import { app, BrowserWindow, Menu } from "electron";

import { loadRootEnv } from "./Main/Client";
import { registerIpc } from "./Main/Ipc";
import { createWindow } from "./Main/Window";

loadRootEnv();
registerIpc();

void app.whenReady().then(() => {

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
