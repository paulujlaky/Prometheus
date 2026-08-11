import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { ChatSession } from "../sdk/index";

import { estimateTokens } from "./lib/tokens";
import { extractCommand, extractFinishedSummary, FINISHED, incompleteReason, parseReply, } from "./parse";

import type { BoodleClient } from "../sdk/client";

export { extractCommand, extractFinishedSummary, incompleteReason, FINISHED } from "./parse";

const MAX_OBSERVATION = Number(process.env.SWE_MAX_OUTPUT ?? 16000);
const DEFAULT_MAX_STEPS = Number(process.env.SWE_MAX_STEPS ?? 100);

const CWD_MARKER = "__SWE_CWD__";

// a model that refuses the harness role usually keeps refusing; bail rather than burn the step budget
const MAX_MISSES = 3;

export type AgentEvent =
  | { type: "delta"; text: string }
  | { type: "assistant"; text: string }
  | { type: "command"; command: string }
  | { type: "observation"; text: string; exitCode: number }
  | { type: "status"; text: string }
  | { type: "usage"; used: number; step: number }
  | { type: "session"; chatId: string; title: string }
  | { type: "done"; summary: string }
  | { type: "error"; message: string };

export interface AgentOptions {

  client: BoodleClient;
  cwd: string;

  assistantId?: string;

  maxSteps?: number;
  commandTimeoutMs?: number;

  onEvent: (event: AgentEvent) => void;
  approve: (command: string) => Promise<boolean>;

}

const SHELL = process.env.SWE_SHELL ?? "bash";

/** MSYS/Git-Bash path so `export PATH=…` works under bash on Windows. */
function toBashPath(p: string): string {

  const n = p.replace(/\\/g, "/");

  if (process.platform !== "win32") {

    return n;

  }

  const drive = /^([A-Za-z]):\/(.*)$/.exec(n);

  return drive ? `/${drive[1].toLowerCase()}/${drive[2]}` : n;

}

function prompt(cwd: string, task: string): string {

  const win = process.platform === "win32" ? "- You are on Windows. Use forward slashes only; prefer `cmd //c npm` if npm shims break under bash.\n" : "";

  return [
    "You are a coding agent. Bash you write is executed on the user's machine; stdout/stderr come back. Do not simulate or refuse shell access.",
    "",
    `Current Path: ${cwd}`,
    `Shell: ${SHELL} (${process.platform})`,
    "",
    "Every reply must be EXACTLY this shape (machine-parsed, streamed live):",
    "",
    "<tool>: <≤8 word label>",
    "```bash",
    "<single focused command>",
    "```",
    "",
    `<tool> is ONE word, chosen from this list only — it is parsed as the step's tool type and drives the UI:`,
    "  read    inspecting files or directories (cat, ls, head, wc)",
    "  search  locating things (rg, grep, find)",
    "  write   creating a new file",
    "  edit    changing an existing file (apply_patch, git apply, sg)",
    "  run     builds, installs, scaffolds, git, anything else",
    "  test    running tests, type-checks or lints",
    "  fix     a retry after the previous step failed",
    "  think   planning with a read-only probe",
    "  done    the final FINISHED echo",
    "",
    "Output order is mandatory (the step renders as soon as the label arrives):",
    "- Token 1 of the reply starts the label line. Nothing may precede it.",
    "- Open ```bash on the next line so the command streams early.",
    "- Thinking out loud belongs only between the label and the fence (the UI folds it under Thought for Ns). Never before the label, never after the closing fence.",
    "",
    "Editing — use the bundled tools (already on PATH). Do NOT invent ad-hoc Python/sed editors.",
    "",
    "1) apply_patch — preferred for create/update/delete, multi-file in one call:",
    "  apply_patch <<'PATCH'",
    "  *** Begin Patch",
    "  *** Update File: path/to/file.ts",
    "  @@",
    "   unchanged context line",
    "  -old line",
    "  +new line",
    "  *** Add File: path/to/new.ts",
    "  +export const x = 1",
    "  *** Delete File: path/to/gone.ts",
    "  *** End Patch",
    "  PATCH",
    "  Relative paths. Context lines start with a space; removals `-`; additions `+`.",
    "  If it fails, re-read the file and fix the context — never fall back to rewriting the whole file from memory.",
    "",
    "2) git apply --whitespace=nowarn -p0 <<'DIFF' … DIFF — only for standard unified diffs.",
    "3) sg -p '<pattern>' -r '<replacement>' -l ts --update-all — structural rewrites; preview without --update-all when unsure.",
    "4) cat > 'path' <<'EOF' … EOF — new files only, when apply_patch is awkward.",
    "",
    "Behaviour Notes:",
    "- One action per turn: read OR edit OR write. Inspect the tree yourself when needed (`ls`, `git status -sb`, `rg`).",
    "- Quote paths. Prefer apply_patch over whole-file rewrites.",
    "- No verify parades: at most one build/test after real edits; never re-check the same fact; when done, finish immediately.",
    `- Done: echo "${FINISHED}: <one-line summary>" with the label \`done:\``,
    `- Output capped at ${MAX_OBSERVATION} chars (middle cut) — filter with rg/grep/tail.`,
    "- No interactive tools, no long-lived servers/watchers (killed by timeout). Scaffold with -y. `cd` persists; env does not.",
    win,

    `\nTask: ${task}`,

  ].join("\n");

}

// heuristic denylist catches the obvious footguns, but is not a determined agent.
const RISKY: [RegExp, string][] = [

  [/\brm\s+(-[a-z]*\s+)*-?[a-z]*[rf]/i, "recursive or forced delete"],
  [/\b(rmdir|del|rd)\s+\/s/i, "recursive delete"],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|push\s+.*--force)/i, "discards or force-pushes work"],
  [/\b(sudo|runas)\b/i, "needs elevated privileges"],
  [/\b(mkfs|fdisk|diskpart|format)\b/i, "involves disk formatting"],
  [/\bdd\s+.*\bof=/i, "is a raw disk write"],
  [/(curl|wget|iwr)\b[^|]*\|\s*(ba)?sh/i, "pipes a download straight into a shell"],
  [/>\s*\/dev\/(sd|nvme|disk)/i, "writes to a raw device"],
  [/\b(shutdown|reboot|halt)\b/i, "could shut the machine down"],
  [/\btaskkill\s+.*\/f/i, "force-kills processes"],
  [/\bchmod\s+(-R\s+)?777\b/i, "world-writable permissions"],
  [/\b(npm|yarn|pnpm)\s+publish\b/i, "publishes a package"],
  [/\bgit\s+push\b/i, "pushes to a remote"],
  [/:\(\)\s*\{.*\|.*&.*\}/, "is a fork bomb"],

];

/** Returns why a command looks destructive, or null when it looks routine. */
export function riskReason(command: string): string | null {

  for (const [pattern, reason] of RISKY) {

    if (pattern.test(command)) {

      return reason;

    }

  }

  return null;

}

function truncate(text: string): string {

  if (text.length <= MAX_OBSERVATION) {

    return text;

  }

  const half = Math.floor(MAX_OBSERVATION / 2);
  const cut = text.length - MAX_OBSERVATION;

  // loud, because a silently clipped middle is where the real error usually is
  const notice = `\n\n===== ${cut} CHARACTERS CUT FROM THE MIDDLE OF THIS OUTPUT =====\nRe-run with grep/tail if the part you need was in here.\n\n`;

  return `${text.slice(0, half)}${notice}${text.slice(-half)}`;

}

/**
 * PATH prefixes for bundled tools (apply_patch, sg/ast-grep)
*/
export function wrapCommand(command: string, toolBins?: string): string {

  // $PWD under Git Bash is an MSYS path (/tmp, /c/...) that Windows cannot spawn into; pwd -W gives the native one
  const pwd = process.platform === "win32" ? '"$(pwd -W 2>/dev/null || pwd)"' : '"$PWD"';
  const pathPrefix = toolBins ? `export PATH="${toolBins}:$PATH"\n` : "";

  return `${pathPrefix}${command}\n__swe_status=$?\nprintf '\\n${CWD_MARKER}%s\\n' ${pwd}\nexit $__swe_status\n`;

}

/** Resolve dirs that contain apply_patch + node_modules/.bin (sg). */
export function resolveToolBinDirs(bundleDir: string): string[] {

  const dirs: string[] = [];
  const applyDir = join(bundleDir, "bin");

  if (existsSync(applyDir)) {

    dirs.push(applyDir);

  }

  // electron runs swe/dist/main.cjs → project root is ../..
  const rootCandidates = [

    resolve(bundleDir, "../.."),
    resolve(bundleDir, "../../.."),

    process.cwd(),

  ];

  for (const root of rootCandidates) {

    const nm = join(root, "node_modules", ".bin");

    if (existsSync(nm)) {

      dirs.push(nm);
      break;

    }

  }

  return dirs;

}

/** Git Bash reports /c/Users/x; node's spawn needs C:/Users/x. */
export function toNativePath(path: string): string {

  if (process.platform !== "win32") {

    return path;

  }

  const drive = /^\/([a-zA-Z])\/(.*)$/.exec(path);

  return drive ? `${drive[1].toUpperCase()}:/${drive[2]}` : path;

}

export function parseRun(raw: string): { output: string; cwd: string | null } {

  const index = raw.lastIndexOf(CWD_MARKER);

  if (index === -1) {

    return { output: raw, cwd: null };

  }

  const rest = raw.slice(index + CWD_MARKER.length);
  const end = rest.indexOf("\n");

  const cwd = (end === -1 ? rest : rest.slice(0, end)).trim();

  return {

    output: raw.slice(0, index).replace(/\n$/, ""),
    cwd: cwd ? toNativePath(cwd) : null,

  };

}

// conventional timeout exit (GNU timeout / CI tools)
const EXIT_TIMEOUT = 124;

// grace period after kill before we force-resolve even if the shell never exits
const KILL_GRACE_MS = 2_500;

// child.kill() only reaches the shell; installers and servers keep running underneath it
function killTree(child: ChildProcess) {

  if (child.pid == null) {

    return;

  }

  if (process.platform === "win32") {

    // /t = whole tree; /f = force — needed for bun/node grandchildren of bash
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {

      windowsHide: true,
      stdio: "ignore",

    });

    return;

  }

  // process group (spawned detached below) — wipes bash + bun run dev + anything it forked
  try {

    process.kill(-child.pid, "SIGKILL");

  } catch {

    try {

      child.kill("SIGKILL");

    } catch {

      // already gone

    }

  }

}

/** Commands go through a temp script rather than `bash -c`. */
export function runCommand(command: string, cwd: string, timeoutMs: number, onSpawn?: (child: ChildProcess) => void, extraEnv?: Record<string, string>, ): Promise<{ output: string; exitCode: number }> {

  return new Promise((resolve) => {

    const script = join(mkdtempSync(join(tmpdir(), "swe-")), "step.sh");

    writeFileSync(script, command.replaceAll("\r\n", "\n"), "utf8");

    let settled = false;
    let timedOut = false;
    let forceTimer: ReturnType<typeof setTimeout> | null = null;

    const done = (result: { output: string; exitCode: number }) => {

      if (settled) {

        return;

      }

      settled = true;

      if (forceTimer) {

        clearTimeout(forceTimer);
        forceTimer = null;

      }

      try {

        rmSync(dirname(script), { recursive: true, force: true });

      } catch {

        // an orphaned grandchild can still hold the script open on Windows; a stray temp file is not worth failing the step
      }

      resolve(result);

    };

    // detached on Unix so bash is a process-group leader and killTree can SIGKILL the whole tree
    const child = spawn(SHELL, [script.replaceAll("\\", "/")], {

      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",

      // anything that prompts gets EOF and fails fast instead of hanging until the timeout. good UX
      stdio: ["ignore", "pipe", "pipe"],

      env: {

        ...process.env,
        ...extraEnv,

        CI: "1",
        GIT_PAGER: "cat",
        PAGER: "cat",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        NPM_CONFIG_YES: "true",
        NPM_CONFIG_FUND: "false",
        NPM_CONFIG_AUDIT: "false",
        DEBIAN_FRONTEND: "noninteractive",

      },

    });

    onSpawn?.(child);

    let output = "";

    const timer = setTimeout(() => {

      timedOut = true;
      killTree(child);
      output += `\n<command killed after ${timeoutMs}ms (timeout)>`;

      // never leave the agent parked if the shell ignores SIGKILL / taskkill races
      forceTimer = setTimeout(() => {

        done({ output, exitCode: EXIT_TIMEOUT });

      }, KILL_GRACE_MS);

    }, timeoutMs);

    child.stdout.on("data", (chunk) => {

      output += String(chunk);

    });

    child.stderr.on("data", (chunk) => {

      output += String(chunk);

    });

    child.on("error", (err) => {

      clearTimeout(timer);
      done({ output: `failed to run ${SHELL} in ${cwd}: ${err.message}`, exitCode: -1 });

    });

    // "exit", not "close": a killed shell can leave a grandchild holding the pipes, and close would wait for it
    child.on("exit", (code) => {

      clearTimeout(timer);

      // small drain so a last stderr flush from taskkill lands in output
      setTimeout(() => {

        done({

          output,
          exitCode: timedOut ? EXIT_TIMEOUT : (code ?? -1),

        });

      }, 150);

    });

  });

}

export class MiniAgent {

  private options: AgentOptions;

  private session: ChatSession | null = null;
  private child: ChildProcess | null = null;
  private stopped = false;

  private cwd = "";
  private toolPath = "";

  /** Cumulative estimated tokens of everything sent + received this run (server keeps full history). */
  private tokensUsed = 0;

  constructor(options: AgentOptions) {

    this.options = options;

    // bun inlines __dirname; resolve tools relative to the running main bundle (swe/dist)
    const bundleDir = resolve(dirname(process.argv[1] ?? "."));
    const bins = resolveToolBinDirs(bundleDir).map(toBashPath);

    this.toolPath = bins.join(":");

  }

  /** Interrupts at whichever point the run is sitting: a running command, or a model turn we are waiting on. */
  stop() {

    if (this.stopped) {

      return;

    }

    this.stopped = true;

    this.options.onEvent({ type: "status", text: "Stopping..." });

    if (this.child) {

      killTree(this.child);

    }

    // disposing rejects the pending final response, so an in-flight turn does not block the stop
    this.session?.dispose();

  }

  private noteTokens(text: string, step: number) {

    this.tokensUsed += estimateTokens(text);
    this.options.onEvent({ type: "usage", used: this.tokensUsed, step });

  }

  async run(task: string): Promise<void> {

    const { client, onEvent, approve } = this.options;

    const maxSteps = this.options.maxSteps ?? DEFAULT_MAX_STEPS;
    const timeoutMs = this.options.commandTimeoutMs ?? 120_000;

    // forward slashes, because a backslash path in a bash prompt is a trap
    this.cwd = this.options.cwd.replaceAll("\\", "/");
    this.tokensUsed = 0;

    try {

      onEvent({ type: "status", text: "Thinking" });

      const session = await ChatSession.create(client, {

        assistantId: this.options.assistantId,
        // agent only reads the streamed turn; skip the full chat refetch after every send
        refreshOnComplete: false,

      });

      this.session = session;

      // let Boodle title the chat; we only track the id for the sidebar
      const seedTitle = session.state.chat?.name?.trim() || "New chat";

      onEvent({ type: "session", chatId: session.chatId, title: seedTitle });

      // history lives on the server, so each step only sends the new observation
      this.session.on((event) => {

        if (event.type === "stream" && event.change.kind === "delta") {

          onEvent({ type: "delta", text: event.change.text });

        }

      });

      let message = prompt(this.cwd, task);
      let misses = 0;
      let lastProse = "";

      for (let step = 1; step <= maxSteps; step += 1) {

        if (this.stopped) {

          onEvent({ type: "status", text: "Stopped" });

          return;

        }

        // Thinking | Drafting | Running — default working state is Thinking
        const phase = (text: string) => onEvent({ type: "status", text: `Step ${step} · ${text}` });

        phase("Thinking");
        this.noteTokens(message, step);

        let drafting = false;

        const unsubDraft = this.session.on((event) => {

          if (event.type === "stream" && event.change.kind === "delta" && !drafting) {

            drafting = true;
            phase("Drafting");

          }

        });

        const turn = await this.session.send(message);

        unsubDraft();

        if (this.stopped) {

          onEvent({ type: "status", text: "Stopped" });

          return;

        }

        this.noteTokens(turn.text, step);
        onEvent({ type: "assistant", text: turn.text });
        phase("Thinking");

        const parsed = parseReply(turn.text);
        const command = extractCommand(turn.text);

        if (parsed.desc) {

          lastProse = parsed.desc;

        }

        const truncated = command ? incompleteReason(command) : null;

        if (command && truncated) {

          misses += 1;

          if (misses >= MAX_MISSES) {

            onEvent({ type: "error", message: `The block kept arriving incomplete (${truncated}). Try a smaller task or a different model.` });

            return;

          }

          onEvent({ type: "status", text: "Block arrived incomplete — asking for a resend" });

          message = [

            `Your block was not run: ${truncated}. It reached me cut off at ${command.length} characters, so the rest never arrived.`,
            "Do not resend the same block. Prefer a smaller apply_patch, or split a large add: `*** Add File` for the first chunk only, then a follow-up Update — or `cat >` then `cat >>` for plain writes.",
            "After a write, check with `wc -c 'file'` and `tail -3 'file'` if the fence looked truncated.",

          ].join("\n");

          continue;

        }

        if (!command) {

          misses += 1;

          // model sometimes finishes with prose + FINISHED echo request already satisfied in prior turn
          const finishedInProse = extractFinishedSummary(turn.text);

          if (finishedInProse && finishedInProse !== "Task complete.") {

            onEvent({ type: "done", summary: finishedInProse });

            return;

          }

          if (misses >= MAX_MISSES) {

            onEvent({ type: "error", message: `${misses} replies in a row had no bash block — this assistant is not following the protocol. Try a different model.` });

            return;

          }

          if (turn.text.includes("```")) {

            message = "Your reply opened a bash block but never closed it, so nothing could be run. Resend a smaller block, closing the fence.";
            continue;

          }

          message = [

            "That reply contained no bash code block, so nothing ran and the task did not advance.",
            "Your commands are really executed on the user's machine and the output comes back to you — do not answer with prose, files, or artifacts.",
            "Reply now — line 1 is the label, line 2 opens the fence:\n\nread|search|write|edit|run|test|fix|think|done: <≤8 word label>\n```bash\n<one command>\n```",

          ].join("\n");

          continue;

        }

        misses = 0;

        onEvent({ type: "command", command });

        // approve() resolves immediately in auto/smart-safe modes; we should stay on Thinking while parked on a prompt
        const approval = approve(command);
        const waiting = setTimeout(() => phase("Thinking"), 40);
        const ok = await approval;

        clearTimeout(waiting);

        if (!ok) {

          message = "The user declined to run that command. Propose a different one.";
          continue;

        }

        phase("Running");

        const run = await runCommand(wrapCommand(command, this.toolPath), this.cwd, timeoutMs, (child) => {

          this.child = child;

        });

        this.child = null;

        const { output, cwd: ended } = parseRun(run.output);
        const exitCode = run.exitCode;

        // only follow the shell somewhere that actually exists, or the next spawn fails before running anything
        if (ended && ended !== this.cwd && existsSync(ended)) {

          this.cwd = ended;

        }

        if (this.stopped) {

          onEvent({ type: "observation", text: output, exitCode });
          onEvent({ type: "status", text: "Stopped" });

          return;

        }

        onEvent({ type: "observation", text: output, exitCode });

        const summary = extractFinishedSummary(output);

        if (summary) {

          // prefer the model's own one-liner when FINISHED was bare
          const finalSummary = summary === "Task complete." && lastProse ? lastProse.split(/\r?\n/)[0].trim() : summary;

          onEvent({ type: "done", summary: finalSummary });

          return;

        }

        // failed patch: nudge toward re-read instead of a blind whole-file rewrite
        const patchMiss = exitCode !== 0 && /apply_patch:|Invalid Context|failed to update|git apply/i.test(output);

        message = patchMiss ? [

            `Exit code: ${exitCode}`,
            "",
            truncate(output) || "<no output>",
            "",
            "Patch context did not match. Re-cat the file, fix the @@ context lines, and retry apply_patch (or git apply) — do not rewrite the whole file from memory.",

          ].join("\n")

        : `Exit code: ${exitCode}\n\n${truncate(output) || "<no output>"}`;

      }

      onEvent({ type: "status", text: `Step limit reached (${maxSteps})` });
      onEvent({ type: "error", message: `Step limit (${maxSteps}) reached without a ${FINISHED} marker.` });

    } catch (err) {

      // a stop tears the session down, so the resulting rejection is expected rather than a failure
      if (this.stopped) {

        onEvent({ type: "status", text: "Stopped" });

      } else {

        onEvent({ type: "error", message: err instanceof Error ? err.message : String(err) });

      }

    } finally {

      this.session?.dispose();

      this.session = null;
      this.child = null;

    }

  }

}
