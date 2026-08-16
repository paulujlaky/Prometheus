import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BBX_DIR } from "./Settings";
import { dayKey } from "../Utils/Time";

import type { UsageFile } from "../Types/Usage";

export type { DayModels, UsageFile } from "../Types/Usage";

const USAGE_PATH = join(BBX_DIR, "usage.json");

function ensureDir() {

  mkdirSync(BBX_DIR, { recursive: true });

}

export { dayKey };

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
