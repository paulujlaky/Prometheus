// REST / API shapes (as returned by box.boodle.ai)

export type MessageState = "Pending" | "Complete" | string;

export interface Chat {

  id: string;
  name: string;
  description: string | null;

  isContinueChat: boolean;

  chatType: string;
  state: string;

  version: number;

  createdBy: string;
  orgId: string;

  lastMessage: number;

  transcriptKnowledgeId: string | null;

  created: number;
  modified: number;

  accessScope: string;
  accessLevel: string;

  unreadCount?: number;

  isFavorite?: boolean;

  role?: string;

}

export interface ChatMember {

  chatId: string;
  userId: string;

  status?: string;
  state?: string;

  role?: string;

  lastRead: number;

  created: number;
  modified: number;

  access?: unknown;

}

export interface CreateChatResponse {

  chat: Chat;

  knowledge: unknown[];
  members: ChatMember[];

}

export interface ChatListResponse {

  entries: Chat[];

  total: number;
  offset: number;
  limit: number;

}

export interface AssistantSummary {

  id: string;
  name: string;

  alias?: string;
  description?: string;

  displayCategory?: string;

  state?: string;

  avatarUrl?: string;

}

/** Opaque message-part object from the API (stream or history). */
export type RawPart = Record<string, unknown> & { type?: string };

export interface UserMessage {

  id: string;
  chatId: string;

  type: "User";

  state: MessageState;

  submission: string;

  coachModeUsed: boolean;
  fullTextSearchUsed: boolean;
  memoryModeUsed: boolean;

  promptAssistantId: string | null;

  createdBy: string;

  created: number;
  modified: number;

}

export interface AssistantMessage {

  id?: string;
  chatId: string;

  type: "Assistant";

  state: MessageState;

  submission?: string; // User prompt for this turn (API stores history on Assistant rows).
  responses: RawPart[];

  promptAssistantId?: string | null;
  responseAssistantId?: string | null;

  coachModeUsed?: boolean;
  fullTextSearchUsed?: boolean;
  memoryModeUsed?: boolean;

  createdBy?: string;
  created: number;
  modified?: number;

}

export type ApiChatMessage = UserMessage | AssistantMessage;

export interface ChatDetail {

  chat: Chat;

  assistants: AssistantSummary[];

  profiles: unknown[];
  knowledge: unknown[];
  members: ChatMember[];
  messages: ApiChatMessage[];

}

export interface SendMessageOptions {

  assistantId?: string;

  coachModeUsed?: boolean;
  fullTextSearchUsed?: boolean;
  memoryModeUsed?: boolean;

  mentions?: unknown[];

}

export interface SendMessageRequest {

  coachModeUsed: boolean;
  fullTextSearchUsed: boolean;
  memoryModeUsed: boolean;

  mentions: unknown[];

  message: {

    content: string;
    type: "PlainText";

  };

  assistantId: string;

}

// WebSocket

export interface WsEnvelope {

  entityId?: string;
  userId?: string;

  data: WsData;

  timestamp?: number;

  ticketId?: string | null;

}

/** Any inbound parrot payload; always has a string `type`. */
export type WsData = {

  type: string;

  chatId?: string;
  [key: string]: unknown;

};

export interface WsOutbound {

  type: "ChatMemberActive" | "ChatMemberTyping" | string;

  chatId: string;
  userId: string;

}

// Normalized UI model

export type TurnStatus = "pending" | "streaming" | "complete" | "error";

export type ContentBlock =
  | {
      kind: "text";

      key: string;
      sectionType: string;

      text: string;
      streaming: boolean;

    }
  | {

      kind: "progress";

      key: string;
      content: string;

    }
  | {

      kind: "link";

      key: string;
      title: string;
      url: string;

      linkType: string;

    }
  | {

      kind: "unknown";

      key: string;
      type: string;

      raw: Record<string, unknown>;

  };

export interface ChatTurn {

  id: string;

  role: "user" | "assistant";
  status: TurnStatus;

  text: string;
  blocks: ContentBlock[];

  submissionId?: string;
  assistantId?: string | null;

  created?: number;
  error?: string;

}

export interface ResponseSnapshot {

  chatId: string;

  submissionId: string | null;
  assistantId: string | null;

  status: "idle" | "streaming" | "complete";

  text: string;
  blocks: ContentBlock[];

  progress: string | null;

  links: Extract<ContentBlock, { kind: "link" }>[];

}

/** Low-level stream mutations emitted by ResponseStream. */
export type StreamChange =
  | {

      kind: "started";
      snapshot: ResponseSnapshot;

      userText?: string;

    }
  | {

      kind: "delta";
      snapshot: ResponseSnapshot;

      text: string;
      sectionKey: string;

    }
  | {

      kind: "section";

      snapshot: ResponseSnapshot;
      sectionKey: string;

    }
  | {

      kind: "progress";

      snapshot: ResponseSnapshot;
      content: string;

    }
  | {

      kind: "block";

      snapshot: ResponseSnapshot;
      block: ContentBlock;

    }
  | {

      kind: "complete";
      snapshot: ResponseSnapshot;

    }
  | {

      kind: "unknown";
      snapshot: ResponseSnapshot;

      data: WsData;

    };
