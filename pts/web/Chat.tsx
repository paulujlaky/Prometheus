import { ArrowUp, Calendar, Check, ChevronRight, Globe, SlidersHorizontal, Square, X } from "lucide-react";
import { Component, createRef, type KeyboardEvent } from "react";

import { Bar, Button, IconButton, Memo } from "./ui";

import { buildItems, type Item, type Step } from "./thread";
import type { Agent, AgentEvent } from "./api";

const STATUS: Record<Agent["state"], string> = {

  waiting: "Needs your OK",
  running: "Working",
  queued: "Queued",
  idle: "Idle",

};

interface ComposerProps {

  placeholder: string;
  onSend: (text: string) => Promise<void>;

}

export class Composer extends Component<ComposerProps, { text: string; sending: boolean }> {

  state = { text: "", sending: false };

  send = async () => {

    const text = this.state.text.trim();

    if (!text || this.state.sending) {

      return;

    }

    this.setState({ sending: true });

    try {

      await this.props.onSend(text);
      this.setState({ text: "" });

    } catch (err) {

      alert(err instanceof Error ? err.message : String(err));

    } finally {

      this.setState({ sending: false });

    }

  };

  onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {

    // isComposing: Enter that confirms an IME candidate (Japanese, Chinese) must not send half a word
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {

      event.preventDefault();
      this.send();

    }

  };

  render() {

    const rows = Math.min(6, this.state.text.split("\n").length);

    return (

      <form onSubmit={(event) => { event.preventDefault(); this.send(); }} className="mx-3 mb-[max(12px,env(safe-area-inset-bottom))] flex shrink-0 items-end gap-2 rounded-2xl border border-line bg-panel py-1.5 pr-1.5 pl-4 focus-within:border-dim">

        <label className="sr-only" htmlFor="composer">{this.props.placeholder}</label>
        <textarea id="composer" rows={rows} value={this.state.text} onChange={(event) => this.setState({ text: event.target.value })} onKeyDown={this.onKeyDown} placeholder={this.props.placeholder} className="max-h-40 min-w-0 grow resize-none bg-transparent py-2.5 text-[16px] leading-normal text-fg outline-none placeholder:text-dim" />
        <button type="submit" aria-label="Send" disabled={!this.state.text.trim() || this.state.sending} className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-fg text-ink disabled:opacity-30"><ArrowUp size={18} strokeWidth={2} /></button>

      </form>

    );

  }

}

class Work extends Component<{ steps: Step[]; seconds: number; live: boolean }, { open: boolean }> {

  state = { open: false };

  render() {

    const { steps, seconds, live } = this.props;
    const failed = steps.filter((step) => step.ok === false).length;
    const summary = live ? `Working · step ${steps.length}` : `Worked for ${seconds}s · ${steps.length} ${steps.length === 1 ? "step" : "steps"}${failed ? ` · ${failed} retried` : ""}`;

    return (

      <div className="flex flex-col gap-1 self-start">

        <button type="button" aria-expanded={this.state.open} onClick={() => this.setState({ open: !this.state.open })} className="flex items-center gap-2 py-1 text-[14px] text-dim hover:text-fg">

          {live ? <span className="size-2 animate-pulse rounded-full bg-fg" /> : <ChevronRight size={15} className={this.state.open ? "rotate-90" : ""} />}
          {summary}

        </button>

        {this.state.open && (

          <ol className="m-0 flex list-none flex-col gap-2 border-l border-line py-1 pl-4">

            {steps.map((step, i) => (

              <li key={i} className="flex flex-col gap-1">

                <span className="flex items-center gap-2 text-[14px]">

                  {step.ok === false ? <X size={14} className="text-dim" /> : <Check size={14} className={step.ok ? "text-dim" : "opacity-0"} />}
                  {step.label}

                </span>

                {step.detail && <pre className="m-0 max-h-48 overflow-auto rounded-lg bg-panel p-3 font-mono text-[12px] whitespace-pre-wrap text-dim">{step.detail.slice(0, 1500)}</pre>}

              </li>

            ))}

          </ol>

        )}

      </div>

    );

  }

}

interface ChatProps {

  agent: Agent;
  events: AgentEvent[] | undefined;

  onSend: (text: string) => Promise<void>;
  onStop: () => void;
  onAnswer: (allow: boolean) => void;

}

export class Chat extends Component<ChatProps> {

  private scroller = createRef<HTMLDivElement>();
  private pinned = true;

  componentDidMount() {

    this.scrollToEnd();

  }

  componentDidUpdate(previous: ChatProps) {

    // follow new output only when the reader was already at the bottom
    if (previous.agent.id !== this.props.agent.id || this.pinned) {

      this.scrollToEnd();

    }

  }

  scrollToEnd = () => {

    const element = this.scroller.current;

    element?.scrollTo({ top: element.scrollHeight });

  };

  onScroll = () => {

    const element = this.scroller.current!;

    this.pinned = element.scrollHeight - element.scrollTop - element.clientHeight < 80;

  };

  renderItem(item: Item, lastAsk: string | null) {

    const { agent } = this.props;

    switch (item.kind) {

      case "user":

        return <div key={item.key} className="max-w-[80%] self-end rounded-2xl rounded-br-md bg-panel px-4 py-2.5 text-[15px] whitespace-pre-wrap">{item.text}</div>;

      case "note":

        return <div key={item.key} className="self-center px-6 text-center text-[13px] text-dim">{item.text}</div>;

      case "say":

        return <Memo key={item.key} text={item.text} className="text-[17px] text-fg/80" />;

      case "work":

        return <Work key={item.key} steps={item.steps} seconds={item.seconds} live={item.live} />;

      case "page":

        return (

          <div key={item.key} className="flex max-w-md flex-col gap-1 rounded-2xl border border-line px-4 py-3">

            <span className="flex items-center gap-2 font-mono text-[12px] text-dim"><Globe size={13} /><span className="truncate">{item.url.replace(/^https?:\/\//, "")}</span></span>
            {item.title && <span className="font-serif text-[18px]">{item.title}</span>}

          </div>

        );

      case "routine":

        return (

          <div key={item.key} className="flex max-w-md items-start gap-3 rounded-2xl border border-line px-4 py-3">

            <Calendar size={16} className="mt-1 shrink-0 text-dim" />
            <span className="flex min-w-0 flex-col gap-0.5">

              <span className="font-mono text-[12px] text-dim">{item.when}</span>
              <span className="line-clamp-2 text-[15px]">{item.task}</span>

            </span>

          </div>

        );

      case "ask": {

        const [what, where] = item.text.split("\n");
        const open = item.answer === null && agent.state === "waiting" && item.key === lastAsk;

        if (!open) {

          return (

            <div key={item.key} className="flex max-w-md items-start gap-3 text-dim">

              {item.answer === "allowed" ? <Check size={16} className="mt-1 shrink-0" /> : <X size={16} className="mt-1 shrink-0" />}
              <span className="text-[14px]">{item.answer === "allowed" ? "Sent with your OK" : "Not sent"} — {what}</span>

            </div>

          );

        }

        return (

          <section key={item.key} aria-label="Approval" className="flex max-w-md flex-col gap-4 rounded-2xl bg-panel p-5">

            <span className="flex flex-col gap-1.5">

              <span className="text-[14px] text-dim">Send this?</span>
              <span className="font-serif text-[20px] leading-snug">{what}</span>
              {where && <span className="truncate font-mono text-[12px] text-dim">{where}</span>}

            </span>

            <span className="flex gap-2">

              <Button className="grow" onClick={() => this.props.onAnswer(false)}>Don’t send</Button>
              <Button tone="primary" className="grow" onClick={() => this.props.onAnswer(true)}>Allow</Button>

            </span>

          </section>

        );

      }

      case "done":

        return <Memo key={item.key} text={item.text} />;

      case "error":

        return <div key={item.key} className="text-[14px] text-dim">{item.text === "Stopped by the user." ? "Stopped." : `Couldn’t finish: ${item.text}`}</div>;

    }

  }

  render() {

    const { agent, events } = this.props;
    const busy = agent.state === "running" || agent.state === "waiting";
    const items = buildItems(events ?? [], busy);
    const lastAsk = [...items].reverse().find((item) => item.kind === "ask")?.key ?? null;
    const working = agent.state === "running" && !items.some((item) => item.kind === "work" && item.live);

    return (

      <div className="flex h-full flex-col">

        <Bar
          back="#/"
          title={agent.name}
          subtitle={STATUS[agent.state]}
          actions={(

            <>

              {agent.state !== "idle" && <IconButton label="Stop" onClick={this.props.onStop}><Square size={16} strokeWidth={2} /></IconButton>}
              <a href={`#/agent/${agent.id}/details`} aria-label="Details" title="Details" className="flex size-11 items-center justify-center rounded-xl text-dim hover:text-fg"><SlidersHorizontal size={19} strokeWidth={1.6} /></a>

            </>

          )}
        />

        <div ref={this.scroller} onScroll={this.onScroll} className="grow overflow-y-auto">

          <div className="mx-auto flex max-w-2xl flex-col gap-5 px-5 py-6">

            {events === undefined && <div className="text-dim">Loading…</div>}
            {events?.length === 0 && <Memo text={`${agent.name} is ready. What should it do?`} className="text-dim" />}
            {items.map((item) => this.renderItem(item, lastAsk))}
            {working && <div className="flex items-center gap-2 text-[14px] text-dim"><span className="size-2 animate-pulse rounded-full bg-fg" />Working…</div>}
            {agent.state === "queued" && <div className="text-[14px] text-dim">Queued — it starts when another agent finishes.</div>}

          </div>

        </div>

        <Composer placeholder={`Message ${agent.name}`} onSend={this.props.onSend} />

      </div>

    );

  }

}
