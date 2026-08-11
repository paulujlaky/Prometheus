import { Component, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { CheckIcon, ChevronDownIcon, FolderOpenIcon, PlayIcon, ShieldAlertIcon, ShieldCheckIcon, ShieldIcon, TriangleAlertIcon, XIcon } from "lucide-react";

import { Composer } from "@/comps/composer";
import type { UsageFile } from "@/comps/heatmap";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/comps/ui/dropdown";

import { contextLimitOf, displayName } from "@/lib/models";
import { usageOf } from "@/lib/tokens";
import { cn } from "@/lib/utils";

import { Sidebar, type SweChat } from "./sidebar";
import { cleanSummary, parseReply, streamStep, Transcript, type Entry } from "./transcript";

import type { AgentEvent } from "./agent";
import type { AssistantSummary } from "../sdk/types";

import "./index.css";

interface SweBridge {

  models: () => Promise<AssistantSummary[]>;
  pickDir: () => Promise<string | null>;
  lastCwd: () => Promise<string | null>;

  usage: () => Promise<UsageFile>;

  listChats: () => Promise<SweChat[]>;
  deleteChat: (chatId: string) => Promise<void>;
  getChat: (chatId: string) => Promise<{ id: string; name: string; title: string; entries: Entry[] }>;
  rememberChat: (chatId: string) => Promise<void>;

  pickImages: () => Promise<string[]>;

  start: (options: {

    task: string;
    cwd: string;

    assistantId?: string;
    modelLabel?: string;

    mode: ApprovalMode;

    chatId?: string;
    imagePaths?: string[];

  }) => Promise<void>;

  interject: (options: { text: string; imagePaths?: string[] }) => Promise<void>;

  stop: () => Promise<void>;

  approve: (id: number, ok: boolean) => Promise<void>;

  onEvent: (handler: (event: AgentEvent) => void) => void;
  onApproval: (handler: (request: Approval) => void) => void;

}

type ApprovalMode = "ask" | "smart" | "auto";

interface Approval {

  id: number;
  command: string;

  reason: string | null;

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

const MODEL_KEY = "swe:assistantId";
const MODE_KEY = "swe:approvalMode";

// distributes over the Entry union, unlike a bare Omit
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

type NewEntry = WithoutId<Entry>;

/** Owns its own interval so a 10Hz clock never re-renders the transcript. */
class Elapsed extends Component<{ since: number }, { now: number }> {

  state = { now: Date.now() };

  private timer: ReturnType<typeof setInterval> | null = null;

  componentDidMount() {

    this.timer = setInterval(() => this.setState({ now: Date.now() }), 100);

  }

  componentWillUnmount() {

    if (this.timer) {

      clearInterval(this.timer);

    }

  }

  render() {

    return (

      <span className="font-mono text-[13px] text-ink-3 tabular-nums">

        {((this.state.now - this.props.since) / 1000).toFixed(1)}s

      </span>

    );

  }

}

interface AppState {

  entries: Entry[];

  assistants: AssistantSummary[];
  assistantId: string | null;

  cwd: string | null;
  mode: ApprovalMode;

  running: boolean;
  startedAt: number | null;

  status: string;

  stream: string | null;

  toggled: Set<string>;

  approval: Approval | null;

  /** Estimated cumulative tokens for this run (local; Boodlebox does not report usage). */
  tokensUsed: number;

  /** Daily totals from ~/.bbx/usage.json for the empty-state heatmap. */
  usage: UsageFile;

  chats: SweChat[];
  chatsLoading: boolean;
  activeChatId: string | null;

}

export class App extends Component<{}, AppState> {

  state: AppState = {

    entries: [],

    assistants: [],
    assistantId: localStorage.getItem(MODEL_KEY),

    cwd: null,
    mode: (localStorage.getItem(MODE_KEY) as ApprovalMode | null) ?? "smart",

    running: false,
    startedAt: null,

    status: "Idle",

    stream: null,

    toggled: new Set<string>(),

    approval: null,

    tokensUsed: 0,

    usage: {},

    chats: [],
    chatsLoading: true,
    activeChatId: null,

  };

  private seq = 0;

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

  private ensureStreamId(): string {

    if (this.streamEntryId == null) {

      this.streamEntryId = `e${(this.seq += 1)}`;

    }

    return this.streamEntryId;

  }

  componentDidMount() {

    window.swe.onEvent(this.onEvent);

    window.swe.onApproval((approval) => this.setState({ approval }));

    void window.swe.lastCwd().then((cwd) => {

      if (cwd) {

        this.setState({ cwd });

      }

    });

    void window.swe.models().then((assistants) => {

      this.setState((prev) => ({ assistants, assistantId: prev.assistantId ?? assistants[0]?.id ?? null }));

    }).catch((err) => this.push({ kind: "error", text: `Could not load models: ${String(err)}` }));

    void this.refreshUsage();
    void this.refreshChats();

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

      const chats = await window.swe.listChats();

      this.setState({ chats, chatsLoading: false });

    } catch {

      this.setState({ chatsLoading: false });

    }

  };

  private push(entry: NewEntry) {

    this.seq += 1;

    this.setState((prev) => ({ entries: [...prev.entries, { ...entry, id: `e${this.seq}` } as Entry] }));

  }

  /** Steps stay folded until the user opens one; the label alone carries the transcript. */
  private isOpen = (entry: Entry) => entry.kind === "step" && this.state.toggled.has(entry.id);

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

  private onEvent = (event: AgentEvent) => {

    if (event.type === "status") {

      this.setState({ status: event.text });

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

    if (event.type === "session") {

      const chat: SweChat = {

        id: event.chatId,
        name: event.title,
        title: event.title,
        modified: Date.now(),

      };

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

        // the fence is where thinking stops and the command starts
        if (this.thinkEndedAt == null && stream.includes("```")) {

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
      const id = this.streamEntryId ?? `e${(this.seq += 1)}`;

      this.streamStartedAt = null;
      this.thinkEndedAt = null;
      this.streamReasoning = "";
      this.streamEntryId = null;

      this.setState((prev) => ({

        entries: [...prev.entries, {
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

          return { entries: [...prev.entries.slice(0, -1), { ...last, command: event.command }] };

        }

        return { entries: [...prev.entries, { id: `e${(this.seq += 1)}`, kind: "step", tool: null, desc: "", thinking: "", command: event.command, output: null, exitCode: null, streaming: false }] };

      });

      return;

    }

    if (event.type === "observation") {

      this.setState((prev) => {

        const last = prev.entries[prev.entries.length - 1];

        if (last?.kind === "step" && last.output === null) {

          return { entries: [...prev.entries.slice(0, -1), { ...last, output: event.text, exitCode: event.exitCode }] };

        }

        return { entries: [...prev.entries, { id: `e${(this.seq += 1)}`, kind: "step", tool: null, desc: "", thinking: "", command: null, output: event.text, exitCode: event.exitCode, streaming: false }] };

      });

      return;

    }

    if (event.type === "done") {

      this.push({ kind: "done", text: cleanSummary(event.summary) });
      this.setState({ status: "Done" });

      return;

    }

    this.push({ kind: "error", text: event.message });
    this.setState({ status: "Error" });

  };

  private pickFolder = async () => {

    const picked = await window.swe.pickDir();

    if (picked) {

      this.setState({ cwd: picked });

    }

  };

  private resolveApproval(ok: boolean) {

    const approval = this.state.approval;

    if (!approval) {

      return;

    }

    void window.swe.approve(approval.id, ok);
    this.setState({ approval: null });

  }

  private newSession = () => {

    if (this.state.running) {

      return;

    }

    this.seq = 0;
    this.streamEntryId = null;
    this.streamReasoning = "";
    this.setState({

      entries: [],
      stream: null,
      toggled: new Set(),
      approval: null,
      tokensUsed: 0,
      activeChatId: null,
      status: "Idle",

    });

  };

  private selectChat = async (chat: SweChat) => {

    if (this.state.running) {

      return;

    }

    this.streamEntryId = null;
    this.streamReasoning = "";
    this.setState({

      activeChatId: chat.id,
      status: "Loading...",
      stream: null,
      toggled: new Set(),
      approval: null,
      tokensUsed: 0,

    });

    try {

      const detail = await window.swe.getChat(chat.id);
      const entries = (detail.entries ?? []) as Entry[];

      // keep seq ahead of loaded ids so live steps don't collide
      this.seq = entries.length + 100;
      this.streamEntryId = null;

      this.setState({

        activeChatId: detail.id,
        entries,
        status: "Idle",

      });

    } catch (err) {

      this.setState({

        entries: [],
        status: "Idle",

      });

      this.push({ kind: "error", text: `Could not load session: ${err instanceof Error ? err.message : String(err)}` });

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

      this.seq = Math.max(this.seq, entries.length) + 1;

      this.setState((prev) => ({

        entries: [...prev.entries, {

          id: `e${this.seq}`,
          kind: "task" as const,

          text: task,
          attachments: imagePaths.length ? imagePaths : undefined,

        }],

        running: true,

        startedAt: Date.now(),
        status: "Starting",

        stream: null,
        approval: null,

      }));

    } else {

      this.seq = 1;

      this.setState({

        entries: [{

          id: "e1",
          kind: "task",

          text: task,
          attachments: imagePaths.length ? imagePaths : undefined,

        }],

        running: true,

        startedAt: Date.now(),
        status: "Starting",

        toggled: new Set<string>(),
        tokensUsed: 0,

        stream: null,
        approval: null,

      });

    }

    try {

      await window.swe.start({

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

      this.streamEntryId = null;
      this.setState({ running: false, startedAt: null, approval: null, stream: null });
      void this.refreshChats();
      void this.refreshUsage();

    }

  };

  render() {

    const { entries, assistants, assistantId, cwd, mode, running, startedAt, status, stream, approval, tokensUsed, usage: dailyUsage, chats, chatsLoading, activeChatId } = this.state;

    const model = assistants.find((a) => a.id === assistantId);
    const liveThought = this.streamStartedAt != null && this.thinkEndedAt != null ? this.thinkEndedAt - this.streamStartedAt : null;

    // include a synthetic stream row when only platform reasoning has arrived (no answer tokens yet)
    const liveStream = stream ?? (this.streamReasoning && running ? "" : null);
    const rows = liveStream === null
      ? entries
      : [...entries, streamStep(liveStream, liveThought, this.streamReasoning, this.streamEntryId ?? "stream")];

    const activeMode = MODES.find((m) => m.value === mode) ?? MODES[1];
    const ModeIcon = activeMode.icon;

    const folderName = cwd ? cwd.replaceAll("\\", "/").split("/").filter((x) => x).pop() ?? cwd : null;

    const limit = contextLimitOf(model ?? assistantId);
    const usage = usageOf(tokensUsed, limit);

    return (

      <div className="flex h-full bg-page">

        <Sidebar

          chats={chats}
          activeId={activeChatId}

          loading={chatsLoading}

          onSelect={(chat) => void this.selectChat(chat)}
          onDelete={(chat) => void this.deleteChat(chat)}
          onNew={this.newSession}

        />

        <div className="flex min-w-0 flex-1 flex-col">

          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">

            <button type="button" onClick={() => void this.pickFolder()} className="flex h-9 items-center gap-2 rounded-control border border-line bg-surface px-3 text-[13px] font-medium text-ink transition-colors duration-100 hover:bg-hover" >

              <FolderOpenIcon className="size-4 text-ink-3" />
              <span className="max-w-56 truncate">{cwd ? folderName : "Choose folder"}</span>

            </button>

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

          <div className="flex justify-center pt-1 pb-4">

            <div className="flex w-fit items-center gap-2.5 rounded-full bg-field px-3.5 py-1.5 shadow-hairline">

              {status === "Done" ? <CheckIcon className="size-3.5 text-green" strokeWidth={3} /> : null}

              {/* the agent sends "Step 2 · Drafting"; splitting it lets the gap come from flex, not the glyph */}
              {status.split(" · ").map((part, index) => (

                <Fragment key={index}>

                  {index > 0 ? <span className="text-[13px] text-ink-3">·</span> : null}

                  <span className={cn( "text-[13px] font-medium", status === "Error" ? "text-red" : status === "Done" ? "text-green" : "text-ink-2", )} >

                    {part}

                  </span>

                </Fragment>

              ))}

              {running && startedAt != null ? <Elapsed since={startedAt} /> : null}

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

            placeholder={running ? "Send a note while it works..." : activeChatId ? "Follow up on this session..." : "Describe the task..."}
            disabledPlaceholder="Choose a working folder first..."

            onModelChange={(id) => {

              localStorage.setItem(MODEL_KEY, id);
              this.setState({ assistantId: id });

            }}

            onSend={(task, imagePaths) => void this.start(task, imagePaths)}
            onPickImages={() => window.swe.pickImages()}
            onStop={() => void window.swe.stop()}

          />

        </div>

      </div>

    );

  }

}

createRoot(document.getElementById("root")!).render(<App />);
