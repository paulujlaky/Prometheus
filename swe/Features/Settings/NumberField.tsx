import { Component, type ChangeEvent, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "@/Utils/Class";
import { clamp } from "@/Utils/Prefs";

interface NumberFieldProps {

  label: string;
  hint: string;

  value: number;
  suffix: string;

  min: number;
  max: number;

  onCommit: (next: number) => void;

}

interface NumberFieldState {

  draft: string;

}

export class NumberField extends Component<NumberFieldProps, NumberFieldState> {

  state: NumberFieldState = { draft: String(this.props.value) };

  componentDidUpdate(prev: NumberFieldProps) {

    if (prev.value !== this.props.value && this.state.draft !== String(this.props.value)) {

      this.setState({ draft: String(this.props.value) });

    }

  }

  private commit = () => {

    const { min, max, value, onCommit } = this.props;
    const next = clamp(this.state.draft.trim(), { min, max }, value);

    this.setState({ draft: String(next) });

    if (next !== value) {

      onCommit(next);

    }

  };

  private onChange = (event: ChangeEvent<HTMLInputElement>) => {

    this.setState({ draft: event.target.value });

  };

  private onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {

    if (event.key === "Enter") {

      event.preventDefault();
      this.commit();

    }

    if (event.key === "Escape") {

      event.stopPropagation();
      this.setState({ draft: String(this.props.value) });

    }

  };

  render(): ReactNode {

    const { label, hint, suffix } = this.props;
    const { draft } = this.state;

    return (

      <label className="flex flex-col gap-1.5">

        <span className="flex items-baseline justify-between gap-4">

          <span className="text-[13.5px] text-ink">{label}</span>
          <span className="shrink-0 text-[12px] text-ink-3">{hint}</span>

        </span>

        <span className="relative flex w-full items-center">

          <input className={cn(

            "h-9 w-full rounded-chip border border-line bg-field px-2.5 text-left text-[13.5px] tabular-nums text-ink outline-none transition-colors focus:border-brand",
            suffix && "pr-10",

          )}

            type="text"
            inputMode="numeric"

            value={draft}
            aria-label={label}

            onChange={this.onChange}
            onBlur={this.commit}
            onKeyDown={this.onKeyDown}

          />

          {suffix ? (

            <span className="pointer-events-none absolute right-2.5 text-[12px] text-ink-3">{suffix}</span>

          ) : null}

        </span>

      </label>

    );

  }

}
