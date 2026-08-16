/** Local calendar date key (`YYYY-MM-DD`). */
export function dayKey(d = new Date()): string {

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");

  return `${y}-${m}-${day}`;

}

/** Format run duration: whole seconds under 1m, then `m:ss min`. */
export function formatElapsed(ms: number): string {

  const totalSec = Math.max(0, Math.floor(ms / 1000));

  if (totalSec < 60) {

    return `${totalSec}s`;

  }

  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;

  return `${min}:${String(sec).padStart(2, "0")} min`;

}

/** Compact relative timestamp for sidebar rows. */
export function relativeTime(ts: number): string {

  if (!ts) {

    return "";

  }

  const ms = ts < 1e12 ? ts * 1000 : ts;
  const delta = Date.now() - ms;

  if (delta < 60_000) {

    return "just now";

  }

  if (delta < 3_600_000) {

    return `${Math.floor(delta / 60_000)}m`;

  }

  if (delta < 86_400_000) {

    return `${Math.floor(delta / 3_600_000)}h`;

  }

  if (delta < 7 * 86_400_000) {

    return `${Math.floor(delta / 86_400_000)}d`;

  }

  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

}
