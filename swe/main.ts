import { app, BrowserWindow, Menu } from "electron";

import { APP_ID } from "./Main/Bundle";
import { loadRootEnv } from "./Main/Client";
import { registerIpc } from "./Main/Ipc";
import { closeAll } from "./Main/Mcp";
import { createWindow } from "./Main/Window";

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

// stdio servers are our own child processes; without this they outlive the app
app.on("before-quit", () => {

  void closeAll();

});

app.on("window-all-closed", () => {

  app.quit();

});
