// JSON-first protocol parser. Legacy bash-fence replies still parse for old chats.

import { parseToolCalls } from "../sdk/tools";

export const FINISHED = "MINI_SWE_FINISHED";

export const TOOLS = ["read", "search", "write", "edit", "delete", "run", "echo", "test", "fix", "think", "done"] as const;

export type Tool = (typeof TOOLS)[number];

const TOOL_SET = new Set<string>(TOOLS);

const TOOL_LINE = new RegExp(`^(${TOOLS.join("|")})\\s*:\\s*(.+)$`, "i");
const DESC_LINE = /^desc\s*:\s*(.+)$/i;
const FENCE_OPEN = /```[ \t]*(?:bash|sh|shell|json)?[ \t]*\r?\n/i;

export interface ParsedReply {

  tool: Tool | null;
  desc: string;
  thinking: string;

  command: string | null;
  hasFence: boolean;

}

export function asTool(name: string | null | undefined): Tool | null {

  if (!name) {

    return null;

  }

  const lower = name.toLowerCase();

  return TOOL_SET.has(lower) ? (lower as Tool) : null;

}

/** Live + settled parse: JSON call, or mid-stream "tool"/"label" keys, or legacy fence. */
export function parseReply(text: string): ParsedReply {

  const start = indexOfJson(text);
  const thinkingHead = start === -1 ? text : text.slice(0, start);
  const calls = parseToolCalls(text);

  if (calls[0]) {

    const call = calls[0];
    const tool = asTool(call.tool);

    return {

      tool,
      desc: (call.label ?? "").replace(/\s+/g, " ").trim(),
      thinking: stripPartialJson(thinkingHead),
      command: JSON.stringify({ tool: call.tool, label: call.label, args: call.args }),
      hasFence: true,

    };

  }

  if (start !== -1) {

    const partial = parsePartialJson(text.slice(start));

    return {

      tool: partial.tool,
      desc: partial.desc,
      thinking: stripPartialJson(thinkingHead),
      command: null,
      hasFence: true,

    };

  }

  return parseLegacy(text);

}

function parsePartialJson(chunk: string): { tool: Tool | null; desc: string } {

  const tool = /"tool"\s*:\s*"([^"]+)"/.exec(chunk);
  const label = /"label"\s*:\s*"([^"]*)"/.exec(chunk);

  return {

    tool: asTool(tool?.[1]),
    desc: (label?.[1] ?? "").replace(/\s+/g, " ").trim(),

  };

}

function indexOfJson(text: string): number {

  const fenced = /```(?:json)?\s*[\r\n]+/.exec(text);

  if (fenced) {

    return fenced.index;

  }

  const toolKey = text.search(/\{\s*"(?:tool|calls)"\s*:/);

  return toolKey;

}

function stripPartialJson(text: string): string {

  return text.replace(/```(?:json)?\s*$/i, "").trim();

}

function parseLegacy(text: string): ParsedReply {

  const open = FENCE_OPEN.exec(text);

  if (!open) {

    const { tool, desc, thinking } = parseLeading(text);

    return { tool, desc, thinking, command: null, hasFence: false };

  }

  const body = text.slice(open.index + open[0].length);
  const close = body.indexOf("```");
  const command = (close === -1 ? body : body.slice(0, close)).trim();
  const { tool, desc, thinking } = parseLeading(text.slice(0, open.index));

  return { tool, desc, thinking, command: command || null, hasFence: true };

}

export function parseLeading(leading: string): { tool: Tool | null; desc: string; thinking: string } {

  const raw = leading.trim();

  if (!raw) {

    return { tool: null, desc: "", thinking: "" };

  }

  const think: string[] = [];
  let tool: Tool | null = null;
  let desc = "";

  for (const line of raw.split(/\r?\n/)) {

    const trimmed = line.trim();
    const classified = TOOL_LINE.exec(trimmed);

    if (classified) {

      tool = asTool(classified[1]);
      desc = classified[2].replace(/\s+/g, " ").trim();
      continue;

    }

    const legacy = DESC_LINE.exec(trimmed);

    if (legacy) {

      desc = legacy[1].replace(/\s+/g, " ").trim();
      continue;

    }

    think.push(line);

  }

  if (desc) {

    return { tool, desc, thinking: think.join("\n").trim() };

  }

  return { tool: null, desc: "", thinking: raw };

}

export function extractCommand(reply: string): string | null {

  return parseReply(reply).command;

}

export function inferTool(command: string | null): Tool {

  if (!command) {

    return "think";

  }

  const parsed = parseReply(command);

  if (parsed.tool) {

    return parsed.tool;

  }

  if (/apply_patch|git\s+apply/m.test(command)) {

    return "edit";

  }

  if (/^\s*(rg|grep|find)\b/m.test(command)) {

    return "search";

  }

  return "run";

}

export type WriteKind = "add" | "update" | "delete";

export interface WriteLine {

  text: string;
  kind: "add" | "remove" | "context" | "gap";

}

export interface FileWrite {

  file: string;
  kind: WriteKind;

  added: number;
  removed: number;

  lines: WriteLine[];

}

export interface FileEdit {

  file: string;
  added: number;
  removed: number;

}

const PATCH_SECTION = /^\*\*\*\s*(Add|Update|Delete)\s+File:\s*(.+)$/;
const DIFF_HEADER = /^\+\+\+\s+(?:b\/)?(.+)$/;

export function parseWrites(command: string): FileWrite[] {

  if (!command) {

    return [];

  }

  const fromJson = writesFromJson(command);

  if (fromJson) {

    return fromJson;

  }

  return writesFromPatch(command);

}

function writesFromJson(command: string): FileWrite[] | null {

  let raw: unknown;

  try {

    raw = JSON.parse(command);

  } catch {

    return null;

  }

  if (!raw || typeof raw !== "object") {

    return null;

  }

  const obj = raw as { tool?: string; args?: unknown };
  const tool = String(obj.tool ?? "");
  const args = obj.args;

  if (tool === "write") {

    return filesOf(args).map((file) => linesOf(file.path, file.content, "add"));

  }

  if (tool === "delete") {

    return pathsOf(args).map((file) => ({ file, kind: "delete" as const, added: 0, removed: 0, lines: [] }));

  }

  if (tool === "edit") {

    const patch = firstString(args, "patch") ?? (typeof args === "string" ? args : "");

    if (patch) {

      return writesFromPatch(patch);

    }

    return editViewsOf(args);

  }

  return [];

}

function editViewsOf(args: unknown): FileWrite[] {

  if (Array.isArray(args)) {

    return args.flatMap(editViewsOf);

  }

  if (!args || typeof args !== "object") {

    return [];

  }

  const obj = args as Record<string, unknown>;

  if (Array.isArray(obj.files)) {

    return obj.files.flatMap(editViewsOf);

  }

  if (typeof obj.path !== "string") {

    return [];

  }

  if (obj.delete === true) {

    return [{ file: obj.path, kind: "delete", added: 0, removed: 0, lines: [] }];

  }

  const next = typeof obj.new === "string" ? obj.new : typeof obj.content === "string" ? obj.content : "";
  const old = typeof obj.old === "string" ? obj.old : "";

  if (!old && next) {

    return [linesOf(obj.path, next, "add")];

  }

  const lines: FileWrite["lines"] = [];
  let added = 0;
  let removed = 0;

  if (old) {

    for (const line of old.split("\n")) {

      lines.push({ text: line, kind: "remove" });
      removed += 1;

    }

  }

  if (next) {

    for (const line of next.split("\n")) {

      lines.push({ text: line, kind: "add" });
      added += 1;

    }

  }

  return old || next ? [{ file: obj.path, kind: "update", added, removed, lines }] : [];

}

export function filesOf(args: unknown): { path: string; content: string }[] {

  if (Array.isArray(args)) {

    return args.flatMap(filesOf);

  }

  if (!args || typeof args !== "object") {

    return [];

  }

  const obj = args as Record<string, unknown>;

  if (Array.isArray(obj.files)) {

    return obj.files.flatMap(filesOf);

  }

  if (typeof obj.path === "string" && typeof obj.content === "string") {

    return [{ path: obj.path, content: obj.content }];

  }

  return [];

}

export function pathsOf(args: unknown): string[] {

  if (typeof args === "string") {

    return [args];

  }

  if (Array.isArray(args)) {

    return args.flatMap(pathsOf);

  }

  if (!args || typeof args !== "object") {

    return [];

  }

  const obj = args as Record<string, unknown>;

  if (typeof obj.path === "string") {

    return [obj.path];

  }

  if (Array.isArray(obj.paths)) {

    return obj.paths.flatMap(pathsOf);

  }

  return [];

}

export function firstString(args: unknown, key: string): string | null {

  if (typeof args === "string") {

    return args;

  }

  if (Array.isArray(args)) {

    return typeof args[0] === "string" ? args[0] : args[0] ? firstString(args[0], key) : null;

  }

  if (args && typeof args === "object") {

    const value = (args as Record<string, unknown>)[key];

    return typeof value === "string" ? value : null;

  }

  return null;

}

function linesOf(file: string, content: string, kind: WriteKind): FileWrite {

  const lines = content.split(/\r?\n/).map((text) => ({ text, kind: "add" as const }));

  return { file, kind, added: lines.length, removed: 0, lines };

}

function writesFromPatch(command: string): FileWrite[] {

  const writes: FileWrite[] = [];
  let current: FileWrite | null = null;

  const open = (file: string, kind: WriteKind): FileWrite => {

    const existing = writes.find((write) => write.file === file);

    if (existing) {

      return existing;

    }

    const write: FileWrite = { file: file.trim(), kind, added: 0, removed: 0, lines: [] };

    writes.push(write);

    return write;

  };

  for (const line of command.split(/\r?\n/)) {

    const section = PATCH_SECTION.exec(line);

    if (section) {

      current = open(section[2], section[1].toLowerCase() as WriteKind);
      continue;

    }

    const header = DIFF_HEADER.exec(line);

    if (header) {

      current = open(header[1], "update");
      continue;

    }

    if (!current || line.startsWith("---") || line.startsWith("+++")) {

      continue;

    }

    if (line.startsWith("@@")) {

      if (current.lines.length) {

        current.lines.push({ text: "", kind: "gap" });

      }

      continue;

    }

    if (line.startsWith("+")) {

      current.lines.push({ text: line.slice(1), kind: "add" });
      current.added += 1;
      continue;

    }

    if (line.startsWith("-")) {

      current.lines.push({ text: line.slice(1), kind: "remove" });
      current.removed += 1;
      continue;

    }

    if (line.startsWith(" ")) {

      current.lines.push({ text: line.slice(1), kind: "context" });

    }

  }

  for (const write of writes) {

    while (write.lines[write.lines.length - 1]?.kind === "gap") {

      write.lines.pop();

    }

  }

  return writes.filter((write) => write.kind === "delete" || write.lines.length > 0);

}

export function fileEdits(command: string): FileEdit[] {

  return parseWrites(command).map(({ file, added, removed }) => ({ file, added, removed }));

}

function baseName(path: string): string {

  const parts = path.replaceAll("\\", "/").split("/");

  return parts[parts.length - 1] || path;

}

function lineSpan(args: unknown): string {

  if (!args || typeof args !== "object" || Array.isArray(args)) {

    return "";

  }

  const obj = args as Record<string, unknown>;
  const start = asInt(obj.start ?? obj.from ?? obj.offset);
  const end = asInt(obj.end ?? obj.to);
  const limit = asInt(obj.limit);

  if (start == null && end == null) {

    return "";

  }

  if (start != null && end != null) {

    return `L${start}–${end}`;

  }

  if (start != null && limit != null) {

    return `L${start}–${start + limit - 1}`;

  }

  if (start != null) {

    return `L${start}+`;

  }

  return `–L${end}`;

}

function asInt(value: unknown): number | null {

  if (typeof value === "number" && Number.isFinite(value)) {

    return Math.trunc(value);

  }

  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {

    return Math.trunc(Number(value));

  }

  return null;

}

/** One-line `read: a.ts` style summary for the tool-row body. */
export function summarizeCall(command: string | null, tool: Tool | null): string {

  const name = tool ?? inferTool(command);

  if (!command) {

    return name;

  }

  try {

    const raw = JSON.parse(command) as { args?: unknown };
    const args = raw.args;
    const pattern = firstString(args, "pattern");

    if (name === "search" && pattern) {

      const where = firstString(args, "path") ?? firstString(args, "root");

      return where && where !== "." ? `${name}: ${pattern} in ${where}` : `${name}: ${pattern}`;

    }

    const files = [...new Set([
      ...filesOf(args).map((file) => baseName(file.path)),
      ...pathsOf(args).map(baseName).filter((file) => file && file !== "."),
    ])];

    if (files.length) {

      const shown = files.slice(0, 3).join(", ");
      const more = files.length > 3 ? ` +${files.length - 3}` : "";
      const span = lineSpan(args);

      return span ? `${name}: ${shown}${more} ${span}` : `${name}: ${shown}${more}`;

    }

    if (pattern) {

      return `${name}: ${pattern}`;

    }

    const bash = firstString(args, "command");

    if (bash) {

      const one = bash.replace(/\s+/g, " ").trim();

      return `${name}: ${one.length > 60 ? `${one.slice(0, 57)}…` : one}`;

    }

  } catch {

    // legacy fence
  }

  return name;

}

/** Bash body for a `run` call; null for every other tool. */
export function runCommandOf(command: string | null, tool: Tool | null): string | null {

  if ((tool ?? inferTool(command)) !== "run" || !command) {

    return null;

  }

  try {

    const raw = JSON.parse(command) as { args?: unknown };

    return firstString(raw.args, "command");

  } catch {

    return command;

  }

}

export function isDoneStep(step: { tool: Tool | null; command: string | null }): boolean {

  return step.tool === "done" || inferTool(step.command) === "done";

}

export function extractFinishedSummary(output: string): string | null {

  if (!output) {

    return null;

  }

  const fromJson = summaryFromJson(output);

  if (fromJson) {

    return fromJson;

  }

  if (!output.includes(FINISHED)) {

    return null;

  }

  const lineRe = new RegExp(`(?:^|\\r?\\n)[ \\t]*${FINISHED}\\s*:?\\s*([^\\r\\n]*)`);
  const lineMatch = lineRe.exec(output);

  if (lineMatch) {

    return (lineMatch[1] ?? "").replace(/^["']|["']$/g, "").trim() || "Task complete.";

  }

  return null;

}

function summaryFromJson(text: string): string | null {

  const calls = parseToolCalls(text);

  if (asTool(calls[0]?.tool) === "done") {

    return firstString(calls[0].args, "summary") ?? pathsOf(calls[0].args)[0] ?? calls[0].label ?? "Task complete.";

  }

  try {

    const raw = JSON.parse(text.trim()) as { tool?: string; summary?: string; args?: unknown };

    if (raw.tool === "done") {

      return firstString(raw.args, "summary") ?? raw.summary ?? "Task complete.";

    }

    if (typeof raw.summary === "string" && raw.summary.trim()) {

      return raw.summary.trim();

    }

  } catch {

    // not json
  }

  return null;

}

export function cleanSummary(text: string): string {

  let s = text.trim();

  s = s.replace(new RegExp(`^${FINISHED}[:\\s|-]*`, "i"), "");
  s = s.replace(/```[\s\S]*$/g, "").trim();
  s = s.replace(/\s+/g, " ");

  return s || "Task complete.";

}

export function extractTaskText(text: string): string | null {

  const trimmed = text.trim();

  if (!trimmed) {

    return null;

  }

  try {

    const raw = JSON.parse(trimmed) as { task?: unknown };

    if (typeof raw.task === "string" && raw.task.trim()) {

      return raw.task.trim();

    }

  } catch {

    // seed is prose
  }

  const taskLine = /\nTask:\s*([\s\S]+)$/m.exec(trimmed);

  if (taskLine) {

    return taskLine[1].trim();

  }

  if (/^Task:\s*/i.test(trimmed)) {

    return trimmed.replace(/^Task:\s*/i, "").trim();

  }

  if (trimmed.length < 2000 && !trimmed.includes("You are a coding agent") && !trimmed.includes("\"tool_result\"") && !trimmed.includes("\"emit\"")) {

    return trimmed;

  }

  return null;

}

/** Observation the harness posted — JSON or legacy `Exit code:` blob. */
export function parseObservation(text: string): { exitCode: number; output: string } | null {

  const trimmed = text.trim();

  try {

    const raw = JSON.parse(trimmed) as { ok?: unknown; output?: unknown; exit?: unknown; error?: unknown };

    if (typeof raw.ok === "boolean" || typeof raw.output === "string") {

      const output = typeof raw.output === "string" ? raw.output : typeof raw.error === "string" ? raw.error : "";
      const exitCode = typeof raw.exit === "number" ? raw.exit : raw.ok === false ? 1 : 0;

      return { exitCode, output };

    }

  } catch {

    // legacy
  }

  const match = /^Exit code:\s*(-?\d+)\s*\n?([\s\S]*)$/.exec(trimmed);

  if (!match) {

    return null;

  }

  return { exitCode: Number(match[1]), output: (match[2] ?? "").replace(/^\n/, "") };

}
