import { parseSession, type SessionInfo } from "./auth";
import { BoodleSocket } from "./socket";

import type {
  AssistantSummary,
  Chat,
  ChatDetail,
  ChatListResponse,
  CreateChatResponse,
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

  async createChat(): Promise<Chat> {

    const body = await this.requestJson<CreateChatResponse>("POST", "/chat", {

      knowledgeIds: [], // not really used for now

    });

    return body.chat;

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

        out.push({

          id: obj.id,
          name: obj.name,

          alias: typeof obj.alias === "string" ? obj.alias : undefined,
          avatarUrl: typeof obj.avatarUrl === "string" ? obj.avatarUrl : undefined,
          description: typeof obj.description === "string" ? obj.description : undefined,

          displayCategory: typeof obj.displayCategory === "string" ? obj.displayCategory : undefined,

          state: typeof obj.state === "string" ? obj.state : undefined,

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
