import { Component, type FocusEvent, type MouseEvent, type ReactNode } from "react";

import { formatTokens } from "@/lib/tokens";
import { cn } from "@/lib/utils";

/** model label and estimated tokens for that day */
export type DayModels = Record<string, number>;

/** `YYYY-MM-DD` and per-model totals */
export type UsageFile = Record<string, DayModels>;

/** Week columns shown; rightmost is the current week. */
const WEEKS = 14;

const HOVER_SHOW_MS = 120;
const HOVER_HIDE_MS = 60;

function dayKey(d: Date): string {

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");

  return `${y}-${m}-${day}`;

}

function startOfDay(d: Date): Date {

  return new Date(d.getFullYear(), d.getMonth(), d.getDate());

}

function dayTotal(models: DayModels | undefined): number {

  if (!models) {

    return 0;

  }

  let sum = 0;

  for (const n of Object.values(models)) {

    sum += n;

  }

  return sum;

}

/** 0 empty · 1–4 intensity steps from the day's share of the window max. */
function intensity(total: number, max: number): number {

  if (total <= 0 || max <= 0) {

    return 0;

  }

  const r = total / max;

  if (r < 0.15) return 1;
  if (r < 0.35) return 2;
  if (r < 0.6) return 3;

  return 4;

}

const CELL: Record<number, string> = {

  0: "bg-[#2a2c30]",
  1: "bg-brand/30",
  2: "bg-brand/50",
  3: "bg-brand/75",
  4: "bg-brand",

};

interface Cell {

  key: string | null;
  total: number;
  models: DayModels;
  /** After today — still drawn so the grid stays rectangular. */
  future: boolean;

}

type HoverTip = { key: string; total: number; models: DayModels; x: number; y: number };

/**
 * Fixed rectangle: rows = Sun–Sat, columns = weeks left→right (recent on the right).
 */
function recentGrid(usage: UsageFile, now = new Date()): { weeks: Cell[][]; max: number; total: number } {

  const today = startOfDay(now);
  const dow = today.getDay();

  // Sunday of the leftmost week
  const origin = new Date(today);

  origin.setDate(today.getDate() - dow - (WEEKS - 1) * 7);

  const weeks: Cell[][] = [];
  let max = 0;
  let total = 0;

  for (let w = 0; w < WEEKS; w += 1) {

    const col: Cell[] = [];

    for (let d = 0; d < 7; d += 1) {

      const date = new Date(origin);

      date.setDate(origin.getDate() + w * 7 + d);

      const future = date.getTime() > today.getTime();
      const key = future ? null : dayKey(date);
      const models = key ? (usage[key] ?? {}) : {};
      const n = dayTotal(models);

      if (!future) {

        total += n;
        max = Math.max(max, n);

      }

      col.push({ key, total: n, models, future });

    }

    weeks.push(col);

  }

  return { weeks, max, total };

}

function modelRows(models: DayModels): { name: string; tokens: number }[] {

  return Object.entries(models).filter(([, n]) => n > 0).map(([name, tokens]) => ({ name, tokens })).sort((a, b) => b.tokens - a.tokens);

}

function shortDate(key: string): string {

  const [y, mo, d] = key.split("-").map(Number);
  const date = new Date(y!, mo! - 1, d!);

  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });

}

function tipFromEvent(cell: Cell, e: MouseEvent<HTMLButtonElement> | FocusEvent<HTMLButtonElement>): HoverTip | null {

  if (!cell.key || cell.future) {

    return null;

  }

  const rect = e.currentTarget.getBoundingClientRect();
  const parent = e.currentTarget.closest("[data-heatmap]")?.getBoundingClientRect();
  const x = rect.left + rect.width / 2 - (parent?.left ?? 0);
  const y = rect.top - (parent?.top ?? 0);

  return { key: cell.key, total: cell.total, models: cell.models, x, y };

}

interface UsageHeatmapProps {

  usage: UsageFile;

}

interface UsageHeatmapState {

  hover: HoverTip | null;

}

export class UsageHeatmap extends Component<UsageHeatmapProps, UsageHeatmapState> {

  state: UsageHeatmapState = { hover: null };

  private showTimer: ReturnType<typeof setTimeout> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  componentWillUnmount() {

    this.clearTimers();

  }

  private clearTimers() {

    if (this.showTimer) {

      clearTimeout(this.showTimer);
      this.showTimer = null;

    }

    if (this.hideTimer) {

      clearTimeout(this.hideTimer);
      this.hideTimer = null;

    }

  }

  private onEnter = (cell: Cell, e: MouseEvent<HTMLButtonElement> | FocusEvent<HTMLButtonElement>) => {

    const next = tipFromEvent(cell, e);

    if (!next) {

      return;

    }

    if (this.hideTimer) {

      clearTimeout(this.hideTimer);
      this.hideTimer = null;

    }

    // already open — snap to the new cell without re-waiting
    if (this.state.hover) {

      if (this.showTimer) {

        clearTimeout(this.showTimer);
        this.showTimer = null;

      }

      this.setState({ hover: next });

      return;

    }

    if (this.showTimer) {

      clearTimeout(this.showTimer);

    }

    this.showTimer = setTimeout(() => {

      this.showTimer = null;
      this.setState({ hover: next });

    }, HOVER_SHOW_MS);

  };

  private onLeave = () => {

    if (this.showTimer) {

      clearTimeout(this.showTimer);
      this.showTimer = null;

    }

    if (this.hideTimer) {

      clearTimeout(this.hideTimer);

    }

    this.hideTimer = setTimeout(() => {

      this.hideTimer = null;
      this.setState({ hover: null });

    }, HOVER_HIDE_MS);

  };

  render(): ReactNode {

    const { usage } = this.props;
    const { hover } = this.state;

    const { weeks, max, total } = recentGrid(usage);
    const models = hover ? modelRows(hover.models) : [];

    return (

      <div data-heatmap className="relative mx-auto w-fit animate-fade-up">

        <div className="w-fit rounded-[12px] border border-line/40 bg-inset px-4 pt-3.5 pb-4">

          <div className="mb-3 flex items-baseline justify-between gap-5">

            <span className="text-[12px] font-medium text-ink-3">Your usage</span>
            <span className="font-mono text-[12px] text-ink-3 tabular-nums">

              {total > 0 ? `~${formatTokens(total)}` : "—"}

            </span>

          </div>

          <div className="flex gap-1">

            {weeks.map((week, wi) => (

              <div key={wi} className="flex flex-col gap-1">

                {week.map((cell, di) => {

                  if (cell.future || !cell.key) {

                    return (

                      <div

                        key={`f-${wi}-${di}`}
                        className={cn("size-3.25 rounded-[3px]", CELL[0], "opacity-35")}

                      />

                    );

                  }

                  const level = intensity(cell.total, max);
                  const active = hover?.key === cell.key;

                  return (

                    <button key={cell.key} type="button" aria-label={`${cell.key}: ${formatTokens(cell.total)} tokens`}

                      onMouseEnter={(e) => this.onEnter(cell, e)}
                      onMouseLeave={this.onLeave}
                      onFocus={(e) => this.onEnter(cell, e)}
                      onBlur={this.onLeave}

                      className={cn(

                        "size-3.25 rounded-[3px] outline-none transition-[transform,filter] duration-100",
                        CELL[level],
                        active && "scale-110 brightness-110",

                      )}

                    />

                  );

                })}

              </div>

            ))}

          </div>

        </div>

        {hover ? (

          <div className="pointer-events-none absolute z-10 min-w-36 -translate-x-1/2 -translate-y-full rounded-control bg-[#222427] px-3 py-2 shadow-raised animate-fade-in" style={{ left: hover.x, top: hover.y - 8 }} >

            <div className="flex items-baseline justify-between gap-4">

              <span className="text-[12px] text-ink-2">{shortDate(hover.key)}</span>
              <span className="font-mono text-[12px] text-ink tabular-nums">

                {hover.total > 0 ? `~${formatTokens(hover.total)}` : "—"}

              </span>

            </div>

            {models.length > 0 ? (

              <ul className="mt-1.5 flex flex-col gap-0.5 border-t border-white/6 pt-1.5">

                {models.map((row) => (

                  <li key={row.name} className="flex items-center justify-between gap-4 text-[12px]">

                    <span className="min-w-0 max-w-32 truncate text-ink-3">{row.name}</span>
                    <span className="shrink-0 font-mono text-ink-2 tabular-nums">~{formatTokens(row.tokens)}</span>

                  </li>

                ))}

              </ul>

            ) : null}

          </div>

        ) : null}

      </div>

    );

  }

}
