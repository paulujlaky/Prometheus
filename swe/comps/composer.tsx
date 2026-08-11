import { Component, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDownIcon, SendIcon, SquareIcon } from "lucide-react";

import { Button } from "@/comps/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger, } from "@/comps/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea, } from "@/comps/ui/input-group";

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

/** Circular progress around the Stop control — track is always visible; arc fills with context use. */
function ContextRing({
  ratio,
  used,
  limit,
  children,
}: {
  ratio: number;
  used?: number;
  limit?: number;
  children: ReactNode;
}) {

  const size = 40;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.min(1, Math.max(0, ratio));
  const offset = c * (1 - pct);
  const hot = pct >= 0.85;
  const warm = pct >= 0.6;

  const title =
    used != null && limit != null
      ? `Context ~${formatTokens(used)} / ${formatTokens(limit)} (local estimate)`
      : "Context usage (local estimate)";

  return (

    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
      title={title}
    >

      <svg
        className="pointer-events-none absolute inset-0 -rotate-90"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden
      >

        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          className="stroke-border"
          strokeWidth={stroke}
        />

        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          className={cn(
            "transition-[stroke-dashoffset] duration-300",
            hot ? "stroke-destructive" : warm ? "stroke-amber-500" : "stroke-primary",
          )}
        />

      </svg>

      <div className="relative z-[1] flex items-center justify-center">

        {children}

      </div>

    </div>

  );

}

export class Composer extends Component<ComposerProps, ComposerState> {

  state: ComposerState = { text: "" };

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

    const {
      assistants,
      assistantId,
      busy,
      disabled,
      placeholder,
      disabledPlaceholder,
      contextRatio = 0,
      contextUsed,
      contextLimit,
      onModelChange,
      onStop,
    } = this.props;

    const { text } = this.state;
    const model = assistants.find((assistant) => assistant.id === assistantId);
    const groups = groupAssistants(assistants);
    const provider = model ? providerOf(model) : null;
    const locked = disabled || busy;
    const canSend = !locked && text.trim().length > 0;

    return (

      <form
        className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4"
        onSubmit={this.submit}
      >

        <InputGroup className="h-auto items-end rounded-2xl">

          <InputGroupTextarea
            value={text}
            disabled={locked}
            placeholder={disabled ? disabledPlaceholder : placeholder}
            rows={2}
            className="min-h-12 px-3 py-3 text-sm md:text-sm"
            onChange={(event) => this.setState({ text: event.target.value })}
            onKeyDown={this.onKeyDown}
          />

          <InputGroupAddon align="block-end" className="justify-between gap-2">

            <DropdownMenu>

              <DropdownMenuTrigger asChild>

                <Button
                  type="button"
                  variant="secondary"
                  size="default"
                  disabled={disabled || groups.length === 0}
                  className="gap-1.5 text-sm font-normal text-foreground shadow-none bg-none focus-visible:ring-0 border-none"
                >

                  <span className="max-w-56 truncate">

                    {model
                      ? provider
                        ? `${provider} · ${displayName(model.name)}`
                        : displayName(model.name)
                      : "Model"}

                  </span>
                  <ChevronDownIcon className="size-4 opacity-50" />

                </Button>

              </DropdownMenuTrigger>

              <DropdownMenuContent align="start" className="w-56 text-sm">

                <DropdownMenuLabel className="text-sm">Provider</DropdownMenuLabel>

                <DropdownMenuSeparator />

                {groups.map((group) => (

                  <DropdownMenuSub key={group.provider}>

                    <DropdownMenuSubTrigger>
                      {group.provider}
                    </DropdownMenuSubTrigger>

                    <DropdownMenuSubContent className="w-72 text-sm">

                      <DropdownMenuLabel className="text-sm">{group.provider}</DropdownMenuLabel>

                      <DropdownMenuSeparator />

                      <DropdownMenuRadioGroup
                        value={assistantId ?? undefined}
                        onValueChange={onModelChange}
                      >

                        {group.models.map((assistant) => (

                          <DropdownMenuRadioItem
                            key={assistant.id}
                            value={assistant.id}
                          >

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

              <ContextRing ratio={contextRatio} used={contextUsed} limit={contextLimit}>

                <InputGroupButton
                  type="button"
                  variant="secondary"
                  size="icon-sm"
                  className="size-8 rounded-full"
                  onClick={onStop}
                  aria-label="Stop"
                >

                  <SquareIcon className="size-3 fill-current" />

                </InputGroupButton>

              </ContextRing>

            ) : (

              <InputGroupButton
                type="submit"
                variant="default"
                size="sm"
                disabled={!canSend}
                className="gap-1.5"
              >

                <SendIcon className="size-3.5" />
                Send

              </InputGroupButton>

            )}

          </InputGroupAddon>

        </InputGroup>

      </form>

    );

  }

}
