import { BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { APP_ID, APP_NAME, bundleDir, resourcePath } from "./Bundle";

const here = bundleDir();

export function resolveIcon(): string | undefined {

  const candidates = [

    resourcePath("icon.ico"),
    join(here, "icon.ico"),
    resourcePath("icon.png"),
    join(here, "icon.png"),
    join(here, "assets", "icon.ico"),
    join(here, "assets", "icon.png"),
    resolve(here, "../assets/icon.ico"),
    resolve(here, "../assets/icon.png"),
    resolve(here, "../../swe/assets/icon.ico"),
    resolve(here, "../../swe/assets/icon.png"),

  ];

  for (const path of candidates) {

    if (existsSync(path)) {

      return path;

    }

  }

  return undefined;

}

export const getAppIcon = resolveIcon;

let window: BrowserWindow | null = null;

export function getWindow(): BrowserWindow | null {

  return window;

}

/** Drop the payload when the page is gone — throwing here would tear down an in-flight run. */
export function sendToRenderer(channel: string, payload: unknown) {

  const win = window;

  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {

    return;

  }

  try {

    win.webContents.send(channel, payload);

  } catch {

    // render frame can dispose between the checks and send (reload, crash)

  }

}

export function createWindow(): BrowserWindow {

  const icon = resolveIcon();

  window = new BrowserWindow({

    width: 1096,
    height: 1024,

    backgroundColor: "#111318",
    title: "Boombox Agent",

    ...(icon ? { icon } : {}),

    webPreferences: {

      preload: join(here, "preload.cjs"),

      contextIsolation: true,
      nodeIntegration: false,

    },

  });

  if (icon) {

    window.setIcon(icon);

  }

  if (process.platform === "win32") {

    const portable = process.env.PORTABLE_EXECUTABLE_FILE;
    const launch = portable || process.execPath;

    window.setAppDetails({

      appId: APP_ID,

      relaunchDisplayName: APP_NAME,
      relaunchCommand: `"${launch}"`,

      ...(icon ? { appIconPath: icon } : {}),

    });

  }

  void window.loadFile(join(here, "index.html"));

  return window;

}
