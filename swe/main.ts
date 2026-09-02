import { app, BrowserWindow, Menu } from "electron";

import { APP_ID } from "./Main/Bundle";
import { loadRootEnv } from "./Main/Client";
import { registerIpc } from "./Main/Ipc";
import { closeAll } from "./Main/Mcp";
import { createWindow } from "./Main/Window";

process.on("uncaughtException", (err) => {

  console.error("uncaughtException", err);

});

process.on("unhandledRejection", (reason) => {

  console.error("unhandledRejection", reason);

});

// Windows binds the taskbar icon to the process AUMID before ready.
if (process.platform === "win32") {

  app.setAppUserModelId(APP_ID);

}

loadRootEnv();
registerIpc();

void app.whenReady().then(() => {

  Menu.setApplicationMenu(null);
  createWindow();

  app.on("activate", () => {

    if (BrowserWindow.getAllWindows().length === 0) {

      createWindow();

    }

  });

});

let lastRendererReload = 0;

app.on("render-process-gone", (_event, webContents, details) => {

  console.error("render-process-gone", details.reason, details.exitCode);

  if (details.reason === "clean-exit" || webContents.isDestroyed()) {

    return;

  }

  const now = Date.now();

  if (now - lastRendererReload < 3000) {

    return;

  }

  lastRendererReload = now;
  webContents.reload();

});

app.on("child-process-gone", (_event, details) => {

  console.error("child-process-gone", details.type, details.reason, details.exitCode);

});

// stdio servers are our own child processes; without this they outlive the app
app.on("before-quit", () => {

  void closeAll();

});

app.on("window-all-closed", () => {

  app.quit();

});
