// What the server sends: these mirror the JSON of pts/server/store, field for field.

export type EventKind = "task" | "user" | "assistant" | "result" | "say" | "notify" | "ask" | "question" | "handoff" | "done" | "error";

export interface AgentEvent {

  id: number;
  agentId: number;
  runId: string;

  kind: EventKind;
  text: string;

  at: number;

}

/** `schedule` runs on a cron spec; `watch` checks `target` every `spec` minutes and runs only when it changes. */
export interface Routine {

  id: number;
  agentId: number;

  kind: "schedule" | "watch";
  spec: string;
  target: string;

  title: string;
  task: string;

  enabled: boolean;

  lastOutput: string | null;
  lastAt: number | null;

  /** When a schedule fires next; only the routine list carries it. */
  nextAt?: number | null;

}

/** `author` is "user", "system" or the agent's name; `agentId` is set only for agents. `groupId` 0 is Everyone. */
export interface GroupMessage {

  id: number;
  groupId: number;

  author: string;
  agentId: number | null;

  text: string;

  at: number;

}

export interface GroupChat {

  id: number;
  name: string;
  members: number[];

  createdAt: number;

}
