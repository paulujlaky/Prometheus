import type { WsData, WsEnvelope, WsOutbound } from "./types";

export type EnvelopeHandler = (envelope: WsEnvelope) => void;
export type SocketStatusHandler = (connected: boolean) => void;
export type SocketErrorHandler = (error: Error) => void;

export class BoodleSocket {

  readonly userId: string;

  private ws: WebSocket;

  private envelopeHandlers = new Set<EnvelopeHandler>();
  private statusHandlers = new Set<SocketStatusHandler>();
  private errorHandlers = new Set<SocketErrorHandler>();

  private openPromise: Promise<void>;

  private resolveOpen!: () => void;
  private rejectOpen!: (err: Error) => void;

  private intentionallyClosed = false;

  private constructor(ws: WebSocket, userId: string) {

    this.ws = ws;
    this.userId = userId;

    this.openPromise = new Promise<void>((resolve, reject) => {

      this.resolveOpen = resolve;
      this.rejectOpen = reject;

    });

    this.ws.addEventListener("open", () => {

      this.resolveOpen();
      this.emitStatus(true);

    });

    this.ws.addEventListener("message", (ev) => {

      this.onRawMessage(String(ev.data));

    });

    this.ws.addEventListener("error", () => {

      const err = new Error("WebSocket connection error");

      this.rejectOpen(err);
      this.emitError(err);

    });

    this.ws.addEventListener("close", () => {

      this.emitStatus(false);

      if (!this.intentionallyClosed) {

        this.emitError(new Error("WebSocket closed"));

      }

    });

  }

  static async connect(url: string, userId: string): Promise<BoodleSocket> {

    const ws = new WebSocket(url);
    const sock = new BoodleSocket(ws, userId);

    await sock.openPromise;

    return sock;

  }

  get connected(): boolean {

    return this.ws.readyState === WebSocket.OPEN;

  }

  onEnvelope(handler: EnvelopeHandler): () => void {

    this.envelopeHandlers.add(handler);

    return () => {

      this.envelopeHandlers.delete(handler);

    };

  }

  onStatus(handler: SocketStatusHandler): () => void {

    this.statusHandlers.add(handler);

    return () => {

      this.statusHandlers.delete(handler);

    };

  }

  onError(handler: SocketErrorHandler): () => void {

    this.errorHandlers.add(handler);

    return () => {

      this.errorHandlers.delete(handler);

    };

  }

  setActive(chatId: string) {

    this.send({

      chatId,
      userId: this.userId,

      type: "ChatMemberActive",

    });

  }

  setTyping(chatId: string) {

    this.send({

      chatId,
      userId: this.userId,

      type: "ChatMemberTyping",

    });

  }

  send(payload: WsOutbound) {

    if (!this.connected) {

      throw new Error("WebSocket is not open");

    }

    this.ws.send(JSON.stringify(payload));

  }

  close() {

    this.intentionallyClosed = true;
    this.ws.close();

  }

  private emitStatus(connected: boolean) {

    for (const handler of this.statusHandlers) {

      handler(connected);

    }

  }

  private emitError(error: Error) {

    for (const handler of this.errorHandlers) {

      handler(error);

    }

  }

  private onRawMessage(raw: string) {

    let parsed: unknown;

    try {

      parsed = JSON.parse(raw);

    } catch {

      return;

    }

    const envelope = normalizeEnvelope(parsed);

    if (!envelope) {

      return;

    }

    for (const handler of this.envelopeHandlers) {

      handler(envelope);

    }

  }

}

function normalizeEnvelope(parsed: unknown): WsEnvelope | null {

  if (parsed == null || typeof parsed !== "object") {

    return null;

  }

  const obj = parsed as Record<string, unknown>;

  // standard envelope. format is { data: { type, ... }, ... }
  if (obj.data != null && typeof obj.data === "object") {

    const data = obj.data as WsData;

    if (typeof data.type !== "string") {

      return null;

    }

    return {

      entityId: typeof obj.entityId === "string" ? obj.entityId : undefined,
      userId: typeof obj.userId === "string" ? obj.userId : undefined,

      timestamp: typeof obj.timestamp === "number" ? obj.timestamp : undefined,
      ticketId: obj.ticketId === null || typeof obj.ticketId === "string" ? (obj.ticketId as string | null) : undefined,

      data,

    };

  }

  // bare payload
  if (typeof obj.type === "string") {

    return {

      data: obj as WsData,

    };

  }

  return null;

}
