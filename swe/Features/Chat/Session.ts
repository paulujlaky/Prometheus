import { fileEdits, inferTool, parseReply } from "@/Agent/Parse";

import type { AgentEvent } from "@/Agent/Agent";
import type { Entry, Step, SubagentEntry } from "@/Types/Transcript";

/** Called when a latter call arrived... */
export function closeOpenSteps(entries: Entry[]): Entry[] {

  return entries.map((entry) => {

    if (entry.kind !== "step" || entry.output !== null) {

      return entry;

    }

    return { ...entry, output: "", streaming: false };

  });

}

/** Same close as above, for the step list a subagent card owns. */
export function closeSteps(steps: Step[]): Step[] {

  return steps.map((step) => (step.output === null ? { ...step, output: "", streaming: false } : step));

}

/** Fold one forwarded child event into its card. Deltas never arrive here — only settled blocks. */
export function applyToSubagent(entry: SubagentEntry, inner: AgentEvent, nextId: () => string): SubagentEntry {

  if (inner.type === "status") {

    return { ...entry, note: inner.text };

  }

  if (inner.type === "command") {

    const { tool, desc } = parseReply(inner.command);

    return {

      ...entry,

      steps: [...closeSteps(entry.steps), {

        id: nextId(),
        kind: "step",

        tool,
        desc,
        thinking: "",

        command: inner.command,

        output: null,
        exitCode: null,

        streaming: false,

      }],

    };

  }

  if (inner.type === "observation" || inner.type === "say") {

    const exitCode = inner.type === "say" ? 0 : inner.exitCode;
    const last = entry.steps[entry.steps.length - 1];

    if (last && last.output === null) {

      return { ...entry, steps: [...entry.steps.slice(0, -1), { ...last, output: inner.text, exitCode }] };

    }

    return {

      ...entry,

      steps: [...entry.steps, {

        id: nextId(),
        kind: "step",

        tool: inner.type === "say" ? "say" : null,
        desc: "",
        thinking: "",

        command: inner.type === "say" ? `<say>\n${inner.text}\n</say>` : null,

        output: inner.text,
        exitCode,

        streaming: false,

      }],

    };

  }

  return entry;

}

/** The row a spawn's cards hang from — matched the same way live and rebuilt from history. */
export function isSpawnStep(entry: Entry): boolean {

  return entry.kind === "step" && (entry.tool === "spawn" || inferTool(entry.command) === "spawn");

}

/** Cumulative +/- from apply_patch / write commands in the transcript (and live stream). */
export function lineStatsFromEntries(entries: Entry[]): { added: number; removed: number } {

  let added = 0;
  let removed = 0;

  for (const entry of entries) {

    if (entry.kind !== "step" || !entry.command) {

      continue;

    }

    for (const edit of fileEdits(entry.command)) {

      added += edit.added;
      removed += edit.removed;

    }

  }

  return { added, removed };

}

export function placeSubagents(rows: Entry[], cards: SubagentEntry[]): Entry[] {

  if (!cards.length) {

    return rows;

  }

  const out: Entry[] = [];
  const placed = new Set<string>();

  let ordinal = 0;

  for (const row of rows) {

    out.push(row);

    if (!isSpawnStep(row)) {

      continue;

    }

    for (const card of cards) {

      if (card.spawnIndex === ordinal) {

        out.push(card);
        placed.add(card.id);

      }

    }

    ordinal += 1;

  }

  for (const card of cards) {

    if (!placed.has(card.id)) {

      out.push(card);

    }

  }

  return out;

}
