import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { BUILTIN_CMD_TIMEOUT_MS, BUILTIN_MAX_STEPS, clamp, CMD_TIMEOUT_RANGE, MAX_STEPS_RANGE, type Preferences } from "../Utils/Prefs";
import { folderLabel, normalizeDir } from "../Utils/Paths";

export { CMD_TIMEOUT_RANGE, MAX_STEPS_RANGE, type Preferences };

/** App data root under the user profile (`~/.bbx`). */
export const BBX_DIR = join(homedir(), ".bbx");

const SETTINGS_PATH = join(BBX_DIR, "settings.json");

/** Chats created before project mapping — shown until triaged or claimed. */
export const UNASSIGNED_PROJECT = "";

export const FALLBACK_MAX_STEPS = Number(process.env.SWE_MAX_STEPS ?? BUILTIN_MAX_STEPS);
export const FALLBACK_CMD_TIMEOUT_MS = Number(process.env.SWE_CMD_TIMEOUT_MS ?? BUILTIN_CMD_TIMEOUT_MS);

export interface Settings {

  /** Frequently opened project roots, persisted in ~/.bbx/settings.json. */
  recentProjects?: { dir: string; count: number }[];

  /** Settings-panel choices. Partial on disk; {@link loadPreferences} fills the gaps. */
  prefs?: Partial<Preferences>;

  /** BoodleBox browser cookie used to authenticate the SDK. */
  boodleCookie?: string;

  /** @deprecated Working directories now belong to individual chats. */
  cwd?: string | null;

  /** Per-chat working directory and selected model. */
  chats?: Record<string, { dir?: string | null; modelId?: string | null; botAssistantId?: string | null }>;

  /**
   * @deprecated Flat list from pre-project builds. Migrated into `projectChats` under {@link UNASSIGNED_PROJECT} on first load.
   */
  chatIds?: string[];

  /**
   * Normalized project root -> Boodle chat ids (newest first).
  */
  projectChats?: Record<string, string[]>;

}

export interface RecentProject {

  dir: string;
  count: number;

}

/** Stored preferences with every gap filled — safe to read straight into a run. */
export function loadPreferences(): Preferences {

  const stored = loadSettings().prefs ?? {};

  return {

    defaultModelId: typeof stored.defaultModelId === "string" && stored.defaultModelId ? stored.defaultModelId : null,

    maxSteps: clamp(stored.maxSteps, MAX_STEPS_RANGE, FALLBACK_MAX_STEPS),
    commandTimeoutMs: clamp(stored.commandTimeoutMs, CMD_TIMEOUT_RANGE, FALLBACK_CMD_TIMEOUT_MS),

  };

}

/** Merge a patch over what is stored, then hand back the resolved set. */
export function savePreferences(patch: Partial<Preferences>): Preferences {

  const prefs: Partial<Preferences> = { ...(loadSettings().prefs ?? {}), ...patch };

  if (prefs.maxSteps !== undefined) {

    prefs.maxSteps = clamp(prefs.maxSteps, MAX_STEPS_RANGE, FALLBACK_MAX_STEPS);

  }

  if (prefs.commandTimeoutMs !== undefined) {

    prefs.commandTimeoutMs = clamp(prefs.commandTimeoutMs, CMD_TIMEOUT_RANGE, FALLBACK_CMD_TIMEOUT_MS);

  }

  saveSettings({ prefs });

  return loadPreferences();

}

/** Return up to ten projects, ordered by descending open count. */
export function loadRecentProjects(): RecentProject[] {

  const rows = loadSettings().recentProjects;
  if (!Array.isArray(rows)) return [];

  return rows
    .filter((row): row is RecentProject => Boolean(row && typeof row.dir === "string" && row.dir.trim() && typeof row.count === "number"))
    .map((row) => ({ dir: normalizeProjectPath(row.dir), count: Math.max(1, Math.floor(row.count)) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

}

/** Count a project open, evicting the least popular entry when over capacity. */
export function rememberRecentProject(rawDir: string): RecentProject[] {

  const dir = normalizeProjectPath(rawDir);
  if (!dir) return loadRecentProjects();

  const projects = loadRecentProjects();
  const existing = projects.find((project) => project.dir === dir);

  if (existing) existing.count += 1;
  else projects.push({ dir, count: 1 });

  projects.sort((a, b) => b.count - a.count);

  const next = projects.slice(0, 10);

  saveSettings({ recentProjects: next });
  return next;

}

function ensureDir() {

  mkdirSync(BBX_DIR, { recursive: true });

}

/** Stable project key for map lookups (forward slashes, no trailing slash, drive letter uppercased). */
export function normalizeProjectPath(raw: string): string {

  return normalizeDir(raw.trim()) || UNASSIGNED_PROJECT;

}

export function projectLabel(path: string): string {

  const n = normalizeProjectPath(path);

  return n ? folderLabel(n) : "Unassigned";

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

  // Do not retain the old global working directory.
  delete next.cwd;

  writeFileSync(SETTINGS_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");

  return next;

}

export function loadBoodleCookie(): string | null {

  const value = loadSettings().boodleCookie;

  return typeof value === "string" && value.trim() ? value.trim() : null;

}

export function saveBoodleCookie(cookie: string): string {

  const value = cookie.trim();

  saveSettings({ boodleCookie: value });

  return value;

}

/**
 * Fold legacy `chatIds` into `projectChats` once.
*/
export function ensureProjectChats(): Record<string, string[]> {

  const settings = loadSettings();
  let map: Record<string, string[]> = { ...(settings.projectChats ?? {}) };

  let dirty = false;

  // normalize existing keys
  const normalized: Record<string, string[]> = {};

  for (const [key, ids] of Object.entries(map)) {

    const k = key === UNASSIGNED_PROJECT ? UNASSIGNED_PROJECT : normalizeProjectPath(key);
    const list = Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id) : [];

    if (!list.length) {

      dirty = dirty || k !== key;
      continue;

    }

    const prev = normalized[k] ?? [];
    const merged = [...list];

    for (const id of prev) {

      if (!merged.includes(id)) {

        merged.push(id);

      }

    }

    if (k !== key || merged.length !== list.length) {

      dirty = true;

    }

    normalized[k] = merged;

  }

  map = normalized;

  const legacy = settings.chatIds;

  if (Array.isArray(legacy) && legacy.length) {

    const unassigned = [...(map[UNASSIGNED_PROJECT] ?? [])];
    const seen = new Set(allChatIdsFrom(map));

    for (const id of legacy) {

      if (typeof id !== "string" || !id || seen.has(id)) {

        continue;

      }

      unassigned.push(id);
      seen.add(id);
      dirty = true;

    }

    if (unassigned.length) {

      map[UNASSIGNED_PROJECT] = unassigned;

    }

    // drop legacy field once folded
    saveSettings({ projectChats: map, chatIds: [] });
    return map;

  }

  if (dirty || !settings.projectChats) {

    saveSettings({ projectChats: map });

  }

  return map;

}

function allChatIdsFrom(map: Record<string, string[]>): string[] {

  const out: string[] = [];
  const seen = new Set<string>();

  for (const ids of Object.values(map)) {

    for (const id of ids) {

      if (!seen.has(id)) {

        seen.add(id);
        out.push(id);

      }

    }

  }

  return out;

}

/** Every known chat id (all projects + unassigned). */
export function loadChatIds(): string[] {

  return allChatIdsFrom(ensureProjectChats());

}

/** Chat ids for one project (empty string = unassigned). */
export function loadChatIdsForProject(projectDir: string | null | undefined): string[] {

  const map = ensureProjectChats();
  const key = projectDir == null || projectDir === "" ? UNASSIGNED_PROJECT : normalizeProjectPath(projectDir);

  return [...(map[key] ?? [])];

}

/**
 * Binds a chat to a project (or unassigned).
 */
export function rememberChatId(chatId: string, projectDir?: string | null, bump = true): void {

  if (!chatId) {

    return;

  }

  const map = ensureProjectChats();
  const key = projectDir == null || projectDir === "" ? UNASSIGNED_PROJECT : normalizeProjectPath(projectDir);

  const here = map[key] ?? [];

  if (here.includes(chatId)) {

    if (!bump) {

      return;

    }

    map[key] = [chatId, ...here.filter((id) => id !== chatId)].slice(0, 80);
    saveSettings({ projectChats: map, chatIds: [] });

    return;

  }

  // strip from every bucket first so renames do not duplicate
  for (const [proj, ids] of Object.entries(map)) {

    if (ids.includes(chatId)) {

      map[proj] = ids.filter((id) => id !== chatId);

      if (!map[proj].length && proj !== UNASSIGNED_PROJECT) {

        delete map[proj];

      }

    }

  }

  const rest = (map[key] ?? []).filter((id) => id !== chatId);
  map[key] = (bump ? [chatId, ...rest] : [...rest, chatId]).slice(0, 80);

  saveSettings({ projectChats: map, chatIds: [] });

}

/** Persist metadata that must be restored with a specific chat. */
export function rememberChatSettings(chatId: string, dir?: string | null, modelId?: string | null, botAssistantId?: string | null): void {

  if (!chatId) return;

  const settings = loadSettings();
  const chats = { ...(settings.chats ?? {}) };
  const previous = chats[chatId] ?? {};

  chats[chatId] = {

    ...previous,
    ...(dir !== undefined ? { dir: dir ? normalizeProjectPath(dir) : null } : {}),
    ...(modelId !== undefined ? { modelId: modelId || null } : {}),
    ...(botAssistantId !== undefined ? { botAssistantId: botAssistantId || null } : {}),

  };

  saveSettings({ chats });

}

export function settingsForChat(chatId: string): { dir: string | null; modelId: string | null; botAssistantId: string | null } {

  const value = loadSettings().chats?.[chatId];

  return {

    dir: typeof value?.dir === "string" && value.dir ? value.dir : projectForChat(chatId),

    modelId: typeof value?.modelId === "string" && value.modelId ? value.modelId : null,
    botAssistantId: typeof value?.botAssistantId === "string" && value.botAssistantId ? value.botAssistantId : null,

  };

}

export function forgetChatId(chatId: string): void {

  const map = ensureProjectChats();
  let dirty = false;

  for (const [proj, ids] of Object.entries(map)) {

    if (!ids.includes(chatId)) {

      continue;

    }

    dirty = true;
    map[proj] = ids.filter((id) => id !== chatId);

    if (!map[proj].length && proj !== UNASSIGNED_PROJECT) {

      delete map[proj];

    }

  }

  const settings = loadSettings();
  const chats = { ...(settings.chats ?? {}) };
  const hadSettings = Object.prototype.hasOwnProperty.call(chats, chatId);

  delete chats[chatId];

  if (dirty || hadSettings) {

    saveSettings({ projectChats: map, chatIds: [], chats });

  }

}

/** Project path for a chat, or null if unknown / unassigned. */
export function projectForChat(chatId: string): string | null {

  const map = ensureProjectChats();

  for (const [proj, ids] of Object.entries(map)) {

    if (ids.includes(chatId)) {

      return proj === UNASSIGNED_PROJECT ? null : proj;

    }

  }

  return null;

}

/** @deprecated There is no global cwd; directories are restored per chat. */
export function loadLastCwd(): string | null {

  return null;

}
