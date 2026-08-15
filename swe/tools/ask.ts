// A question the model puts to the user mid-run: fixed choices, optionally several at once,
// optionally a write-in answer beside them. Same bargain as the rest of the protocol — lines
// and prefixes, no JSON, nothing to escape.

import type { Action } from "../protocol";

export interface Choice {

  id: string;
  label: string;

}

export interface Question {

  prompt: string;
  choices: Choice[];

  multi: boolean;

  /** Placeholder for the write-in field; empty when the model offered no `+` line. */
  openLabel: string;

}

export interface Answer {

  picked: string[];
  text: string;

  /** User closed the card instead of answering it. */
  dismissed: boolean;

}

const BULLET = /^[-*•]\s+/;
const NUMBERED = /^\d+[.)]\s+/;
const OPEN = /^\+\s*/;

const MULTI = /\b(multi|multiple|many|checkbox|any)\b/i;

export function parseAsk(action: Action): Question {

  const prompt: string[] = [];
  const choices: Choice[] = [];

  let openLabel = "";

  for (const raw of action.body.split("\n")) {

    const line = raw.trim();

    if (!line) {

      continue;

    }

    if (OPEN.test(line)) {

      openLabel = line.replace(OPEN, "").trim() || "Something else";
      continue;

    }

    if (BULLET.test(line) || NUMBERED.test(line)) {

      const label = line.replace(BULLET, "").replace(NUMBERED, "").trim();

      if (label) {

        choices.push({ id: `c${choices.length + 1}`, label });

      }

      continue;

    }

    // prose is only the question while no choice has been offered; after that it is stray text
    if (!choices.length) {

      prompt.push(line);

    }

  }

  const question = prompt.join(" ").trim();

  if (!question) {

    throw new Error("ask needs a question on the first line, then one choice per line: - Postgres");

  }

  if (!choices.length && !openLabel) {

    throw new Error("ask needs at least one choice — write each on its own line starting with -");

  }

  // models phrase the affordance in the question far more reliably than they reach for the tag
  const multi = MULTI.test(action.path) || /all that apply|select any|one or more/i.test(question);

  return { prompt: question, choices, multi, openLabel };

}

/** What the model reads back. Plain prose, because that is what it reasons over best. */
export function formatAnswer(question: Question, answer: Answer): string {

  if (answer.dismissed) {

    return "The user closed that question without answering. Decide it yourself and keep going.";

  }

  const chosen = question.choices
    .filter((choice) => answer.picked.includes(choice.id))
    .map((choice) => choice.label);

  const typed = answer.text.trim();

  if (typed) {

    chosen.push(typed);

  }

  if (!chosen.length) {

    return "The user answered without picking anything. Decide it yourself and keep going.";

  }

  if (chosen.length === 1) {

    return `The user chose: ${chosen[0]}`;

  }

  return `The user chose:\n${chosen.map((label) => `- ${label}`).join("\n")}`;

}
