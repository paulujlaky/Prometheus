// The agent protocol: tagged blocks in, tagged results out. No JSON, no escaping.

export const VERBS = ["ls", "read", "grep", "edit", "write", "delete", "run", "say", "done"] as const;

export type Verb = (typeof VERBS)[number];

const VERB_SET = new Set<string>(VERBS);

// models reach for whatever verb their training favours; accepting the synonym costs nothing
const ALIASES: Record<string, Verb> = {

  list: "ls",
  dir: "ls",
  tree: "ls",

  cat: "read",
  open: "read",
  view: "read",
  show: "read",

  search: "grep",
  find: "grep",
  rg: "grep",

  patch: "edit",
  replace: "edit",
  str_replace: "edit",

  create: "write",
  new: "write",
  file: "write",

  rm: "delete",
  remove: "delete",
  unlink: "delete",

  bash: "run",
  sh: "run",
  shell: "run",
  cmd: "run",
  exec: "run",
  command: "run",

  echo: "say",
  message: "say",
  tell: "say",
  note: "say",
  plan: "say",

  finish: "done",
  complete: "done",
  final: "done",

};

export function asVerb(name: string | null | undefined): Verb | null {

  if (!name) {

    return null;

  }

  const lower = name.toLowerCase();

  return VERB_SET.has(lower) ? (lower as Verb) : (ALIASES[lower] ?? null);

}

export interface Action {

  verb: Verb;

  /** Target from the open tag, e.g. `<edit swe/agent.ts>`. Empty when the verb takes none. */
  path: string;

  /** The short line the model wrote directly above the block — the transcript row title. */
  label: string;

  body: string;

  /** The whole block, tags included — the transcript stores this verbatim. */
  raw: string;

}

const OPEN_TAG = /<([A-Za-z_][A-Za-z0-9_]*)([^>\n]*)>/g;

/** `path="a.ts"` / `'a.ts'` / `` `a.ts` `` / bare — all collapse to `a.ts`. */
function attrPath(raw: string): string {

  return raw
    .trim()
    .replace(/^(?:path|file|filename|target)\s*=\s*/i, "")
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/\\/g, "/")
    .trim();

}

/**
 * Blocks are scanned left to right, each resuming after the previous close tag, so a tag that
 * appears inside a file body (a `<write>` of HTML) is never mistaken for an action.
 */
export function parseActions(text: string): { thinking: string; actions: Action[] } {

  const actions: Action[] = [];
  const thoughts: string[] = [];

  let cursor = 0;
  let leadFrom = 0;

  while (cursor < text.length) {

    OPEN_TAG.lastIndex = cursor;

    const open = OPEN_TAG.exec(text);

    if (!open) {

      break;

    }

    const verb = asVerb(open[1]);

    if (!verb) {

      cursor = open.index + open[0].length;
      continue;

    }

    const bodyStart = open.index + open[0].length;
    const close = text.toLowerCase().indexOf(`</${open[1].toLowerCase()}>`, bodyStart);
    const bodyEnd = close === -1 ? text.length : close;
    const blockEnd = close === -1 ? text.length : close + open[1].length + 3;

    const lead = splitLead(text.slice(leadFrom, open.index));

    if (lead.thinking) {

      thoughts.push(lead.thinking);

    }

    actions.push({

      verb,
      path: attrPath(open[2]),
      label: lead.label,

      body: trimBlock(text.slice(bodyStart, bodyEnd)),

      // the label rides along so a stored block still titles its own row on reload
      raw: lead.label ? `${lead.label}\n${text.slice(open.index, blockEnd)}` : text.slice(open.index, blockEnd),

    });

    cursor = blockEnd;
    leadFrom = blockEnd;

  }

  if (!actions.length) {

    return { thinking: cleanThinking(text), actions };

  }

  return { thinking: thoughts.join("\n\n"), actions };

}

const LABEL_MAX = 90;

/**
 * The line right above a block is that block's title; anything above that is thinking.
 * Models write this line unprompted, so the transcript gets a real label for free.
 */
function splitLead(lead: string): { thinking: string; label: string } {

  const lines = cleanThinking(lead).split("\n");

  while (lines.length && !lines[lines.length - 1].trim()) {

    lines.pop();

  }

  const last = (lines[lines.length - 1] ?? "")
    .replace(/^[-*>#\s]+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/[*_`]/g, "")
    .replace(/[:.]\s*$/, "")
    .trim();

  if (!last || last.length > LABEL_MAX) {

    return { thinking: lines.join("\n").trim(), label: "" };

  }

  return { thinking: lines.slice(0, -1).join("\n").trim(), label: last };

}

/** Drop the leading/trailing newline the tags sit on, keep everything else byte-exact. */
function trimBlock(body: string): string {

  return body.replace(/^[ \t]*\r?\n/, "").replace(/\r?\n[ \t]*$/, "");

}

function cleanThinking(text: string): string {

  return text
    .replace(/```[a-z]*\s*$/i, "")
    .replace(/^```[a-z]*\s*$/gim, "")
    .trim();

}

/** Live parse for the streaming row: verb, target and title as soon as the open tag lands. */
export function parsePartial(text: string): { verb: Verb | null; path: string; label: string } {

  const settled = parseActions(text);
  const last = settled.actions[settled.actions.length - 1];

  if (last) {

    return { verb: last.verb, path: last.path, label: last.label };

  }

  const partial = /<([A-Za-z_][A-Za-z0-9_]*)([^>\n]*)>?/g;
  let match: RegExpExecArray | null;

  while ((match = partial.exec(text))) {

    const verb = asVerb(match[1]);

    if (verb) {

      return { verb, path: attrPath(match[2]), label: splitLead(text.slice(0, match.index)).label };

    }

  }

  return { verb: null, path: "", label: "" };

}

export interface Result {

  verb: Verb;
  ok: boolean;
  text: string;

}

/** One shape, every time: `[verb ok]` then the body. Nothing conditional, nothing to re-learn. */
export function formatResults(results: Result[]): string {

  return results
    .map((result) => `[${result.verb} ${result.ok ? "ok" : "failed"}]\n${result.text.trim()}`)
    .join("\n\n");

}

const GUIDE = `You are a coding agent. You work in a real repository and you finish the job.

## Replying

Every block gets a title line directly above it: three to six words naming that step. It
becomes the label of that row in the transcript, and a block without one shows up unlabelled.
This holds for every block in the reply — including the ones after a <say>, which does not
title them. Only blocks run; never describe an action instead of taking it.

Put every block you already know you need in the same reply: they run top to bottom and stop
at the first failure, and one reply of four blocks beats four replies of one.

  <say>
  Tracing how deletion is wired before I add rename beside it.
  </say>

  find both call sites
  <grep>
  deleteChat
  renameChat
  </grep>

  read the files that own them
  <read>
  swe/main.ts
  swe/sidebar.tsx 40-120
  </read>

## Blocks

  <ls>       a directory: files, line counts, top-level symbols
  <read>     whole files, or a line range
  <grep>     find text — one pattern per line, any of them matches
  <edit>     change a file by exact find / replace
  <write>    create a file, or replace one entirely
  <delete>   remove files
  <run>      shell: build, test, git
  <say>      talk to the user
  <done>     final summary, ends the run

A tag takes a target: <grep swe/tools> searches one directory, <edit swe/x.ts> names the file.

  <edit swe/agent.ts>
  @@ FIND
  const MAX_STEPS = 100;
  @@ REPLACE
  const MAX_STEPS = 40;
  </edit>

  <write swe/hello.ts>
  export const hello = "hi";
  </write>

  <done>
  Fixed the dropped observation in the agent loop.

  - \`say\` emitted an observation the renderer had no row for.
  - Removed the second emit; the say event settles its own row.
  - \`bun run swe:build\` passes.
  </done>

## Rules

  The user sees only <say> and <done>. Open with a <say> naming your plan, <say> again when
  you learn something that changes it or finish a piece of the work, and never go more than
  a few blocks without one — silence reads as a hang. Both render as markdown: lead <done>
  with one sentence of what now works, then a bullet per change. Backtick files and commands.
  Paths are relative to the repo root, forward slashes: swe/agent.ts
  FIND is copied exactly from a read — same text, same indentation.
  One <edit> may hold several @@ FIND / @@ REPLACE pairs. Put every change to a file in one block.
  Read a file before editing it. Never guess at contents.
  Use <read> and <grep> to look at code. <run> is for building, testing and git.

Checking your work is one step, not a phase. Run the build or the tests once, after the edits
are in. If it passes you are done — say so and call <done>. Do not re-run a check that passed,
do not invent a check the task did not ask for, and do not hunt for problems in code you did
not touch. If it fails, fix what it named and run it once more.`;

export function systemPrompt(map: string, doc: string, task: string): string {

  // named, not inlined — but read in the first batch, because style learned after the code is
  // written means the code gets written twice
  const conventions = doc ? `\n\n## House rules\n\nThis repo's conventions are in ${doc}. Read it in your first batch of blocks, before you write any code, and follow it in everything you write.` : "";

  return `${GUIDE}\n\n## Repo\n\n${map}${conventions}\n\n## Task\n\n${task}`;

}

export function followUpPrompt(map: string, task: string): string {

  return `Continue in the same repository, same protocol.\n\n## Repo\n\n${map}\n\n## Task\n\n${task}`;

}

/** Sent when a reply carried no block at all — short, and shows the shape rather than explaining it. */
export const NUDGE = `[harness]\nThat reply had no action block, so nothing ran. Reply with a block:\n\n  <read>\n  path/to/file.ts\n  </read>\n\nor <done> if the task is finished.`;
