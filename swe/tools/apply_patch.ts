#!/usr/bin/env bun
/**
 * apply_patch — multi-file editor using the open Codex / Agents "apply_patch" format.
 *
 * Each file is applied independently. One stale hunk does not roll back
 * unrelated files. The report lists what landed and what failed.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";

import { applyDiff } from "./apply_diff";

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const UPDATE = "*** Update File:";
const ADD = "*** Add File:";
const DEL = "*** Delete File:";

export type PatchOp =
  | { kind: "update"; path: string; body: string[] }
  | { kind: "add"; path: string; body: string[] }
  | { kind: "delete"; path: string };

export interface FileResult {

  file: string;
  op: PatchOp["kind"];
  ok: boolean;
  error?: string;

}

export interface ApplyReport {

  ok: boolean;
  applied: FileResult[];
  failed: FileResult[];

}

function die(msg: string, code = 1): never {

  console.error(msg);
  process.exit(code);

}

function readInput(): string {

  const arg = process.argv[2];

  if (arg && arg !== "-") {

    if (!existsSync(arg)) {

      die(`apply_patch: file not found: ${arg}`);

    }

    return readFileSync(arg, "utf8");

  }

  const fd = 0;

  try {

    if (process.stdin.isTTY) {

      die("apply_patch: pass a patch file or pipe a patch on stdin\nusage: apply_patch [file|-]");

    }

  } catch {

    // ignore
  }

  return readFileSync(fd).toString("utf8");

}

function safeRelPath(raw: string, cwd: string): string {

  const trimmed = raw.trim().replace(/\\/g, "/");

  if (!trimmed || trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) {

    throw new Error(`path must be relative: ${raw}`);

  }

  if (trimmed.split("/").includes("..")) {

    throw new Error(`path must not contain ..: ${raw}`);

  }

  const abs = resolve(cwd, trimmed);
  const root = resolve(cwd) + sep;

  if (abs !== resolve(cwd) && !abs.startsWith(root)) {

    throw new Error(`path escapes working directory: ${raw}`);

  }

  return normalize(trimmed);

}

function detectEol(text: string): "\n" | "\r\n" {

  const crlf = text.split("\r\n").length - 1;
  const lf = text.replace(/\r\n/g, "").split("\n").length - 1;

  return crlf > lf ? "\r\n" : "\n";

}

function toLf(text: string): string {

  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

}

function fromLf(text: string, eol: "\n" | "\r\n"): string {

  return eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;

}

export function parseEnvelope(text: string): PatchOp[] {

  const lines = toLf(text).split("\n");
  const begin = lines.findIndex((l) => l.trim() === BEGIN);
  const end = lines.findIndex((l) => l.trim() === END);

  if (begin === -1 || end === -1 || end <= begin) {

    throw new Error("patch must contain *** Begin Patch … *** End Patch");

  }

  const slice = lines.slice(begin + 1, end);
  const ops: PatchOp[] = [];
  let i = 0;

  const takeBody = (): string[] => {

    const body: string[] = [];

    while (
      i < slice.length
      && !slice[i].startsWith("*** Update File:")
      && !slice[i].startsWith("*** Add File:")
      && !slice[i].startsWith("*** Delete File:")
    ) {

      body.push(slice[i]);
      i += 1;

    }

    return body;

  };

  while (i < slice.length) {

    const line = slice[i];

    if (!line.trim()) {

      i += 1;
      continue;

    }

    if (line.startsWith(UPDATE)) {

      const path = line.slice(UPDATE.length).trim();
      i += 1;
      ops.push({ kind: "update", path, body: takeBody() });
      continue;

    }

    if (line.startsWith(ADD)) {

      const path = line.slice(ADD.length).trim();
      i += 1;
      ops.push({ kind: "add", path, body: takeBody() });
      continue;

    }

    if (line.startsWith(DEL)) {

      ops.push({ kind: "delete", path: line.slice(DEL.length).trim() });
      i += 1;
      continue;

    }

    throw new Error(`unexpected line in patch: ${line}`);

  }

  if (!ops.length) {

    throw new Error("empty patch (no file operations)");

  }

  return ops;

}

function applyOne(op: PatchOp, cwd: string): FileResult {

  const file = safeRelPath(op.path, cwd);
  const abs = join(cwd, file);

  if (op.kind === "delete") {

    if (!existsSync(abs)) {

      return { file, op: "delete", ok: false, error: "missing file" };

    }

    unlinkSync(abs);

    return { file, op: "delete", ok: true };

  }

  if (op.kind === "add") {

    if (existsSync(abs)) {

      return { file, op: "add", ok: false, error: "file already exists" };

    }

    mkdirSync(dirname(abs), { recursive: true });
    const content = applyDiff("", op.body.join("\n"), "create");
    writeFileSync(abs, content.endsWith("\n") ? content : `${content}\n`, "utf8");

    return { file, op: "add", ok: true };

  }

  if (!existsSync(abs)) {

    return { file, op: "update", ok: false, error: "missing file" };

  }

  const raw = readFileSync(abs, "utf8");
  const eol = detectEol(raw);
  const before = toLf(raw);

  if (!op.body.some((l) => l.startsWith("+") || l.startsWith("-"))) {

    return { file, op: "update", ok: false, error: "no +/- hunks (empty patch)" };

  }

  let after: string;

  try {

    after = applyDiff(before, op.body.join("\n"), "default");

  } catch (err) {

    return { file, op: "update", ok: false, error: err instanceof Error ? err.message : String(err) };

  }

  if (after === before) {

    return { file, op: "update", ok: false, error: "hunks applied but file unchanged (stale or already applied)" };

  }

  writeFileSync(abs, fromLf(after, eol), "utf8");

  return { file, op: "update", ok: true };

}

/** Apply each file independently. Failures do not undo earlier successes. */
export function applyPatch(raw: string, cwd: string): ApplyReport {

  const ops = parseEnvelope(raw);
  const applied: FileResult[] = [];
  const failed: FileResult[] = [];

  for (const op of ops) {

    let result: FileResult;

    try {

      result = applyOne(op, cwd);

    } catch (err) {

      result = {

        file: op.path,
        op: op.kind,
        ok: false,
        error: err instanceof Error ? err.message : String(err),

      };

    }

    (result.ok ? applied : failed).push(result);

  }

  return { ok: failed.length === 0, applied, failed };

}

export function formatApplyReport(report: ApplyReport): string {

  const lines: string[] = [];

  for (const item of report.applied) {

    lines.push(`${item.op} ${item.file}`);

  }

  for (const item of report.failed) {

    lines.push(`FAILED ${item.op} ${item.file}: ${item.error}`);

  }

  lines.push(`${report.applied.length} applied, ${report.failed.length} failed`);

  return lines.join("\n");

}

function main() {

  try {

    const report = applyPatch(readInput(), process.cwd());

    console.log(formatApplyReport(report));

    if (!report.ok) {

      process.exit(1);

    }

  } catch (err) {

    die(`apply_patch: ${err instanceof Error ? err.message : String(err)}`);

  }

}

if (import.meta.main) {

  main();

}
