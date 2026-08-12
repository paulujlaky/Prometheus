// Single protocol parser for mini-swe replies.

export const FINISHED = "MINI_SWE_FINISHED";

/** Closed vocabulary: the label key doubles as the tool type the UI renders. */
export const TOOLS = ["read", "search", "write", "edit", "run", "test", "fix", "think", "done"] as const;

export type Tool = (typeof TOOLS)[number];

const TOOL_LINE = new RegExp(`^(${TOOLS.join("|")})\\s*:\\s*(.+)$`, "i");

// pre-classifier protocol; still parsed so archived chats keep replaying
const DESC_LINE = /^desc\s*:\s*(.+)$/i;

// opening fence with optional shell language
const FENCE_OPEN = /```[ \t]*(?:bash|sh|shell)?[ \t]*\r?\n/i;
const FENCE_OPENING_PARTIAL = /```[ \t]*(?:bash|sh|shell)?[ \t]*$/im;
const PARTIAL_FENCE = /(^|\n)[ \t]*`{1,3}[a-zA-Z]*$/;

export interface ParsedReply {

  /** Preset classifier from the label line; null until it arrives (or on legacy `desc:`). */
  tool: Tool | null;

  desc: string;
  thinking: string;

  command: string | null;
  hasFence: boolean; // indicates whether the reply contains a fenced code block (even if incomplete)

}

/** Label + optional thinking from text before the bash fence. */
export function parseLeading(leading: string): { tool: Tool | null; desc: string; thinking: string } {

  const raw = leading.replace(PARTIAL_FENCE, "").trim();

  if (!raw) {

    return { tool: null, desc: "", thinking: "" };

  }

  const think: string[] = [];

  let tool: Tool | null = null;
  let desc = "";

  for (const line of raw.split(/\r?\n/)) {

    const trimmed = line.trim();
    const classified = TOOL_LINE.exec(trimmed);

    if (classified) {

      tool = classified[1].toLowerCase() as Tool;
      desc = classified[2].replace(/\s+/g, " ").trim();

      continue;

    }

    const legacy = DESC_LINE.exec(trimmed);

    if (legacy) {

      desc = legacy[1].replace(/\s+/g, " ").trim();
      continue;

    }

    think.push(line);

  }

  const thinking = think.join("\n").trim();

  if (desc) {

    return { tool, desc, thinking };

  }

  // no label yet — do not promote monologue into the title (UI shows Working… until it arrives)
  return { tool: null, desc: "", thinking: raw };

}

/**
 * Parses a full model reply into desc / thinking / command.
*/
export function parseReply(text: string): ParsedReply {

  const open = FENCE_OPEN.exec(text);

  if (open) {

    return finishFence(text, open.index, open[0].length);

  }

  // mid-stream: ```bash with no body newline yet
  const partial = FENCE_OPENING_PARTIAL.exec(text);

  if (partial) {

    const { tool, desc, thinking } = parseLeading(text.slice(0, partial.index));

    return { tool, desc, thinking, command: "", hasFence: true };

  }

  const { tool, desc, thinking } = parseLeading(text);

  return { tool, desc, thinking, command: null, hasFence: false };

}

function finishFence(text: string, fenceIndex: number, openLen: number): ParsedReply {

  const bodyStart = fenceIndex + openLen;
  const rest = text.slice(bodyStart);
  const close = rest.indexOf("```");

  let body = close === -1 ? rest : rest.slice(0, close);
  const trailing = close === -1 ? "" : rest.slice(close + 3).trim();

  // if a heredoc embeds ```, grow to the last fence that closes all heredocs
  if (close !== -1 && incompleteReason(body.trim())) {

    const last = rest.lastIndexOf("```");

    if (last > close) {

      const extended = rest.slice(0, last).trim();

      if (!incompleteReason(extended)) {

        body = rest.slice(0, last);

      }

    }

  }

  const { tool, desc, thinking } = parseLeading(text.slice(0, fenceIndex));
  const command = body.trim();

  return {

    tool,
    desc,
    thinking: [thinking, trailing].filter(Boolean).join("\n\n").trim(),
    command: command || null,
    hasFence: true,

  };

}

/** Unterminated here-document → block was cut off. */
export function incompleteReason(command: string): string | null {

  const pending: string[] = [];

  for (const line of command.split(/\r?\n/)) {

    if (pending.length) {

      if (line.trim() === pending[pending.length - 1]) {

        pending.pop();

      }

      continue;

    }

    const opener = /<<-?\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/.exec(line);

    if (opener) {

      pending.push(opener[1] ?? opener[2] ?? opener[3]);

    }

  }

  return pending.length ? `the here-document <<${pending[pending.length - 1]} is never closed` : null;

}

/** Bash body only — null when no usable fence. */
export function extractCommand(reply: string): string | null {

  const { command, hasFence } = parseReply(reply);

  if (!hasFence || command == null || !command) {

    // unclosed fence: still return body so incompleteReason can flag it
    const open = FENCE_OPEN.exec(reply);

    if (open) {

      const body = reply.slice(open.index + open[0].length);
      const close = body.indexOf("```");
      const raw = (close === -1 ? body : body.slice(0, close)).trim();

      return raw || null;

    }

    return null;

  }

  if (!incompleteReason(command)) {

    return command;

  }

  // heredoc with embedded fences; re-scan if needed
  return command;

}

const REDIRECT = /(?:^|[|;&]\s*)(?:cat|tee)\s*>>?\s*['"]?([^\s'"|;&<]+)/m;

// first match wins, so order matters: `git apply` is an edit before it is a run
const INFERRED: [RegExp, Tool][] = [

  [new RegExp(FINISHED), "done"],
  [/^\s*(apply_patch|sg\b|git\s+apply)/m, "edit"],
  [/^\s*cat\s*>/m, "write"],
  [/^\s*(rg|grep|find|ag|ack)\b/m, "search"],
  [/^\s*(cat|head|tail|less|ls|wc|stat|file)\b/m, "read"],
  [/\b(test|jest|vitest|pytest|tsc|eslint|lint)\b/, "test"],

];

/** Icon type for a step whose reply skipped the classifier (or replays from a legacy `desc:` chat). */
export function inferTool(command: string | null): Tool {

  if (!command) {

    return "think";

  }

  for (const [pattern, tool] of INFERRED) {

    if (pattern.test(command)) {

      return tool;

    }

  }

  return "run";

}

export type WriteKind = "add" | "update" | "delete";

export interface WriteLine {

  text: string;
  kind: "add" | "remove" | "context" | "gap";

}

export interface FileWrite {

  file: string;
  kind: WriteKind;

  added: number;
  removed: number;

  /** Full content for an add, the patch hunks for an update. */
  lines: WriteLine[];

}

export interface FileEdit {

  file: string;

  added: number;
  removed: number;

}

const PATCH_SECTION = /^\*\*\*\s*(Add|Update|Delete)\s+File:\s*(.+)$/;
const DIFF_HEADER = /^\+\+\+\s+(?:b\/)?(.+)$/;
const HEREDOC_OPEN = /<<-?\s*['"]?(\w+)['"]?/;

/**
 * The code the agent actually wrote, parsed from the command itself.
*/
export function parseWrites(command: string): FileWrite[] {

  const writes: FileWrite[] = [];
  const lines = command.split(/\r?\n/);

  const open = (file: string, kind: WriteKind): FileWrite => {

    const existing = writes.find((write) => write.file === file);

    if (existing) {

      return existing;

    }

    const write: FileWrite = { file: file.trim(), kind, added: 0, removed: 0, lines: [] };

    writes.push(write);

    return write;

  };

  // `cat > 'file' <<'EOF'` — the heredoc body is the file's new content verbatim
  const redirect = REDIRECT.exec(lines[0] ?? "");
  const heredoc = HEREDOC_OPEN.exec(lines[0] ?? "");

  if (redirect && heredoc) {

    const write = open(redirect[1], "add");

    for (const line of lines.slice(1)) {

      if (line.trim() === heredoc[1]) {

        break;

      }

      write.lines.push({ text: line, kind: "add" });
      write.added += 1;

    }

    return writes;

  }

  let current: FileWrite | null = null;

  for (const line of lines) {

    const section = PATCH_SECTION.exec(line);

    if (section) {

      const kind = section[1].toLowerCase() as WriteKind;

      current = open(section[2], kind);
      current.kind = kind;

      continue;

    }

    const header = DIFF_HEADER.exec(line);

    if (header) {

      current = open(header[1], "update");
      continue;

    }

    if (!current || line.startsWith("---") || line.startsWith("+++")) {

      continue;

    }

    // hunk boundary: a visual break, not content
    if (line.startsWith("@@")) {

      if (current.lines.length) {

        current.lines.push({ text: "", kind: "gap" });

      }

      continue;

    }

    if (line.startsWith("+")) {

      current.lines.push({ text: line.slice(1), kind: "add" });
      current.added += 1;

      continue;

    }

    if (line.startsWith("-")) {

      current.lines.push({ text: line.slice(1), kind: "remove" });
      current.removed += 1;

      continue;

    }

    if (line.startsWith(" ")) {

      current.lines.push({ text: line.slice(1), kind: "context" });

    }

  }

  // a trailing gap is the End Patch marker, not a break between hunks
  for (const write of writes) {

    while (write.lines[write.lines.length - 1]?.kind === "gap") {

      write.lines.pop();

    }

  }

  return writes.filter((write) => write.kind === "delete" || write.lines.length > 0);

}

/** Per-file line counts, for the run summary chips. */
export function fileEdits(command: string): FileEdit[] {

  return parseWrites(command).map(({ file, added, removed }) => ({ file, added, removed }));

}

/**
 * Detect a real session-end signal — not prose/docs that merely mention the marker.
 *
 * Accepts:
 *  1) Shell stdout: a line that *begins* with MINI_SWE_FINISHED (what `echo` prints)
 *  2) A done-step command: `echo "MINI_SWE_FINISHED: …"` (any summary length)
 *
 * Rejects mid-line mentions in sticky protocol / seed examples, which used to end
 * sessions early and paint a false "done" when replaying chats.
 */
export function extractFinishedSummary(output: string): string | null {

  if (!output || !output.includes(FINISHED)) {

    return null;

  }

  // 1) Real echo output — marker must start the line (may be multi-line summary; take rest of line)
  const lineRe = new RegExp(`(?:^|\\r?\\n)[ \\t]*${FINISHED}\\s*:?\\s*([^\\r\\n]*)`);
  const lineMatch = lineRe.exec(output);

  if (lineMatch) {

    const summary = (lineMatch[1] ?? "").replace(/^["']|["']$/g, "").trim();

    return summary || "Task complete.";

  }

  // 2) Done-step command: whole string is `echo …FINISHED…` (history + empty-stdout recovery).
  // No length cap — real finish summaries are often long. Sticky/docs never start with `echo`.
  const cmd = output.trim();

  if (!/^echo\b/i.test(cmd) || /^Exit code:/m.test(cmd) || /\bProtocol\b/.test(cmd)) {

    return null;

  }

  // echo "MINI_SWE_FINISHED: …" | echo '…' | echo MINI_SWE_FINISHED: …
  // Allow any summary length; strip a single matching trailing quote if present.
  const echoHead = new RegExp(`^echo\\s+(["']?)${FINISHED}\\s*:\\s*`, "i");
  const head = echoHead.exec(cmd);

  if (!head) {

    return null;

  }

  const quote = head[1] ?? "";
  let rest = cmd.slice(head[0].length);

  if (quote && rest.endsWith(quote)) {

    rest = rest.slice(0, -1);

  } else {

    rest = rest.replace(/["']\s*;?\s*$/, "");

  }

  const summary = rest.replace(/\s*;\s*$/, "").trim();

  return summary || "Task complete.";

}

export function cleanSummary(text: string): string {

  let s = text.trim();

  s = s.replace(new RegExp(`^${FINISHED}[:\\s|-]*`, "i"), "");
  s = s.replace(/```[\s\S]*$/g, "").trim();
  s = s.replace(/\s+/g, " ");

  s.endsWith('"') && (s = s.slice(0, -1).trim()); // replace trailing quote from `echo "Task complete."` in a finished bash block

  return s || "Task complete.";

}

/**
 * When the model tries to finish with the wrong marker (TASK_COMPLETE, DONE, …)
 * or label done: without the real echo — return a short resend instruction.
 * null when this does not look like a botched finish attempt.
 */
export function wrongFinishHint(command: string | null, output: string, tool: Tool | null): string | null {

  if (extractFinishedSummary(output) || (command && extractFinishedSummary(command))) {

    return null;

  }

  const cmd = (command ?? "").trim();
  const out = (output ?? "").trim();
  const isDoneLabel = tool === "done";

  // echo SOME_OTHER_TOKEN: summary  (or quoted)
  const echoToken = /^\s*echo\s+["']?([A-Za-z][A-Za-z0-9_]{2,})\s*:/.exec(cmd);
  const outToken = /(?:^|\n)\s*([A-Za-z][A-Za-z0-9_]{2,})\s*:/.exec(out);

  const bogus = echoToken?.[1] && echoToken[1] !== FINISHED
    ? echoToken[1]
    : outToken?.[1] && outToken[1] !== FINISHED && isDoneLabel
      ? outToken[1]
      : null;

  if (!bogus && !isDoneLabel) {

    return null;

  }

  if (!bogus && isDoneLabel && !/^echo\b/i.test(cmd)) {

    return [
      `Label done: was used, but the shell must print the exact marker ${FINISHED}.`,
      "Resend EXACTLY (nothing else in the fence):",
      `done: task complete`,
      "```bash",
      `echo "${FINISHED}: <one-line summary>"`,
      "```",
    ].join("\n");

  }

  if (!bogus) {

    return null;

  }

  return [
    `Wrong finish marker "${bogus}". The runner only stops when stdout contains a line that starts with ${FINISHED}.`,
    "Do not invent TASK_COMPLETE, DONE, or similar. Resend EXACTLY:",
    `done: task complete`,
    "```bash",
    `echo "${FINISHED}: <one-line summary>"`,
    "```",
  ].join("\n");

}

/** User task from the harness system prompt or a short plain message. */
export function extractTaskText(text: string): string | null {

  const trimmed = text.trim();

  if (!trimmed) {

    return null;

  }

  const taskLine = /\nTask:\s*([\s\S]+)$/m.exec(trimmed);

  if (taskLine) {

    return taskLine[1].trim();

  }

  if (/^Task:\s*/i.test(trimmed)) {

    return trimmed.replace(/^Task:\s*/i, "").trim();

  }

  if (trimmed.length < 2000 && !trimmed.includes("You are a coding agent")) {

    return trimmed;

  }

  return null;

}
