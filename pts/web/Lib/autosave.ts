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
