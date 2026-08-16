import { ipcMain } from "electron";

import { entriesFromChatDetail } from "../Agent/History";
import { getClient } from "./Client";
import {

  ensureProjectChats,
  forgetChatId,
  normalizeProjectPath,
  rememberChatId,
  settingsForChat,

  UNASSIGNED_PROJECT,

} from "./Settings";
import { forgetMarks, loadMarks, snapshotsAvailable } from "../Tools/Snapshot";

import type { ChatDetail } from "../../sdk/types";

export function chatTitle(name: string | null | undefined): string {

  const raw = (name ?? "").trim();

  if (raw.startsWith("[SWE] ")) {

    return raw.slice(6).trim() || raw;

  }

  return raw || "Untitled";

}

function extractProjectFromDetail(detail: ChatDetail): string | null {

  for (const message of detail.messages ?? []) {

    const text = message.type === "User" ? message.submission ?? "" : message.submission ?? "";

    if (!text) {

      continue;

    }

    const seed = /Working directory for the runner:\s*(\S+)/.exec(text);

    if (seed?.[1]) {

      return normalizeProjectPath(seed[1]);

    }

    const sticky = /(?:^|\n)cwd:\s*(\S+)/.exec(text);

    if (sticky?.[1]) {

      return normalizeProjectPath(sticky[1]);

    }

  }

  return null;

}

let triagePromise: Promise<void> | null = null;

const triagedOrphans = new Set<string>();

async function triageUnassignedChats(limit = 12): Promise<void> {

  if (triagePromise) {

    return triagePromise;

  }

  triagePromise = (async () => {

    const map = ensureProjectChats();
    const orphans = (map[UNASSIGNED_PROJECT] ?? []).filter((id) => !triagedOrphans.has(id)).slice(0, limit);

    if (!orphans.length) {

      return;

    }

    const client = getClient();

    for (const id of orphans) {

      triagedOrphans.add(id);

      try {

        const detail = await client.getChat(id);
        const project = extractProjectFromDetail(detail);

        if (project) {

          rememberChatId(id, project, false);

        }

      } catch {

        forgetChatId(id);

      }

    }

  })().finally(() => {

    triagePromise = null;

  });

  return triagePromise;

}

export function registerChatIpc() {

  ipcMain.handle("chats:list", async (_event, _projectDir?: string | null) => {

    ensureProjectChats();

    await triageUnassignedChats();
    const projects = ensureProjectChats();

    const orderedIds: { id: string; project: string | null }[] = [];

    for (const [proj, ids] of Object.entries(projects)) {

      const project = proj === UNASSIGNED_PROJECT ? null : proj;

      for (const id of ids) {

        orderedIds.push({ id, project });

      }

    }

    if (!orderedIds.length) {

      return [];

    }

    const knownIds = new Set(orderedIds.map((r) => r.id));
    const list = await getClient().listChats(100, 0);
    const remote = new Map((list.entries ?? []).filter((c) => knownIds.has(c.id)).map((c) => [c.id, c]));

    const rows = orderedIds.map(({ id, project }) => {

      const chat = remote.get(id);
      const saved = settingsForChat(id);

      return {

        id,
        name: chat?.name ?? "",
        title: chat ? chatTitle(chat.name) : "Untitled",

        modified: chat ? (chat.lastMessage ?? chat.modified ?? chat.created ?? 0) : 0,

        project: saved.dir ?? project,
        modelId: saved.modelId,

      };

    });

    return rows.sort((a, b) => b.modified - a.modified);

  });

  ipcMain.handle("chats:delete", async (_event, chatId: string) => {

    await getClient().deleteChat(chatId);

    forgetChatId(chatId);
    forgetMarks(chatId);

  });

  ipcMain.handle("chats:rename", async (_event, chatId: string, name: string) => {

    const trimmed = typeof name === "string" ? name.trim() : "";

    if (!chatId || !trimmed) {

      throw new Error("Chat id and name are required");

    }

    await getClient().renameChat(chatId, trimmed);

  });

  ipcMain.handle("chats:get", async (_event, chatId: string) => {

    const detail = await getClient().getChat(chatId);
    const saved = settingsForChat(chatId);

    const project = saved.dir ?? extractProjectFromDetail(detail);

    if (project) {

      rememberChatId(chatId, project, false);

    }

    return {

      id: detail.chat.id,
      name: detail.chat.name,
      title: chatTitle(detail.chat.name),

      project,

      modelId: saved.modelId,

      entries: entriesFromChatDetail(detail),
      undos: snapshotsAvailable() ? loadMarks(chatId) : [],

    };

  });

  ipcMain.handle("chats:remember", (_event, chatId: string, projectDir?: string | null) => {

    rememberChatId(chatId, projectDir);

  });

  ipcMain.handle("chats:claim", (_event, chatId: string, projectDir: string) => {

    if (!chatId || !projectDir) {

      return;

    }

    rememberChatId(chatId, projectDir, false);

  });

}
