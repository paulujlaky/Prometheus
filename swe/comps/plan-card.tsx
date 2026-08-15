import { Component, type ChangeEvent } from "react";
import { CheckIcon, ChevronDownIcon, ListTodoIcon, SearchIcon, XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { displayName, groupAssistants, providerOf } from "@/lib/models";

import type { Plan, PlanDecision } from "@/tools/plan";
import type { AssistantSummary } from "../../sdk/types";

interface PlanCardProps {

  plan: Plan;

  assistants: AssistantSummary[];
  assistantId: string | null;

  onBuild: (decision: PlanDecision) => void;
  onDismiss: () => void;

}

interface PlanCardState {

  /** Null until the user opens the picker and chooses — the run's own model builds by default. */
  chosen: string | null;

  picking: boolean;
  query: string;

  note: string;

}

export class PlanCard extends Component<PlanCardProps, PlanCardState> {

  state: PlanCardState = { chosen: null, picking: false, query: "", note: "" };

  private get picked(): string {

    return this.state.chosen ?? this.props.assistantId ?? "";

  }

  private assistantOf(id: string): AssistantSummary | undefined {

    return this.props.assistants.find((assistant) => assistant.id === id);

  }

  private labelOf(id: string): string {

    const assistant = this.assistantOf(id);

    if (!assistant) {

      return "";

    }

    const provider = providerOf(assistant);

    return `${provider ? `${provider} · ` : ""}${displayName(assistant.name)}${assistant.kind === "agent" ? " · Agent" : ""}`;

  }

  private choose = (id: string) => {

    this.setState({ chosen: id, picking: false, query: "" });

  };

  private onQuery = (event: ChangeEvent<HTMLInputElement>) => {

    this.setState({ query: event.target.value });

  };

  private onNote = (event: ChangeEvent<HTMLInputElement>) => {

    this.setState({ note: event.target.value });

  };

  private build = () => {

    const { assistantId } = this.props;

    const picked = this.picked;
    const switched = Boolean(picked) && picked !== assistantId;

    this.props.onBuild({

      build: true,

      assistantId: picked,
      modelLabel: switched ? this.labelOf(picked) : "",

      note: this.state.note.trim(),

      dismissed: false,

    });

  };

  private decline = () => {

    this.props.onBuild({

      build: false,

      assistantId: this.props.assistantId ?? "",
      modelLabel: "",

      note: this.state.note.trim(),

      dismissed: false,

    });

  };

  render() {

    const { plan, assistants, assistantId, onDismiss } = this.props;
    const { picking, query, note } = this.state;

    const picked = this.picked;
    const switched = Boolean(picked) && picked !== assistantId;

    const needle = query.trim().toLowerCase();

    const groups = groupAssistants(assistants)
      .map((group) => ({

        provider: group.provider,
        models: [...group.chat, ...group.agent].filter((assistant) => !needle || displayName(assistant.name).toLowerCase().includes(needle) || group.provider.toLowerCase().includes(needle)),

      }))
      .filter((group) => group.models.length > 0);

    return (

      // a fifteen-step plan used to push the transcript and the composer off screen; the card now
      // owns a ceiling and the steps scroll inside it, so the buttons stay reachable either way
      <div className="flex max-h-[min(62vh,34rem)] flex-col overflow-hidden rounded-card bg-surface shadow-card animate-fade-up">

        <div className="flex shrink-0 items-center gap-2.5 p-3.5">

          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ink text-page">

            <ListTodoIcon className="size-3.5" strokeWidth={2.5} />

          </span>

          <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{plan.title}</span>

          <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-ink-3">
            {plan.steps.length} {plan.steps.length === 1 ? "step" : "steps"}
          </span>

        </div>

        {/* the title stays pinned; the summary scrolls with the steps it introduces */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain border-t border-line bg-inset">

          {plan.summary ? (

            <p className="shrink-0 px-3.5 pt-3 text-[12.5px] leading-[1.6] text-ink-2">{plan.summary}</p>

          ) : null}

          <ol className="flex flex-col gap-2 px-3.5 py-3">

          {plan.steps.map((step, index) => (

            <li key={index} className="flex items-start gap-2.5">

              <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-surface font-mono text-[11px] tabular-nums text-ink-2 shadow-hairline">

                {index + 1}

              </span>

              <span className="flex min-w-0 flex-col gap-0.5">

                <span className="text-[13px] leading-snug text-ink">{step.title}</span>

                {step.detail ? (

                  <span className="text-[12.5px] leading-[1.6] text-ink-3">{step.detail}</span>

                ) : null}

              </span>

            </li>

          ))}

          </ol>

        </div>

        {picking ? (

          <div className="flex shrink-0 flex-col border-t border-line bg-inset">

            <div className="flex items-center gap-2 px-3.5 py-2.5">

              <SearchIcon className="size-3.5 shrink-0 text-ink-3" />

              <input
                type="text"
                autoFocus
                value={query}
                placeholder="Search models..."
                onChange={this.onQuery}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
              />

            </div>

            {/* shorter than it was: with the card capped, the picker and the steps compete for height */}
            <div className="max-h-48 overflow-y-auto overscroll-contain px-2 pb-2">

              {groups.map((group) => (

                <div key={group.provider} className="flex flex-col">

                  <span className="px-1.5 pt-2 pb-1 text-[11.5px] font-medium tracking-wide text-ink-3 uppercase">{group.provider}</span>

                  {group.models.map((assistant) => (

                    <button
                      key={assistant.id}
                      type="button"
                      onClick={() => this.choose(assistant.id)}
                      className={cn( "flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-control px-1.5 py-1 text-left text-[13px] transition-colors duration-100", assistant.id === picked ? "bg-surface text-ink shadow-hairline" : "text-ink-2 hover:bg-hover hover:text-ink", )}
                    >

                      <span className="min-w-0 flex-1 truncate">{displayName(assistant.name)}</span>

                      {assistant.kind === "agent" ? <span className="shrink-0 text-[11.5px] text-ink-3">Agent</span> : null}

                      {assistant.id === picked ? <CheckIcon className="size-3.5 shrink-0" strokeWidth={3} /> : null}

                    </button>

                  ))}

                </div>

              ))}

              {groups.length === 0 ? (

                <p className="px-1.5 py-3 text-[12.5px] text-ink-3">No model matches that.</p>

              ) : null}

            </div>

          </div>

        ) : null}

        <div className="shrink-0 border-t border-line px-3.5 py-3">

          <input
            type="text"
            value={note}
            placeholder="Add a note for the build (optional)"
            onChange={this.onNote}
            className="min-h-9 w-full rounded-control bg-inset px-2.5 py-1.5 text-[13px] text-ink outline-none transition-shadow duration-100 placeholder:text-ink-3 focus:shadow-hairline"
          />

        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-3.5 py-3">

          <button
            type="button"
            onClick={() => this.setState((prev) => ({ picking: !prev.picking, query: "" }))}
            className="mr-auto flex h-9 min-w-0 items-center gap-2 rounded-control px-2.5 text-[13px] text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink"
          >

            <span className="max-w-64 truncate">

              {picked ? `Build with ${this.labelOf(picked) || "this model"}` : "Choose a model"}

            </span>

            <ChevronDownIcon className={cn("size-3.5 shrink-0 opacity-60 transition-transform duration-100", picking && "rotate-180")} />

          </button>

          <button type="button" onClick={onDismiss} className="flex h-9 items-center gap-2 rounded-control px-3 text-[13px] font-medium text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink">

            <XIcon className="size-4" />
            Not now

          </button>

          <button type="button" onClick={this.build} className="flex h-9 items-center gap-2 rounded-control bg-ink px-3 text-[13px] font-medium text-page transition-[background-color,transform] duration-100 hover:bg-ink/85 active:scale-[0.97]">

            <CheckIcon className="size-4" strokeWidth={2.5} />
            {switched ? "Build with this model" : "Build it"}

          </button>

        </div>

      </div>

    );

  }

}
