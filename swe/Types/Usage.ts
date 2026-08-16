/** model label -> estimated tokens for that day */
export type DayModels = Record<string, number>;

/** `YYYY-MM-DD` -> per-model totals */
export type UsageFile = Record<string, DayModels>;
