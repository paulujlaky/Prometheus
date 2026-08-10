import { contextBridge, ipcRenderer } from "electron";

import type { AgentEvent } from "./agent";
import type { AssistantSummary } from "../sdk/types";

contextBridge.exposeInMainWorld("swe", {

  models: (): Promise<AssistantSummary[]> => ipcRenderer.invoke("models"),

  pickDir: (): Promise<string | null> => ipcRenderer.invoke("pick-dir"),

  lastCwd: (): Promise<string | null> => ipcRenderer.invoke("settings:last-cwd"),

  start: (options: { task: string; cwd: string; assistantId?: string; mode: string }): Promise<void> => ipcRenderer.invoke("start", options),

  stop: (): Promise<void> => ipcRenderer.invoke("stop"),

  approve: (id: number, ok: boolean): Promise<void> => ipcRenderer.invoke("approve", { id, ok }),

  onEvent: (handler: (event: AgentEvent) => void) => {

    ipcRenderer.on("agent-event", (_e, event: AgentEvent) => handler(event));

  },

  onApproval: (handler: (request: { id: number; command: string; reason: string | null }) => void) => {

    ipcRenderer.on("approval", (_e, request: { id: number; command: string; reason: string | null }) => handler(request));

  },

});
