import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BBX_DIR, normalizeProjectPath } from "./Settings";

import type { RecapFile, RunRecap } from "../Types/Recap";

const RECAP_PATH = join(BBX_DIR, "recap.json");

const RECAPS_PER_PROJECT = 100;

export function loadRecaps(): RecapFile {

  try {

    if (!existsSync(RECAP_PATH)) {

      return {};

    }

    const raw = JSON.parse(readFileSync(RECAP_PATH, "utf8")) as RecapFile;

    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};

  } catch {

    return {};

  }

}

function saveRecaps(file: RecapFile): void {

  mkdirSync(BBX_DIR, { recursive: true });
  writeFileSync(RECAP_PATH, `${JSON.stringify(file, null, 2)}\n`, "utf8");

}

/** Append one finished run under its repo, keeping the newest {@link RECAPS_PER_PROJECT}. */
export function recordRecap(recap: RunRecap): void {

  const project = normalizeProjectPath(recap.project);

  if (!project || !recap.headline.trim()) {

    return;

  }

  const file = loadRecaps();
  const rows = Array.isArray(file[project]) ? file[project] : [];

  saveRecaps({ ...file, [project]: [...rows, { ...recap, project }].slice(-RECAPS_PER_PROJECT) });

}

export function forgetProjectRecaps(dir: string): void {

  const project = normalizeProjectPath(dir);
  const file = loadRecaps();

  if (!Object.prototype.hasOwnProperty.call(file, project)) {

    return;

  }

  delete file[project];

  saveRecaps(file);

}
