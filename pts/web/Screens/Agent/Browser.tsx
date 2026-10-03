import { ArrowLeft } from "lucide-react";
import { Component, createRef, type ChangeEvent, type ClipboardEvent, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";

import { Button, IconButton, inputClass } from "../../Components/Controls";
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
  mine: boolean;
  error: string;

  typed: string;

}

// a pointer that moves further than this is scrolling or dragging, not tapping
const TAP_SLOP = 8;

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta"]);

// the typing row under the page while it is taken over
const CONTROLS_HEIGHT = 80;

/** One agent's browser, live. Watching is free; taking over pauses the agent's browser work until it is handed back. */
export class Browser extends Component<BrowserProps, BrowserState> {

  state: BrowserState = { ready: false, mine: false, error: "", typed: "" };

  private frame = createRef<HTMLImageElement>();
  private box = createRef<HTMLDivElement>();
  private unsubscribe = () => {};
  private shown = "";

  private press: { x: number; y: number; startX: number; startY: number; moved: boolean; mouse: boolean } | null = null;
  private scroll = { x: 0, y: 0, dx: 0, dy: 0, queued: false };

  componentDidMount() {

    this.unsubscribe = this.props.live.subscribe(this.onLive);
    this.props.live.send({ live: "watch", agentId: this.props.agent.id });

  }

  componentWillUnmount() {

    this.unsubscribe();
    this.props.live.send({ live: "unwatch" });
    URL.revokeObjectURL(this.shown);

  }

  onLive = (event: LiveEvent) => {

    if (event.agentId !== this.props.agent.id) {

      return;

    }

    if (event.type === "frame") {

      // straight onto the element: ten frames a second through state would re-render for nothing
      const previous = this.shown;

      this.shown = URL.createObjectURL(event.data);

      if (this.frame.current) {

        this.frame.current.src = this.shown;

      }

      URL.revokeObjectURL(previous);

      if (!this.state.ready) {

        this.setState({ ready: true, error: "" });

      }

      return;

    }

    this.setState((state) => ({ mine: event.mine ?? state.mine, error: event.error ?? state.error }));

  };

  input = (event: LiveInput) => this.props.live.send({ live: "input", event });

  /** On a phone the page is resized to fit, leaving room for the typing row that appears once it is ours. */
  take = () => {

    const box = this.box.current;

    if (box && innerWidth < 768) {

      const gutter = parseFloat(getComputedStyle(box).paddingLeft) * 2;

      this.props.live.send({ live: "take", width: box.clientWidth - gutter, height: box.clientHeight - CONTROLS_HEIGHT });
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

      const { x, y, dx, dy } = this.scroll;
      const cap = (value: number) => Math.max(-10, Math.min(10, value));

      this.scroll = { x, y, dx: 0, dy: 0, queued: false };
      this.input({ kind: "scroll", x, y, dx: cap(dx), dy: cap(dy) });

    });

  }

  onPointerDown = (event: PointerEvent<HTMLImageElement>) => {

    if (!this.state.mine) {

      return;

    }

    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    this.press = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false, mouse: event.pointerType === "mouse" };

  };

  /** A finger drags to scroll; a mouse drags for real, which is what a slider captcha needs. */
  onPointerMove = (event: PointerEvent<HTMLImageElement>) => {

    const press = this.press;

    if (!press) {

      return;

    }

    if (!press.moved && Math.hypot(event.clientX - press.startX, event.clientY - press.startY) < TAP_SLOP) {

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

  };

  onWheel = (event: WheelEvent<HTMLImageElement>) => {

    if (this.state.mine) {

      this.queueScroll(event.clientX, event.clientY, event.deltaX, event.deltaY);

    }

  };

  /** A keyboard on the frame itself: printable keys as text, the rest as Playwright key names like Control+a. */
  onKeyDown = (event: KeyboardEvent<HTMLImageElement>) => {

    const paste = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v";

    // a paste is left to the browser, so it arrives as onPaste with this machine's clipboard rather than the server's
    if (!this.state.mine || MODIFIERS.has(event.key) || paste) {

      return;

    }

    event.preventDefault();

    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {

      this.input({ kind: "text", text: event.key });
      return;

    }

    const held = [event.ctrlKey && "Control", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Meta"].filter(Boolean);

    this.input({ kind: "key", key: [...held, event.key === " " ? "Space" : event.key].join("+") });

  };

  onPaste = (event: ClipboardEvent<HTMLImageElement>) => {

    const text = event.clipboardData.getData("text").slice(0, 2000);

    if (this.state.mine && text) {

      event.preventDefault();
      this.input({ kind: "text", text });

    }

  };

  /** Phones type into a real field; each change goes to the page as the keys that would make it. */
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

  onTypeKey = (event: KeyboardEvent<HTMLInputElement>) => {

    if (event.key === "Enter" || event.key === "Tab") {

      event.preventDefault();
      this.input({ kind: "key", key: event.key });
      this.setState({ typed: "" });
      return;

    }

    // an empty field has nothing to delete, so the change event never fires
    if (event.key === "Backspace" && !this.state.typed) {

      this.input({ kind: "key", key: "Backspace" });

    }

  };

  render() {

    const { agent } = this.props;
    const { ready, mine, error, typed } = this.state;
    const handoff = agent.state === "waiting" && agent.waitingOn === "handoff";

    return (

      <div className="flex h-full flex-col">

        <Bar
          back={`#/agent/${agent.id}`}
          icon={<Glyph glyph={agent.glyph} size={30} live={agent.state === "running" || agent.state === "waiting"} />}
          title={agent.name}
          actions={<Button tone={mine ? "primary" : "quiet"} className="ml-2 shrink-0" onClick={mine ? () => this.props.live.send({ live: "give" }) : this.take}>{mine ? "Hand back" : "Take over"}</Button>}
        />

        {handoff && (

          <div className="mx-[23px] mb-3 flex items-center gap-4 rounded-2xl bg-panel px-4 py-3 md:mx-8">

            <span className="flex min-w-0 grow flex-col gap-0.5">

              <span className="text-[13px] text-dim">{agent.name} needs you to</span>
              <span className="text-[15px]">{agent.question}</span>

            </span>

            <button type="button" className="shrink-0 text-[14px] text-dim hover:text-fg" onClick={() => this.props.onAnswer(false)}>Skip</button>

          </div>

        )}

        <div ref={this.box} className="flex min-h-0 grow items-center justify-center px-[23px] pb-4 md:px-8">

          <img
            ref={this.frame}
            alt={`${agent.name}'s browser`}
            tabIndex={mine ? 0 : -1}
            draggable={false}
            onPointerDown={this.onPointerDown}
            onPointerMove={this.onPointerMove}
            onPointerUp={this.onPointerUp}
            onPointerCancel={() => (this.press = null)}
            onWheel={this.onWheel}
            onKeyDown={this.onKeyDown}
            onPaste={this.onPaste}
            className={`max-h-full max-w-full rounded-xl border select-none [-webkit-touch-callout:none] ${mine ? "touch-none border-fg/40 outline-none" : "border-line"} ${ready ? "" : "hidden"}`}
          />

          {!ready && <span className="text-[15px] text-dim">{error || "Opening the browser…"}</span>}

        </div>

        {mine && (

          <div className="flex items-center gap-1 border-t border-line px-[23px] pt-3 pb-[max(12px,env(safe-area-inset-bottom))] md:px-8">

            <IconButton label="Back" onClick={() => this.input({ kind: "back" })}><ArrowLeft size={19} strokeWidth={1.75} /></IconButton>
            <input value={typed} onChange={this.onType} onKeyDown={this.onTypeKey} autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false} placeholder="Type into the page" aria-label="Type into the page" className={inputClass} />

          </div>

        )}

      </div>

    );

  }

}
