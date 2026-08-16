import { Component, type ChangeEvent, type KeyboardEvent } from "react";
import { CheckIcon, ListChecksIcon, XIcon } from "lucide-react";

import { Md } from "@/Features/Code/Markdown";
import { ActionButton, PromptBody, PromptCard, PromptFooter, PromptHeader, PromptIcon } from "@/UI/Prompt";
import { cn } from "@/Utils/Class";

import type { Answer, Question } from "@/Tools/Ask";

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

      <PromptCard>

        <PromptHeader>

          <PromptIcon><ListChecksIcon className="size-3.5" strokeWidth={2.5} /></PromptIcon>

          <Md className="min-w-0 flex-1 text-[14px] font-medium text-ink">

            {question.prompt}

          </Md>

        </PromptHeader>

        <PromptBody className="flex flex-col gap-1.5">

          {question.choices.map((choice) => {

            const on = picked.includes(choice.id);

            return (

              <button className={cn( "flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left text-[13px] transition-colors duration-100", on ? "bg-surface text-ink shadow-hairline" : "text-ink-2 hover:bg-hover hover:text-ink", )}

                key={choice.id}
                type="button"
                aria-pressed={on}

                onClick={() => this.choose(choice.id)}

              >

                <span className={cn( "flex size-4 shrink-0 items-center justify-center border border-line transition-colors duration-100", question.multi ? "rounded-[5px]" : "rounded-full", on && "border-ink bg-ink text-page", )}>

                  {on ? <CheckIcon className="size-3" strokeWidth={3} /> : null}

                </span>

                <Md inline className="min-w-0 flex-1 overflow-visible whitespace-normal text-[13px] leading-snug text-inherit">

                  {choice.label}

                </Md>

              </button>

            );

          })}

          {question.openLabel ? (

            <input className="min-h-9 w-full rounded-control bg-surface px-2.5 py-1.5 text-[13px] text-ink shadow-hairline outline-none transition-shadow duration-100 placeholder:text-ink-3 focus:shadow-card"

              type="text"
              value={text}

              placeholder={question.openLabel}

              onChange={this.onType}
              onKeyDown={this.onKeyDown}

            />

          ) : null}

        </PromptBody>

        <PromptFooter>

          {question.multi ? (

            <span className="mr-auto text-[12.5px] text-ink-3">Pick as many as apply</span>

          ) : null}

          <ActionButton onClick={onDismiss}>

            <XIcon className="size-4" />
            Skip

          </ActionButton>

          {this.instant ? null : (

            <ActionButton tone={ready ? "primary" : "muted"} disabled={!ready} onClick={this.submit}>

              <CheckIcon className="size-4" strokeWidth={2.5} />
              Answer

            </ActionButton>

          )}

        </PromptFooter>

      </PromptCard>

    );

  }

}
