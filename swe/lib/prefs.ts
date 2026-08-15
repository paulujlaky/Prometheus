/**
 * Preference shape and bounds, with no node imports, so the renderer can hold the same
 * rules the main process enforces instead of a second copy that drifts out of step.
 *
 * Main clamps authoritatively on read and write — the renderer clamps only so the field
 * shows the value that is about to be stored rather than one the user has to be corrected on.
 */

export interface Preferences {

  /** Model new sessions open on. Null = fall back to the account's preferred assistant. */
  defaultModelId: string | null;

  /** Ceiling on model turns in one run. */
  maxSteps: number;

  /** Kill a single command after this long. */
  commandTimeoutMs: number;

}

/** Built-in defaults. Environment overrides are folded in by the main process, not here. */
export const BUILTIN_MAX_STEPS = 100;
export const BUILTIN_CMD_TIMEOUT_MS = 600_000;

export const MAX_STEPS_RANGE = { min: 1, max: 1000 } as const;
export const CMD_TIMEOUT_RANGE = { min: 5_000, max: 3_600_000 } as const;

/** Round into range, falling back when the input is not a usable number. */
export function clamp(value: unknown, range: { min: number; max: number }, fallback: number): number {

  const n = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(n)) {

    return fallback;

  }

  return Math.min(range.max, Math.max(range.min, Math.round(n)));

}
