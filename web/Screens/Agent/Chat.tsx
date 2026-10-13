import { AppWindow, Bell, Calendar, Check, FolderOpen, Globe, Paperclip, SlidersHorizontal, Square, X } from "lucide-react";
import { motion } from "motion/react";
import { Component, createRef, type DragEvent, type ReactNode } from "react";

import { Composer } from "./Composer";
import { Files } from "./Files";
import { Button, IconButton, inputClass } from "../../Components/Controls";
import { Glyph } from "../../Components/Glyph/Glyph";
import { withMentions } from "../../Components/Glyph/Mention";
import { Bar } from "../../Components/Layout";
import { Memo } from "../../Components/Memo";
import { RichCard } from "../../Components/RichCard";

import { parseQuestion } from "../../Lib/protocol";
import { AgentsContext } from "../../App/context";
import { fileURL, uploadFile, type Agent, type AgentEvent } from "../../Lib/api";
import { buildItems, type Item } from "../../Lib/thread";

/** One run's work, summed up in a line: what it is doing now, or how long it took. */
function Work({ steps, current, seconds, live }: { steps: number; current: string; seconds: number; live: boolean }) {

  return (

    <div className="flex max-w-full min-w-0 items-center gap-2 self-start py-1 text-[14px] text-dim">

      {live ? <span className="size-2 shrink-0 animate-pulse rounded-full bg-fg" /> : <Check size={15} className="shrink-0" />}
      <span className="truncate">{live ? current || `Working · step ${steps}` : `Worked for ${seconds}s · ${steps} ${steps === 1 ? "step" : "steps"}`}</span>

    </div>

  );

}

/** A card's answer, once the agent stopped waiting on it. */
function Answered({ ok, text }: { ok: boolean; text: string }) {

  return (

    <div className="flex max-w-md items-start gap-3 text-dim">

      {ok ? <Check size={16} className="mt-1 shrink-0" /> : <X size={16} className="mt-1 shrink-0" />}
      <span className="text-[14px]">{text}</span>

    </div>

  );

}

/** What the agent is waiting on right now. */
function Waiting({ label, title, children }: { label: string; title: string; children: ReactNode }) {

  return (

    <section aria-label={label} className="flex max-w-md flex-col gap-4 rounded-2xl bg-panel p-5">

      <span className="flex flex-col gap-1.5">

        <span className="text-[14px] text-dim">{label}</span>
        <span className="font-serif text-[20px] leading-snug">{title}</span>

      </span>

      {children}

    </section>

  );

}

interface ChatProps {

  agent: Agent;
  events: AgentEvent[] | undefined;

  /** files are workspace paths, already uploaded. */
  onSend: (text: string, files?: string[]) => Promise<void>;
  onStop: () => void;

  /** Allow or refuse; a question is answered in words. */
  onAnswer: (reply: boolean | string) => void;

}

interface ChatState {

  files: boolean;
  dragging: boolean;

}

export class Chat extends Component<ChatProps, ChatState> {

  static contextType = AgentsContext;
  declare context: Agent[];

  state: ChatState = { files: false, dragging: false };

  private scroller = createRef<HTMLDivElement>();
  private composer = createRef<Composer>();
  private pinned = true;

  // history already on screen when the chat opens appears at once; only what arrives later animates in
  private ready = false;

  componentDidMount() {

    this.scrollToEnd();
    this.ready = true;

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

  send = async (text: string, files: File[]) => {

    const paths = await Promise.all(files.map((file) => uploadFile(this.props.agent.id, file)));

    await this.props.onSend(text, paths);

  };

  onDragOver = (event: DragEvent) => {

    if (event.dataTransfer.types.includes("Files")) {

      event.preventDefault();

      if (!this.state.dragging) {

        this.setState({ dragging: true });

      }

    }

  };

  onDragLeave = (event: DragEvent) => {

    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {

      this.setState({ dragging: false });

    }

  };

  onDrop = (event: DragEvent) => {

    if (event.dataTransfer.files.length) {

      event.preventDefault();
      this.composer.current?.add([...event.dataTransfer.files]);

    }

    this.setState({ dragging: false });

  };

  renderItem(item: Item, lastAsk: string | null) {

    const { agent } = this.props;
    const open = "answer" in item && item.answer === null && agent.state === "waiting" && item.key === lastAsk;

    switch (item.kind) {

      case "user":

        return (

          <div key={item.key} className="flex max-w-[80%] flex-col items-end gap-1.5 self-end">

            {item.files.length > 0 && (

              <span className="flex flex-wrap justify-end gap-1.5">

                {item.files.map((path) => <a key={path} href={fileURL(agent.id, path)} download className="flex max-w-56 items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[13px] text-fg no-underline hover:border-dim"><Paperclip size={12} className="shrink-0 text-dim" /><span className="truncate">{path.split("/").at(-1)}</span></a>)}

              </span>

            )}

            {item.text && <div className="rounded-2xl rounded-br-md bg-panel px-4 py-2.5 text-[15px] whitespace-pre-wrap">{withMentions(item.text, this.context)}</div>}

          </div>

        );

      case "note":

        return <div key={item.key} className="self-center px-6 text-center text-[13px] text-dim">{item.text}</div>;

      case "say":

        return <Memo key={item.key} text={item.text} className="text-[17px] text-fg/80" />;

      case "card":

        return <RichCard key={item.key} text={item.text} onSend={this.props.onSend} />;

      case "notify":

        return <div key={item.key} className="flex items-center gap-2 text-[13px] text-dim"><Bell size={13} className="shrink-0" />Sent to your phone: {item.text}</div>;

      case "work":

        return <Work key={item.key} steps={item.steps} current={item.current} seconds={item.seconds} live={item.live} />;

      case "page":

        return (

          <a key={item.key} href={`#/agent/${agent.id}/browser`} className="flex max-w-md flex-col gap-1 rounded-2xl border border-line px-4 py-3 text-fg no-underline hover:border-dim">

            <span className="flex items-center gap-2 font-mono text-[12px] text-dim"><Globe size={13} /><span className="truncate">{item.url.replace(/^https?:\/\//, "")}</span></span>
            {item.title && <span className="font-serif text-[18px]">{item.title}</span>}

          </a>

        );

      case "routine":

        return (

          <div key={item.key} className="flex max-w-md items-start gap-3 rounded-2xl border border-line px-4 py-3">

            <Calendar size={16} className="mt-1 shrink-0 text-dim" />
            <span className="flex min-w-0 flex-col gap-0.5">

              <span className="text-[13px] text-dim">{item.when}</span>
              <span className="line-clamp-2 text-[15px]">{item.title}</span>

            </span>

          </div>

        );

      case "ask": {

        const [what, where] = item.text.split("\n");

        if (!open) {

          return <Answered ok={item.answer === "allowed"} text={`${item.answer === "allowed" ? "Sent with your OK" : "Not sent"} — ${what}`} />;

        }

        return (

          <Waiting label="Send this?" title={what}>

            {where && <span className="-mt-2.5 truncate font-mono text-[12px] text-dim">{where}</span>}

            <span className="flex gap-2">

              <Button className="grow" onClick={() => this.props.onAnswer(false)}>Don’t send</Button>
              <Button tone="primary" className="grow" onClick={() => this.props.onAnswer(true)}>Allow</Button>

            </span>

          </Waiting>

        );

      }

      case "handoff":

        if (!open) {

          return <Answered ok={item.answer === "done"} text={`${item.answer === "done" ? "Done in the browser" : "Skipped"} — ${item.text}`} />;

        }

        return (

          <Waiting label="Needs you in the browser" title={item.text}>

            <span className="flex gap-2">

              <Button className="grow" onClick={() => this.props.onAnswer(false)}>Skip</Button>
              <a href={`#/agent/${agent.id}/browser`} className="flex h-11 grow items-center justify-center rounded-xl bg-fg px-5 text-[15px] font-medium text-ink no-underline">Open browser</a>

            </span>

          </Waiting>

        );

      case "question": {

        const { prompt, choices, write } = parseQuestion(item.text);
        const answered = item.answer !== null && item.answer !== "Skipped.";

        if (!open) {

          return <Answered ok={answered} text={`${prompt} — ${answered ? item.answer : "Not answered"}`} />;

        }

        return (

          <Waiting label="Question" title={prompt}>

            {choices.length > 0 && (

              <span className="flex flex-col gap-2">

                {choices.map((choice) => <Button key={choice} className="h-auto min-h-11 py-2.5 text-left" onClick={() => this.props.onAnswer(choice)}>{choice}</Button>)}

              </span>

            )}

            {write && <input placeholder={write} aria-label={write} enterKeyHint="send" onKeyDown={(event) => event.key === "Enter" && event.currentTarget.value.trim() && this.props.onAnswer(event.currentTarget.value.trim())} className={inputClass} />}

            <Button onClick={() => this.props.onAnswer(false)}>Skip</Button>

          </Waiting>

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
    const lastAsk = [...items].reverse().find((item) => item.kind === "ask" || item.kind === "handoff" || item.kind === "question")?.key ?? null;
    const working = agent.state === "running" && !items.some((item) => item.kind === "work" && item.live);

    return (

      <div onDragOver={this.onDragOver} onDragLeave={this.onDragLeave} onDrop={this.onDrop} className="relative flex h-full">

        <div className="flex h-full min-w-0 grow flex-col">

          <Bar
            back="#/"
            backAlways
            icon={<Glyph glyph={agent.glyph} size={30} live={busy} />}
            title={agent.name}
            actions={(

              <>

                {agent.state !== "idle" && <IconButton label="Stop" onClick={this.props.onStop}><Square size={16} strokeWidth={2} /></IconButton>}
                <IconButton label="Files" aria-pressed={this.state.files} onClick={() => this.setState({ files: !this.state.files })}><FolderOpen size={19} strokeWidth={1.6} /></IconButton>
                <a href={`#/agent/${agent.id}/browser`} aria-label="Browser" title="Browser" className="flex size-11 items-center justify-center rounded-xl text-dim hover:text-fg"><AppWindow size={19} strokeWidth={1.6} /></a>
                <a href={`#/agent/${agent.id}/details`} aria-label="Details" title="Details" className="flex size-11 items-center justify-center rounded-xl text-dim hover:text-fg"><SlidersHorizontal size={19} strokeWidth={1.6} /></a>

              </>

            )}
          />

          <div ref={this.scroller} onScroll={this.onScroll} className="min-h-0 grow overflow-y-auto">

            <div className="mx-auto flex max-w-4xl flex-col gap-5 px-[23px] pt-6 pb-12 md:px-8">

              {events === undefined && <div className="text-dim">Loading…</div>}
              {events?.length === 0 && <Memo text={`${agent.name} is ready. What should it do?`} className="text-dim" />}
              {items.map((item) => (

                <motion.div key={item.key} className="flex flex-col" initial={this.ready ? { opacity: 0, y: 8 } : false} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: "easeOut" }}>

                  {this.renderItem(item, lastAsk)}

                </motion.div>

              ))}
              {working && <div className="flex items-center gap-2 text-[14px] text-dim"><span className="size-2 animate-pulse rounded-full bg-fg" />Working…</div>}
              {agent.state === "queued" && <div className="text-[14px] text-dim">Queued — it starts when another agent finishes.</div>}

            </div>

          </div>

          <Composer ref={this.composer} placeholder={`Message ${agent.name}`} onSend={this.send} attach />

        </div>

        {this.state.files && <Files agentId={agent.id} version={events?.length ?? 0} onClose={() => this.setState({ files: false })} />}

        {this.state.dragging && <div className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-dim bg-ink/85 text-[15px] text-fg">Drop to attach</div>}

      </div>

    );

  }

}
