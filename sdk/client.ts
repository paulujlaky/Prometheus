import { parseSession, type SessionInfo } from "./auth";
import { BoodleSocket } from "./socket";

import type {
  AssistantSummary,
  Chat,
  ChatDetail,
  ChatListResponse,
  CreateChatOptions,
  CreateChatResponse,
  KnowledgeItem,
  KnowledgeUploadInit,
  SendMessageOptions,
  SendMessageRequest,
  UserMessage,
} from "./types";

const DEFAULT_BASE = "https://box.boodle.ai/api";

export interface BoodleClientOptions {

  cookie: string;
  baseUrl?: string;
  userAgent?: string;

}

export class BoodleClient {

  readonly session: SessionInfo;
  readonly baseUrl: string;

  private userAgent: string;

  constructor(options: BoodleClientOptions) {

    this.session = parseSession(options.cookie);
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    this.userAgent = options.userAgent ?? "Mozilla/5.0 (compatible; Boombox/0.1; +https://box.boodle.ai)";

  }

  get userId() {

    return this.session.userId;

  }

  get orgId() {

    return this.session.orgId;

  }

  get preferredAssistantId() {

    return this.session.preferredAssistantId;

  }

  async getWsTicket(): Promise<string> {

    const text = await this.requestText("GET", "/user/ws-ticket");

    return text.replace(/^"|"$/g, "").trim();

  }

  async createChat(options: CreateChatOptions = {}): Promise<Chat> {

    const body = await this.requestJson<CreateChatResponse>("POST", "/chat", {

      knowledgeIds: options.knowledgeIds ?? [],

    });

    return body.chat;

  }

  /**
   * Find a recent chat with no messages to reuse instead of POST /chat.
   * Prefers default "New Chat" titles / never-messaged rows, then verifies via getChat.
   */
  async findEmptyChat(options: { scan?: number; verify?: number } = {}): Promise<Chat | null> {

    const scan = options.scan ?? 20;
    const verify = options.verify ?? 5;

    const list = await this.listChats(scan, 0);
    const entries = [...(list.entries ?? [])].sort(
      (a, b) => (b.modified ?? b.lastMessage ?? b.created ?? 0) - (a.modified ?? a.lastMessage ?? a.created ?? 0),
    );

    if (!entries.length) {

      return null;

    }

    const likelyEmpty = (c: Chat) => {

      const name = (c.name ?? "").trim().toLowerCase();

      if (name === "new chat" || name === "") {

        return true;

      }

      // never received a user/assistant turn after creation
      if (c.lastMessage != null && c.created != null && c.lastMessage === c.created) {

        return true;

      }

      return false;

    };

    const ranked = [
      ...entries.filter(likelyEmpty),
      // fall through only if nothing looked empty from list metadata
    ];

    const pool = (ranked.length ? ranked : entries).slice(0, verify);

    for (const entry of pool) {

      try {

        const detail = await this.getChat(entry.id);

        if ((detail.messages ?? []).length === 0) {

          return detail.chat;

        }

      } catch {

        // deleted / inaccessible — skip
      }

    }

    return null;

  }

  /**
   * Reuse a recent empty chat when possible; otherwise create one.
   * Attaches `knowledgeIds` in both paths.
   */
  async createOrReuseChat(options: CreateChatOptions = {}): Promise<Chat> {

    const empty = await this.findEmptyChat();

    if (empty) {

      if (options.knowledgeIds?.length) {

        await this.attachChatKnowledge(empty.id, options.knowledgeIds);

      }

      return empty;

    }

    return this.createChat(options);

  }

  /**
   * Step 1 of file/image upload: allocate a knowledge row + S3 presign URL.
   * Then PUT raw bytes to `uploadUrl`, then call `confirmKnowledgeUpload`.
   */
  async initKnowledgeUpload(file: { name: string; size: number; context?: string }): Promise<KnowledgeUploadInit> {

    return this.requestJson<KnowledgeUploadInit>("POST", "/knowledge/upload", {

      context: file.context ?? "Chat",
      fileName: encodeURIComponent(file.name),
      fileSize: file.size,
      name: file.name,

    });

  }

  /** Step 3: mark the S3 put as Success/Error so Boodle processes the file. */
  async confirmKnowledgeUpload(
    knowledgeId: string,
    result: "Success" | "Error" = "Success",
    errorReason?: string,
  ): Promise<KnowledgeItem> {

    const payload: Record<string, string> = {

      knowledgeId,
      uploadResult: result,

    };

    if (errorReason) {

      payload.errorReason = errorReason;

    }

    return this.requestJson<KnowledgeItem>("POST", `/knowledge/upload/${knowledgeId}`, payload);

  }

  /**
   * Full upload: init → PUT bytes to S3 → confirm Success.
   * `data` is the raw file body (image/png, text, …).
   */
  async uploadKnowledge(
    file: { name: string; data: ArrayBuffer | Uint8Array | Buffer; context?: string },
  ): Promise<KnowledgeItem> {

    const raw = file.data instanceof ArrayBuffer
      ? new Uint8Array(file.data)
      : new Uint8Array(file.data.buffer, file.data.byteOffset, file.data.byteLength);

    // copy into a plain ArrayBuffer so fetch/Blob typings are happy across bun/node
    const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    const size = ab.byteLength;

    const { knowledge, uploadUrl } = await this.initKnowledgeUpload({

      name: file.name,
      size,
      context: file.context,

    });

    const put = await fetch(uploadUrl, {

      method: "PUT",
      headers: {

        "User-Agent": this.userAgent,

      },
      body: ab,

    });

    if (!put.ok) {

      const reason = `S3 PUT failed: ${put.status}`;

      try {

        await this.confirmKnowledgeUpload(knowledge.id, "Error", reason);

      } catch {

        // best-effort
      }

      throw new Error(reason);

    }

    return this.confirmKnowledgeUpload(knowledge.id, "Success");

  }

  /** Attach knowledge items to an existing chat (also available via createChat knowledgeIds). */
  async attachChatKnowledge(chatId: string, knowledgeIds: string[]): Promise<unknown> {

    if (!knowledgeIds.length) {

      return [];

    }

    return this.requestJson("POST", `/chat/${chatId}/knowledge`, { knowledgeIds });

  }

  async deleteChat(chatId: string): Promise<void> {

    await this.request("DELETE", `/chat/${chatId}`);

  }

  /** Best-effort rename — Boodlebox may accept PATCH or PUT; failures are non-fatal for callers. */
  async renameChat(chatId: string, name: string): Promise<void> {

    try {

      await this.request("PATCH", `/chat/${chatId}`, { name });

      return;

    } catch {

      // fall through
    }

    await this.request("PUT", `/chat/${chatId}`, { name });

  }

  async getChat(chatId: string): Promise<ChatDetail> {

    return this.requestJson<ChatDetail>("GET", `/chat/${chatId}`);

  }

  async listChats(limit = 25, offset = 0): Promise<ChatListResponse> {

    return this.requestJson<ChatListResponse>("GET", `/chat/list?limit=${limit}&offset=${offset}`);

  }

  async sendMessage(chatId: string, content: string, options: SendMessageOptions = {}): Promise<UserMessage> {

    const assistantId = options.assistantId ?? this.preferredAssistantId;

    if (!assistantId) {

      throw new Error("assistantId required (set preferred-chat-assistant cookie or pass assistantId)");

    }

    const payload: SendMessageRequest = {

      coachModeUsed: options.coachModeUsed ?? false,
      fullTextSearchUsed: options.fullTextSearchUsed ?? false,
      memoryModeUsed: options.memoryModeUsed ?? false,

      mentions: options.mentions ?? [],

      message: {

        content,
        type: "PlainText",

      },

      assistantId,

    };

    if (options.knowledgeIds?.length) {

      payload.knowledgeIds = options.knowledgeIds;

    }

    return this.requestJson<UserMessage>("POST", `/chat/${chatId}/message`, payload);

  }

  async listAssistants(): Promise<AssistantSummary[]> {

    const raw = await this.requestJson<unknown>("GET", "/assistant");

    return flattenAssistants(raw);

  }

  wsUrl(ticket: string): string {

    const base = this.baseUrl.replace(/^http/, "ws");

    return `${base}/v2/parrot/connect/user/${this.userId}/ticket/${ticket}`;

  }

  async connectSocket(): Promise<BoodleSocket> {

    const ticket = await this.getWsTicket();

    return BoodleSocket.connect(this.wsUrl(ticket), this.userId);

  }

  private headers(json = true): Record<string, string> {

    const headers: Record<string, string> = {

      Cookie: this.session.cookie,

      Accept: "application/json, text/plain, */*",
      Origin: "https://box.boodle.ai",
      Referer: "https://box.boodle.ai/",

      "User-Agent": this.userAgent,

    };

    if (json) {

      headers["Content-Type"] = "application/json";

    }

    return headers;

  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {

    const res = await fetch(`${this.baseUrl}${path}`, {

      method,
      headers: this.headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),

    });

    if (!res.ok) {

      const text = await res.text().catch(() => "");

      throw new Error(
        `${method} ${path} failed: ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 400)}` : ""}`,
      );

    }

    return res;

  }

  private async requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {

    const res = await this.request(method, path, body);

    return (await res.json()) as T;

  }

  private async requestText(method: string, path: string): Promise<string> {

    const res = await this.request(method, path);

    return res.text();

  }

}

function flattenAssistants(raw: unknown): AssistantSummary[] {

  const out: AssistantSummary[] = [];
  const seen = new Set<string>();

  const visit = (node: unknown) => {

    if (node == null) {

      return;

    }

    if (Array.isArray(node)) {

      for (const item of node) {

        visit(item);

      }

      return;

    }

    if (typeof node !== "object") {

      return;

    }

    const obj = node as Record<string, unknown>;

    if (typeof obj.id === "string" && typeof obj.name === "string") {

      const looksLikeAssistant = "alias" in obj || "displayCategory" in obj || "assistantType" in obj || "welcome" in obj;

      if (looksLikeAssistant && !seen.has(obj.id)) {

        seen.add(obj.id);

        // catalog nests provider meta under `llm` / `model`; surface it for context limits + UI
        const llm = asMeta(obj.llm) ?? asMeta(obj.model);

        out.push({

          id: obj.id,
          name: obj.name,

          alias: typeof obj.alias === "string" ? obj.alias : undefined,
          avatarUrl: typeof obj.avatarUrl === "string" ? obj.avatarUrl : typeof llm?.avatarUrl === "string" ? llm.avatarUrl : undefined,
          description: typeof obj.description === "string" ? obj.description : undefined,

          displayCategory: typeof obj.displayCategory === "string" ? obj.displayCategory : undefined,

          state: typeof obj.state === "string" ? obj.state : undefined,

          api: typeof llm?.api === "string" ? llm.api : undefined,
          model: typeof llm?.model === "string" ? llm.model : undefined,

          contextLength: typeof llm?.contextLength === "number" ? llm.contextLength : undefined,
          maxTokens: typeof llm?.maxTokens === "number" ? llm.maxTokens : undefined,

          premiumCategory: typeof llm?.premiumCategory === "string" ? llm.premiumCategory : undefined,

        });

      }

    }

    for (const value of Object.values(obj)) {

      visit(value);

    }

  };

  visit(raw);

  return out;

}

function asMeta(value: unknown): Record<string, unknown> | null {

  if (value != null && typeof value === "object" && !Array.isArray(value)) {

    return value as Record<string, unknown>;

  }

  return null;

}
