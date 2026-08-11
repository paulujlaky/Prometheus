import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

/** CRLF-safe unique-string replace; exits non-zero instead of corrupting the file. */
const REPLACE_HELPER = `
import sys
from pathlib import Path

def die(msg, code=1):
    print(msg, file=sys.stderr)
    raise SystemExit(code)

if len(sys.argv) != 2:
    die("usage: swe-replace <file>  (stdin: <<<<<<< SEARCH / ======= / >>>>>>> REPLACE)")

path = Path(sys.argv[1])
if not path.is_file():
    die("not a file: %s" % path)

raw = sys.stdin.read().replace("\\r\\n", "\\n")
start, mid, end = "<<<<<<< SEARCH\\n", "\\n=======\\n", "\\n>>>>>>> REPLACE"
if start not in raw or mid not in raw:
    die("stdin must be:\\n<<<<<<< SEARCH\\n<old>\\n=======\\n<new>\\n>>>>>>> REPLACE")

i = raw.index(start) + len(start)
j = raw.index(mid, i)
# end marker optional if stdin ends after new text
if end in raw[j:]:
    k = raw.index(end, j)
    new = raw[j + len(mid):k]
else:
    new = raw[j + len(mid):]
old = raw[i:j]

data = path.read_bytes()
nl = "\\r\\n" if (b"\\r\\n" in data and data.count(b"\\r\\n") >= data.count(b"\\n") - data.count(b"\\r\\n")) else "\\n"
text = data.decode("utf-8")
norm = text.replace("\\r\\n", "\\n")
count = norm.count(old)
if count != 1:
    die("expected exactly 1 match, found %d" % count)
out = norm.replace(old, new, 1)
if nl == "\\r\\n":
    out = out.replace("\\n", "\\r\\n")
path.write_bytes(out.encode("utf-8"))
print("replaced 1 span in %s" % path)
`;

const WRITE_HELPER = `
import sys
from pathlib import Path

if len(sys.argv) != 2:
    print("usage: swe-write <file>  (stdin: full file body)", file=sys.stderr)
    raise SystemExit(1)

path = Path(sys.argv[1])
path.parent.mkdir(parents=True, exist_ok=True)
body = sys.stdin.buffer.read()
path.write_bytes(body)
print("wrote %s (%d bytes)" % (path, len(body)))
`;

const SHELL = process.env.SWE_SHELL ?? "bash";

function prompt(cwd: string, task: string, survey: string): string {

  const win = process.platform === "win32"
    ? "\nWindows: use forward slashes; swe-replace handles CRLF; prefer `cmd //c npm` if npm shims break.\n"
    : "";

  return [
    "You are a coding agent. Bash you write is executed on the user's machine; stdout/stderr come back. Do not simulate or refuse shell access.",
    "",
    `Cwd: ${cwd}`,
    `Shell: ${SHELL} (${process.platform})`,
    "",
    "Every reply is EXACTLY this shape (machine-parsed, streamed live):",
    "",
    "desc: <≤8 word label>",
    "```bash",
    "<single focused command>",
    "```",
    "",
    "Output order is mandatory (the UI shows the step as soon as desc arrives):",
    "- Token 1 of the reply must start the line `desc: …` — never a preamble, plan, or monologue first.",
    "- The very next line must open ```bash. Put the command in the fence as soon as you know it.",
    "- No essays before the fence. Prefer zero notes; if needed, one short line after `desc:` only.",
    "- Nothing after the closing fence. Only the key `desc:` is a valid label.",
    "",
    "Behaviour:",
    "- One action per turn: read OR edit OR write. Batch cheap recon (`ls && git status -sb`).",
    "- Prefer swe-replace / swe-write (unique SEARCH assert; CRLF-safe). Quote paths. Do not rewrite large files from memory.",
    "  swe-replace 'f.ts' <<'EOF'",
    "  <<<<<<< SEARCH",
    "  old",
    "  =======",
    "  new",
    "  >>>>>>> REPLACE",
    "  EOF",
    "- No verify parades: at most one build/test after real edits; never re-check the same fact; when done, finish immediately.",
    `- Done: echo "${FINISHED}: <one-line summary>"`,
    `- Output capped at ${MAX_OBSERVATION} chars (middle cut) — filter with rg/grep/tail.`,
    "- No interactive tools, no long-lived servers/watchers (killed by timeout). Scaffold with -y. `cd` persists; env does not.",
    "- Never `cd` into dist/build output dirs.",
    win,
    survey ? `Snapshot (already gathered):\n${survey}\n` : "",
    `Task: ${task}`,
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

/** Runs the command, then reports the shell's final directory so the next block starts where this one ended.*/
export function wrapCommand(command: string, helpersDir?: string | null): string {

  // $PWD under Git Bash is an MSYS path (/tmp, /c/...) that Windows cannot spawn into; pwd -W gives the native one
  const pwd = process.platform === "win32" ? '"$(pwd -W 2>/dev/null || pwd)"' : '"$PWD"';
  const py = process.platform === "win32" ? "python" : "python3";

  // functions beat PATH wrappers: no execute bit required, works under Git Bash on Windows
  const prefix = helpersDir ? [
    `export SWE_HELPERS="${helpersDir.replaceAll("\\", "/")}"`,
    `swe-replace() { ${py} "$SWE_HELPERS/swe_replace.py" "$@"; }`,
    `swe-write() { ${py} "$SWE_HELPERS/swe_write.py" "$@"; }`,
    "",
  ].join("\n") : "";

  return `${prefix}${command}\n__swe_status=$?\nprintf '\\n${CWD_MARKER}%s\\n' ${pwd}\nexit $__swe_status\n`;

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
  private helpersDir: string | null = null;

  /** Cumulative estimated tokens of everything sent + received this run (server keeps full history). */
  private tokensUsed = 0;

  constructor(options: AgentOptions) {

    this.options = options;

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

  private installHelpers(): string {

    const dir = mkdtempSync(join(tmpdir(), "swe-helpers-"));

    writeFileSync(join(dir, "swe_replace.py"), REPLACE_HELPER.trim() + "\n", "utf8");
    writeFileSync(join(dir, "swe_write.py"), WRITE_HELPER.trim() + "\n", "utf8");

    this.helpersDir = dir;

    return dir;

  }

  private shellEnv(): Record<string, string> {

    // do not rewrite PATH here — on Windows that breaks spawn(bash). wrapCommand exports PATH inside the script.
    return {

      SWE_HELPERS: this.helpersDir?.replaceAll("\\", "/") ?? "",

    };

  }

  private noteTokens(text: string, step: number) {

    this.tokensUsed += estimateTokens(text);
    this.options.onEvent({ type: "usage", used: this.tokensUsed, step });

  }

  /** Turn one is almost always reconnaissance, so the first message already carries it. */
  private async survey(): Promise<string> {

    const { output } = await runCommand(

      [

        "ls -la 2>&1 | head -60",
        "echo",
        "if git rev-parse --git-dir >/dev/null 2>&1; then",
        "  git --no-pager status --short --branch 2>&1 | head -30",
        "  # key manifests if present — saves a later turn",
        "  for f in package.json pyproject.toml go.mod Cargo.toml README.md; do",
        '    [ -f "$f" ] && { echo; echo "== $f (head)"; head -40 "$f"; }',
        "  done",
        "else",

        // without a repo there is no diff to review and no way back from a bad rewrite
        '  echo "NOT A GIT REPOSITORY — there is no diff to review and no undo."',
        "fi",

      ].join("\n"), this.cwd, 15_000, undefined, this.shellEnv(),

    );

    return output.trim().slice(0, 6000);

  }

  async run(task: string): Promise<void> {

    const { client, onEvent, approve } = this.options;

    const maxSteps = this.options.maxSteps ?? DEFAULT_MAX_STEPS;
    const timeoutMs = this.options.commandTimeoutMs ?? 120_000;

    // forward slashes, because a backslash path in a bash prompt is a trap
    this.cwd = this.options.cwd.replaceAll("\\", "/");
    this.tokensUsed = 0;

    try {

      this.installHelpers();

      onEvent({ type: "status", text: "Thinking" });

      // survey is local; chat open is network — overlap them
      const surveyPromise = this.survey();
      const sessionPromise = ChatSession.create(client, {

        assistantId: this.options.assistantId,
        // agent only reads the streamed turn; skip the full chat refetch after every send
        refreshOnComplete: false,

      });

      const [survey, session] = await Promise.all([surveyPromise, sessionPromise]);

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

      let message = prompt(this.cwd, task, survey);
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
            "Do not resend the same block. Prefer `swe-replace` for surgical edits, or split a large write: `swe-write`/`cat >` for the first chunk, then `cat >> 'file' <<'EOF'` for the rest, one block per turn.",
            "After the final chunk, verify with `wc -c 'file'` and `tail -3 'file'` — exit 0 alone does not prove the file is whole.",

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
            "Reply now — first line MUST be desc:, second line MUST open ```bash:\n\ndesc: <≤8 word label>\n```bash\n<one command>\n```",

          ].join("\n");

          continue;

        }

        misses = 0;

        onEvent({ type: "command", command });

        // approve() resolves immediately in auto/smart-safe modes; stay on Thinking while parked on a prompt
        const approval = approve(command);
        const waiting = setTimeout(() => phase("Thinking"), 40);
        const ok = await approval;

        clearTimeout(waiting);

        if (!ok) {

          message = "The user declined to run that command. Propose a different one.";
          continue;

        }

        phase("Running");

        const run = await runCommand(wrapCommand(command, this.helpersDir), this.cwd, timeoutMs, (child) => {

          this.child = child;

        }, this.shellEnv());

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

        // failed unique-replace: nudge toward re-read instead of a blind rewrite
        const replaceMiss = exitCode !== 0 && /expected exactly 1 match/i.test(output);

        message = replaceMiss
          ? [

              `Exit code: ${exitCode}`,
              "",
              truncate(output) || "<no output>",
              "",
              "swe-replace needs a unique SEARCH span. Re-cat the file (or the relevant lines), copy an exact unique span, and retry swe-replace — do not rewrite the whole file from memory.",

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

      if (this.helpersDir) {

        try {

          rmSync(this.helpersDir, { recursive: true, force: true });

        } catch {

          // temp cleanup is best-effort
        }

        this.helpersDir = null;

      }

    }

  }

}
