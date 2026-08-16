import { applyToSubagent, closeSteps, placeSubagents } from "@/Features/Chat/Session";
import { cleanSummary } from "@/Features/Chat/Transcript";

import type { AgentEvent } from "@/Agent/Agent";
import type { SweChat } from "@/Types/Chat";
import type { Entry, SubagentEntry } from "@/Types/Transcript";

export class SubagentStore {

  private subsByChat = new Map<string, SubagentEntry[]>();

  private spawnSeen = new Map<string, number>();

  private inSpawnBatch = new Set<string>();

  private subSeq = 0;

  forgetRun(runId: string) {

    this.spawnSeen.delete(runId);
    this.inSpawnBatch.delete(runId);

  }

  place(rows: Entry[], chatId: string | null): Entry[] {

    const cards = chatId ? this.subsByChat.get(chatId) : null;

    return cards?.length ? placeSubagents(rows, cards) : rows;

  }

  sidebarRows(chats: SweChat[], cwd: string | null): SweChat[] {

    const rows: SweChat[] = [];

    for (const [chatId, cards] of this.subsByChat) {

      for (const card of cards) {

        if (card.status !== "working") {

          continue;

        }

        rows.push({

          id: `sub:${card.subId}`,

          name: card.name,
          title: card.name,

          modified: Date.now(),
          project: cwd ?? null,

          parentId: chatId,
          subagent: true,

        });

      }

    }

    return rows.length ? [...chats, ...rows] : chats;

  }

  apply(runId: string, event: AgentEvent, chatId: string | null, onWrite: (chatId: string) => void) {

    if (!chatId) {

      return;

    }

    const cards = this.subsByChat.get(chatId) ?? [];

    if (event.type === "subagent:start") {

      if (!this.inSpawnBatch.has(runId)) {

        this.spawnSeen.set(runId, (this.spawnSeen.get(runId) ?? 0) + 1);
        this.inSpawnBatch.add(runId);

      }

      this.subSeq += 1;

      this.subsByChat.set(chatId, [...cards, {

        id: `sub${this.subSeq}`,
        kind: "subagent",

        subId: event.id,
        spawnIndex: Math.max(0, (this.spawnSeen.get(runId) ?? 1) - 1),

        name: event.name,
        task: event.task,

        steps: [],
        note: "",

        status: "working",
        summary: "",

      }]);

      onWrite(chatId);

      return;

    }

    this.inSpawnBatch.delete(runId);

    if (event.type === "subagent:event") {

      this.subsByChat.set(chatId, cards.map((card) => (

        card.subId === event.id ? applyToSubagent(card, event.event, () => `${card.id}-s${(this.subSeq += 1)}`) : card

      )));

      onWrite(chatId);

      return;

    }

    if (event.type === "subagent:end") {

      const status: SubagentEntry["status"] = event.ok ? "done" : "failed";

      this.subsByChat.set(chatId, cards.map((card) => (

        card.subId === event.id ? { ...card, steps: closeSteps(card.steps), note: "", status, summary: cleanSummary(event.summary) } : card

      )));

      onWrite(chatId);

    }

  }

  settle(chatId: string, onWrite: (chatId: string) => void): boolean {

    const cards = this.subsByChat.get(chatId);

    if (cards?.some((card) => card.status === "working")) {

      this.subsByChat.set(chatId, cards.map((card) => (

        card.status === "working" ? { ...card, steps: closeSteps(card.steps), note: "", status: "failed" as const, summary: card.summary || "The run ended before this subagent reported back." } : card

      )));

      onWrite(chatId);

      return true;

    }

    return false;

  }

}
