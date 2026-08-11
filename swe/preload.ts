import { contextBridge, ipcRenderer } from "electron";

import type { AgentEvent } from "./agent";
import type { AssistantSummary } from "../sdk/types";
import type { UsageFile } from "./usage";

export interface SweChatSummary {

  id: string;
  name: string;
  title: string;
  modified: number;

}

contextBridge.exposeInMainWorld("swe", {

  models: (): Promise<AssistantSummary[]> => ipcRenderer.invoke("models"),

  pickDir: (): Promise<string | null> => ipcRenderer.invoke("pick-dir"),
  lastCwd: (): Promise<string | null> => ipcRenderer.invoke("settings:last-cwd"),

  usage: (): Promise<UsageFile> => ipcRenderer.invoke("usage:get"),

  listChats: (): Promise<SweChatSummary[]> => ipcRenderer.invoke("chats:list"),
  deleteChat: (chatId: string): Promise<void> => ipcRenderer.invoke("chats:delete", chatId),
  getChat: (chatId: string): Promise<{ id: string; name: string; title: string; entries: unknown[] }> => ipcRenderer.invoke("chats:get", chatId),
  rememberChat: (chatId: string): Promise<void> => ipcRenderer.invoke("chats:remember", chatId),

  pickImages: (): Promise<string[]> => ipcRenderer.invoke("pick-images"),

  start: (options: {

    task: string;
    cwd: string;

    assistantId?: string;
    modelLabel?: string;

    mode: string;

    chatId?: string;
    imagePaths?: string[];

  }): Promise<void> => ipcRenderer.invoke("start", options),

  /** Inject a user message into the active run (queued until the next model turn). */
  interject: (options: { text: string; imagePaths?: string[] }): Promise<void> => ipcRenderer.invoke("interject", options),

  stop: (): Promise<void> => ipcRenderer.invoke("stop"),

  approve: (id: number, ok: boolean): Promise<void> => ipcRenderer.invoke("approve", { id, ok }),

  onEvent: (handler: (event: AgentEvent) => void) => {

    ipcRenderer.on("agent-event", (_e, event: AgentEvent) => handler(event));

  },

  onApproval: (handler: (request: { id: number; command: string; reason: string | null }) => void) => {

    ipcRenderer.on("approval", (_e, request: { id: number; command: string; reason: string | null }) => handler(request));

  },

});
