import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { MiniAgent, riskReason, type AgentEvent } from "./agent";
import { entriesFromChatDetail } from "./history";
import { forgetChatId, loadChatIds, loadLastCwd, loadSettings, rememberChatId, saveSettings } from "./settings";
import { loadUsage } from "./usage";

export type ApprovalMode = "ask" | "smart" | "auto";
import { BoodleClient } from "../sdk/index";

// bun inlines __dirname to the source directory, so assets are resolved from the running bundle instead
const here = resolve(dirname(process.argv[1] ?? ""));

/** Window / taskbar icon — copied into dist/assets by swe:build. */
function resolveIcon(): string | undefined {

  const candidates = [

    join(here, "assets", "icon.png"),

    // source tree when running main from a non-dist layout
    resolve(here, "../assets/icon.png"),
    resolve(here, "../../swe/assets/icon.png"),

  ];

  for (const path of candidates) {

    if (existsSync(path)) {

      return path;

    }

  }

  return undefined;

}

const appIcon = resolveIcon();

let window: BrowserWindow | null = null;
let agent: MiniAgent | null = null;
let client: BoodleClient | null = null;

const approvals = new Map<number, (ok: boolean) => void>();

let approvalSeq = 0;

// electron is launched by node rather than bun, so the project .env is not picked up for free
const rootEnv = resolve(here, "../../.env");

if (!process.env.BOODLE_COOKIE && existsSync(rootEnv)) {

  process.loadEnvFile(rootEnv);

}

function getClient(): BoodleClient {

  if (!client) {

    const cookie = process.env.BOODLE_COOKIE;

    if (!cookie) {

      throw new Error(`BOODLE_COOKIE is not set — add it to ${rootEnv}`);

    }

    client = new BoodleClient({ cookie });

  }

  return client;

}

// one IPC message per token is the bulk of the streaming cost, so deltas are coalesced
let deltaBuffer = "";
let deltaTimer: ReturnType<typeof setTimeout> | null = null;

function flushDeltas() {

  if (deltaTimer) {

    clearTimeout(deltaTimer);
    deltaTimer = null;

  }

  if (deltaBuffer) {

    window?.webContents.send("agent-event", { type: "delta", text: deltaBuffer });
    deltaBuffer = "";

  }

}

function send(event: AgentEvent) {

  if (event.type === "delta") {

    deltaBuffer += event.text;

    deltaTimer ??= setTimeout(flushDeltas, 60);

    return;

  }

  flushDeltas();

  window?.webContents.send("agent-event", event);

}

function createWindow() {

  window = new BrowserWindow({

    width: 1100,
    height: 780,

    backgroundColor: "#111318",
    title: "Boombox Agent",
    ...(appIcon ? { icon: appIcon } : {}),

    webPreferences: {

      preload: join(here, "preload.cjs"),

      contextIsolation: true,
      nodeIntegration: false,

    },

  });

  void window.loadFile(join(here, "index.html"));

}

// the renderer groups these with the same picker the web app uses
ipcMain.handle("models", async () => getClient().listAssistants());

ipcMain.handle("settings:get", () => loadSettings());

ipcMain.handle("settings:last-cwd", () => loadLastCwd());

ipcMain.handle("usage:get", () => loadUsage());

ipcMain.handle("chats:list", async () => {

  const known = new Set(loadChatIds());

  if (!known.size) {

    return [];

  }

  // pull a wide recent page and keep only chats we created (titles stay whatever Boodle assigned)
  const list = await getClient().listChats(100, 0);
  const found = new Set<string>();

  const rows = (list.entries ?? []).filter((chat) => known.has(chat.id) || (typeof chat.name === "string" && chat.name.startsWith("[SWE] "))).map((chat) => {

      found.add(chat.id);
      rememberChatId(chat.id);

      const raw = (chat.name ?? "").trim();

      // we should migrate old local titles; new chats use Boodle's name as-is
      const title = raw.startsWith("[SWE] ") ? raw.slice(6).trim() || raw : raw || "Untitled";

      return {

        id: chat.id,
        name: chat.name,
        title,
        modified: chat.modified ?? chat.lastMessage ?? chat.created ?? 0,

      };

    }).sort((a, b) => b.modified - a.modified);

  // drop ids Boodle no longer returns (deleted elsewhere)
  for (const id of known) {

    if (!found.has(id)) {

      forgetChatId(id);

    }

  }

  return rows;

});

ipcMain.handle("chats:delete", async (_event, chatId: string) => {

  await getClient().deleteChat(chatId);
  forgetChatId(chatId);

});

ipcMain.handle("chats:get", async (_event, chatId: string) => {

  const detail = await getClient().getChat(chatId);

  return {

    id: detail.chat.id,
    name: detail.chat.name,
    title: (detail.chat.name ?? "").trim() || "Untitled",
    entries: entriesFromChatDetail(detail),

  };

});

ipcMain.handle("chats:remember", (_event, chatId: string) => {

  rememberChatId(chatId);

});

ipcMain.handle("pick-dir", async () => {

  const result = await dialog.showOpenDialog({

    properties: ["openDirectory"],
    defaultPath: loadLastCwd() ?? undefined,

  });

  if (result.canceled || !result.filePaths[0]) {

    return null;

  }

  const cwd = result.filePaths[0];

  saveSettings({ cwd });

  return cwd;

});

ipcMain.handle("start", async (_event, options: { task: string; cwd: string; assistantId?: string; modelLabel?: string; mode: ApprovalMode }) => {

  if (agent) {

    throw new Error("A run is already in progress");

  }

  agent = new MiniAgent({

    client: getClient(),
    cwd: options.cwd,

    assistantId: options.assistantId,
    modelLabel: options.modelLabel,

    onEvent: (event) => {

      if (event.type === "session") {

        rememberChatId(event.chatId);

      }

      send(event);

    },

    approve: (command) => {

      const reason = riskReason(command);

      if (options.mode === "auto" || (options.mode === "smart" && !reason)) {

        return Promise.resolve(true);

      }

      const id = (approvalSeq += 1);

      return new Promise<boolean>((resolve) => {

        approvals.set(id, resolve);

        flushDeltas();
        window?.webContents.send("approval", { id, command, reason });

      });

    },

  });

  try {

    await agent.run(options.task);

  } finally {

    agent = null;

    for (const resolve of approvals.values()) {

      resolve(false);

    }

    approvals.clear();

  }

});

ipcMain.handle("approve", (_event, { id, ok }: { id: number; ok: boolean }) => {

  const resolve = approvals.get(id);

  approvals.delete(id);
  resolve?.(ok);

});

ipcMain.handle("stop", () => {

  // a run parked on an approval prompt would otherwise never see the stop
  for (const resolve of approvals.values()) {

    resolve(false);

  }

  approvals.clear();

  agent?.stop();

});

void app.whenReady().then(() => {

  // Windows taskbar grouping / identity
  if (process.platform === "win32") {

    app.setAppUserModelId("com.boombox.agent");

  }

  Menu.setApplicationMenu(null);
  createWindow();

  app.on("activate", () => {

    if (BrowserWindow.getAllWindows().length === 0) {

      createWindow();

    }

  });

});

app.on("window-all-closed", () => {

  app.quit();

});
