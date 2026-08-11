import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BBX_DIR } from "./settings";

const USAGE_PATH = join(BBX_DIR, "usage.json");

/** model label → estimated tokens for that day */
export type DayModels = Record<string, number>;

/** `YYYY-MM-DD` → per-model totals */
export type UsageFile = Record<string, DayModels>;

function ensureDir() {

  mkdirSync(BBX_DIR, { recursive: true });

}

/** Local calendar date key (`YYYY-MM-DD`). */
export function dayKey(d = new Date()): string {

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");

  return `${y}-${m}-${day}`;

}

export function loadUsage(): UsageFile {

  try {

    if (!existsSync(USAGE_PATH)) {

      return {};

    }

    const raw = JSON.parse(readFileSync(USAGE_PATH, "utf8")) as UsageFile;

    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};

  } catch {

    return {};

  }

}

function saveUsage(data: UsageFile): void {

  ensureDir();
  writeFileSync(USAGE_PATH, `${JSON.stringify(data)}\n`, "utf8");

}

/** Add estimated tokens for a model on today's local date. No-op for non-positive counts. */
export function recordUsage(model: string, tokens: number): void {

  if (!Number.isFinite(tokens) || tokens <= 0) {

    return;

  }

  const label = (model || "unknown").trim() || "unknown";
  const key = dayKey();
  const data = loadUsage();
  const day = data[key] ?? {};

  day[label] = (day[label] ?? 0) + Math.round(tokens);
  data[key] = day;

  saveUsage(data);

}
