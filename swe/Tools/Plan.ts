// A plan the model shows to the user before it builds.

import { isMarked, unmark } from "../Agent/Lines";
import type { Action } from "../Agent/Protocol";

export interface PlanStep {

  title: string;
  detail: string;

}

export interface Plan {

  title: string;

  /** Framing above the steps; empty when the model went straight into them. */
  summary: string;

  steps: PlanStep[];

}

export interface PlanDecision {

  build: boolean;

  /** The model that builds it — the current one unless the user switched. */
  assistantId: string;

  /** Display label, set only on a switch; the model is told which model it now is. */
  modelLabel: string;

  /** Amendment typed into the card before approving. */
  note: string;

  /** User closed the card instead of deciding. */
  dismissed: boolean;

}

const CONTINUATION = /^\s+\S/;

// models write `title — detail` unprompted; either dash reads the same once the card splits it
const SPLIT = /\s+(?:—|–|--)\s+/;

const TITLE_MAX = 90;

export function parsePlan(action: Action): Plan {

  const lead: string[] = [];
  const steps: PlanStep[] = [];

  for (const raw of action.body.split("\n")) {

    const line = raw.trim();

    if (!line) {

      continue;

    }

    const marked = isMarked(line);

    // an indented line under a step is that step's detail, not a step of its own
    if (!marked && steps.length && CONTINUATION.test(raw)) {

      const step = steps[steps.length - 1];

      step.detail = step.detail ? `${step.detail} ${line}` : line;

      continue;

    }

    if (!marked) {

      // prose is framing only until the first step; after that it is stray text
      if (!steps.length) {

        lead.push(line);

      }

      continue;

    }

    const text = unmark(line);

    if (!text) {

      continue;

    }

    const [head, ...rest] = text.split(SPLIT);

    steps.push({ title: head.trim(), detail: rest.join(" ").trim() });

  }

  if (!steps.length) {

    throw new Error("plan needs a title on the first line, then one numbered step per line: 1. Add the IPC handler — swe/main.ts");

  }

  const first = lead[0] ?? "";

  // a long first line is framing the model forgot to title; the row label already names the work
  const titled = first && first.length <= TITLE_MAX;

  if (titled) {

    lead.shift();

  }

  const title = (titled ? first : action.label || action.path || "Plan").trim();

  return { title, summary: lead.join(" ").trim(), steps };

}

/** What the model reads back. Plain prose, because that is what it reasons over best. */
export function formatDecision(plan: Plan, decision: PlanDecision): string {

  if (decision.dismissed) {

    return "The user closed the plan without deciding. Do not start building — ask what they want changed, or call <done>.";

  }

  const note = decision.note.trim();

  if (!decision.build) {

    const extra = note ? ` They said: ${note}` : "";

    return `The user declined that plan.${extra} Do not build it. Ask what they want different, or call <done>.`;

  }

  const lines = [`The user approved the plan "${plan.title}". Build it now: work the steps in order, starting with step 1, and do not re-propose the plan.`];

  const label = decision.modelLabel.trim();

  if (label) {

    // the handoff is invisible from inside the loop, so say it plainly: same chat, new model
    lines.push(`They handed the build to ${label}, which is the model writing this reply. You are in the same chat with the plan and everything above it already in context.`);

  }

  if (note) {

    lines.push(`They added: ${note}`);

  }

  return lines.join("\n\n");

}
