#!/usr/bin/env bun
/**
 * apply_patch — multi-file editor using the open Codex / Agents "apply_patch" format.
 *
 * Patch body (OpenAI Agents SDK applyDiff + multi-file envelope):
 *
 *   *** Begin Patch
 *   *** Update File: relative/path.ts
 *   @@
 *    context
 *   -old line
 *   +new line
 *   *** Add File: relative/new.ts
 *   +line one
 *   +line two
 *   *** Delete File: relative/gone.ts
 *   *** End Patch
 *
 * Usage:
 *   apply_patch <<'PATCH'
 *   *** Begin Patch
 *   ...
 *   *** End Patch
 *   PATCH
 *
 *   apply_patch path/to.patch
 *   cat patch | apply_patch -
 *
 * Exits 0 on success; non-zero with a clear stderr message on mismatch.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";

import { applyDiff } from "./apply_diff";

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const UPDATE = "*** Update File:";
const ADD = "*** Add File:";
const DEL = "*** Delete File:";

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

  // stdin
  const chunks: Buffer[] = [];
  const fd = 0;

  try {

    // Bun / node: read sync from stdin if piped
    if (process.stdin.isTTY) {

      die("apply_patch: pass a patch file or pipe a patch on stdin\nusage: apply_patch [file|-]  (patch on stdin or file)");

    }

  } catch {

    // ignore
  }

  const data = readFileSync(fd);

  return data.toString("utf8");

}

/** Reject absolute paths and path traversal. */
function safeRelPath(raw: string, cwd: string): string {

  const trimmed = raw.trim().replace(/\\/g, "/");

  if (!trimmed || trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) {

    die(`apply_patch: path must be relative: ${raw}`);

  }

  if (trimmed.split("/").includes("..")) {

    die(`apply_patch: path must not contain ..: ${raw}`);

  }

  const abs = resolve(cwd, trimmed);
  const root = resolve(cwd) + sep;

  if (abs !== resolve(cwd) && !abs.startsWith(root)) {

    die(`apply_patch: path escapes working directory: ${raw}`);

  }

  return normalize(trimmed);

}

type Op =
  | { kind: "update"; path: string; body: string[] }
  | { kind: "add"; path: string; body: string[] }
  | { kind: "delete"; path: string };

function parseEnvelope(text: string): Op[] {

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const begin = lines.findIndex((l) => l.trim() === BEGIN);
  const end = lines.findIndex((l) => l.trim() === END);

  if (begin === -1 || end === -1 || end <= begin) {

    die("apply_patch: patch must contain *** Begin Patch … *** End Patch");

  }

  const slice = lines.slice(begin + 1, end);
  const ops: Op[] = [];
  let i = 0;

  while (i < slice.length) {

    const line = slice[i];

    if (!line.trim()) {

      i += 1;
      continue;

    }

    if (line.startsWith(UPDATE)) {

      const path = line.slice(UPDATE.length).trim();
      i += 1;
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

      ops.push({ kind: "update", path, body });
      continue;

    }

    if (line.startsWith(ADD)) {

      const path = line.slice(ADD.length).trim();
      i += 1;
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

      ops.push({ kind: "add", path, body });
      continue;

    }

    if (line.startsWith(DEL)) {

      ops.push({ kind: "delete", path: line.slice(DEL.length).trim() });
      i += 1;
      continue;

    }

    die(`apply_patch: unexpected line in patch: ${line}`);

  }

  if (!ops.length) {

    die("apply_patch: empty patch (no file operations)");

  }

  return ops;

}

function main() {

  const cwd = process.cwd();
  const raw = readInput();
  const ops = parseEnvelope(raw);
  const results: string[] = [];

  for (const op of ops) {

    const rel = safeRelPath(op.path, cwd);
    const abs = join(cwd, rel);

    if (op.kind === "delete") {

      if (!existsSync(abs)) {

        die(`apply_patch: delete failed, missing file: ${rel}`);

      }

      unlinkSync(abs);
      results.push(`deleted ${rel}`);
      continue;

    }

    if (op.kind === "add") {

      if (existsSync(abs)) {

        die(`apply_patch: add failed, file exists: ${rel}`);

      }

      mkdirSync(dirname(abs), { recursive: true });
      const content = applyDiff("", op.body.join("\n"), "create");
      writeFileSync(abs, content.endsWith("\n") ? content : `${content}\n`, "utf8");
      results.push(`added ${rel}`);
      continue;

    }

    // update
    if (!existsSync(abs)) {

      die(`apply_patch: update failed, missing file: ${rel}`);

    }

    const before = readFileSync(abs, "utf8");
    const hasEdits = op.body.some((l) => l.startsWith("+") || l.startsWith("-"));

    if (!hasEdits) {

      die(
        `apply_patch: Update File ${rel} has no + or - lines (malformed empty patch — not a context mismatch). Include real -old and +new hunks.`,
      );

    }

    let after: string;

    try {

      after = applyDiff(before, op.body.join("\n"), "default");

    } catch (err) {

      die(`apply_patch: failed to update ${rel}: ${err instanceof Error ? err.message : String(err)}`);

    }

    if (after === before) {

      die(
        `apply_patch: no changes produced for ${rel} (hunks applied but file identical — already applied, or +/- lines matched existing content)`,
      );

    }

    writeFileSync(abs, after, "utf8");
    results.push(`updated ${rel}`);

  }

  console.log(results.join("\n"));

}

main();
