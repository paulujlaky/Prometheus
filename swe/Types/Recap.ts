/** One finished run: what the agent wrote in `<recap>`, plus what the harness stamped on it. */
export interface RunRecap {

  id: string;

  headline: string;

  changed: string[];
  unverified: string[];

  risk: string;

  project: string;
  chatId: string | null;

  /** Human model label, already shortened for display. */
  model: string;

  at: number;
  durationMs: number;

  /** Snapshot commit this run started from, when git was available. */
  commit: string | null;

  added: number;
  removed: number;

}

/** The fields the agent itself supplies; everything else is filled in by the main process. */
export type RecapDraft = Pick<RunRecap, "headline" | "changed" | "unverified" | "risk">;

/** Normalized project root -> that repo's recaps, oldest first. */
export type RecapFile = Record<string, RunRecap[]>;
