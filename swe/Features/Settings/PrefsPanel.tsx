import { Component, createRef, type ReactNode } from "react";
import { motion } from "motion/react";
import { XIcon } from "lucide-react";

import { ModelPicker } from "@/Features/Chat/ModelPicker";
import { NumberField } from "@/Features/Settings/NumberField";

import { fade, popIn } from "@/Utils/Motion";
import { CMD_TIMEOUT_RANGE, MAX_STEPS_RANGE, type Preferences } from "@/Utils/Prefs";

import type { AssistantSummary } from "../../../sdk/types";

interface PrefsPanelProps {

  models: AssistantSummary[];

  onClose: () => void;
  onSaved: (prefs: Preferences) => void;

}

interface PrefsPanelState {

  prefs: Preferences | null;
  error: string | null;

}

export class PrefsPanel extends Component<PrefsPanelProps, PrefsPanelState> {

  state: PrefsPanelState = { prefs: null, error: null };

  private card = createRef<HTMLDivElement>();
  private restoreFocus: HTMLElement | null = null;
  private live = true;

  componentDidMount() {

    this.restoreFocus = document.activeElement as HTMLElement | null;
    this.live = true;

    void window.swe.prefs()
      .then((loaded) => {

        if (this.live) {

          this.setState({ prefs: loaded });

        }

      })
      .catch((err: unknown) => {

        if (this.live) {

          this.setState({ error: err instanceof Error ? err.message : String(err) });

        }

      });

    window.addEventListener("keydown", this.onKey);
    this.card.current?.focus();

  }

  componentWillUnmount() {

    this.live = false;

    window.removeEventListener("keydown", this.onKey);
    this.restoreFocus?.focus?.();

  }

  private onKey = (event: KeyboardEvent) => {

    if (event.key === "Escape") {

      this.props.onClose();

    }

  };

  private patch = (change: Partial<Preferences>) => {

    this.setState((prev) => ({ prefs: prev.prefs ? { ...prev.prefs, ...change } : prev.prefs }));

    void window.swe.setPrefs(change)
      .then((resolved) => {

        this.setState({ prefs: resolved });
        this.props.onSaved(resolved);

      })
      .catch((err: unknown) => this.setState({ error: err instanceof Error ? err.message : String(err) }));

  };

  render(): ReactNode {

    const { models, onClose } = this.props;
    const { prefs, error } = this.state;

    return (

      <motion.div className="fixed inset-0 z-50 flex items-center justify-center p-6"

        initial={fade.initial}
        animate={fade.animate}
        exit={fade.exit}

        transition={fade.transition}

      >

        <div className="absolute inset-0 bg-black/50"

          aria-hidden

          onMouseDown={onClose}

        />

        <motion.div className="settings-backdrop relative flex w-full max-w-md flex-col overflow-hidden rounded-card bg-canvas shadow-overlay outline-none"

          ref={this.card}

          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label="Settings"

          initial={popIn.initial}
          animate={popIn.animate}
          exit={popIn.exit}

          transition={popIn.transition}

        >

          <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">

            <h2 className="min-w-0 flex-1 text-[14px] font-medium text-ink">Settings</h2>

            <button className="flex size-7 items-center justify-center rounded-chip text-ink-3 transition-colors hover:bg-hover hover:text-ink"

              type="button"
              aria-label="Close settings"

              onClick={onClose}

            >

              <XIcon className="size-4" />

            </button>

          </div>

          {error && (

            <p className="border-b border-line bg-red-tint px-5 py-2.5 text-[12.5px] text-red">{error}</p>

          )}

          {!prefs ? (

            <p className="px-5 py-8 text-center text-[13px] text-ink-3">Loading…</p>

          ) : (

            <div className="flex flex-col gap-6 px-5 py-5">

              <section className="flex flex-col gap-2.5">

                <h3 className="text-[11px] font-medium tracking-wide text-ink-3">DEFAULT MODEL</h3>

                <ModelPicker

                  models={models}
                  value={prefs.defaultModelId}

                  onChange={(defaultModelId) => this.patch({ defaultModelId })}

                  allowNone
                  trigger="field"

                />

                <p className="text-[12px] leading-relaxed text-ink-3">

                  Applies to new sessions. Existing sessions are unchanged.

                </p>

              </section>

              <section className="flex flex-col gap-3.5">

                <h3 className="text-[11px] font-medium tracking-wide text-ink-3">AGENT LIMITS</h3>

                <NumberField

                  label="Max steps"
                  hint={`Turns before a run stops on its own (${MAX_STEPS_RANGE.min}–${MAX_STEPS_RANGE.max}).`}

                  value={prefs.maxSteps}
                  suffix=""

                  min={MAX_STEPS_RANGE.min}
                  max={MAX_STEPS_RANGE.max}

                  onCommit={(maxSteps) => this.patch({ maxSteps })}

                />

                <NumberField

                  label="Command timeout"
                  hint={`A single command is killed after this long (${CMD_TIMEOUT_RANGE.min / 1000}–${CMD_TIMEOUT_RANGE.max / 1000}).`}

                  value={Math.round(prefs.commandTimeoutMs / 1000)}
                  suffix="s"

                  min={CMD_TIMEOUT_RANGE.min / 1000}
                  max={CMD_TIMEOUT_RANGE.max / 1000}

                  onCommit={(seconds) => this.patch({ commandTimeoutMs: seconds * 1000 })}

                />

              </section>

            </div>

          )}

        </motion.div>

      </motion.div>

    );

  }

}
