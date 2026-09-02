/** Chromium/Electron vars that must not leak into children on Windows. */
const DROP = [

  "CHROME_CRASHPAD_PIPE_NAME",
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ASAR",
  "ELECTRON_NO_ATTACH_CONSOLE",

];

/** CreateProcess on Windows needs these to resolve `.cmd` shims (npx, uvx, npm). */
const WINDOWS_SHELL = ["COMSPEC", "PATHEXT", "WINDIR"] as const;

/**
 * Strip the parent's crashpad/Electron identity so a spawned process cannot
 * steal or close Chromium's handler pipe — that is what prints
 * crashpad_client_win "not connected" and can take the whole app with it.
 */
export function withoutElectron(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {

  const out: NodeJS.ProcessEnv = { ...env };

  for (const key of Object.keys(out)) {

    if (DROP.includes(key) || key.startsWith("ELECTRON_") || key.startsWith("CHROME_CRASHPAD")) {

      delete out[key];

    }

  }

  return out;

}

/** Env for `<run>` / git: the real user environment, minus Electron. */
export function commandEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {

  return withoutElectron({ ...process.env, ...extra });

}

/** Extra Windows keys the MCP SDK's default env omits. */
export function windowsSpawnExtras(): Record<string, string> {

  if (process.platform !== "win32") {

    return {};

  }

  const extras: Record<string, string> = {};

  for (const key of WINDOWS_SHELL) {

    const value = process.env[key];

    if (value) {

      extras[key] = value;

    }

  }

  return extras;

}
