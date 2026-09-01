// The agent protocol: tagged blocks in, tagged results out. No JSON, no escaping.

export const VERBS = ["ls", "read", "grep", "edit", "write", "delete", "run", "mcp", "spawn", "plan", "ask", "say", "retry", "recap", "done"] as const;

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

  subagent: "spawn",
  subagents: "spawn",
  agent: "spawn",
  delegate: "spawn",
  fork: "spawn",
  parallel: "spawn",

  tool: "mcp",
  call: "mcp",
  server: "mcp",
  mcp_tool: "mcp",

  question: "ask",
  choose: "ask",
  choice: "ask",
  select: "ask",
  poll: "ask",

  blueprint: "plan",
  proposal: "plan",
  roadmap: "plan",
  steps: "plan",

  echo: "say",
  message: "say",
  tell: "say",
  note: "say",

  resend: "retry",
  replay: "retry",
  again: "retry",

  wrap: "recap",
  changelog: "recap",
  digest: "recap",

  finish: "done",
  complete: "done",
  final: "done",

};

// an alias that shadows a real verb is a silent no-op — asVerb resolves VERB_SET first, so every
// block written with it would route to the other tool and nothing anywhere would say so
for (const alias of Object.keys(ALIASES)) {

  if (VERB_SET.has(alias)) {

    throw new Error(`ALIASES["${alias}"] shadows the real verb <${alias}>: asVerb checks VERB_SET first, so the alias can never fire. Remove it.`);

  }

}

export function asVerb(name: string | null | undefined): Verb | null {

  if (!name) {

    return null;

  }

  const lower = name.toLowerCase();

  return VERB_SET.has(lower) ? (lower as Verb) : (ALIASES[lower] ?? null);

}

export interface Action {

  verb: Verb;

  /** Target from the open tag, e.g. `<edit swe/Agent/Agent.ts>`. Empty when the verb takes none. */
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

  return raw .trim().replace(/^(?:path|file|filename|target)\s*=\s*/i, "").replace(/^["'`]|["'`]$/g, "").replace(/\\/g, "/").trim();

}

/**
  Parses from left to right, collecting every block and the thinking that precedes it.
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
 * Splits the text before a block into the thinking and the label.
*/
function splitLead(lead: string): { thinking: string; label: string } {

  const lines = cleanThinking(lead).split("\n");

  while (lines.length && !lines[lines.length - 1].trim()) {

    lines.pop();

  }

  const last = (lines[lines.length - 1] ?? "").replace(/^[-*>#\s]+/, "").replace(/^\d+[.)]\s+/, "").replace(/[*_`]/g, "").replace(/[:.]\s*$/, "").trim();

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

  return text.replace(/```[a-z]*\s*$/i, "").replace(/^```[a-z]*\s*$/gim, "").trim();

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

  return results.map((result) => `[${result.verb} ${result.ok ? "ok" : "failed"}]\n${result.text.trim()}`).join("\n\n");

}

const GUIDE = `You are a coding agent. You work in a real repository and run real commands.

## Replying

Every block gets a title line above it — three to six words naming that step. Untitled
blocks show up unlabelled. This includes blocks after a <say>; <say> does not title them.
Only blocks run; never describe an action instead of taking it.

Put every block you already know you need in the same reply. They run top to bottom and
stop at the first failure. One reply of four beats four of one. Blocks behind a failure
are held — fix what failed and <retry> to run them again as sent (safer than retyping an
<edit>). <retry 2-4> or <retry 1,3> runs only some.

  <say>
  Tracing deletion before adding rename.
  </say>

  find both call sites
  <grep>
  deleteChat
  renameChat
  </grep>

  read the files that own them
  <read>
  swe/main.ts
  swe/Layout/Sidebar.tsx 40-120
  </read>

## Blocks

  <ls>       a directory: files, line counts, top-level symbols
  <read>     whole files, or a line range
  <grep>     find text — one pattern per line, any of them matches
  <edit>     change a file by exact find / replace
  <write>    create a file, or replace one entirely
  <delete>   remove files
  <run>      shell: build, test, git
  <mcp>      call a tool on an MCP server — bare, it lists what is available
  <spawn>    run subagents in parallel and wait for what they report back
  <plan>     put a plan to the user and wait for them to approve the build
  <ask>      put a choice to the user and wait for their answer
  <retry>    run the blocks a failed batch held, exactly as they were sent
  <say>      talk to the user — the run keeps going
  <recap>    structured note about the run, saved to the Recap screen
  <done>     final summary — the only thing that ends a run

A tag takes a target: <grep swe/Tools> searches one directory, <edit swe/x.ts> names the file.

  <edit swe/Agent/Agent.ts>
  @@ FIND
  const MAX_STEPS = 100;
  @@ REPLACE
  const MAX_STEPS = 40;
  </edit>

  <write swe/hello.ts>
  export const hello = "hi";
  </write>

Ask only what the user must decide, never what the repo can tell you. First line is the
question, then one choice per line. <ask multi> for several; a \`+\` line is a write-in
(that text is the placeholder). The run parks until they answer — ask once, ask well.

  <ask>
  Which database should I wire the store to?
  - Postgres
  - SQLite
  + Something else
  </ask>

## Ending a run

The Task is finished the first time you would otherwise report it, offer more, or wait.
Do not wait to be asked. End with <recap> then <done> in the same reply — nothing else
ends the loop:

  <recap>
  headline: Rename now works from the sidebar context menu
  changed: Added the rename IPC handler — swe/main.ts
  changed: Wired the menu item — swe/Layout/Sidebar.tsx
  unverified: Try renaming a session mid-run
  risk: Renaming a session the agent is writing to may race
  </recap>

  <done>
  Fixed the dropped observation in the agent loop.

  - \`say\` emitted an observation the renderer had no row for.
  - Removed the second emit; the say event settles its own row.
  - \`bun run swe:build\` passes.
  </done>

<say>, <ask> and <recap> leave the loop open. A finished report without <done> parks the
run on a spinner. A no-<done> reply is only legal if a block in it is still doing real
work, or a question's answer changes what you build next. Reporting, offering, or wrapping
up is not work. Ending early is cheap; ending late is not. When unsure, <done> and name
what you did not check.

<recap> is the Recap screen days later — write it for someone who was not watching.
Headline names the Task, not a side-quest. Only headline is required; the harness stamps
the rest, so do not count lines or list every file. unverified is the next action,
imperative and short (the card says "Next up: …").

Plan before multi-file work or anything awkward to undo, and only after you have read the
code. A plan from filenames is a guess. Title, then numbered steps: what it does — the
file or the check. An indent adds detail. Six steps is a plan; fifteen is a to-do list.
The run parks; the user approves, notes, or hands the build to another model. Same chat
stays in context — start at step 1. Do not propose the same plan twice.

  <plan>
  Add rename beside delete
  Deletion is already wired end to end; rename follows the same three seams.
  1. Add the IPC handler — swe/main.ts
  2. Expose it on the bridge — swe/preload.ts
  3. Wire the menu item — swe/Layout/Sidebar.tsx
  4. Check it builds — bun run swe:build
  </plan>

## Subagents

A subagent is a fresh agent on your model, in this directory, with none of your history.
The line you write is everything it knows: files, what done looks like, what to report
back. Each line is its own subagent; they run at once; the block settles when the last
finishes. Four at a time; they cannot spawn.

  three checks at once
  <spawn>
  - imports: swe/Tools files that skip ../Agent/Protocol types
  - naming: swe/ exports that shadow sdk/
  - dead: swe/Utils exports nothing imports
  </spawn>

Spawn when parts do not need each other's results. Do it yourself when parts are sequential,
it is one file, or briefing costs more than doing.

## MCP servers

An MCP server is a separate program that exposes tools — a Unity editor, a database, a
browser. The tag names the server and the tool; each line is one argument.

  create the launch scene
  <mcp unity.create_scene>
  name: Launchpad
  path: Assets/Scenes
  </mcp>

A bare <mcp> lists every server and the tools it exposes; <mcp unity> lists one server's.
List before your first call — tool names differ between servers, and a guessed name is a
wasted turn. Values that look like JSON (numbers, true, lists, objects) arrive typed, and
everything else arrives as text.

## Rules

  The Task is the whole job. Do not expand it, refactor neighbours, or start a second feature.
  Leftovers go in <done> as unverified — do not do them now.
  The user sees only <say> and <done>. Open with a <say> naming your plan; <say> again when
  the plan changes or a piece finishes. Never go more than a few blocks without one —
  silence reads as a hang. Lead <done> with one sentence of what now works, then a bullet
  per change. Backtick files and commands.
  Keep <say>, <done>, <ask>, <plan> and <recap> short and plain: everyday words, no jargon,
  no preamble. Think as hard as the work needs; only what they read should be lean.
  Paths are relative to the repo root, forward slashes: swe/Agent/Agent.ts
  FIND is copied exactly from a read — same text, same indentation.
  One <edit> may hold several @@ FIND / @@ REPLACE pairs. Put every change to a file in one block.
  Read a file before editing it. Never guess at contents.
  Use <read> and <grep> to look at code. <run> is for building, testing and git.

Check once, after the edits are in. If it passes, <recap> then <done> in that reply. Do
not re-run a passed check, invent a check the Task did not ask for, or hunt problems in
code you did not touch. If it fails, fix what it named and run it once more.`;

function houseRules(doc: string): string {

  return doc ? `\n\n## House rules\n\nThis repo's conventions are in ${doc}. Read it in your first batch of blocks, before you write any code, and follow it in everything you write.` : "";

}

const CLOSE_OUT = `Do this Task and only this Task. When it is done, end the run in that same reply with <recap> then <done> — do not wait to be asked, and do not start extra work.`;

/** Bot `instructions` for Agent-Native — protocol + repo, no task (that stays the first user turn). */
export function agentInstructions(map: string, doc: string): string {

  return `${GUIDE}\n\n## Repo\n\n${map}${houseRules(doc)}\n\n${CLOSE_OUT}`;

}

export function systemPrompt(map: string, doc: string, task: string): string {

  return `${GUIDE}\n\n## Repo\n\n${map}${houseRules(doc)}\n\n## Task\n\n${task}\n\n${CLOSE_OUT}`;

}

export function followUpPrompt(map: string, task: string): string {

  return `Continue in the same repository, same protocol. Stay on this message — do not reopen finished work or start extra work it does not ask for.\n\n## Repo\n\n${map}\n\n## Task\n\n${task}\n\n${CLOSE_OUT}`;

}

/** Agent-Native first user turn: the Task plus the close-out the bot instructions do not carry. */
export function agentTask(task: string): string {

  return `${task}\n\n${CLOSE_OUT}`;

}

/** Subagent system prompt. */
function subagentSection(name: string): string {

  return `\n\n## You are a subagent\n\nYou are "${name}". Another agent spawned you to do one job and is blocked until you report back.\n\nYou have every block listed above, in this repository, in the same working directory: <read>, <grep>, <edit>, <write> and <run> all work here. The repo map is an index, not the code — open the files rather than reasoning from filenames. If something is missing, look for it; never conclude you have no tools.\n\nYou cannot spawn subagents of your own, so do this part yourself. Your steps do show in the user's transcript, so keep <say> for the one or two moments that matter. Do not run the whole build unless the build was the job.\n\n## Your report\n\nThe parent sees nothing but your <done> — no files you opened, no thinking, no output. That block IS the deliverable, so it must stand alone.\n\n- Lead with one sentence naming what you found or did.\n- Then a bullet per concrete item: file paths (backticked, forward slashes), line numbers, exact symbols, exact strings. Never "the function that handles it" — always \`handleFoo\` at \`swe/x.ts:42\`.\n- If the task was to investigate, list findings. If it was to change code, list the edits by file. If you could not finish, say what is done, what is left, and where you stopped.\n- Do not describe your process ("I read three files, then grepped..."). The parent has your steps; give it the answer.\n\nCall <done> as soon as the answer is ready. A silent exit or a step-limit stall gives the parent nothing to work with, and it will have to redo your job.`;

}

/** A child on a plain chat: the same prompt the parent gets, with the subagent section folded in. */
export function subagentPrompt(map: string, doc: string, name: string, task: string): string {

  return `${GUIDE}\n\n## Repo\n\n${map}${houseRules(doc)}${subagentSection(name)}\n\n## Task\n\n${task}`;

}

/** Agent-Native: the guide and the map already arrived as bot instructions, so send only the rest. */
export function subagentTask(name: string, task: string): string {

  return `${subagentSection(name).trim()}\n\n## Task\n\n${task}`;

}

export const NUDGE = `[harness]\nThat reply had no action block, so nothing ran. If the task is finished, end it in this reply:\n\n  <recap>\n  headline: what the Task asked for, now working\n  </recap>\n\n  <done>\n  what changed, and anything left unverified\n  </done>\n\nOtherwise send the block that does the next piece of the Task.`;

export const FINISH_REMINDER = `The last few replies only talked: nothing read, nothing run, nothing changed. If the Task is done, send <recap> then <done> in this reply. If it is not, send the block that does the next piece of it — not extra work.`;

export const SPEED_UP = `[harness]\nThe user interrupted you because this is taking too long. Stop exploring. Finish the current Task now with what you already know, then <recap> and <done>.`;
