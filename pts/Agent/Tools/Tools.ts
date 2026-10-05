import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import * as browser from "./Browser";
import { runShell } from "./Shell";
import { parsePairs, type Action, type Result } from "../Protocol";

const MAX_READ = 120_000;
const MAX_GREP_FILE = 400_000;
const MAX_WALK = 8000;

const SKIP = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__"]);

// reading through the shell loses the line numbers the next <edit> leans on
const READERS = /^\s*(grep|rg|cat|head|tail|less|more|ls|tree|find)\b/;

function skip(name: string): boolean {

  return SKIP.has(name) || name.startsWith(".");

}

/** Anything the model hands us, normalised to a workspace-relative path. Escaping the workspace throws. */
export function relPath(raw: string, cwd: string): string {

  let cleaned = raw.trim().replace(/\\/g, "/").replace(/^["'`]|["'`]$/g, "");
  const root = resolve(cwd).replace(/\\/g, "/");

  if (cleaned === root) {

    return ".";

  }

  if (cleaned.startsWith(`${root}/`)) {

    cleaned = cleaned.slice(root.length + 1);

  }

  cleaned = cleaned.replace(/^\.\//, "").replace(/^\/+/, "") || ".";

  const rel = relative(resolve(cwd), resolve(cwd, cleaned));

  if (rel.startsWith("..")) {

    throw new Error(`${raw} is outside your workspace`);

  }

  return rel ? rel.split(sep).join("/") : ".";

}

function abs(cwd: string, rel: string): string {

  return rel === "." ? cwd : join(cwd, rel);

}

function isBinary(text: string): boolean {

  return text.slice(0, 4000).includes("\0");

}

/** A trailing newline is a terminator, not an extra line — counting it makes every number look wrong. */
function splitLines(text: string): string[] {

  const lines = text.split("\n");

  if (lines.length > 1 && lines[lines.length - 1] === "") {

    lines.pop();

  }

  return lines;

}

function readText(path: string): string {

  return readFileSync(path, "utf8").replace(/\r\n?/g, "\n");

}

function children(path: string): { name: string; dir: boolean }[] {

  const out: { name: string; dir: boolean }[] = [];

  for (const name of readdirSync(path)) {

    if (skip(name)) {

      continue;

    }

    try {

      out.push({ name, dir: statSync(join(path, name)).isDirectory() });

    } catch {

      // a dangling symlink; not worth failing the listing
    }

  }

  return out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));

}

function walkFiles(cwd: string, rel: string, out: string[]) {

  for (const child of children(abs(cwd, rel))) {

    if (out.length >= MAX_WALK) {

      return;

    }

    const path = rel === "." ? child.name : `${rel}/${child.name}`;

    if (child.dir) {

      walkFiles(cwd, path, out);
      continue;

    }

    out.push(path);

  }

}

export function listDir(cwd: string, target: string): string {

  const rel = relPath(target || ".", cwd);
  const path = abs(cwd, rel);

  if (!existsSync(path)) {

    throw new Error(`${rel} does not exist`);

  }

  if (!statSync(path).isDirectory()) {

    return readFiles(cwd, [{ path: rel }]);

  }

  const lines = [rel === "." ? "." : `${rel}/`];

  for (const kid of children(path)) {

    const child = rel === "." ? kid.name : `${rel}/${kid.name}`;

    if (kid.dir) {

      const files: string[] = [];

      walkFiles(cwd, child, files);
      lines.push(`  ${kid.name}/  ${files.length} files`);
      continue;

    }

    try {

      const text = readText(join(cwd, child));

      lines.push(isBinary(text) ? `  ${kid.name}  binary` : `  ${kid.name}  ${splitLines(text).length} lines`);

    } catch {

      lines.push(`  ${kid.name}`);

    }

  }

  return lines.length > 1 ? lines.join("\n") : `${lines[0]}  empty`;

}

export interface ReadSpec {

  path: string;
  start?: number;
  end?: number;

}

/** `notes.md 40-120`, `notes.md:40-120`, `notes.md:40` all mean the same thing. */
export function parseReadSpec(line: string): ReadSpec {

  const raw = line.trim().replace(/^["'`]|["'`]$/g, "");
  const range = /^(.*?)[\s:]+(\d+)\s*(?:[-–:]\s*(\d+))?$/.exec(raw);

  if (!range) {

    return { path: raw };

  }

  const start = Number(range[2]);

  if (range[3]) {

    return { path: range[1].trim(), start, end: Number(range[3]) };

  }

  // a bare line number is usually a grep hit pasted back; show its neighbourhood
  return { path: range[1].trim(), start: Math.max(1, start - 25), end: start + 55 };

}

function numbered(lines: string[], start: number): string {

  const width = String(start + lines.length - 1).length;

  return lines.map((line, i) => `${String(start + i).padStart(width)}  ${line}`).join("\n");

}

export function readFiles(cwd: string, specs: ReadSpec[]): string {

  if (!specs.length) {

    throw new Error("read needs at least one path");

  }

  const chunks: string[] = [];
  const budget = Math.floor(MAX_READ / specs.length);

  for (const spec of specs) {

    const rel = relPath(spec.path, cwd);
    const path = abs(cwd, rel);

    if (!existsSync(path)) {

      chunks.push(`${rel}  no such file`);
      continue;

    }

    if (statSync(path).isDirectory()) {

      chunks.push(listDir(cwd, rel));
      continue;

    }

    const text = readText(path);

    if (isBinary(text)) {

      chunks.push(`${rel}  binary file`);
      continue;

    }

    if (!text.trim()) {

      chunks.push(`${rel}  empty file`);
      continue;

    }

    const all = splitLines(text);
    const start = Math.max(1, Math.min(spec.start ?? 1, all.length));
    const end = Math.min(all.length, spec.end ?? all.length);

    let body = numbered(all.slice(start - 1, end), start);
    let shown = end;

    if (body.length > budget) {

      const kept = body.slice(0, budget).split("\n");

      kept.pop();
      shown = start + kept.length - 1;
      body = kept.join("\n");

    }

    const header = start === 1 && shown === all.length ? `${rel}  ${all.length} lines` : `${rel}  lines ${start}-${shown} of ${all.length}`;
    const more = shown < end ? `\n\n... read ${rel} ${shown + 1}-${end} for the rest` : "";

    chunks.push(`${header}\n\n${body}${more}`);

  }

  return chunks.join("\n\n");

}

/** `/pattern/` is a regex, anything else is literal. Several patterns match as alternatives. */
function toMatcher(patterns: string[]): RegExp {

  const sources = patterns.map((pattern) => {

    const re = /^\/(.+)\/[gimsu]*$/.exec(pattern);

    return re ? re[1] : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  });

  return new RegExp(sources.join("|"));

}

/** Grouped by file so paths never blur into line numbers the way `path:12:` does. */
export function grep(cwd: string, patterns: string[], where: string): string {

  if (!patterns.length) {

    throw new Error("grep needs a pattern");

  }

  const root = relPath(where || ".", cwd);

  if (!existsSync(abs(cwd, root))) {

    throw new Error(`${root} does not exist`);

  }

  const matcher = toMatcher(patterns);
  const perFile = 6;
  const max = 120;

  const files: string[] = [];

  if (statSync(abs(cwd, root)).isDirectory()) {

    walkFiles(cwd, root, files);

  } else {

    files.push(root);

  }

  const groups: string[] = [];

  let hits = 0;
  let shown = 0;

  for (const file of files) {

    if (shown >= max) {

      break;

    }

    let text: string;

    try {

      text = readText(join(cwd, file));

    } catch {

      continue;

    }

    if (isBinary(text) || text.length > MAX_GREP_FILE) {

      continue;

    }

    const found: string[] = [];
    const lines = text.split("\n");

    let inFile = 0;

    for (let i = 0; i < lines.length; i += 1) {

      if (!matcher.test(lines[i])) {

        continue;

      }

      inFile += 1;

      if (found.length < perFile) {

        found.push(`  ${String(i + 1).padStart(5)}  ${lines[i].trim().slice(0, 200)}`);

      }

    }

    if (!inFile) {

      continue;

    }

    hits += inFile;
    shown += found.length;

    groups.push(`${file}${inFile > found.length ? `  (${inFile} matches, first ${found.length})` : ""}\n${found.join("\n")}`);

  }

  if (!groups.length) {

    return `no matches for ${patterns.join(" or ")}${root === "." ? "" : ` in ${root}`}`;

  }

  return `${hits} ${hits === 1 ? "match" : "matches"} in ${groups.length} ${groups.length === 1 ? "file" : "files"}\n\n${groups.join("\n\n")}`;

}

export function writeFile(cwd: string, target: string, content: string): string {

  const rel = relPath(target, cwd);

  if (rel === ".") {

    throw new Error("write needs a file path: <write notes.md>");

  }

  const path = abs(cwd, rel);
  const existed = existsSync(path);
  const body = content.endsWith("\n") ? content : `${content}\n`;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");

  return `${existed ? "replaced" : "created"} ${rel}  ${splitLines(body).length} lines`;

}

export function deleteFiles(cwd: string, targets: string[]): string {

  if (!targets.length) {

    throw new Error("delete needs a path");

  }

  const out: string[] = [];

  for (const target of targets) {

    const rel = relPath(target, cwd);

    if (rel === "." || rel === "MEMORY.md") {

      throw new Error(`refusing to delete ${rel === "." ? "your workspace" : "MEMORY.md"}`);

    }

    const path = abs(cwd, rel);

    if (!existsSync(path)) {

      out.push(`${rel}  already gone`);
      continue;

    }

    rmSync(path, { recursive: true, force: true });
    out.push(`deleted ${rel}`);

  }

  return out.join("\n");

}

/** A read is numbered, so a copied FIND often is too. Strip the gutter when every line has one. */
function stripGutter(text: string): string {

  const lines = text.split("\n");
  const gutter = /^\s*\d+\s{2}/;

  if (lines.length < 2 || !lines.every((line) => !line.trim() || gutter.test(line))) {

    return text;

  }

  return lines.map((line) => line.replace(gutter, "")).join("\n");

}

type Compare = (a: string, b: string) => boolean;

const LOOSE: [Compare, string][] = [

  [(a, b) => a.trimEnd() === b.trimEnd(), "ignoring trailing space"],
  [(a, b) => a.trim() === b.trim(), "ignoring indentation"],

];

function lineMatches(lines: string[], needle: string[], same: Compare): number[] {

  const hits: number[] = [];

  for (let i = 0; i + needle.length <= lines.length; i += 1) {

    if (needle.every((line, j) => same(lines[i + j], line))) {

      hits.push(i);

    }

  }

  return hits;

}

function indentOf(line: string): string {

  return /^[ \t]*/.exec(line)?.[0] ?? "";

}

/** Re-indent the replacement by however far the real file sits from what the model typed. */
function reindent(replace: string[], from: string, to: string): string[] {

  if (from === to) {

    return replace;

  }

  return replace.map((line) => {

    if (!line.trim()) {

      return line;

    }

    return line.startsWith(from) ? to + line.slice(from.length) : to + line.trimStart();

  });

}

function occurrences(text: string, needle: string): number[] {

  const at: number[] = [];

  let i = text.indexOf(needle);

  while (i !== -1) {

    at.push(i);
    i = text.indexOf(needle, i + needle.length);

  }

  return at;

}

function lineOf(text: string, offset: number): number {

  return text.slice(0, offset).split("\n").length;

}

/** Exact line = 2, near-miss (stale value, renamed word) = 1. */
function similarity(a: string, b: string): number {

  const x = a.trim();
  const y = b.trim();

  if (!x || !y) {

    return 0;

  }

  if (x === y) {

    return 2;

  }

  let shared = 0;

  while (shared < x.length && shared < y.length && x[shared] === y[shared]) {

    shared += 1;

  }

  return shared / Math.max(x.length, y.length) >= 0.5 ? 1 : 0;

}

/** The window that looks most like FIND, so a stale edit is fixed in one turn instead of three. */
function nearest(lines: string[], needle: string[]): string {

  let best = -1;
  let bestScore = 0;

  for (let i = 0; i < lines.length; i += 1) {

    let score = 0;

    for (let j = 0; j < needle.length && i + j < lines.length; j += 1) {

      score += similarity(lines[i + j], needle[j]);

    }

    if (score > bestScore) {

      bestScore = score;
      best = i;

    }

  }

  if (best === -1) {

    return "\n\nRead the file again — it does not look the way you expected.";

  }

  const from = Math.max(0, best - 2);
  const to = Math.min(lines.length, best + needle.length + 2);

  return `\n\nClosest match in the file:\n\n${numbered(lines.slice(from, to), from + 1)}`;

}

/** Three lines either side of the change, so the model can see it landed without another read. */
function preview(text: string, line: number): string {

  const lines = text.split("\n");
  const from = Math.max(0, line - 4);

  return numbered(lines.slice(from, Math.min(lines.length, line + 4)), from + 1);

}

/** All pairs or nothing: a failure leaves the file untouched, and says so, so the model never edits around half an edit. */
export function applyEdit(cwd: string, target: string, body: string): Result {

  const fail = (text: string): Result => ({ verb: "edit", ok: false, text });
  const rel = relPath(target, cwd);
  const path = abs(cwd, rel);

  if (!existsSync(path)) {

    return fail(`${rel} does not exist. Use <write ${rel}> to create it.`);

  }

  const pairs = parsePairs(body);

  if (!pairs.length) {

    return fail("No @@ FIND / @@ REPLACE pair in that block.\n\n  <edit notes.md>\n  @@ FIND\n  old text\n  @@ REPLACE\n  new text\n  </edit>");

  }

  const raw = readFileSync(path, "utf8");
  const crlf = raw.includes("\r\n");
  const original = raw.replace(/\r\n/g, "\n");
  const rolledBack = (text: string) => fail(`${text}\n\n${pairs.length > 1 ? "No pairs were applied" : "Nothing was applied"} — ${rel} is unchanged. Fix it and send the whole block again.`);

  let text = original;

  const notes: string[] = [];
  const previews: string[] = [];

  for (const [index, pair] of pairs.entries()) {

    const find = stripGutter(pair.find);
    const label = pairs.length > 1 ? `pair ${index + 1} of ${pairs.length}: ` : "";

    if (!find.trim()) {

      return rolledBack(`${label}FIND is empty. Copy the exact lines you want to change.`);

    }

    const exact = occurrences(text, find);

    if (exact.length > 1) {

      return rolledBack(`${label}FIND matches ${exact.length} places in ${rel} (lines ${exact.map((at) => lineOf(text, at)).slice(0, 6).join(", ")}). Include more surrounding lines so it is unique.`);

    }

    if (exact.length === 1) {

      text = text.slice(0, exact[0]) + pair.replace + text.slice(exact[0] + find.length);
      previews.push(preview(text, lineOf(text, exact[0])));
      continue;

    }

    const lines = text.split("\n");
    const needle = find.split("\n");

    let applied = false;

    for (const [same, how] of LOOSE) {

      const hits = lineMatches(lines, needle, same);

      if (!hits.length) {

        continue;

      }

      if (hits.length > 1) {

        return rolledBack(`${label}FIND matches ${hits.length} places in ${rel} (lines ${hits.slice(0, 6).map((i) => i + 1).join(", ")}). Include more surrounding lines so it is unique.`);

      }

      lines.splice(hits[0], needle.length, ...reindent(pair.replace.split("\n"), indentOf(needle[0]), indentOf(lines[hits[0]])));
      text = lines.join("\n");

      notes.push(`${label}matched ${how}`);
      previews.push(preview(text, hits[0] + 1));

      applied = true;
      break;

    }

    if (applied) {

      continue;

    }

    if (pair.replace.trim() && text.includes(pair.replace)) {

      notes.push(`${label}already applied, left alone`);
      continue;

    }

    // numbered against the file on disk, since nothing earlier in this block was written
    return rolledBack(`${label}FIND is not in ${rel}.${nearest(original.split("\n"), needle)}`);

  }

  writeFileSync(path, crlf ? text.replace(/\n/g, "\r\n") : text, "utf8");

  return { verb: "edit", ok: true, text: [`edited ${rel}${notes.length ? `  (${notes.join("; ")})` : ""}`, ...previews].join("\n\n") };

}

function bodyLines(body: string): string[] {

  return body.split("\n").map((line) => line.trim()).filter(Boolean);

}

/** Every verb except say and done, which belong to the loop. Throws become failed results. */
export async function execute(action: Action, cwd: string, signal?: AbortSignal, zone?: string): Promise<Result> {

  const ok = (text: string): Result => ({ verb: action.verb, ok: true, text });

  try {

    switch (action.verb) {

      case "ls":

        return ok(listDir(cwd, action.path || bodyLines(action.body)[0] || "."));

      case "read":

        return ok(readFiles(cwd, (bodyLines(action.body).length ? bodyLines(action.body) : [action.path]).filter(Boolean).map(parseReadSpec)));

      case "grep":

        return ok(grep(cwd, bodyLines(action.body), action.path));

      case "write":

        return ok(writeFile(cwd, action.path, action.body));

      case "delete":

        return ok(deleteFiles(cwd, action.path ? [action.path] : bodyLines(action.body)));

      case "edit":

        return applyEdit(cwd, action.path, action.body);

      case "run": {

        const command = action.body.trim();

        if (!command) {

          throw new Error("run needs a command");

        }

        if (READERS.test(command)) {

          throw new Error("Use <ls>, <read> or <grep> to look at files — they give line numbers. <run> is for everything else.");

        }

        const { output, exitCode } = await runShell(command, cwd, signal, undefined, zone);

        return { verb: "run", ok: exitCode === 0, text: `exit ${exitCode}\n\n${output || "(no output)"}` };

      }

      case "open":

        return ok(await browser.open(cwd, action.path || bodyLines(action.body)[0] || "", signal));

      case "look":

        return ok(await browser.look(cwd, signal));

      case "click":

        return ok(await browser.click(cwd, action.path || bodyLines(action.body)[0] || "", signal));

      case "type":

        return ok(await browser.type(cwd, action.path, action.body, signal));

      case "press":

        return ok(await browser.press(cwd, action.path || bodyLines(action.body)[0] || "", signal));

      case "tab":

        return ok(await browser.tab(cwd, action.path || bodyLines(action.body)[0] || "", signal));

      default:

        throw new Error(`${action.verb} is handled by the loop`);

    }

  } catch (err) {

    return { verb: action.verb, ok: false, text: err instanceof Error ? err.message : String(err) };

  }

}
