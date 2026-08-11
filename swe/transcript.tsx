import { Component, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, FilePlus2Icon, FileTextIcon, PencilLineIcon, SearchIcon, SparklesIcon, TerminalIcon, TriangleAlertIcon, WrenchIcon } from "lucide-react";

import { UsageHeatmap, type UsageFile } from "@/comps/heatmap";
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from "@/comps/ui/message-scroller";

import { cn } from "@/lib/utils";

import { Code, FileWriteView } from "./code";
import { Md } from "./md";
import { cleanSummary, fileEdits, inferTool, parseReply, parseWrites, type FileEdit, type ParsedReply, type Tool } from "./parse";

export { cleanSummary, parseReply };
export type { ParsedReply };

/** One turn of the loop. */
export interface Step {

  id: string;
  kind: "step";

  /** Preset classifier from the reply label; picks the row icon. */
  tool: Tool | null;

  /** Short label the model wrote after the classifier. */
  desc: string;

  /** Non-desc prose before the fence (rendered as its own Thinking row). */
  thinking: string;

  /** Wall-clock or estimated ms spent drafting (for "Thought for Ns"). */
  thoughtMs?: number | null;

  command: string | null;

  output: string | null;
  exitCode: number | null;

  streaming: boolean;

}

export type Entry =
  | Step
  | { id: string; kind: "task"; text: string }
  | { id: string; kind: "done"; text: string }
  | { id: string; kind: "error"; text: string };

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
export function stepLabel(step: Pick<Step, "desc" | "streaming" | "command">): string {

  const desc = step.desc.replace(/\s+/g, " ").trim();

  return desc || (step.streaming || !step.command ? "Working" : "Ran a command");

}

export type StepStatus = "working" | "succeeded" | "failed" | "unknown";

/**
 * Every settled step reports a status, so the trailing column never blinks in and out.
 * `unknown` is a replayed step whose observation was never stored.
*/
export function stepStatus(step: Pick<Step, "streaming" | "output" | "exitCode">): StepStatus {

  if (step.streaming || step.output === null) {

    return "working";

  }

  if (step.exitCode === null) {

    return "unknown";

  }

  return step.exitCode === 0 ? "succeeded" : "failed";

}

/**
 * The step being streamed; the id is stable so React keeps the nodes as the text grows.
 * `thoughtMs` is threaded in live so the duration does not jump when the step settles.
*/
export function streamStep(stream: string, thoughtMs: number | null): Step {

  const { tool, desc, thinking, command } = parseReply(stream);

  return {

    id: "stream",
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

/** Stable, quiet placeholder while the model has not labeled a step yet. */
export function Working() {

  return (

    <div className="flex h-9 w-full min-w-0 items-center">

      <span className="shimmer-label text-[14px] font-medium">Working</span>

    </div>

  );

}

const TOOL_ICONS: Record<Tool, typeof FileTextIcon> = {

  read: FileTextIcon,
  search: SearchIcon,
  write: FilePlus2Icon,
  edit: PencilLineIcon,
  run: TerminalIcon,
  test: CheckIcon,
  fix: WrenchIcon,
  think: SparklesIcon,
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

/** The one row shape every tool call and thinking block shares: glyph, label, status. */
function ToolRow({ icon: Icon, working, label, open, onToggle, trailing, children }: RowProps) {

  const resting = "transition-opacity duration-100 group-hover/row:opacity-0";

  return (

    <div className="w-full animate-tool-reveal">

      <button type="button" aria-expanded={open} onClick={onToggle} className="group/row flex h-9 w-full min-w-0 cursor-pointer items-center gap-2.5 text-left" >

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

    const { step, open, onToggle } = this.props;
    const { thinkOpen } = this.state;

    const empty = !step.desc && !step.thinking && step.command == null;

    // nothing has streamed yet — a bare pulse rather than an empty row
    if (step.streaming && empty) {

      return <Working />;

    }

    const thinking = step.thinking.trim();
    const seconds = thoughtSeconds(step);

    const status = stepStatus(step);
    const working = status === "working";
    const failed = status === "failed";

    // splitting needs a real label to split against; without one the monologue IS the step,
    const showThinking = Boolean(thinking) && Boolean(step.desc);

    // a reply with no bash at all is a protocol miss; show the prose instead of an empty body
    const proseOnly = !step.streaming && !step.command;

    // thinking already has its own row when shown; repeating it here is the same duplication
    const prose = [step.desc, showThinking ? "" : thinking].filter(Boolean).join("\n\n");

    // parsed as it streams: a partial patch yields the files it has reached so far, and grows
    const writes = step.command ? parseWrites(step.command) : [];

    // while working the label carries the motion, so no caret is needed to signal streaming
    const label = working ? (

      <span className="shimmer-label min-w-0 truncate text-[14px] font-medium">{stepLabel(step)}</span>

    ) : (

      <span className={cn("min-w-0 truncate", step.streaming && "animate-stream-in")}>

        <Md inline className="text-[14px] font-medium text-ink">{stepLabel(step)}</Md>

      </span>

    );

    return (

      <>

        {showThinking ? (

          <ToolRow

            icon={SparklesIcon}
            working={seconds == null}

            label={ seconds == null ? <span className="shimmer-label min-w-0 truncate text-[14px] font-medium">Thinking</span> : <span className="min-w-0 truncate text-[14px] font-medium text-ink-2">Thought for {seconds}s</span> }

            open={thinkOpen}
            onToggle={() => this.setState((prev) => ({ thinkOpen: !prev.thinkOpen }))}

          >

            <Md className="text-[12.5px] leading-[1.7] text-ink-2">{thinking}</Md>

          </ToolRow>

        ) : null}

        <ToolRow

          icon={TOOL_ICONS[step.tool ?? inferTool(step.command)]}
          working={working}

          label={label}

          open={open}
          onToggle={onToggle}

          trailing={

            working || status === "unknown" ? null : (

              <span className={cn("shrink-0 text-[12.5px] animate-fade-in", failed ? "text-red/85" : "text-green/85")} title={failed ? `Exit code ${step.exitCode}` : undefined} >

                {failed ? "Failed" : "Succeeded"}

              </span>

            )

          }

        >

          {proseOnly ? (

            <Md className="text-[13px] text-ink-2">{prose || stepLabel(step)}</Md>

          ) : null}

          {/* shows the code the agent produced */}
          {writes.map((write, index) => <FileWriteView key={index} write={write} />)}

          {step.command && !writes.length ? (

            <div className="overflow-x-auto rounded-chip border border-line bg-inset p-2.5">

              <Code code={step.command} streaming={step.streaming} />

            </div>

          ) : null}

          {step.output !== null ? (

            <pre className="max-h-72 overflow-auto rounded-chip border border-line bg-inset p-2.5 font-mono text-[12.5px] leading-[1.65] whitespace-pre-wrap text-ink-2">

              {step.output.trim() || "<no output>"}

            </pre>

          ) : null}

        </ToolRow>

      </>

    );

  }

}

/** done so height animates without measuring anything. */
function Reveal({ open, children }: { open: boolean; children: ReactNode }) {

  return (

    <div className="grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]" style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }} >

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

interface RunProps {

  steps: Step[];

  /** The whole session is done — mid-run the summary would flash in between every step. */
  finished: boolean;

  isOpen: (entry: Entry) => boolean;
  onToggle: (entry: Entry) => void;

}

const EDIT_CHIPS = 4;

/** Contiguous tool calls as a flat list, with what they changed summarised underneath. */
class Run extends Component<RunProps, { allEdits: boolean }> {

  state = { allEdits: false };

  render() {

    const { steps, finished, isOpen, onToggle } = this.props;
    const { allEdits } = this.state;

    const edits = finished ? editsOf(steps) : [];
    const shown = allEdits ? edits : edits.slice(0, EDIT_CHIPS);

    return (

      <div className="w-full">

        <div className="flex flex-col gap-1">

          {steps.map((step, index) => (

            <div key={step.id} style={{ animation: `fade-up 300ms var(--ease-glide) ${Math.min(index, 8) * 45}ms both` }}>

              <StepRow step={step} open={isOpen(step)} onToggle={() => onToggle(step)} />

            </div>

          ))}

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

      </div>

    );

  }

}

function TaskBubble({ text }: { text: string }) {

  return (

    <div className="flex justify-end pl-12">

      <div className="max-w-[min(100%,34rem)] rounded-window bg-field px-3.5 py-2 text-[14.5px] leading-[1.5] whitespace-pre-wrap text-ink animate-fade-up">

        {text}

      </div>

    </div>

  );

}

function Verdict({ tone, icon, children }: { tone: "green" | "red"; icon: ReactNode; children: ReactNode }) {

  return (

    <div className="flex items-start gap-3 animate-fade-up">

      <span className={cn( "mt-px flex size-6 shrink-0 items-center justify-center rounded-full text-white", tone === "green" ? "bg-green" : "bg-red", )} >

        {icon}

      </span>

      <div className="min-w-0 flex-1 pt-0.5">{children}</div>

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

}

/** Rows collapse into blocks: contiguous steps become one run, everything else stands alone. */
type Block = { key: string; kind: "run"; steps: Step[] } | { key: string; kind: "entry"; entry: Exclude<Entry, Step> };

function toBlocks(entries: Entry[]): Block[] {

  const blocks: Block[] = [];

  for (const entry of entries) {

    if (entry.kind !== "step") {

      blocks.push({ key: entry.id, kind: "entry", entry });
      continue;

    }

    const last = blocks[blocks.length - 1];

    if (last?.kind === "run") {

      last.steps.push(entry);
      continue;

    }

    blocks.push({ key: `run-${entry.id}`, kind: "run", steps: [entry] });

  }

  return blocks;

}

export function Transcript({ entries, running, empty, usage, isOpen, onToggle }: TranscriptProps) {

  const blocks = toBlocks(entries);

  // between steps nothing is streaming and no row is pending, so the transcript would look idle
  const busy = entries.some((entry) => entry.kind === "step" && (entry.streaming || entry.output === null));

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

            {blocks.map((block) => (

              <MessageScrollerItem key={block.key} messageId={block.key} scrollAnchor={block.kind === "entry" && block.entry.kind === "task"} >

                {block.kind === "run" ? (

                  <Run steps={block.steps} finished={!running} isOpen={isOpen} onToggle={onToggle} />

                ) : block.entry.kind === "task" ? (

                  <TaskBubble text={block.entry.text} />

                ) : block.entry.kind === "done" ? (

                  <Verdict tone="green" icon={<CheckIcon className="size-3.5" strokeWidth={3.5} />}>

                    <Md className="text-[14px] text-ink">{cleanSummary(block.entry.text)}</Md>

                  </Verdict>

                ) : (

                  <Verdict tone="red" icon={<TriangleAlertIcon className="size-3.5" strokeWidth={2.5} />}>

                    <p className="text-[14px] leading-[1.5] text-ink">{block.entry.text}</p>

                  </Verdict>

                )}

              </MessageScrollerItem>

            ))}

            {running && !busy ? (

              <MessageScrollerItem messageId="working">

                <Working />

              </MessageScrollerItem>

            ) : null}

          </MessageScrollerContent>

        </MessageScrollerViewport>

        <MessageScrollerButton className="left-1/2" />

      </MessageScroller>

    </MessageScrollerProvider>

  );

}
