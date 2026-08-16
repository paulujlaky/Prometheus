import { Component, type ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger, } from "@/UI/Dropdown";

import { displayName, groupAssistants, modelLabel } from "@/Utils/Models";
import { cn } from "@/Utils/Class";

import type { AssistantSummary } from "../../../sdk/types";

interface ModelPickerProps {

  models: AssistantSummary[];
  value: string | null;

  onChange: (id: string | null) => void;

  disabled?: boolean;

  /** Prefs: allow falling back to the account default. */
  allowNone?: boolean;
  noneLabel?: string;

  trigger?: "ghost" | "field";
  align?: "start" | "end";

}

export class ModelPicker extends Component<ModelPickerProps> {

  private label(): string {

    const { models, value, allowNone, noneLabel } = this.props;

    if (!value) {

      return noneLabel ?? (allowNone ? "Use account preference" : "Model");

    }

    const selected = models.find((assistant) => assistant.id === value);

    return selected ? modelLabel(selected) : "Unavailable model";

  }

  private groups() {

    return groupAssistants(this.props.models);

  }

  render(): ReactNode {

    const { value, onChange, disabled, allowNone, noneLabel, trigger = "ghost", align = "start" } = this.props;
    const groups = this.groups();
    const selected = value ? this.props.models.find((assistant) => assistant.id === value) : null;

    return (

      <DropdownMenu>

        <DropdownMenuTrigger className={trigger === "ghost" ? "text-ink-2 hover:text-ink -ml-1" : undefined}

          asChild

          style={trigger === "ghost" ? { background: "none" } : undefined}

        >

          <button className={cn(

            "flex min-w-0 items-center gap-2 text-left disabled:opacity-50",

            trigger === "ghost" && "h-8 px-2.5 text-[13px]",
            trigger === "field" && "h-9 w-full rounded-chip border border-line bg-field px-2.5 text-[13.5px] text-ink transition-colors hover:border-line-strong",

          )}

            type="button"
            disabled={disabled || groups.length === 0}

          >

            <span className={cn("min-w-0 flex-1 truncate", trigger === "ghost" ? "max-w-56" : !selected && "text-ink-3")}>

              {this.label()}

            </span>

            <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />

          </button>

        </DropdownMenuTrigger>

        <DropdownMenuContent align={align} className={cn("text-sm", trigger === "field" ? "w-64" : "w-56")}>

          {allowNone ? (

            <>

              <DropdownMenuRadioGroup value={value ?? ""} onValueChange={(next) => onChange(next || null)}>

                <DropdownMenuRadioItem value="">{noneLabel ?? "Use account preference"}</DropdownMenuRadioItem>

              </DropdownMenuRadioGroup>

              <DropdownMenuSeparator />

            </>

          ) : null}

          <DropdownMenuLabel className="text-sm">Provider</DropdownMenuLabel>

          {trigger === "ghost" ? <DropdownMenuSeparator /> : null}

          {groups.map((group) => (

            <DropdownMenuSub key={group.provider}>

              <DropdownMenuSubTrigger>{group.provider}</DropdownMenuSubTrigger>

              <DropdownMenuSubContent className="w-72 text-sm">

                {group.chat.length > 0 ? (

                  <>

                    <DropdownMenuLabel className="text-sm">Chat-Native</DropdownMenuLabel>

                    <DropdownMenuRadioGroup value={value ?? undefined} onValueChange={(id) => onChange(id)}>

                      {group.chat.map((assistant) => (

                        <DropdownMenuRadioItem key={assistant.id} value={assistant.id}>

                          {displayName(assistant.name)}

                        </DropdownMenuRadioItem>

                      ))}

                    </DropdownMenuRadioGroup>

                  </>

                ) : null}

                {group.chat.length > 0 && group.agent.length > 0 ? <DropdownMenuSeparator /> : null}

                {group.agent.length > 0 ? (

                  <>

                    <DropdownMenuLabel className="text-sm">{trigger === "field" ? "Agent" : "Agent-Native"}</DropdownMenuLabel>

                    <DropdownMenuRadioGroup value={value ?? undefined} onValueChange={(id) => onChange(id)}>

                      {group.agent.map((assistant) => (

                        <DropdownMenuRadioItem key={assistant.id} value={assistant.id}>

                          {displayName(assistant.name)}

                        </DropdownMenuRadioItem>

                      ))}

                    </DropdownMenuRadioGroup>

                  </>

                ) : null}

              </DropdownMenuSubContent>

            </DropdownMenuSub>

          ))}

        </DropdownMenuContent>

      </DropdownMenu>

    );

  }

}
