import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { BoodleClient } from "../../sdk/index";

import { bundleDir } from "./Bundle";

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

export function getClient(): BoodleClient {

  if (!client) {

    const cookie = process.env.BOODLE_COOKIE;

    if (!cookie) {

      throw new Error("BOODLE_COOKIE is not set — put it in the environment, next to the app as .env, or in ~/.bbx/.env");

    }

    client = new BoodleClient({ cookie });

  }

  return client;

}
