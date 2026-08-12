import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { ChatSession } from "../sdk/index";
import { parseToolCalls } from "../sdk/tools";

import { estimateTokens } from "./lib/tokens";
import { advertisedTools, prepareCall, VERB_HELP, VERBS } from "./tools/dispatch";
import { recordUsage } from "./usage";

import type { BoodleClient } from "../sdk/client";

const MAX_OBSERVATION = Number(process.env.SWE_MAX_OUTPUT ?? 16000);
const DEFAULT_MAX_STEPS = Number(process.env.SWE_MAX_STEPS ?? 100);
/** Per-command wall clock (default 10 min). Override with SWE_CMD_TIMEOUT_MS. */
const DEFAULT_CMD_TIMEOUT_MS = Number(process.env.SWE_CMD_TIMEOUT_MS ?? 600_000);

const CWD_MARKER = "__SWE_CWD__";

// a model that refuses the harness role usually keeps refusing; bail rather than burn the step budget
const MAX_MISSES = 3;

export type AgentEvent =
  | { type: "delta"; text: string }
  /** Platform chain-of-thought (sectionType Reasoning) — not harness prose. */
  | { type: "reasoning"; text: string }
  | { type: "assistant"; text: string; reasoning?: string }
  | { type: "command"; command: string }
  | { type: "observation"; text: string; exitCode: number }
  | { type: "status"; text: string }
  | { type: "usage"; used: number; step: number }
  | { type: "session"; chatId: string; title: string }
  /** User message injected mid-loop (queued until the next model turn). */
  | { type: "interjection"; text: string }
  | { type: "echo"; text: string }
  | { type: "done"; summary: string }
  | { type: "error"; message: string };

export interface Interjection {

  text: string;
  imagePaths?: string[];

}

export interface AgentOptions {

  client: BoodleClient;
  cwd: string;

  assistantId?: string;

  /** Human label for daily usage totals (falls back to assistantId). */
  modelLabel?: string;

  maxSteps?: number;
  commandTimeoutMs?: number;

  onEvent: (event: AgentEvent) => void;
  approve: (command: string) => Promise<boolean>;

}

export interface AgentRunOptions {

  /** Resume an existing Boodle chat (follow-up). Omit to create a new chat. */
  chatId?: string;

  /** Local image/file paths to upload and attach for this run. */
  imagePaths?: string[];

}

const SHELL = process.env.SWE_SHELL ?? "bash";

/** Fallback sidebar / Boodle title from the user prompt — first few words, capped. */
function titleFromPrompt(task: string): string {

  const cleaned = task.replace(/\s+/g, " ").trim();

  if (!cleaned) {

    return "New chat";

  }

  const words = cleaned.split(" ");
  const title = words.slice(0, 8).join(" ");

  if (title.length > 60) {

    return `${title.slice(0, 57).trimEnd()}…`;

  }

  return words.length > 8 ? `${title}…` : title;

}

/** True when Boodle never assigned a real title (still the create default). */
function isUntitled(name: string): boolean {

  const n = name.replace(/\s+/g, " ").trim().toLowerCase();

  return !n || n === "new chat" || n === "untitled";

}

/** MSYS/Git-Bash path so `export PATH=…` works under bash on Windows. */
function toBashPath(p: string): string {

  const n = p.replace(/\\/g, "/");

  if (process.platform !== "win32") {

    return n;

  }

  const drive = /^([A-Za-z]):\/(.*)$/.exec(n);

  return drive ? `/${drive[1].toLowerCase()}/${drive[2]}` : n;

}

/** Clip a task for sticky re-anchors without blowing the context window. */
function clipTask(task: string, max = 700): string {

  const one = task.replace(/\s+/g, " ").trim();

  if (one.length <= max) {

    return one;

  }

  return `${one.slice(0, max - 1).trimEnd()}…`;

}

function schemaHint() {

  return { tool: advertisedTools(), label: "≤8 words", args: {} };

}

function prompt(cwd: string, task: string): string {

  const win = process.platform === "win32"
    ? "Windows: forward slashes; `cmd //c npm` if shims break under bash.\n"
    : "";

  const tools = VERBS.map((verb) => `  ${verb.padEnd(7)} ${VERB_HELP[verb]}`).join("\n");

  return [
    "You are a coding agent. Each reply is one JSON object (optional thinking prose before it, nothing after):",
    `{"tool":"read","label":"≤8 words","args":{}}`,
    "",
    "tool / args:",
    tools,
    "",
    "label is required and short — it is the UI title.",
    "Prefer read/search/write/edit/delete over run. read returns the whole file. Use only advertised argument names; after an error, correct the call from its message instead of repeating it.",
    "edit: copy old verbatim from a read (including spaces). Several files → args.files: [{path,old,new}].",
    "Before builds/tests, inspect package scripts or project config; use existing tooling (Bun when preferred over npm), but do not waste time debating tool choice.",
    "Follow applicable repository directives such as AGENTS.md or CLAUDE.md.",
    "Do not invent command output. One tool per reply. Do not discuss the protocol — just emit the object.",
    `cwd: ${cwd}  shell: ${SHELL}`,
    win,
    `Task: ${task}`,

  ].join("\n");

}

function followUpPrompt(cwd: string, task: string): string {

  return [
    `Continue. JSON {\"tool\",\"label\",\"args\"} — tool=${advertisedTools()}.`,
    `cwd: ${cwd}`,
    `Follow-up: ${task}`,

  ].join("\n");

}

function observationMessage(opts: {

  ok: boolean;
  tool?: string;
  cwd: string;
  task?: string;
  output?: string;
  error?: string;
  note?: string;
  exit?: number;

}): string {

  const body: Record<string, unknown> = {

    ok: opts.ok,
    cwd: opts.cwd,
    next: schemaHint(),

  };

  if (opts.task) {

    body.task = clipTask(opts.task);

  }

  if (opts.tool) {

    body.tool = opts.tool;

  }

  if (opts.exit != null) {

    body.exit = opts.exit;

  }

  if (opts.output) {

    body.output = truncate(opts.output);

  }

  if (opts.error) {

    body.error = opts.error;

  }

  if (opts.note) {

    body.note = opts.note;

  }

  return JSON.stringify(body);

}

/** Upload local files as Boodle knowledge items (images/docs). */
async function uploadPaths(client: BoodleClient, paths: string[]): Promise<string[]> {

  const ids: string[] = [];

  for (const path of paths) {

    if (!existsSync(path)) {

      throw new Error(`Attachment not found: ${path}`);

    }

    const data = readFileSync(path);
    const name = basename(path);
    const item = await client.uploadKnowledge({ name, data, context: "Chat" });

    ids.push(item.id);

  }

  return ids;

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

function stripCrlfNoise(text: string): string {

  return text
    .split(/\r?\n/)
    .filter((line) => !/LF will be replaced by CRLF|CRLF will be replaced by LF/i.test(line))
    .join("\n");

}

/** Keep exit/errors/tail; drop webpack asset dumps and CRLF warnings. */
function summarizeRun(output: string, exit: number, ms: number): string {

  const clean = stripCrlfNoise(output).trim();
  const lines = clean ? clean.split("\n") : [];
  const header = `exit ${exit} in ${ms}ms`;

  if (lines.length <= 80 && clean.length <= 6000) {

    return `${header}\n${clean}`.trim();

  }

  const errors = lines.filter((line) => /\berror\b|ERR!|ELIFECYCLE|failed to compile/i.test(line)).slice(0, 16);
  const tail = lines.slice(-20).join("\n");
  const parts = [header, `${lines.length} lines`];

  if (errors.length) {

    parts.push(`errors:\n${errors.join("\n")}`);

  }

  if (tail) {

    parts.push(`tail:\n${tail}`);

  }

  return parts.join("\n\n");

}

function truncate(text: string): string {

  if (text.length <= MAX_OBSERVATION) {

    return text;

  }

  const half = Math.floor(MAX_OBSERVATION / 2);
  const cut = text.length - MAX_OBSERVATION;

  // loud, because a silently clipped middle is where the real error usually is
  const notice = [
    "",
    "",
    `===== ${cut} CHARACTERS CUT FROM THE MIDDLE OF THIS OUTPUT =====`,
    "Re-run with a narrower filter (grep -n pattern file, sed -n 'A,Bp', tail) — do not re-page the same window hoping for different lines.",
    "",
    "",
  ].join("\n");

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
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.safecrlf",
        GIT_CONFIG_VALUE_0: "false",
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

  /** Active user task — re-anchored into every observation so multi-part goals do not drift. */
  private task = "";

  /** Cumulative estimated tokens of everything sent + received this run (server keeps full history). */
  private tokensUsed = 0;

  private modelLabel: string;

  /** User notes queued while a turn or command is in flight; drained before the next send. */
  private pending: Interjection[] = [];

  constructor(options: AgentOptions) {

    this.options = options;
    this.modelLabel = (options.modelLabel || options.assistantId || "unknown").trim() || "unknown";

    // bun inlines __dirname; resolve tools relative to the running main bundle (swe/dist)
    const bundleDir = resolve(dirname(process.argv[1] ?? "."));
    const bins = resolveToolBinDirs(bundleDir).map(toBashPath);

    this.toolPath = bins.join(":");

  }

  /**
   * Queue a user message into the active loop. 
   */
  interject(text: string, imagePaths: string[] = []) {

    if (this.stopped || !this.session) {

      throw new Error("No run in progress");

    }

    const trimmed = text.trim();
    const paths = imagePaths.filter(Boolean);

    if (!trimmed && !paths.length) {

      throw new Error("Interjection is empty");

    }

    const note = trimmed || (paths.length ? "Use the attached image(s) for this task." : "");

    this.pending.push({ text: note, imagePaths: paths.length ? paths : undefined });
    this.options.onEvent({ type: "interjection", text: note });
    this.options.onEvent({ type: "status", text: "Note queued" });

  }

  /** Interrupts at whichever point the run is sitting: a running command, or a model turn we are waiting on. */
  stop() {

    if (this.stopped) {

      return;

    }

    this.stopped = true;
    this.pending = [];

    this.options.onEvent({ type: "status", text: "Stopping..." });

    if (this.child) {

      killTree(this.child);

    }

    // disposing rejects the pending final response, so an in-flight turn does not block the stop
    this.session?.dispose();

  }

  /** Fold any queued user notes into the next outbound message; attach new images first. */
  private async applyInterjections(message: string): Promise<string> {

    if (!this.pending.length || !this.session) {

      return message;

    }

    const batch = this.pending;
    this.pending = [];

    const notes: string[] = [];

    for (const item of batch) {

      if (item.imagePaths?.length) {

        const ids = await uploadPaths(this.options.client, item.imagePaths);
        await this.session.attachKnowledge(ids);

      }

      if (item.text.trim()) {

        notes.push(item.text.trim());

      }

    }

    if (!notes.length) {

      return message;

    }

    this.task = [this.task, ...notes].filter(Boolean).join("\n");
    const note = notes.join("\n\n");

    try {

      const raw = JSON.parse(message) as Record<string, unknown>;

      raw.note = note;
      raw.task = clipTask(this.task);
      raw.next = schemaHint();

      return JSON.stringify(raw);

    } catch {

      return observationMessage({

        ok: true,
        cwd: this.cwd,
        task: this.task,
        output: message,
        note,

      });

    }

  }

  private noteTokens(text: string, step: number) {

    const n = estimateTokens(text);

    this.tokensUsed += n;
    recordUsage(this.modelLabel, n);
    this.options.onEvent({ type: "usage", used: this.tokensUsed, step });

  }

  async run(task: string, runOptions: AgentRunOptions = {}): Promise<void> {

    const { client, onEvent, approve } = this.options;

    const maxSteps = this.options.maxSteps ?? DEFAULT_MAX_STEPS;
    const timeoutMs = this.options.commandTimeoutMs ?? DEFAULT_CMD_TIMEOUT_MS;

    // forward slashes, because a backslash path in a bash prompt is a trap
    this.cwd = this.options.cwd.replaceAll("\\", "/");
    this.task = task;
    this.tokensUsed = 0;

    const followUp = Boolean(runOptions.chatId);
    const imagePaths = (runOptions.imagePaths ?? []).filter(Boolean);

    // only new chats get a prompt-fallback title if Boodle never auto-named them
    let newChatId: string | null = null;

    try {

      onEvent({ type: "status", text: imagePaths.length ? "Uploading" : "Thinking" });

      let knowledgeIds: string[] = [];

      if (imagePaths.length) {

        knowledgeIds = await uploadPaths(client, imagePaths);

      }

      if (this.stopped) {

        onEvent({ type: "status", text: "Stopped" });

        return;

      }

      const session = followUp
        ? await ChatSession.open(client, runOptions.chatId!, {

            assistantId: this.options.assistantId,
            refreshOnComplete: false,

          })
        : await ChatSession.create(client, {

            assistantId: this.options.assistantId,
            refreshOnComplete: false,
            knowledgeIds: knowledgeIds.length ? knowledgeIds : undefined,

          });

      this.session = session;

      // follow-ups: attach any new images to the existing chat
      if (followUp && knowledgeIds.length) {

        await session.attachKnowledge(knowledgeIds);

      }

      // seed sidebar with whatever Boodle has; auto-title may replace it during the run
      const seedTitle = session.state.chat?.name?.trim() || "New chat";

      onEvent({ type: "session", chatId: session.chatId, title: seedTitle });

      if (!followUp) {

        newChatId = session.chatId;

      }

      // history lives on the server, so each step only sends the new observation
      // stream only answer deltas into the fence parser — reasoning is a separate channel
      this.session.on((event) => {

        if (event.type !== "stream") {

          return;

        }

        const { change } = event;

        if (change.kind === "delta") {

          if (change.sectionType?.toLowerCase() === "reasoning") {

            onEvent({ type: "reasoning", text: change.text });

          } else {

            onEvent({ type: "delta", text: change.text });

          }

        }

      });

      let message = followUp ? followUpPrompt(this.cwd, task) : prompt(this.cwd, task);
      let misses = 0;
      let firstSend = true;

      for (let step = 1; step <= maxSteps; step += 1) {

        if (this.stopped) {

          onEvent({ type: "status", text: "Stopped" });

          return;

        }

        // Thinking | Drafting | Running — default working state is Thinking
        const phase = (text: string) => onEvent({ type: "status", text: `Step ${step} · ${text}` });

        // mid-loop user notes land here — after the prior command, before the next model turn
        message = await this.applyInterjections(message);

        if (this.stopped) {

          onEvent({ type: "status", text: "Stopped" });

          return;

        }

        phase("Thinking");
        this.noteTokens(message, step);

        let drafting = false;

        const unsubDraft = this.session.on((event) => {

          if (event.type === "stream" && event.change.kind === "delta" && event.change.sectionType?.toLowerCase() !== "reasoning" && !drafting) {

            drafting = true;
            phase("Drafting");

          }

        });

        // attach knowledgeIds only on the first user message of a new chat (createChat already linked them;
        // re-send is harmless; on follow-up we already attachKnowledge above)
        const sendOpts = firstSend && knowledgeIds.length && !followUp
          ? { knowledgeIds }
          : {};

        firstSend = false;

        const turn = await this.session.send(message, sendOpts);

        unsubDraft();

        if (this.stopped) {

          onEvent({ type: "status", text: "Stopped" });

          return;

        }

        this.noteTokens(turn.text + (turn.reasoning ?? ""), step);
        onEvent({ type: "assistant", text: turn.text, reasoning: turn.reasoning });
        phase("Thinking");

        const call = parseToolCalls(turn.text)[0];

        if (!call) {

          misses += 1;

          if (misses >= MAX_MISSES) {

            onEvent({ type: "error", message: `${misses} replies in a row were not a JSON tool call. Try a different model.` });

            return;

          }

          message = observationMessage({

            ok: false,
            cwd: this.cwd,
            task: this.task,
            error: `Need one JSON object: {\"tool\",\"label\",\"args\"}. tool=${advertisedTools()}`,

          });

          continue;

        }

        let exec;

        try {

          exec = prepareCall(call, this.cwd);

        } catch (err) {

          misses += 1;

          if (misses >= MAX_MISSES) {

            onEvent({ type: "error", message: err instanceof Error ? err.message : String(err) });

            return;

          }

          message = observationMessage({

            ok: false,
            cwd: this.cwd,
            task: this.task,
            error: err instanceof Error ? err.message : String(err),

          });

          continue;

        }

        misses = 0;

        const command = JSON.stringify({ tool: exec.tool, label: exec.label, args: call.args });

        onEvent({ type: "command", command });

        if (exec.kind === "done") {

          if (this.pending.length) {

            message = await this.applyInterjections(observationMessage({

              ok: false,
              tool: "done",
              cwd: this.cwd,
              task: this.task,
              error: `You were about to finish (${exec.summary}). A new user note arrived — address it first.`,

            }));

            continue;

          }

          onEvent({ type: "done", summary: exec.summary ?? exec.label });

          return;

        }

        if (exec.kind === "echo") {

          onEvent({ type: "echo", text: exec.output ?? exec.label });
          message = observationMessage({ ok: true, tool: exec.tool, cwd: this.cwd, task: this.task, output: "Message shown to user.", exit: 0 });
          continue;

        }

        const needsApproval = exec.kind === "run" || exec.tool === "delete";
        const approvePayload = exec.command ?? command;

        if (needsApproval) {

          const waiting = setTimeout(() => phase("Thinking"), 40);
          const ok = await approve(approvePayload);

          clearTimeout(waiting);

          if (!ok) {

            message = observationMessage({

              ok: false,
              tool: exec.tool,
              cwd: this.cwd,
              task: this.task,
              error: "User declined that action. Choose a different tool.",

            });

            continue;

          }

        }

        phase("Running");

        let output = exec.output ?? "";
        let exitCode = exec.exit ?? 0;

        if (exec.kind === "run" && exec.command) {

          const started = Date.now();
          const run = await runCommand(wrapCommand(exec.command, this.toolPath), this.cwd, timeoutMs, (child) => {

            this.child = child;

          });

          this.child = null;

          const parsed = parseRun(run.output);

          output = summarizeRun(parsed.output, run.exitCode, Date.now() - started);
          exitCode = run.exitCode;

          if (parsed.cwd && parsed.cwd !== this.cwd && existsSync(parsed.cwd)) {

            this.cwd = parsed.cwd;

          }

        }

        if (this.stopped) {

          onEvent({ type: "observation", text: output, exitCode });
          onEvent({ type: "status", text: "Stopped" });

          return;

        }

        onEvent({ type: "observation", text: output, exitCode });

        let error: string | undefined;

        if (exitCode !== 0 && exec.tool === "edit") {

          error = "Some files failed (see FAILED lines). Re-read only those files and retry just them — do not rewrite via run.";

        }

        message = observationMessage({

          ok: exitCode === 0,
          tool: exec.tool,
          cwd: this.cwd,
          task: this.task,
          output,
          exit: exitCode,
          error,

        });

      }

      onEvent({ type: "status", text: `Step limit reached (${maxSteps})` });
      onEvent({ type: "error", message: `Step limit (${maxSteps}) reached without a done call.` });

    } catch (err) {

      // a stop tears the session down, so the resulting rejection is expected rather than a failure
      if (this.stopped) {

        onEvent({ type: "status", text: "Stopped" });

      } else {

        onEvent({ type: "error", message: err instanceof Error ? err.message : String(err) });

      }

    } finally {

      // if auto-title never fired, fall back to the first words of the prompt
      if (newChatId) {

        try {

          const detail = await client.getChat(newChatId);
          const current = (detail.chat?.name ?? "").trim();

          if (isUntitled(current)) {

            const title = titleFromPrompt(task);

            await client.renameChat(newChatId, title);
            onEvent({ type: "session", chatId: newChatId, title });

          } else {

            // surface Boodle's name so the sidebar does not stay on "New chat"
            onEvent({ type: "session", chatId: newChatId, title: current });

          }

        } catch {

          // naming is best-effort
        }

      }

      this.session?.dispose();

      this.session = null;
      this.child = null;
      this.pending = [];

    }

  }

}
