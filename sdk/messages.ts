import { ResponseStream } from "./stream";
import type { ApiChatMessage, AssistantMessage, ChatDetail, ChatTurn, TurnStatus, UserMessage, } from "./types";

function mapApiState(state: string | undefined, role: "user" | "assistant"): TurnStatus {

  if (!state) {

    return role === "user" ? "complete" : "complete";

  }

  const normalized = state.toLowerCase();

  if (normalized === "pending") {

    return "pending";

  }

  if (normalized === "complete" || normalized === "completed") {

    return "complete";

  }

  if (normalized === "error" || normalized === "failed") {

    return "error";

  }

  // Streaming-ish intermediate states from the API, if any
  if (normalized.includes("stream") || normalized === "running") {

    return "streaming";

  }

  return "complete";

}

export function isUserMessage(message: ApiChatMessage): message is UserMessage {

  return message.type === "User";

}

export function isAssistantMessage(message: ApiChatMessage): message is AssistantMessage {

  return message.type === "Assistant";

}

export function turnFromUserMessage(message: UserMessage): ChatTurn {

  return {

    id: message.id,
    role: "user",

    status: mapApiState(message.state, "user"),

    text: message.submission ?? "",
    blocks: [],

    submissionId: message.id,

    created: message.created,

  };

}

export function turnFromAssistantMessage( message: AssistantMessage, chatId: string, ): ChatTurn {

  const submissionId = message.id ?? `assistant-${message.created}`;

  const stream = ResponseStream.fromHistory(chatId, message.responses ?? [], {

    submissionId,
    assistantId: message.responseAssistantId ?? message.promptAssistantId ?? null,

    complete: mapApiState(message.state, "assistant") === "complete",

  });

  const snapshot = stream.snapshot();
  const status = mapApiState(message.state, "assistant");
  const errBlock = snapshot.blocks.find((b) => b.kind === "error");

  return {

    id: submissionId,
    role: "assistant",

    // submission on Assistant rows is the user prompt — never use it as assistant text
    status: errBlock ? "error" : status,

    text: snapshot.text,
    reasoning: snapshot.reasoning || undefined,

    blocks: snapshot.blocks.filter((b) => b.kind !== "progress"),

    submissionId,
    assistantId: snapshot.assistantId,

    created: message.created,

    error: errBlock && errBlock.kind === "error" ? errBlock.content : undefined,

  };

}

// Gets the turns from a chat detail, including user and assistant messages, and handles cases where the user prompt is embedded in the assistant message.
export function turnsFromChatDetail(detail: ChatDetail): ChatTurn[] {

  const chatId = detail.chat.id;
  const messages = detail.messages ?? [];
  const hasExplicitUsers = messages.some(isUserMessage);
  const turns: ChatTurn[] = [];

  for (const message of messages) {

    if (isUserMessage(message)) {

      turns.push(turnFromUserMessage(message));
      continue;

    }

    if (isAssistantMessage(message)) {

      const prompt = (message.submission ?? "").trim();

      if (!hasExplicitUsers && prompt) {

        const asstId = message.id ?? `assistant-${message.created}`;

        turns.push({

          id: `user:${asstId}`,
          role: "user",

          status: "complete",

          text: prompt,
          blocks: [],

          submissionId: asstId,

          created: message.created,

        });

      }

      turns.push(turnFromAssistantMessage(message, chatId));
      continue;

    }

  }

  return turns;

}

export function turnFromSnapshot(snapshot: import("./types").ResponseSnapshot, options: { id?: string; error?: string } = {}): ChatTurn {

  const status =
    options.error || snapshot.status === "error" || snapshot.error
      ? "error"
      : snapshot.status === "complete"
        ? "complete"
        : snapshot.status === "streaming"
          ? "streaming"
          : "pending";

  return {

    id: options.id ?? snapshot.submissionId ?? `stream-${snapshot.chatId}`,
    role: "assistant",

    status,

    text: snapshot.text,
    reasoning: snapshot.reasoning || undefined,

    blocks: snapshot.blocks,

    submissionId: snapshot.submissionId ?? undefined,
    assistantId: snapshot.assistantId,

    error: options.error ?? snapshot.error ?? undefined,

    usage: snapshot.usage,

  };

}
