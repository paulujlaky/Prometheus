import { extractCommand, extractFinishedSummary, extractTaskText, parseReply, type Tool } from "./parse";

import { isAssistantMessage, isUserMessage } from "../sdk/messages";
import { ResponseStream } from "../sdk/stream";

import type { ApiChatMessage, ChatDetail } from "../sdk/types";

// a bare Omit collapses a union to its common keys; this keeps each variant intact
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

/** Serializable transcript rows for the renderer (mirrors transcript.Entry). */
export type HistoryEntry =

  | {

      id: string;

      kind: "step";
      tool: Tool | null;

      desc: string;

      thinking: string;
      thoughtMs?: number | null;

      command: string | null;
      output: string | null;
      exitCode: number | null;

      streaming: false;

    }

  | { id: string; kind: "task"; text: string }
  | { id: string; kind: "done"; text: string }
  | { id: string; kind: "error"; text: string };

function assistantText(message: Extract<ApiChatMessage, { type: "Assistant" }>, chatId: string): string {

  const stream = ResponseStream.fromHistory(chatId, message.responses ?? [], {

    submissionId: message.id ?? null,
    complete: true,

  });

  return stream.fullText().trim();

}

/** Observation the harness sends after each command. */
function parseObservation(text: string): { exitCode: number; output: string } | null {

  const match = /^Exit code:\s*(-?\d+)\s*\n?([\s\S]*)$/.exec(text.trim());

  if (!match) {

    return null;

  }

  return {

    exitCode: Number(match[1]),
    output: (match[2] ?? "").replace(/^\n/, ""),

  };

}

/**
 * Rebuilds the mini-swe transcript from a Boodle chat detail.
 */
export function entriesFromChatDetail(detail: ChatDetail): HistoryEntry[] {

  const chatId = detail.chat.id;
  const messages = detail.messages ?? [];
  const entries: HistoryEntry[] = [];

  let seq = 0;
  let sawTask = false;

  let openStep: Extract<HistoryEntry, { kind: "step" }> | null = null;
  let pushedDone = false;

  const push = (entry: WithoutId<HistoryEntry> & { id?: string }) => {

    seq += 1;
    const full = { ...entry, id: entry.id ?? `h${seq}` } as HistoryEntry;
    entries.push(full);
    return full;

  };

  const pushDone = (summary: string) => {

    if (pushedDone) {

      return;

    }

    pushedDone = true;
    push({ kind: "done", text: summary });

  };

  const closeStep = (exitCode: number, output: string) => {

    if (!openStep) {

      // still surface a done marker if FINISHED arrived without a paired step
      const summary = extractFinishedSummary(output);

      if (summary) {

        pushDone(summary);

      }

      return;

    }

    openStep.output = output;
    openStep.exitCode = exitCode;
    openStep = null;

    const summary = extractFinishedSummary(output);

    if (summary) {

      pushDone(summary);

    }

  };

  /** Apply harness feedback (Exit code: …) whether it arrived as User or as next-turn submission. */
  const applyHarnessText = (text: string): boolean => {

    if (!text) {

      return false;

    }

    const observation = parseObservation(text);

    if (observation) {

      closeStep(observation.exitCode, observation.output);
      return true;

    }

    // bare FINISHED line (rare, but tolerate)
    const summary = extractFinishedSummary(text);

    if (summary && !text.includes("You are a coding agent") && text.length < 500) {

      if (openStep) {

        openStep.output = text;
        openStep.exitCode = 0;
        openStep = null;

      }

      pushDone(summary);
      return true;

    }

    return false;

  };

  for (const message of messages) {

    if (isUserMessage(message)) {

      const text = message.submission ?? "";

      if (!sawTask) {

        const task = extractTaskText(text);

        if (task) {

          push({ kind: "task", text: task });
          sawTask = true;
          continue;

        }

      }

      if (applyHarnessText(text)) {

        continue;

      }

      continue;

    }

    if (isAssistantMessage(message)) {

      const submission = (message.submission ?? "").trim();

      // previous step's observation is usually here, not on a User row
      if (sawTask && applyHarnessText(submission)) {

        // fall through to process this assistant's response as the next step
      } else if (submission && !sawTask) {

        const task = extractTaskText(submission);

        if (task) {

          push({ kind: "task", text: task });
          sawTask = true;

        }

      }

      const text = assistantText(message, chatId);

      if (!text) {

        continue;

      }

      // model-only finish (no bash) — rare
      const finishedOnly = extractFinishedSummary(text);

      if (finishedOnly && !extractCommand(text)) {

        pushDone(finishedOnly);
        continue;

      }

      const { tool, desc, thinking, command } = parseReply(text);

      // FINISHED echo is often itself a bash step: desc + echo MINI_SWE_FINISHED
      if (command && extractFinishedSummary(command)) {

        if (openStep && openStep.output === null) {

          openStep.output = "";
          openStep.exitCode = 0;
          openStep = null;

        }

        openStep = push({

          kind: "step",

          tool: tool ?? "done",
          desc: desc || "Finish",

          thinking,
          thoughtMs: thinking.trim() ? Math.max(1000, Math.round(thinking.length / 50) * 1000) : null,

          command,
          output: null,
          exitCode: null,

          streaming: false,

        }) as (Extract<HistoryEntry, { kind: "step" }>);

        continue;

      }

      if (!command && !desc) {

        continue;

      }

      // exitCode stays null: we never saw the result, so the row must not claim success
      if (openStep && openStep.output === null) {

        openStep.output = "<no observation stored>";
        openStep = null;

      }

      openStep = push({

        kind: "step",

        tool,
        desc: desc || "Command",

        thinking,
        thoughtMs: thinking.trim() ? Math.max(1000, Math.round(thinking.length / 50) * 1000) : null,

        command,
        output: null,
        exitCode: null,

        streaming: false,

      }) as Extract<HistoryEntry, { kind: "step" }>;

    }

  }

  if (openStep && openStep.output === null) {

    openStep.output = "";

    // last step was the FINISHED echo itself — that one really did succeed
    if (openStep.command && extractFinishedSummary(openStep.command)) {

      openStep.output = openStep.command;
      openStep.exitCode = 0;

      pushDone(extractFinishedSummary(openStep.command) ?? "Task complete.");

    }

  }

  return entries;

}
