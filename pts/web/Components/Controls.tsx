import { Check, ChevronDown } from "lucide-react";
import { Component, createRef, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";

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

export function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {

  return (

    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${checked ? "bg-fg" : "bg-raised"}`}>

      <span className={`absolute top-1 left-1 size-5 rounded-full transition-transform ${checked ? "translate-x-5 bg-ink" : "bg-dim"}`} />

    </button>

  );

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

export const inputClass = "w-full rounded-xl border border-line bg-panel px-4 py-3 text-[16px] text-fg outline-none placeholder:text-dim focus:border-dim";
