import { Component, createRef, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUpIcon, ChevronDownIcon, SquareIcon } from "lucide-react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger, } from "@/comps/ui/dropdown";

import { displayName, groupAssistants, providerOf } from "@/lib/models";
import { formatTokens } from "@/lib/tokens";
import { cn } from "@/lib/utils";

import type { AssistantSummary } from "../../sdk/types";

interface ComposerProps {

  assistants: AssistantSummary[];
  assistantId: string | null;

  busy: boolean;
  disabled: boolean;

  placeholder: string;
  disabledPlaceholder: string;

  /** 0–1 estimated context fill; drawn as a ring around Stop while busy. */
  contextRatio?: number;
  contextUsed?: number;
  contextLimit?: number;

  onModelChange: (id: string) => void;
  onSend: (task: string) => void;
  onStop: () => void;

}

interface ComposerState {

  text: string;

}

const MAX_HEIGHT = 190;

/** Circular progress around the Stop control — track is always visible; arc fills with context use. */
function ContextRing({ ratio, used, limit, onStop }: { ratio: number; used?: number; limit?: number; onStop: () => void }) {

  const size = 38;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;

  const pct = Math.min(1, Math.max(0, ratio));
  const hot = pct >= 0.85;
  const warm = pct >= 0.6;

  const title = used != null && limit != null ? `Context ~${formatTokens(used)} / ${formatTokens(limit)}` : "Context usage";

  return (

    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }} title={title}>

      <svg className="pointer-events-none absolute inset-0 -rotate-90" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>

        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line-strong)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} stroke={hot ? "var(--red)" : warm ? "var(--orange)" : "var(--ink-2)"} className="transition-[stroke-dashoffset] duration-300" />

      </svg>

      <button type="button" aria-label="Stop" onClick={onStop} className="relative flex size-8 items-center justify-center rounded-full text-ink transition-[transform,background-color] duration-200 hover:bg-hover active:scale-[0.96]" >

        <SquareIcon className="size-3.5 fill-current stroke-none" />

      </button>

    </div>

  );

}

export class Composer extends Component<ComposerProps, ComposerState> {

  state: ComposerState = { text: "" };

  private input = createRef<HTMLTextAreaElement>();

  componentDidUpdate(_prev: ComposerProps, prev: ComposerState) {

    if (prev.text !== this.state.text) {

      this.resize();

    }

  }

  /** Grow with the draft up to a cap, then scroll — a fixed rows= wastes the panel. */
  private resize() {

    const node = this.input.current;

    if (!node) {

      return;

    }

    node.style.height = "0px";

    const content = node.scrollHeight;

    node.style.height = `${Math.min(Math.max(content, 28), MAX_HEIGHT)}px`;
    node.style.overflowY = content > MAX_HEIGHT ? "auto" : "hidden";

  }

  private submit = (event?: FormEvent) => {

    event?.preventDefault();

    const task = this.state.text.trim();

    if (!task || this.props.disabled || this.props.busy) {

      return;

    }

    this.props.onSend(task);
    this.setState({ text: "" });

  };

  private onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {

    if (event.key === "Enter" && !event.shiftKey) {

      event.preventDefault();
      this.submit();

    }

  };

  render() {

    const { assistants, assistantId, busy, disabled, placeholder, disabledPlaceholder, contextRatio = 0, contextUsed, contextLimit, onModelChange, onStop } = this.props;

    const { text } = this.state;

    const model = assistants.find((assistant) => assistant.id === assistantId);
    const groups = groupAssistants(assistants);
    const provider = model ? providerOf(model) : null;

    const locked = disabled || busy;
    const canSend = !locked && text.trim().length > 0;

    return (

      <form className="mx-auto w-full max-w-3xl shrink-0 px-5 pb-5" onSubmit={this.submit}>

        <div role="presentation" onClick={() => this.input.current?.focus()} className="flex cursor-text flex-col gap-2.5 rounded-window border border-line bg-field p-3 shadow-card transition-[border-color] duration-150 focus-within:border-line-strong" >

          <textarea className="min-h-7 w-full resize-none bg-transparent px-1 text-[14.5px] leading-[1.5] text-ink outline-none placeholder:text-ink-3 disabled:opacity-60"

            ref={this.input}

            value={text}
            disabled={locked}

            placeholder={disabled ? disabledPlaceholder : placeholder}

            rows={1}

            onChange={(event) => this.setState({ text: event.target.value })}
            onKeyDown={this.onKeyDown}

          />

          <div className="flex items-center justify-between gap-2">

            <DropdownMenu>

              <DropdownMenuTrigger asChild>

                <button type="button" disabled={disabled || groups.length === 0} className="flex h-8 min-w-0 items-center gap-2 rounded-control px-2.5 text-[13px] text-ink-2 outline-none transition-colors duration-100 hover:bg-hover hover:text-ink focus:outline-none focus-visible:outline-none disabled:opacity-50" >

                  <span className="max-w-56 truncate">

                    {model ? provider ? `${provider} · ${displayName(model.name)}` : displayName(model.name) : "Model"}

                  </span>

                  <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />

                </button>

              </DropdownMenuTrigger>

              <DropdownMenuContent align="start" className="w-56 text-sm">

                <DropdownMenuLabel className="text-sm">Provider</DropdownMenuLabel>

                <DropdownMenuSeparator />

                {groups.map((group) => (

                  <DropdownMenuSub key={group.provider}>

                    <DropdownMenuSubTrigger>{group.provider}</DropdownMenuSubTrigger>

                    <DropdownMenuSubContent className="w-72 text-sm">

                      <DropdownMenuLabel className="text-sm">{group.provider}</DropdownMenuLabel>

                      <DropdownMenuSeparator />

                      <DropdownMenuRadioGroup value={assistantId ?? undefined} onValueChange={onModelChange}>

                        {group.models.map((assistant) => (

                          <DropdownMenuRadioItem key={assistant.id} value={assistant.id}>

                            {displayName(assistant.name)}

                          </DropdownMenuRadioItem>

                        ))}

                      </DropdownMenuRadioGroup>

                    </DropdownMenuSubContent>

                  </DropdownMenuSub>

                ))}

              </DropdownMenuContent>

            </DropdownMenu>

            {busy ? (

              <ContextRing ratio={contextRatio} used={contextUsed} limit={contextLimit} onStop={onStop} />

            ) : (

              <button type="submit" aria-label="Send" disabled={!canSend}

                className={cn(
                  "flex size-8 items-center justify-center rounded-control transition-[background-color,color,transform] duration-200",
                  canSend ? "bg-ink text-page active:scale-[0.96]" : "bg-line-strong text-ink-3",
                )}

              >

                <ArrowUpIcon className="size-4.5" strokeWidth={2.4} />

              </button>

            )}

          </div>

        </div>

      </form>

    );

  }

}
