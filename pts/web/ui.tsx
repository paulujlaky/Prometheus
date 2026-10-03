import { Check, ChevronDown, ChevronLeft } from "lucide-react";
import { Component, createRef, Fragment, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

function inline(text: string): ReactNode[] {

  return text.split(INLINE).map((part, i) => {

    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {

      return <code key={i} className="rounded bg-raised px-1 py-0.5 font-mono text-[0.85em]">{part.slice(1, -1)}</code>;

    }

    if (part.startsWith("**") && part.endsWith("**") && part.length > 3) {

      return <strong key={i} className="font-medium">{part.slice(2, -2)}</strong>;

    }

    return <Fragment key={i}>{part}</Fragment>;

  });

}

/** Just enough markdown for what agents write: paragraphs, bullets, `code` and **bold**. */
export function Memo({ text, className = "" }: { text: string; className?: string }) {

  // runs of bullet lines become lists even when a paragraph sits directly above them, as agents often write
  const runs: { list: boolean; lines: string[] }[] = [];

  for (const block of text.trim().split(/\n\s*\n/)) {

    const start = runs.length;

    for (const line of block.split("\n")) {

      const list = BULLET.test(line);
      const last = runs.length > start ? runs[runs.length - 1] : null;

      if (last?.list === list) {

        last.lines.push(line);
        continue;

      }

      runs.push({ list, lines: [line] });

    }

  }

  return (

    <div className={`flex flex-col gap-3 font-serif text-[18px] leading-relaxed ${className}`}>

      {runs.map((run, i) => {

        if (run.list) {

          return (

            <ul key={i} className="m-0 flex list-disc flex-col gap-1.5 pl-5 marker:text-dim">

              {run.lines.map((line, j) => <li key={j}>{inline(line.replace(BULLET, ""))}</li>)}

            </ul>

          );

        }

        return <p key={i} className="m-0 whitespace-pre-line">{inline(run.lines.join("\n"))}</p>;

      })}

    </div>

  );

}

export function Torch({ size = 22 }: { size?: number }) {

  return <img src="/logo.png" alt="" width={size} height={size} className="shrink-0" />;

}

interface BarProps {

  title: ReactNode;
  subtitle?: ReactNode;

  back?: string;
  actions?: ReactNode;

}

/** A screen's top bar. `back` is where the chevron goes; leave it out on screens with nowhere to go back to. */
export function Bar({ title, subtitle, back, actions }: BarProps) {

  return (

    <header className="flex min-h-16 shrink-0 items-center gap-1 px-3 pt-[env(safe-area-inset-top)]">

      {back && (

        <a href={back} aria-label="Back" className="flex size-11 items-center justify-center rounded-xl text-fg lg:hidden">

          <ChevronLeft size={22} strokeWidth={1.75} />

        </a>

      )}

      <div className={`flex min-w-0 grow flex-col ${back ? "" : "pl-3"}`}>

        <span className="truncate font-serif text-[22px] leading-none">{title}</span>
        {subtitle && <span className="mt-1 truncate text-[13px] leading-none text-dim">{subtitle}</span>}

      </div>

      {actions}

    </header>

  );

}

type Tone = "primary" | "quiet" | "danger" | "destroy";

const TONES: Record<Tone, string> = {

  primary: "bg-fg text-ink font-medium",
  quiet: "bg-transparent text-fg border border-line",

  // danger points at something destructive; destroy is the button that actually does it
  danger: "bg-transparent text-danger border border-danger/40 hover:bg-danger/10",
  destroy: "bg-danger text-ink font-medium",

};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {

  tone?: Tone;

}

export class Button extends Component<ButtonProps> {

  render() {

    const { tone = "quiet", className = "", ...props } = this.props;

    return <button type="button" {...props} className={`h-11 rounded-xl px-5 text-[15px] disabled:opacity-40 ${TONES[tone]} ${className}`} />;

  }

}

export function IconButton({ label, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {

  return (

    <button type="button" aria-label={label} title={label} {...props} className="flex size-11 items-center justify-center rounded-xl text-dim hover:text-fg disabled:opacity-40">

      {children}

    </button>

  );

}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {

  return (

    <label className="flex flex-col gap-2">

      <span className="text-[14px] text-dim">{label}</span>
      {children}
      {hint && <span className="text-[13px] text-dim">{hint}</span>}

    </label>

  );

}

interface SectionProps {

  title: string;
  description?: ReactNode;

  /** Sits on the heading's row, right-aligned: a button, a switch, a select. */
  action?: ReactNode;

  children?: ReactNode;

}

export function Section({ title, description, action, children }: SectionProps) {

  return (

    <section className="flex flex-col gap-3">

      <div className="flex items-center gap-4">

        <div className="flex min-w-0 grow flex-col gap-0.5">

          <h2 className="m-0 font-serif text-[20px] leading-tight font-normal">{title}</h2>
          {description && <p className="m-0 text-[14px] text-dim">{description}</p>}

        </div>

        {action && <div className="shrink-0">{action}</div>}

      </div>

      {children}

    </section>

  );

}

export function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {

  return (

    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${checked ? "bg-fg" : "bg-raised"}`}>

      <span className={`absolute top-1 left-1 size-5 rounded-full transition-transform ${checked ? "translate-x-5 bg-ink" : "bg-dim"}`} />

    </button>

  );

}

interface ConfirmProps {

  open: boolean;

  title: string;
  body?: string;
  confirm: string;
  danger?: boolean;

  onConfirm: () => void;
  onCancel: () => void;

}

/** A native <dialog>: it already traps focus, closes on Escape and dims the page behind it. */
export class Confirm extends Component<ConfirmProps> {

  private dialog = createRef<HTMLDialogElement>();

  componentDidMount() {

    this.sync();

  }

  componentDidUpdate() {

    this.sync();

  }

  sync() {

    const dialog = this.dialog.current;

    if (this.props.open && !dialog?.open) {

      dialog?.showModal();

    }

    if (!this.props.open && dialog?.open) {

      dialog.close();

    }

  }

  render() {

    const { title, body, confirm, danger, onConfirm, onCancel } = this.props;

    return (

      <dialog ref={this.dialog} onCancel={(event) => { event.preventDefault(); onCancel(); }} onClick={(event) => event.target === event.currentTarget && onCancel()} className="m-auto w-[min(92vw,380px)] rounded-2xl border border-line bg-panel p-0 text-fg">

        <div className="flex flex-col gap-5 p-6">

          <div className="flex flex-col gap-1.5">

            <h2 className="m-0 font-serif text-[22px] leading-tight font-normal">{title}</h2>
            {body && <p className="m-0 text-[14px] text-dim">{body}</p>}

          </div>

          <div className="flex gap-2">

            <Button className="grow" onClick={onCancel} autoFocus>Cancel</Button>
            <Button className="grow" tone={danger ? "destroy" : "primary"} onClick={onConfirm}>{confirm}</Button>

          </div>

        </div>

      </dialog>

    );

  }

}

export interface Option {

  value: string;
  label: string;

}

interface SelectProps {

  label: string;
  value: string;
  options: Option[];

  onChange: (value: string) => void;

  /** Fills its row in a form; otherwise it hugs its label beside a heading. */
  wide?: boolean;
  disabled?: boolean;

}

interface SelectState {

  open: boolean;
  active: number;

}

/** A listbox in the app's style; the native one opens a platform menu that ignores the theme. */
export class Select extends Component<SelectProps, SelectState> {

  state: SelectState = { open: false, active: 0 };

  private root = createRef<HTMLDivElement>();
  private trigger = createRef<HTMLButtonElement>();
  private items: (HTMLLIElement | null)[] = [];

  componentDidMount() {

    document.addEventListener("pointerdown", this.onOutside);

  }

  componentWillUnmount() {

    document.removeEventListener("pointerdown", this.onOutside);

  }

  componentDidUpdate(_: SelectProps, previous: SelectState) {

    if (this.state.open && (!previous.open || previous.active !== this.state.active)) {

      this.items[this.state.active]?.focus();

    }

  }

  onOutside = (event: PointerEvent) => {

    if (this.state.open && !this.root.current?.contains(event.target as Node)) {

      this.setState({ open: false });

    }

  };

  openList = () => {

    const current = this.props.options.findIndex((option) => option.value === this.props.value);

    this.setState({ open: true, active: Math.max(0, current) });

  };

  choose = (index: number) => {

    const option = this.props.options[index];

    this.setState({ open: false });
    this.trigger.current?.focus();

    if (option && option.value !== this.props.value) {

      this.props.onChange(option.value);

    }

  };

  onTriggerKey = (event: KeyboardEvent) => {

    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {

      event.preventDefault();
      this.openList();

    }

  };

  onListKey = (event: KeyboardEvent) => {

    const last = this.props.options.length - 1;
    const moves: Record<string, number> = { ArrowDown: Math.min(last, this.state.active + 1), ArrowUp: Math.max(0, this.state.active - 1), Home: 0, End: last };

    if (event.key in moves) {

      event.preventDefault();
      this.setState({ active: moves[event.key] });
      return;

    }

    if (event.key === "Enter" || event.key === " ") {

      event.preventDefault();
      this.choose(this.state.active);
      return;

    }

    if (event.key === "Escape" || event.key === "Tab") {

      event.preventDefault();
      this.setState({ open: false });
      this.trigger.current?.focus();

    }

  };

  render() {

    const { label, value, options, wide, disabled } = this.props;
    const { open, active } = this.state;
    const current = options.find((option) => option.value === value);

    return (

      <div ref={this.root} className={`relative ${wide ? "w-full" : ""}`}>

        <button ref={this.trigger} type="button" aria-haspopup="listbox" aria-expanded={open} aria-label={label} disabled={disabled} onClick={() => (open ? this.setState({ open: false }) : this.openList())} onKeyDown={this.onTriggerKey} className={`flex h-11 items-center justify-between gap-3 rounded-xl border border-line bg-panel px-4 text-[15px] text-fg disabled:opacity-40 ${wide ? "w-full" : "max-w-56"}`}>

          <span className="truncate">{current?.label ?? "Choose…"}</span>
          <ChevronDown size={16} className={`shrink-0 text-dim transition-transform ${open ? "rotate-180" : ""}`} />

        </button>

        {open && (

          <ul role="listbox" aria-label={label} onKeyDown={this.onListKey} className="absolute top-full right-0 z-30 m-0 mt-1.5 flex max-h-72 min-w-full list-none flex-col overflow-y-auto rounded-xl border border-line bg-panel p-1 shadow-[0_16px_40px_rgb(0_0_0/0.5)]">

            {options.map((option, index) => (

              <li key={option.value} ref={(element) => { this.items[index] = element; }} role="option" tabIndex={-1} aria-selected={option.value === value} onClick={() => this.choose(index)} onPointerMove={() => index !== active && this.setState({ active: index })} className={`flex cursor-pointer items-center justify-between gap-6 rounded-lg px-3 py-2.5 text-[15px] whitespace-nowrap outline-none ${index === active ? "bg-raised" : ""}`}>

                {option.label}
                {option.value === value && <Check size={15} className="shrink-0" />}

              </li>

            ))}

          </ul>

        )}

      </div>

    );

  }

}

const AUTOSAVE_MS = 700;

/** Debounced saves keyed by field. `flush` runs whatever is still waiting, so leaving a screen never drops an edit. */
export class Autosave {

  private pending = new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => Promise<unknown> }>();

  constructor(private report: (note: string) => void) {}

  queue(key: string, run: () => Promise<unknown>) {

    clearTimeout(this.pending.get(key)?.timer);

    const timer = setTimeout(() => this.save(key), AUTOSAVE_MS);

    this.pending.set(key, { timer, run });

  }

  private save(key: string) {

    const job = this.pending.get(key);

    if (!job) {

      return;

    }

    this.pending.delete(key);
    job.run().then(() => this.report("Saved")).catch((err) => this.report(err instanceof Error ? err.message : String(err)));

  }

  flush() {

    for (const [key, job] of this.pending) {

      clearTimeout(job.timer);
      this.save(key);

    }

  }

}

export const inputClass ="w-full rounded-xl border border-line bg-panel px-4 py-3 text-[16px] text-fg outline-none placeholder:text-dim focus:border-dim";
