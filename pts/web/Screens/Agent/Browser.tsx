import { ArrowLeft, Keyboard } from "lucide-react";
import { Component, createRef, type ChangeEvent, type KeyboardEvent, type PointerEvent, type TouchEvent, type WheelEvent } from "react";

import { Button, IconButton } from "../../Components/Controls";
import { Glyph } from "../../Components/Glyph/Glyph";
import { Bar } from "../../Components/Layout";

import type { Agent, LiveChannel, LiveEvent, LiveInput } from "../../Lib/api";

interface BrowserProps {

  agent: Agent;
  live: LiveChannel;

  onAnswer: (allow: boolean) => void;

}

interface BrowserState {

  ready: boolean;
  blank: boolean;
  mine: boolean;
  error: string;

  typed: string;

}

// a pointer that moves further than this is scrolling or dragging, not tapping
const TAP_SLOP = 8;

// keys a phone keyboard reports while composing; the text arrives through the change event instead
const PASSIVE_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "Unidentified", "Process", "Dead", "Backspace"]);

function needsYou(agent: Agent): boolean {

  return agent.state === "waiting" && agent.waitingOn === "handoff";

}

/** One agent's browser, live. Watching is free; taking over pauses the agent's browser work until it is handed back. */
export class Browser extends Component<BrowserProps, BrowserState> {

  state: BrowserState = { ready: false, blank: false, mine: false, error: "", typed: "" };

  private frame = createRef<HTMLImageElement>();
  private typer = createRef<HTMLInputElement>();
  private box = createRef<HTMLDivElement>();
  private unsubscribe = () => {};
  private shown = "";
  private errorTimer: ReturnType<typeof setTimeout> | undefined;

  private press: { x: number; y: number; startX: number; startY: number; moved: boolean; mouse: boolean } | null = null;
  private scroll = { x: 0, y: 0, dx: 0, dy: 0, queued: false };

  componentDidMount() {

    this.unsubscribe = this.props.live.subscribe(this.onLive);
    this.props.live.send({ live: "watch", agentId: this.props.agent.id });

    if (needsYou(this.props.agent)) {

      this.take();

    }

  }

  componentDidUpdate(previous: BrowserProps) {

    // a handoff asked for while the user is already looking is theirs at once
    if (needsYou(this.props.agent) && !needsYou(previous.agent) && !this.state.mine) {

      this.take();

    }

  }

  componentWillUnmount() {

    this.unsubscribe();
    this.props.live.send({ live: "unwatch" });
    URL.revokeObjectURL(this.shown);
    clearTimeout(this.errorTimer);

  }

  onLive = (event: LiveEvent) => {

    if (event.agentId !== this.props.agent.id) {

      return;

    }

    if (event.type === "frame") {

      // straight onto the element: several frames a second through state would re-render for nothing
      const previous = this.shown;

      this.shown = URL.createObjectURL(event.data);

      if (this.frame.current) {

        this.frame.current.src = this.shown;

      }

      URL.revokeObjectURL(previous);

      if (!this.state.ready || this.state.blank) {

        this.setState({ ready: true, blank: false, error: "" });

      }

      return;

    }

    this.setState((state) => ({

      ready: state.ready || !!event.blank,
      blank: event.blank ?? state.blank,
      mine: event.mine ?? state.mine,
      error: event.error ?? state.error,

      // what was typed belonged to a hold that has ended
      typed: event.mine === false ? "" : state.typed,

    }));

    // over a live page an error is a passing notice; before the first frame it is all there is to show, so it stays
    if (event.error && this.state.ready) {

      clearTimeout(this.errorTimer);
      this.errorTimer = setTimeout(() => this.setState({ error: "" }), 5000);

    }

  };

  input = (event: LiveInput) => this.props.live.send({ live: "input", event });

  /** On a phone the page is resized to fit the screen. */
  take = () => {

    const box = this.box.current;

    if (box && innerWidth < 768) {

      const style = getComputedStyle(box);

      this.props.live.send({ live: "take", width: box.clientWidth - parseFloat(style.paddingLeft) * 2, height: box.clientHeight - parseFloat(style.paddingBottom) });
      return;

    }

    this.props.live.send({ live: "take" });

  };

  /** Where on the page a pointer is, as fractions of the frame; the server scales them to its own viewport. */
  point(clientX: number, clientY: number) {

    const rect = this.frame.current!.getBoundingClientRect();
    const clamp = (value: number) => Math.min(1, Math.max(0, value));

    return { x: clamp((clientX - rect.left) / rect.width), y: clamp((clientY - rect.top) / rect.height), rect };

  }

  queueScroll(clientX: number, clientY: number, dx: number, dy: number) {

    const { x, y, rect } = this.point(clientX, clientY);

    this.scroll.x = x;
    this.scroll.y = y;
    this.scroll.dx += dx / rect.width;
    this.scroll.dy += dy / rect.height;

    if (this.scroll.queued) {

      return;

    }

    this.scroll.queued = true;

    requestAnimationFrame(() => {

      const cap = (value: number) => Math.max(-10, Math.min(10, value));
      const { x, y, dx, dy } = this.scroll;

      this.scroll = { x, y, dx: 0, dy: 0, queued: false };
      this.input({ kind: "scroll", x, y, dx: cap(dx), dy: cap(dy) });

    });

  }

  onPointerDown = (event: PointerEvent<HTMLImageElement>) => {

    if (!this.state.mine) {

      return;

    }

    // keeps focus where it is, so a keyboard opened from the button stays open between taps
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    this.press = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false, mouse: event.pointerType === "mouse" };

  };

  /** A finger drags to scroll; a mouse drags for real, which is what a slider captcha needs. */
  onPointerMove = (event: PointerEvent<HTMLImageElement>) => {

    const press = this.press;

    if (!press || (!press.moved && Math.hypot(event.clientX - press.startX, event.clientY - press.startY) < TAP_SLOP)) {

      return;

    }

    press.moved = true;

    if (!press.mouse) {

      this.queueScroll(event.clientX, event.clientY, press.x - event.clientX, press.y - event.clientY);
      press.x = event.clientX;
      press.y = event.clientY;

    }

  };

  onPointerUp = (event: PointerEvent<HTMLImageElement>) => {

    const press = this.press;

    this.press = null;

    if (!press || (press.moved && !press.mouse)) {

      return;

    }

    const to = this.point(event.clientX, event.clientY);

    if (press.moved) {

      const from = this.point(press.startX, press.startY);

      this.input({ kind: "drag", x: from.x, y: from.y, toX: to.x, toY: to.y });
      return;

    }

    this.input({ kind: "click", x: to.x, y: to.y });

    // a tap usually moves focus to another field; what was typed belonged to the last one
    this.setState({ typed: "" });

    // a touch would open the phone keyboard on every tap; that is the keyboard button's job
    if (press.mouse) {

      this.typer.current?.focus({ preventScroll: true });

    }

  };

  toggleKeyboard = () => {

    const typer = this.typer.current;

    if (document.activeElement === typer) {

      typer?.blur();
      return;

    }

    typer?.focus({ preventScroll: true });

  };

  // iOS follows a tap with mouse events that move focus off the hidden field, closing the keyboard it just opened
  onTouchEnd = (event: TouchEvent<HTMLImageElement>) => {

    if (this.state.mine) {

      event.preventDefault();

    }

  };

  onWheel = (event: WheelEvent<HTMLImageElement>) => {

    if (this.state.mine) {

      this.queueScroll(event.clientX, event.clientY, event.deltaX, event.deltaY);

    }

  };

  /** Typing goes through a hidden field so phones get a keyboard; each change goes to the page as the keys that would make it. */
  onType = (event: ChangeEvent<HTMLInputElement>) => {

    const next = event.target.value;
    const before = this.state.typed;

    let same = 0;

    while (same < before.length && same < next.length && before[same] === next[same]) {

      same += 1;

    }

    for (let i = same; i < before.length; i += 1) {

      this.input({ kind: "key", key: "Backspace" });

    }

    if (next.length > same) {

      this.input({ kind: "text", text: next.slice(same, same + 2000) });

    }

    this.setState({ typed: next });

  };

  /** Keys that make no text, like Enter, arrows or Control+a, go as Playwright key names. */
  onTypeKey = (event: KeyboardEvent<HTMLInputElement>) => {

    // an empty field has nothing to delete, so the change event never fires
    if (event.key === "Backspace" && !this.state.typed) {

      this.input({ kind: "key", key: "Backspace" });
      return;

    }

    const combo = event.ctrlKey || event.metaKey || event.altKey;

    // a paste is left to the field, so it arrives as a change with this machine's clipboard rather than the server's
    if (PASSIVE_KEYS.has(event.key) || (event.key.length === 1 && !combo) || (combo && event.key.toLowerCase() === "v")) {

      return;

    }

    event.preventDefault();

    const held = [event.ctrlKey && "Control", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Meta"].filter(Boolean);

    this.input({ kind: "key", key: [...held, event.key === " " ? "Space" : event.key].join("+") });
    this.setState({ typed: "" });

  };

  render() {

    const { agent } = this.props;
    const { ready, blank, mine, error, typed } = this.state;

    return (

      <div className="flex h-full flex-col">

        <Bar
          back={`#/agent/${agent.id}`}
          icon={<Glyph glyph={agent.glyph} size={30} live={agent.state === "running" || agent.state === "waiting"} />}
          title={agent.name}
          actions={(

            <>

              {mine && <IconButton label="Back" onClick={() => this.input({ kind: "back" })}><ArrowLeft size={19} strokeWidth={1.75} /></IconButton>}

              {/* pressing it must not take focus off the hidden field, or it could never tell an open keyboard to close */}
              {mine && <span className="hidden pointer-coarse:flex" onPointerDown={(event) => event.preventDefault()}><IconButton label="Keyboard" onClick={this.toggleKeyboard}><Keyboard size={19} strokeWidth={1.75} /></IconButton></span>}
              <Button tone={mine ? "primary" : "quiet"} className="ml-2 shrink-0" onClick={mine ? () => this.props.live.send({ live: "give" }) : this.take}>{mine ? "Hand back" : "Take over"}</Button>

            </>

          )}
        />

        {needsYou(agent) && (

          <div className="mx-[23px] mb-3 flex items-center gap-4 rounded-2xl bg-panel px-4 py-3 md:mx-8">

            <span className="flex min-w-0 grow flex-col gap-0.5">

              <span className="text-[13px] text-dim">{agent.name} needs you to</span>
              <span className="text-[15px]">{agent.question}</span>

            </span>

            <button type="button" className="shrink-0 text-[14px] text-dim hover:text-fg" onClick={() => this.props.onAnswer(false)}>Skip</button>

          </div>

        )}

        <div ref={this.box} className="relative flex min-h-0 grow items-center justify-center px-[23px] pb-4 md:px-8">

          {ready && error && <span role="status" className="absolute top-2 left-1/2 z-10 max-w-[80%] -translate-x-1/2 rounded-full bg-panel px-3.5 py-1.5 text-center text-[13px] text-dim">{error}</span>}

          <img
            ref={this.frame}
            alt={`${agent.name}'s browser`}
            draggable={false}
            onPointerDown={this.onPointerDown}
            onPointerMove={this.onPointerMove}
            onPointerUp={this.onPointerUp}
            onPointerCancel={() => (this.press = null)}
            onTouchEnd={this.onTouchEnd}
            onWheel={this.onWheel}
            className={`max-h-full max-w-full rounded-xl border select-none [-webkit-touch-callout:none] ${mine ? "[touch-action:pinch-zoom] border-fg/40 outline-none" : "border-line"} ${ready && !blank ? "" : "hidden"}`}
          />

          {!ready && <span className="text-[15px] text-dim">{error || "Opening the browser…"}</span>}
          {ready && blank && <span className="flex items-center gap-3 text-[15px] text-dim"><Glyph glyph={agent.glyph} size={22} live />Browser is suspended</span>}

        </div>

        {/* 16px stops iOS zooming in on focus */}
        {mine && <input ref={this.typer} value={typed} onChange={this.onType} onKeyDown={this.onTypeKey} autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false} aria-label="Type into the page" className="fixed top-0 left-0 size-px text-[16px] opacity-0" />}

      </div>

    );

  }

}
