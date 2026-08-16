import { app } from "electron";
import { dirname, join, resolve } from "node:path";

export const APP_ID = "com.boombox.agent";
export const APP_NAME = "Boombox";

/** Directory that holds main.cjs, preload.cjs, index.html, and assets. */
export function bundleDir(): string {

  if (app.isPackaged) {

    return app.getAppPath();

  }

  return resolve(dirname(process.argv[1] ?? "."));

}

/** Files shipped beside the binary (icon, bundled CLIs) rather than inside the asar. */
export function resourcePath(...parts: string[]): string {

  if (app.isPackaged) {

    return join(process.resourcesPath, ...parts);

  }

  return join(bundleDir(), ...parts);

}
