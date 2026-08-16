import { Component, createRef, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import { ArrowUpIcon, FastForwardIcon, PaperclipIcon, SquareIcon, UploadIcon, XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { ModelPicker } from "@/Features/Chat/ModelPicker";

import { formatTokens } from "@/Utils/Tokens";
import { cn } from "@/Utils/Class";
import { fade, slideIn } from "@/Utils/Motion";
import { fileName } from "@/Utils/Paths";

import type { AssistantSummary } from "../../../sdk/types";

interface ComposerProps {

  assistants: AssistantSummary[];
  assistantId: string | null;

  busy: boolean;
  disabled: boolean;

  placeholder: string;
  disabledPlaceholder: string;

  /** 0–1 estimated context fill; drawn as a ring around Stop while busy. */
  contextRatio?: number;
  contextUsed?: number;
  contextLimit?: number;

  onModelChange: (id: string) => void;
  onSend: (task: string, imagePaths: string[]) => void;
  onStop: () => void;
  onSpeedUp?: () => void;

  /** Wall-clock start of the live run; Speed Up appears after SPEED_UP_AFTER_MS. */
  startedAt?: number | null;

  /** Open a multi-file picker; return absolute paths. */
  onPickImages?: () => Promise<string[]>;
  onFiles?: (files: File[]) => Promise<string[]>;

}

interface ComposerState {

  text: string;

  /** Absolute paths queued for upload with the next send. */
  attachments: string[];

  /** A file drag is over the composer — drives the drop veil. */
  dragging: boolean;

  /** Paths added by the last drop/paste; animated in, then cleared. */
  landed: string[];

  now: number;

  /** When Speed Up was last pressed; gates the cooldown. */
  spedUpAt: number | null;

  /** Bumped per press to remount the icon and replay its nudge. */
  pulse: number;

}

const MAX_HEIGHT = 190;

const SPEED_UP_AFTER_MS = 150_000;

const SPEED_UP_COOLDOWN_MS = 60_000;

/** Circular progress around the Stop control — track is always visible; arc fills with context use. */
function ContextRing({ ratio, used, limit, onStop, canSend }: { ratio: number; used?: number; limit?: number; onStop: () => void; canSend: boolean }) {

  const size = 38;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;

  const pct = Math.min(1, Math.max(0, ratio));
  const hot = pct >= 0.85;
  const warm = pct >= 0.6;

  const title = used != null && limit != null ? `Context ~${formatTokens(used)} / ${formatTokens(limit)}` : "Context usage";

  return (

    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }} title={title}>

      <svg className="pointer-events-none absolute inset-0 -rotate-90" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>

        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line-strong)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} stroke={hot ? "var(--red)" : warm ? "var(--orange)" : "var(--ink-2)"} className="transition-[stroke-dashoffset] duration-300" />

      </svg>

      <button type={canSend ? "submit" : "button"} aria-label={canSend ? "Send note" : "Stop"} title={canSend ? "Send note to the agent" : undefined}

        onClick={canSend ? undefined : onStop}

        className={cn(

          "relative flex size-8 items-center justify-center rounded-full transition-[transform,background-color,color] duration-200 active:scale-[0.96]",
          canSend ? "bg-ink text-page" : "text-ink hover:bg-hover",

        )}

      >

        {canSend ? <ArrowUpIcon className="size-4.5" strokeWidth={2.4} /> : <SquareIcon className="size-3.5 fill-current stroke-none" />}

      </button>

    </div>

  );

}



export class Composer extends Component<ComposerProps, ComposerState> {

  state: ComposerState = { text: "", attachments: [], dragging: false, landed: [], now: Date.now(), spedUpAt: null, pulse: 0 };

  private input = createRef<HTMLTextAreaElement>();

  /** dragenter/dragleave fire per child — count them so the veil does not flicker. */
  private dragDepth = 0;

  private landTimer: ReturnType<typeof setTimeout> | null = null;

  private clock: ReturnType<typeof setInterval> | null = null;

  componentDidMount() {

    this.syncClock();

  }

  componentWillUnmount() {

    if (this.landTimer) {

      clearTimeout(this.landTimer);

    }

    if (this.clock) {

      clearInterval(this.clock);

    }

  }

  componentDidUpdate(prev: ComposerProps, prevState: ComposerState) {

    if (prevState.text !== this.state.text) {

      this.resize();

    }

    if (prev.busy !== this.props.busy || prev.startedAt !== this.props.startedAt) {

      this.syncClock();

    }

    if (prev.startedAt !== this.props.startedAt && this.state.spedUpAt != null) {

      this.setState({ spedUpAt: null });

    }

  }

  private syncClock() {

    const need = this.props.busy && this.props.startedAt != null && Boolean(this.props.onSpeedUp);

    if (need && !this.clock) {

      this.setState({ now: Date.now() });
      this.clock = setInterval(() => this.setState({ now: Date.now() }), 1000);

    }

    if (!need && this.clock) {

      clearInterval(this.clock);
      this.clock = null;

    }

  }

  /** Grow with the draft up to a cap, then scroll — a fixed rows= wastes the panel. */
  private resize() {

    const node = this.input.current;

    if (!node) {

      return;

    }

    node.style.height = "0px";

    const content = node.scrollHeight;

    node.style.height = `${Math.min(Math.max(content, 28), MAX_HEIGHT)}px`;
    node.style.overflowY = content > MAX_HEIGHT ? "auto" : "hidden";

  }

  private submit = (event?: FormEvent) => {

    event?.preventDefault();

    const task = this.state.text.trim();
    const { attachments } = this.state;

    // busy only swaps the send control for stop — typing and interjections stay open
    if ((!task && !attachments.length) || this.props.disabled) {

      return;

    }

    // images alone still need a short instruction so the harness has something to do
    const payload = task || (attachments.length ? "Use the attached image(s) for this task." : "");

    if (!payload) {

      return;

    }

    this.props.onSend(payload, attachments);
    this.setState({ text: "", attachments: [], landed: [] });

  };

  private speedUp = (event: MouseEvent<HTMLButtonElement>) => {

    event.stopPropagation();

    const { spedUpAt } = this.state;

    if (spedUpAt != null && Date.now() - spedUpAt < SPEED_UP_COOLDOWN_MS) {

      return;

    }

    this.setState((prev) => ({ spedUpAt: Date.now(), pulse: prev.pulse + 1, now: Date.now() }));

    this.props.onSpeedUp?.();

  };

  private onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {

    if (event.key === "Enter" && !event.shiftKey) {

      event.preventDefault();
      this.submit();

    }

  };

  private pickImages = async () => {

    if (!this.props.onPickImages || this.props.disabled) {

      return;

    }

    const paths = await this.props.onPickImages();

    if (!paths?.length) {

      return;

    }

    this.setState((prev) => ({

      attachments: [...new Set([...prev.attachments, ...paths])],

    }));

  };

  private removeAttachment = (path: string) => {

    this.setState((prev) => ({

      attachments: prev.attachments.filter((p) => p !== path),

    }));

  };

  private addFiles = async (files: File[]) => {

    if (this.props.disabled || !this.props.onFiles) return;
    const images = files.filter((file) => file.type.startsWith("image/"));

    if (!images.length) return;
    const paths = await this.props.onFiles(images);

    // only the genuinely new paths animate — re-dropping a queued file should not re-fire
    this.setState(

      (prev) => ({

        attachments: [...new Set([...prev.attachments, ...paths])],
        landed: paths.filter((path) => !prev.attachments.includes(path)),

      }),

      () => {

        if (this.landTimer) clearTimeout(this.landTimer);
        this.landTimer = setTimeout(() => this.setState({ landed: [] }), 420);

      },

    );

  };

  /** Ignore text/selection drags — the veil is only for files. */
  private hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");

  private onDragEnter = (event: DragEvent) => {

    if (this.props.disabled || !this.hasFiles(event)) return;

    event.preventDefault();
    this.dragDepth += 1;

    if (!this.state.dragging) {

      this.setState({ dragging: true });

    }

  };

  private onDragOver = (event: DragEvent) => {

    event.preventDefault();

    if (!this.props.disabled && this.hasFiles(event)) {

      event.dataTransfer.dropEffect = "copy";

    }

  };

  private onDragLeave = (event: DragEvent) => {

    if (!this.hasFiles(event)) return;

    this.dragDepth = Math.max(0, this.dragDepth - 1);

    if (this.dragDepth === 0) {

      this.setState({ dragging: false });

    }

  };

  private onDrop = (event: DragEvent) => {

    event.preventDefault();

    this.dragDepth = 0;
    this.setState({ dragging: false });

    void this.addFiles(Array.from(event.dataTransfer.files));

  };

  private onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {

    const files = Array.from(event.clipboardData.files);
    if (files.some((file) => file.type.startsWith("image/"))) {

      event.preventDefault();
      void this.addFiles(files);

    }

  };

  render() {

    const { assistants, assistantId, busy, disabled, placeholder, disabledPlaceholder, contextRatio = 0, contextUsed, contextLimit, startedAt, onModelChange, onStop, onSpeedUp, onPickImages } = this.props;

    const { text, attachments, dragging, landed, now, spedUpAt, pulse } = this.state;

    const drafted = text.trim().length > 0;
    const canSend = !disabled && (drafted || attachments.length > 0);
    const showAttach = Boolean(onPickImages && drafted);

    const showSpeedUp = Boolean(onSpeedUp && busy && !canSend && startedAt != null && now - startedAt >= SPEED_UP_AFTER_MS);

    const cooldownLeft = spedUpAt != null ? Math.max(0, SPEED_UP_COOLDOWN_MS - (now - spedUpAt)) : 0;
    const cooling = cooldownLeft > 0;

    return (

      <form className="mx-auto w-full max-w-3xl shrink-0 px-5 pb-5" onSubmit={this.submit} onDragEnter={this.onDragEnter} onDragOver={this.onDragOver} onDragLeave={this.onDragLeave} onDrop={this.onDrop}>

        <div role="presentation" onClick={() => this.input.current?.focus()}

          className={cn(

            "relative flex cursor-text flex-col gap-2.5 rounded-window border border-line bg-field p-3 transition-[border-color,transform] duration-150 focus-within:border-line-strong",
            dragging ? "animate-drop-ring scale-[1.01] border-brand/70" : "shadow-card",

          )}

        >

          <AnimatePresence>

            {dragging ? (

              <motion.div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-1.5 rounded-window bg-page/78 backdrop-blur-[2px]"

                initial={fade.initial}
                animate={fade.animate}
                exit={fade.exit}

                transition={fade.transition}

              >

                <UploadIcon className="size-5 text-brand-ink" strokeWidth={2.2} />

                <span className="text-[12.5px] font-medium text-ink-2">Drop images to attach</span>

              </motion.div>

            ) : null}

          </AnimatePresence>

          {attachments.length > 0 ? (

            <div className="flex flex-wrap gap-1.5 px-1 pb-2">

              {attachments.map((path) => (

                <motion.span className="inline-flex max-w-full items-center gap-1 rounded-control border border-line bg-inset px-2 py-0.5 text-[12px] text-ink-2"

                  key={path}

                  initial={landed.includes(path) ? { opacity: 0, scale: 0.92, y: 4 } : false}
                  animate={{ opacity: 1, scale: 1, y: 0 }}

                  transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}

                >

                  <span className="min-w-0 truncate" title={path}>{fileName(path)}</span>

                  <button className="shrink-0 rounded p-0.5 text-ink-3 hover:bg-hover hover:text-ink disabled:opacity-50"

                    type="button"
                    aria-label={`Remove ${fileName(path)}`}

                    disabled={disabled}

                    onClick={(e) => { e.stopPropagation(); this.removeAttachment(path); }}

                  >

                    <XIcon className="size-3" />

                  </button>

                </motion.span>

              ))}

            </div>

          ) : null}

          <textarea className="min-h-7 w-full resize-none bg-transparent px-1 text-[14.5px] leading-normal text-ink outline-none placeholder:text-ink-3 disabled:opacity-60"

            ref={this.input}

            value={text}
            disabled={disabled}

            placeholder={disabled ? disabledPlaceholder : placeholder}

            rows={1}

            onChange={(event) => this.setState({ text: event.target.value })}
            onKeyDown={this.onKeyDown}
            onPaste={this.onPaste}

          />

          <div className="flex items-center justify-between gap-2">

            <ModelPicker

              models={assistants}
              value={assistantId}

              onChange={(id) => { if (id) onModelChange(id); }}

              disabled={disabled}
              trigger="ghost"

            />

            <div className="flex shrink-0 items-center gap-1">

              <AnimatePresence initial={false}>

                {showAttach ? (

                  <motion.button className="flex size-8 shrink-0 items-center justify-center rounded-control text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink disabled:opacity-50"

                    key="attach"
                    type="button"
                    aria-label="Attach files"

                    disabled={disabled}

                    onClick={(e) => { e.stopPropagation(); void this.pickImages(); }}

                    initial={slideIn.initial}
                    animate={slideIn.animate}
                    exit={slideIn.exit}

                    transition={slideIn.transition}

                    title="Attach images or files"

                  >

                    <PaperclipIcon className="size-4" />

                  </motion.button>

                ) : null}

              </AnimatePresence>

              <AnimatePresence initial={false}>

                {showSpeedUp ? (

                  <motion.button className="flex size-8 shrink-0 items-center justify-center rounded-control text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-40"

                    key="speed-up"
                    type="button"
                    aria-label="Speed up"

                    disabled={cooling}
                    onClick={this.speedUp}

                    initial={slideIn.initial}
                    animate={slideIn.animate}
                    exit={slideIn.exit}

                    transition={slideIn.transition}

                    whileTap={cooling ? undefined : { scale: 0.88 }}

                    title={cooling ? `Speed up available in ${Math.ceil(cooldownLeft / 1000)}s` : "Tell the agent this is taking too long..."}

                  >

                    <motion.span key={pulse} initial={{ x: -2.5 }} animate={{ x: 0 }} transition={{ type: "spring", stiffness: 520, damping: 13 }} className="flex items-center justify-center">

                      <FastForwardIcon className="size-4 translate-x-[0.5px]" strokeWidth={2.2} />

                    </motion.span>

                  </motion.button>

                ) : null}

              </AnimatePresence>

              {busy ? (

                <ContextRing ratio={contextRatio} used={contextUsed} limit={contextLimit} onStop={onStop} canSend={canSend} />

              ) : (

                <button type="submit" aria-label="Send" disabled={!canSend}

                    className={cn(

                      "flex size-8 items-center justify-center rounded-full transition-[background-color,color,transform] duration-200",
                      canSend ? "bg-ink text-page active:scale-[0.96]" : "bg-line-strong text-ink-3",

                    )}

                >

                  <ArrowUpIcon className="size-4.5" strokeWidth={2.4} />

                </button>

              )}

            </div>

          </div>

        </div>

      </form>

    );

  }

}
