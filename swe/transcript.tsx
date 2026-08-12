import { Component, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, FilePlus2Icon, FileTextIcon, MessageSquareIcon, PencilLineIcon, SearchIcon, SparklesIcon, TerminalIcon, Trash2Icon, TriangleAlertIcon, WrenchIcon } from "lucide-react";

import { UsageHeatmap, type UsageFile } from "@/comps/heatmap";
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from "@/comps/ui/scroller";

import { cn } from "@/lib/utils";

import { Code, FileWriteView } from "./code";
import { Md } from "./md";
import { cleanSummary, fileEdits, inferTool, isDoneStep, parseReply, parseWrites, runCommandOf, summarizeCall, type FileEdit, type ParsedReply, type Tool } from "./parse";

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
  | { id: string; kind: "task"; text: string; attachments?: string[] }
  | { id: string; kind: "echo"; text: string }
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
export function stepStatus(
  step: Pick<Step, "streaming" | "output" | "exitCode">,
  opts: { pending?: boolean } = {},
): StepStatus {

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
 * The step being streamed; `id` must stay stable through settle so React does not remount
 * (and re-animate) the row when the live entry becomes a real one.
 * `thoughtMs` is threaded in live so the duration does not jump when the step settles.
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

/** Stable, quiet placeholder while the model has not labeled a step yet. Not a dropdown. */
export function Working() {

  return (

    <div className="flex h-8 w-full min-w-0 items-center" aria-busy="true" aria-label="Working">

      <span className="shimmer-label text-[14px] font-medium">Working</span>

    </div>

  );

}

const TOOL_ICONS: Record<Tool, typeof FileTextIcon> = {

  read: FileTextIcon,
  search: SearchIcon,
  write: FilePlus2Icon,
  edit: PencilLineIcon,
  delete: Trash2Icon,
  run: TerminalIcon,
  echo: MessageSquareIcon,
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

  /** False once a later call exists (or the run ended) — kills a stuck shimmer. */
  pending?: boolean;

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

    const { step, open, onToggle, pending = true } = this.props;
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

    const writes = step.command ? parseWrites(step.command) : [];

    let linesAdded = 0;
    let linesRemoved = 0;

    for (const write of writes) {

      linesAdded += write.added;
      linesRemoved += write.removed;

    }

    const hasLineCounts = linesAdded > 0 || linesRemoved > 0;
    const kind = step.tool ?? inferTool(step.command);
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

    const trailing = hasLineCounts ? (

      <span className="flex shrink-0 items-center gap-1.5 font-mono text-[12px] tabular-nums" title={failed ? `Exit code ${step.exitCode}` : undefined}>

        {linesAdded > 0 ? <span className="text-green">+{linesAdded}</span> : null}
        {linesRemoved > 0 ? <span className="text-red">−{linesRemoved}</span> : null}

      </span>

    ) : working || status === "unknown" ? null : (

      <span className={cn("shrink-0 text-[12.5px] animate-fade-in", failed ? "text-red/85" : "text-green/85")} title={failed ? `Exit code ${step.exitCode}` : undefined} >

        {failed ? "Failed" : "Succeeded"}

      </span>

    );

    return (

      <>

        {showThinking ? (

          <ToolRow

            icon={SparklesIcon}
            working={thinkLive}

            label={ thinkLive ? <span className="shimmer-label min-w-0 truncate text-[14px] font-medium">Thinking</span> : <span className="min-w-0 truncate text-[14px] font-medium text-ink-2">Thought for {seconds ?? 1}s</span> }

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

interface RunProps {

  steps: Step[];

  /** The whole session is done — mid-run the summary would flash in between every step. */
  finished: boolean;

  /** Between steps: show Working inside this run (gap-1) instead of as a separate block. */
  showWorking?: boolean;

  isOpen: (entry: Entry) => boolean;
  onToggle: (entry: Entry) => void;

}

const EDIT_CHIPS = 4;

/** Contiguous tool calls as a flat list, with what they changed summarised underneath. */
class Run extends Component<RunProps, { allEdits: boolean }> {

  state = { allEdits: false };

  render() {

    const { steps, finished, showWorking, isOpen, onToggle } = this.props;
    const { allEdits } = this.state;

    const visible = steps.filter((step) => !isDoneStep(step));
    const edits = finished ? editsOf(visible) : [];
    const shown = allEdits ? edits : edits.slice(0, EDIT_CHIPS);

    return (

      <div className="w-full">

        <div className="flex flex-col gap-1">

          {visible.map((step, index) => (

            <div key={step.id} style={{ animation: `fade-up 300ms var(--ease-glide) ${Math.min(index, 8) * 45}ms both` }}>

              <StepRow

                step={step}
                open={isOpen(step)}
                onToggle={() => onToggle(step)}

                pending={!finished && index === visible.length - 1 && !showWorking}

              />

            </div>

          ))}

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

      </div>

    );

  }

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

    if (entry.kind === "step" && isDoneStep(entry)) {

      continue;

    }

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
  const busy = entries.some((entry) => entry.kind === "step" && !isDoneStep(entry) && (entry.streaming || entry.output === null));

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
              // keep Working inside the run's gap-1 so it sits closer than a block-level gap-6
              const workInRun = running && !busy && last && block.kind === "run";

              return (

                <MessageScrollerItem key={block.key} messageId={block.key}>

                  {block.kind === "run" ? (

                    <Run steps={block.steps} finished={!running} showWorking={workInRun} isOpen={isOpen} onToggle={onToggle} />

                  ) : block.entry.kind === "task" ? (

                    <TaskBubble text={block.entry.text} attachments={block.entry.attachments} />

                  ) : block.entry.kind === "echo" ? (

                    <div className="max-w-[42rem] animate-fade-up"><Md className="text-[14px] text-ink">{block.entry.text}</Md></div>

                  ) : block.entry.kind === "done" ? (

                    <Verdict tone="green" icon={<CheckIcon className="size-3.5" strokeWidth={3.5} />}>

                      <Md className="text-[14px] text-ink">{cleanSummary(block.entry.text)}</Md>

                    </Verdict>

                  ) : (

                    <Verdict tone="red" icon={<TriangleAlertIcon className="size-3.5" strokeWidth={2.5} />}>

                      <p className="text-[14px] leading-normal text-ink">{block.entry.text}</p>

                    </Verdict>

                  )}

                </MessageScrollerItem>

              );

            })}

            {running && !busy && (blocks.length === 0 || blocks[blocks.length - 1]?.kind !== "run") ? (

              <MessageScrollerItem messageId="working">

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
