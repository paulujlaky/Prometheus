import { contextBridge, ipcRenderer } from "electron";

import type { AgentEvent } from "./agent";
import type { AssistantSummary } from "../sdk/types";
import type { UsageFile } from "./usage";

export interface SweChatSummary {

  id: string;
  name: string;
  title: string;
  modified: number;

  /** Normalized project root, or null when unassigned / pre-project. */
  project?: string | null;

}

contextBridge.exposeInMainWorld("swe", {

  models: (): Promise<AssistantSummary[]> => ipcRenderer.invoke("models"),

  pickDir: (): Promise<string | null> => ipcRenderer.invoke("pick-dir"),
  lastCwd: (): Promise<string | null> => ipcRenderer.invoke("settings:last-cwd"),
  setCwd: (cwd: string): Promise<string | null> => ipcRenderer.invoke("settings:set-cwd", cwd),

  usage: (): Promise<UsageFile> => ipcRenderer.invoke("usage:get"),

  listChats: (projectDir?: string | null): Promise<SweChatSummary[]> =>
    ipcRenderer.invoke("chats:list", projectDir ?? null),

  deleteChat: (chatId: string): Promise<void> => ipcRenderer.invoke("chats:delete", chatId),

  getChat: (chatId: string): Promise<{
    id: string;
    name: string;
    title: string;
    project?: string | null;
    entries: unknown[];
  }> => ipcRenderer.invoke("chats:get", chatId),

  rememberChat: (chatId: string, projectDir?: string | null): Promise<void> =>
    ipcRenderer.invoke("chats:remember", chatId, projectDir ?? null),

  claimChat: (chatId: string, projectDir: string): Promise<void> =>
    ipcRenderer.invoke("chats:claim", chatId, projectDir),

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

    ipcRenderer.on("approval", (_e, request) => handler(request));

  },

});
