import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { BoodleClient } from "../../sdk/index";

import { bundleDir } from "./Bundle";
import { loadBoodleCookie, saveBoodleCookie } from "./Settings";

export const ROOT_ENV = resolve(bundleDir(), "../../.env");

function envFiles(): string[] {

  return [

    join(dirname(process.execPath), ".env"),
    join(homedir(), ".bbx", ".env"),
    ROOT_ENV,

  ];

}

export function loadRootEnv(): void {

  if (process.env.BOODLE_COOKIE) {

    return;

  }

  for (const path of envFiles()) {

    if (existsSync(path)) {

      process.loadEnvFile(path);
      return;

    }

  }

}

let client: BoodleClient | null = null;

export function getBoodleCookie(): string | null {

  return loadBoodleCookie() ?? process.env.BOODLE_COOKIE?.trim() ?? null;

}

export function getClient(): BoodleClient {

  if (!client) {

    const cookie = getBoodleCookie();

    if (!cookie) {

      throw new Error("BoodleBox cookie is not set — add it in Settings");

    }

    client = new BoodleClient({ cookie });

  }

  return client;

}

export function setBoodleCookie(cookie: string): string {

  const value = cookie.trim();

  if (!value) {

    throw new Error("BoodleBox cookie is required");

  }

  const next = new BoodleClient({ cookie: value });

  saveBoodleCookie(value);
  client = next;

  return value;

}
