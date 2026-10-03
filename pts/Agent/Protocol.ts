// Tagged blocks in, tagged results out. No JSON, so nothing the model writes ever needs escaping.

export const VERBS = ["ls", "read", "grep", "edit", "write", "delete", "run", "say", "done"] as const;

export type Verb = (typeof VERBS)[number];

const VERB_SET = new Set<string>(VERBS);

// models reach for whatever verb their training favours; accepting the synonym costs nothing
const ALIASES: Record<string, Verb> = {

  list: "ls",
  dir: "ls",

  cat: "read",
  open: "read",
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

  message: "say",
  tell: "say",

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

export interface Result {

  verb: Verb;
  ok: boolean;
  text: string;

}

const OPEN_TAG = /<([A-Za-z_][A-Za-z0-9_]*)([^>\n]*)>/g;
const LABEL_MAX = 90;

/** `path="a.md"` / `'a.md'` / bare all collapse to `a.md`. */
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

  return last.length > LABEL_MAX ? "" : last;

}

/** Drop the newline the tags sit on, keep everything else byte-exact. */
function trimBlock(body: string): string {

  return body.replace(/^[ \t]*\r?\n/, "").replace(/\r?\n[ \t]*$/, "");

}

/** Unknown tags are prose; an unclosed block runs to the end of the reply. */
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

    const bodyStart = open.index + open[0].length;
    const close = text.toLowerCase().indexOf(`</${open[1].toLowerCase()}>`, bodyStart);
    const bodyEnd = close === -1 ? text.length : close;

    actions.push({

      verb,
      path: attrPath(open[2]),
      label: labelOf(text.slice(leadFrom, open.index)),

      body: trimBlock(text.slice(bodyStart, bodyEnd)),

    });

    cursor = close === -1 ? text.length : close + open[1].length + 3;
    leadFrom = cursor;

  }

  return actions;

}

export interface Pair {

  find: string;
  replace: string;

}

const FIND_MARK = /^\s*(?:@@\s*FIND|<{5,}\s*SEARCH|@@\s*SEARCH)\s*$/i;
const REPLACE_MARK = /^\s*(?:@@\s*REPLACE|={5,}|>{5,}\s*REPLACE)\s*$/i;
const END_MARK = /^\s*(?:>{5,}\s*REPLACE|@@\s*END)\s*$/i;

/** Both the `@@ FIND` form we document and the `<<<<<<< SEARCH` form models arrive knowing. */
export function parsePairs(body: string): Pair[] {

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

  for (const line of body.split("\n")) {

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

    (replace ?? find)?.push(line);

  }

  flush();

  return pairs;

}

/** One shape, every time: `[verb ok]` then the body. */
export function formatResults(results: Result[]): string {

  return results.map((result) => `[${result.verb} ${result.ok ? "ok" : "failed"}]\n${result.text.trim()}`).join("\n\n");

}

const GUIDE = `You are an always-on agent running on a Linux server. You have your own workspace folder with real files and a real shell, and you work through tasks on your own — the user is usually not watching. They see only <say> and <done>.

## Replying

Write a short title line, three to six words, directly above every block. Only blocks run; never describe an action instead of taking it.

The chat you are in may offer built-in tools such as web search or file creation. Never call them: their results do not reach your workspace. Use the blocks below — <run> with curl reaches the web.

Put every block you already know you need in the same reply. They run top to bottom and stop at the first failure. Blocks after a failure do not run — send them again once the failure is fixed.

  check what is already here
  <ls>
  </ls>

  read the plan
  <read>
  notes/plan.md
  </read>

## Blocks

  <ls>       a folder: files and line counts
  <read>     whole files, or a line range: notes.md 40-80
  <grep>     find text — one pattern per line, /regex/ allowed
  <edit>     change a file by exact find / replace
  <write>    create a file, or replace one entirely
  <delete>   remove files
  <run>      a shell command: curl, python, git, scripts — anything installed
  <say>      tell the user something — the task keeps going
  <done>     final report — the only thing that ends a task

A tag takes a target: <read notes.md>, <grep notes>, <edit notes.md>.

  <edit notes/plan.md>
  @@ FIND
  - [ ] book the venue
  @@ REPLACE
  - [x] book the venue
  </edit>

  <write notes/hello.md>
  # Hello
  </write>

## Memory

MEMORY.md in your workspace is your long-term memory. It is shown to you at the start of every task; nothing else carries over between tasks. When you learn something worth keeping — a preference, an account, a standing commitment, where you left something — edit MEMORY.md in the same reply. Keep it short and current, and delete what has gone stale.

## Rules

  Paths are relative to your workspace, with forward slashes. Nothing outside it is reachable.
  FIND is copied exactly from a read — same text, same indentation. Read a file before editing it.
  Use <ls>, <read> and <grep> to look at files. <run> is for everything else.
  Commands get no input, so anything that prompts fails. Pass flags like -y instead.
  Do the task and only the task. When it is done, end with <done> in that same reply —
  but never in a reply whose <run>, <read>, <grep> or <ls> output you have not seen yet.
  Lead <done> with one sentence of the outcome, then a bullet per thing done or found.
  Keep <say> and <done> short and plain: everyday words, no preamble.
  If you are blocked on something only the user can do, say exactly what you need in <done>.`;

/** The bot's system prompt. Only what rarely changes lives here, because changing it means minting a new bot. */
export function botInstructions(name: string, persona: string): string {

  return `${GUIDE}\n\n## Who you are\n\nYour name is ${name}.${persona.trim() ? `\n\n${persona.trim()}` : ""}`;

}

export interface TaskContext {

  user: string;
  memory: string;

  /** Recent tasks and how they ended, oldest first. */
  recent: string[];

}

function section(title: string, body: string, empty: string): string {

  return `## ${title}\n\n${body.trim() || empty}`;

}

/** First message of a run: everything that changes between tasks, then the task itself. */
export function taskMessage(context: TaskContext, task: string): string {

  return [

    section("About the user (USER.md)", context.user, "Nothing yet."),
    section("Your memory (MEMORY.md)", context.memory, "Empty — nothing remembered yet. Start it with <write MEMORY.md>, since there is nothing to edit."),
    section("Recent tasks", context.recent.join("\n"), "None."),
    section("Task", task, ""),
    "End with <done> in the same reply once the task is finished.",

  ].join("\n\n");

}

export const NUDGE = `[harness]\nThat reply had no block, so nothing ran. If the task is finished, end it now with <done>. Otherwise send the block that does the next piece of it.`;
