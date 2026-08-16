import type { Tool } from "@/Agent/Parse";

export interface Step {

  id: string;
  kind: "step";

  tool: Tool | null;
  desc: string;

  thinking: string;
  thoughtMs?: number | null;

  command: string | null;

  output: string | null;
  exitCode: number | null;

  streaming: boolean;

}

export interface SubagentEntry {

  id: string;
  kind: "subagent";

  subId: string;
  spawnIndex: number;

  name: string;
  task: string;

  steps: Step[];

  note: string;

  status: "working" | "done" | "failed";
  summary: string;

}

export type Entry =
  | Step
  | SubagentEntry
  | { id: string; kind: "task"; text: string; attachments?: string[] }
  | { id: string; kind: "say"; text: string }
  | { id: string; kind: "done"; text: string }
  | { id: string; kind: "error"; text: string };

export type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
