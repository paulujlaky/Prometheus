import { MODE_KEY } from "@/Layout/Header";

import type { Approval, ApprovalMode, Ask, PlanRequest } from "@/Types/Bridge";
import type { SweChat } from "@/Types/Chat";
import type { Entry, WithoutId } from "@/Types/Transcript";
import type { RecapFile } from "@/Types/Recap";
import type { UsageFile } from "@/Types/Usage";
import type { UndoMark } from "@/Tools/Snapshot";
import type { Preferences } from "@/Utils/Prefs";

import type { AssistantSummary } from "../../../sdk/types";

export type NewEntry = WithoutId<Entry>;

export type AppView = "recap" | "chat";

export interface AppState {

  entries: Entry[];

  assistants: AssistantSummary[];
  assistantId: string | null;

  cwd: string | null;
  mode: ApprovalMode;

  running: boolean;
  startedAt: number | null;

  agentStatus: string;

  lastRun: { id: string; ms: number } | null;

  notice: string | null;

  stream: string | null;

  toggled: Set<string>;

  approval: Approval | null;
  ask: Ask | null;
  plan: PlanRequest | null;

  tokensUsed: number;

  usage: UsageFile;

  /** Recap is the home screen; selecting a chat or starting a session switches to "chat". */
  view: AppView;
  recaps: RecapFile;

  chats: SweChat[];
  chatsLoading: boolean;
  activeChatId: string | null;
  recentProjects: { dir: string; count: number }[];

  prefs: Preferences | null;
  prefsOpen: boolean;

  undos: UndoMark[];
  undoBusy: string | null;

}

export function initialAppState(): AppState {

  return {

    entries: [],

    assistants: [],
    assistantId: null,

    cwd: null,
    mode: (localStorage.getItem(MODE_KEY) as ApprovalMode | null) ?? "smart",

    running: false,
    startedAt: null,

    agentStatus: "",
    lastRun: null,
    notice: null,

    stream: null,

    toggled: new Set<string>(),

    approval: null,
    ask: null,
    plan: null,

    tokensUsed: 0,

    usage: {},

    view: "recap",
    recaps: {},

    chats: [],
    chatsLoading: true,
    activeChatId: null,
    recentProjects: [],

    prefs: null,
    prefsOpen: false,

    undos: [],
    undoBusy: null,

  };

}
