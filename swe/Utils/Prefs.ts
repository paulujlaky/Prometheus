// User (global) preferences.

export interface Preferences {

  /** Model new sessions open on. Null = fall back to the account's preferred assistant. */
  defaultModelId: string | null;

  /** Ceiling on model turns in one run. */
  maxSteps: number;

  /** Kill a single command after this long. */
  commandTimeoutMs: number;

}

// Defaults

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
