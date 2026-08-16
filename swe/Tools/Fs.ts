import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const MAX_READ = 120_000;
const MAX_GREP_FILE = 400_000;

const SKIP = new Set([

  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  "coverage",
  ".next",
  ".cache",
  ".venv",
  "venv",
  "target",
  "vendor",
  "__pycache__",

]);

const KEEP_DOTFILES = new Set([".env.example", ".gitignore", ".github"]);

// generated, enormous, and never worth a line of the repo map
const NOISE = /^(bun\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock)$|\.(min\.js|min\.css|map|lock)$/i;

function skip(name: string): boolean {

  // "nul" is a stray file a `>nul` redirect leaves behind on Windows, never something to read
  if (SKIP.has(name) || name === "nul") {

    return true;

  }

  return name.startsWith(".") && !KEEP_DOTFILES.has(name);

}

/**
 * Normalises anything the model might hand us
*/
export function relPath(raw: string, cwd: string): string {

  let cleaned = raw.trim().replace(/\\/g, "/").replace(/^["'`]|["'`]$/g, "");
  const root = resolve(cwd).replace(/\\/g, "/");

  if (cleaned.toLowerCase() === root.toLowerCase()) {

    return ".";

  }

  if (cleaned.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {

    cleaned = cleaned.slice(root.length + 1);

  }

  cleaned = cleaned.replace(/^\.\//, "").replace(/^\/+/, "") || ".";

  const abs = resolve(cwd, cleaned);
  const rel = relative(resolve(cwd), abs);

  if (rel.startsWith("..")) {

    throw new Error(`${raw} is outside the repo`);

  }

  return rel ? rel.split(sep).join("/") : ".";

}

function abs(cwd: string, rel: string): string {

  return rel === "." ? cwd : join(cwd, rel);
}

function isBinary(text: string): boolean {

  return text.slice(0, 4000).includes("\0");

}

/** A trailing newline is a terminator, not an eighth line — counting it makes every number look wrong. */
function splitLines(text: string): string[] {

  const lines = text.split("\n");

  if (lines.length > 1 && lines[lines.length - 1] === "") {

    lines.pop();

  }

  return lines;

}

function lineCount(text: string): number {

  return splitLines(text).length;

}

function readText(path: string): string {

  return readFileSync(path, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

}

const SYMBOLS: [RegExp, string[]][] = [

  [/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const\s+(?=\w+\s*[:=]\s*(?:async\s*)?(?:\(|function|class)))\s+([A-Za-z_$][\w$]*)/gm, ["ts", "tsx", "js", "jsx", "mts", "cts"]],
  [/^(?:func\s+(?:\([^)]*\)\s*)?|type\s+)([A-Za-z_]\w*)/gm, ["go"]],
  [/^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm, ["py"]],
  [/^(?:pub\s+)?(?:async\s+)?(?:fn|struct|enum|trait|mod)\s+([A-Za-z_]\w*)/gm, ["rs"]],

];

/** Cheap top-level outline. Wrong on exotic syntax, right often enough to save a read. */
export function symbolsOf(text: string, path: string): string[] {

  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const entry = SYMBOLS.find(([, exts]) => exts.includes(ext));

  if (!entry) {

    return [];

  }

  const names: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  entry[0].lastIndex = 0;

  while ((match = entry[0].exec(text))) {

    const name = match[1];

    if (!seen.has(name)) {

      seen.add(name);
      names.push(name);

    }

  }

  return names;

}

interface Entry {

  name: string;
  dir: boolean;

}

function children(cwd: string, rel: string): Entry[] {

  const names = readdirSync(abs(cwd, rel)).filter((name) => !skip(name));
  const out: Entry[] = [];

  for (const name of names) {

    try {

      out.push({ name, dir: statSync(join(abs(cwd, rel), name)).isDirectory() });

    } catch {

      // a symlink into nowhere; not worth failing the listing
    }

  }

  return out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));

}

function countFiles(cwd: string, rel: string, budget = 4000): number {

  let total = 0;

  for (const child of children(cwd, rel)) {

    if (total > budget) {

      break;

    }

    total += child.dir ? countFiles(cwd, `${rel}/${child.name}`, budget) : 1;

  }

  return total;

}

function fileLine(cwd: string, rel: string, name: string, width: number): string {

  const path = join(cwd, rel);

  let text: string;

  try {

    text = readText(path);

  } catch {

    return `  ${name}`;

  }

  if (isBinary(text)) {

    return `  ${name}`;

  }

  const lines = String(lineCount(text)).padStart(5);
  const all = symbolsOf(text, rel);
  const symbols = all.slice(0, 6);
  const more = all.length > symbols.length ? `, +${all.length - symbols.length} more` : "";
  const tail = symbols.length ? `  ${symbols.join(", ")}${more}` : "";

  return `  ${name.padEnd(width)} ${lines}${tail}`;

}

/** A directory at a glance: every file with its size and outline, subdirectories with their weight. */
export function listDir(cwd: string, target = "."): string {

  const rel = relPath(target || ".", cwd);
  const path = abs(cwd, rel);

  if (!existsSync(path)) {

    throw new Error(`${rel} does not exist`);

  }

  if (!statSync(path).isDirectory()) {

    return readFiles(cwd, [{ path: rel }]);

  }

  const kids = children(cwd, rel);

  if (!kids.length) {

    return `${rel}/  empty`;

  }

  const width = Math.min(34, Math.max(...kids.map((kid) => kid.name.length + (kid.dir ? 1 : 0))));
  const lines: string[] = [`${rel === "." ? "." : `${rel}/`}`];

  for (const kid of kids) {

    const child = rel === "." ? kid.name : `${rel}/${kid.name}`;

    if (kid.dir) {

      lines.push(`  ${`${kid.name}/`.padEnd(width)} ${String(countFiles(cwd, child)).padStart(5)} files`);
      continue;

    }

    lines.push(fileLine(cwd, child, kid.name, width));

  }

  return lines.join("\n");

}

/** The map that ships in the system prompt: directories, then their files, two levels deep. */
export function repoMap(cwd: string, maxLines = 160): string {

  const lines: string[] = [];

  const walk = (rel: string, depth: number) => {

    if (lines.length >= maxLines) {

      return;

    }

    const kids = children(cwd, rel);
    const files = kids.filter((kid) => !kid.dir && !NOISE.test(kid.name));
    const dirs = kids.filter((kid) => kid.dir);
    const width = Math.min(30, Math.max(1, ...files.map((file) => file.name.length)));

    if (files.length) {

      lines.push(rel === "." ? "." : `${rel}/`);

      for (const file of files) {

        if (lines.length >= maxLines) {

          lines.push("  ...");
          return;

        }

        lines.push(fileLine(cwd, rel === "." ? file.name : `${rel}/${file.name}`, file.name, width));

      }

      lines.push("");

    }

    for (const dir of dirs) {

      const child = rel === "." ? dir.name : `${rel}/${dir.name}`;

      if (depth >= 2) {

        lines.push(`${child}/  ${countFiles(cwd, child)} files`);
        continue;

      }

      walk(child, depth + 1);

    }

  };

  walk(".", 0);

  return lines.join("\n").trim() || "empty repository";

}

const DOCS = ["CLAUDE.md", "AGENTS.md", "AGENT.md", ".cursorrules", "CONVENTIONS.md", "CONTRIBUTING.md"];

/** The repo's own conventions file, if it has one. Named in the prompt, read by the model. */
export function projectDoc(cwd: string): string {

  for (const name of DOCS) {

    const path = join(cwd, name);

    if (!existsSync(path)) {

      continue;

    }

    try {

      if (readText(path).trim()) {

        return name;

      }

    } catch {

      // unreadable is the same as absent here

    }

  }

  return "";

}

export interface ReadSpec {

  path: string;
  start?: number;
  end?: number;

}

/** `swe/agent.ts 40-120`, `swe/agent.ts:40-120`, `swe/agent.ts:40` — all mean the same thing. */
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

  // a bare line number is a grep hit pasted back at us; show the neighbourhood
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

    const all = splitLines(text);
    const start = Math.max(1, Math.min(spec.start ?? 1, all.length));
    const end = Math.min(all.length, spec.end ?? all.length);
    const slice = all.slice(start - 1, end);

    let body = numbered(slice, start);
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

function walkFiles(cwd: string, rel: string, out: string[], cap: number) {

  if (out.length >= cap) {

    return;

  }

  for (const child of children(cwd, rel)) {

    const path = rel === "." ? child.name : `${rel}/${child.name}`;

    if (child.dir) {

      walkFiles(cwd, path, out, cap);
      continue;

    }

    if (out.length >= cap) {

      return;

    }

    out.push(path);

  }

}

/**
  Converts a glob pattern to a regex.
*/
function globToRe(glob: string): RegExp {

  const normalized = glob.replace(/\\/g, "/");

  let source = "";

  for (let i = 0; i < normalized.length; i += 1) {

    if (normalized.startsWith("**/", i)) {

      source += "(?:.*/)?";
      i += 2;
      continue;

    }

    const char = normalized[i];

    if (char === "*") {

      source += "[^/]*";
      continue;

    }

    if (char === "?") {

      source += ".";
      continue;

    }

    source += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;

  }

  return new RegExp(`(^|/)${source}$`);

}

export interface GrepOptions {

  path?: string;
  glob?: string;

  max?: number;

  /** Lines shown per file; the rest are counted and named, never silently dropped. */
  perFile?: number;

}

/** `/pattern/flags` is a regex; anything else is literal text. Several patterns match as alternatives. */
function toMatcher(patterns: string[]): RegExp {

  const sources = patterns.map((pattern) => {

    const re = /^\/(.+)\/[gimsu]*$/.exec(pattern);

    return re ? re[1] : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  });

  return new RegExp(sources.join("|"));

}

/** Grouped by file so paths never collide with line numbers the way `path:12:` does. */
export function grep(cwd: string, pattern: string | string[], options: GrepOptions = {}): string {

  const patterns = (Array.isArray(pattern) ? pattern : [pattern]).map((one) => one.trim()).filter(Boolean);

  if (!patterns.length) {

    throw new Error("grep needs a pattern");

  }

  const root = relPath(options.path || ".", cwd);

  if (!existsSync(abs(cwd, root))) {

    throw new Error(`${root} does not exist`);

  }

  const matcher = toMatcher(patterns);
  const filter = options.glob ? globToRe(options.glob) : null;

  // The model's budget is a few hundred lines, so we don't want to show more than that.
  const perFile = Math.max(1, Math.min(options.perFile ?? 6, 50));
  const max = Math.max(perFile, Math.min(options.max ?? 120, 400));

  const files: string[] = [];

  if (statSync(abs(cwd, root)).isDirectory()) {

    walkFiles(cwd, root, files, 8000);

  } else {

    files.push(root);

  }

  const candidates = filter ? files.filter((file) => filter.test(file)) : files;

  const groups: string[] = [];

  let hits = 0;
  let shown = 0;

  /** Files the budget ran out before reaching — named, so a capped grep never hides what it skipped. */
  const unsearched: string[] = [];

  for (const file of candidates) {

    if (shown >= max) {

      unsearched.push(file);

      continue;

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

    const lines = text.split("\n");
    const found: string[] = [];

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

    const more = inFile > found.length ? `  (${inFile} matches, first ${found.length})` : "";

    groups.push(`${file}${more}\n${found.join("\n")}`);

  }

  if (!groups.length) {

    const where = options.glob ? ` in ${options.glob}` : root === "." ? "" : ` in ${root}`;

    return `no matches for ${patterns.join(" or ")}${where}`;

  }

  const total = `${hits} ${hits === 1 ? "match" : "matches"} in ${groups.length} ${groups.length === 1 ? "file" : "files"}`;
  const trimmed = hits > shown ? `  (${shown} shown, ${perFile} per file)` : "";

  const tail = unsearched.length ? `\n\nnot searched — budget spent before these: ${unsearched.slice(0, 8).join(", ")}${unsearched.length > 8 ? `, +${unsearched.length - 8} more` : ""}` : "";

  return `${total}${trimmed}\n\n${groups.join("\n\n")}${tail}`;

}

export function writeFile(cwd: string, target: string, content: string): string {

  const rel = relPath(target, cwd);

  if (rel === ".") {

    throw new Error("write needs a file path");

  }

  const path = abs(cwd, rel);
  const existed = existsSync(path);
  const body = content.endsWith("\n") ? content : `${content}\n`;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");

  return `${existed ? "replaced" : "created"} ${rel}  ${lineCount(body)} lines`;

}

export function deleteFiles(cwd: string, targets: string[]): string {

  if (!targets.length) {

    throw new Error("delete needs a path");

  }

  const out: string[] = [];

  for (const target of targets) {

    const rel = relPath(target, cwd);

    if (rel === ".") {

      throw new Error("refusing to delete the repo root");

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
