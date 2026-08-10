import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ChatSession } from "../sdk/index";

import type { BoodleClient } from "../sdk/client";

const FINISHED = "MINI_SWE_FINISHED";
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

function prompt(cwd: string, task: string, survey: string): string {

  return [

    "You are the reasoning half of an automated coding agent. A program running on the user's machine executes the commands you write and sends you their real output. You are not being asked to imagine, describe, or simulate any of this.",
    "",
    `Working directory: ${cwd}`,
    `Shell: ${SHELL} (platform ${process.platform})`,
    "",
    "How the loop works:",
    "- You reply with exactly ONE bash code block, and no other code blocks.",
    "- The program writes that block to a script and runs it with `" + SHELL + "` in the working directory above, then replies with the genuine exit code and stdout/stderr from the machine. There is no size limit on the block.",
    "- So you do have shell access — through this loop. Never reply that you lack command-line access, that you cannot run commands, or that the user should run them instead. Doing so stalls the run.",
    "- Never answer with file attachments, artifacts, download links, or JSON file objects. None of those reach the machine. The bash block is the only thing that does anything.",
    "- Every reply must contain a bash block, including when you are unsure: investigate with `ls`, `cat`, or `git status` rather than asking a question.",
    "- The working directory carries over between blocks: if you `cd`, the next block starts there. Nothing else survives — exported vars, venv activation and shell functions all die with the block, so re-establish those in the block that needs them.",
    "- Keep prose to one or two sentences before the block. No plans, no numbered outlines, no summaries of what you are about to do.",
    `- When the task is done, run: echo "${FINISHED}: <one line summary>"`,
    "",
    "One block is one round trip, so make each one count:",
    "- Batch cheap reads into a single block instead of spending a turn on each: `ls -la && git status --short && cat package.json`.",
    "- Loop when reading several files: `for f in a.ts b.ts; do echo \"== $f\"; cat \"$f\"; done`.",
    "- End every editing block with its own verification — typecheck, build, or tests. Both usually take a couple of seconds, far less than another round trip: `bun run typecheck 2>&1 | tail -5 && bun run build 2>&1 | tail -8`.",
    "- A green exit code is not proof of a correct artifact. When a build produces files, assert on their contents (`grep` the built output for what must be there), not just on the status.",
    `- Output is capped at ${MAX_OBSERVATION} characters and the middle is cut, with a loud notice where it happened. Filter at the source (\`grep -nE 'error|FAIL'\`, \`tail -40\`) rather than dumping everything.`,
    "",
    "Editing files:",
    "- New file, or one under roughly 2 KB: write it whole with a quoted heredoc, so nothing is expanded by the shell. Do not indent a heredoc body — every space becomes part of the file:",
    "",
    "cat > 'path/to/file.ts' <<'EOF'",
    "...entire file contents...",
    "EOF",
    "",
    "  The quotes around EOF are required — without them, dollar signs, backticks and backslashes in the file get expanded by the shell.",
    "  If the body contains a line that is exactly EOF, use another delimiter such as SWEEOF.",
    "- Existing large file: do NOT re-emit it from memory — that is how imports get dropped and earlier edits silently reverted. Make a surgical replacement instead:",
    "",
    "python - <<'PY'",
    "from pathlib import Path",
    "p = Path('path/to/file.ts')",
    "s = p.read_text(encoding='utf-8')",
    "old = \"\"\"exact text to replace\"\"\"",
    "assert s.count(old) == 1, s.count(old)",
    "p.write_text(s.replace(old, \"\"\"new text\"\"\"), encoding='utf-8')",
    "PY",
    "",
    "  The assert is the point: it fails loudly instead of corrupting the file.",
    "- Read before you edit, quote every path, and verify afterwards — `git --no-pager diff --stat`, or run the build or tests.",
    "- After writing a large file, check its length, not just the exit code: `wc -c 'file' && tail -3 'file'`.",
    "- Before finishing, review your own work with `git --no-pager diff` (or `git status --short` when the repo is not initialised).",
    "",
    "Commands that break this loop — avoid them:",
    "- Interactive tools: vim, nano, less, top, or anything that opens an editor or pager. There is no stdin: prompts get EOF, so an interactive command fails instead of waiting.",
    "- Watchers and servers that never exit: `npm run dev`, `--watch`, `tail -f`. Build or test instead. Commands are killed after two minutes.",
    "- Scaffolders that ask questions: pass `-y`/`--yes`. CI=1 and npm's yes/no-audit flags are already set for you.",
    "- Never `cd` into a build output directory such as dist. The working directory persists, and on Windows a shell sitting inside a folder prevents it being deleted, so the next build fails with a confusing error naming the folder. Use a tool flag instead (`python -m http.server 8765 --directory dist`), or wrap a temporary move in a subshell: `(cd dist && ls)`.",
    "- Some things cannot be checked from a shell at all — service worker registration, install prompts, browser runtime behaviour. Assert their preconditions statically and say plainly that confirming them is a manual step, rather than spending turns chasing them.",
    ...(process.platform === "win32"
      ? [

          "",
          "This is Windows running bash, which has sharp edges:",
          "- Use forward slashes everywhere; a backslash is an escape character in bash.",
          "- Heredocs write LF. If a tool needs CRLF, or a file already has it, handle it explicitly rather than assuming.",
          "- npm/npx are .cmd shims; if one misbehaves under bash, run it via `cmd //c npm ...`.",
          "- The filesystem is case-insensitive, so wrong import casing will work here and break on Linux CI. Copy filenames from `ls` output rather than typing them from memory.",
          "- Tools may print absolute paths with backslashes; anything parsing those paths has to handle both separators.",

        ]
      : []),
    "",
    survey ? `Current state of the working directory:\n\n${survey}\n` : "",
    `Task: ${task}`,

  ].join("\n");

}

// ponytail: heuristic denylist — it catches the obvious footguns, not a determined agent. Approval mode is the real gate.
const RISKY: [RegExp, string][] = [

  [/\brm\s+(-[a-z]*\s+)*-?[a-z]*[rf]/i, "recursive or forced delete"],
  [/\b(rmdir|del|rd)\s+\/s/i, "recursive delete"],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|push\s+.*--force)/i, "discards or force-pushes work"],
  [/\b(sudo|runas)\b/i, "elevated privileges"],
  [/\b(mkfs|fdisk|diskpart|format)\b/i, "disk formatting"],
  [/\bdd\s+.*\bof=/i, "raw disk write"],
  [/(curl|wget|iwr)\b[^|]*\|\s*(ba)?sh/i, "pipes a download straight into a shell"],
  [/>\s*\/dev\/(sd|nvme|disk)/i, "writes to a raw device"],
  [/\b(shutdown|reboot|halt)\b/i, "shuts the machine down"],
  [/\btaskkill\s+.*\/f/i, "force-kills processes"],
  [/\bchmod\s+(-R\s+)?777\b/i, "world-writable permissions"],
  [/\b(npm|yarn|pnpm)\s+publish\b/i, "publishes a package"],
  [/\bgit\s+push\b/i, "pushes to a remote"],
  [/:\(\)\s*\{.*\|.*&.*\}/, "fork bomb"],

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

/**
 * Reports an unterminated here-document, which is what a cut-off block looks like from here.
 * Running one anyway writes a half a file and reports success.
 */
export function incompleteReason(command: string): string | null {

  const pending: string[] = [];

  for (const line of command.split("\n")) {

    if (pending.length) {

      if (line.trim() === pending[pending.length - 1]) {

        pending.pop();

      }

      continue; // nothing inside a here-document body is parsed as shell

    }

    const opener = /<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);

    if (opener) {

      pending.push(opener[2]);

    }

  }

  return pending.length ? `the here-document <<${pending[pending.length - 1]} is never closed` : null;

}

/** Pulls the fenced block out of a reply; mini-swe-agent's whole tool surface is one bash command. */
export function extractCommand(reply: string): string | null {

  const opening = /```(?:bash|sh|shell)?\r?\n/.exec(reply);

  if (!opening) {

    return null;

  }

  const body = reply.slice(opening.index + opening[0].length);
  const first = body.indexOf("```");

  if (first === -1) {

    return null;

  }

  const command = body.slice(0, first).trim();

  // a heredoc body containing its own fence closes the block early; the last fence is then the real one
  if (incompleteReason(command)) {

    const last = body.lastIndexOf("```");
    const extended = body.slice(0, last).trim();

    if (last !== first && !incompleteReason(extended)) {

      return extended || null;

    }

  }

  return command || null;

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
 * Runs the command, then reports the shell's final directory so the next block starts where this one ended.
 * A persistent shell would also carry env and shell functions, but it brings process lifetime and deadlock
 * problems that this one marker avoids.
 */
export function wrapCommand(command: string): string {

  // $PWD under Git Bash is an MSYS path (/tmp, /c/...) that Windows cannot spawn into; pwd -W gives the native one
  const pwd = process.platform === "win32" ? '"$(pwd -W 2>/dev/null || pwd)"' : '"$PWD"';

  return `${command}\n__swe_status=$?\nprintf '\\n${CWD_MARKER}%s\\n' ${pwd}\nexit $__swe_status\n`;

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

// child.kill() only reaches the shell; installers and builds keep running underneath it
function killTree(child: ChildProcess) {

  if (child.pid == null) {

    return;

  }

  if (process.platform === "win32") {

    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });

    return;

  }

  child.kill("SIGKILL");

}

/**
 * Commands go through a temp script rather than `bash -c`.
 * The argument form is capped by the OS — on Windows anything past ~8 KB is silently truncated
 * mid-byte (a heredoc then swallows the rest of the script) and past ~32 KB spawn throws outright.
 */
export function runCommand(command: string, cwd: string, timeoutMs: number, onSpawn?: (child: ChildProcess) => void): Promise<{ output: string; exitCode: number }> {

  return new Promise((resolve) => {

    const script = join(mkdtempSync(join(tmpdir(), "swe-")), "step.sh");

    writeFileSync(script, command.replaceAll("\r\n", "\n"), "utf8");

    const done = (result: { output: string; exitCode: number }) => {

      try {

        rmSync(dirname(script), { recursive: true, force: true });

      } catch {

        // an orphaned grandchild can still hold the script open on Windows; a stray temp file is not worth failing the step
      }

      resolve(result);

    };

    const child = spawn(SHELL, [script.replaceAll("\\", "/")], {

      cwd,
      windowsHide: true,

      // no stdin: anything that prompts gets EOF and fails fast instead of hanging until the timeout
      stdio: ["ignore", "pipe", "pipe"],

      env: {

        ...process.env,

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

      killTree(child);
      output += `\n<command killed after ${timeoutMs}ms>`;

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

      setTimeout(() => done({ output, exitCode: code ?? -1 }), 150);

    });

  });

}

export class MiniAgent {

  private options: AgentOptions;

  private session: ChatSession | null = null;
  private child: ChildProcess | null = null;
  private stopped = false;

  private cwd = "";

  constructor(options: AgentOptions) {

    this.options = options;

  }

  /** Interrupts at whichever point the run is sitting: a running command, or a model turn we are waiting on. */
  stop() {

    if (this.stopped) {

      return;

    }

    this.stopped = true;

    this.options.onEvent({ type: "status", text: "Stopping…" });

    if (this.child) {

      killTree(this.child);

    }

    // disposing rejects the pending final response, so an in-flight turn does not block the stop
    this.session?.dispose();

  }

  /** Turn one is otherwise always reconnaissance, so the first message already carries it. */
  private async survey(): Promise<string> {

    const { output } = await runCommand(

      [

        "ls -la 2>&1 | head -60",
        "echo",
        "if git rev-parse --git-dir >/dev/null 2>&1; then",
        "  git --no-pager status --short --branch 2>&1 | head -30",
        "else",
        // without a repo there is no diff to review and no way back from a bad rewrite
        '  echo "NOT A GIT REPOSITORY — there is no diff to review and no undo. If this task touches more than a couple of files, make your first block: git init && git add -A && git commit -qm baseline"',
        "fi",

      ].join("\n"),
      this.cwd,
      15_000,

    );

    return output.trim().slice(0, 4000);

  }

  async run(task: string): Promise<void> {

    const { client, onEvent, approve } = this.options;

    const maxSteps = this.options.maxSteps ?? DEFAULT_MAX_STEPS;
    const timeoutMs = this.options.commandTimeoutMs ?? 120_000;

    // forward slashes, because a backslash path in a bash prompt is a trap
    this.cwd = this.options.cwd.replaceAll("\\", "/");

    try {

      onEvent({ type: "status", text: "Looking around…" });

      const survey = await this.survey();

      onEvent({ type: "status", text: "Opening chat…" });

      // the agent only reads the streamed turn, so skip the full chat refetch the SDK does after every send
      this.session = await ChatSession.create(client, { assistantId: this.options.assistantId, refreshOnComplete: false });

      // history lives on the server, so each step only sends the new observation
      this.session.on((event) => {

        if (event.type === "stream" && event.change.kind === "delta") {

          onEvent({ type: "delta", text: event.change.text });

        }

      });

      let message = prompt(this.cwd, task, survey);
      let misses = 0;

      for (let step = 1; step <= maxSteps; step += 1) {

        if (this.stopped) {

          onEvent({ type: "status", text: "Stopped." });

          return;

        }

        const phase = (text: string) => onEvent({ type: "status", text: `Step ${step} · ${text}` });

        phase("Thinking…");

        const turn = await this.session.send(message);

        if (this.stopped) {

          onEvent({ type: "status", text: "Stopped." });

          return;

        }

        onEvent({ type: "assistant", text: turn.text });

        const command = extractCommand(turn.text);

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
            "Do not resend the same block. Split the write into parts: `cat > 'file' <<'EOF'` for the first chunk, then `cat >> 'file' <<'EOF'` for each of the rest, one block per turn.",
            "After the final chunk, verify with `wc -c 'file'` and `tail -3 'file'` — exit 0 alone does not prove the file is whole.",

          ].join("\n");

          continue;

        }

        if (!command) {

          misses += 1;

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
            "Reply now with exactly one ```bash block containing the single next command. If you are unsure where to start, list the working directory.",

          ].join("\n");

          continue;

        }

        misses = 0;

        onEvent({ type: "command", command });

        phase("Waiting for approval…");

        if (!(await approve(command))) {

          message = "The user declined to run that command. Propose a different one.";
          continue;

        }

        phase("Running command…");

        const run = await runCommand(wrapCommand(command), this.cwd, timeoutMs, (child) => {

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
          onEvent({ type: "status", text: "Stopped." });

          return;

        }

        onEvent({ type: "observation", text: output, exitCode });

        if (output.includes(FINISHED)) {

          const summary = output.slice(output.indexOf(FINISHED) + FINISHED.length).replace(/^[:\s]+/, "").trim();

          onEvent({ type: "done", summary: summary || "Task complete." });

          return;

        }

        message = `Exit code: ${exitCode}\n\n${truncate(output) || "<no output>"}`;

      }

      onEvent({ type: "status", text: `Step limit reached (${maxSteps})` });
      onEvent({ type: "error", message: `Step limit (${maxSteps}) reached without a ${FINISHED} marker.` });

    } catch (err) {

      // a stop tears the session down, so the resulting rejection is expected rather than a failure
      if (this.stopped) {

        onEvent({ type: "status", text: "Stopped." });

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
