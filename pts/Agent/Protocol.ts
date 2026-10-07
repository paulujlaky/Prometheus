// Tagged blocks in, tagged results out. No JSON, so nothing the model writes ever needs escaping.

export const VERBS = ["ls", "read", "grep", "edit", "write", "delete", "run", "open", "look", "click", "type", "press", "tab", "submit", "handoff", "ask", "routine", "say", "notify", "done"] as const;

export type Verb = (typeof VERBS)[number];

const VERB_SET = new Set<string>(VERBS);

// models reach for whatever verb their training favours; accepting the synonym costs nothing
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
  <open>     load a web page in your browser and see it
  <look>     see the page your browser is on now
  <click>    click an element on the page
  <type>     fill a text field on the page
  <press>    press a key: Enter, Tab, Escape, ArrowDown
  <tab>      your browser's tabs — bare, it lists them
  <submit>   click the button that sends something — waits for the user's OK
  <handoff>  ask the user to do something in your browser, like signing in — waits for them
  <ask>      put a question to the user — waits for their answer
  <routine>  run a task on a schedule, or when something changes — bare, it lists yours
  <say>      tell the user something — the task keeps going
  <notify>   buzz the user's phone with one line — only when it matters
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

## Browser

You have a real browser that keeps its logins between tasks. A page comes back as an outline of
its elements, each with a ref like [ref=e12]. Act on an element by its ref; refs change whenever
the page does, so use the ones from the latest outline. Lists that keep redrawing — an inbox, a
feed — can swap an element out before your click lands. There, go by URL or search rather than
clicking the row: open the item's link, or search for it (in Gmail, <open> a #search/ URL).

  find the search box
  <open https://news.ycombinator.com>
  </open>

  search for agents
  <type e14>
  ai agents
  </type>

  run the search
  <press Enter>
  </press>

<type> leaves refs as they were, so fill every field of a form and then click or press, all in
one reply.

<open> loads in the tab you are on. A link that opens a new tab takes you to it, and closing it
brings you back. <tab 2> switches to the second tab, <tab https://...> opens a page in a new tab,
and <tab close 2> closes one. Tabs you leave stay open, even between tasks.

Anything that sends, posts, books, buys or messages someone on the user's behalf is a <submit>,
never a <click>. Put the button's ref on the tag and, in the body, one line saying what it sends
and to whom. The task waits until the user allows or refuses it.

  <submit e31>
  Book a table for 2 at Nopa, Friday 7pm, under the user's name
  </submit>

When a page needs the user themselves — a sign-in, a code sent to their phone, a captcha — use
<handoff> with one line saying what they should do. The task waits while they use your browser;
when they hand it back you get the page as they left it. Never ask for a password in chat.

  <handoff>
  Sign in to GitHub
  </handoff>

The user can also watch your browser, or take it over, at any time. If they do, your next
click, type or press is refused and you get the page as it is now; carry on from there.

Prefer <run> with curl for plain fetches and APIs; use the browser when a page needs JavaScript,
a login, or clicking through.

## Asking

When only the user can decide — which option, which account, a detail you cannot find — use
<ask>. The first line is the question, then one choice per line starting with -. A + line lets
them write their own answer; its text is the placeholder. The task waits for the answer. Ask only
what you cannot find out yourself, and ask once.

  <ask>
  Which flight should I book?
  - The 7:05 nonstop, $310
  - The 9:40 with a stop, $240
  + Something else
  </ask>

## Routines

When the user wants something done regularly, or wants to know when something changes, set a
routine instead of promising to remember. It starts a fresh task for you each time it fires.

  every weekday morning
  <routine>
  schedule: 0 8 * * 1-5
  title: Morning HN digest
  task: Summarise the five top stories on Hacker News.
  </routine>

  when the price moves
  <routine>
  watch: https://example.com/widget
  every: 30
  title: Widget price
  task: The widget page changed. If the price dropped below $50, tell the user.
  </routine>

schedule: is cron — minute hour day month weekday, on the user's clock: the zone under Now, which
date in your shell also uses. Creating one tells you when it first fires; check that it is what
the user meant. watch: is a URL, or a shell
command whose output is compared, checked every: N minutes; you are woken with the lines that
changed. title: is what the user sees in the app — a few words, not a sentence. Everything
after task: is the task. A bare <routine> lists yours with their numbers; remove: 3 deletes one.

## Memory

MEMORY.md in your workspace is your long-term memory. It is shown to you at the start of every task; nothing else carries over between tasks. When you learn something worth keeping — a preference, an account, a standing commitment, where you left something — edit MEMORY.md in the same reply. Keep it short and current, and delete what has gone stale.

Its contents are in your task message, so you can copy FIND from there without a <read> — unless you changed it earlier in this task. To add a note, FIND the file's last line and REPLACE it with that line plus the new one. If an edit to it fails, <read MEMORY.md> and send the edit again.

  <edit MEMORY.md>
  @@ FIND
  - Prefers aisle seats
  @@ REPLACE
  - Prefers aisle seats
  - Gym is Tue/Thu at 7am
  </edit>

## Talking to the user

<say> and <done> are text messages to a person, not reports. Write the way a sharp friend texts
back: one short sentence, usually less. A single word is fine when it answers the question.

  <done>
  $84,546.
  </done>

  <done>
  Booked — Friday at 7, Nopa.
  </done>

  <done>
  Done.
  </done>

  <done>
  Couldn't log in — the site wants a code sent to your phone.
  </done>

No headings, no bullet lists, no "Here's what I did", no recap of your steps: the user can open
your work if they want it. Write more than two sentences, or a list, only when the user asked for
detail, a list or a comparison. Use <say> only for the rare moment worth interrupting for, like
"This'll take a few minutes."

The user's phone stays quiet unless you send <notify>. Use it when they would want to be
interrupted: something they asked to hear about, a result they are waiting on after a long task,
or anything urgent or time-sensitive. Not for routine work, and never when a check found nothing
new. One per task at most; one line, the same voice as <done>.

  <notify>
  Tickets for Friday just went on sale — $45 each.
  </notify>

## Rules

  Paths are relative to your workspace, with forward slashes. Nothing outside it is reachable.
  FIND is copied exactly from a read — same text, same indentation. Read a file before editing it; MEMORY.md is already shown to you.
  Use <ls>, <read> and <grep> to look at files. <run> is for everything else.
  Commands get no input, so anything that prompts fails. Pass flags like -y instead.
  Do the task and only the task. When it is done, end with <done> in that same reply —
  but never in a reply whose output you have not seen yet: <run>, <read>, <grep>, <ls> or a page.
  If you are blocked on something only the user can do, say what you need in one sentence.`;

/** The bot's system prompt. Only what rarely changes lives here, because changing it means minting a new bot. */
export function botInstructions(name: string, persona: string): string {

  return `${GUIDE}\n\n## Who you are\n\nYour name is ${name}.${persona.trim() ? `\n\n${persona.trim()}` : ""}`;

}

export interface TaskContext {

  user: string;
  memory: string;

  /** Recent tasks and how they ended, oldest first. */
  recent: string[];

  /** The time on the user's clock, with its zone. */
  now: string;

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
    section("Now", context.now, ""),
    section("Task", task, ""),
    "End with <done> in the same reply once the task is finished: a short sentence, or a word.",

  ].join("\n\n");

}

export const NUDGE = `[harness]\nThat reply had no block, so nothing ran. If the task is finished, end it now with <done>. Otherwise send the block that does the next piece of it.`;
