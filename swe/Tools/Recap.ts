import type { Action } from "../Agent/Protocol";
import type { RecapDraft } from "../Types/Recap";

type Field = "headline" | "changed" | "unverified" | "risk";

// models reach for the neighbouring word as often as the exact one
const FIELDS: Record<string, Field> = {

  headline: "headline",
  title: "headline",
  what: "headline",

  changed: "changed",
  changes: "changed",
  change: "changed",
  did: "changed",
  work: "changed",

  unverified: "unverified",
  next: "unverified",
  "next up": "unverified",
  unchecked: "unverified",
  untested: "unverified",
  left: "unverified",
  remaining: "unverified",
  todo: "unverified",

  risk: "risk",
  risks: "risk",
  caveat: "risk",
  caveats: "risk",
  warning: "risk",

};

const HEADER = /^\s*[-*•]?\s*([A-Za-z][A-Za-z ]{1,19}?)\s*:\s*(.*)$/;

function clean(line: string): string {

  return line.replace(/^\s*[-*•]\s+/, "").trim();

}

function push(draft: RecapDraft, field: Field, text: string): void {

  if (!text) {

    return;

  }

  if (field === "headline") {

    draft.headline = draft.headline ? `${draft.headline} ${text}` : text;

    return;

  }

  if (field === "risk") {

    draft.risk = draft.risk ? `${draft.risk} ${text}` : text;

    return;

  }

  draft[field].push(text);

}

/** Field lines in any order; anything unlabelled joins the field above it, or opens the headline. */
export function parseRecap(action: Action): RecapDraft {

  const draft: RecapDraft = { headline: "", changed: [], unverified: [], risk: "" };

  let field: Field | null = null;

  for (const raw of action.body.split("\n")) {

    const line = raw.trim();

    if (!line) {

      continue;

    }

    const header = HEADER.exec(line);
    const key = header ? FIELDS[header[1].trim().toLowerCase()] ?? null : null;

    if (key && header) {

      field = key;
      push(draft, key, clean(header[2]));

      continue;

    }

    push(draft, field ?? (draft.headline ? "changed" : "headline"), clean(line));

  }

  if (!draft.headline) {

    throw new Error("recap needs a headline: one line naming what changed, then optional changed / unverified / risk lines.");

  }

  return draft;

}

export function formatRecap(draft: RecapDraft): string {

  const parts = [`saved: ${draft.headline}`];

  if (draft.changed.length) {

    parts.push(`${draft.changed.length} change ${draft.changed.length === 1 ? "line" : "lines"}`);

  }

  if (draft.unverified.length) {

    parts.push(`${draft.unverified.length} unverified`);

  }

  return parts.join(" · ");

}
