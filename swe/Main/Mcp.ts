import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { McpHttpTransport } from "./McpHttp";
import { McpStdioTransport } from "./McpStdio";
import { loadSettings } from "./Settings";
import { formatCallResult, type CallResult } from "../Tools/Mcp";

import type { McpServerConfig, McpServerStatus, McpToolInfo } from "../Types/Mcp";

const CLIENT_INFO = { name: "boombox", version: "0.1.0" };

/** A cold stdio server (uvx, npx) can take a while to come up the first time. */
const CONNECT_TIMEOUT_MS = Number(process.env.SWE_MCP_CONNECT_MS ?? 45_000);

const CALL_TIMEOUT_MS = Number(process.env.SWE_MCP_CALL_MS ?? 120_000);

// every editor writes the same map under a slightly different name
const PROJECT_FILES = [".mcp.json", join(".cursor", "mcp.json"), join(".vscode", "mcp.json")];

export interface McpEntry {

  name: string;
  source: string;

  transport: "stdio" | "http";

  config: McpServerConfig;

}

function serversIn(raw: unknown): Record<string, McpServerConfig> {

  if (!raw || typeof raw !== "object") {

    return {};

  }

  const root = raw as Record<string, unknown>;
  const map = root.mcpServers ?? root.servers ?? root;

  if (!map || typeof map !== "object") {

    return {};

  }

  return map as Record<string, McpServerConfig>;

}

function readConfigFile(path: string): Record<string, McpServerConfig> {

  try {

    if (!existsSync(path)) {

      return {};

    }

    return serversIn(JSON.parse(readFileSync(path, "utf8")));

  } catch {

    return {};

  }

}

function transportOf(config: McpServerConfig): "stdio" | "http" | null {

  if (typeof config.url === "string" && config.url.trim()) {

    return "http";

  }

  if (typeof config.command === "string" && config.command.trim()) {

    return "stdio";

  }

  return null;

}

/** User settings first, then the project's own files — a project entry replaces the user's. */
export function listServers(cwd: string): McpEntry[] {

  const found = new Map<string, McpEntry>();

  const add = (source: string, map: Record<string, McpServerConfig>) => {

    for (const [name, config] of Object.entries(map)) {

      if (!config || typeof config !== "object" || config.disabled) {

        continue;

      }

      const transport = transportOf(config);

      if (!transport) {

        continue;

      }

      found.set(name, { name, source, transport, config });

    }

  };

  add("settings", loadSettings().mcpServers ?? {});

  for (const file of PROJECT_FILES) {

    add(file.replace(/\\/g, "/"), readConfigFile(join(cwd, file)));

  }

  return [...found.values()];

}

const pool = new Map<string, Promise<Client>>();

function keyFor(cwd: string, name: string): string {

  return `${cwd}\u0000${name}`;

}

function withTimeout<T>(job: Promise<T>, ms: number, what: string): Promise<T> {

  return new Promise<T>((resolve, reject) => {

    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);

    job.then((value) => {

      clearTimeout(timer);
      resolve(value);

    }, (err: unknown) => {

      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));

    });

  });

}

async function open(entry: McpEntry, cwd: string): Promise<Client> {

  const client = new Client(CLIENT_INFO, { capabilities: {} });

  const transport = entry.transport === "http"
    ? new McpHttpTransport(new URL(entry.config.url as string), entry.config.headers)
    : new McpStdioTransport({

      command: entry.config.command as string,
      args: entry.config.args ?? [],
      env: entry.config.env,
      cwd,

    });

  await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `Connecting to "${entry.name}"`);

  return client;

}

export function connect(cwd: string, name: string): Promise<Client> {

  const entry = listServers(cwd).find((server) => server.name === name);

  if (!entry) {

    return Promise.reject(new Error(`No MCP server named "${name}" is configured for this project. Send a bare <mcp> block to see what is.`));

  }

  const key = keyFor(cwd, name);
  const existing = pool.get(key);

  if (existing) {

    return existing;

  }

  // a failed connection must not stay cached, or every later call inherits the same error
  const started = open(entry, cwd).catch((err: unknown) => {

    pool.delete(key);

    throw err;

  });

  pool.set(key, started);

  return started;

}

function paramsOf(schema: unknown): string[] {

  const shape = schema as { properties?: Record<string, unknown>; required?: string[] } | undefined;

  if (!shape?.properties) {

    return [];

  }

  const required = new Set(shape.required ?? []);

  return Object.keys(shape.properties).map((key) => (required.has(key) ? key : `${key}?`));

}

export async function listTools(cwd: string, name: string): Promise<McpToolInfo[]> {

  const client = await connect(cwd, name);
  const result = await withTimeout(client.listTools(), CALL_TIMEOUT_MS, `Listing tools on "${name}"`);

  return (result.tools ?? []).map((tool) => ({

    name: tool.name,
    description: (tool.description ?? "").split("\n")[0].trim(),

    params: paramsOf(tool.inputSchema),

  }));

}

/** Every configured server with its tools, or the reason it could not be reached. */
export async function catalog(cwd: string, only?: string): Promise<McpServerStatus[]> {

  const all = listServers(cwd);
  const entries = only ? all.filter((entry) => entry.name === only) : all;

  if (only && !entries.length) {

    throw new Error(`No MCP server named "${only}" is configured for this project. Send a bare <mcp> block to see what is.`);

  }

  return Promise.all(entries.map(async (entry): Promise<McpServerStatus> => {

    try {

      const tools = await listTools(cwd, entry.name);

      return { name: entry.name, source: entry.source, transport: entry.transport, connected: true, error: null, tools };

    } catch (err) {

      return {

        name: entry.name,
        source: entry.source,
        transport: entry.transport,

        connected: false,
        error: err instanceof Error ? err.message : String(err),

        tools: [],

      };

    }

  }));

}

export async function callTool(cwd: string, server: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {

  const client = await connect(cwd, server);

  const result = await withTimeout(client.callTool({ name: tool, arguments: args }), CALL_TIMEOUT_MS, `${server}.${tool}`) as CallResult;

  return { ok: !result.isError, text: formatCallResult(result) };

}

export async function closeAll(): Promise<void> {

  const clients = [...pool.values()];

  pool.clear();

  await Promise.all(clients.map((pending) => pending.then((client) => client.close()).catch(() => undefined)));

}

/** Drop cached connections so the next call re-reads the config files. */
export function refresh(): void {

  void closeAll();

}

/** Named in the run's opening prompt so the model knows the block is worth reaching for. */
export function mcpPromptSection(cwd: string): string {

  const servers = listServers(cwd);

  if (!servers.length) {

    return "";

  }

  const lines = servers.map((server) => `- ${server.name} (${server.transport}, from ${server.source})`);
  const count = servers.length === 1 ? "one MCP server" : `${servers.length} MCP servers`;

  return `\n\n## MCP servers\n\nThis project has ${count} configured:\n\n${lines.join("\n")}\n\nSend a bare <mcp> block to see the tools each one exposes before you call anything.`;

}
