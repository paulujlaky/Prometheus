import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { MiniAgent, riskReason, type AgentEvent } from "./agent";
import { loadLastCwd, loadSettings, saveSettings } from "./settings";

export type ApprovalMode = "ask" | "smart" | "auto";
import { BoodleClient } from "../sdk/index";

// bun inlines __dirname to the source directory, so assets are resolved from the running bundle instead
const here = resolve(dirname(process.argv[1] ?? ""));

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
    title: "mini-swe-agent",

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

ipcMain.handle("start", async (_event, options: { task: string; cwd: string; assistantId?: string; mode: ApprovalMode }) => {

  if (agent) {

    throw new Error("A run is already in progress");

  }

  agent = new MiniAgent({

    client: getClient(),
    cwd: options.cwd,

    assistantId: options.assistantId,

    onEvent: send,

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
