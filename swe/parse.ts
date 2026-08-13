// Transcript-side view of the protocol: turn a stored block back into rows, labels and diffs.

import { parseActions, parsePartial, VERBS, type Action, type Verb } from "./protocol";
import { parsePairs } from "./tools/edit";

export { VERBS as TOOLS };

export type Tool = Verb;

export interface ParsedReply {

  tool: Tool | null;
  desc: string;
  thinking: string;

  command: string | null;

}

function firstAction(text: string): Action | null {

  return parseActions(text).actions[0] ?? null;

}

/** Live and settled both land here: a complete block wins, a half-typed open tag still labels the row. */
export function parseReply(text: string): ParsedReply {

  const { thinking, actions } = parseActions(text);
  const action = actions[0];

  if (action) {

    return { tool: action.verb, desc: action.label || describe(action), thinking, command: action.raw };

  }

  const partial = parsePartial(text);

  if (partial.verb) {

    return { tool: partial.verb, desc: partial.label || partial.path, thinking, command: null };

  }

  return { tool: null, desc: "", thinking: text.trim(), command: null };

}

export function extractCommand(reply: string): string | null {

  return firstAction(reply)?.raw ?? null;

}

export function inferTool(command: string | null): Tool | null {

  return command ? firstAction(command)?.verb ?? null : null;

}

function bodyLines(action: Action): string[] {

  return action.body.split("\n").map((line) => line.trim()).filter(Boolean);

}

function baseName(path: string): string {

  return path.replace(/\\/g, "/").split("/").pop() || path;

}

/** The row label: what this block touches, in as few characters as read cleanly. */
function describe(action: Action): string {

  if (action.verb === "run") {

    const one = action.body.replace(/\s+/g, " ").trim();

    return one.length > 60 ? `${one.slice(0, 57)}…` : one;

  }

  if (action.verb === "grep") {

    return bodyLines(action)[0] ?? "";

  }

  if (action.verb === "say" || action.verb === "done") {

    return "";

  }

  if (action.path) {

    return baseName(action.path);

  }

  const names = bodyLines(action).map((line) => baseName(line.split(/[\s:]/)[0]));

  if (!names.length) {

    return "";

  }

  return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0];

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

/** Diff view of a stored block. Only write / edit / delete produce one. */
export function parseWrites(command: string): FileWrite[] {

  const action = firstAction(command);

  if (!action) {

    return [];

  }

  if (action.verb === "delete") {

    const targets = action.path ? [action.path] : bodyLines(action);

    return targets.map((file) => ({ file, kind: "delete" as const, added: 0, removed: 0, lines: [] }));

  }

  if (action.verb === "write") {

    const lines = action.body.split("\n").map((text) => ({ text, kind: "add" as const }));

    return [{ file: action.path || "new file", kind: "add", added: lines.length, removed: 0, lines }];

  }

  if (action.verb !== "edit") {

    return [];

  }

  const pairs = parsePairs(action.body);
  const lines: WriteLine[] = [];

  let added = 0;
  let removed = 0;

  for (const pair of pairs) {

    if (lines.length) {

      lines.push({ text: "", kind: "gap" });

    }

    for (const text of pair.find.split("\n")) {

      lines.push({ text, kind: "remove" });
      removed += 1;

    }

    for (const text of pair.replace.split("\n")) {

      lines.push({ text, kind: "add" });
      added += 1;

    }

  }

  return lines.length ? [{ file: action.path || "file", kind: "update", added, removed, lines }] : [];

}

export function fileEdits(command: string): FileEdit[] {

  return parseWrites(command).map(({ file, added, removed }) => ({ file, added, removed }));

}

/** One-line detail under the row for the tools that have no diff of their own. */
export function summarizeCall(command: string | null, tool: Tool | null): string {

  const action = command ? firstAction(command) : null;

  if (!action) {

    return tool ?? "";

  }

  if (action.verb === "read") {

    const specs = bodyLines(action);

    return specs.length ? `read ${specs.join(", ")}` : `read ${action.path}`;

  }

  if (action.verb === "ls") {

    return `ls ${action.path || bodyLines(action)[0] || "."}`;

  }

  if (action.verb === "grep") {

    const [pattern, where] = bodyLines(action);

    return where ? `grep ${pattern} in ${where}` : `grep ${pattern ?? ""}`;

  }

  return "";

}

/** Body of a `say` block — what the user actually reads. */
export function sayTextOf(command: string | null): string | null {

  const action = command ? firstAction(command) : null;

  return action?.verb === "say" ? action.body.trim() || null : null;

}

/** Shell body of a `run` block; null for every other verb. */
export function runCommandOf(command: string | null, tool: Tool | null): string | null {

  const action = command ? firstAction(command) : null;

  if (action?.verb === "run") {

    return action.body.trim();

  }

  return tool === "run" ? command : null;

}

export function isDoneStep(step: { tool: Tool | null; command: string | null }): boolean {

  return step.tool === "done" || inferTool(step.command) === "done";

}

export function extractFinishedSummary(text: string): string | null {

  const action = text ? firstAction(text) : null;

  return action?.verb === "done" ? action.body.trim() || "Task complete." : null;

}


export function cleanSummary(text: string): string {

  const summary = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return summary || "Task complete.";

}

/** The task the run was seeded with — always the tail of the prompt, after the `## Task` heading. */
export function extractTaskText(text: string): string | null {

  const trimmed = text.trim();

  if (!trimmed) {

    return null;

  }

  const heading = /^##\s*Task\s*$/m.exec(trimmed);

  if (heading) {

    return trimmed.slice(heading.index + heading[0].length).trim() || null;

  }

  // a plain follow-up submission is the task itself
  if (trimmed.length < 2000 && !trimmed.startsWith("[") && !trimmed.startsWith("You are a coding agent")) {

    return trimmed;

  }

  return null;

}

export interface StoredResult {

  verb: string;
  exitCode: number;
  output: string;

}

/**
 * Every result the harness posted for one reply, in order — a batched reply produces one per
 * block, and a reload pairs them back up with the rows that made them.
 */
export function parseResults(text: string): StoredResult[] {

  const head = /^\[([a-z]+) (ok|failed)\]$/gm;
  const trimmed = text.trim();
  const found: { verb: string; ok: boolean; from: number; to: number }[] = [];

  let match: RegExpExecArray | null;

  while ((match = head.exec(trimmed))) {

    const last = found[found.length - 1];

    if (last) {

      last.to = match.index;

    }

    found.push({ verb: match[1], ok: match[2] === "ok", from: match.index + match[0].length, to: trimmed.length });

  }

  return found.map((entry) => ({

    verb: entry.verb,
    exitCode: entry.ok ? 0 : 1,
    output: trimmed.slice(entry.from, entry.to).trim(),

  }));

}
