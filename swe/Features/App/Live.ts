import { Component } from "react";

import { closeOpenSteps } from "@/Features/Chat/Session";
import { cleanSummary, parseReply } from "@/Features/Chat/Transcript";

import type { AppState, NewEntry } from "@/Features/App/State";
import type { AgentEvent } from "@/Agent/Agent";
import type { SweChat } from "@/Types/Chat";
import type { Entry } from "@/Types/Transcript";

export interface LiveHooks {

  state: AppState;
  setState: Component<{}, AppState>["setState"];
  forceUpdate: () => void;

  activeRunId: string | null;

  runByChat: Map<string, { runId: string; startedAt: number }>;
  chatByRun: Map<string, string>;

  onSubagent: (event: AgentEvent) => void;
  push: (entry: NewEntry) => void;

}

export class LiveSession {

  seq = 0;

  streamStartedAt: number | null = null;
  thinkEndedAt: number | null = null;
  streamReasoning = "";
  streamEntryId: string | null = null;
  pendingSnapshot: string | null = null;

  nextId(): string {

    return `e${(this.seq += 1)}`;

  }

  syncSeq(entries: Entry[]) {

    for (const entry of entries) {

      const n = entry.id.startsWith("e") ? Number(entry.id.slice(1)) : 0;

      if (Number.isFinite(n) && n > this.seq) {

        this.seq = n;

      }

    }

  }

  ensureStreamId(): string {

    if (this.streamEntryId == null) {

      this.streamEntryId = this.nextId();

    }

    return this.streamEntryId;

  }

  resetStream() {

    this.streamStartedAt = null;
    this.thinkEndedAt = null;
    this.streamReasoning = "";
    this.streamEntryId = null;

  }

  apply(event: AgentEvent, hooks: LiveHooks) {

    if (event.type === "status") {

      hooks.setState({ agentStatus: event.text });

      return;

    }

    if (event.type === "interjection") {

      return;

    }

    if (event.type === "usage") {

      hooks.setState({ tokensUsed: event.used });

      return;

    }

    if (event.type === "subagent:start" || event.type === "subagent:event" || event.type === "subagent:end") {

      if (hooks.activeRunId) {

        hooks.onSubagent(event);

      }

      return;

    }

    if (event.type === "snapshot") {

      this.pendingSnapshot = event.commit;

      return;

    }

    if (event.type === "session") {

      const project = hooks.state.cwd;

      const chat: SweChat = {

        id: event.chatId,
        name: event.title,
        title: event.title,
        modified: Date.now(),
        project: project ?? null,

      };

      if (hooks.activeRunId) {

        const run = {

          runId: hooks.activeRunId,
          startedAt: hooks.state.startedAt ?? Date.now(),

        };

        hooks.runByChat.set(event.chatId, run);
        hooks.chatByRun.set(hooks.activeRunId, event.chatId);

      }

      hooks.setState((prev) => ({

        activeChatId: event.chatId,
        chats: [chat, ...prev.chats.filter((c) => c.id !== event.chatId)],

      }));

      return;

    }

    if (event.type === "reasoning") {

      if (this.streamStartedAt == null) {

        this.streamStartedAt = Date.now();
        this.thinkEndedAt = null;

      }

      this.ensureStreamId();
      this.streamReasoning += event.text;

      hooks.forceUpdate();

      return;

    }

    if (event.type === "delta") {

      hooks.setState((prev) => {

        if (prev.stream === null) {

          this.streamStartedAt ??= Date.now();
          this.thinkEndedAt = null;
          this.ensureStreamId();

        }

        const stream = (prev.stream ?? "") + event.text;

        if (this.thinkEndedAt == null && parseReply(stream).tool !== null) {

          this.thinkEndedAt = Date.now();

        }

        return { stream };

      });

      return;

    }

    if (event.type === "assistant") {

      const { tool, desc, thinking: harnessThinking, command } = parseReply(event.text);

      const thinking = (event.reasoning ?? this.streamReasoning).trim() || harnessThinking;

      const thoughtMs = this.streamStartedAt != null ? Math.max(0, (this.thinkEndedAt ?? Date.now()) - this.streamStartedAt) : thinking.trim() ? Math.max(1000, Math.round(thinking.length / 50) * 1000) : null;

      const id = this.streamEntryId ?? this.nextId();

      this.resetStream();

      hooks.setState((prev) => ({

        entries: [...closeOpenSteps(prev.entries), {

          id,
          kind: "step",

          tool,
          desc,

          thinking,
          thoughtMs,

          command,
          output: null,
          exitCode: null,

          streaming: false,

        }],

        stream: null,

      }));

      return;

    }

    if (event.type === "command") {

      hooks.setState((prev) => {

        const last = prev.entries[prev.entries.length - 1];

        if (last?.kind === "step" && last.command === event.command) {

          return null;

        }

        if (last?.kind === "step" && last.command === null && last.output === null) {

          return { entries: [...closeOpenSteps(prev.entries.slice(0, -1)), { ...last, command: event.command }] };

        }

        const { tool, desc } = parseReply(event.command);

        const id = this.nextId();

        return { entries: [...closeOpenSteps(prev.entries), { id, kind: "step", tool, desc, thinking: "", command: event.command, output: null, exitCode: null, streaming: false }] };

      });

      return;

    }

    if (event.type === "observation") {

      hooks.setState((prev) => {

        for (let index = prev.entries.length - 1; index >= 0; index -= 1) {

          const entry = prev.entries[index];

          if (entry.kind === "subagent") {

            continue;

          }

          if (entry.kind === "step" && entry.output === null) {

            const entries = [...prev.entries];

            entries[index] = { ...entry, output: event.text, exitCode: event.exitCode };

            return { entries };

          }

          break;

        }

        const id = this.nextId();

        return { entries: [...prev.entries, { id, kind: "step", tool: null, desc: "", thinking: "", command: null, output: event.text, exitCode: event.exitCode, streaming: false }] };

      });

      return;

    }

    if (event.type === "say") {

      hooks.setState((prev) => {

        const last = prev.entries[prev.entries.length - 1];

        if (last?.kind === "step" && last.output === null) {

          return {

            entries: [...prev.entries.slice(0, -1), {

              ...last,

              tool: last.tool ?? "say",

              command: last.command ?? `<say>\n${event.text}\n</say>`,
              output: event.text,
              exitCode: 0,

              streaming: false,

            }],

          };

        }

        return { entries: [...closeOpenSteps(prev.entries), { id: this.nextId(), kind: "say", text: event.text }] };

      });

      return;

    }

    if (event.type === "done") {

      const commit = this.pendingSnapshot;
      const project = hooks.state.cwd ?? "";
      const doneId = this.nextId();

      hooks.setState((prev) => ({

        entries: [...closeOpenSteps(prev.entries), { id: doneId, kind: "done", text: cleanSummary(event.summary) }],
        lastRun: { id: doneId, ms: Date.now() - (prev.startedAt ?? Date.now()) },
        stream: null,

        undos: commit ? [...prev.undos, { commit, project, summary: event.summary, at: Date.now() }] : prev.undos,

      }));

      return;

    }

    hooks.push({ kind: "error", text: event.message });

  }

}
