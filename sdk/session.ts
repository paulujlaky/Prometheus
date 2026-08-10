import type { BoodleClient } from "./client";
import { turnsFromChatDetail, turnFromSnapshot } from "./messages";
import type { BoodleSocket } from "./socket";
import { ResponseStream } from "./stream";

import type { Chat, ChatTurn, SendMessageOptions, StreamChange, WsData, WsEnvelope, } from "./types";

export interface ChatSessionOptions {

  assistantId?: string; // Uses the default if not provided

  reconnect?: boolean;
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;

  timeoutMs?: number;

  refreshOnComplete?: boolean; // If true, refreshes the chat state after a final response is received

}

export interface ChatSessionState {

  chat: Chat | null;
  messages: ChatTurn[];

  connected: boolean;

  busy: boolean;
  error: Error | null;

}

export type ChatSessionListener = (state: ChatSessionState) => void;
export type ChatSessionEvent = | { type: "state"; state: ChatSessionState } | { type: "stream"; change: StreamChange; turn: ChatTurn } | { type: "error"; error: Error };

type EventListener = (event: ChatSessionEvent) => void;

export class ChatSession {

  readonly client: BoodleClient;
  readonly chatId: string;

  private options: Required< Pick< ChatSessionOptions, | "reconnect" | "reconnectDelayMs" | "maxReconnectAttempts" | "timeoutMs" | "refreshOnComplete" >> & { assistantId?: string };

  private chat: Chat | null = null;
  private messages: ChatTurn[] = [];
  private connected = false;
  private busy = false;
  private error: Error | null = null;

  private socket: BoodleSocket | null = null;
  private unsubEnvelope: (() => void) | null = null;
  private unsubStatus: (() => void) | null = null;
  private unsubError: (() => void) | null = null;

  private activeStream: ResponseStream | null = null;
  private activeAssistantTurnId: string | null = null;
  private pendingFinal: | { submissionId: string; resolve: (turn: ChatTurn) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout>; } | null = null;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private connecting: Promise<void> | null = null;

  private stateListeners = new Set<ChatSessionListener>();
  private eventListeners = new Set<EventListener>();

  private constructor( client: BoodleClient, chatId: string, options: ChatSessionOptions = {}, ) {

    this.client = client;
    this.chatId = chatId;

    this.options = {

      assistantId: options.assistantId,

      reconnect: options.reconnect ?? true,
      reconnectDelayMs: options.reconnectDelayMs ?? 1500,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 8,

      timeoutMs: options.timeoutMs ?? 180_000,

      refreshOnComplete: options.refreshOnComplete ?? true,

    };

  }

  static async create(client: BoodleClient, options: ChatSessionOptions = {}): Promise<ChatSession> {

    const chat = await client.createChat();
    const session = new ChatSession(client, chat.id, options);

    session.chat = chat;
    session.emitState();

    await session.connect();

    return session;

  }

  static async open(client: BoodleClient, chatId: string, options: ChatSessionOptions = {}): Promise<ChatSession> {

    const session = new ChatSession(client, chatId, options);

    await session.refresh();
    await session.connect();

    return session;

  }

  get state(): ChatSessionState {

    return {

      chat: this.chat,
      messages: [...this.messages],

      connected: this.connected,

      busy: this.busy,
      error: this.error,

    };

  }

  /** Subscribes to full state snapshots (for a simple chat UI). */
  subscribe(listener: ChatSessionListener): () => void {

    this.stateListeners.add(listener);
    listener(this.state);

    return () => {

      this.stateListeners.delete(listener);

    };

  }

  /** Listens to lower-level events including per-delta stream changes. */
  on(listener: EventListener): () => void {

    this.eventListeners.add(listener);

    return () => {

      this.eventListeners.delete(listener);

    };

  }

  async connect(): Promise<void> {

    if (this.disposed) {

      throw new Error("ChatSession is disposed");

    }

    if (this.socket?.connected) {

      this.socket.setActive(this.chatId);

      return;

    }

    if (this.connecting) {

      return this.connecting;

    }

    this.connecting = this.openSocket().catch((err) => {

      this.setError(err instanceof Error ? err : new Error(String(err)));
      throw err;

    }).finally(() => {

      this.connecting = null;

    });

    return this.connecting;

  }

  disconnect() {

    this.clearReconnect();
    this.teardownSocket(true);
    this.connected = false;
    this.emitState();

  }

  async refresh(): Promise<ChatSessionState> {

    const detail = await this.client.getChat(this.chatId);

    this.chat = detail.chat;
    this.messages = turnsFromChatDetail(detail);

    this.error = null;
    this.emitState();

    return this.state;

  }

  /** Send a user message and wait until the assistant turn completes or times out. */
  async send(content: string, options: SendMessageOptions = {}): Promise<ChatTurn> {

    if (this.disposed) {

      throw new Error("ChatSession is disposed");

    }

    if (this.busy) {

      throw new Error("A response is already in progress");

    }

    const text = content.trim();

    if (!text) {

      throw new Error("Message content is empty");

    }

    await this.connect();

    this.busy = true;
    this.error = null;

    const localUserId = `local-user-${Date.now()}`;

    const userTurn: ChatTurn = {

      id: localUserId,
      role: "user",

      status: "pending",

      text,
      blocks: [],

    };

    this.messages = [...this.messages, userTurn];
    this.emitState();

    this.socket?.setActive(this.chatId);
    this.socket?.setTyping(this.chatId);

    try {

      const pending = await this.client.sendMessage(this.chatId, text, {

        ...options,
        assistantId: options.assistantId ?? this.options.assistantId ?? this.client.preferredAssistantId ?? undefined,

      });

      this.patchTurn(localUserId, {

        id: pending.id,
        status: "complete",

        submissionId: pending.id,
        created: pending.created,

      });

      const assistantId = `assistant-${pending.id}`;

      const assistantTurn: ChatTurn = {

        id: assistantId,
        role: "assistant",

        status: "streaming",

        text: "",
        blocks: [],

        submissionId: pending.id,
        assistantId: options.assistantId ?? this.options.assistantId ?? this.client.preferredAssistantId,

      };

      this.messages = [...this.messages, assistantTurn];
      this.activeAssistantTurnId = assistantId;
      this.activeStream = new ResponseStream(this.chatId, pending.id);

      this.emitState();

      const completed = await this.waitForFinal(pending.id);

      if (this.options.refreshOnComplete) {

        try {

          await this.refresh();

        } catch {

          // keep streamed turn if reconcile fails
        }

      }

      return (

        this.messages.find((m) => m.role === "assistant" && (m.submissionId === pending.id || m.id === assistantId)) ?? completed

      );

    } catch (err) {

      const error = err instanceof Error ? err : new Error(String(err));

      this.setError(error);

      if (this.activeAssistantTurnId) {

        this.patchTurn(this.activeAssistantTurnId, { status: "error", error: error.message });

      }

      throw error;

    } finally {

      this.busy = false;
      this.activeStream = null;
      this.activeAssistantTurnId = null;

      this.clearPendingFinal();
      this.emitState();

    }

  }

  dispose() {

    this.disposed = true;

    this.clearReconnect();
    this.clearPendingFinal(new Error("ChatSession disposed"));
    this.teardownSocket(true);

    this.stateListeners.clear();
    this.eventListeners.clear();

  }

  private async openSocket(): Promise<void> {

    this.teardownSocket(false);

    const socket = await this.client.connectSocket();

    this.socket = socket;
    this.reconnectAttempts = 0;
    this.connected = true;
    this.error = null;

    this.unsubEnvelope = socket.onEnvelope((envelope) => {

      this.onEnvelope(envelope);

    });

    this.unsubStatus = socket.onStatus((connected) => {

      this.connected = connected;
      this.emitState();

      if (!connected && !this.disposed && this.options.reconnect) {

        this.scheduleReconnect();

      }

    });

    this.unsubError = socket.onError((err) => {

      if (this.disposed) {

        return;

      }

      // Close already triggers reconnect via onStatus; avoid noisy hard errors
      if (err.message === "WebSocket closed" && this.options.reconnect) {

        return;

      }

      this.setError(err);

    });

    socket.setActive(this.chatId);
    this.emitState();

  }

  private teardownSocket(intentional: boolean) {

    if (this.socket) {

      if (intentional) {

        this.socket.close();

      } else {

        try {

          this.socket.close();

        } catch {

          // ignore
        }

      }

    }

    this.unsubEnvelope?.();
    this.unsubStatus?.();
    this.unsubError?.();

    this.unsubEnvelope = null;
    this.unsubStatus = null;
    this.unsubError = null;

    this.socket = null;

  }

  private scheduleReconnect() {

    if (this.disposed || this.reconnectTimer) {

      return;

    }

    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {

      this.setError(new Error("WebSocket reconnect attempts exhausted"));

      return;

    }

    const delay = this.options.reconnectDelayMs * Math.min(8, 2 ** this.reconnectAttempts); // exponential backoff. max 8x delay

    this.reconnectAttempts += 1;

    this.reconnectTimer = setTimeout(() => {

      this.reconnectTimer = null;

      void this.connect().catch(() => {

        this.scheduleReconnect();

      });

    }, delay);

  }

  private clearReconnect() {

    if (this.reconnectTimer) {

      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;

    }

  }

  private onEnvelope(envelope: WsEnvelope) {

    const data = envelope.data;
    const chatId = resolveChatId(envelope, data);

    if (chatId && chatId !== this.chatId) {

      return;

    }

    // presence / typing echoes. can ignore safely
    if ( data.type === "ChatMemberActive" || data.type === "ChatMemberTyping" ) {

      return;

    }

    if (data.type === "MessageSubmission" || data.type === "MessageIncrementalResponse" || data.type === "MessageFinalResponse" ) {

      this.onGenerationData(data);

    }

  }

  private onGenerationData(data: WsData) {

    const submissionId = (typeof data.submissionId === "string" && data.submissionId) || (typeof data.id === "string" && data.id) || null;

    if (!this.activeStream) {

      // unsolicited stream. we should reconnect
      if (data.type === "MessageIncrementalResponse" || data.type === "MessageSubmission") {

        this.activeStream = new ResponseStream(this.chatId, submissionId);
        this.busy = true;

        if (!this.activeAssistantTurnId) {

          const turn = turnFromSnapshot(this.activeStream.snapshot(), {

            id: `assistant-${submissionId ?? Date.now()}`,

          });

          turn.status = "streaming";

          this.activeAssistantTurnId = turn.id;
          this.messages = [...this.messages, turn];

        }

      } else {

        return;

      }

    }

    if (submissionId && this.activeStream.submissionId && submissionId !== this.activeStream.submissionId && data.type !== "MessageSubmission") {

      return; // something does not look right - ignore

    }

    const changes = this.activeStream.handleData(data);

    for (const change of changes) {

      this.applyStreamChange(change);

    }

  }

  private applyStreamChange(change: StreamChange) {

    const snapshot = change.snapshot;
    const turnId = this.activeAssistantTurnId ?? snapshot.submissionId ?? `assistant-${Date.now()}`;

    if (!this.activeAssistantTurnId) {

      this.activeAssistantTurnId = turnId;

    }

    const turn = turnFromSnapshot(snapshot, { id: turnId });

    if (!this.messages.some((m) => m.id === turnId)) {

      this.messages = [...this.messages, turn];

    } else {

      this.patchTurn(turnId, turn);

    }

    this.emitEvent({ type: "stream", change, turn });
    this.emitState();

    if (change.kind === "complete") {

      const pending = this.pendingFinal;

      if (pending && (!pending.submissionId || pending.submissionId === snapshot.submissionId)) {

        clearTimeout(pending.timer);

        this.pendingFinal = null;
        pending.resolve(turn);

      }

    }

  }

  private waitForFinal(submissionId: string): Promise<ChatTurn> {

    return new Promise((resolve, reject) => {

      const existing = this.messages.find((m) => m.role === "assistant" && m.submissionId === submissionId && m.status === "complete"); // already complete?

      if (existing) {

        resolve(existing);
        return;

      }

      const timer = setTimeout(() => {

        if (this.pendingFinal?.submissionId === submissionId) {

          this.pendingFinal = null;
          reject(new Error( `Timed out waiting for final response (${this.options.timeoutMs}ms)`, ));

        }

      }, this.options.timeoutMs);

      this.pendingFinal = { submissionId, resolve, reject, timer };

    });

  }

  private clearPendingFinal(error?: Error) {

    if (!this.pendingFinal) {

      return;

    }

    clearTimeout(this.pendingFinal.timer);

    if (error) {

      this.pendingFinal.reject(error);

    }

    this.pendingFinal = null;

  }

  private patchTurn(id: string, patch: Partial<ChatTurn>) {

    this.messages = this.messages.map((m) => m.id === id ? { ...m, ...patch, id: patch.id ?? m.id } : m, ); // 'patches' to preserve the original id if not provided

  }

  private setError(error: Error) {

    this.error = error;

    this.emitEvent({ type: "error", error });
    this.emitState();

  }

  private emitState() {

    const state = this.state;

    for (const listener of this.stateListeners) {

      listener(state);

    }

    this.emitEvent({ type: "state", state });

  }

  private emitEvent(event: ChatSessionEvent) {

    for (const listener of this.eventListeners) {

      listener(event);

    }

  }

}

function resolveChatId(envelope: WsEnvelope, data: WsData): string | undefined {

  if (typeof data.chatId === "string") {

    return data.chatId;

  }

  if (typeof envelope.entityId === "string") {

    return envelope.entityId;

  }

  return undefined;

}
