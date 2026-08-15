import { Component, type ChangeEvent, type KeyboardEvent } from "react";
import { CheckIcon, ListChecksIcon, XIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import type { Answer, Question } from "@/tools/ask";

interface AskCardProps {

  question: Question;

  onAnswer: (answer: Answer) => void;
  onDismiss: () => void;

}

interface AskCardState {

  picked: string[];
  text: string;

}

export class AskCard extends Component<AskCardProps, AskCardState> {

  state: AskCardState = { picked: [], text: "" };

  // a lone question with no write-in has exactly one thing to say, so saying it is the whole gesture
  private get instant(): boolean {

    const { multi, openLabel } = this.props.question;

    return !multi && !openLabel;

  }

  private choose = (id: string) => {

    if (this.instant) {

      this.props.onAnswer({ picked: [id], text: "", dismissed: false });

      return;

    }

    const { multi } = this.props.question;

    this.setState((prev) => {

      if (!multi) {

        return { picked: prev.picked[0] === id ? [] : [id] };

      }

      return { picked: prev.picked.includes(id) ? prev.picked.filter((one) => one !== id) : [...prev.picked, id] };

    });

  };

  private onType = (event: ChangeEvent<HTMLInputElement>) => {

    this.setState({ text: event.target.value });

  };

  private onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {

    if (event.key === "Enter") {

      event.preventDefault();
      this.submit();

    }

  };

  private submit = () => {

    const { picked, text } = this.state;

    if (!picked.length && !text.trim()) {

      return;

    }

    this.props.onAnswer({ picked, text: text.trim(), dismissed: false });

  };

  render() {

    const { question, onDismiss } = this.props;
    const { picked, text } = this.state;

    const ready = picked.length > 0 || text.trim().length > 0;

    return (

      <div className="overflow-hidden rounded-card bg-surface shadow-card animate-fade-up">

        <div className="flex items-center gap-2.5 p-3.5">

          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ink text-page">

            <ListChecksIcon className="size-3.5" strokeWidth={2.5} />

          </span>

          <span className="text-[14px] font-medium text-ink">

            {question.prompt}

          </span>

        </div>

        <div className="flex flex-col gap-1.5 border-t border-line bg-inset px-3.5 py-3">

          {question.choices.map((choice) => {

            const on = picked.includes(choice.id);

            return (

              <button
                key={choice.id}
                type="button"
                aria-pressed={on}
                onClick={() => this.choose(choice.id)}
                className={cn( "flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left text-[13px] transition-colors duration-100", on ? "bg-surface text-ink shadow-hairline" : "text-ink-2 hover:bg-hover hover:text-ink", )}
              >

                <span className={cn( "flex size-4 shrink-0 items-center justify-center border border-line transition-colors duration-100", question.multi ? "rounded-[5px]" : "rounded-full", on && "border-ink bg-ink text-page", )}>

                  {on ? <CheckIcon className="size-3" strokeWidth={3} /> : null}

                </span>

                <span className="min-w-0 flex-1">{choice.label}</span>

              </button>

            );

          })}

          {question.openLabel ? (

            <input
              type="text"
              value={text}
              placeholder={question.openLabel}
              onChange={this.onType}
              onKeyDown={this.onKeyDown}
              className="min-h-9 w-full rounded-control bg-surface px-2.5 py-1.5 text-[13px] text-ink shadow-hairline outline-none transition-shadow duration-100 placeholder:text-ink-3 focus:shadow-card"
            />

          ) : null}

        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-3.5 py-3">

          {question.multi ? (

            <span className="mr-auto text-[12.5px] text-ink-3">Pick as many as apply</span>

          ) : null}

          <button type="button" onClick={onDismiss} className="flex h-9 items-center gap-2 rounded-control px-3 text-[13px] font-medium text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink" >

            <XIcon className="size-4" />
            Skip

          </button>

          {this.instant ? null : (

            <button type="button" disabled={!ready} onClick={this.submit} className={cn( "flex h-9 items-center gap-2 rounded-control px-3 text-[13px] font-medium transition-[background-color,transform] duration-100 active:scale-[0.97]", ready ? "bg-ink text-page hover:bg-ink/85" : "cursor-not-allowed bg-field text-ink-3", )} >

              <CheckIcon className="size-4" strokeWidth={2.5} />
              Answer

            </button>

          )}

        </div>

      </div>

    );

  }

}
