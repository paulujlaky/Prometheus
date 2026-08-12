import type { ToolCall, ToolResult, ToolSpec } from "./types";

const FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

/** Prompt fragment: JSON-only replies. Boodle still carries this as PlainText. */
export function formatToolsPrompt(tools: ToolSpec[]): string {

  const lines = [
    "Reply with one JSON object. Optional prose before it is thinking; nothing after.",
    "{\"tool\":\"<name>\",\"label\":\"≤8 words\",\"args\":{}}",
    "",
    "Tools:",
  ];

  for (const tool of tools) {

    const schema = tool.parameters ? ` ${JSON.stringify(tool.parameters)}` : "";

    lines.push(`- ${tool.name}: ${tool.description}${schema}`);

  }

  return lines.join("\n");

}

export function formatToolResults(results: ToolResult[]): string {

  return JSON.stringify(
    {
      results: results.map((result) => ({

        tool: result.tool,
        ok: result.ok,
        content: result.content,

      })),
    },
    null,
    2,
  );

}

/** Pull complete tool calls out of answer text. Incomplete JSON → []. */
export function parseToolCalls(text: string): ToolCall[] {

  const raw = extractJson(text);

  if (raw == null) {

    return [];

  }

  return normalizeCalls(raw);

}

function extractJson(text: string): unknown {

  const trimmed = text.trim();

  if (!trimmed) {

    return null;

  }

  const fenced = FENCE.exec(trimmed);

  if (fenced) {

    const body = fenced[1].trim();

    return tryParse(body) ?? tryParse(repairJson(body));

  }

  const start = trimmed.search(/\{\s*"/);

  if (start === -1) {

    return null;

  }

  const slice = takeObject(trimmed.slice(start));

  return tryParse(slice) ?? tryParse(repairJson(slice));

}

function takeObject(text: string): string {

  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = 0; i < text.length; i += 1) {

    const ch = text[i];

    if (inStr) {

      if (esc) {

        esc = false;
        continue;

      }

      if (ch === "\\") {

        esc = true;
        continue;

      }

      if (ch === "\"") {

        inStr = false;

      }

      continue;

    }

    if (ch === "\"") {

      inStr = true;
      continue;

    }

    if (ch === "{") {

      depth += 1;
      continue;

    }

    if (ch === "}") {

      depth -= 1;

      if (depth === 0) {

        return text.slice(0, i + 1);

      }

    }

  }

  return text;

}

/** Models often put real newlines inside JSON strings (especially edit old/new). */
function repairJson(text: string): string {

  let out = "";
  let inStr = false;
  let esc = false;

  for (const ch of text) {

    if (inStr) {

      if (esc) {

        out += ch;
        esc = false;
        continue;

      }

      if (ch === "\\") {

        out += ch;
        esc = true;
        continue;

      }

      if (ch === "\"") {

        inStr = false;
        out += ch;
        continue;

      }

      if (ch === "\n") {

        out += "\\n";
        continue;

      }

      if (ch === "\r") {

        continue;

      }

      if (ch === "\t") {

        out += "\\t";
        continue;

      }

      out += ch;
      continue;

    }

    if (ch === "\"") {

      inStr = true;

    }

    out += ch;

  }

  return out;

}

function tryParse(text: string): unknown {

  try {

    return JSON.parse(text);

  } catch {

    return null;

  }

}

function normalizeCalls(raw: unknown): ToolCall[] {

  if (Array.isArray(raw)) {

    return raw.flatMap(asCall);

  }

  if (!raw || typeof raw !== "object") {

    return [];

  }

  const obj = raw as Record<string, unknown>;

  if (Array.isArray(obj.calls)) {

    return obj.calls.flatMap(asCall);

  }

  return asCall(obj);

}

function asCall(value: unknown): ToolCall[] {

  if (!value || typeof value !== "object") {

    return [];

  }

  const obj = value as Record<string, unknown>;
  const name = typeof obj.tool === "string" ? obj.tool : typeof obj.name === "string" ? obj.name : "";

  if (!name) {

    return [];

  }

  const label = typeof obj.label === "string"
    ? obj.label
    : typeof obj.desc === "string"
      ? obj.desc
      : undefined;

  const args = "args" in obj ? obj.args : obj.arguments ?? obj.input ?? {};

  return [{ tool: name, label, args }];

}
