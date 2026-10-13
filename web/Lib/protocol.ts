// The parts of the agents' protocol the app reads, the way server/agent/protocol reads them.

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

/** A message's words apart from the workspace files listed under its `[attached]` lines. */
export function splitAttached(message: string): { text: string; files: string[] } {

  const text: string[] = [];
  const files: string[] = [];

  let listing = false;

  for (const raw of message.split("\n")) {

    const line = raw.trim();

    if (line === "[attached]") {

      listing = true;

    } else if (listing && line) {

      files.push(line);

    } else {

      listing = false;
      text.push(raw);

    }

  }

  return { text: text.join("\n").trim(), files };

}
