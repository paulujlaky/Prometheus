import type { AgentEvent, GroupMessage, Routine } from "../Store";

export type { AgentEvent, GroupMessage, Routine };

export type AgentState = "idle" | "queued" | "running" | "waiting";

/** The server's view of an agent: the stored row plus where it is in the queue. */
export interface Agent {

  id: number;
  name: string;

  modelId: string;
  persona: string;

  createdAt: number;

  state: AgentState;
  question: string | null;

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
  | { type: "group"; message: GroupMessage };

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
