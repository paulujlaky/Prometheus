import { formatElapsed } from "@/Utils/Time";

import type { AppState } from "@/Features/App/State";
import type { Entry } from "@/Types/Transcript";
import type { UndoInfo } from "@/Features/Chat/Transcript";

export function statusLine(state: AppState): string {

  const { running, agentStatus, notice, lastRun, entries } = state;

  if (running) {

    return agentStatus || "Starting";

  }

  if (notice) {

    return notice;

  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {

    const entry = entries[index];

    if (entry.kind === "error") {

      return "Error";

    }

    if (entry.kind === "done") {

      return lastRun && lastRun.id === entry.id ? `Done in ${formatElapsed(lastRun.ms)}` : "Done";

    }

  }

  return "Idle";

}

export function undoFor(state: AppState, entry: Entry): UndoInfo | null {

  const { undos, entries } = state;

  if (entry.kind !== "done" || !undos.length) {

    return null;

  }

  const verdicts = entries.filter((row) => row.kind === "done");
  const index = verdicts.indexOf(entry);

  if (index < 0) {

    return null;

  }

  const mark = undos[index - (verdicts.length - undos.length)];

  return mark ? { commit: mark.commit, undone: mark.undone } : null;

}
