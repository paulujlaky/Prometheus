import { Component, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { CheckIcon, ChevronDownIcon, FolderOpenIcon, PlayIcon, ShieldAlertIcon, ShieldCheckIcon, ShieldIcon, TriangleAlertIcon, XIcon } from "lucide-react";

import { AskCard } from "@/comps/ask-card";
import { Composer } from "@/comps/composer";
import { PlanCard } from "@/comps/plan-card";
import type { UsageFile } from "@/comps/heatmap";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/comps/ui/dropdown";

import { contextLimitOf, displayName } from "@/lib/models";
import { usageOf } from "@/lib/tokens";
import { cn } from "@/lib/utils";

import { Sidebar, type SweChat } from "./sidebar";
import { fileEdits, inferTool } from "./parse";
import { cleanSummary, parseReply, streamStep, Transcript, type Entry, type Step, type SubagentEntry, type UndoInfo } from "./transcript";

import type { AgentEvent } from "./agent";
import type { Answer, Question } from "./tools/ask";
import type { Plan, PlanDecision } from "./tools/plan";
import type { UndoMark } from "./tools/snapshot";
import type { AssistantSummary } from "../sdk/types";

import { PrefsPanel } from "./prefs-panel";
import type { Preferences } from "./lib/prefs";

import "./index.css";

interface SweBridge {

  models: () => Promise<AssistantSummary[]>;
  preferredModel: () => Promise<string | null>;
  pickDir: () => Promise<string | null>;
  lastCwd: () => Promise<string | null>;
  setCwd: (cwd: string) => Promise<string | null>;
  recentProjects: () => Promise<{ dir: string; count: number }[]>;
  openProject: (cwd: string) => Promise<{ dir: string; recentProjects: { dir: string; count: number }[] } | null>;

  usage: () => Promise<UsageFile>;

  prefs: () => Promise<Preferences>;
  setPrefs: (patch: Partial<Preferences>) => Promise<Preferences>;

  undos: (chatId: string) => Promise<UndoMark[]>;
  undo: (chatId: string, commit: string) => Promise<{ ok: boolean; files: string[]; text: string }>;

  listChats: (projectDir?: string | null) => Promise<SweChat[]>;
  deleteChat: (chatId: string) => Promise<void>;
  renameChat: (chatId: string, name: string) => Promise<void>;
  getChat: (chatId: string) => Promise<{ id: string; name: string; title: string; project?: string | null; modelId?: string | null; entries: Entry[]; undos?: UndoMark[] }>;
  rememberChat: (chatId: string, projectDir?: string | null) => Promise<void>;
  claimChat: (chatId: string, projectDir: string) => Promise<void>;

  pickImages: () => Promise<string[]>;
  filePaths: (files: File[]) => string[];
  importImages: (files: File[]) => Promise<string[]>;

  start: (options: {

    runId: string;
    task: string;
    cwd: string;

    assistantId?: string;
    modelLabel?: string;

    mode: ApprovalMode;

    chatId?: string;
    imagePaths?: string[];

  }) => Promise<void>;

  interject: (options: { runId: string; text: string; imagePaths?: string[] }) => Promise<void>;
  speedUp: (runId: string) => Promise<void>;

  stop: (runId: string) => Promise<void>;

  approve: (id: number, ok: boolean) => Promise<void>;
  answer: (id: number, answer: Answer) => Promise<void>;
  decide: (id: number, decision: PlanDecision) => Promise<void>;

  onEvent: (handler: (message: { runId: string; event: AgentEvent }) => void) => void;
  onApproval: (handler: (request: Approval & { runId: string }) => void) => void;
  onAsk: (handler: (request: Ask & { runId: string }) => void) => void;
  onPlan: (handler: (request: PlanRequest & { runId: string }) => void) => void;
  onRunEnded: (handler: (message: { runId: string }) => void) => void;

}

type ApprovalMode = "ask" | "smart" | "auto";

interface Approval {

  id: number;
  command: string;

  reason: string | null;

}

interface Ask {

  id: number;
  question: Question;

}

interface PlanRequest {

  id: number;
  plan: Plan;

}

const MODES: { value: ApprovalMode; label: string; hint: string; icon: typeof ShieldIcon }[] = [

  { value: "ask", label: "Ask every time", hint: "Approve each command before it runs", icon: ShieldIcon },
  { value: "smart", label: "Ask when risky", hint: "Runs routine commands, asks for destructive ones", icon: ShieldAlertIcon },
  { value: "auto", label: "Run everything", hint: "No approvals at all, everything runs", icon: ShieldCheckIcon },

];

declare global {

  interface Window {

    swe: SweBridge;

  }

}

const MODE_KEY = "swe:approvalMode";

// distributes over the Entry union, unlike a bare Omit
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

type NewEntry = WithoutId<Entry>;

/** Format run duration: whole seconds under 1m, then `m:ss min`. */
function formatElapsed(ms: number): string {

  const totalSec = Math.max(0, Math.floor(ms / 1000));

  if (totalSec < 60) {

    return `${totalSec}s`;

  }

  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;

  return `${min}:${String(sec).padStart(2, "0")} min`;

}

/** Owns its own interval so a 10Hz clock never re-renders the transcript. */
class Elapsed extends Component<{ since: number }, { now: number }> {

  state = { now: Date.now() };

  private timer: ReturnType<typeof setInterval> | null = null;

  componentDidMount() {

    this.timer = setInterval(() => this.setState({ now: Date.now() }), 250);

  }

  componentWillUnmount() {

    if (this.timer) {

      clearInterval(this.timer);

    }

  }

  render() {

    return (

      <span className="font-mono text-[13px] text-ink-3 tabular-nums">

        {formatElapsed(this.state.now - this.props.since)}

      </span>

    );

  }

}

/** A later call arrived — stop treating earlier steps as in-flight. */
function closeOpenSteps(entries: Entry[]): Entry[] {

  return entries.map((entry) => {

    if (entry.kind !== "step" || entry.output !== null) {

      return entry;

    }

    return { ...entry, output: "", streaming: false };

  });

}

/** Same close as above, for the step list a subagent card owns. */
function closeSteps(steps: Step[]): Step[] {

  return steps.map((step) => (step.output === null ? { ...step, output: "", streaming: false } : step));

}

/** Fold one forwarded child event into its card. Deltas never arrive here — only settled blocks. */
function applyToSubagent(entry: SubagentEntry, inner: AgentEvent, nextId: () => string): SubagentEntry {

  if (inner.type === "status") {

    return { ...entry, note: inner.text };

  }

  if (inner.type === "command") {

    const { tool, desc } = parseReply(inner.command);

    return {

      ...entry,

      steps: [...closeSteps(entry.steps), {

        id: nextId(),
        kind: "step",

        tool,
        desc,
        thinking: "",

        command: inner.command,

        output: null,
        exitCode: null,

        streaming: false,

      }],

    };

  }

  if (inner.type === "observation" || inner.type === "say") {

    const exitCode = inner.type === "say" ? 0 : inner.exitCode;
    const last = entry.steps[entry.steps.length - 1];

    if (last && last.output === null) {

      return { ...entry, steps: [...entry.steps.slice(0, -1), { ...last, output: inner.text, exitCode }] };

    }

    return {

      ...entry,

      steps: [...entry.steps, {

        id: nextId(),
        kind: "step",

        tool: inner.type === "say" ? "say" : null,
        desc: "",
        thinking: "",

        command: inner.type === "say" ? `<say>\n${inner.text}\n</say>` : null,

        output: inner.text,
        exitCode,

        streaming: false,

      }],

    };

  }

  return entry;

}

/** The row a spawn's cards hang from — matched the same way live and rebuilt from history. */
function isSpawnStep(entry: Entry): boolean {

  return entry.kind === "step" && (entry.tool === "spawn" || inferTool(entry.command) === "spawn");

}

/** Cumulative +/- from apply_patch / write commands in the transcript (and live stream). */
function lineStatsFromEntries(entries: Entry[]): { added: number; removed: number } {

  let added = 0;
  let removed = 0;

  for (const entry of entries) {

    if (entry.kind !== "step" || !entry.command) {

      continue;

    }

    for (const edit of fileEdits(entry.command)) {

      added += edit.added;
      removed += edit.removed;

    }

  }

  return { added, removed };

}

interface AppState {

  entries: Entry[];

  assistants: AssistantSummary[];
  assistantId: string | null;

  cwd: string | null;
  mode: ApprovalMode;

  running: boolean;
  startedAt: number | null;

  /** Live text from the agent ("Step 2 · Drafting"). Only meaningful while running. */
  agentStatus: string;

  /** Duration of the run that produced a verdict, keyed to it so a chat switch cannot mismatch. */
  lastRun: { id: string; ms: number } | null;

  /** One-off line that outlives its run (an undo reporting its outcome). */
  notice: string | null;

  stream: string | null;

  toggled: Set<string>;

  approval: Approval | null;

  /** The question this run is parked on, until the user answers or skips it. */
  ask: Ask | null;

  /** The plan this run is parked on, until the user builds it or waves it off. */
  plan: PlanRequest | null;

  /** Estimated cumulative tokens for this run (local; Boodlebox does not report usage). */
  tokensUsed: number;

  /** Daily totals from ~/.bbx/usage.json for the empty-state heatmap. */
  usage: UsageFile;

  chats: SweChat[];
  chatsLoading: boolean;
  activeChatId: string | null;
  recentProjects: { dir: string; count: number }[];

  /** Resolved preferences, or null until the first load lands. */
  prefs: Preferences | null;
  prefsOpen: boolean;

  /** Rollback marks for this chat, oldest first — one per verdict row that has a snapshot. */
  undos: UndoMark[];

  /** Commit being restored right now, so its control can show progress. */
  undoBusy: string | null;

}

export class App extends Component<{}, AppState> {

  state: AppState = {

    entries: [],

    assistants: [],
    assistantId: null,

    cwd: null,
    mode: (localStorage.getItem(MODE_KEY) as ApprovalMode | null) ?? "smart",

    running: false,
    startedAt: null,

    agentStatus: "",
    lastRun: null,
    notice: null,

    stream: null,

    toggled: new Set<string>(),

    approval: null,
    ask: null,
    plan: null,

    tokensUsed: 0,

    usage: {},

    chats: [],
    chatsLoading: true,
    activeChatId: null,
    recentProjects: [],

    prefs: null,
    prefsOpen: false,

    undos: [],
    undoBusy: null,

    };

  private seq = 0;

  /** Step ids inside subagent cards, kept off `seq` so the two never collide. */
  private subSeq = 0;

  /**
   * Subagent cards by chat id. They live here rather than in `entries` because a child's own chat is
   * deleted the moment it finishes: the server keeps no record of it, so navigating away and
   * rebuilding from history would leave the spawn row with nothing under it. Instance state, so
   * selectChat cannot clear it.
   */
  private subsByChat = new Map<string, SubagentEntry[]>();

  /** Spawn calls seen so far per run — the ordinal each card is anchored by. */
  private spawnSeen = new Map<string, number>();

  /** Runs mid-batch: every child of one spawn starts before any of them reports a step. */
  private inSpawnBatch = new Set<string>();

  /** Snapshot taken at the top of the live run; pinned to a mark once a verdict lands. */
  private pendingSnapshot: string | null = null;

  /** Wall-clock start of the current model stream (for "Thought for Ns"). */
  private streamStartedAt: number | null = null;

  /** When the bash fence opened — the thought ends there, not when the whole reply finishes. */
  private thinkEndedAt: number | null = null;

  /** Accumulated platform Reasoning section for the in-flight turn. */
  private streamReasoning = "";

  /** Bumps so reasoning-only updates re-render the live stream step. */
  private reasoningTick = 0;

  /**
   * Stable id for the in-flight stream step — allocated on first token and reused on settle
   * so the row does not remount (and re-play slide-in) when the reply completes.
  */
  private streamEntryId: string | null = null;
  private activeRunId: string | null = null;

  /** Running agents keyed by their persisted chat ID. */
  private runByChat = new Map<string, { runId: string; startedAt: number }>();
  private chatByRun = new Map<string, string>();
  private approvalsByRun = new Map<string, Approval>();
  private asksByRun = new Map<string, Ask>();
  private plansByRun = new Map<string, PlanRequest>();

  /**
   * The one place a live entry id is minted. Resolves eagerly: a deferred read of
   * `this.seq` inside a setState updater is how two rows used to land on one id.
   */
  private nextId(): string {

    return `e${(this.seq += 1)}`;

  }

  /**
   * The pill is a view of run state, recomputed every paint. A late event could strand a
   * stored string on "Drafting" forever; there is nothing here for it to strand.
   */
  private statusLine(): string {

    const { running, agentStatus, notice, lastRun, entries } = this.state;

    if (running) {

      return agentStatus || "Starting";

    }

    // an undo reports its own outcome and outlives the run it rolled back
    if (notice) {

      return notice;

    }

    for (let index = entries.length - 1; index >= 0; index -= 1) {

      const entry = entries[index];

      if (entry.kind === "error") {

        return "Error";

      }

      if (entry.kind === "done") {

        // the timing belongs to one verdict; a resumed chat has the row but not the clock
        return lastRun && lastRun.id === entry.id
          ? `Done in ${formatElapsed(lastRun.ms)}`
          : "Done";

      }

    }

    return "Idle";

  }

  /** Raise the floor past rows already on screen, so a resumed chat cannot re-mint over them. */
  private syncSeq(entries: Entry[]) {

    for (const entry of entries) {

      const n = entry.id.startsWith("e") ? Number(entry.id.slice(1)) : 0;

      if (Number.isFinite(n) && n > this.seq) {

        this.seq = n;

      }

    }

  }

  private ensureStreamId(): string {

    if (this.streamEntryId == null) {

      this.streamEntryId = this.nextId();

    }

    return this.streamEntryId;

  }

  componentDidMount() {

    window.swe.onEvent(({ runId, event }) => {

      if (runId === this.activeRunId) {

        this.onEvent(event);

        return;

      }

      // a run the user has navigated away from still has children working; dropping their events
      // here is what used to leave the cards frozen (and then missing) on the way back
      if (event.type === "subagent:start" || event.type === "subagent:event" || event.type === "subagent:end") {

        this.onSubagentEvent(runId, event);

      }

    });

    window.swe.onApproval((approval) => {
      this.approvalsByRun.set(approval.runId, approval);
      if (approval.runId === this.activeRunId) this.setState({ approval });
    });

    window.swe.onAsk((ask) => {
      this.asksByRun.set(ask.runId, ask);
      if (ask.runId === this.activeRunId) this.setState({ ask });
    });

    window.swe.onPlan((plan) => {
      this.plansByRun.set(plan.runId, plan);
      if (plan.runId === this.activeRunId) this.setState({ plan });
    });

    window.swe.onRunEnded(({ runId }) => {
      const chatId = this.chatByRun.get(runId);

      // a hard stop can leave a card mid-step, and nothing else is coming to settle it
      if (chatId) this.settleStragglers(chatId);

      if (chatId) this.runByChat.delete(chatId);

      this.spawnSeen.delete(runId);
      this.inSpawnBatch.delete(runId);
      this.chatByRun.delete(runId);
      this.approvalsByRun.delete(runId);
      this.asksByRun.delete(runId);
      this.plansByRun.delete(runId);

      if (runId === this.activeRunId) {
        this.activeRunId = null;
        this.setState({ running: false, startedAt: null, approval: null, ask: null, plan: null, stream: null });
      }
    });

    void this.refreshChats();

    void Promise.all([window.swe.models(), window.swe.preferredModel(), window.swe.prefs()]).then(([assistants, preferredModelId, prefs]) => {

      // a stored default that no longer exists on the account is ignored rather than stranding selection
      const known = (id: string | null) => (id && assistants.some((assistant) => assistant.id === id) ? id : null);

      const chosen = known(prefs.defaultModelId) ?? known(preferredModelId) ?? assistants[0]?.id ?? null;

      this.setState((prev) => ({ assistants, prefs, assistantId: prev.assistantId ?? chosen }));

    }).catch((err) => this.push({ kind: "error", text: `Could not load models: ${String(err)}` }));

    void this.refreshUsage();
    void window.swe.recentProjects().then((recentProjects) => this.setState({ recentProjects }));

  }

  private refreshUsage = async () => {

    try {

      const usage = await window.swe.usage();

      this.setState({ usage });

    } catch {

      // heatmap is best-effort; leave previous totals

    }

  };

  private refreshChats = async () => {

    this.setState({ chatsLoading: true });

    try {

      // list is global (all projects); cwd is only used for grouping / "New session"
      const chats = await window.swe.listChats(this.state.cwd);

      this.setState({ chats, chatsLoading: false });

    } catch {

      this.setState({ chatsLoading: false });

    }

  };

  private push(entry: NewEntry) {

    const id = this.nextId();

    this.setState((prev) => ({ entries: [...prev.entries, { ...entry, id } as Entry] }));

  }

  /** Steps stay folded until the user opens one; the label alone carries the transcript. */
  private isOpen = (entry: Entry) => entry.kind === "step" && this.state.toggled.has(entry.id);

  /**
   * Pair a verdict row with its snapshot. A run can finish without one (no git, folder moved),
   * so the lists are aligned from the newest end rather than by position from the top.
   */
  private undoFor = (entry: Entry): UndoInfo | null => {

    const { undos, entries } = this.state;

    if (entry.kind !== "done" || !undos.length) {

      return null;

    }

    const verdicts = entries.filter((row) => row.kind === "done");
    const index = verdicts.indexOf(entry);

    if (index < 0) {

      return null;

    }

    const mark = undos[index - (verdicts.length - undos.length)];

    return mark ? { commit: mark.commit, undone: mark.undone } : null;

  };

  private handleUndo = async (commit: string) => {

    const chatId = this.state.activeChatId;

    if (!chatId || this.state.undoBusy) {

      return;

    }

    this.setState({ undoBusy: commit });

    try {

      const report = await window.swe.undo(chatId, commit);

      if (!report.ok) {

        this.push({ kind: "error", text: report.text });

        return;

      }

      this.setState((prev) => ({

        undos: prev.undos.map((mark) => (mark.commit === commit ? { ...mark, undone: true } : mark)),
        notice: report.text,

      }));

    } catch (err) {

      this.push({ kind: "error", text: `Undo failed: ${String(err)}` });

    } finally {

      this.setState({ undoBusy: null });

    }

  };

  private toggle = (entry: Entry) => {

    this.setState((prev) => {

      const toggled = new Set(prev.toggled);

      if (toggled.has(entry.id)) {

        toggled.delete(entry.id);

      } else {

        toggled.add(entry.id);

      }

      return { toggled };

    });

  };

  /** Chat a run is writing into; a fresh run has one by the time any child starts. */
  private chatForRun(runId: string): string | null {

    return this.chatByRun.get(runId) ?? (runId === this.activeRunId ? this.state.activeChatId : null);

  }

  private writeCards(chatId: string, cards: SubagentEntry[]) {

    this.subsByChat.set(chatId, cards);

    // the store is instance state, so the transcript only repaints when the user is looking at it
    if (chatId === this.state.activeChatId) {

      this.forceUpdate();

    }

  }

  /** Fold one child's event into the store, live run or background run alike. */
  private onSubagentEvent(runId: string, event: AgentEvent) {

    const chatId = this.chatForRun(runId);

    if (!chatId) {

      return;

    }

    const cards = this.subsByChat.get(chatId) ?? [];

    if (event.type === "subagent:start") {

      // every child of one spawn starts before any of them reports, so a run of starts is one call
      if (!this.inSpawnBatch.has(runId)) {

        this.spawnSeen.set(runId, (this.spawnSeen.get(runId) ?? 0) + 1);
        this.inSpawnBatch.add(runId);

      }

      this.subSeq += 1;

      this.writeCards(chatId, [...cards, {

        id: `sub${this.subSeq}`,
        kind: "subagent",

        subId: event.id,
        spawnIndex: Math.max(0, (this.spawnSeen.get(runId) ?? 1) - 1),

        name: event.name,
        task: event.task,

        steps: [],
        note: "",

        status: "working",
        summary: "",

      }]);

      return;

    }

    this.inSpawnBatch.delete(runId);

    if (event.type === "subagent:event") {

      this.writeCards(chatId, cards.map((card) => (
        card.subId === event.id
          ? applyToSubagent(card, event.event, () => `${card.id}-s${(this.subSeq += 1)}`)
          : card
      )));

      return;

    }

    if (event.type === "subagent:end") {

      const status: SubagentEntry["status"] = event.ok ? "done" : "failed";

      this.writeCards(chatId, cards.map((card) => (
        card.subId === event.id
          ? { ...card, steps: closeSteps(card.steps), note: "", status, summary: cleanSummary(event.summary) }
          : card
      )));

    }

  }

  /** Nothing is going to report for these now — settle them rather than leave a card pulsing. */
  private settleStragglers(chatId: string) {

    const cards = this.subsByChat.get(chatId);

    if (cards?.some((card) => card.status === "working")) {

      this.writeCards(chatId, cards.map((card) => (
        card.status === "working"
          ? { ...card, steps: closeSteps(card.steps), note: "", status: "failed" as const, summary: card.summary || "The run ended before this subagent reported back." }
          : card
      )));

    }

    // top-level steps with no observation would otherwise keep the "Working" tail on until reload
    if (chatId !== this.state.activeChatId) {

      return;

    }

    this.setState((prev) => {

      if (!prev.entries.some((entry) => entry.kind === "step" && (entry.streaming || entry.output === null))) {

        return null;

      }

      return {

        entries: prev.entries.map((entry) => (
          entry.kind === "step" && (entry.streaming || entry.output === null)
            ? { ...entry, output: entry.output ?? "", streaming: false }
            : entry
        )),
        stream: null,

      };

    });

  }

  /**
   * Drop each spawn's cards in behind the row that opened it. The nth spawn row gets the cards
   * tagged with ordinal n, which is why this works on a transcript rebuilt from history too.
   */
  private withSubagents(rows: Entry[]): Entry[] {

    const cards = this.state.activeChatId ? this.subsByChat.get(this.state.activeChatId) : null;

    if (!cards?.length) {

      return rows;

    }

    const out: Entry[] = [];
    const placed = new Set<string>();

    let ordinal = 0;

    for (const row of rows) {

      out.push(row);

      if (!isSpawnStep(row)) {

        continue;

      }

      for (const card of cards) {

        if (card.spawnIndex === ordinal) {

          out.push(card);
          placed.add(card.id);

        }

      }

      ordinal += 1;

    }

    // children whose spawn row has not streamed in yet: better trailing than missing
    for (const card of cards) {

      if (!placed.has(card.id)) {

        out.push(card);

      }

    }

    return out;

  }

  /** Live children as temporary sidebar rows, derived so a chat refresh cannot wipe them. */
  private sidebarChats(chats: SweChat[]): SweChat[] {

    const rows: SweChat[] = [];

    for (const [chatId, cards] of this.subsByChat) {

      for (const card of cards) {

        if (card.status !== "working") {

          continue;

        }

        rows.push({

          id: `sub:${card.subId}`,

          name: card.name,
          title: card.name,

          modified: Date.now(),
          project: this.state.cwd ?? null,

          parentId: chatId,
          subagent: true,

        });

      }

    }

    return rows.length ? [...chats, ...rows] : chats;

  }

  private onEvent = (event: AgentEvent) => {

    if (event.type === "status") {

      this.setState({ agentStatus: event.text });

      return;

    }

    // UI already paints the task bubble when the user sends; agent just acks the queue
    if (event.type === "interjection") {

      return;

    }

    if (event.type === "usage") {

      this.setState({ tokensUsed: event.used });

      return;

    }

    if (event.type === "subagent:start" || event.type === "subagent:event" || event.type === "subagent:end") {

      // cards never enter `entries` — they outlive the rebuild that selectChat does
      if (this.activeRunId) {

        this.onSubagentEvent(this.activeRunId, event);

      }

      return;

    }

    if (event.type === "snapshot") {

      this.pendingSnapshot = event.commit;

      return;

    }

    if (event.type === "session") {

      const project = this.state.cwd;

      const chat: SweChat = {

        id: event.chatId,
        name: event.title,
        title: event.title,
        modified: Date.now(),
        project: project ?? null,

      };

      if (this.activeRunId) {
        const run = {
          runId: this.activeRunId,
          startedAt: this.state.startedAt ?? Date.now(),
        };
        this.runByChat.set(event.chatId, run);
        this.chatByRun.set(this.activeRunId, event.chatId);
      }

      this.setState((prev) => ({

        activeChatId: event.chatId,
        chats: [chat, ...prev.chats.filter((c) => c.id !== event.chatId)],

      }));

      return;

    }

    if (event.type === "reasoning") {

      // platform chain-of-thought — folds into Thought UI; does not feed the fence parser
      if (this.streamStartedAt == null) {

        this.streamStartedAt = Date.now();
        this.thinkEndedAt = null;

      }

      this.ensureStreamId();
      this.streamReasoning += event.text;
      this.reasoningTick += 1;

      // force a paint while only reasoning is flowing (no answer delta yet)
      this.forceUpdate();

      return;

    }

    if (event.type === "delta") {

      this.setState((prev) => {

        if (prev.stream === null) {

          this.streamStartedAt ??= Date.now();
          this.thinkEndedAt = null;
          this.ensureStreamId();

        }

        const stream = (prev.stream ?? "") + event.text;

        // thinking ends the moment the first action block opens
        if (this.thinkEndedAt == null && parseReply(stream).tool !== null) {

          this.thinkEndedAt = Date.now();

        }

        return { stream };

      });

      return;

    }

    if (event.type === "assistant") {

      // settle the streamed step into a real entry in one update, so nothing flickers between the two
      const { tool, desc, thinking: harnessThinking, command } = parseReply(event.text);
      // platform Reasoning section wins over harness prose between label and fence
      const thinking = (event.reasoning ?? this.streamReasoning).trim() || harnessThinking;

      // measure to the fence, not to the end of the reply — otherwise a long command reads as long thinking
      const thoughtMs = this.streamStartedAt != null
        ? Math.max(0, (this.thinkEndedAt ?? Date.now()) - this.streamStartedAt)
        : thinking.trim()
          ? Math.max(1000, Math.round(thinking.length / 50) * 1000)
          : null;

      // reuse the live stream id so the row stays mounted (no slide-up re-animation)
      const id = this.streamEntryId ?? this.nextId();

      this.streamStartedAt = null;
      this.thinkEndedAt = null;
      this.streamReasoning = "";
      this.streamEntryId = null;

      this.setState((prev) => ({

        entries: [...closeOpenSteps(prev.entries), {
          id,
          kind: "step",
          tool,
          desc,
          thinking,
          thoughtMs,
          command,
          output: null,
          exitCode: null,
          streaming: false,
        }],
        stream: null,

      }));

      return;

    }

    if (event.type === "command") {

      // the reply already carried this command; the event only matters when the two parses disagree
      this.setState((prev) => {

        const last = prev.entries[prev.entries.length - 1];

        if (last?.kind === "step" && last.command === event.command) {

          return null;

        }

        if (last?.kind === "step" && last.command === null && last.output === null) {

          return { entries: [...closeOpenSteps(prev.entries.slice(0, -1)), { ...last, command: event.command }] };

        }

        // a later block in a batched reply: it carries its own label, so re-derive rather than blanking the row
        const { tool, desc } = parseReply(event.command);

        const id = this.nextId();

      return { entries: [...closeOpenSteps(prev.entries), { id, kind: "step", tool, desc, thinking: "", command: event.command, output: null, exitCode: null, streaming: false }] };

      });

      return;

    }

    if (event.type === "observation") {

      this.setState((prev) => {

        // a spawn's cards sit between its row and its result, so the open step is not always last
        for (let index = prev.entries.length - 1; index >= 0; index -= 1) {

          const entry = prev.entries[index];

          if (entry.kind === "subagent") {

            continue;

          }

          if (entry.kind === "step" && entry.output === null) {

            const entries = [...prev.entries];

            entries[index] = { ...entry, output: event.text, exitCode: event.exitCode };

            return { entries };

          }

          break;

        }

        const id = this.nextId();

      return { entries: [...prev.entries, { id, kind: "step", tool: null, desc: "", thinking: "", command: null, output: event.text, exitCode: event.exitCode, streaming: false }] };

      });

      return;

    }

    if (event.type === "say") {

      this.setState((prev) => {

        const last = prev.entries[prev.entries.length - 1];

        // settle the streamed echo step in place so the label row is not left behind
        if (last?.kind === "step" && last.output === null) {

          return {

            entries: [...prev.entries.slice(0, -1), {

              ...last,

              tool: last.tool ?? "say",
              command: last.command ?? `<say>\n${event.text}\n</say>`,
              output: event.text,
              exitCode: 0,
              streaming: false,

            }],

          };

        }

        return { entries: [...closeOpenSteps(prev.entries), { id: this.nextId(), kind: "say", text: event.text }] };

      });

      return;

    }

    if (event.type === "done") {

      const commit = this.pendingSnapshot;
      const project = this.state.cwd ?? "";
      const doneId = this.nextId();

      this.setState((prev) => ({

        entries: [...closeOpenSteps(prev.entries), { id: doneId, kind: "done", text: cleanSummary(event.summary) }],
        lastRun: { id: doneId, ms: Date.now() - (prev.startedAt ?? Date.now()) },
        stream: null,

        // main persists the same mark; mirroring it here keeps the control live without a round trip
        undos: commit ? [...prev.undos, { commit, project, summary: event.summary, at: Date.now() }] : prev.undos,

      }));

      return;

    }

    // the row itself is the error state now — nothing to set
    this.push({ kind: "error", text: event.message });

  };

  private pickFolder = async () => {

    const picked = await window.swe.pickDir();

    if (!picked) {

      return;

    }

    await this.openProject(picked);
  };

  private openProject = async (dir: string) => {
    const opened = await window.swe.openProject(dir);
    if (!opened) return;

    // switching projects clears the open transcript — sessions are per-folder
    this.seq = 0;
    this.streamEntryId = null;
    this.streamReasoning = "";

    this.setState({

      cwd: opened.dir,
      recentProjects: opened.recentProjects,
      chats: [],
      chatsLoading: true,
      activeChatId: null,
      entries: [],
      undos: [],
      undoBusy: null,
      stream: null,
      toggled: new Set(),
      approval: null,
      ask: null,
      tokensUsed: 0,

      // a run in another project is still reporting; its text stays until it ends
      agentStatus: this.state.running ? this.state.agentStatus : "",
      lastRun: null,
      notice: null,

    }, () => {

      void this.refreshChats();

    });

  };

  private resolveApproval(ok: boolean) {

    const approval = this.state.approval;

    if (!approval) {

      return;

    }

    void window.swe.approve(approval.id, ok);
    this.setState({ approval: null });

  }

  private answerAsk = (answer: Answer) => {

    const ask = this.state.ask;

    if (!ask) {

      return;

    }

    void window.swe.answer(ask.id, answer);

    if (this.activeRunId) {

      this.asksByRun.delete(this.activeRunId);

    }

    this.setState({ ask: null });

  };

  private dismissAsk = () => {

    this.answerAsk({ picked: [], text: "", dismissed: true });

  };

  private decidePlan = (decision: PlanDecision) => {

    const plan = this.state.plan;

    if (!plan) {

      return;

    }

    void window.swe.decide(plan.id, decision);

    if (this.activeRunId) {

      this.plansByRun.delete(this.activeRunId);

    }

    // the loop sends as the new model from here; the composer should say so too
    const switched = decision.build && decision.assistantId && decision.assistantId !== this.state.assistantId;

    this.setState(switched ? { plan: null, assistantId: decision.assistantId } : { plan: null });

  };

  private dismissPlan = () => {

    this.decidePlan({ build: false, assistantId: "", modelLabel: "", note: "", dismissed: true });

  };

  private newSession = () => {
    this.activeRunId = null;
    this.seq = 0;
    this.streamEntryId = null;
    this.streamReasoning = "";

    // a fresh session is the one place the stored default applies; restored chats keep their own model
    const { prefs, assistants, assistantId } = this.state;
    const stored = prefs?.defaultModelId ?? null;
    const nextAssistant = stored && assistants.some((a) => a.id === stored) ? stored : assistantId;

    this.setState({

      assistantId: nextAssistant,
      entries: [],
      stream: null,
      toggled: new Set(),
      approval: null,
      ask: null,
      tokensUsed: 0,
      activeChatId: null,
      running: false,
      startedAt: null,
      agentStatus: "",
      lastRun: null,
      notice: null,
      undos: [],
      undoBusy: null,

      });

  };

  private selectChat = async (chat: SweChat) => {
    this.activeRunId = null;
    this.streamEntryId = null;
    this.streamReasoning = "";
    this.setState({

      activeChatId: chat.id,
      agentStatus: "",
      lastRun: null,
      notice: null,
      stream: null,
      toggled: new Set(),
      approval: null,
      ask: null,
      tokensUsed: 0,
      running: false,
      startedAt: null,
      undos: [],
      undoBusy: null,

      });

    try {

      // opening a session from another project switches the working folder
      let cwd = this.state.cwd;
      const chatProject = chat.project?.trim() || null;

      if (chatProject) {

        const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
        const same = cwd && norm(cwd).toLowerCase() === norm(chatProject).toLowerCase();

        if (!same) {

          await window.swe.setCwd(chatProject);
          cwd = chatProject;
          this.setState({ cwd: chatProject });

        }

      } else if (this.state.cwd) {

        // unassigned → claim into the active project
        await window.swe.claimChat(chat.id, this.state.cwd);

      }

      const detail = await window.swe.getChat(chat.id);
      const entries = (detail.entries ?? []) as Entry[];
      const project = detail.project ?? chat.project ?? cwd ?? null;
      const live = this.runByChat.get(detail.id);
      this.activeRunId = live?.runId ?? null;

      // exact rather than a guessed gap — the old "+ 100" is what a collision looked like
      this.seq = 0;
      this.syncSeq(entries);
      this.streamEntryId = null;

      this.setState((prev) => ({

        activeChatId: detail.id,
        entries,
        cwd: project,
        undos: detail.undos ?? [],
        assistantId: detail.modelId ?? prev.assistantId,
        running: Boolean(live),
        startedAt: live?.startedAt ?? null,
        approval: live ? this.approvalsByRun.get(live.runId) ?? null : null,
        ask: live ? this.asksByRun.get(live.runId) ?? null : null,

        agentStatus: live ? "Working" : "",
        // the verdict row is restored but its clock is not; statusLine falls back to a bare "Done"
        lastRun: null,
        notice: null,
        chats: prev.chats.map((c) => (
          c.id === detail.id
            ? { ...c, title: detail.title || c.title, project, name: detail.name || c.name }
            : c
        )),

      }));

    } catch (err) {

      this.setState({

        entries: [],
        agentStatus: "",
        lastRun: null,
        notice: null,

      });

      this.push({ kind: "error", text: `Could not load session: ${err instanceof Error ? err.message : String(err)}` });

    }

  };

  private renameChat = async (chat: SweChat, name: string) => {

    try {

      await window.swe.renameChat(chat.id, name);

      this.setState((prev) => ({

        chats: prev.chats.map((item) => (
          item.id === chat.id ? { ...item, name, title: name } : item
        )),

      }));

    } catch (err) {

      this.push({ kind: "error", text: `Could not rename session: ${err instanceof Error ? err.message : String(err)}` });

    }

  };

  private deleteChat = async (chat: SweChat) => {

    try {

      await window.swe.deleteChat(chat.id);

      this.setState((prev) => ({

        chats: prev.chats.filter((c) => c.id !== chat.id),
        activeChatId: prev.activeChatId === chat.id ? null : prev.activeChatId,
        entries: prev.activeChatId === chat.id ? [] : prev.entries,
        status: prev.activeChatId === chat.id ? "Idle" : prev.status,

      }));

    } catch (err) {

      this.push({ kind: "error", text: `Could not delete session: ${err instanceof Error ? err.message : String(err)}` });

    }

  };

  /** Mid-run user note — shows as a task bubble and queues into the agent loop. */
  private interject = async (task: string, imagePaths: string[] = []) => {

    this.seq += 1;

    this.setState((prev) => ({

      entries: [...prev.entries, {

        id: `e${this.seq}`,
        kind: "task" as const,

        text: task,
        attachments: imagePaths.length ? imagePaths : undefined,

      }],

    }));

    try {

      await window.swe.interject({

        runId: this.activeRunId!,
        text: task,
        imagePaths: imagePaths.length ? imagePaths : undefined,

      });

    } catch (err) {

      this.push({ kind: "error", text: err instanceof Error ? err.message : String(err) });

    }

  };

  private start = async (task: string, imagePaths: string[] = []) => {

    const { cwd, assistantId, mode, assistants, activeChatId, entries, running } = this.state;

    if (!cwd) {

      return;

    }

    // already looping — fold into the current run instead of starting another
    if (running) {

      await this.interject(task, imagePaths);

      return;

    }

    const runId = crypto.randomUUID();
    this.activeRunId = runId;

    if (activeChatId) {
      const live = { runId, startedAt: Date.now() };
      this.runByChat.set(activeChatId, live);
      this.chatByRun.set(runId, activeChatId);
    }

    const model = assistants.find((a) => a.id === assistantId);
    const modelLabel = model ? displayName(model.name) : assistantId ?? undefined;

    // follow-up when a chat is already active (and not mid-run); otherwise open a new Boodle chat
    const chatId = activeChatId ?? undefined;
    const followUp = Boolean(chatId);

    this.streamReasoning = "";
    this.streamStartedAt = null;
    this.thinkEndedAt = null;
    this.streamEntryId = null;

    if (followUp) {

      this.syncSeq(entries);

      const taskId = this.nextId();

      this.setState((prev) => ({

        entries: [...prev.entries, {

          id: taskId,
          kind: "task" as const,

          text: task,
          attachments: imagePaths.length ? imagePaths : undefined,

        }],

        running: true,

        startedAt: Date.now(),
        agentStatus: "Starting",
        notice: null,

        stream: null,
        approval: null,

      }));

    } else {

      this.seq = 0;

      this.setState({

        entries: [{

          id: this.nextId(),
          kind: "task",

          text: task,
          attachments: imagePaths.length ? imagePaths : undefined,

        }],

        running: true,

        startedAt: Date.now(),
        agentStatus: "Starting",
        notice: null,
        lastRun: null,

        toggled: new Set<string>(),
        tokensUsed: 0,

        stream: null,
        approval: null,

      });

    }

    try {

      await window.swe.start({

        runId,
        task,
        cwd,

        assistantId: assistantId ?? undefined,
        modelLabel,

        mode,

        chatId,
        imagePaths: imagePaths.length ? imagePaths : undefined,

      });

    } catch (err) {

      this.push({ kind: "error", text: err instanceof Error ? err.message : String(err) });

    } finally {
      if (this.activeRunId === runId) {
        this.activeRunId = null;
        this.streamEntryId = null;
        this.setState({ running: false, startedAt: null, approval: null, ask: null, stream: null });
      }

      const finishedChat = this.chatByRun.get(runId);
      if (finishedChat) this.runByChat.delete(finishedChat);
      this.chatByRun.delete(runId);
      this.approvalsByRun.delete(runId);
      this.asksByRun.delete(runId);
      this.plansByRun.delete(runId);
      void this.refreshChats();
      void this.refreshUsage();

    }

  };

  render() {

    const { entries, assistants, assistantId, cwd, mode, running, startedAt, stream, approval, ask, plan, tokensUsed, usage: dailyUsage, chats, chatsLoading, activeChatId, undoBusy } = this.state;

    const status = this.statusLine();

    const model = assistants.find((a) => a.id === assistantId);
    const liveThought = this.streamStartedAt != null && this.thinkEndedAt != null ? this.thinkEndedAt - this.streamStartedAt : null;

    // include a synthetic stream row when only platform reasoning has arrived (no answer tokens yet)
    const liveStream = stream ?? (this.streamReasoning && running ? "" : null);
    const rows = this.withSubagents(liveStream === null
      ? entries
      : [...entries, streamStep(liveStream, liveThought, this.streamReasoning, this.streamEntryId ?? "stream")]);

    const activeMode = MODES.find((m) => m.value === mode) ?? MODES[1];
    const ModeIcon = activeMode.icon;

    const folderName = cwd ? cwd.replaceAll("\\", "/").split("/").filter((x) => x).pop() ?? cwd : null;

    const limit = contextLimitOf(model ?? assistantId);
    const usage = usageOf(tokensUsed, limit);

    const diff = lineStatsFromEntries(rows);
    const hasDiff = diff.added > 0 || diff.removed > 0;

    return (

      <div className="flex h-full bg-page">

        <Sidebar

          chats={this.sidebarChats(chats)}
          activeId={activeChatId}

          // a row the user has switched away from still shows a pulse where its options button sits
          runningIds={[...this.runByChat.keys()]}

          loading={chatsLoading}

          projectDir={cwd}

          onSelect={(chat) => void this.selectChat(chat)}
          onRename={(chat, name) => void this.renameChat(chat, name)}
          onDelete={(chat) => void this.deleteChat(chat)}
          onNew={this.newSession}
          onOpenSettings={() => this.setState({ prefsOpen: true })}

        />

        {this.state.prefsOpen && (

          <PrefsPanel
            models={assistants}
            onClose={() => this.setState({ prefsOpen: false })}
            onSaved={(prefs) => this.setState({ prefs })}
          />

        )}

        <div className="flex min-w-0 flex-1 flex-col">

          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="flex h-9 items-center gap-2 rounded-control border border-line bg-surface px-3 text-[13px] font-medium text-ink transition-colors duration-100 hover:bg-hover">
                  <FolderOpenIcon className="size-4 text-ink-3" />
                  <span className="max-w-56 truncate">{cwd ? folderName : "Choose folder"}</span>
                  <ChevronDownIcon className="size-3.5 opacity-60" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="min-w-72">
                <DropdownMenuLabel>Recent projects</DropdownMenuLabel>
                {this.state.recentProjects.length === 0 ? (
                  <div className="px-2 py-1.5 text-sm text-muted-foreground">No recent projects</div>
                ) : this.state.recentProjects.map((project) => (
                  <DropdownMenuItem key={project.dir} onSelect={() => void this.openProject(project.dir)} title={project.dir}>
                    <span className="min-w-0 flex-1 truncate">{project.dir.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? project.dir}</span>
                    <span className="ml-3 text-xs tabular-nums text-muted-foreground">{project.count}</span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void this.pickFolder()}>
                  <FolderOpenIcon className="size-4 text-ink-3" />
                  Open new folder…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="min-w-0 flex-1" />

            <DropdownMenu>

              <DropdownMenuTrigger asChild>

                <button type="button" className="flex h-9 items-center gap-2 px-3 text-[13px] font-medium">

                  <ModeIcon className="size-4 text-ink-3" />
                  {activeMode.label}
                  <ChevronDownIcon className="size-3.5 opacity-60" />

                </button>

              </DropdownMenuTrigger>

              <DropdownMenuContent align="end" className="w-80 text-sm">

                <DropdownMenuLabel className="text-sm">Command approval</DropdownMenuLabel>

                <DropdownMenuSeparator />

                <DropdownMenuRadioGroup

                  value={mode}

                  onValueChange={(value) => {

                    localStorage.setItem(MODE_KEY, value);
                    this.setState({ mode: value as ApprovalMode });

                  }}

                >

                  {MODES.map((option) => (

                    <DropdownMenuRadioItem key={option.value} value={option.value} className="items-start gap-2 py-2.5 text-sm">

                      <div className="flex flex-col gap-0.5">

                        <span className="text-sm">{option.label}</span>
                        <span className="text-xs text-muted-foreground">{option.hint}</span>

                      </div>

                    </DropdownMenuRadioItem>

                  ))}

                </DropdownMenuRadioGroup>

              </DropdownMenuContent>

            </DropdownMenu>

          </header>

          <Transcript

            entries={rows}
            running={running}

            empty={cwd ? "Describe a task below to start." : "Choose a working folder to start."}
            usage={dailyUsage}

            isOpen={this.isOpen}
            onToggle={this.toggle}

            undoFor={this.undoFor}
            onUndo={this.handleUndo}
            undoBusy={undoBusy}

          />

          {approval && (

            <div className="mx-auto w-full max-w-3xl px-5 pb-2">

              <div className="overflow-hidden rounded-card bg-surface shadow-card animate-fade-up">

                <div className="flex items-center gap-2.5 p-3.5">

                  {approval.reason ? (

                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-red text-white">

                      <TriangleAlertIcon className="size-3.5" strokeWidth={2.5} />

                    </span>

                  ) : null}

                  <span className="text-[14px] font-medium text-ink">

                    {approval.reason ? `Looks destructive — ${approval.reason}` : "Run this command?"}

                  </span>

                </div>

                <div className="border-t border-line bg-inset px-3.5 py-3">

                  <pre className="max-h-32 overflow-y-auto font-mono text-[12.5px] leading-[1.65] whitespace-pre-wrap text-ink-2">

                    {approval.command}

                  </pre>

                </div>

                <div className="flex items-center justify-end gap-2 border-t border-line px-3.5 py-3">

                  <button type="button" onClick={() => this.resolveApproval(false)} className="flex h-9 items-center gap-2 rounded-control px-3 text-[13px] font-medium text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink" >

                    <XIcon className="size-4" />
                    Skip

                  </button>

                  <button type="button" onClick={() => this.resolveApproval(true)} className={cn( "flex h-9 items-center gap-2 rounded-control px-3 text-[13px] font-medium transition-[background-color,transform] duration-100 active:scale-[0.97]", approval.reason ? "bg-red text-white hover:bg-red/85" : "bg-ink text-page hover:bg-ink/85", )} >

                    <PlayIcon className="size-4 fill-current" />
                    Run

                  </button>

                </div>

              </div>

            </div>

          )}

          {ask && (

            <div className="mx-auto w-full max-w-3xl px-5 pb-2">

              <AskCard key={ask.id} question={ask.question} onAnswer={this.answerAsk} onDismiss={this.dismissAsk} />

            </div>

          )}

          {plan && (

            <div className="mx-auto w-full max-w-3xl px-5 pb-2">

              <PlanCard

                key={plan.id}

                plan={plan.plan}

                assistants={assistants}
                assistantId={assistantId}

                onBuild={this.decidePlan}
                onDismiss={this.dismissPlan}

              />

            </div>

          )}

          <div className="flex justify-center pt-1 pb-4">

            <div className="flex w-fit items-center gap-2.5 rounded-full bg-field px-3.5 py-1.5 shadow-hairline">

              {status.startsWith("Done in ") ? <CheckIcon className="size-3.5 text-green" strokeWidth={3} /> : null}

              {/* the agent sends "Step 2 · Drafting"; splitting it lets the gap come from flex, not the glyph */}
              {status.split(" · ").map((part, index) => (

                <Fragment key={index}>

                  {index > 0 ? <span className="text-[13px] text-ink-3">·</span> : null}

                  <span className={cn( "text-[13px] font-medium", status === "Error" ? "text-red" : status.startsWith("Done in ") ? "text-green" : "text-ink-2", )} >

                    {part}

                  </span>

                </Fragment>

              ))}

              {running && hasDiff ? (

                <span className="flex shrink-0 items-center gap-1.5 font-mono text-[12.5px] tabular-nums">

                  {diff.added > 0 ? <span className="text-green">+{diff.added}</span> : null}
                  {diff.removed > 0 ? <span className="text-red">−{diff.removed}</span> : null}

                </span>

              ) : running && startedAt != null ? (

                <Elapsed since={startedAt} />

              ) : null}

            </div>

          </div>

          <Composer

            assistants={assistants}
            assistantId={assistantId}

            busy={running}
            disabled={!cwd}

            contextRatio={usage.ratio}
            contextUsed={usage.used}
            contextLimit={usage.limit}

            placeholder={running ? "Interject while working..." : activeChatId ? "Follow up on this session..." : "Describe what to build..."}
            disabledPlaceholder="Choose a working folder first..."

            startedAt={startedAt}

            onModelChange={(id) => {

              this.setState({ assistantId: id });

            }}

            onSend={(task, imagePaths) => void this.start(task, imagePaths)}
            onPickImages={() => window.swe.pickImages()}
            onFiles={(files) => window.swe.importImages(files)}
            onStop={() => {
              if (this.activeRunId) void window.swe.stop(this.activeRunId);
            }}
            onSpeedUp={() => {
              if (this.activeRunId) void window.swe.speedUp(this.activeRunId);
            }}

          />

        </div>

      </div>

    );

  }

}

createRoot(document.getElementById("root")!).render(<App />);
