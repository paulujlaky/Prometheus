import { ipcMain } from "electron";

import { getBoodleCookie, getClient, setBoodleCookie } from "./Client";
import { registerChatIpc } from "./Chats";
import { registerFileIpc } from "./Files";
import { catalog, refresh } from "./Mcp";
import { loadRecaps } from "./Recap";
import { registerRunIpc } from "./Run";
import {

  loadLastCwd,
  loadPreferences,
  loadRecentProjects,
  loadSettings,
  normalizeProjectPath,
  rememberRecentProject,
  savePreferences,

  type Preferences,

} from "./Settings";
import { loadUsage } from "./Usage";
import { mergeModelLists } from "../Utils/Models";
import { loadMarks, markUndone, restoreSnapshot, snapshotsAvailable } from "../Tools/Snapshot";

export function registerIpc() {

  ipcMain.handle("models", async () => {

    const client = getClient();
    const [assistants, custom] = await Promise.all([client.listAssistants(), client.listCustomModels()]);

    return mergeModelLists(assistants, custom);

  });

  ipcMain.handle("models:preferred", () => getClient().preferredAssistantId);

  ipcMain.handle("settings:get", () => loadSettings());

  ipcMain.handle("cookie:get", () => getBoodleCookie());
  ipcMain.handle("cookie:set", (_event, cookie: string) => {

    if (typeof cookie !== "string") {

      throw new Error("BoodleBox cookie is required");

    }

    return setBoodleCookie(cookie);

  });

  ipcMain.handle("prefs:get", () => loadPreferences());

  ipcMain.handle("prefs:set", (_event, patch: Partial<Preferences>) => {

    if (!patch || typeof patch !== "object") {

      return loadPreferences();

    }

    return savePreferences(patch);

  });

  ipcMain.handle("settings:last-cwd", () => loadLastCwd());
  ipcMain.handle("settings:recent-projects", () => loadRecentProjects());

  ipcMain.handle("settings:open-project", (_event, cwd: string) => {

    if (typeof cwd !== "string" || !cwd.trim()) return null;

    const dir = normalizeProjectPath(cwd);
    return { dir, recentProjects: rememberRecentProject(dir) };

  });

  ipcMain.handle("settings:set-cwd", (_event, cwd: string) => {

    if (typeof cwd !== "string" || !cwd.trim()) {

      return null;

    }

    return cwd.trim();

  });

  ipcMain.handle("mcp:list", (_event, cwd: string) => {

    if (typeof cwd !== "string" || !cwd.trim()) {

      return [];

    }

    return catalog(cwd);

  });

  ipcMain.handle("mcp:refresh", () => refresh());

  ipcMain.handle("usage:get", () => loadUsage());

  ipcMain.handle("recaps:get", () => loadRecaps());

  ipcMain.handle("rollback:list", (_event, chatId: string) => (snapshotsAvailable() ? loadMarks(chatId) : []));

  ipcMain.handle("rollback:undo", (_event, chatId: string, commit: string) => {

    const mark = loadMarks(chatId).find((row) => row.commit === commit);

    if (!mark) {

      return { ok: false, files: [], text: "That snapshot is no longer on record." };

    }

    const report = restoreSnapshot(mark.project, commit);

    if (report.ok) {

      markUndone(chatId, commit);

    }

    return report;

  });

  registerChatIpc();
  registerFileIpc();
  registerRunIpc();

}
