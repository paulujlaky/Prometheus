import { app, dialog, ipcMain } from "electron";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadLastCwd } from "./Settings";

export function registerFileIpc() {

  ipcMain.handle("pick-dir", async () => {

    const result = await dialog.showOpenDialog({

      properties: ["openDirectory"],
      defaultPath: loadLastCwd() ?? undefined,

    });

    if (result.canceled || !result.filePaths[0]) {

      return null;

    }

    return result.filePaths[0];

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

  ipcMain.handle("import-images", (_event, files: Array<{ path: string; name: string; bytes: number[] }>) => {

    const dir = join(app.getPath("temp"), "boombox-images");
    mkdirSync(dir, { recursive: true });

    return files.map((file, index) => {

      if (file.path && existsSync(file.path)) return file.path;

      const safe = (file.name || `pasted-${index}.png`).replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = join(dir, `${Date.now()}-${index}-${safe}`);

      writeFileSync(path, Buffer.from(file.bytes));
      return path;

    });

  });

}
