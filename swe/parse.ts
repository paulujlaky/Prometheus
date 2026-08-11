/**
 * Single protocol parser for mini-swe replies.
*/

export const FINISHED = "MINI_SWE_FINISHED";

/** Only `desc:` — keeps the surface tiny so the model cannot invent alternate labels. */
const DESC_LINE = /^desc\s*:\s*(.+)$/i;

// opening fence with optional shell language
const FENCE_OPEN = /```[ \t]*(?:bash|sh|shell)?[ \t]*\r?\n/i;
const FENCE_OPENING_PARTIAL = /```[ \t]*(?:bash|sh|shell)?[ \t]*$/im;
const PARTIAL_FENCE = /(^|\n)[ \t]*`{1,3}[a-zA-Z]*$/;

export interface ParsedReply {

  desc: string;
  thinking: string;

  command: string | null;
  hasFence: boolean; // indicates whether the reply contains a fenced code block (even if incomplete)

}

/** Label + optional thinking from text before the bash fence. */
export function parseLeading(leading: string): { desc: string; thinking: string } {

  const raw = leading.replace(PARTIAL_FENCE, "").trim();

  if (!raw) {

    return { desc: "", thinking: "" };

  }

  const think: string[] = [];
  let desc = "";

  for (const line of raw.split(/\r?\n/)) {

    const match = DESC_LINE.exec(line.trim());

    if (match) {

      desc = match[1].replace(/\s+/g, " ").trim();
      continue;

    }

    think.push(line);

  }

  const thinking = think.join("\n").trim();

  if (desc) {

    return { desc, thinking };

  }

  // no `desc:` yet — do not promote monologue into the title (UI shows Working… until classifier arrives)
  return { desc: "", thinking: raw };

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

    const { desc, thinking } = parseLeading(text.slice(0, partial.index));

    return { desc, thinking, command: "", hasFence: true };

  }

  const { desc, thinking } = parseLeading(text);

  return { desc, thinking, command: null, hasFence: false };

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

  const { desc, thinking } = parseLeading(text.slice(0, fenceIndex));
  const command = body.trim();

  return {

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

export function extractFinishedSummary(output: string): string | null {

  const index = output.indexOf(FINISHED);

  if (index === -1) {

    return null;

  }

  const line = (output.slice(index + FINISHED.length).split(/\r?\n/, 1)[0] ?? "").replace(/^[:\s|-]+/, "").trim();

  return line || "Task complete.";

}

export function cleanSummary(text: string): string {

  let s = text.trim();

  s = s.replace(new RegExp(`^${FINISHED}[:\\s|-]*`, "i"), "");
  s = s.replace(/```[\s\S]*$/g, "").trim();
  s = s.replace(/\s+/g, " ");

  return s || "Task complete.";

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
