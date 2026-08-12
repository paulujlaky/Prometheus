import type { ToolCall } from "../../sdk/types";

import { firstString, filesOf, pathsOf } from "../parse";
import { applyPatch, formatApplyReport } from "./apply_patch";
import { deleteFiles, readFiles, searchFiles, writeFiles } from "./fs";

export const VERBS = ["read", "search", "write", "edit", "delete", "run", "echo", "done"] as const;

export type Verb = (typeof VERBS)[number];

/** Must stay in lockstep with VERBS — missing keys fail the typecheck. */
export const VERB_HELP: { [K in Verb]: string } = {

  read: "{\"paths\":[\"file\"]}  — whole file. Optional start/end only for huge files.",
  search: "{\"pattern\":\"...\",\"path\":\"src\",\"glob\":\"*.ts\",\"max\":80}",
  write: "{\"files\":[{\"path\":\"a.ts\",\"content\":\"...\"}]}",
  edit: "{\"path\":\"a.ts\",\"old\":\"exact text from read\",\"new\":\"replacement\"}",
  delete: "{\"paths\":[\"gone.ts\"]}",
  run: "{\"command\":\"bash\"}  — builds, git, tests. Not for editing files.",
  echo: "{\"text\":\"message\"}  — rare status note for the user.",
  done: "{\"summary\":\"what shipped\"}  — only when every Task item is done.",

};

export function advertisedTools(): string {

  return VERBS.join("|");

}

export interface ToolExec {

  tool: Verb;
  label: string;

  kind: "local" | "run" | "echo" | "done";

  output?: string;
  command?: string;
  summary?: string;
  exit?: number;

}

export function isVerb(name: string): name is Verb {

  return (VERBS as readonly string[]).includes(name);

}

export function defaultLabel(call: ToolCall): string {

  if (call.label?.trim()) {

    return call.label.replace(/\s+/g, " ").trim().split(/\s+/).slice(0, 8).join(" ");

  }

  const paths = pathsOf(call.args);
  const files = filesOf(call.args);

  if (files[0]) {

    return files[0].path.split("/").pop() ?? call.tool;

  }

  if (paths[0]) {

    return paths[0].split("/").pop() ?? call.tool;

  }

  const pattern = firstString(call.args, "pattern");

  if (pattern) {

    return pattern.slice(0, 40);

  }

  return call.tool;

}

export function prepareCall(call: ToolCall, cwd: string): ToolExec {

  const tool = call.tool.toLowerCase();

  if (!isVerb(tool)) {

    throw new Error(`unknown tool "${call.tool}" — use ${VERBS.join("|")}`);

  }

  const label = defaultLabel({ ...call, tool });
  const args = call.args;

  if (tool === "read") {

    return { tool, label, kind: "local", output: readFiles(cwd, pathsOf(args), rangeOf(args)) };

  }

  if (tool === "search") {

    const pattern = firstString(args, "pattern") ?? "";
    const path = firstString(args, "path") ?? firstString(args, "root") ?? ".";
    const glob = firstString(args, "glob") ?? undefined;
    const max = numberOf(args, "max") ?? 80;

    return { tool, label, kind: "local", output: searchFiles(cwd, pattern, path, glob, max) };

  }

  if (tool === "write") {

    return { tool, label, kind: "local", output: writeFiles(cwd, filesOf(args)) };

  }

  if (tool === "delete") {

    return { tool, label, kind: "local", output: deleteFiles(cwd, pathsOf(args)) };

  }

  if (tool === "edit") {

    const patch = patchFromArgs(args);

    const report = applyPatch(patch, cwd);

    return {

      tool,
      label,
      kind: "local",
      output: formatApplyReport(report),
      exit: report.ok ? 0 : 1,

    };

  }

  if (tool === "run") {

    const command = firstString(args, "command");

    if (!command?.trim()) {

      throw new Error("run: args.command required");

    }

    return { tool, label, kind: "run", command };

  }

  if (tool === "echo") {

    const text = firstString(args, "text");

    if (!text?.trim()) {

      throw new Error("echo: args.text required");

    }

    return { tool, label, kind: "echo", output: text.trim() };

  }

  const summary = firstString(args, "summary") ?? pathsOf(args)[0] ?? label;

  return { tool: "done", label, kind: "done", summary: summary.trim() || "Task complete." };

}

/** Prefer {path,old,new} — JSON-safe. Still accepts a raw apply_patch string. */
export function patchFromArgs(args: unknown): string {

  const raw = firstString(args, "patch");

  if (raw?.trim()) {

    return raw;

  }

  const files = editFilesOf(args);

  if (!files.length) {

    throw new Error("edit: args.path + old/new (or args.files / args.patch) required");

  }

  const lines = ["*** Begin Patch"];

  for (const file of files) {

    if (file.kind === "delete") {

      lines.push(`*** Delete File: ${file.path}`);
      continue;

    }

    if (file.kind === "add") {

      lines.push(`*** Add File: ${file.path}`);

      for (const line of file.body.split("\n")) {

        lines.push(`+${line}`);

      }

      continue;

    }

    lines.push(`*** Update File: ${file.path}`);
    lines.push("@@");

    for (const line of file.old.split("\n")) {

      lines.push(`-${line}`);

    }

    for (const line of file.next.split("\n")) {

      lines.push(`+${line}`);

    }

  }

  lines.push("*** End Patch");

  return lines.join("\n");

}

export function editFilesOf(args: unknown): { path: string; kind: "update" | "add" | "delete"; old: string; next: string; body: string }[] {

  if (Array.isArray(args)) {

    return args.flatMap(editFilesOf);

  }

  if (!args || typeof args !== "object") {

    return [];

  }

  const obj = args as Record<string, unknown>;

  if (Array.isArray(obj.files)) {

    return obj.files.flatMap(editFilesOf);

  }

  if (typeof obj.path !== "string") {

    return [];

  }

  if (obj.delete === true) {

    return [{ path: obj.path, kind: "delete", old: "", next: "", body: "" }];

  }

  const next = typeof obj.new === "string" ? obj.new : typeof obj.content === "string" ? obj.content : "";
  const old = typeof obj.old === "string" ? obj.old : "";

  if (!old && next) {

    return [{ path: obj.path, kind: "add", old: "", next, body: next }];

  }

  if (old || next) {

    return [{ path: obj.path, kind: "update", old, next, body: next }];

  }

  return [];

}

function rangeOf(args: unknown): { start?: number; end?: number } {

  const start = numberOf(args, "start") ?? numberOf(args, "from") ?? numberOf(args, "offset");
  const end = numberOf(args, "end") ?? numberOf(args, "to");
  const limit = numberOf(args, "limit");

  if (start != null && end == null && limit != null) {

    return { start, end: start + limit - 1 };

  }

  return { start, end };

}

function numberOf(args: unknown, key: string): number | undefined {

  if (!args || typeof args !== "object" || Array.isArray(args)) {

    return undefined;

  }

  const value = (args as Record<string, unknown>)[key];

  if (typeof value === "number" && Number.isFinite(value)) {

    return Math.trunc(value);

  }

  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {

    return Math.trunc(Number(value));

  }

  return undefined;

}
