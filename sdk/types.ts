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

  /** `chat` = catalog assistant. `agent` = custom-bot path (system prompt). */
  kind?: "chat" | "agent";

  /** Provider slug from the catalog (`openai`, `anthropic`, ...). */
  api?: string;

  /** Upstream model id (`claude-4.6-sonnet`, `gpt-5.6-sol`, ...). */
  model?: string;

  contextLength?: number;
  maxTokens?: number;

  premiumCategory?: string;

  assistantType?: string;
  useDocumentUi?: boolean;

  /** Boodle task template id (chat vs image vs research). Not a client tool. */
  defaultTaskId?: string;

}

export interface CustomModel {

  id: string;
  name: string;

  taskId?: string;
  imageModelId?: string | null;

  api?: string;
  model?: string;

  contextLength?: number;
  maxTokens?: number;

  premiumCategory?: string;

}

export interface CustomBotDraft {

  id: string;
  name: string;

  currentVersionId?: string;

  description?: string;
  instructions?: string | null;
  welcome?: string | null;

  alias?: string;

  allowRemix?: boolean;

}

export interface CustomBotGroup {

  chatId: string;
  botBuilderChatId: string;

  draft: CustomBotDraft;

  published: { id: string; name: string } | null;

}

export interface ProvisionedAgentBot {

  draftId: string;
  assistantId: string;

}

export interface TeamUsage {

  limits: unknown;
  teamUsage: unknown;

  tier?: string;

}

export interface KnowledgeFolder {

  id: string;
  name: string;

  folderType?: string;
  itemType?: string;

  role?: string;

  createdBy?: string;
  modified?: number;

}

export interface KnowledgeListResponse {

  entries: KnowledgeItem[];

  total: number;
  offset: number;
  limit: number;

}

export interface KnowledgeFolderTree {

  folders: Record<string, KnowledgeFolder>;
  knowledge: unknown[];

  lists: Record<string, { entries: { id: string; itemType?: string }[]; limit: number; offset: number; total: number }>;

  remainingFolderIds?: string[];

}

export interface ContinueChatResponse {

  chat: Chat;
  messages: ApiChatMessage[];

}

/** Loose GET /user bootstrap — teams, flags, alias map. */
export interface UserBootstrap {

  assistant?: unknown;
  profiles?: unknown;
  teams?: unknown;
  user?: unknown;

}

export interface KnowledgeItem {

  id: string;
  name: string;

  description?: string;
  state?: string;

  docType?: string;
  fileName?: string;
  size?: number;

  thumbnail?: unknown;

  created?: number;
  modified?: number;

}

export interface KnowledgeUploadInit {

  knowledge: KnowledgeItem;
  uploadUrl: string;

}

export interface UsageBucket {

  orgId?: string;
  usage?: unknown[];

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

  /** UI “knowledge to context” — full-text search over attached knowledge. */
  fullTextSearchUsed?: boolean;

  memoryModeUsed?: boolean;

  mentions?: unknown[];

  /** Attach already-uploaded knowledge items to this turn / chat. */
  knowledgeIds?: string[];

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

  knowledgeIds?: string[];

}

export interface CreateChatOptions {

  knowledgeIds?: string[];

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

      kind: "reasoning";

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

      kind: "image";

      key: string;
      url: string;
      title: string;

    }
  | {

      kind: "code";

      key: string;
      language: string;
      text: string;

    }
  | {

      kind: "error";

      key: string;
      content: string;
      opcode?: number;

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

  /** Visible answer text (excludes reasoning sections). */
  text: string;

  /** Platform reasoning / chain-of-thought, when streamed as its own section. */
  reasoning?: string;

  blocks: ContentBlock[];

  submissionId?: string;
  assistantId?: string | null;

  created?: number;
  error?: string;

  usage?: UsageBucket | null;

}

export interface ResponseSnapshot {

  chatId: string;

  submissionId: string | null;
  assistantId: string | null;

  status: "idle" | "streaming" | "complete" | "error";

  /** Answer text only — safe for tool/command parsing. */
  text: string;

  /** Reasoning section text, when present. */
  reasoning: string;

  blocks: ContentBlock[];

  progress: string | null;

  links: Extract<ContentBlock, { kind: "link" }>[];
  images: Extract<ContentBlock, { kind: "image" }>[];

  error: string | null;

  usage: UsageBucket | null;

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

      /** Section this delta belongs to (`Reasoning`, `Text`, ...). */
      sectionType: string;

    }
  | {

      kind: "section";

      snapshot: ResponseSnapshot;
      sectionKey: string;

      sectionType: string;

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

      kind: "error";
      snapshot: ResponseSnapshot;

      content: string;
      opcode?: number;

    }
  | {

      kind: "unknown";
      snapshot: ResponseSnapshot;

      data: WsData;

    };

// Client-side JSON tool protocol (PlainText — Boodle does not accept a tools array)

export interface ToolSpec {

  name: string;
  description: string;

  /** JSON Schema for `args`. Optional. */
  parameters?: Record<string, unknown>;

}

export interface ToolCall {

  tool: string;
  label?: string;

  /** Object, array, or scalar — tools interpret their own shape. */
  args: unknown;

}

export interface ToolResult {

  tool: string;

  ok: boolean;
  content: string;

}
