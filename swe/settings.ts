import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** App data root under the user profile (`~/.bbx`). */
export const BBX_DIR = join(homedir(), ".bbx");

const SETTINGS_PATH = join(BBX_DIR, "settings.json");

export interface Settings {

  /** Last folder the agent worked in. */
  cwd?: string | null;

}

function ensureDir() {

  mkdirSync(BBX_DIR, { recursive: true });

}

export function loadSettings(): Settings {

  try {

    if (!existsSync(SETTINGS_PATH)) {

      return {};

    }

    const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Settings;

    return raw && typeof raw === "object" ? raw : {};

  } catch {

    return {};

  }

}

export function saveSettings(patch: Partial<Settings>): Settings {

  ensureDir();

  const next: Settings = { ...loadSettings(), ...patch };

  writeFileSync(SETTINGS_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");

  return next;

}

/** Restored cwd only if the path still exists on disk. */
export function loadLastCwd(): string | null {

  const { cwd } = loadSettings();

  if (typeof cwd !== "string" || !cwd) {

    return null;

  }

  return existsSync(cwd) ? cwd : null;

}
