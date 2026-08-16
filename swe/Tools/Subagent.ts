// A subagent is a whole agent in a separate chat.

import { unmark } from "../Agent/Lines";
import type { Action } from "../Agent/Protocol";

export interface SubagentTask {

  name: string;
  task: string;

}

export interface SubagentReport {

  name: string;
  ok: boolean;

  summary: string;

}

// four concurrent children already outruns what one transcript can show and one context can hold
export const MAX_SUBAGENTS = 4;

const NAMED = /^([A-Za-z][\w -]{0,23}):\s+(\S.*)$/;

/** `name: task` when the model named it, otherwise a positional name. */
function splitName(line: string, index: number): SubagentTask {

  const named = NAMED.exec(line);

  if (named) {

    return { name: named[1].trim(), task: named[2].trim() };

  }

  return { name: `subagent ${index + 1}`, task: line };

}

export function parseSpawn(action: Action): SubagentTask[] {

  const tasks: SubagentTask[] = [];

  for (const raw of action.body.split("\n")) {

    const line = unmark(raw.trim());

    if (!line) {

      continue;

    }

    tasks.push(splitName(line, tasks.length));

  }

  if (!tasks.length) {

    throw new Error("spawn needs one task per line: - reviewer: check swe/Tools/Edit.ts for off-by-one bugs");

  }

  if (tasks.length > MAX_SUBAGENTS) {

    throw new Error(`spawn takes at most ${MAX_SUBAGENTS} tasks at once — that block had ${tasks.length}. Send the rest in a later block.`);

  }

  return tasks;

}

/** What the parent reads back: one section per child, in the order they were spawned. */
export function formatReports(reports: SubagentReport[]): string {

  return reports.map((report) => `[${report.name} ${report.ok ? "done" : "failed"}]\n${report.summary.trim() || "No summary."}`).join("\n\n");

}
