import { ArrowUp } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Component, createRef, type KeyboardEvent } from "react";

import { colorOf, Glyph } from "../../Components/Glyph/Glyph";

import { AgentsContext } from "../../App/context";
import type { Agent } from "../../Lib/api";

interface ComposerProps {

  placeholder: string;
  onSend: (text: string) => Promise<void>;

}

interface ComposerState {

  text: string;
  sending: boolean;

  /** The @word being typed at the caret, while it could still become a mention. */
  query: string | null;
  active: number;

}

const MENTION_AT_CARET = /(?:^|\s)@([\w-]*)$/;

export class Composer extends Component<ComposerProps, ComposerState> {

  static contextType = AgentsContext;
  declare context: Agent[];

  state: ComposerState = { text: "", sending: false, query: null, active: 0 };

  private field = createRef<HTMLTextAreaElement>();

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

    const rows = Math.min(6, this.state.text.split("\n").length);
    const suggestions = this.suggestions();

    return (

      <form onSubmit={(event) => { event.preventDefault(); this.send(); }} className="relative mx-3 mb-[max(12px,env(safe-area-inset-bottom))] flex md:mx-auto md:w-[calc(100%-64px)] md:max-w-[832px] shrink-0 items-end gap-2 rounded-2xl border border-line bg-panel py-1.5 pr-1.5 pl-4 focus-within:border-dim">

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

        <label className="sr-only" htmlFor="composer">{this.props.placeholder}</label>
        <textarea ref={this.field} id="composer" rows={rows} value={this.state.text} onChange={(event) => this.setState({ text: event.target.value }, this.track)} onKeyDown={this.onKeyDown} onKeyUp={(event) => (event.key.startsWith("Arrow") && !suggestions.length) && this.track()} onClick={this.track} onBlur={() => this.setState({ query: null })} placeholder={this.props.placeholder} className="max-h-40 min-w-0 grow resize-none bg-transparent py-2.5 text-[16px] leading-normal text-fg outline-none placeholder:text-dim" />
        <button type="submit" aria-label="Send" disabled={!this.state.text.trim() || this.state.sending} className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-fg text-ink disabled:opacity-30"><ArrowUp size={18} strokeWidth={2} /></button>

      </form>

    );

  }

}
