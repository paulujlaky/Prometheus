import { getWindow } from "./Window";

import type { AgentEvent } from "../Agent/Agent";

const deltaBuffers = new Map<string, string>();
const deltaTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function flushDeltas(runId: string) {

  const timer = deltaTimers.get(runId);

  if (timer) {

    clearTimeout(timer);
    deltaTimers.delete(runId);

  }

  const text = deltaBuffers.get(runId);

  if (text) {

    getWindow()?.webContents.send("agent-event", { runId, event: { type: "delta", text } });
    deltaBuffers.delete(runId);

  }

}

export function send(runId: string, event: AgentEvent) {

  if (event.type === "delta") {

    deltaBuffers.set(runId, (deltaBuffers.get(runId) ?? "") + event.text);
    if (!deltaTimers.has(runId)) deltaTimers.set(runId, setTimeout(() => flushDeltas(runId), 60));

    return;

  }

  flushDeltas(runId);

  getWindow()?.webContents.send("agent-event", { runId, event });

}
