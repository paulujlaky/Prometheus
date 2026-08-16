import { BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const here = resolve(dirname(process.argv[1] ?? ""));

export function resolveIcon(): string | undefined {

  const candidates = [

    join(here, "assets", "icon.png"),
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

export const APP_ICON = resolveIcon();

let window: BrowserWindow | null = null;

export function getWindow(): BrowserWindow | null {

  return window;

}

export function createWindow(): BrowserWindow {

  window = new BrowserWindow({

    width: 1096,
    height: 1024,

    backgroundColor: "#111318",
    title: "Boombox Agent",

    ...(APP_ICON ? { icon: APP_ICON } : {}),

    webPreferences: {

      preload: join(here, "preload.cjs"),

      contextIsolation: true,
      nodeIntegration: false,

    },

  });

  void window.loadFile(join(here, "index.html"));

  return window;

}
