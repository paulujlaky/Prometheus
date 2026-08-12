import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const MAX_FILE = 80_000;

export function safeRel(raw: string, cwd: string): string {

  const cleaned = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = resolve(cwd, cleaned);
  const root = resolve(cwd);
  const rel = relative(root, abs);

  if (!rel || rel.startsWith("..") || normalize(abs) === normalize(root)) {

    if (normalize(abs) === normalize(root)) {

      throw new Error("path is the workspace root");

    }

    throw new Error(`path escapes workspace: ${raw}`);

  }

  return rel.split(sep).join("/");

}

export interface ReadRange {

  start?: number;
  end?: number;

}

export function readFiles(cwd: string, paths: string[], range: ReadRange = {}): string {

  if (!paths.length) {

    throw new Error("read: args.path or args.paths required");

  }

  const chunks: string[] = [];

  for (const raw of paths) {

    const rel = safeRel(raw, cwd);
    const abs = join(cwd, rel);

    if (!existsSync(abs)) {

      chunks.push(`===== ${rel} =====\n<missing>`);
      continue;

    }

    const lines = readFileSync(abs, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const total = lines.length;
    const windowed = range.start != null || range.end != null;
    const start = Math.max(1, range.start ?? 1);
    const end = Math.min(total, range.end ?? total);
    const slice = lines.slice(start - 1, end);
    const width = String(end).length;
    const body = slice.map((line, i) => `${String(start + i).padStart(width)}|${line}`).join("\n");

    const header = windowed && (start > 1 || end < total)
      ? `===== ${rel} lines ${start}-${end} of ${total} =====`
      : `===== ${rel} (${total} lines) =====`;

    let block = `${header}\n${body}`;

    if (block.length > MAX_FILE) {

      const kept = body.slice(0, MAX_FILE).split("\n").length;
      const last = start + kept - 1;

      block = `${header}\n${body.slice(0, MAX_FILE)}\n\n<truncated at line ${last} of ${total} — read again with start: ${last + 1}>`;

    }

    chunks.push(block);

  }

  return chunks.join("\n\n");

}

export function writeFiles(cwd: string, files: { path: string; content: string }[]): string {

  if (!files.length) {

    throw new Error("write: args.path+content or args.files required");

  }

  const out: string[] = [];

  for (const file of files) {

    const rel = safeRel(file.path, cwd);
    const abs = join(cwd, rel);

    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content, "utf8");
    out.push(`wrote ${rel} (${file.content.length} chars)`);

  }

  return out.join("\n");

}

export function deleteFiles(cwd: string, paths: string[]): string {

  if (!paths.length) {

    throw new Error("delete: args.path or args.paths required");

  }

  const out: string[] = [];

  for (const raw of paths) {

    const rel = safeRel(raw, cwd);
    const abs = join(cwd, rel);

    if (!existsSync(abs)) {

      throw new Error(`delete: missing ${rel}`);

    }

    unlinkSync(abs);
    out.push(`deleted ${rel}`);

  }

  return out.join("\n");

}

export function searchFiles(
  cwd: string,
  pattern: string,
  root = ".",
  glob?: string,
  max = 80,
): string {

  if (!pattern) {

    throw new Error("search: args.pattern required");

  }

  const rel = root && root !== "." ? safeRel(root, cwd) : ".";
  const shell = process.env.SWE_SHELL ?? "bash";
  const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const include = glob ? `--include=${q(glob)} ` : "";
  const excludes = [
    "--exclude-dir=node_modules",
    "--exclude-dir=.git",
    "--exclude-dir=dist",
    "--exclude-dir=out",
    "--exclude-dir=coverage",
  ].join(" ");
  const cap = Math.max(1, Math.min(max, 200));
  const cmd = `grep -rn -I --color=never ${excludes} ${include}${q(pattern)} ${q(rel)} | head -n ${cap}`;

  const result = spawnSync(shell, ["-lc", cmd], { cwd, encoding: "utf8", windowsHide: true });
  const text = (result.stdout ?? "").trim();

  if (!text) {

    return "<no matches>";

  }

  const lines = text.split("\n");
  const clipped = lines.length >= cap ? `${text}\n<truncated to ${cap} hits — narrow path/glob>` : text;

  return clipped;

}
