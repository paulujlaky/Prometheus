import { ipcMain } from "electron";

import { MiniAgent, riskReason } from "../Agent/Agent";
import { getClient } from "./Client";
import { alertUser, NOTICES } from "./Alerts";
import { chatTitle } from "./Chats";
import { loadPreferences, rememberChatId, rememberChatSettings, settingsForChat } from "./Settings";
import { recordRecap } from "./Recap";
import { flushDeltas, send } from "./Stream";
import { diffStat, recordMark } from "../Tools/Snapshot";
import { shortModelName } from "../Utils/Models";
import { sendToRenderer } from "./Window";

import type { Answer } from "../Tools/Ask";
import type { Plan, PlanDecision } from "../Tools/Plan";
import type { ApprovalMode } from "../Types/Bridge";
import type { RecapDraft } from "../Types/Recap";

const agents = new Map<string, MiniAgent>();

const approvals = new Map<number, { runId: string; resolve: (ok: boolean) => void }>();

let approvalSeq = 0;

const asks = new Map<number, { runId: string; resolve: (answer: Answer) => void }>();

let askSeq = 0;

const plans = new Map<number, { runId: string; resolve: (decision: PlanDecision) => void }>();

let planSeq = 0;

const DISMISSED: Answer = { picked: [], text: "", dismissed: true };

const UNDECIDED: PlanDecision = { build: false, assistantId: "", modelLabel: "", note: "", dismissed: true };

function rejectPending(runId: string) {

  for (const [id, pending] of approvals) {

    if (pending.runId !== runId) continue;

    pending.resolve(false);
    approvals.delete(id);

  }

  for (const [id, pending] of asks) {

    if (pending.runId !== runId) continue;

    pending.resolve(DISMISSED);
    asks.delete(id);

  }

  for (const [id, pending] of plans) {

    if (pending.runId !== runId) continue;

    pending.resolve(UNDECIDED);
    plans.delete(id);

  }

}

export function registerRunIpc() {

  ipcMain.handle("start", async (_event, options: {

    runId: string;
    task: string;
    cwd: string;

    assistantId?: string;
    modelLabel?: string;

    mode: ApprovalMode;

    chatId?: string;
    imagePaths?: string[];

  }) => {

    if (!options.runId || agents.has(options.runId)) {

      throw new Error("This session is already running");

    }

    let notifyTitle = chatTitle(options.task.split(/\s+/).slice(0, 8).join(" "));

    const startedAt = Date.now();

    let snapshotCommit: string | null = null;
    let markChatId = options.chatId ?? null;
    let recapDraft: RecapDraft | null = null;

    const prefs = loadPreferences();

    const agent = new MiniAgent({

      client: getClient(),
      cwd: options.cwd,

      maxSteps: prefs.maxSteps,
      commandTimeoutMs: prefs.commandTimeoutMs,

      assistantId: options.assistantId,
      botAssistantId: options.chatId ? settingsForChat(options.chatId).botAssistantId ?? undefined : undefined,
      modelLabel: options.modelLabel,

      onEvent: (event) => {

        if (event.type === "snapshot") {

          snapshotCommit = event.commit;

        }

        if (event.type === "recap") {

          recapDraft = event.draft;

        }

        if (event.type === "done" && snapshotCommit && markChatId) {

          recordMark(markChatId, { commit: snapshotCommit, project: options.cwd, summary: event.summary, at: Date.now() });

        }

        if (event.type === "done" && recapDraft) {

          const stat = snapshotCommit ? diffStat(options.cwd, snapshotCommit) : { added: 0, removed: 0 };

          recordRecap({

            id: options.runId,

            headline: recapDraft.headline,

            changed: recapDraft.changed,
            unverified: recapDraft.unverified,

            risk: recapDraft.risk,

            project: options.cwd,
            chatId: markChatId,

            model: shortModelName(options.modelLabel ?? options.assistantId ?? ""),

            at: Date.now(),
            durationMs: Date.now() - startedAt,

            commit: snapshotCommit,

            added: stat.added,
            removed: stat.removed,

          });

        }

        if (event.type === "session") {

          markChatId = event.chatId;

          rememberChatId(event.chatId, options.cwd);
          rememberChatSettings(event.chatId, options.cwd, options.assistantId ?? null, event.botAssistantId ?? null);

          if (event.title.trim() && event.title.trim().toLowerCase() !== "new chat") {

            notifyTitle = chatTitle(event.title);

          }

        }

        send(options.runId, event);
        if (event.type === "done") alertUser(notifyTitle, NOTICES.done);

      },

      approve: (command) => {

        const reason = riskReason(command);

        if (options.mode === "auto" || (options.mode === "smart" && !reason)) {

          return Promise.resolve(true);

        }

        const id = (approvalSeq += 1);

        return new Promise<boolean>((resolve) => {

          approvals.set(id, { runId: options.runId, resolve });

          flushDeltas(options.runId);

          sendToRenderer("approval", { runId: options.runId, id, command, reason });
          alertUser(notifyTitle, reason ? NOTICES.approvalRisky : NOTICES.approval);

        });

      },

      ask: (question) => {

        const id = (askSeq += 1);

        return new Promise<Answer>((resolve) => {

          asks.set(id, { runId: options.runId, resolve });

          flushDeltas(options.runId);

          sendToRenderer("ask", { runId: options.runId, id, question });
          alertUser(notifyTitle, NOTICES.ask);

        });

      },

      plan: (plan: Plan) => {

        const id = (planSeq += 1);

        return new Promise<PlanDecision>((resolve) => {

          plans.set(id, { runId: options.runId, resolve });

          flushDeltas(options.runId);

          sendToRenderer("plan", { runId: options.runId, id, plan });
          alertUser(notifyTitle, NOTICES.plan);

        });

      },

    });

    agents.set(options.runId, agent);

    try {

      if (options.chatId) {

        rememberChatId(options.chatId, options.cwd);
        rememberChatSettings(options.chatId, options.cwd, options.assistantId ?? null, settingsForChat(options.chatId).botAssistantId);

      }

      await agent.run(options.task, {

        chatId: options.chatId,
        imagePaths: options.imagePaths,

      });

    } finally {

      agents.delete(options.runId);

      rejectPending(options.runId);

      flushDeltas(options.runId);
      sendToRenderer("run-ended", { runId: options.runId });

    }

  });

  ipcMain.handle("approve", (_event, { id, ok }: { id: number; ok: boolean }) => {

    const pending = approvals.get(id);

    approvals.delete(id);
    pending?.resolve(ok);

  });

  ipcMain.handle("answer", (_event, { id, answer }: { id: number; answer: Answer }) => {

    const pending = asks.get(id);

    asks.delete(id);
    pending?.resolve(answer);

  });

  ipcMain.handle("decide", (_event, { id, decision }: { id: number; decision: PlanDecision }) => {

    const pending = plans.get(id);

    plans.delete(id);
    pending?.resolve(decision);

  });

  ipcMain.handle("stop", (_event, runId: string) => {

    rejectPending(runId);
    agents.get(runId)?.stop();

  });

  ipcMain.handle("speed-up", (_event, runId: string) => {

    const agent = agents.get(runId);

    if (!agent) {

      throw new Error("No run in progress");

    }

    agent.speedUp();

  });

  ipcMain.handle("interject", (_event, options: { runId: string; text: string; imagePaths?: string[] }) => {

    const agent = agents.get(options.runId);

    if (!agent) {

      throw new Error("No run in progress");

    }

    agent.interject(options.text ?? "", options.imagePaths ?? []);

  });

}
