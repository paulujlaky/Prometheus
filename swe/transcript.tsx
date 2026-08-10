import { BotIcon, CheckIcon, ChevronRightIcon, FolderIcon, TerminalIcon, TriangleAlertIcon } from "lucide-react";

import { Avatar, AvatarFallback } from "@/comps/ui/avatar";
import { Bubble, BubbleContent, BubbleGroup } from "@/comps/ui/bubble";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/comps/ui/collapsible";
import { Marker, MarkerContent, MarkerIcon } from "@/comps/ui/marker";
import { Message, MessageAvatar, MessageContent, MessageGroup, MessageHeader } from "@/comps/ui/message";
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from "@/comps/ui/message-scroller";
import { Spinner } from "@/comps/ui/spinner";

import { Code } from "./code";

/** One turn of the loop: what the model said, what it ran, and what came back. */
export interface Step {

  id: string;
  kind: "step";

  prose: string;

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

const FENCE = /```(?:bash|sh|shell)?\r?\n/;

// a fence arrives a character at a time; without this the opening ``` flashes in the prose bubble before it is recognised
const PARTIAL_FENCE = /(^|\n)[ \t]*`{1,3}[a-zA-Z]*$/;

/**
 * Splits a reply into the prose before the fence and the command inside it, mid-stream as well as at the end,
 * so a command is rendered as a command from its first character instead of arriving as prose and re-homing.
 */
export function splitReply(text: string): { prose: string; command: string | null } {

  const fence = FENCE.exec(text);

  if (!fence) {

    return { prose: text.replace(PARTIAL_FENCE, "").trim(), command: null };

  }

  const body = text.slice(fence.index + fence[0].length);
  const close = body.indexOf("```");

  return {

    prose: text.slice(0, fence.index).trim(),
    command: (close === -1 ? body : body.slice(0, close)).trim(),

  };

}

/** The step being streamed; the id is stable so React keeps the nodes as the text grows. */
export function streamStep(stream: string): Step {

  const { prose, command } = splitReply(stream);

  return {

    id: "stream",
    kind: "step",

    prose,
    command,

    output: null,
    exitCode: null,

    streaming: true,

  };

}

function label(step: Step): string {

  if (step.prose) {

    return step.prose;

  }

  const first = (step.command ?? "").split("\n")[0];

  return first || "Working…";

}

function StepRow({ step, modelName, open, onToggle }: { step: Step; modelName?: string; open: boolean; onToggle: () => void }) {

  if (step.streaming && !step.prose && !step.command) {

    return (

      <Message>

        <Marker role="status">

          <MarkerIcon>

            <Spinner />

          </MarkerIcon>

          <MarkerContent className="shimmer">Thinking…</MarkerContent>

        </Marker>

      </Message>

    );

  }

  // nothing was run, so there is nothing to fold away
  if (!step.command) {

    return (

      <Message>

        <MessageAvatar>

          <Avatar className="size-7">

            <AvatarFallback className="bg-secondary text-muted-foreground">

              <BotIcon className="size-3.5" />

            </AvatarFallback>

          </Avatar>

        </MessageAvatar>

        <MessageContent>

          <MessageHeader>{modelName ?? "Assistant"}</MessageHeader>

          <BubbleGroup>

            <Bubble variant="ghost">

              <BubbleContent className="whitespace-pre-wrap">{step.prose}</BubbleContent>

            </Bubble>

          </BubbleGroup>

        </MessageContent>

      </Message>

    );

  }

  const failed = step.exitCode !== null && step.exitCode !== 0;

  return (

    <Message>

      <MessageAvatar>

        <Avatar className="size-7">

          <AvatarFallback className={failed ? "bg-destructive/15 text-destructive" : "bg-primary/15 text-primary"}>

            <TerminalIcon className="size-3.5" />

          </AvatarFallback>

        </Avatar>

      </MessageAvatar>

      <MessageContent>

        <Collapsible open={open} onOpenChange={onToggle}>

          <CollapsibleTrigger className="group/toggle flex w-full items-center gap-1.5 rounded-lg px-1 py-0.5 text-left text-sm hover:bg-accent/50">

            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/toggle:rotate-90" />

            <span className="min-w-0 flex-1 truncate">{label(step)}</span>

            {step.output === null ? (

              step.streaming ? null : <Spinner className="size-3 shrink-0 text-muted-foreground" />

            ) : (

              <span className={failed ? "shrink-0 font-mono text-[11px] text-destructive" : "shrink-0 font-mono text-[11px] text-muted-foreground"}>

                exit {step.exitCode}

              </span>

            )}

          </CollapsibleTrigger>

          <CollapsibleContent className="mt-1.5 flex flex-col gap-1.5">

            <Bubble variant="tinted">

              <BubbleContent>

                <Code code={step.command} streaming={step.streaming} />

              </BubbleContent>

            </Bubble>

            {step.output !== null && (

              <Bubble variant={failed ? "destructive" : "muted"}>

                <BubbleContent className="max-h-64 overflow-y-auto font-mono text-xs whitespace-pre-wrap text-muted-foreground">

                  {step.output.trim() || "<no output>"}

                </BubbleContent>

              </Bubble>

            )}

          </CollapsibleContent>

        </Collapsible>

      </MessageContent>

    </Message>

  );

}

function Row({ entry, modelName, open, onToggle }: { entry: Entry; modelName?: string; open: boolean; onToggle: () => void }) {

  if (entry.kind === "task") {

    return (

      <Message align="end">

        <MessageContent>

          <Bubble>

            <BubbleContent className="whitespace-pre-wrap">{entry.text}</BubbleContent>

          </Bubble>

        </MessageContent>

      </Message>

    );

  }

  if (entry.kind === "done") {

    return (

      <Message>

        {/* the separator variant pins content to its natural width, which clips a long summary */}
        <Marker className="items-start text-[oklch(0.75_0.15_155)]">

          <MarkerIcon className="mt-0.5">

            <CheckIcon />

          </MarkerIcon>

          <MarkerContent>{entry.text}</MarkerContent>

        </Marker>

      </Message>

    );

  }

  if (entry.kind === "error") {

    return (

      <Message>

        <Marker className="items-start text-destructive">

          <MarkerIcon className="mt-0.5">

            <TriangleAlertIcon />

          </MarkerIcon>

          <MarkerContent>{entry.text}</MarkerContent>

        </Marker>

      </Message>

    );

  }

  return <StepRow step={entry} modelName={modelName} open={open} onToggle={onToggle} />;

}

interface TranscriptProps {

  entries: Entry[];

  modelName?: string;
  empty: string;

  isOpen: (entry: Entry) => boolean;
  onToggle: (entry: Entry) => void;

}

export function Transcript({ entries, modelName, empty, isOpen, onToggle }: TranscriptProps) {

  return (

    <MessageScrollerProvider autoScroll defaultScrollPosition="end">

      <MessageScroller className="flex-1">

        <MessageScrollerViewport className="px-4">

          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-5 py-6">

            {!entries.length && (

              <Marker className="justify-center pt-16">

                <MarkerIcon>

                  <FolderIcon />

                </MarkerIcon>

                <MarkerContent>{empty}</MarkerContent>

              </Marker>

            )}

            {entries.map((entry) => (

              <MessageScrollerItem key={entry.id} messageId={entry.id} scrollAnchor={entry.kind === "task"}>

                <MessageGroup>

                  <Row entry={entry} modelName={modelName} open={isOpen(entry)} onToggle={() => onToggle(entry)} />

                </MessageGroup>

              </MessageScrollerItem>

            ))}

          </MessageScrollerContent>

        </MessageScrollerViewport>

        <MessageScrollerButton className="left-1/2" />

      </MessageScroller>

    </MessageScrollerProvider>

  );

}
