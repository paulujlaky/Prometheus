import { ArrowUp, Paperclip, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Component, createRef, type ClipboardEvent, type KeyboardEvent } from "react";

import { colorOf, Glyph } from "../../Components/Glyph/Glyph";

import { AgentsContext } from "../../App/context";
import type { Agent } from "../../Lib/api";

interface ComposerProps {

  placeholder: string;
  onSend: (text: string, files: File[]) => Promise<void>;

  /** Whether files can go with a message. */
  attach?: boolean;

}

interface ComposerState {

  text: string;
  files: File[];
  sending: boolean;

  /** The @word being typed at the caret, while it could still become a mention. */
  query: string | null;
  active: number;

}

const MENTION_AT_CARET = /(?:^|\s)@([\w-]*)$/;

// the server refuses more, since the agent could not read it whole
const MAX_FILE = 20_000_000;

export class Composer extends Component<ComposerProps, ComposerState> {

  static contextType = AgentsContext;
  declare context: Agent[];

  state: ComposerState = { text: "", files: [], sending: false, query: null, active: 0 };

  private field = createRef<HTMLTextAreaElement>();
  private picker = createRef<HTMLInputElement>();
  private observer: ResizeObserver | undefined;

  componentDidMount() {

    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(this.field.current!.parentElement!);
    this.resize();

  }

  componentDidUpdate() {

    this.resize();

  }

  componentWillUnmount() {

    this.observer?.disconnect();

  }

  resize = () => {

    const field = this.field.current;

    if (field) {

      field.style.height = "0px";
      field.style.height = field.scrollHeight + "px";

    }

  };

  suggestions(): Agent[] {

    const { query } = this.state;

    if (query === null) {

      return [];

    }

    return this.context.filter((agent) => agent.name.toLowerCase().startsWith(query.toLowerCase())).slice(0, 6);

  }

  /** Re-reads the word at the caret; called on every edit and caret move. */
  track = () => {

    const field = this.field.current!;
    const before = field.value.slice(0, field.selectionStart);
    const query = MENTION_AT_CARET.exec(before)?.[1] ?? null;

    if (query !== this.state.query) {

      this.setState({ query, active: 0 });

    }

  };

  pick = (agent: Agent) => {

    const field = this.field.current!;
    const caret = field.selectionStart;
    const before = field.value.slice(0, caret).replace(/@[\w-]*$/, `@${agent.name} `);
    const text = before + field.value.slice(caret);

    this.setState({ text, query: null }, () => {

      field.focus();
      field.setSelectionRange(before.length, before.length);

    });

  };

  /** Adds files to the next message; the chat calls this for a drop. */
  add = (files: File[]) => {

    const big = files.filter((file) => file.size > MAX_FILE);

    if (big.length) {

      alert(`${big.map((file) => file.name).join(", ")} ${big.length === 1 ? "is" : "are"} over 20 MB.`);

    }

    this.setState({ files: [...this.state.files, ...files.filter((file) => file.size <= MAX_FILE)] });

  };

  onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {

    if (this.props.attach && event.clipboardData.files.length) {

      event.preventDefault();
      this.add([...event.clipboardData.files]);

    }

  };

  send = async () => {

    const text = this.state.text.trim();
    const { files } = this.state;

    if ((!text && !files.length) || this.state.sending) {

      return;

    }

    this.setState({ sending: true });

    try {

      await this.props.onSend(text, files);
      this.setState({ text: "", files: [] });

    } catch (err) {

      alert(err instanceof Error ? err.message : String(err));

    } finally {

      this.setState({ sending: false });

    }

  };

  onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {

    const suggestions = this.suggestions();

    if (suggestions.length) {

      const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 };

      if (event.key in moves) {

        event.preventDefault();
        this.setState({ active: (this.state.active + moves[event.key] + suggestions.length) % suggestions.length });
        return;

      }

      if (event.key === "Enter" || event.key === "Tab") {

        event.preventDefault();
        this.pick(suggestions[this.state.active]);
        return;

      }

      if (event.key === "Escape") {

        event.preventDefault();
        this.setState({ query: null });
        return;

      }

    }

    // isComposing: Enter that confirms an IME candidate (Japanese, Chinese) must not send half a word
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {

      event.preventDefault();
      this.send();

    }

  };

  render() {

    const suggestions = this.suggestions();
    const { files, text, sending } = this.state;

    return (

      <form onSubmit={(event) => { event.preventDefault(); this.send(); }} className="relative mx-3 mb-[max(12px,env(safe-area-inset-bottom))] flex shrink-0 flex-col rounded-2xl border border-line bg-panel p-1.5 focus-within:border-dim md:mx-auto md:w-[calc(100%-64px)] md:max-w-[832px]">

        <AnimatePresence>

          {suggestions.length > 0 && (

            <motion.ul initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.12 }} role="listbox" aria-label="Mention an agent" className="absolute bottom-full left-0 z-20 m-0 mb-2 flex min-w-56 list-none flex-col rounded-xl border border-line bg-panel p-1 shadow-[0_16px_40px_rgb(0_0_0/0.5)]">

              {suggestions.map((agent, index) => (

                <li key={agent.id} role="option" aria-selected={index === this.state.active} onPointerDown={(event) => { event.preventDefault(); this.pick(agent); }} className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-[15px] ${index === this.state.active ? "bg-raised" : ""}`}>

                  <Glyph glyph={agent.glyph} size={22} />
                  <span style={{ color: colorOf(agent) }}>{agent.name}</span>

                </li>

              ))}

            </motion.ul>

          )}

        </AnimatePresence>

        {files.length > 0 && (

          <ul aria-label="Attached files" className="m-0 flex list-none flex-wrap gap-1.5 p-1.5 pb-1">

            {files.map((file, index) => (

              <li key={`${file.name}${index}`} className="flex max-w-56 items-center gap-1 rounded-lg bg-raised py-1 pr-1 pl-2.5 text-[13px]">

                <span className="truncate">{file.name}</span>
                <button type="button" aria-label={`Remove ${file.name}`} onClick={() => this.setState({ files: files.filter((_, other) => other !== index) })} className="flex size-6 shrink-0 items-center justify-center rounded-md text-dim hover:text-fg"><X size={13} /></button>

              </li>

            ))}

          </ul>

        )}

        <div className={`flex items-end gap-2 ${this.props.attach ? "" : "pl-2.5"}`}>

          {this.props.attach && (

            <>

              <input ref={this.picker} type="file" multiple hidden onChange={(event) => { this.add([...(event.target.files ?? [])]); event.target.value = ""; }} />
              <button type="button" aria-label="Attach files" title="Attach files" onClick={() => this.picker.current?.click()} className="mb-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl text-dim hover:text-fg"><Paperclip size={18} /></button>

            </>

          )}

          <label className="sr-only" htmlFor="composer">{this.props.placeholder}</label>
          <textarea ref={this.field} id="composer" rows={1} value={text} onChange={(event) => this.setState({ text: event.target.value }, this.track)} onKeyDown={this.onKeyDown} onKeyUp={(event) => (event.key.startsWith("Arrow") && !suggestions.length) && this.track()} onClick={this.track} onPaste={this.onPaste} onBlur={() => this.setState({ query: null })} placeholder={this.props.placeholder} className="max-h-[45dvh] min-w-0 grow resize-none bg-transparent py-2.5 text-[16px] leading-normal text-fg outline-none placeholder:text-dim" />
          <button type="submit" aria-label="Send" disabled={(!text.trim() && !files.length) || sending} className="mb-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl bg-fg text-ink disabled:opacity-30"><ArrowUp size={18} strokeWidth={2} /></button>

        </div>

      </form>

    );

  }

}
