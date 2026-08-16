import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { ChatSession } from "../../sdk/index";

import { agentInstructions, FINISH_REMINDER, followUpPrompt, formatResults, NUDGE, parseActions, SPEED_UP, subagentPrompt, subagentTask, systemPrompt, type Action, type Result } from "./Protocol";

import { isAgentModelId, llmIdFromAgentModel } from "../Utils/Models";
import { estimateTokens } from "../Utils/Tokens";

import { formatAnswer, type Answer, type Question } from "../Tools/Ask";
import { execute } from "../Tools/Dispatch";
import { formatDecision, type Plan, type PlanDecision } from "../Tools/Plan";
import { parseRetryRange, selectRetry } from "../Tools/Retry";
import { formatReports, type SubagentReport, type SubagentTask } from "../Tools/Subagent";
import { projectDoc, repoMap } from "../Tools/FS";
import { captureSnapshot } from "../Tools/Snapshot";

import { recordUsage } from "../Main/Usage";

import type { BoodleClient } from "../../sdk/client";

const MAX_OBSERVATION = Number(process.env.SWE_MAX_OUTPUT ?? 24000);

/** Hard ceiling on a single command's captured output, so a runaway process cannot exhaust memory. */
const MAX_RUN_BUFFER = Number(process.env.SWE_MAX_RUN_BUFFER ?? 2_000_000);
const DEFAULT_MAX_STEPS = Number(process.env.SWE_MAX_STEPS ?? 100);

/** Per-command wall clock (default 10 min). Override with SWE_CMD_TIMEOUT_MS. */
const DEFAULT_CMD_TIMEOUT_MS = Number(process.env.SWE_CMD_TIMEOUT_MS ?? 600_000);

const CWD_MARKER = "__SWE_CWD__";

// a model that will not emit a block usually keeps not emitting one; bail rather than burn the budget
const MAX_MISSES = 3;

/** Talk-only turns tolerated before the loop asks whether the run should have ended. */
const MAX_QUIET_TURNS = 2;

// one reply may carry a batch, but a wall of blocks is a model that has stopped looking at results
const MAX_ACTIONS_PER_TURN = 8;

// a child is scoped to one errand; a budget near the parent's means it was the wrong errand
const SUBAGENT_MAX_STEPS = Number(process.env.SWE_SUBAGENT_MAX_STEPS ?? 40);

/**
 * Serialises everything that needs the user.
*/
class Gate {

  private tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => Promise<T>): Promise<T> {

    const next = this.tail.then(job, job);

    this.tail = next.catch(() => undefined);

    return next;

  }

}

export type AgentEvent =
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string } /** Platform chain-of-thought (sectionType Reasoning). */
  | { type: "assistant"; text: string; reasoning?: string }
  | { type: "command"; command: string }
  | { type: "observation"; text: string; exitCode: number }
  | { type: "status"; text: string }
  | { type: "usage"; used: number; step: number }
  | { type: "session"; chatId: string; title: string; botAssistantId?: string } /** Worktree commit in the shadow store, taken before this run touched anything. */
  | { type: "snapshot"; commit: string }
  | { type: "interjection"; text: string } /** User message injected mid-loop (queued until the next model turn). */
  | { type: "say"; text: string }
  | { type: "done"; summary: string }

  | { type: "subagent:start"; id: string; name: string; task: string } /** A child opened; its blocks arrive as `subagent:event` until `subagent:end` settles the card. */
  | { type: "subagent:event"; id: string; event: AgentEvent }
  | { type: "subagent:end"; id: string; ok: boolean; summary: string }

  | { type: "error"; message: string };

export interface Interjection {

  text: string;
  imagePaths?: string[];

}

export interface AgentOptions {

  client: BoodleClient;
  cwd: string;

  assistantId?: string;

  /** Published custom-bot id when resuming an Agent-Native chat. */
  botAssistantId?: string;

  /** Human label for daily usage totals (falls back to assistantId). */
  modelLabel?: string;

  maxSteps?: number;
  commandTimeoutMs?: number;

  /** 0 for a run the user started; a spawned child runs at 1 and may not spawn again. */
  depth?: number;

  /** Set on a spawned child: the name its parent gave it, which frames its prompt. */
  subagentName?: string;

  onEvent: (event: AgentEvent) => void;
  approve: (command: string) => Promise<boolean>;

  /** Park the run on a question and resolve with whatever the user picked. */
  ask: (question: Question) => Promise<Answer>;

  /** Park the run on a plan and resolve with whether to build it, and on which model. */
  plan: (plan: Plan) => Promise<PlanDecision>;

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

/** Upload local files as Boodle knowledge items (images/docs). */
async function uploadPaths(client: BoodleClient, paths: string[]): Promise<string[]> {

  // validate every path before any upload starts, so a bad attachment fails the batch cleanly
  for (const path of paths) {

    if (!existsSync(path)) {

      throw new Error(`Attachment not found: ${path}`);

    }

  }

  // uploads are independent — run them concurrently; Promise.all preserves input order
  const items = await Promise.all(paths.map((path) => client.uploadKnowledge({

    name: basename(path),
    data: readFileSync(path),
    context: "Chat",

  })));

  return items.map((item) => item.id);

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

/** Keep exit/errors/tail; drop asset dumps and CRLF warnings. */
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

function truncate(text: string, max = MAX_OBSERVATION): string {

  if (text.length <= max) {

    return text;

  }

  const half = Math.floor(max / 2);
  const dropped = text.length - max;

  return `${text.slice(0, half)}\n\n... ${dropped} characters cut from the middle ...\n\n${text.slice(-half)}`;

}

/**
 * PATH prefixes for bundled tools (sg/ast-grep)
*/
export function wrapCommand(command: string, toolBins?: string): string {

  // $PWD under Git Bash is an MSYS path (/tmp, /c/...) that Windows cannot spawn into; pwd -W gives the native one
  const pwd = process.platform === "win32" ? '"$(pwd -W 2>/dev/null || pwd)"' : '"$PWD"';
  const pathPrefix = toolBins ? `export PATH="${toolBins}:$PATH"\n` : "";

  return `${pathPrefix}${command}\n__swe_status=$?\nprintf '\\n${CWD_MARKER}%s\\n' ${pwd}\nexit $__swe_status\n`;

}

/** Resolve dirs that contain node_modules/.bin (sg). */
export function resolveToolBinDirs(bundleDir: string): string[] {

  const dirs: string[] = [];

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

    // bounded: keep the head plus a rolling tail, dropping the middle. summarizeRun leans on the
    // tail for failures, so a plain head-cap would throw away the part that matters.
    const half = Math.floor(MAX_RUN_BUFFER / 2);

    let head = "";
    let tail = "";
    let dropped = 0;
    let notice = "";

    const append = (chunk: unknown) => {

      const text = String(chunk);

      if (head.length < half) {

        head += text;

        return;

      }

      tail += text;

      if (tail.length > half) {

        const cut = tail.length - half;

        tail = tail.slice(cut);
        dropped += cut;

      }

    };

    const collected = () => {

      const middle = dropped ? `\n<${dropped} characters dropped from the middle of this output>\n` : "";

      return `${head}${middle}${tail}${notice}`;

    };

    const timer = setTimeout(() => {

      timedOut = true;
      killTree(child);
      notice += `\n<command killed after ${timeoutMs}ms (timeout)>`;

      // never leave the agent parked if the shell ignores SIGKILL / taskkill races
      forceTimer = setTimeout(() => {

        done({ output: collected(), exitCode: EXIT_TIMEOUT });

      }, KILL_GRACE_MS);

    }, timeoutMs);

    child.stdout.on("data", append);
    child.stderr.on("data", append);

    child.on("error", (err) => {

      clearTimeout(timer);
      done({ output: `${collected()}\nfailed to run ${SHELL} in ${cwd}: ${err.message}`.trim(), exitCode: -1 });

    });

    // "exit", not "close": a killed shell can leave a grandchild holding the pipes, and close would wait for it
    child.on("exit", (code) => {

      clearTimeout(timer);

      // small drain so a last stderr flush from taskkill lands in output
      setTimeout(() => {

        done({

          output: collected(),
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

  /** User asked to cut the current turn short; consumed on the next loop beat. */
  private hurry = false;

  private cwd = "";
  private toolPath = "";

  /** Cumulative estimated tokens of everything sent + received this run (server keeps full history). */
  private tokensUsed = 0;

  private modelLabel: string;

  private depth: number;

  /** Live children, so a stop or a speed-up reaches them too. */
  private children = new Map<string, MiniAgent>();

  /** Approvals and questions from parallel children queue here — the UI holds one card. */
  private gate = new Gate();

  private subagentSeq = 0;

  /** Set when the user hands a plan to another model: every later turn sends as that assistant. */
  private handoff: string | null = null;

  /** Blocks a failed batch left unrun, kept whole so <retry> can replay them without a retype. */
  private cancelled: Action[] = [];

  /** User notes queued while a turn or command is in flight; drained before the next send. */
  private pending: Interjection[] = [];

  constructor(options: AgentOptions) {

    this.options = options;
    this.modelLabel = (options.modelLabel || options.assistantId || "unknown").trim() || "unknown";
    this.depth = options.depth ?? 0;

    // bun inlines __dirname; resolve tools relative to the running main bundle (swe/dist)
    const bundleDir = resolve(dirname(process.argv[1] ?? "."));

    this.toolPath = resolveToolBinDirs(bundleDir).map(toBashPath).join(":");

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

  /** Cancel the in-flight model turn (or command) and tell the next beat to wrap up. */
  speedUp() {

    if (this.stopped || !this.session) {

      throw new Error("No run in progress");

    }

    this.hurry = true;
    this.options.onEvent({ type: "status", text: "Speeding up" });

    for (const child of this.children.values()) {

      try {

        child.speedUp();

      } catch {

        // that child has not opened its session yet; it will see the stop instead
      }

    }

    if (this.child) {

      killTree(this.child);

    }

    void this.session.cancel();

  }

  /** Interrupts at whichever point the run is sitting: a running command, or a model turn we are waiting on. */
  stop() {

    if (this.stopped) {

      return;

    }

    this.stopped = true;
    this.hurry = false;
    this.pending = [];

    for (const child of this.children.values()) {

      child.stop();

    }

    this.options.onEvent({ type: "status", text: "Stopping..." });

    if (this.child) {

      killTree(this.child);

    }

    // disposing rejects the pending final response, so an in-flight turn does not block the stop
    this.session?.dispose();

  }

  /** Fold queued user notes into the next message as their own block; attach new images first. */
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

    return `${message}\n\n[user]\n${notes.join("\n\n")}`;

  }

  private noteTokens(text: string, step: number) {

    const n = estimateTokens(text);

    this.tokensUsed += n;
    recordUsage(this.modelLabel, n);

    this.options.onEvent({ type: "usage", used: this.tokensUsed, step });

  }

  /**
   * Hand off the run to another model, either a Boodle assistant or a provisioned agent.
  */
  private async takeHandoff(assistantId: string, label: string): Promise<void> {

    if (!assistantId || assistantId === this.options.assistantId) {

      return;

    }

    if (isAgentModelId(assistantId)) {

      this.options.onEvent({ type: "status", text: "Preparing agent" });

      const bot = await this.options.client.provisionAgentBot({

        llmId: llmIdFromAgentModel(assistantId),
        modelName: label || assistantId,
        instructions: agentInstructions(repoMap(this.cwd), projectDoc(this.cwd)),

      });

      this.handoff = bot.assistantId;

    } else {

      this.handoff = assistantId;

    }

    this.modelLabel = label.trim() || assistantId;

  }

  /**
   * Swap every <retry> for the blocks a previous batch held.
  */
  private expandRetries(sent: Action[]): { actions: Action[]; failure: { action: Action; text: string } | null } {

    if (!sent.some((action) => action.verb === "retry")) {

      return { actions: sent, failure: null };

    }

    const actions: Action[] = [];

    for (const action of sent) {

      if (action.verb !== "retry") {

        actions.push(action);

        continue;

      }

      try {

        actions.push(...selectRetry(this.cancelled, parseRetryRange(action)));

      } catch (err) {

        return { actions, failure: { action, text: err instanceof Error ? err.message : String(err) } };

      }

    }

    return { actions, failure: null };

  }

  private async confirm(command: string): Promise<boolean> {

    this.options.onEvent({ type: "status", text: "Waiting for approval" });

    return this.options.approve(command);

  }

  /** One block: execute it, tell the UI, hand back what the model should see. */
  private async runAction(action: Action, timeoutMs: number): Promise<Result | "done"> {

    const { onEvent } = this.options;

    onEvent({ type: "command", command: action.raw });

    if (action.verb === "delete" && !(await this.confirm(`delete ${action.path || action.body.trim()}`))) {

      const text = "The user declined that delete. Do something else.";

      onEvent({ type: "observation", text, exitCode: 1 });

      return { verb: "delete", ok: false, text };

    }

    let outcome;

    try {

      outcome = execute(action, this.cwd);

    } catch (err) {

      const text = err instanceof Error ? err.message : String(err);

      onEvent({ type: "observation", text, exitCode: 1 });

      return { verb: action.verb, ok: false, text };

    }

    if (outcome.kind === "done") {

      if (this.pending.length) {

        const text = "A new note from the user arrived before you finished. Read it below and address it first.";

        onEvent({ type: "observation", text, exitCode: 1 });

        return { verb: "done", ok: false, text };

      }

      onEvent({ type: "observation", text: outcome.summary, exitCode: 0 });
      onEvent({ type: "done", summary: outcome.summary });

      return "done";

    }

    if (outcome.kind === "say") {

      onEvent({ type: "say", text: outcome.text });
      return { verb: "say", ok: true, text: "shown to the user" };

    }

    if (outcome.kind === "result") {

      const { result } = outcome;

      onEvent({ type: "observation", text: result.text, exitCode: result.ok ? 0 : 1 });

      return { ...result, text: truncate(result.text) };

    }

    if (outcome.kind === "ask") {

      onEvent({ type: "status", text: "Waiting for an answer" });

      const answer = await this.options.ask(outcome.question);
      const text = formatAnswer(outcome.question, answer);

      onEvent({ type: "observation", text, exitCode: answer.dismissed ? 1 : 0 });

      return { verb: "ask", ok: !answer.dismissed, text };

    }

    if (outcome.kind === "plan") {

      onEvent({ type: "status", text: "Waiting on the plan" });

      const decision = await this.options.plan(outcome.plan);

      if (decision.build) {

        await this.takeHandoff(decision.assistantId, decision.modelLabel);

      }

      const text = formatDecision(outcome.plan, decision);

      onEvent({ type: "observation", text, exitCode: decision.build ? 0 : 1 });

      return { verb: "plan", ok: decision.build, text };

    }

    if (outcome.kind === "spawn") {

      if (this.depth > 0) {

        const text = "You are a subagent — you cannot spawn your own. Do this part yourself.";

        onEvent({ type: "observation", text, exitCode: 1 });

        return { verb: "spawn", ok: false, text };

      }

      const count = outcome.tasks.length;

      onEvent({ type: "status", text: count === 1 ? "Running 1 subagent" : `Running ${count} subagents` });

      const reports = await Promise.all(outcome.tasks.map((task) => this.runSubagent(task, timeoutMs)));

      const text = formatReports(reports);
      const ok = reports.every((report) => report.ok);

      onEvent({ type: "observation", text, exitCode: ok ? 0 : 1 });

      return { verb: "spawn", ok, text: truncate(text) };

    }

    if (!(await this.confirm(outcome.command))) {

      const text = "The user declined that command. Do something else.";

      onEvent({ type: "observation", text, exitCode: 1 });

      return { verb: "run", ok: false, text };

    }

    onEvent({ type: "status", text: "Running" });

    const started = Date.now();
    const run = await runCommand(wrapCommand(outcome.command, this.toolPath), this.cwd, timeoutMs, (child) => {

      this.child = child;

    });

    this.child = null;

    const parsed = parseRun(run.output);
    const text = summarizeRun(parsed.output, run.exitCode, Date.now() - started);

    if (parsed.cwd && parsed.cwd !== this.cwd && existsSync(parsed.cwd)) {

      this.cwd = parsed.cwd;

    }

    onEvent({ type: "observation", text, exitCode: run.exitCode });

    return { verb: "run", ok: run.exitCode === 0, text: truncate(text) };

  }

  /**
   * Runs a subagent in a child MiniAgent, reporting its blocks back to the parent.
  */
  private async runSubagent(task: SubagentTask, timeoutMs: number): Promise<SubagentReport> {

    const { onEvent } = this.options;

    const id = `sub${(this.subagentSeq += 1)}`;

    const state = {

      chatId: "",

      summary: "",
      failure: "",

      counted: 0,

      lastSay: "",
      lastAssistant: "",
      lastStatus: "",

      stopped: false,

    };

    const child = new MiniAgent({

      client: this.options.client,
      cwd: this.cwd,

      // the published bot carries the protocol, so an Agent-Native parent spawns Agent-Native children

      assistantId: this.options.assistantId,
      botAssistantId: this.options.botAssistantId,
      modelLabel: this.options.modelLabel,

      subagentName: task.name,

      maxSteps: SUBAGENT_MAX_STEPS,
      commandTimeoutMs: timeoutMs,

      depth: this.depth + 1,

      onEvent: (event) => {

        // a child's chat must never repoint the sidebar or claim the parent's undo marks
        if (event.type === "session") {

          state.chatId = event.chatId;

          return;

        }

        if (event.type === "usage") {

          const delta = Math.max(0, event.used - state.counted);

          state.counted = event.used;
          this.tokensUsed += delta;

          onEvent({ type: "usage", used: this.tokensUsed, step: event.step });

          return;

        }

        if (event.type === "done") {

          state.summary = event.summary;

        }

        if (event.type === "error") {

          state.failure = event.message;

        }

        // salvages material for a report when <done> never lands: the last <say>

        if (event.type === "say") {

          state.lastSay = event.text;

        }

        if (event.type === "assistant") {

          state.lastAssistant = event.text;

        }

        if (event.type === "status") {

          state.lastStatus = event.text;

        }

        // four children streaming tokens at once buys nothing but IPC; their settled rows are enough
        if (event.type === "delta" || event.type === "reasoning" || event.type === "assistant" || event.type === "snapshot" || event.type === "interjection") {

          return;

        }

        onEvent({ type: "subagent:event", id, event });

      },

      approve: (command) => this.gate.run(() => this.options.approve(command)),
      ask: (question) => this.gate.run(() => this.options.ask({ ...question, prompt: `${task.name} · ${question.prompt}` })),
      plan: (plan) => this.gate.run(() => this.options.plan(plan)),

    });

    this.children.set(id, child);

    onEvent({ type: "subagent:start", id, name: task.name, task: task.task });

    try {

      await child.run(task.task);

    } catch (err) {

      // a user-initiated stop tears the child's session down; the resulting rejection is not a failure
      if (this.stopped) {

        state.stopped = true;

      } else {

        state.failure = state.failure || (err instanceof Error ? err.message : String(err));

      }

    } finally {

      this.children.delete(id);

      if (state.chatId) {

        try {

          await this.options.client.deleteChat(state.chatId);

        } catch {

          // the work is already reported; a stranded chat is not worth failing the parent over
        }

      }

    }

    // salvage summary when <done> never fired: prefer explicit failure

    const salvaged = state.summary
      || (state.failure ? `Did not finish: ${state.failure}` : "")
      || (state.stopped ? "Stopped by the user before reporting." : "")
      || (state.lastSay ? `No <done> was called. Last said: ${state.lastSay}` : "")
      || (state.lastAssistant ? `No <done> was called. Last reply:\n\n${state.lastAssistant}` : "")
      || (state.lastStatus ? `The subagent stopped without a summary (last status: ${state.lastStatus}).` : "")
      || "The subagent stopped without a summary.";

    const ok = Boolean(state.summary) && !state.failure && !state.stopped;

    const report: SubagentReport = {

      name: task.name,
      ok,

      // cap per-child so one long report cannot swallow the middle of a sibling's when they're joined
      summary: truncate(salvaged, Math.floor(MAX_OBSERVATION / 2)),

    };

    onEvent({ type: "subagent:end", id, ok, summary: report.summary });

    return report;

  }

  async run(task: string, runOptions: AgentRunOptions = {}): Promise<void> {

    const { client, onEvent } = this.options;

    const maxSteps = this.options.maxSteps ?? DEFAULT_MAX_STEPS;
    const timeoutMs = this.options.commandTimeoutMs ?? DEFAULT_CMD_TIMEOUT_MS;

    // forward slashes, because a backslash path in a bash prompt is a trap
    this.cwd = this.options.cwd.replaceAll("\\", "/");
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

      const pickerId = this.options.assistantId;
      const agentNative = isAgentModelId(pickerId);

      let sendAssistantId = pickerId;
      let botAssistantId: string | undefined;

      if (agentNative && pickerId) {

        // a child has no chatId, so gating reuse on followUp made every one provision its own bot
        if (this.options.botAssistantId) {

          sendAssistantId = this.options.botAssistantId;
          botAssistantId = this.options.botAssistantId;

        } else {

          onEvent({ type: "status", text: "Preparing agent" });

          const llmId = llmIdFromAgentModel(pickerId);
          const bot = await client.provisionAgentBot({

            llmId,
            modelName: this.modelLabel,
            instructions: agentInstructions(repoMap(this.cwd), projectDoc(this.cwd)),

          });

          sendAssistantId = bot.assistantId;
          botAssistantId = bot.assistantId;

        }

      }

      const session = followUp ? await ChatSession.open(client, runOptions.chatId!, {

        assistantId: sendAssistantId,
        refreshOnComplete: false,

      }) : await ChatSession.create(client, {

        assistantId: sendAssistantId,
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

      onEvent({ type: "session", chatId: session.chatId, title: seedTitle, botAssistantId });

      const snapshot = this.depth === 0 ? captureSnapshot(this.cwd, `before ${titleFromPrompt(task)}`) : null;

      if (snapshot) {

        onEvent({ type: "snapshot", commit: snapshot });

      }

      if (!followUp) {

        newChatId = session.chatId;

      }

      // history lives on the server, so each step only sends the new results
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

      const map = repoMap(this.cwd);
      const subName = this.options.subagentName;

      // wraps the task in a system prompt when it needs it

      let message = followUp ? followUpPrompt(map, task) : subName
          ? agentNative ? subagentTask(subName, task): subagentPrompt(map, projectDoc(this.cwd), subName, task)
          : agentNative ? task : systemPrompt(map, projectDoc(this.cwd), task);

      let misses = 0;
      let quiet = 0;

      let firstSend = true;

      for (let step = 1; step <= maxSteps; step += 1) {

        if (this.stopped) {

          onEvent({ type: "status", text: "Stopped" });

          return;

        }

        const phase = (text: string) => onEvent({ type: "status", text: `Step ${step} · ${text}` });

        // mid-loop user notes land here — after the prior results, before the next model turn
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

        // attach knowledgeIds only on the first user message of a new chat

        const sendOpts: { knowledgeIds?: string[]; assistantId?: string } = firstSend && knowledgeIds.length && !followUp ? { knowledgeIds } : {};

        if (this.handoff) {

          sendOpts.assistantId = this.handoff;

        }

        firstSend = false;

        let turn;

        try {

          turn = await this.session.send(message, sendOpts);

        } catch (err) {

          unsubDraft();

          if (this.stopped) {

            onEvent({ type: "status", text: "Stopped" });

            return;

          }

          if (this.hurry) {

            this.hurry = false;
            message = SPEED_UP;
            continue;

          }

          throw err;

        }

        unsubDraft();

        if (this.stopped) {

          onEvent({ type: "status", text: "Stopped" });

          return;

        }

        if (this.hurry) {

          this.hurry = false;
          message = SPEED_UP;
          continue;

        }

        this.noteTokens(turn.text + (turn.reasoning ?? ""), step);
        onEvent({ type: "assistant", text: turn.text, reasoning: turn.reasoning });
        phase("Working");

        const { actions: sent } = parseActions(turn.text);

        if (!sent.length) {

          misses += 1;

          if (misses >= MAX_MISSES) {

            onEvent({ type: "error", message: `${misses} replies in a row carried no action block. Try a different model.` });

            return;

          }

          message = NUDGE;
          continue;

        }

        misses = 0;

        const { actions, failure } = this.expandRetries(sent);

        if (failure) {

          onEvent({ type: "command", command: failure.action.raw });
          onEvent({ type: "observation", text: failure.text, exitCode: 1 });

          message = formatResults([{ verb: "retry", ok: false, text: failure.text }]);
          continue;

        }

        const results: Result[] = [];
        const batch = actions.slice(0, MAX_ACTIONS_PER_TURN);

        for (const action of batch) {

          if (this.hurry) {

            break;

          }

          const result = await this.runAction(action, timeoutMs);

          if (result === "done") {

            return;

          }

          results.push(result);

          if (this.stopped) {

            onEvent({ type: "status", text: "Stopped" });

            return;

          }

          if (this.hurry) {

            break;

          }

          // a failed block usually invalidates the ones behind it; we should let the model look first
          if (!result.ok) {

            break;

          }

        }

        const skipped = actions.length - results.length;

        // held rather than dropped: the harness still has them, so retyping them is pure risk
        this.cancelled = actions.slice(results.length);

        // say does no work, so a batch of nothing else moved the task no further along
        quiet = batch.length && batch.every((action) => action.verb === "say") ? quiet + 1 : 0;

        const notes: string[] = [];

        if (quiet >= MAX_QUIET_TURNS) {

          quiet = 0;
          notes.push(FINISH_REMINDER);

        }

        if (this.hurry) {

          this.hurry = false;
          notes.push("The user interrupted because this is taking too long. Stop exploring and finish now.");

        }

        if (skipped > 0) {

          notes.push(`${skipped} later ${skipped === 1 ? "block" : "blocks"} in that reply did not run, and ${skipped === 1 ? "it is" : "they are"} held exactly as you sent ${skipped === 1 ? "it" : "them"}. Once you have fixed what failed, send <retry> to run ${skipped === 1 ? "it" : "them"} again${skipped === 1 ? "" : " — or <retry 1,3> for only some of them"}. Do not retype ${skipped === 1 ? "it" : "them"}.`);

        }

        // labels drift away first when a reply gets long; saying so costs a line and fixes the next one
        const unlabelled = batch.filter((action) => !action.label && action.verb !== "say" && action.verb !== "done").length;

        if (unlabelled) {

          notes.push(`${unlabelled === 1 ? "A block" : `${unlabelled} blocks`} had no title line above ${unlabelled === 1 ? "it" : "them"}, so ${unlabelled === 1 ? "that row is" : "those rows are"} unlabelled for the user. Put three to six words on the line directly above every block.`);

        }

        message = notes.length ? `${formatResults(results)}\n\n[harness]\n${notes.join("\n")}` : formatResults(results);

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
      if (newChatId && this.depth === 0) {

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
      this.children.clear();

    }

  }

}
