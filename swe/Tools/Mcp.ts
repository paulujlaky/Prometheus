// An MCP tool call: the model names server.tool on the tag and writes the arguments as key: value lines.

import type { Action } from "../Agent/Protocol";
import type { McpServerStatus } from "../Types/Mcp";

export interface McpCall {

  /** Empty when the model wants the whole catalogue. */
  server: string;

  /** Empty when the model wants one server's tools rather than a call. */
  tool: string;

  args: Record<string, unknown>;

}

const TARGET = /^([\w-]+)(?:[.:/]([\w.-]+))?$/;

const PAIR = /^([A-Za-z_][\w.-]*)\s*[:=]\s*(.*)$/;

/** Numbers, booleans and JSON literals arrive typed; everything else stays a string. */
function coerce(raw: string): unknown {

  const value = raw.trim();

  if (!value) {

    return "";

  }

  if (/^(true|false|null)$/.test(value) || /^-?\d+(\.\d+)?$/.test(value) || /^[[{"]/.test(value)) {

    try {

      return JSON.parse(value);

    } catch {

      return value;

    }

  }

  return value;

}

function parseArgs(body: string): Record<string, unknown> {

  const trimmed = body.trim();

  if (!trimmed) {

    return {};

  }

  if (trimmed.startsWith("{")) {

    try {

      const parsed = JSON.parse(trimmed) as unknown;

      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {

        return parsed as Record<string, unknown>;

      }

    } catch {

      // not JSON after all — fall through to the line form

    }

  }

  const args: Record<string, unknown> = {};

  let last = "";

  for (const raw of trimmed.split("\n")) {

    const line = raw.trimEnd();
    const pair = PAIR.exec(line.trim());

    if (pair) {

      last = pair[1];
      args[last] = coerce(pair[2]);

      continue;

    }

    // a line that is not a pair continues the value above it, so multi-line text survives
    if (last && typeof args[last] === "string") {

      args[last] = `${args[last] as string}\n${line}`.trim();

    }

  }

  return args;

}

export function parseMcp(action: Action): McpCall {

  const target = action.path.trim();

  if (!target) {

    if (action.body.trim()) {

      throw new Error("mcp needs the server and tool on the tag: <mcp unity.create_scene>. A bare <mcp> with an empty body lists what is available.");

    }

    return { server: "", tool: "", args: {} };

  }

  const named = TARGET.exec(target);

  if (!named) {

    throw new Error(`"${target}" is not an MCP target. Use <mcp server.tool> to call a tool, or <mcp server> to list one server's tools.`);

  }

  const server = named[1];
  const tool = named[2] ?? "";

  if (!tool) {

    return { server, tool: "", args: {} };

  }

  return { server, tool, args: parseArgs(action.body) };

}

export function formatCatalog(servers: McpServerStatus[]): string {

  if (!servers.length) {

    return `No MCP servers are configured for this project. Add one to .mcp.json or .cursor/mcp.json in the repo root, or to ~/.bbx/settings.json under "mcpServers".`;

  }

  return servers.map((server) => {

    const head = `[${server.name}] ${server.transport} · ${server.source}`;

    if (!server.connected) {

      return `${head}\nnot connected: ${server.error ?? "unknown error"}`;

    }

    if (!server.tools.length) {

      return `${head}\nconnected, but it exposes no tools.`;

    }

    const tools = server.tools.map((tool) => {

      const params = tool.params.length ? ` (${tool.params.join(", ")})` : "";
      const description = tool.description ? ` — ${tool.description}` : "";

      return `  ${server.name}.${tool.name}${params}${description}`;

    });

    return `${head}\n${tools.join("\n")}`;

  }).join("\n\n");

}

export interface CallContent {

  type: string;
  text?: string;

}

export interface CallResult {

  content?: CallContent[];
  structuredContent?: unknown;

  isError?: boolean;

}

const MAX_CALL_TEXT = 100_000;

export function formatCallResult(result: CallResult): string {

  const parts: string[] = [];

  for (const item of result.content ?? []) {

    if (item.type === "image" || item.type === "audio" || item.type === "resource") {

      parts.push(`[${item.type} content]`);
      continue;

    }

    if (typeof item.text === "string" && item.text.trim()) {

      parts.push(item.text.trim());
      continue;

    }

    parts.push(`[${item.type} content]`);

  }

  if (!parts.length && result.structuredContent !== undefined) {

    parts.push(JSON.stringify(result.structuredContent, null, 2));

  }

  const text = parts.join("\n\n").trim();

  if (!text) {

    return result.isError ? "The tool reported an error but returned no message." : "The tool returned no content.";

  }

  if (text.length <= MAX_CALL_TEXT) {

    return text;

  }

  return `${text.slice(0, MAX_CALL_TEXT)}\n\n... ${text.length - MAX_CALL_TEXT} characters cut ...`;

}
