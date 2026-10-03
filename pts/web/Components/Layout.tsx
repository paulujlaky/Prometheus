import { ChevronLeft } from "lucide-react";
import { Component, createRef, type ReactNode } from "react";

import { Button } from "./Controls";

export function Torch({ size = 22 }: { size?: number }) {

  return <img src="/brand/logo.png" alt="" width={size} height={size} className="shrink-0" />;

}

interface BarProps {

  title: ReactNode;
  icon?: ReactNode;
  subtitle?: ReactNode;

  back?: string;
  actions?: ReactNode;

}

/** A screen's top bar. `back` is where the chevron goes; leave it out on screens with nowhere to go back to. */
export function Bar({ title, icon, subtitle, back, actions }: BarProps) {

  return (

    <header className="flex min-h-16 shrink-0 items-center gap-1 px-3 pt-[env(safe-area-inset-top)]">

      {back && (

        <a href={back} aria-label="Back" className="flex size-11 items-center justify-center rounded-xl text-fg lg:hidden">

          <ChevronLeft size={22} strokeWidth={1.75} />

        </a>

      )}

      {icon && <span className={`mr-2.5 flex ${back ? "" : "ml-3"}`}>{icon}</span>}

      <div className={`flex min-w-0 grow flex-col ${back || icon ? "" : "pl-3"}`}>

        <span className="truncate font-serif text-[22px] leading-none">{title}</span>
        {subtitle && <span className="mt-1 truncate text-[13px] leading-none text-dim">{subtitle}</span>}

      </div>

      {actions}

    </header>

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
