import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { MiniAgent, riskReason, type AgentEvent } from "./agent";
import { entriesFromChatDetail } from "./history";
import {
  ensureProjectChats,
  forgetChatId,
  loadLastCwd,
  loadSettings,
  normalizeProjectPath,
  rememberChatId,
  saveSettings,
  UNASSIGNED_PROJECT,
} from "./settings";
import { loadUsage } from "./usage";

import type { ChatDetail } from "../sdk/types";

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

    width: 1096,
    height: 1024,

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

/** Persist the active project folder without a picker (e.g. opening a chat from another project). */
ipcMain.handle("settings:set-cwd", (_event, cwd: string) => {

  if (typeof cwd !== "string" || !cwd.trim()) {

    return null;

  }

  const next = cwd.trim();
  saveSettings({ cwd: next });

  return next;

});

ipcMain.handle("usage:get", () => loadUsage());

/** Pull project root from the harness seed / sticky lines in a chat's history. */
function extractProjectFromDetail(detail: ChatDetail): string | null {

  for (const message of detail.messages ?? []) {

    const text = message.type === "User"
      ? message.submission ?? ""
      : message.submission ?? "";

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

/** One in-flight triage so listChats does not stampede getChat. */
let triagePromise: Promise<void> | null = null;

/** Orphans already inspected this process — avoid re-fetching every sidebar refresh. */
const triagedOrphans = new Set<string>();

/**
 * Assign unassigned / legacy chat ids to a project by reading the seed prompt cwd.
 * Caps how many we fetch per list call so the sidebar stays snappy.
 */
async function triageUnassignedChats(limit = 12): Promise<void> {

  if (triagePromise) {

    return triagePromise;

  }

  triagePromise = (async () => {

    const map = ensureProjectChats();
    const orphans = (map[UNASSIGNED_PROJECT] ?? [])
      .filter((id) => !triagedOrphans.has(id))
      .slice(0, limit);

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

          rememberChatId(id, project);

        }

      } catch {

        // deleted remotely or unreachable — drop the id
        forgetChatId(id);

      }

    }

  })().finally(() => {

    triagePromise = null;

  });

  return triagePromise;

}

function chatTitle(name: string | null | undefined): string {

  const raw = (name ?? "").trim();

  if (raw.startsWith("[SWE] ")) {

    return raw.slice(6).trim() || raw;

  }

  return raw || "Untitled";

}

ipcMain.handle("chats:list", async (_event, _projectDir?: string | null) => {

  // fold legacy chatIds; best-effort bind orphans from history
  // Always return every project — filtering to the active folder made other
  // projects look "deleted" when the user switched cwd (storage was fine).
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

    return {

      id,
      name: chat?.name ?? "",
      title: chat ? chatTitle(chat.name) : "Untitled",
      modified: chat
        ? (chat.modified ?? chat.lastMessage ?? chat.created ?? 0)
        : 0,
      project,

    };

  });

  // newest first within the flat list; the sidebar re-groups by project
  return rows.sort((a, b) => b.modified - a.modified);

});

ipcMain.handle("chats:delete", async (_event, chatId: string) => {

  await getClient().deleteChat(chatId);
  forgetChatId(chatId);

});

ipcMain.handle("chats:get", async (_event, chatId: string) => {

  const detail = await getClient().getChat(chatId);

  // opportunistic bind if still unassigned
  const project = extractProjectFromDetail(detail);

  if (project) {

    rememberChatId(chatId, project);

  }

  return {

    id: detail.chat.id,
    name: detail.chat.name,
    title: chatTitle(detail.chat.name),
    project,
    entries: entriesFromChatDetail(detail),

  };

});

ipcMain.handle("chats:remember", (_event, chatId: string, projectDir?: string | null) => {

  rememberChatId(chatId, projectDir);

});

/** Claim an unassigned session into the active project (user opened it there). */
ipcMain.handle("chats:claim", (_event, chatId: string, projectDir: string) => {

  if (!chatId || !projectDir) {

    return;

  }

  rememberChatId(chatId, projectDir);

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

ipcMain.handle("pick-images", async () => {

  const result = await dialog.showOpenDialog({

    properties: ["openFile", "multiSelections"],
    filters: [

      { name: "Images & documents", extensions: ["png", "jpg", "jpeg", "webp", "gif", "pdf", "txt", "csv", "docx", "xlsx", "pptx"] },
      { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
      { name: "All files", extensions: ["*"] },

    ],

  });

  if (result.canceled) {

    return [];

  }

  return result.filePaths;

});

ipcMain.handle("start", async (_event, options: {

  task: string;
  cwd: string;

  assistantId?: string;
  modelLabel?: string;

  mode: ApprovalMode;

  /** Resume this Boodle chat as a follow-up (no full system reseed). */
  chatId?: string;

  /** Absolute paths of files/images to upload and attach. */
  imagePaths?: string[];

}) => {

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

        rememberChatId(event.chatId, options.cwd);

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

    await agent.run(options.task, {

      chatId: options.chatId,
      imagePaths: options.imagePaths,

    });

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

/** Queue a user note into the active agent loop (applied on the next model turn). */
ipcMain.handle("interject", (_event, options: { text: string; imagePaths?: string[] }) => {

  if (!agent) {

    throw new Error("No run in progress");

  }

  agent.interject(options.text ?? "", options.imagePaths ?? []);

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
