import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDownIcon, XIcon } from "lucide-react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger, } from "@/comps/ui/dropdown";

import { displayName, groupAssistants, providerOf } from "@/lib/models";
import { cn } from "@/lib/utils";
import { clamp, CMD_TIMEOUT_RANGE, MAX_STEPS_RANGE, type Preferences } from "@/lib/prefs";

import type { AssistantSummary } from "../sdk/types";

interface PrefsPanelProps {

  models: AssistantSummary[];

  onClose: () => void;

  /** Resolved values come back from main after clamping; the app adopts them without refetching. */
  onSaved: (prefs: Preferences) => void;

}

interface NumberFieldProps {

  label: string;
  hint: string;

  value: number;
  suffix: string;

  min: number;
  max: number;

  onCommit: (next: number) => void;

}

/**
 * Edits as text so a half-typed number is not clamped mid-keystroke, then commits on blur
 * or Enter. Escape puts the field back rather than leaving a rejected draft on screen.
 */
function NumberField({ label, hint, value, suffix, min, max, onCommit }: NumberFieldProps) {

  const [draft, setDraft] = useState(String(value));

  // a save elsewhere (or a clamp on the way back) is the authority, not the stale draft
  useEffect(() => {

    setDraft(String(value));

  }, [value]);

  const commit = useCallback(() => {

    const next = clamp(draft.trim(), { min, max }, value);

    setDraft(String(next));

    if (next !== value) {

      onCommit(next);

    }

  }, [draft, min, max, value, onCommit]);

  return (

    <label className="flex flex-col gap-1.5">

      <span className="flex items-baseline justify-between gap-4">

        <span className="text-[13.5px] text-ink">{label}</span>
        <span className="shrink-0 text-[12px] text-ink-3">{hint}</span>

      </span>

      {/* number left, unit pinned right: the two never collide as the value grows */}
      <span className="relative flex w-full items-center">

        <input
          type="text"
          inputMode="numeric"
          value={draft}
          aria-label={label}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {

            if (event.key === "Enter") {

              event.preventDefault();
              commit();

            }

            if (event.key === "Escape") {

              // the panel's own Escape handler would otherwise close the modal on a typo
              event.stopPropagation();
              setDraft(String(value));

            }

          }}
          className={cn(
            "h-9 w-full rounded-chip border border-line bg-field px-2.5 text-left text-[13.5px] tabular-nums text-ink outline-none transition-colors focus:border-brand",
            suffix && "pr-10",
          )}
        />

        {suffix ? (

          <span className="pointer-events-none absolute right-2.5 text-[12px] text-ink-3">{suffix}</span>

        ) : null}

      </span>

    </label>

  );

}

/**
 * The composer's picker, pointed at preferences. `groupAssistants` drops everything outside the
 * major providers and buckets the rest, so the two surfaces show the same short list without a
 * second filter here to keep in step with it.
 */
function ModelPicker({ models, value, onChange }: { models: AssistantSummary[]; value: string | null; onChange: (id: string | null) => void }) {

  const groups = groupAssistants(models);

  const selected = value ? models.find((assistant) => assistant.id === value) ?? null : null;
  const provider = selected ? providerOf(selected) : null;

  // a stored id that survived the model disappearing should say so, not show a blank trigger
  const label = value
    ? selected
      ? `${provider ? `${provider} · ` : ""}${displayName(selected.name)}${selected.kind === "agent" ? " · Agent" : ""}`
      : "Unavailable model"
    : "Use account preference";

  return (

    <DropdownMenu>

      <DropdownMenuTrigger asChild>

        <button
          type="button"
          disabled={groups.length === 0}
          className="flex h-9 w-full min-w-0 items-center gap-2 rounded-chip border border-line bg-field px-2.5 text-left text-[13.5px] text-ink transition-colors hover:border-line-strong disabled:opacity-50"
        >

          <span className={cn("min-w-0 flex-1 truncate", !selected && "text-ink-3")}>{label}</span>

          <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />

        </button>

      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-64 text-sm">

        <DropdownMenuRadioGroup value={value ?? ""} onValueChange={(next) => onChange(next || null)}>

          <DropdownMenuRadioItem value="">Use account preference</DropdownMenuRadioItem>

        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

        <DropdownMenuLabel className="text-sm">Provider</DropdownMenuLabel>

        {groups.map((group) => (

          <DropdownMenuSub key={group.provider}>

            <DropdownMenuSubTrigger>{group.provider}</DropdownMenuSubTrigger>

            <DropdownMenuSubContent className="w-72 text-sm">

              <DropdownMenuRadioGroup value={value ?? ""} onValueChange={(next) => onChange(next || null)}>

                {group.chat.length > 0 ? (

                  <>

                    <DropdownMenuLabel className="text-sm">Chat-Native</DropdownMenuLabel>

                    {group.chat.map((assistant) => (

                      <DropdownMenuRadioItem key={assistant.id} value={assistant.id}>

                        {displayName(assistant.name)}

                      </DropdownMenuRadioItem>

                    ))}

                  </>

                ) : null}

                {group.chat.length > 0 && group.agent.length > 0 ? <DropdownMenuSeparator /> : null}

                {group.agent.length > 0 ? (

                  <>

                    <DropdownMenuLabel className="text-sm">Agent</DropdownMenuLabel>

                    {group.agent.map((assistant) => (

                      <DropdownMenuRadioItem key={assistant.id} value={assistant.id}>

                        {displayName(assistant.name)}

                      </DropdownMenuRadioItem>

                    ))}

                  </>

                ) : null}

              </DropdownMenuRadioGroup>

            </DropdownMenuSubContent>

          </DropdownMenuSub>

        ))}

      </DropdownMenuContent>

    </DropdownMenu>

  );

}

export function PrefsPanel({ models, onClose, onSaved }: PrefsPanelProps) {

  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [error, setError] = useState<string | null>(null);

  const card = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {

    restoreFocus.current = document.activeElement as HTMLElement | null;

    let live = true;

    void window.swe.prefs()   .then((loaded) => {

        if (live) {

          setPrefs(loaded);

        }

      })
      .catch((err: unknown) => {

        if (live) {

          setError(err instanceof Error ? err.message : String(err));

        }

      });

    const onKey = (event: KeyboardEvent) => {

      if (event.key === "Escape") {

        onClose();

      }

    };

    window.addEventListener("keydown", onKey);
    card.current?.focus();

    return () => {

      live = false;

      window.removeEventListener("keydown", onKey);
      restoreFocus.current?.focus?.();

    };

  }, [onClose]);

  /** Send only what changed; main resolves and clamps, and its answer is what the panel shows. */
  const patch = useCallback((change: Partial<Preferences>) => {

    setPrefs((prev) => (prev ? { ...prev, ...change } : prev));

    void window.swe.setPrefs(change)
      .then((resolved) => {

        setPrefs(resolved);
        onSaved(resolved);

      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));

  }, [onSaved]);

  return (

    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ animation: "fade-in 120ms ease both" }}
    >

      {/* portaled menus live outside the card; only the dimmer itself is a dismiss */}
      <div aria-hidden className="absolute inset-0 bg-black/50" onMouseDown={onClose} />

      <div
        ref={card}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="settings-backdrop relative flex w-full max-w-md flex-col overflow-hidden rounded-card bg-canvas shadow-overlay outline-none"
        style={{ animation: "pop-in 160ms var(--ease-glide) both" }}
      >

        <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">

          <h2 className="min-w-0 flex-1 text-[14px] font-medium text-ink">Settings</h2>

          <button
            type="button"
            aria-label="Close settings"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-chip text-ink-3 transition-colors hover:bg-hover hover:text-ink"
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
                onChange={(defaultModelId) => patch({ defaultModelId })}
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
                onCommit={(maxSteps) => patch({ maxSteps })}
              />

              <NumberField
                label="Command timeout"
                hint={`A single command is killed after this long (${CMD_TIMEOUT_RANGE.min / 1000}–${CMD_TIMEOUT_RANGE.max / 1000}).`}
                value={Math.round(prefs.commandTimeoutMs / 1000)}
                suffix="s"
                min={CMD_TIMEOUT_RANGE.min / 1000}
                max={CMD_TIMEOUT_RANGE.max / 1000}
                onCommit={(seconds) => patch({ commandTimeoutMs: seconds * 1000 })}
              />

            </section>

          </div>

        )}

      </div>

    </div>

  );

}
