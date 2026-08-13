import { contextBridge, ipcRenderer, webUtils } from "electron";

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
  modelId?: string | null;

}

contextBridge.exposeInMainWorld("swe", {

  models: (): Promise<AssistantSummary[]> => ipcRenderer.invoke("models"),

  pickDir: (): Promise<string | null> => ipcRenderer.invoke("pick-dir"),
  lastCwd: (): Promise<string | null> => ipcRenderer.invoke("settings:last-cwd"),
  setCwd: (cwd: string): Promise<string | null> => ipcRenderer.invoke("settings:set-cwd", cwd),
  recentProjects: (): Promise<{ dir: string; count: number }[]> => ipcRenderer.invoke("settings:recent-projects"),
  openProject: (cwd: string): Promise<{ dir: string; recentProjects: { dir: string; count: number }[] } | null> => ipcRenderer.invoke("settings:open-project", cwd),

  usage: (): Promise<UsageFile> => ipcRenderer.invoke("usage:get"),

  listChats: (projectDir?: string | null): Promise<SweChatSummary[]> =>
    ipcRenderer.invoke("chats:list", projectDir ?? null),

  deleteChat: (chatId: string): Promise<void> => ipcRenderer.invoke("chats:delete", chatId),
  renameChat: (chatId: string, name: string): Promise<void> => ipcRenderer.invoke("chats:rename", chatId, name),

  getChat: (chatId: string): Promise<{
    id: string;
    name: string;
    title: string;
    project?: string | null;
    modelId?: string | null;
    entries: unknown[];
  }> => ipcRenderer.invoke("chats:get", chatId),

  rememberChat: (chatId: string, projectDir?: string | null): Promise<void> =>
    ipcRenderer.invoke("chats:remember", chatId, projectDir ?? null),

  claimChat: (chatId: string, projectDir: string): Promise<void> =>
    ipcRenderer.invoke("chats:claim", chatId, projectDir),

  pickImages: (): Promise<string[]> => ipcRenderer.invoke("pick-images"),
  filePaths: (files: File[]): string[] => files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
  importImages: async (files: File[]): Promise<string[]> => {
    const imported = await Promise.all(files.map(async (file) => ({
      path: webUtils.getPathForFile(file),
      name: file.name,
      bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
    })));
    return ipcRenderer.invoke("import-images", imported);
  },

  start: (options: {

    runId: string;
    task: string;
    cwd: string;

    assistantId?: string;
    modelLabel?: string;

    mode: string;

    chatId?: string;
    imagePaths?: string[];

  }): Promise<void> => ipcRenderer.invoke("start", options),

  /** Inject a user message into the active run (queued until the next model turn). */
  interject: (options: { runId: string; text: string; imagePaths?: string[] }): Promise<void> => ipcRenderer.invoke("interject", options),

  stop: (runId: string): Promise<void> => ipcRenderer.invoke("stop", runId),

  approve: (id: number, ok: boolean): Promise<void> => ipcRenderer.invoke("approve", { id, ok }),

  onEvent: (handler: (message: { runId: string; event: AgentEvent }) => void) => {

    ipcRenderer.on("agent-event", (_e, message) => handler(message));

  },

  onApproval: (handler: (request: { runId: string; id: number; command: string; reason: string | null }) => void) => {

    ipcRenderer.on("approval", (_e, request) => handler(request));

  },

  onRunEnded: (handler: (message: { runId: string }) => void) => {
    ipcRenderer.on("run-ended", (_e, message) => handler(message));
  },

});
