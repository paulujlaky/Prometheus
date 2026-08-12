import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** App data root under the user profile (`~/.bbx`). */
export const BBX_DIR = join(homedir(), ".bbx");

const SETTINGS_PATH = join(BBX_DIR, "settings.json");

/** Chats created before project mapping — shown until triaged or claimed. */
export const UNASSIGNED_PROJECT = "";

export interface Settings {

  /** Frequently opened project roots, persisted in ~/.bbx/settings.json. */
  recentProjects?: { dir: string; count: number }[];

  /** @deprecated Working directories now belong to individual chats. */
  cwd?: string | null;

  /** Per-chat working directory and selected model. */
  chats?: Record<string, { dir?: string | null; modelId?: string | null }>;

  /**
   * @deprecated Flat list from pre-project builds. Migrated into `projectChats`
   * under {@link UNASSIGNED_PROJECT} on first load.
   */
  chatIds?: string[];

  /**
   * Normalized project root → Boodle chat ids (newest first).
   * Empty-string key holds unassigned / pre-project-era sessions.
   */
  projectChats?: Record<string, string[]>;

}

export interface RecentProject {
  dir: string;
  count: number;
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

  let p = raw.trim().replace(/\\/g, "/");

  if (!p) {

    return UNASSIGNED_PROJECT;

  }

  // keep "C:/" but drop trailing slashes on normal paths
  if (p.length > 3 && p.endsWith("/")) {

    p = p.replace(/\/+$/, "");

  } else if (p.length > 1 && p.endsWith("/") && !/^[A-Za-z]:\/$/.test(p)) {

    p = p.replace(/\/+$/, "");

  }

  if (/^[a-zA-Z]:/.test(p)) {

    p = `${p[0].toUpperCase()}${p.slice(1)}`;

  }

  return p;

}

export function projectLabel(path: string): string {

  const n = normalizeProjectPath(path);

  if (!n) {

    return "Unassigned";

  }

  const parts = n.split("/").filter(Boolean);

  return parts[parts.length - 1] || n;

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

/**
 * Fold legacy `chatIds` into `projectChats` once. Unmapped ids land under
 * {@link UNASSIGNED_PROJECT} until triage or a session bind assigns a project.
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
  const key = projectDir == null || projectDir === ""
    ? UNASSIGNED_PROJECT
    : normalizeProjectPath(projectDir);

  return [...(map[key] ?? [])];

}

/**
 * Bind a chat to a project (or unassigned). Moves the id if it already lived
 * under another project. Newest first, capped per project.
 */
export function rememberChatId(chatId: string, projectDir?: string | null): void {

  if (!chatId) {

    return;

  }

  const map = ensureProjectChats();
  const key = projectDir == null || projectDir === ""
    ? UNASSIGNED_PROJECT
    : normalizeProjectPath(projectDir);

  // strip from every bucket first so renames do not duplicate
  for (const [proj, ids] of Object.entries(map)) {

    if (ids.includes(chatId)) {

      map[proj] = ids.filter((id) => id !== chatId);

      if (!map[proj].length && proj !== UNASSIGNED_PROJECT) {

        delete map[proj];

      }

    }

  }

  const list = [chatId, ...(map[key] ?? []).filter((id) => id !== chatId)].slice(0, 80);
  map[key] = list;

  saveSettings({ projectChats: map, chatIds: [] });

}

/** Persist metadata that must be restored with a specific chat. */
export function rememberChatSettings(chatId: string, dir?: string | null, modelId?: string | null): void {

  if (!chatId) return;

  const settings = loadSettings();
  const chats = { ...(settings.chats ?? {}) };
  const previous = chats[chatId] ?? {};

  chats[chatId] = {
    ...previous,
    ...(dir !== undefined ? { dir: dir ? normalizeProjectPath(dir) : null } : {}),
    ...(modelId !== undefined ? { modelId: modelId || null } : {}),
  };

  saveSettings({ chats });

}

export function settingsForChat(chatId: string): { dir: string | null; modelId: string | null } {

  const value = loadSettings().chats?.[chatId];

  return {
    dir: typeof value?.dir === "string" && value.dir ? value.dir : projectForChat(chatId),
    modelId: typeof value?.modelId === "string" && value.modelId ? value.modelId : null,
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
