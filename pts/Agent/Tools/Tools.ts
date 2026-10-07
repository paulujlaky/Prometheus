import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import * as browser from "./Browser";
import { inLane, readRegular, runShell, writeRegular } from "./Shell";
import { parsePairs, type Action, type Result } from "../Protocol";

const MAX_READ = 120_000;
const MAX_GREP_FILE = 400_000;
const MAX_WALK = 8000;
const GREP_PER_FILE = 6;
const GREP_MAX = 120;

const SKIP = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__"]);

// reading through the shell loses the line numbers the next <edit> leans on
const READERS = /^\s*(grep|rg|cat|head|tail|less|more|ls|tree|find)\b/;

type Compare = (a: string, b: string) => boolean;

const LOOSE: [Compare, string][] = [

  [(a, b) => a.trimEnd() === b.trimEnd(), "ignoring trailing space"],
  [(a, b) => a.trim() === b.trim(), "ignoring indentation"],

];

const abs = (cwd: string, rel: string) => rel === "." ? cwd : join(cwd, rel);
const isBinary = (text: string) => text.slice(0, 4000).includes("\0");
const readText = (path: string) => readRegular(path).replace(/\r\n?/g, "\n");
const indentOf = (line: string) => /^[ \t]*/.exec(line)![0];
const lineOf = (text: string, offset: number) => text.slice(0, offset).split("\n").length;
const bodyLines = (body: string) => body.split("\n").map((line) => line.trim()).filter(Boolean);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A trailing newline is a terminator, not an extra line — counting it makes every number look wrong. */
const splitLines = (text: string) => (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");

/** Anything the model hands us, normalised to a workspace-relative path. Escaping the workspace throws. */
export function relPath(raw: string, cwd: string): string {

  const root = resolve(cwd).replace(/\\/g, "/");

  let cleaned = raw.trim().replace(/\\/g, "/").replace(/^["'`]|["'`]$/g, "");

  if (cleaned === root) {

    return ".";

  }

  if (cleaned.startsWith(`${root}/`)) {

    cleaned = cleaned.slice(root.length + 1);

  }

  const rel = relative(resolve(cwd), resolve(cwd, cleaned.replace(/^\.\//, "").replace(/^\/+/, "") || "."));

  if (rel.startsWith("..")) {

    throw new Error(`${raw} is outside your workspace`);

  }

  return rel ? rel.split(sep).join("/") : ".";

}

/** `rel` as an absolute path, once its real location is checked: the agent's shell can point a link anywhere on the host. */
function inside(cwd: string, rel: string): string {

  const root = realpathSync(cwd);
  const path = abs(cwd, rel);

  let head = path;
  let real = "";

  // what does not exist yet cannot be a link; the deepest part that does decides where the path really goes
  while (!lstatSync(head, { throwIfNoEntry: false })) {

    head = dirname(head);

  }

  // a dangling link is refused like one that leads out
  try {

    real = realpathSync(head);

  } catch {}

  if (real !== root && !real.startsWith(root + sep)) {

    throw new Error(`${rel} leads outside your workspace`);

  }

  return path;

}

/** Links are listed but never followed: one may point anywhere on the host. */
function children(path: string): { name: string; dir: boolean; link: boolean }[] {

  return readdirSync(path)
    .filter((name) => !SKIP.has(name) && !name.startsWith("."))
    .flatMap((name) => {

      const stat = lstatSync(join(path, name), { throwIfNoEntry: false });

      return stat ? [{ name, dir: stat.isDirectory(), link: stat.isSymbolicLink() }] : [];

    })
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));

}

function walkFiles(cwd: string, rel: string, out: string[]) {

  for (const child of children(abs(cwd, rel))) {

    const path = rel === "." ? child.name : `${rel}/${child.name}`;

    if (out.length >= MAX_WALK) {

      return;

    }

    if (child.dir && !child.link) {

      walkFiles(cwd, path, out);

    } else if (!child.link) {

      out.push(path);

    }

  }

}

export function listDir(cwd: string, target: string): string {

  const rel = relPath(target || ".", cwd);
  const path = inside(cwd, rel);

  if (!existsSync(path)) {

    throw new Error(`${rel} does not exist`);

  }

  if (!statSync(path).isDirectory()) {

    return readFiles(cwd, [{ path: rel }]);

  }

  const lines = children(path).map((kid) => {

    const child = rel === "." ? kid.name : `${rel}/${kid.name}`;

    if (kid.link) {

      return `  ${kid.name}  link`;

    }

    if (kid.dir) {

      const files: string[] = [];

      walkFiles(cwd, child, files);

      return `  ${kid.name}/  ${files.length} files`;

    }

    try {

      const text = readText(join(cwd, child));

      return `  ${kid.name}  ${isBinary(text) ? "binary" : `${splitLines(text).length} lines`}`;

    } catch {

      return `  ${kid.name}`;

    }

  });

  const head = rel === "." ? "." : `${rel}/`;

  return lines.length ? [head, ...lines].join("\n") : `${head}  empty`;

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

  // a bare line number is usually a grep hit pasted back; show its neighbourhood
  return range[3] ? { path: range[1].trim(), start, end: Number(range[3]) } : { path: range[1].trim(), start: Math.max(1, start - 25), end: start + 55 };

}

function numbered(lines: string[], start: number): string {

  const width = String(start + lines.length - 1).length;

  return lines.map((line, i) => `${String(start + i).padStart(width)}  ${line}`).join("\n");

}

function readOne(cwd: string, spec: ReadSpec, budget: number): string {

  const rel = relPath(spec.path, cwd);
  const path = inside(cwd, rel);

  if (!existsSync(path)) {

    return `${rel}  no such file`;

  }

  if (statSync(path).isDirectory()) {

    return listDir(cwd, rel);

  }

  const text = readText(path);

  if (isBinary(text) || !text.trim()) {

    return `${rel}  ${isBinary(text) ? "binary" : "empty"} file`;

  }

  const all = splitLines(text);
  const start = Math.max(1, Math.min(spec.start ?? 1, all.length));
  const end = Math.min(all.length, spec.end ?? all.length);

  let body = numbered(all.slice(start - 1, end), start);
  let shown = end;

  if (body.length > budget) {

    const kept = body.slice(0, budget).split("\n").slice(0, -1);

    shown = start + kept.length - 1;
    body = kept.join("\n");

  }

  const header = start === 1 && shown === all.length ? `${rel}  ${all.length} lines` : `${rel}  lines ${start}-${shown} of ${all.length}`;
  const more = shown < end ? `\n\n... read ${rel} ${shown + 1}-${end} for the rest` : "";

  return `${header}\n\n${body}${more}`;

}

export function readFiles(cwd: string, specs: ReadSpec[]): string {

  if (!specs.length) {

    throw new Error("read needs at least one path");

  }

  return specs.map((spec) => readOne(cwd, spec, Math.floor(MAX_READ / specs.length))).join("\n\n");

}

/** `/pattern/` is a regex, anything else is literal. Several patterns match as alternatives. */
const toMatcher = (patterns: string[]) => new RegExp(patterns.map((pattern) => /^\/(.+)\/[gimsu]*$/.exec(pattern)?.[1] ?? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"));

/** Grouped by file so paths never blur into line numbers the way `path:12:` does. */
export function grep(cwd: string, patterns: string[], where: string): string {

  if (!patterns.length) {

    throw new Error("grep needs a pattern");

  }

  const root = relPath(where || ".", cwd);

  if (!existsSync(inside(cwd, root))) {

    throw new Error(`${root} does not exist`);

  }

  const matcher = toMatcher(patterns);
  const files: string[] = [];
  const groups: string[] = [];

  let hits = 0;
  let shown = 0;

  if (statSync(abs(cwd, root)).isDirectory()) {

    walkFiles(cwd, root, files);

  } else {

    files.push(root);

  }

  for (const file of files) {

    if (shown >= GREP_MAX) {

      break;

    }

    let text = "";

    try {

      text = readText(join(cwd, file));

    } catch {}

    if (isBinary(text) || text.length > MAX_GREP_FILE) {

      continue;

    }

    const found = text.split("\n").flatMap((line, i) => matcher.test(line) ? [`  ${String(i + 1).padStart(5)}  ${line.trim().slice(0, 200)}`] : []);

    if (found.length) {

      hits += found.length;
      shown += Math.min(found.length, GREP_PER_FILE);
      groups.push(`${file}${found.length > GREP_PER_FILE ? `  (${found.length} matches, first ${GREP_PER_FILE})` : ""}\n${found.slice(0, GREP_PER_FILE).join("\n")}`);

    }

  }

  if (!groups.length) {

    return `no matches for ${patterns.join(" or ")}${root === "." ? "" : ` in ${root}`}`;

  }

  return `${plural(hits, "match", "matches")} in ${plural(groups.length, "file", "files")}\n\n${groups.join("\n\n")}`;

}

export function writeFile(cwd: string, target: string, content: string): string {

  const rel = relPath(target, cwd);

  if (rel === ".") {

    throw new Error("write needs a file path: <write notes.md>");

  }

  const path = inside(cwd, rel);
  const existed = existsSync(path);
  const body = content.endsWith("\n") ? content : `${content}\n`;

  mkdirSync(dirname(path), { recursive: true });
  writeRegular(path, body);

  return `${existed ? "replaced" : "created"} ${rel}  ${splitLines(body).length} lines`;

}

export function deleteFiles(cwd: string, targets: string[]): string {

  if (!targets.length) {

    throw new Error("delete needs a path");

  }

  return targets.map((target) => {

    const rel = relPath(target, cwd);

    if (rel === "." || rel === "MEMORY.md") {

      throw new Error(`refusing to delete ${rel === "." ? "your workspace" : "MEMORY.md"}`);

    }

    // only the folder it sits in has to be inside: removing a link removes the link, not what it points at
    inside(cwd, dirname(rel));

    if (!lstatSync(abs(cwd, rel), { throwIfNoEntry: false })) {

      return `${rel}  already gone`;

    }

    rmSync(abs(cwd, rel), { recursive: true, force: true });

    return `deleted ${rel}`;

  }).join("\n");

}

/** A read is numbered, so a copied FIND often is too. Strip the gutter when every line has one. */
function stripGutter(text: string): string {

  const lines = text.split("\n");
  const gutter = /^\s*\d+\s{2}/;

  return lines.length < 2 || !lines.every((line) => !line.trim() || gutter.test(line)) ? text : lines.map((line) => line.replace(gutter, "")).join("\n");

}

function lineMatches(lines: string[], needle: string[], same: Compare): number[] {

  const hits: number[] = [];

  for (let i = 0; i + needle.length <= lines.length; i += 1) {

    if (needle.every((line, j) => same(lines[i + j], line))) {

      hits.push(i);

    }

  }

  return hits;

}

/** Re-indent the replacement by however far the real file sits from what the model typed. */
const reindent = (replace: string[], from: string, to: string) => from === to ? replace : replace.map((line) => !line.trim() ? line : line.startsWith(from) ? to + line.slice(from.length) : to + line.trimStart());

function occurrences(text: string, needle: string): number[] {

  const at: number[] = [];

  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) {

    at.push(i);

  }

  return at;

}

/** Exact line = 2, near-miss (stale value, renamed word) = 1. */
function similarity(a: string, b: string): number {

  const x = a.trim();
  const y = b.trim();

  if (!x || !y || x === y) {

    return x && x === y ? 2 : 0;

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

    const score = needle.reduce((sum, line, j) => sum + (i + j < lines.length ? similarity(lines[i + j], line) : 0), 0);

    if (score > bestScore) {

      bestScore = score;
      best = i;

    }

  }

  if (best === -1) {

    return "\n\nRead the file again — it does not look the way you expected.";

  }

  const from = Math.max(0, best - 2);

  return `\n\nClosest match in the file:\n\n${numbered(lines.slice(from, best + needle.length + 2), from + 1)}`;

}

/** Three lines either side of the change, so the model can see it landed without another read. */
function preview(text: string, line: number): string {

  const from = Math.max(0, line - 4);

  return numbered(text.split("\n").slice(from, line + 4), from + 1);

}

/** All pairs or nothing: a failure leaves the file untouched, and says so, so the model never edits around half an edit. */
export function applyEdit(cwd: string, target: string, body: string): Result {

  const fail = (text: string): Result => ({ verb: "edit", ok: false, text });
  const rel = relPath(target, cwd);
  const path = inside(cwd, rel);

  if (!existsSync(path)) {

    return fail(`${rel} does not exist. Use <write ${rel}> to create it.`);

  }

  const pairs = parsePairs(body);

  if (!pairs.length) {

    return fail("No @@ FIND / @@ REPLACE pair in that block. To add text, FIND the line it goes after and REPLACE it with that line plus the new text.\n\n  <edit notes.md>\n  @@ FIND\n  old text\n  @@ REPLACE\n  new text\n  </edit>");

  }

  const raw = readRegular(path);
  const original = raw.replace(/\r\n/g, "\n");
  const rolledBack = (text: string) => fail(`${text}\n\n${pairs.length > 1 ? "No pairs were applied" : "Nothing was applied"} — ${rel} is unchanged. Fix it and send the whole block again.`);
  const ambiguous = (label: string, lines: number[]) => rolledBack(`${label}FIND matches ${lines.length} places in ${rel} (lines ${lines.slice(0, 6).join(", ")}). Include more surrounding lines so it is unique.`);

  let text = original;

  const notes: string[] = [];
  const previews: string[] = [];

  pairs: for (const [index, pair] of pairs.entries()) {

    const find = stripGutter(pair.find);
    const label = pairs.length > 1 ? `pair ${index + 1} of ${pairs.length}: ` : "";

    if (!find.trim()) {

      return rolledBack(`${label}FIND is empty. Copy the exact lines you want to change.`);

    }

    const exact = occurrences(text, find);

    if (exact.length > 1) {

      return ambiguous(label, exact.map((at) => lineOf(text, at)));

    }

    if (exact.length === 1) {

      text = text.slice(0, exact[0]) + pair.replace + text.slice(exact[0] + find.length);
      previews.push(preview(text, lineOf(text, exact[0])));
      continue;

    }

    const lines = text.split("\n");
    const needle = find.split("\n");

    for (const [same, how] of LOOSE) {

      const hits = lineMatches(lines, needle, same);

      if (hits.length > 1) {

        return ambiguous(label, hits.map((i) => i + 1));

      }

      if (hits.length === 1) {

        lines.splice(hits[0], needle.length, ...reindent(pair.replace.split("\n"), indentOf(needle[0]), indentOf(lines[hits[0]])));
        text = lines.join("\n");
        notes.push(`${label}matched ${how}`);
        previews.push(preview(text, hits[0] + 1));

        continue pairs;

      }

    }

    if (pair.replace.trim() && text.includes(pair.replace)) {

      notes.push(`${label}already applied, left alone`);
      continue;

    }

    // numbered against the file on disk, since nothing earlier in this block was written
    return rolledBack(`${label}FIND is not in ${rel}.${nearest(original.split("\n"), needle)}`);

  }

  writeRegular(path, raw.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text);

  return { verb: "edit", ok: true, text: [`edited ${rel}${notes.length ? `  (${notes.join("; ")})` : ""}`, ...previews].join("\n\n") };

}

/** Every verb except say and done, which belong to the loop. Throws become failed results. */
export async function execute(action: Action, cwd: string, signal?: AbortSignal, zone?: string): Promise<Result> {

  const ok = (text: string): Result => ({ verb: action.verb, ok: true, text });
  const target = action.path || bodyLines(action.body)[0] || "";

  // in the workspace's lane, so no command of the agent's can move a path between the check and the use
  const files = (work: () => string) => inLane(cwd, work).then(ok);

  try {

    switch (action.verb) {

      case "ls":

        return await files(() => listDir(cwd, target || "."));

      case "read":

        return await files(() => readFiles(cwd, (bodyLines(action.body).length ? bodyLines(action.body) : [action.path]).filter(Boolean).map(parseReadSpec)));

      case "grep":

        return await files(() => grep(cwd, bodyLines(action.body), action.path));

      case "write":

        return await files(() => writeFile(cwd, action.path, action.body));

      case "delete":

        return await files(() => deleteFiles(cwd, action.path ? [action.path] : bodyLines(action.body)));

      case "edit":

        return await inLane(cwd, () => applyEdit(cwd, action.path, action.body));

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

        return ok(await browser.open(cwd, target, signal));

      case "look":

        return ok(await browser.look(cwd, signal));

      case "click":

        return ok(await browser.click(cwd, target, signal));

      case "type":

        return ok(await browser.type(cwd, action.path, action.body, signal));

      case "press":

        return ok(await browser.press(cwd, target, signal));

      case "tab":

        return ok(await browser.tab(cwd, target, signal));

    }

    throw new Error(`${action.verb} is handled by the loop`);

  } catch (err) {

    return { verb: action.verb, ok: false, text: err instanceof Error ? err.message : String(err) };

  }

}
