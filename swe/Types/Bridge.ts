import type { AgentEvent } from "@/Agent/Agent";
import type { Entry } from "@/Types/Transcript";
import type { SweChat } from "@/Types/Chat";
import type { RecapFile } from "@/Types/Recap";
import type { UsageFile } from "@/Types/Usage";
import type { Answer, Question } from "@/Tools/Ask";
import type { Plan, PlanDecision } from "@/Tools/Plan";
import type { UndoMark } from "@/Tools/Snapshot";
import type { Preferences } from "@/Utils/Prefs";

import type { AssistantSummary } from "../../sdk/types";

export type ApprovalMode = "ask" | "smart" | "auto";

export interface Approval {

  id: number;
  command: string;
  reason: string | null;

}

export interface Ask {

  id: number;
  question: Question;

}

export interface PlanRequest {

  id: number;
  plan: Plan;

}

export interface SweBridge {

  models: () => Promise<AssistantSummary[]>;
  preferredModel: () => Promise<string | null>;
  pickDir: () => Promise<string | null>;
  lastCwd: () => Promise<string | null>;
  setCwd: (cwd: string) => Promise<string | null>;
  recentProjects: () => Promise<{ dir: string; count: number }[]>;
  openProject: (cwd: string) => Promise<{ dir: string; recentProjects: { dir: string; count: number }[] } | null>;

  usage: () => Promise<UsageFile>;

  recaps: () => Promise<RecapFile>;

  prefs: () => Promise<Preferences>;
  setPrefs: (patch: Partial<Preferences>) => Promise<Preferences>;

  cookie: () => Promise<string | null>;
  setCookie: (cookie: string) => Promise<string>;

  undos: (chatId: string) => Promise<UndoMark[]>;
  undo: (chatId: string, commit: string) => Promise<{ ok: boolean; files: string[]; text: string }>;

  listChats: (projectDir?: string | null) => Promise<SweChat[]>;
  deleteChat: (chatId: string) => Promise<void>;
  renameChat: (chatId: string, name: string) => Promise<void>;

  getChat: (chatId: string) => Promise<{

    id: string;
    name: string;
    title: string;
    project?: string | null;
    modelId?: string | null;
    entries: Entry[];
    undos?: UndoMark[];

  }>;

  rememberChat: (chatId: string, projectDir?: string | null) => Promise<void>;
  claimChat: (chatId: string, projectDir: string) => Promise<void>;

  pickImages: () => Promise<string[]>;
  filePaths: (files: File[]) => string[];
  importImages: (files: File[]) => Promise<string[]>;

  start: (options: {

    runId: string;
    task: string;
    cwd: string;

    assistantId?: string;
    modelLabel?: string;

    mode: ApprovalMode;

    chatId?: string;
    imagePaths?: string[];

  }) => Promise<void>;

  interject: (options: { runId: string; text: string; imagePaths?: string[] }) => Promise<void>;
  speedUp: (runId: string) => Promise<void>;

  stop: (runId: string) => Promise<void>;

  approve: (id: number, ok: boolean) => Promise<void>;
  answer: (id: number, answer: Answer) => Promise<void>;
  decide: (id: number, decision: PlanDecision) => Promise<void>;

  onEvent: (handler: (message: { runId: string; event: AgentEvent }) => void) => void;
  onApproval: (handler: (request: Approval & { runId: string }) => void) => void;
  onAsk: (handler: (request: Ask & { runId: string }) => void) => void;
  onPlan: (handler: (request: PlanRequest & { runId: string }) => void) => void;
  onRunEnded: (handler: (message: { runId: string }) => void) => void;

}

declare global {

  interface Window {

    swe: SweBridge;

  }

}
