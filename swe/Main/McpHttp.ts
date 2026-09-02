import http from "node:http";
import https from "node:https";

import type { IncomingMessage } from "node:http";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * Streamable HTTP for MCP using only node:http.
 *
 * Electron's fetch / Headers / Readable.toWeb are Chromium objects. Unreal's
 * MCP replies with SSE; wiring that through Chromium streams kills the browser
 * process (exit 3, crashpad "not connected") with no JS stack.
 */

function header(res: IncomingMessage, name: string): string | undefined {

  const value = res.headers[name.toLowerCase()];

  if (Array.isArray(value)) {

    return value[0];

  }

  return value;

}

function extractSseData(event: string): string | null {

  const lines: string[] = [];

  for (const line of event.split(/\r?\n/)) {

    if (line.startsWith("data:")) {

      lines.push(line.slice(5).replace(/^ /, ""));

    }

  }

  const data = lines.join("\n").trim();

  return data || null;

}

class SseParser {

  private rest = "";

  push(chunk: string): string[] {

    this.rest += chunk;

    const events: string[] = [];

    for (;;) {

      const lf = this.rest.indexOf("\n\n");
      const crlf = this.rest.indexOf("\r\n\r\n");

      let at = -1;
      let skip = 2;

      if (lf !== -1) {

        at = lf;
        skip = 2;

      }

      if (crlf !== -1 && (at === -1 || crlf < at)) {

        at = crlf;
        skip = 4;

      }

      if (at === -1) {

        break;

      }

      const data = extractSseData(this.rest.slice(0, at));

      this.rest = this.rest.slice(at + skip);

      if (data) {

        events.push(data);

      }

    }

    return events;

  }

}

export class McpHttpTransport implements Transport {

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  sessionId?: string;

  private url: URL;
  private extra: Record<string, string>;
  private protocolVersion: string | undefined;
  private closed = false;

  constructor(url: URL, headers?: Record<string, string>) {

    this.url = url;
    this.extra = headers ?? {};

  }

  setProtocolVersion = (version: string) => {

    this.protocolVersion = version;

  };

  async start(): Promise<void> {

    // no GET SSE — that path is what took Chromium down
  }

  send(message: JSONRPCMessage): Promise<void> {

    if (this.closed) {

      return Promise.reject(new Error("MCP HTTP transport is closed"));

    }

    const body = JSON.stringify(message);
    const tls = this.url.protocol === "https:";
    const lib = tls ? https : http;

    const headers: Record<string, string> = {

      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      ...this.extra,

    };

    if (this.sessionId) {

      headers["mcp-session-id"] = this.sessionId;

    }

    if (this.protocolVersion) {

      headers["mcp-protocol-version"] = this.protocolVersion;

    }

    return new Promise((resolve, reject) => {

      const req = lib.request({

        protocol: this.url.protocol,
        hostname: this.url.hostname,
        port: this.url.port || (tls ? 443 : 80),
        path: `${this.url.pathname}${this.url.search}`,
        method: "POST",
        headers,
        insecureHTTPParser: true,

      }, (res) => {

        const session = header(res, "mcp-session-id");

        if (session) {

          this.sessionId = session;

        }

        const status = res.statusCode ?? 0;

        if (status >= 400) {

          const chunks: Buffer[] = [];

          res.on("data", (chunk) => chunks.push(chunk as Buffer));
          res.on("error", reject);
          res.on("end", () => reject(new Error(`MCP HTTP ${status}: ${Buffer.concat(chunks).toString("utf8").slice(0, 800)}`)));

          return;

        }

        if (status === 202) {

          res.resume();
          resolve();

          return;

        }

        const type = header(res, "content-type") ?? "";

        if (type.includes("text/event-stream")) {

          const parser = new SseParser();

          res.setEncoding("utf8");
          res.on("error", reject);

          res.on("data", (chunk: string) => {

            for (const data of parser.push(chunk)) {

              try {

                this.onmessage?.(JSON.parse(data) as JSONRPCMessage);

              } catch (err) {

                this.onerror?.(err instanceof Error ? err : new Error(String(err)));

              }

            }

          });

          res.on("end", () => resolve());

          return;

        }

        const chunks: Buffer[] = [];

        res.on("error", reject);

        res.on("data", (chunk) => chunks.push(chunk as Buffer));

        res.on("end", () => {

          try {

            const text = Buffer.concat(chunks).toString("utf8").trim();

            if (text) {

              const data = JSON.parse(text) as unknown;
              const messages = Array.isArray(data) ? data : [data];

              for (const item of messages) {

                this.onmessage?.(item as JSONRPCMessage);

              }

            }

            resolve();

          } catch (err) {

            reject(err instanceof Error ? err : new Error(String(err)));

          }

        });

      });

      req.on("error", reject);
      req.write(body);
      req.end();

    });

  }

  async close(): Promise<void> {

    this.closed = true;
    this.onclose?.();

  }

}
