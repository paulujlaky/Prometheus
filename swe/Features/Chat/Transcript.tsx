import { Component, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, FilePlus2Icon, FileTextIcon, FolderIcon, ListChecksIcon, ListTodoIcon, MessageSquareIcon, PencilLineIcon, RotateCcwIcon, SearchIcon, SparklesIcon, TerminalIcon, Trash2Icon, TriangleAlertIcon, Undo2Icon, UsersIcon } from "lucide-react";

import { UsageHeatmap, type UsageFile } from "@/Features/Usage/Heatmap";
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from "@/UI/Scroller";

import { cn } from "@/Utils/Class";

import { Code, FileWriteView } from "@/Features/Code/Code";
import { Md } from "@/Features/Code/Markdown";
import { cleanSummary, extractFinishedSummary, sayTextOf, fileEdits, inferTool, isDoneStep, parseReply, parseWrites, runCommandOf, summarizeCall, type FileEdit, type ParsedReply, type Tool } from "@/Agent/Parse";

import type { Entry, Step, SubagentEntry } from "@/Types/Transcript";

export { cleanSummary, parseReply };
export type { ParsedReply };
export type { Entry, Step, SubagentEntry };

/** Prefer measured ms; otherwise rough gen-time from thinking length (~50 chars/s). */
export function thoughtSeconds(step: Pick<Step, "thinking" | "thoughtMs" | "streaming" | "command">): number | null {

  const text = step.thinking.trim();

  if (!text) {

    return null;

  }

  // the thought is over the moment the fence opens, even though the step keeps streaming
  if (step.streaming && !step.command) {

    return null;

  }

  if (step.thoughtMs != null && step.thoughtMs > 0) {

    return Math.max(1, Math.round(step.thoughtMs / 1000));

  }

  return Math.max(1, Math.round(text.length / 50));

}

/** Row title: the model's label, or a placeholder until it arrives. */
export function stepLabel(step: Pick<Step, "desc" | "streaming" | "command" | "tool">): string {

  const desc = step.desc.replace(/\s+/g, " ").trim();

  if (desc) {

    return desc;

  }

  if (step.tool) {

    return step.tool;

  }

  return step.streaming || !step.command ? "Working" : "Ran a command";

}

export type StepStatus = "working" | "succeeded" | "failed" | "unknown";

/**
 * Every settled step reports a status, so the trailing column never blinks in and out.
 * `unknown` is a replayed step whose observation was never stored.
*/
export function stepStatus( step: Pick<Step, "streaming" | "output" | "exitCode">, opts: { pending?: boolean } = {}, ): StepStatus {

  const pending = opts.pending ?? true;

  if (step.streaming && pending) {

    return "working";

  }

  if (step.output === null) {

    return pending ? "working" : "unknown";

  }

  if (step.exitCode === null) {

    return "unknown";

  }

  return step.exitCode === 0 ? "succeeded" : "failed";

}

/**
 * Updates a step in place while it streams, so the transcript can render it without waiting for the final observation.
*/
export function streamStep(stream: string, thoughtMs: number | null, platformReasoning = "", id = "stream"): Step {

  const { tool, desc, thinking: harnessThinking, command } = parseReply(stream);

  // live platform Reasoning takes priority over harness prose between label and fence
  const thinking = platformReasoning.trim() || harnessThinking;

  return {

    id,
    kind: "step",

    tool,
    desc,
    thinking,
    thoughtMs,
    command,

    output: null,
    exitCode: null,

    streaming: true,

  };

}

const PIXEL_DELAYS = [90, 180, 270, 0, 90, 180, 90, 180, 270];

/** Nine-pixel loader from the reference set — reads as "busy" without spinning. */
export function Pixels({ className, cell = 5 }: { className?: string; cell?: number }) {

  return (

    <span aria-hidden className={cn("grid", className)} style={{ gridTemplateColumns: `repeat(3, ${cell}px)`, gap: cell <= 3 ? 1.5 : 2 }} >

      {PIXEL_DELAYS.map((delay, index) => (

        <span key={index} className="rounded-[1px] bg-ink" style={{ width: cell, height: cell, opacity: 0.15, animation: `pixel-on 650ms ease-in-out ${delay}ms infinite` }} />

      ))}

    </span>

  );

}

/** Perimeter of the same nine-pixel grid, clockwise from the top-left. */
const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];

const ORBIT_DELAYS = Array.from({ length: 9 }, (_, index) => {

  const step = ORBIT_ORDER.indexOf(index);

  // the centre is off the track: null parks it dim instead of lighting it
  return step === -1 ? null : step * 110;

});

/** Animatied loading indicator. */
export function Orbit({ className, cell = 3 }: { className?: string; cell?: number }) {

  return (

    <span aria-hidden className={cn("grid", className)} style={{ gridTemplateColumns: `repeat(3, ${cell}px)`, gap: cell <= 3 ? 1.5 : 2 }}>

      {ORBIT_DELAYS.map((delay, index) => (

        <span

          key={index}
          className="rounded-[1px] bg-ink"

          style={{

            width: cell,
            height: cell,

            opacity: delay === null ? 0.07 : 0.15,
            animation: delay === null ? "none" : `pixel-on 950ms ease-in-out ${delay}ms infinite`,

          }}

        />

      ))}

    </span>

  );

}

/** Stable, quiet placeholder while the model has not labeled a step yet. */
export function Working() {

  return (

    <div className="flex h-8 w-full min-w-0 items-center" aria-busy="true" aria-label="Working">

      <span className="shimmer-label text-[14px] font-medium">Working</span>

    </div>

  );

}

const TOOL_ICONS: Record<Tool, typeof FileTextIcon> = {

  ls: FolderIcon,
  read: FileTextIcon,
  grep: SearchIcon,
  write: FilePlus2Icon,
  edit: PencilLineIcon,
  delete: Trash2Icon,
  run: TerminalIcon,
  spawn: UsersIcon,
  plan: ListTodoIcon,
  ask: ListChecksIcon,
  retry: RotateCcwIcon,
  say: MessageSquareIcon,
  done: CheckIcon,

};

interface RowProps {

  icon: typeof FileTextIcon;

  /** Swaps the resting glyph for the loader until the step settles. */
  working?: boolean;

  label: ReactNode;

  open: boolean;
  onToggle: () => void;

  trailing?: ReactNode;
  children?: ReactNode;

}

function ThinkingRow({ thinking, seconds, live, open, onToggle }: { thinking: string; seconds: number | null; live: boolean; open: boolean; onToggle: () => void }) {

  return (

    <ToolRow

      icon={SparklesIcon}
      working={live}

      label={live ? <span className="shimmer-label min-w-0 truncate text-[14px] font-medium">Thinking</span> : <span className="min-w-0 truncate text-[14px] font-medium text-ink-2">Thought for {seconds ?? 1}s</span>}

      open={open}
      onToggle={onToggle}

    >

      <Md className="text-[12.5px] leading-[1.7] text-ink-2">{thinking}</Md>

    </ToolRow>

  );

}

/** The one row shape every tool call and thinking block shares: glyph, label, status. */
function ToolRow({ icon: Icon, working, label, open, onToggle, trailing, children }: RowProps) {

  const resting = "transition-opacity duration-100 group-hover/row:opacity-0";

  return (

    <div className="w-full animate-tool-reveal">

      <button className="group/row flex h-9 w-full min-w-0 cursor-pointer items-center gap-2.5 text-left"

        type="button"
        aria-expanded={open}

        onClick={onToggle}

      >

        {/* loader while working, tool icon once settled; either way hover swaps in the chevron */}
        <span className="relative flex size-4 shrink-0 items-center justify-center text-ink-3">

          {working ? (

            <Pixels cell={3} className={cn(resting, open && "opacity-0")} />

          ) : (

            <Icon className={cn("size-4", resting, open && "opacity-0")} />

          )}

          <ChevronDownIcon className={cn( "absolute size-4 transition-[opacity,transform] duration-150 group-hover/row:opacity-100", open ? "opacity-100" : "-rotate-90 opacity-0", )} />

        </span>

        {label}

        <span className="min-w-0 flex-1" />

        {trailing}

      </button>

      <Reveal open={open}>

        <div className="mt-1 mb-1.5 ml-2 flex flex-col gap-1.5 border-l border-line py-0.5 pl-4">

          {children}

        </div>

      </Reveal>

    </div>

  );

}

interface StepRowProps {

  step: Step;
  open: boolean;
  onToggle: () => void;

  /** False once a later call exists (or the run ended) — kills a stuck shimmer. */
  pending?: boolean;

  /** Replaces the exit-code status on rows that know more about themselves than the exit code does. */
  note?: ReactNode;

}

interface StepRowState {

  thinkOpen: boolean;

}

/**
 * A step is up to two rows: the thinking that produced it, then the tool call itself.
*/
class StepRow extends Component<StepRowProps, StepRowState> {

  state: StepRowState = { thinkOpen: false };

  render() {

    const { step, open, onToggle, pending = true, note } = this.props;
    const { thinkOpen } = this.state;

    const thinking = step.thinking.trim();
    const seconds = thoughtSeconds(step);

    const status = stepStatus(step, { pending });
    const working = status === "working";
    const failed = status === "failed";

    const showThinking = Boolean(thinking) && Boolean(step.desc || step.tool);
    const thinkLive = pending && step.streaming && seconds == null;

    if (step.streaming && !step.desc && !step.tool && step.command == null) {

      return <Working />;

    }

    const kind = step.tool ?? inferTool(step.command);

    if (kind === "say") {

      const text = sayTextOf(step.command) || (step.output?.trim() && step.output !== "ok" ? step.output.trim() : "");

      return (

        <>

          {showThinking ? (

            <ThinkingRow thinking={thinking} seconds={seconds} live={thinkLive} open={thinkOpen} onToggle={() => this.setState((prev) => ({ thinkOpen: !prev.thinkOpen }))} />

          ) : null}

          {text ? (

            <div className="flex min-h-9 py-2 w-full items-center animate-tool-reveal">

              <Md className="text-[14px] leading-normal text-ink">{text}</Md>

            </div>

          ) : working ? (

            <Working />

          ) : null}

        </>

      );

    }

    const writes = step.command ? parseWrites(step.command) : [];

    let linesAdded = 0;
    let linesRemoved = 0;

    for (const write of writes) {

      linesAdded += write.added;
      linesRemoved += write.removed;

    }

    const hasLineCounts = linesAdded > 0 || linesRemoved > 0;
    const bash = runCommandOf(step.command, step.tool);
    const showDiff = kind === "edit" && writes.length > 0;
    const overview = !bash && !showDiff ? summarizeCall(step.command, step.tool) : "";
    const showOverview = Boolean(overview) && overview !== kind && !overview.endsWith(": .");

    const label = working ? (

      <span className="shimmer-label min-w-0 truncate text-[14px] font-medium">{stepLabel(step)}</span>

    ) : (

      <span className={cn("min-w-0 truncate", step.streaming && "animate-stream-in")}>

        <Md inline className="text-[14px] font-medium text-ink">{stepLabel(step)}</Md>

      </span>

    );

    const computed = hasLineCounts ? (

      <span className="flex shrink-0 items-center gap-1.5 font-mono text-[12px] tabular-nums" title={failed ? `Exit code ${step.exitCode}` : undefined}>

        {linesAdded > 0 ? <span className="text-green">+{linesAdded}</span> : null}
        {linesRemoved > 0 ? <span className="text-red">−{linesRemoved}</span> : null}

      </span>

    ) : working || status === "unknown" ? null : (

      <span className={cn("shrink-0 text-[12.5px] animate-fade-in", failed ? "text-red/85" : "text-green/85")} title={failed ? `Exit code ${step.exitCode}` : undefined} >

        {failed ? "Failed" : "Succeeded"}

      </span>

    );

    // a spawn row reports how many children are still out; its exit code says nothing until they land
    const trailing = note ?? computed;

    return (

      <>

        {showThinking ? (

          <ThinkingRow thinking={thinking} seconds={seconds} live={thinkLive} open={thinkOpen} onToggle={() => this.setState((prev) => ({ thinkOpen: !prev.thinkOpen }))} />

        ) : null}

        <ToolRow

          icon={TOOL_ICONS[step.tool ?? inferTool(step.command) ?? "run"]}
          working={working}

          label={label}

          open={open}
          onToggle={onToggle}

          trailing={trailing}

        >

          {showOverview ? (

            <p className="font-mono text-[12.5px] text-ink-2">{overview}</p>

          ) : null}

          {showDiff ? writes.map((write, index) => <FileWriteView key={index} write={write} />) : null}

          {bash ? (

            <>

              <div className="overflow-x-auto rounded-chip border border-line bg-inset p-2.5">

                <Code code={bash} streaming={step.streaming} />

              </div>

              {step.output !== null ? (

                <pre className="max-h-72 overflow-auto rounded-chip border border-line bg-inset p-2.5 font-mono text-[12.5px] leading-[1.65] whitespace-pre-wrap text-ink-2">

                  {step.output.trim() || "<no output>"}

                </pre>

              ) : null}

            </>

          ) : null}

        </ToolRow>

      </>

    );

  }

}

/** done so height animates without measuring anything. */
function Reveal({ open, children }: { open: boolean; children: ReactNode }) {

  return (

    <div className="grid transition-[grid-template-rows,opacity] duration-300 ease-glide" style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }} >

      <div className="min-h-0 overflow-hidden">{children}</div>

    </div>

  );

}

/** What a finished run actually changed, rolled up from the patches it applied. */
function editsOf(steps: Step[]): FileEdit[] {

  const totals = new Map<string, FileEdit>();

  for (const step of steps) {

    if (step.command == null || step.exitCode !== 0) {

      continue;

    }

    for (const edit of fileEdits(step.command)) {

      const current = totals.get(edit.file) ?? { file: edit.file, added: 0, removed: 0 };

      current.added += edit.added;
      current.removed += edit.removed;

      totals.set(edit.file, current);

    }

  }

  return [...totals.values()].sort((a, b) => b.added + b.removed - (a.added + a.removed));

}

/** Cards from one spawn block, pinned to the step that opened them. */
export interface SwarmGroup {

  after: string;
  subs: SubagentEntry[];

}

interface RunProps {

  steps: Step[];

  /** Subagent cards to drop directly beneath their spawn row. */
  swarms?: SwarmGroup[];

  /** This run is settled — mid-run the summary would flash in between every step. */
  finished: boolean;

  /** Between steps: show Working inside this run (gap-1) instead of as a separate block. */
  showWorking?: boolean;

  /** Final <done> for this run, folded in so it paints with the already-mounted row. */
  verdict?: Extract<Entry, { kind: "done" }>;
  verdictAction?: ReactNode;

  isOpen: (entry: Entry) => boolean;
  onToggle: (entry: Entry) => void;

}

const EDIT_CHIPS = 4;

/** Contiguous tool calls as a flat list, with what they changed summarised underneath. */
class Run extends Component<RunProps, { allEdits: boolean }> {

  state = { allEdits: false };

  render() {

    const { steps, swarms, finished, showWorking, verdict, verdictAction, isOpen, onToggle } = this.props;
    const { allEdits } = this.state;

    const visible = steps.filter((step) => !isDoneStep(step));
    const edits = finished ? editsOf(visible) : [];
    const shown = allEdits ? edits : edits.slice(0, EDIT_CHIPS);

    return (

      <div className="w-full">

        <div className="flex flex-col gap-1">

          {visible.map((step, index) => {

            const group = swarms?.find((one) => one.after === step.id);
            const live = group ? group.subs.filter((sub) => sub.status === "working").length : 0;

            return (

              <div key={step.id} style={{ animation: `fade-up 300ms var(--ease-glide) ${Math.min(index, 8) * 45}ms both` }}>

                <StepRow

                  step={step}
                  open={isOpen(step)}
                  onToggle={() => onToggle(step)}

                  pending={!finished && index === visible.length - 1 && !showWorking}

                  note={live ? <span className="shrink-0 text-[12.5px] text-ink-3 animate-fade-in">{live} running</span> : undefined}

                />

                {group ? (

                  <div className="mt-1.5 mb-1 flex flex-col gap-2">

                    {group.subs.map((sub) => <SubagentCard key={sub.id} entry={sub} />)}

                  </div>

                ) : null}

              </div>

            );

          })}

          {showWorking ? <Working /> : null}

        </div>

        {shown.length ? (

          <div className="mt-3 flex max-w-full flex-wrap gap-2 border-b border-line pb-3">

            {shown.map((edit, index) => (

              <span key={edit.file} className="inline-flex h-7 max-w-full items-center gap-2 rounded-chip border border-line-strong bg-surface px-2.5 font-mono text-[12px] text-ink" style={{ animation: `pop-in 250ms var(--ease-glide) ${index * 70}ms both` }} >

                <span className="min-w-0 truncate">{edit.file}</span>

                {edit.added > 0 ? <span className="shrink-0 text-green tabular-nums">+{edit.added}</span> : null}
                {edit.removed > 0 ? <span className="shrink-0 text-red tabular-nums">−{edit.removed}</span> : null}

              </span>

            ))}

            {edits.length > shown.length ? (

              <button type="button" onClick={() => this.setState({ allEdits: true })} className="inline-flex h-7 cursor-pointer items-center rounded-chip px-2 font-mono text-[12px] text-ink-3 transition-colors duration-100 hover:text-ink-2" >

                +{edits.length - shown.length} more

              </button>

            ) : null}

          </div>

        ) : null}

        {verdict ? (

          <div className="mt-6">

            <Verdict tone="green" icon={<CheckIcon className="size-3.5" strokeWidth={3.5} />} action={verdictAction}>

              <Md className="max-w-2xl text-[14px] text-ink">{cleanSummary(verdict.text)}</Md>

            </Verdict>

          </div>

        ) : null}

      </div>

    );

  }

}

interface SubagentCardState {

  open: boolean;
  openSteps: Set<string>;

}

/**
 * A child's work, folded into one card. It owns its own open state rather than borrowing the
 * transcript's: these rows come and go with the run, and a stale id in the shared set outlives them.
 */
class SubagentCard extends Component<{ entry: SubagentEntry }, SubagentCardState> {

  state: SubagentCardState = { open: false, openSteps: new Set<string>() };

  private toggleStep = (step: Step) => {

    this.setState((prev) => {

      const openSteps = new Set(prev.openSteps);

      if (openSteps.has(step.id)) {

        openSteps.delete(step.id);

      } else {

        openSteps.add(step.id);

      }

      return { openSteps };

    });

  };

  render() {

    const { entry } = this.props;
    const { open, openSteps } = this.state;

    const working = entry.status === "working";
    const failed = entry.status === "failed";

    const count = entry.steps.length;
    const subtitle = working ? entry.note || entry.task : entry.task;

    return (

      <div className={cn("overflow-hidden rounded-card border bg-surface animate-fade-up", failed ? "border-red/40" : "border-line")}>

        <button type="button" aria-expanded={open} onClick={() => this.setState((prev) => ({ open: !prev.open }))} className="flex w-full min-w-0 cursor-pointer items-center gap-2.5 px-3 py-2.5 text-left" >

          <span className="flex size-4 shrink-0 items-center justify-center">

            {working ? (

              <Orbit cell={3} />

            ) : failed ? (

              <TriangleAlertIcon className="size-4 text-red" strokeWidth={2.5} />

            ) : (

              <CheckIcon className="size-4 text-green" strokeWidth={3} />

            )}

          </span>

          <span className="flex min-w-0 flex-1 flex-col">

            <span className={cn("truncate text-[13.5px] font-medium", failed ? "text-red" : "text-ink")}>{entry.name}</span>

            <span className="truncate text-[12px] text-ink-3">{subtitle}</span>

          </span>

          <span className="shrink-0 font-mono text-[12px] tabular-nums text-ink-3">

            {count === 1 ? "1 step" : `${count} steps`}

          </span>

          <ChevronDownIcon className={cn("size-4 shrink-0 text-ink-3 transition-transform duration-150", open ? "" : "-rotate-90")} />

        </button>

        <Reveal open={open}>

          <div className="flex flex-col gap-1 border-t border-line px-3 py-2">

            {count ? entry.steps.map((step) => (

              <StepRow key={step.id} step={step} open={openSteps.has(step.id)} onToggle={() => this.toggleStep(step)} pending={working} />

            )) : (

              <p className="py-1 text-[12.5px] text-ink-3">Nothing yet.</p>

            )}

          </div>

        </Reveal>

        {entry.summary ? (

          <div className="border-t border-line bg-inset px-3 py-2.5">

            <Md className="text-[13px] leading-[1.7] text-ink-2">{entry.summary}</Md>

          </div>

        ) : null}

      </div>

    );

  }

}

/**
 * Children with no step row to hang off — a replayed transcript, or a spawn whose row was pruned.
 * The count that used to sit here now rides on the spawn row itself.
 */
function Swarm({ subs }: { subs: SubagentEntry[] }) {

  return (

    <div className="flex w-full flex-col gap-2">

      {subs.map((sub) => <SubagentCard key={sub.id} entry={sub} />)}

    </div>

  );

}

function fileLabel(path: string): string {

  const parts = path.replaceAll("\\", "/").split("/");

  return parts[parts.length - 1] || path;

}

function TaskBubble({ text, attachments }: { text: string; attachments?: string[] }) {

  const files = attachments?.filter(Boolean) ?? [];

  return (

    <div className="flex justify-end pl-12">

      <div className="flex max-w-[min(100%,34rem)] flex-col gap-2 rounded-window bg-field px-3.5 py-2 text-[14.5px] leading-normal text-ink animate-fade-up">

        {text ? <div className="whitespace-pre-wrap">{text}</div> : null}

        {files.length ? (

          <div className="flex flex-wrap gap-1.5">

            {files.map((path) => (

              <span key={path} className="inline-flex max-w-full items-center rounded-control border border-line bg-inset px-2 py-0.5 font-mono text-[12px] text-ink-2" title={path}>

                <span className="min-w-0 truncate">{fileLabel(path)}</span>

              </span>

            ))}

          </div>

        ) : null}

      </div>

    </div>

  );

}

/** What the transcript needs to offer a rollback beside one verdict. */
export interface UndoInfo {

  commit: string;
  undone?: boolean;

}

function UndoControl({ info, busy, onUndo }: { info: UndoInfo; busy: boolean; onUndo: (commit: string) => void }) {

  if (info.undone) {

    return (

      <span className="flex items-center gap-1.5 px-2 py-1 text-[12px] text-ink-3" title="These changes were rolled back">

        <Undo2Icon className="size-3.5" strokeWidth={2} />
        Undone

      </span>

    );

  }

  return (

    <button className="flex items-center gap-1.5 rounded-full px-2 py-1 text-[12px] text-ink-3 transition-colors hover:bg-surface hover:text-ink disabled:pointer-events-none disabled:opacity-50"

      type="button"
      disabled={busy}

      title="Restore the files to their state before this run"

      onClick={() => onUndo(info.commit)}

    >

      <Undo2Icon className="size-3.5" strokeWidth={2} />
      {busy ? "Undoing..." : "Undo"}

    </button>

  );

}

function Verdict({ tone, icon, action, children }: { tone: "green" | "red"; icon: ReactNode; action?: ReactNode; children: ReactNode }) {

  return (

    <div className="flex items-start gap-3 animate-fade-up">

      <span className={cn( "mt-px flex size-6 shrink-0 items-center justify-center rounded-full text-white", tone === "green" ? "bg-green" : "bg-red", )} >

        {icon}

      </span>

      {/* first child keeps its top margin at zero so the opening line stays level with the glyph */}

      <div className="min-w-0 flex-1 pt-0.5 [&_ol:first-child]:mt-0 [&_p:first-child+ol]:mt-2.5 [&_p:first-child+ul]:mt-2.5 [&_p:first-child]:mt-0 [&_ul:first-child]:mt-0">{children}</div>

      {action ? <div className="shrink-0">{action}</div> : null}

    </div>

  );

}

interface TranscriptProps {

  entries: Entry[];

  /** The agent loop is live; gates the run summary and the trailing busy indicator. */
  running: boolean;

  empty: string;

  /** Daily token totals for the empty-state heatmap. */
  usage?: UsageFile;

  isOpen: (entry: Entry) => boolean;
  onToggle: (entry: Entry) => void;

  /** Rollback mark for a verdict row, when a snapshot was taken for that run. */
  undoFor?: (entry: Entry) => UndoInfo | null;
  onUndo?: (commit: string) => void;

  /** Commit currently being restored, so its control can show progress. */
  undoBusy?: string | null;

}

/** Rows collapse into blocks: contiguous steps become one run, everything else stands alone. */
type DoneEntry = Extract<Entry, { kind: "done" }>;

type Block =
  | { key: string; kind: "run"; steps: Step[]; swarms?: SwarmGroup[]; verdict?: DoneEntry }
  | { key: string; kind: "swarm"; subs: SubagentEntry[] }
  | { key: string; kind: "entry"; entry: Exclude<Entry, Step | SubagentEntry> };

function asSayStep(entry: Extract<Entry, { kind: "say" }>): Step {

  return {

    id: entry.id,
    kind: "step",

    tool: "say",
    desc: "",
    thinking: "",

    command: `<say>\n${entry.text}\n</say>`,
    output: entry.text,
    exitCode: 0,

    streaming: false,

  };

}

function doneTextFromStep(step: Step): string {

  const fromOutput = step.output?.trim() ?? "";

  if (fromOutput) {

    return fromOutput;

  }

  return extractFinishedSummary(step.command ?? "") ?? "";

}

type RunBlock = Extract<Block, { kind: "run" }>;
type EntryBlock = Extract<Block, { kind: "entry" }>;

/**
 * Where the turn in flight parks its verdict.
 */
type VerdictSlot =
  | { on: "run"; run: RunBlock }
  | { on: "row"; row: EntryBlock };

/**
 * A verdict is always the last thing in a turn, so it either writes through the run that opened the turn.
 */
function placeVerdict(blocks: Block[], verdict: DoneEntry, slot: VerdictSlot | null): VerdictSlot {

  // the turn already has a verdict; this is the paired half, so write through it in place
  if (slot) {

    if (slot.on === "run") {

      slot.run.verdict = verdict;

    } else {

      slot.row.entry = verdict;

    }

    return slot;

  }

  const last = blocks[blocks.length - 1];

  if (last?.kind === "run") {

    last.verdict = verdict;

    return { on: "run", run: last };

  }

  // no run to close (a verdict straight after a task or a swarm)

  const row: EntryBlock = { key: verdict.id, kind: "entry", entry: verdict };

  blocks.push(row);

  return { on: "row", row };

}

function toBlocks(entries: Entry[]): Block[] {

  const blocks: Block[] = [];

  // open for the turn in flight, closed by the next task — see placeVerdict
  let slot: VerdictSlot | null = null;

  for (const entry of entries) {

    if (entry.kind === "step" && isDoneStep(entry)) {

      const text = doneTextFromStep(entry) || "Task complete.";

      slot = placeVerdict(blocks, { id: entry.id, kind: "done", text }, slot);

      continue;

    }

    // children of one spawn arrive back to back, so they collect against the row that opened them
    if (entry.kind === "subagent") {

      const last = blocks[blocks.length - 1];

      if (last?.kind === "run") {

        // the spawn row is the newest step when its children start, and stays their anchor after

        const anchor = last.steps[last.steps.length - 1]?.id ?? "";
        const groups = last.swarms ?? (last.swarms = []);
        const group = groups.find((one) => one.after === anchor);

        if (group) {

          group.subs.push(entry);

        } else {

          groups.push({ after: anchor, subs: [entry] });

        }

        continue;

      }

      if (last?.kind === "swarm") {

        last.subs.push(entry);
        continue;

      }

      blocks.push({ key: `swarm-${entry.id}`, kind: "swarm", subs: [entry] });
      continue;

    }

    // echoes sit in the run (gap-1) so they line up with other tool calls

    if (entry.kind === "say" || entry.kind === "step") {

      const step = entry.kind === "say" ? asSayStep(entry) : entry;
      const last = blocks[blocks.length - 1];

      if (last?.kind === "run") {

        last.steps.push(step);
        continue;

      }

      blocks.push({ key: `run-${step.id}`, kind: "run", steps: [step] });
      continue;

    }

    if (entry.kind === "done") {

      slot = placeVerdict(blocks, entry, slot);
      continue;

    }

    // a new task is the only thing that ends a turn; an error is a sibling of the verdict

    if (entry.kind !== "error") {

      slot = null;

    }

    blocks.push({ key: entry.id, kind: "entry", entry });

  }

  return blocks;

}

export function Transcript({ entries, running, empty, usage, isOpen, onToggle, undoFor, onUndo, undoBusy }: TranscriptProps) {

  const blocks = toBlocks(entries);

  const undoNode = (entry: Entry): ReactNode => {

    const info = undoFor?.(entry) ?? null;

    if (!info || !onUndo) {

      return null;

    }

    return <UndoControl info={info} busy={undoBusy === info.commit} onUndo={onUndo} />;

  };

  // between steps nothing is streaming and no row is pending, so the transcript would look idle
  const busy = entries.some((entry) => (

    (entry.kind === "step" && !isDoneStep(entry) && (entry.streaming || entry.output === null)) || (entry.kind === "subagent" && entry.status === "working")

  ));

  const tail = blocks[blocks.length - 1];
  const lastSettled = tail?.kind === "run" ? Boolean(tail.verdict) : tail?.kind === "swarm" ? false : tail?.entry.kind === "done" || tail?.entry.kind === "error";

  return (

    <MessageScrollerProvider autoScroll defaultScrollPosition="end">

      <MessageScroller className="flex-1">

        <MessageScrollerViewport className="px-5">

          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 py-7">

            {!entries.length && (

              <div className="flex flex-col items-center gap-6 pt-20 pb-6">

                {usage ? <UsageHeatmap usage={usage} /> : null}

                <p className="text-center text-[14px] text-ink-3">{empty}</p>

              </div>

            )}

            {blocks.map((block, index) => {

              const last = index === blocks.length - 1;
              const runVerdict = block.kind === "run" ? block.verdict : undefined;

              // keep Working inside the run's gap-1 so it sits closer than a block-level gap-6
              const workInRun = running && !busy && last && block.kind === "run" && !runVerdict;

              return (

                <MessageScrollerItem key={block.key} messageId={block.key}>

                  {block.kind === "run" ? (

                    <Run

                      steps={block.steps}
                      swarms={block.swarms}

                      finished={!running || !last || Boolean(runVerdict)}

                      showWorking={workInRun}

                      verdict={runVerdict}
                      verdictAction={runVerdict ? undoNode(runVerdict) : undefined}

                      isOpen={isOpen}
                      onToggle={onToggle}

                    />

                  ) : block.kind === "swarm" ? (

                    <Swarm subs={block.subs} />

                  ) : block.entry.kind === "task" ? (

                    <TaskBubble text={block.entry.text} attachments={block.entry.attachments} />

                  ) : block.entry.kind === "say" ? (

                    <div className="max-w-2xl animate-fade-up"><Md className="text-[14px] text-ink">{block.entry.text}</Md></div>

                  ) : block.entry.kind === "done" ? (

                    <Verdict tone="green" icon={<CheckIcon className="size-3.5" strokeWidth={3.5} />} action={undoNode(block.entry)}>

                      <Md className="max-w-2xl text-[14px] text-ink">{cleanSummary(block.entry.text)}</Md>

                    </Verdict>

                  ) : (

                    <Verdict tone="red" icon={<TriangleAlertIcon className="size-3.5" strokeWidth={2.5} />}>

                      <p className="text-[14px] leading-normal text-ink">{block.entry.text}</p>

                    </Verdict>

                  )}

                </MessageScrollerItem>

              );

            })}

            {running && !busy && !lastSettled && (blocks.length === 0 || blocks[blocks.length - 1]?.kind !== "run") ? (

              <MessageScrollerItem key="working" messageId="working">

                <div className="-mt-2">

                  <Working />

                </div>

              </MessageScrollerItem>

            ) : null}

          </MessageScrollerContent>

        </MessageScrollerViewport>

        <MessageScrollerButton className="left-1/2" />

      </MessageScroller>

    </MessageScrollerProvider>

  );

}
