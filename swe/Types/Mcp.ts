/** One entry from an `mcpServers` map: a program to spawn, or an endpoint to call. */
export interface McpServerConfig {

  command?: string;
  args?: string[];
  env?: Record<string, string>;

  url?: string;
  headers?: Record<string, string>;

  disabled?: boolean;

}

export interface McpToolInfo {

  name: string;
  description: string;

  /** Argument names from the tool's schema; optional ones carry a trailing `?`. */
  params: string[];

}

export interface McpServerStatus {

  name: string;

  /** Where the entry came from — `settings`, or the project file that declared it. */
  source: string;

  transport: "stdio" | "http";

  connected: boolean;
  error: string | null;

  tools: McpToolInfo[];

}
