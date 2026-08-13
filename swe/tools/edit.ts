import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { relPath } from "./fs";

export interface Pair {

  find: string;
  replace: string;

}

const FIND_MARK = /^\s*(?:@@\s*FIND|<{5,}\s*SEARCH|@@\s*SEARCH)\s*$/i;
const REPLACE_MARK = /^\s*(?:@@\s*REPLACE|={5,}|>{5,}\s*REPLACE)\s*$/i;
const END_MARK = /^\s*(?:>{5,}\s*REPLACE|@@\s*END)\s*$/i;

/** Both the `@@ FIND` form we document and the `<<<<<<< SEARCH` form models arrive knowing. */
export function parsePairs(body: string): Pair[] {

  const lines = body.split("\n");
  const pairs: Pair[] = [];

  let find: string[] | null = null;
  let replace: string[] | null = null;

  const flush = () => {

    if (find && replace) {

      pairs.push({ find: find.join("\n"), replace: replace.join("\n") });

    }

    find = null;
    replace = null;

  };

  for (const line of lines) {

    if (FIND_MARK.test(line)) {

      flush();
      find = [];
      continue;

    }

    if (find && !replace && REPLACE_MARK.test(line)) {

      replace = [];
      continue;

    }

    if (replace && END_MARK.test(line)) {

      flush();
      continue;

    }

    if (replace) {

      replace.push(line);
      continue;

    }

    if (find) {

      find.push(line);

    }

  }

  flush();

  return pairs;

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

const COMPARATORS: [Compare, string][] = [

  [(a, b) => a === b, "exact"],
  [(a, b) => a.trimEnd() === b.trimEnd(), "ignoring trailing space"],
  [(a, b) => a.trim() === b.trim(), "ignoring indentation"],

];

function findLineMatches(lines: string[], needle: string[], same: Compare): number[] {

  const hits: number[] = [];

  for (let i = 0; i + needle.length <= lines.length; i += 1) {

    let ok = true;

    for (let j = 0; j < needle.length; j += 1) {

      if (!same(lines[i + j], needle[j])) {

        ok = false;
        break;

      }

    }

    if (ok) {

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

/** Exact line = 2, near-miss (stale value, renamed symbol) = 1. */
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

/** The window that looks most like FIND, so a stale edit can be fixed without re-reading the file. */
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
  const width = String(to).length;
  const body = lines
    .slice(from, to)
    .map((line, i) => `${String(from + i + 1).padStart(width)}  ${line}`)
    .join("\n");

  return `\n\nClosest match in the file:\n\n${body}`;

}

export interface EditResult {

  ok: boolean;
  text: string;

  added: number;
  removed: number;

}

export function applyEdit(cwd: string, target: string, body: string): EditResult {

  const rel = relPath(target, cwd);
  const path = join(cwd, rel);

  if (!existsSync(path)) {

    return { ok: false, text: `${rel} does not exist. Use <write ${rel}> to create it.`, added: 0, removed: 0 };

  }

  const pairs = parsePairs(body);

  if (!pairs.length) {

    return {

      ok: false,
      text: "No @@ FIND / @@ REPLACE pair in that block.\n\n  <edit path>\n  @@ FIND\n  old text\n  @@ REPLACE\n  new text\n  </edit>",
      added: 0,
      removed: 0,

    };

  }

  const raw = readFileSync(path, "utf8");
  const crlf = raw.includes("\r\n");

  let text = raw.replace(/\r\n/g, "\n");

  const notes: string[] = [];
  const previews: string[] = [];

  let added = 0;
  let removed = 0;

  for (const [index, pair] of pairs.entries()) {

    const find = stripGutter(pair.find);
    const replace = pair.replace;
    const label = pairs.length > 1 ? `pair ${index + 1}: ` : "";

    if (!find.trim()) {

      return { ok: false, text: `${label}FIND is empty. Copy the exact lines you want to change.`, added, removed };

    }

    const exact = occurrences(text, find);

    if (exact.length > 1) {

      const at = exact.map((offset) => lineOf(text, offset)).slice(0, 6).join(", ");

      return {

        ok: false,
        text: `${label}FIND matches ${exact.length} places in ${rel} (lines ${at}). Include more surrounding lines so it is unique.`,
        added,
        removed,

      };

    }

    if (exact.length === 1) {

      text = text.slice(0, exact[0]) + replace + text.slice(exact[0] + find.length);
      previews.push(preview(rel, text, lineOf(text, exact[0])));

      added += replace ? replace.split("\n").length : 0;
      removed += find.split("\n").length;

      continue;

    }

    const lines = text.split("\n");
    const needle = find.split("\n");
    const wanted = replace.split("\n");

    let applied = false;

    for (const [same, how] of COMPARATORS.slice(1)) {

      const hits = findLineMatches(lines, needle, same);

      if (!hits.length) {

        continue;

      }

      if (hits.length > 1) {

        return {

          ok: false,
          text: `${label}FIND matches ${hits.length} places in ${rel} (lines ${hits.slice(0, 6).map((i) => i + 1).join(", ")}). Include more surrounding lines so it is unique.`,
          added,
          removed,

        };

      }

      const at = hits[0];
      const shifted = reindent(wanted, indentOf(needle[0]), indentOf(lines[at]));

      lines.splice(at, needle.length, ...shifted);
      text = lines.join("\n");

      added += shifted.length;
      removed += needle.length;

      notes.push(`${label}matched ${how}`);
      previews.push(preview(rel, text, at + 1));

      applied = true;
      break;

    }

    if (applied) {

      continue;

    }

    if (replace.trim() && text.includes(replace)) {

      notes.push(`${label}already applied, left alone`);
      continue;

    }

    return {

      ok: false,
      text: `${label}FIND is not in ${rel}.${nearest(text.split("\n"), needle)}`,
      added,
      removed,

    };

  }

  writeFileSync(path, crlf ? text.replace(/\n/g, "\r\n") : text, "utf8");

  const head = `${rel}  +${added} -${removed}${notes.length ? `  (${notes.join("; ")})` : ""}`;

  return { ok: true, text: [head, ...previews].join("\n\n"), added, removed };

}

/** Three lines either side of the change, so the model can see it landed without another read. */
function preview(rel: string, text: string, line: number): string {

  const lines = text.split("\n");
  const from = Math.max(0, line - 4);
  const to = Math.min(lines.length, line + 4);
  const width = String(to).length;

  return lines
    .slice(from, to)
    .map((body, i) => `${String(from + i + 1).padStart(width)}  ${body}`)
    .join("\n");

}
