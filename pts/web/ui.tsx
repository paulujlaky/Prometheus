import { ChevronLeft } from "lucide-react";
import { Component, Fragment, type ButtonHTMLAttributes, type ReactNode } from "react";

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

type Tone = "primary" | "quiet";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {

  tone?: Tone;

}

export class Button extends Component<ButtonProps> {

  render() {

    const { tone = "quiet", className = "", ...props } = this.props;
    const look = tone === "primary" ? "bg-fg text-ink font-medium" : "bg-transparent text-fg border border-line";

    return <button type="button" {...props} className={`h-11 rounded-xl px-5 text-[15px] disabled:opacity-40 ${look} ${className}`} />;

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
