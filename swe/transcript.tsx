import { Component } from "react";
import { CheckIcon, ChevronRightIcon, TriangleAlertIcon, XIcon } from "lucide-react";

import { Bubble, BubbleContent } from "@/comps/ui/bubble";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/comps/ui/collapsible";
import { Marker, MarkerContent, MarkerIcon } from "@/comps/ui/marker";
import { Message, MessageContent, MessageGroup } from "@/comps/ui/message";
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from "@/comps/ui/message-scroller";
import { Spinner } from "@/comps/ui/spinner";

import { cn } from "@/lib/utils";

import { Code } from "./code";
import { Md } from "./md";
import { cleanSummary, parseReply, type ParsedReply } from "./parse";

export { cleanSummary, parseReply };
export type { ParsedReply };

/** One turn of the loop. */
export interface Step {

  id: string;
  kind: "step";

  /** Machine-parsed short label from `desc: ...` (shown in the row). */
  desc: string;

  /** Non-desc prose before the fence (optional Thinking expand). */
  thinking: string;

  /** Wall-clock or estimated ms spent drafting (for "Thought for Ns"). */
  thoughtMs?: number | null;

  command: string | null;

  output: string | null;
  exitCode: number | null;

  streaming: boolean;

}

/** Prefer measured ms; otherwise rough gen-time from thinking length (~50 chars/s). */
export function thoughtSeconds(step: Pick<Step, "thinking" | "thoughtMs" | "streaming">): number | null {

  const text = step.thinking.trim();

  if (!text) {

    return null;

  }

  if (step.streaming) {

    return null;

  }

  if (step.thoughtMs != null && step.thoughtMs > 0) {

    return Math.max(1, Math.round(step.thoughtMs / 1000));

  }

  return Math.max(1, Math.round(text.length / 50));

}

export type Entry =
  | Step
  | { id: string; kind: "task"; text: string }
  | { id: string; kind: "done"; text: string }
  | { id: string; kind: "error"; text: string };

/** @deprecated use parseReply — kept for renderer import sites */
export const splitReply = parseReply;

/** Row title: classified desc only. */
export function stepLabel(step: Pick<Step, "desc" | "streaming" | "command">): string {

  const desc = step.desc.replace(/\s+/g, " ").trim();

  if (desc) {

    return desc;

  }

  if (step.streaming) {

    return "Working...";

  }

  return step.command ? "Ran a command" : "Working...";

}

/** The step being streamed; the id is stable so React keeps the nodes as the text grows. */
export function streamStep(stream: string): Step {

  const { desc, thinking, command } = parseReply(stream);

  // as soon as any tokens arrive, surface a tool row (desc may still be filling in)
  return {

    id: "stream",
    kind: "step",

    desc: desc || (stream.trim() ? "Working…" : ""),
    thinking,
    command,

    output: null,
    exitCode: null,

    streaming: true,

  };

}

function StatusBadge({ pending, failed }: { pending: boolean; failed: boolean }) {

  if (pending) {

    return (

      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">

        <Spinner className="size-3" />
        Working

      </span>

    );

  }

  if (failed) {

    return (

      <span className="flex shrink-0 items-center gap-1 text-xs text-destructive">

        <XIcon className="size-3" />
        Failed

      </span>

    );

  }

  return (

    <span className="flex shrink-0 items-center gap-1 text-xs text-[oklch(0.62_0.14_155)]">

      <CheckIcon className="size-3" />
      Succeeded

    </span>

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
 * Tool step card. Main expand is chevron+label only; thinking is a separate toggle.
*/
class StepRow extends Component<StepRowProps, StepRowState> {

  state: StepRowState = { thinkOpen: false };

  private toggleThink = (event: React.MouseEvent) => {

    event.preventDefault();
    event.stopPropagation();
    this.setState((prev) => ({ thinkOpen: !prev.thinkOpen }));

  };

  render() {

    const { step, open, onToggle } = this.props;
    const { thinkOpen } = this.state;
    const label = stepLabel(step);
    const empty = !step.desc && !step.thinking && step.command == null;
    const thinking = step.thinking.trim();

    // empty stream — waiting for first tokens
    if (step.streaming && empty) {

      return (

        <div className="flex items-center gap-2 px-1 py-1 text-sm text-muted-foreground">

          <Spinner className="size-3.5" />
          <span className="shimmer">Thinking...</span>

        </div>

      );

    }

    const failed = step.exitCode !== null && step.exitCode !== 0;
    const pending = step.output === null;
    const hasBody = step.command != null && step.command.length > 0;
    // protocol-miss prose (no bash) still stays inside a card — never free-float in the transcript
    const proseOnly = !step.streaming && !hasBody;

    return (

      <Collapsible open={open} onOpenChange={onToggle} className="w-full">

        <div className="w-full overflow-hidden rounded-xl border border-border/70 bg-card/40">

          <div className="flex min-h-8 items-center gap-1 px-1.5 py-1">

            {/* only the left control toggles the command/output body */}
            <CollapsibleTrigger
              className={cn(

                "group/toggle flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm transition-colors",
                "hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40",

              )}
            >

              <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/toggle:rotate-90" />

              <div className="min-w-0 flex-1 overflow-hidden">

                <Md inline className="block w-full truncate">{label}</Md>

              </div>

            </CollapsibleTrigger>

            {thinking ? (

              <button
                type="button"
                onClick={this.toggleThink}
                aria-expanded={thinkOpen}
                className={cn(

                  "flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground transition-colors",
                  "hover:bg-muted/70 hover:text-foreground",
                  thinkOpen && "bg-muted/60 text-foreground",

                )}
              >

                <ChevronRightIcon className={cn("size-3 transition-transform", thinkOpen && "rotate-90")} />
                {(() => {

                  const secs = thoughtSeconds(step);

                  if (secs == null) {

                    return "Thinking";

                  }

                  return `Thought for ${secs}s`;

                })()}

              </button>

            ) : null}

            {!proseOnly ? (

              <div className="shrink-0 pr-1">

                <StatusBadge pending={pending} failed={failed} />

              </div>

            ) : null}

          </div>

          {thinkOpen && thinking ? (

            <div className="border-t border-border/50 bg-muted/15 px-3 py-2">

              <div className="max-h-36 overflow-y-auto text-xs leading-relaxed text-muted-foreground">

                <Md className="text-xs text-muted-foreground">{thinking}</Md>

              </div>

            </div>

          ) : null}

          <CollapsibleContent>

            <div className="border-t border-border/60">

              {proseOnly ? (

                <div className="max-w-none overflow-hidden px-3 py-2.5 text-sm">

                  <Md>{[step.desc, step.thinking].filter(Boolean).join("\n\n") || label}</Md>

                </div>

              ) : null}

              {hasBody ? (

                <div className="w-full overflow-x-auto bg-muted/35 px-3 py-3">

                  <Code code={step.command!} streaming={step.streaming && pending} />

                </div>

              ) : step.streaming ? (

                <div className="px-3 py-2 font-mono text-xs text-muted-foreground">...</div>

              ) : null}

              {step.output !== null && (

                <div className="border-t border-border/50 bg-background/30 px-3 py-2.5">

                  <pre className="max-h-56 overflow-y-auto font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">

                    {step.output.trim() || "<no output>"}

                  </pre>

                </div>

              )}

            </div>

          </CollapsibleContent>

        </div>

      </Collapsible>

    );

  }

}

function Row({ entry, open, onToggle }: { entry: Entry; open: boolean; onToggle: () => void }) {

  if (entry.kind === "task") {

    return (

      <Message align="end" className="mb-3">

        <MessageContent>

          <Bubble className="max-w-[min(100%,36rem)]">

            <BubbleContent className="whitespace-pre-wrap">{entry.text}</BubbleContent>

          </Bubble>

        </MessageContent>

      </Message>

    );

  }

  if (entry.kind === "done") {

    return (

      <Marker className="items-start pt-2 text-[oklch(0.75_0.15_155)]">

        <MarkerIcon className="mt-0.5">

          <CheckIcon />

        </MarkerIcon>

        <MarkerContent>

          <Md className="text-[oklch(0.75_0.15_155)]">{cleanSummary(entry.text)}</Md>

        </MarkerContent>

      </Marker>

    );

  }

  if (entry.kind === "error") {

    return (

      <Marker className="items-start text-destructive">

        <MarkerIcon className="mt-0.5">

          <TriangleAlertIcon />

        </MarkerIcon>

        <MarkerContent>{entry.text}</MarkerContent>

      </Marker>

    );

  }

  return <StepRow step={entry} open={open} onToggle={onToggle} />;

}

interface TranscriptProps {

  entries: Entry[];

  empty: string;

  isOpen: (entry: Entry) => boolean;
  onToggle: (entry: Entry) => void;

}

export function Transcript({ entries, empty, isOpen, onToggle }: TranscriptProps) {

  return (

    <MessageScrollerProvider autoScroll defaultScrollPosition="end">

      <MessageScroller className="flex-1">

        <MessageScrollerViewport className="px-4">

          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-3.5 py-6">

            {!entries.length && (

              <Marker className="justify-center pt-16">

                <MarkerContent>{empty}</MarkerContent>

              </Marker>

            )}

            {entries.map((entry, index) => {

              const prev = entries[index - 1];
              const afterTask = prev?.kind === "task" && entry.kind === "step";

              return (

                <MessageScrollerItem key={entry.id} messageId={entry.id} scrollAnchor={entry.kind === "task"}>

                  <MessageGroup className={cn(entry.kind === "step" && "gap-0", afterTask && "mt-2")}>

                    <Row entry={entry} open={isOpen(entry)} onToggle={() => onToggle(entry)} />

                  </MessageGroup>

                </MessageScrollerItem>

              );

            })}

          </MessageScrollerContent>

        </MessageScrollerViewport>

        <MessageScrollerButton className="left-1/2" />

      </MessageScroller>

    </MessageScrollerProvider>

  );

}
