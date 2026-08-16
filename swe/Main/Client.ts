import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { BoodleClient } from "../../sdk/index";

const here = resolve(dirname(process.argv[1] ?? ""));

export const ROOT_ENV = resolve(here, "../../.env");

export function loadRootEnv(): void {

  if (!process.env.BOODLE_COOKIE && existsSync(ROOT_ENV)) {

    process.loadEnvFile(ROOT_ENV);

  }

}

let client: BoodleClient | null = null;

export function getClient(): BoodleClient {

  if (!client) {

    const cookie = process.env.BOODLE_COOKIE;

    if (!cookie) {

      throw new Error(`BOODLE_COOKIE is not set — add it to ${ROOT_ENV}`);

    }

    client = new BoodleClient({ cookie });

  }

  return client;

}
