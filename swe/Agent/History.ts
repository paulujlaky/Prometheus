import { extractTaskText, parseReply, parseResults } from "./Parse";
import { parseActions } from "./Protocol";

import { isAssistantMessage, isUserMessage } from "../../sdk/messages";
import { ResponseStream } from "../../sdk/stream";

import type { Entry as HistoryEntry, Step, WithoutId } from "../Types/Transcript";
import type { ApiChatMessage, ChatDetail } from "../../sdk/types";

export type { HistoryEntry };

function assistantParts(message: Extract<ApiChatMessage, { type: "Assistant" }>, chatId: string): { text: string; reasoning: string } {

  const stream = ResponseStream.fromHistory(chatId, message.responses ?? [], {

    submissionId: message.id ?? null,
    complete: true,

  });

  return {

    text: stream.fullText().trim(),
    reasoning: stream.reasoningText().trim(),

  };

}

/** Rough gen-time from prose length, so a replayed row still shows "Thought for Ns". */
function thoughtMsOf(thinking: string): number | null {

  return thinking.trim() ? Math.max(1000, Math.round(thinking.length / 50) * 1000) : null;

}

/**
 * Rebuilds the transcript from a Boodle chat detail.
 */
export function entriesFromChatDetail(detail: ChatDetail): HistoryEntry[] {

  const chatId = detail.chat.id;
  const messages = detail.messages ?? [];
  const entries: HistoryEntry[] = [];

  let seq = 0;
  let sawTask = false;

  // rows from the last reply that are still waiting for their result
  let open: Step[] = [];

  const push = (entry: WithoutId<HistoryEntry>): HistoryEntry => {

    seq += 1;

    const full = { ...entry, id: `h${seq}` } as HistoryEntry;

    entries.push(full);

    return full;

  };

  /** Pair a harness message with the rows it answers. Returns false when it is not one. */
  const settle = (text: string): boolean => {

    const results = parseResults(text);

    if (!results.length) {

      return false;

    }

    results.forEach((result, index) => {

      const step = open[index];

      if (!step) {

        return;

      }

      step.output = result.output;
      step.exitCode = result.exitCode;

    });

    // a block that never ran (the batch stopped, or the run ended) has no result to show
    for (const step of open.slice(results.length)) {

      step.output = "";

    }

    open = [];

    return true;

  };

  const closeStale = () => {

    for (const step of open) {

      if (step.output === null) {

        step.output = "";

      }

    }

    open = [];

  };

  for (const message of messages) {

    if (isUserMessage(message)) {

      const text = message.submission ?? "";

      if (!sawTask) {

        const task = extractTaskText(text);

        if (task) {

          push({ kind: "task", text: task });
          sawTask = true;

        }

        continue;

      }

      settle(text);

      continue;

    }

    if (!isAssistantMessage(message)) {

      continue;

    }

    const submission = (message.submission ?? "").trim();

    if (!sawTask) {

      const task = extractTaskText(submission);

      if (task) {

        push({ kind: "task", text: task });
        sawTask = true;

      }

    } else if (submission) {

      // the previous reply's results usually ride on this row rather than a User one
      settle(submission);

    }

    const { text, reasoning } = assistantParts(message, chatId);

    if (!text && !reasoning) {

      continue;

    }

    const { thinking, actions } = parseActions(text);
    const thought = reasoning || thinking;

    if (!actions.length) {

      if (thought) {

        push({ kind: "step", tool: null, desc: "", thinking: thought, thoughtMs: thoughtMsOf(thought), command: null, output: "", exitCode: null, streaming: false });

      }

      continue;

    }

    closeStale();

    actions.forEach((action, index) => {

      // the reply's prose belongs to the first row it produced, not to every one of them
      const own = index === 0 ? thought : "";

      // say is a plain bubble in live; emit the same shape here so replay matches
      if (action.verb === "say") {

        if (own) {

          push({ kind: "step", tool: null, desc: "", thinking: own, thoughtMs: thoughtMsOf(own), command: null, output: "", exitCode: null, streaming: false });

        }

        const text = action.body.trim();

        if (text) {

          push({ kind: "say", text });

        }

        return;

      }

      const { tool, desc } = parseReply(action.raw);

      const step = push({

        kind: "step",

        tool: tool ?? action.verb,
        desc,

        thinking: own,
        thoughtMs: thoughtMsOf(own),

        command: action.raw,
        output: null,
        exitCode: null,

        streaming: false,

      }) as Step;

      open.push(step);

      if (action.verb === "done") {

        push({ kind: "done", text: action.body.trim() || "Task complete." });

      }

    });

  }

  closeStale();

  return entries;

}
