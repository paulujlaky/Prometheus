// The agents' block protocol, read the way server/agent/protocol reads it, so each block lines up with its result.

export const VERBS = ["ls", "read", "grep", "edit", "write", "delete", "run", "open", "look", "click", "type", "press", "tab", "submit", "handoff", "ask", "routine", "say", "notify", "done"] as const;

export type Verb = (typeof VERBS)[number];

const VERB_SET = new Set<string>(VERBS);

const ALIASES: Record<string, Verb> = {

  list: "ls",
  dir: "ls",

  cat: "read",
  view: "read",

  search: "grep",
  find: "grep",
  rg: "grep",

  patch: "edit",
  replace: "edit",
  str_replace: "edit",

  create: "write",
  file: "write",

  rm: "delete",
  remove: "delete",

  bash: "run",
  sh: "run",
  shell: "run",
  exec: "run",
  command: "run",

  goto: "open",
  visit: "open",
  navigate: "open",
  browse: "open",

  snapshot: "look",
  page: "look",

  fill: "type",
  input: "type",

  key: "press",

  tabs: "tab",

  handover: "handoff",
  human: "handoff",

  question: "ask",
  choose: "ask",

  routines: "routine",
  schedule: "routine",
  remind: "routine",
  cron: "routine",
  watch: "routine",

  message: "say",
  tell: "say",

  alert: "notify",
  ping: "notify",
  push: "notify",

  finish: "done",
  complete: "done",

};

export function asVerb(name: string): Verb | null {

  const lower = name.toLowerCase();

  return VERB_SET.has(lower) ? (lower as Verb) : (ALIASES[lower] ?? null);

}

export interface Action {

  verb: Verb;

  /** Target from the open tag: `<edit notes.md>`. Empty when the model gave none. */
  path: string;

  /** The short title line directly above the block. */
  label: string;

  body: string;

}

const OPEN_TAG = /<([A-Za-z_][A-Za-z0-9_]*)([^>\n]*)>/g;
const LABEL_MAX = 90;

/** A workspace file named on its own, like notes/plan.md. */
const FILE_PATH = /^[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z0-9]{1,8}$/;

/** Verbs whose body is a line or two, never file content that could itself hold a tag. */
const SHORT_BODY = new Set<Verb>(["ls", "read", "grep", "delete", "open", "look", "click", "press", "tab"]);

function attrPath(raw: string): string {

  return raw.trim().replace(/^(?:path|file|filename|target)\s*=\s*/i, "").replace(/^["'`]|["'`]$/g, "").replace(/\\/g, "/").trim();

}

function cleanThinking(text: string): string {

  return text.replace(/```[a-z]*\s*$/i, "").replace(/^```[a-z]*\s*$/gim, "").trim();

}

/** The last short line before a block is its title; everything above it is thinking. */
function labelOf(lead: string): string {

  const lines = cleanThinking(lead).split("\n").filter((line) => line.trim());
  const last = (lines[lines.length - 1] ?? "").replace(/^[-*>#\s]+/, "").replace(/^\d+[.)]\s+/, "").replace(/[*_`]/g, "").replace(/[:.]\s*$/, "").trim();

  return [...last].length > LABEL_MAX ? "" : last;

}

/** Drop the newline the tags sit on, keep everything else byte-exact. */
function trimBlock(body: string): string {

  return body.replace(/^[ \t]*\r?\n/, "").replace(/\r?\n[ \t]*$/, "");

}

/** Where the next block opens at the start of a line after `from`, or -1. */
function nextBlock(text: string, from: number): number {

  OPEN_TAG.lastIndex = from;

  for (let match = OPEN_TAG.exec(text); match; match = OPEN_TAG.exec(text)) {

    if (asVerb(match[1]) && /(^|\n)[ \t]*$/.test(text.slice(0, match.index))) {

      return match.index;

    }

  }

  return -1;

}

/** Unknown tags are prose. An unclosed short block ends where the next block opens; any other runs to the end of the reply. */
export function parseActions(text: string): Action[] {

  const actions: Action[] = [];

  let cursor = 0;
  let leadFrom = 0;

  while (cursor < text.length) {

    OPEN_TAG.lastIndex = cursor;

    const open = OPEN_TAG.exec(text);

    if (!open) {

      break;

    }

    const verb = asVerb(open[1]);

    // "`<run>`" is the model talking about a block, not opening one
    if (!verb || text[open.index - 1] === "`") {

      cursor = open.index + open[0].length;
      continue;

    }

    const tag = open[1].toLowerCase();
    const bodyStart = open.index + open[0].length;
    const close = text.toLowerCase().indexOf(`</${tag}>`, bodyStart);

    let bodyEnd = text.length;

    cursor = text.length;

    if (close !== -1) {

      bodyEnd = close;
      cursor = close + tag.length + 3;

    } else {

      const next = nextBlock(text, bodyStart);

      if (next !== -1 && SHORT_BODY.has(verb)) {

        bodyEnd = next;
        cursor = next;

      }

    }

    let path = attrPath(open[2]);
    let body = trimBlock(text.slice(bodyStart, bodyEnd));

    // "<edit>plan.md</edit>" then the pairs and a second </edit>: one block on that file
    const second = text.toLowerCase().indexOf(`</${tag}>`, cursor);

    if (close !== -1 && !path && (verb === "edit" || verb === "write") && FILE_PATH.test(body.trim()) && second !== -1) {

      const next = nextBlock(text, cursor);

      if (next === -1 || next > second) {

        path = body.trim();
        body = trimBlock(text.slice(cursor, second));
        cursor = second + tag.length + 3;

      }

    }

    actions.push({ verb, path, label: labelOf(text.slice(leadFrom, open.index)), body });

    leadFrom = cursor;

  }

  return actions;

}

export interface Question {

  prompt: string;
  choices: string[];

  /** Placeholder for a written answer; empty when only the choices are offered. */
  write: string;

}

const CHOICE = /^(?:[-*•]|\d+[.)])\s+/;

/** An <ask> body: the question, `- ` choices, and a `+ ` write-in. With no choices, writing is the only answer. */
export function parseQuestion(body: string): Question {

  const prompt: string[] = [];
  const choices: string[] = [];

  let write = "";

  for (const raw of body.split("\n")) {

    const line = raw.trim();

    if (CHOICE.test(line)) {

      choices.push(line.replace(CHOICE, ""));

    } else if (line.startsWith("+")) {

      write = line.slice(1).trim() || "Something else";

    } else if (line && !choices.length) {

      prompt.push(line);

    }

  }

  return { prompt: prompt.join(" "), choices, write: write || (choices.length ? "" : "Your answer") };

}

/** `<done>wait</done>`: the agent's turn comes after someone else's, so there is nothing to show. */
export function isWaiting(done: string): boolean {

  return done.trim().toLowerCase().replace(/[.!]$/, "") === "wait";

}
