import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { withoutElectron, windowsSpawnExtras } from "./Spawn";

export interface McpStdioParams {

  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;

}

function resolveWindowsCommand(command: string): string {

  if (/[\\/]/.test(command) || /\.\w+$/.test(command)) {

    return command;

  }

  const dirs = (process.env.PATH ?? "").split(delimiter);
  const exts = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean);

  for (const dir of dirs) {

    for (const ext of exts) {

      const candidate = join(dir, command + ext);

      if (existsSync(candidate)) {

        return candidate;

      }

    }

  }

  return command;

}

/**
 * Stdio MCP without the SDK's cross-spawn. That path funnels `.cmd` through
 * `cmd.exe` and inherits Chromium's crashpad/Mojo handles — spawning Unity
 * (or anything CEF-based) on that pipe kills the app with exit 3.
 */
export class McpStdioTransport implements Transport {

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private child: ChildProcess | undefined;
  private buffer = new ReadBuffer();
  private params: McpStdioParams;

  constructor(params: McpStdioParams) {

    this.params = params;

  }

  start(): Promise<void> {

    if (this.child) {

      throw new Error("MCP stdio transport already started");

    }

    return new Promise((resolve, reject) => {

      let command = this.params.command;
      let args = [...(this.params.args ?? [])];
      let windowsVerbatim = false;

      if (process.platform === "win32") {

        command = resolveWindowsCommand(command);

        if (/\.(cmd|bat)$/i.test(command)) {

          const line = [command, ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ");

          command = process.env.ComSpec || "cmd.exe";
          args = ["/d", "/s", "/c", `"${line}"`];
          windowsVerbatim = true;

        }

      }

      const env = withoutElectron({

        ...getDefaultEnvironment(),
        ...windowsSpawnExtras(),
        ...(this.params.env ?? {}),

      }) as Record<string, string>;

      const child = spawn(command, args, {

        cwd: this.params.cwd,
        env,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        windowsVerbatimArguments: windowsVerbatim,
        detached: process.platform === "win32",
        shell: false,

      });

      this.child = child;

      child.on("error", (error) => {

        reject(error);
        this.onerror?.(error);

      });

      child.on("spawn", () => resolve());

      child.on("close", () => {

        this.child = undefined;
        this.onclose?.();

      });

      child.stdin?.on("error", (error) => this.onerror?.(error));
      child.stdout?.on("error", (error) => this.onerror?.(error));

      child.stdout?.on("data", (chunk: Buffer) => {

        try {

          this.buffer.append(chunk);

          for (;;) {

            const message = this.buffer.readMessage();

            if (message == null) {

              break;

            }

            this.onmessage?.(message);

          }

        } catch (error) {

          this.onerror?.(error instanceof Error ? error : new Error(String(error)));

        }

      });

    });

  }

  send(message: JSONRPCMessage): Promise<void> {

    return new Promise((resolve, reject) => {

      if (!this.child?.stdin) {

        reject(new Error("MCP stdio is not connected"));

        return;

      }

      const json = serializeMessage(message);

      if (this.child.stdin.write(json)) {

        resolve();

        return;

      }

      this.child.stdin.once("drain", () => resolve());

    });

  }

  async close(): Promise<void> {

    const child = this.child;

    this.child = undefined;
    this.buffer.clear();

    if (!child) {

      this.onclose?.();

      return;

    }

    try {

      child.stdin?.end();

    } catch {

      // already closed
    }

    if (process.platform === "win32" && child.pid && child.pid !== process.pid) {

      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });

    } else {

      child.kill();

    }

    this.onclose?.();

  }

}
