import type { AgentEvent, GroupChat as StoredGroupChat, GroupMessage, Routine } from "../../Store";

export type { AgentEvent, GroupMessage, Routine };

/** A group thread; id 0 is Everyone, whose members are every agent. */
export type GroupChat = StoredGroupChat & { unread: number };

export type AgentState = "idle" | "queued" | "running" | "waiting";

/** The server's view of an agent: the stored row plus where it is in the queue. */
export interface Agent {

  id: number;
  name: string;

  modelId: string;
  persona: string;

  /** "shape:color" mascot, see Glyph.ts. */
  glyph: string;
  category: string;

  createdAt: number;

  state: AgentState;
  question: string | null;

  /** What a waiting agent waits on: an OK for a <submit>, the user in its browser, or an answer to an <ask>. */
  waitingOn: "ask" | "handoff" | "question" | null;

  /** Messages since its chat was last open. */
  unread: number;

}

/** The Boodle account the server's cookie belongs to. */
export interface Account {

  set: boolean;

  name: string | null;
  email: string | null;

}

export interface Model {

  id: string;
  name: string;

}

export type SocketMessage =

  | { type: "event"; event: AgentEvent }
  | { type: "delta"; agentId: number; text: string }
  | { type: "state"; agentId: number; state: AgentState }
  | { type: "group"; message: GroupMessage }
  | LiveEvent;

/** An agent's browser, streamed to whoever watches it. `mine` is whether this device has taken it over; `blank` means no page is open. */
export type LiveEvent =

  | { type: "frame"; agentId: number; data: Blob }
  | { type: "browser"; agentId: number; held?: boolean; mine?: boolean; blank?: boolean; error?: string }
  | { type: "tabs"; agentId: number; tabs: BrowserTab[] };

/** One of an agent's tabs. `live` is false while it is suspended to its URL. */
export type BrowserTab = { id: number; title: string; url: string; active: boolean; live: boolean };

export type LiveInput =

  | { kind: "click"; x: number; y: number }
  | { kind: "scroll"; x: number; y: number; dx: number; dy: number }
  | { kind: "text"; text: string }
  | { kind: "drag"; x: number; y: number; toX: number; toY: number }
  | { kind: "key"; key: string }
  | { kind: "back" };

export type LiveCommand =

  | { live: "watch"; agentId: number }
  | { live: "unwatch" }
  | { live: "take"; width?: number; height?: number }
  | { live: "give" }
  | { live: "input"; event: LiveInput }
  | { live: "tab"; action: "switch" | "close" | "new"; id?: number };

export interface LiveChannel {

  send: (command: LiveCommand) => void;
  subscribe: (listener: (event: LiveEvent) => void) => () => void;

}

export class Unauthorized extends Error {}

export async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {

  const res = await fetch(`/api${path}`, {

    method,
    credentials: "same-origin",

    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),

  });

  if (res.status === 401) {

    throw new Unauthorized("Signed out");

  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {

    throw new Error(data.error ?? `Request failed (${res.status})`);

  }

  return data as T;

}

/** Web push wants the VAPID key as raw bytes, not the base64url the server hands out. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {

  const base64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");

  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

}

export async function enablePush(): Promise<void> {

  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {

    throw new Error("This browser cannot receive notifications. On iPhone, add Prometheus to your home screen first.");

  }

  if ((await Notification.requestPermission()) !== "granted") {

    throw new Error("Notifications are blocked for this site. Allow them in your browser settings.");

  }

  const registration = await navigator.serviceWorker.ready;
  const { publicKey } = await api<{ publicKey: string }>("/push");
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });

  await api("/push", "POST", { subscription: subscription.toJSON() });

}

export async function pushEnabled(): Promise<boolean> {

  if (!("serviceWorker" in navigator) || !("PushManager" in window) || Notification.permission !== "granted") {

    return false;

  }

  return Boolean(await (await navigator.serviceWorker.ready).pushManager.getSubscription());

}
