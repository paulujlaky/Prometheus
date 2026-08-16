import { Component } from "react";
import { createRoot } from "react-dom/client";

import { initialAppState, type AppState, type NewEntry } from "@/Features/App/State";
import { statusLine, undoFor } from "@/Features/App/Status";
import { LiveSession } from "@/Features/App/Live";
import { SubagentStore } from "@/Features/App/Subagents";
import { Workspace } from "@/Features/App/Workspace";
import { lineStatsFromEntries } from "@/Features/Chat/Session";
import { streamStep } from "@/Features/Chat/Transcript";

import { contextLimitOf, displayName } from "@/Utils/Models";
import { sameDir } from "@/Utils/Paths";
import { usageOf } from "@/Utils/Tokens";

import type { AgentEvent } from "@/Agent/Agent";
import type { Approval, ApprovalMode, Ask, PlanRequest } from "@/Types/Bridge";
import type { SweChat } from "@/Types/Chat";
import type { Entry } from "@/Types/Transcript";
import type { RunRecap } from "@/Types/Recap";
import type { Answer } from "@/Tools/Ask";
import type { PlanDecision } from "@/Tools/Plan";
import type { Preferences } from "@/Utils/Prefs";

import "@/Types/Bridge";
import "./index.css";

export class App extends Component<{}, AppState> {

  state: AppState = initialAppState();

  private live = new LiveSession();
  private subs = new SubagentStore();

  private activeRunId: string | null = null;

  private runByChat = new Map<string, { runId: string; startedAt: number }>();
  private chatByRun = new Map<string, string>();
  private approvalsByRun = new Map<string, Approval>();
  private asksByRun = new Map<string, Ask>();
  private plansByRun = new Map<string, PlanRequest>();

  private chatForRun(runId: string): string | null {

    return this.chatByRun.get(runId) ?? (runId === this.activeRunId ? this.state.activeChatId : null);

  }

  private liveHooks() {

    return {

      state: this.state,
      setState: this.setState.bind(this),
      forceUpdate: () => this.forceUpdate(),

      activeRunId: this.activeRunId,

      runByChat: this.runByChat,
      chatByRun: this.chatByRun,

      onSubagent: (event: AgentEvent) => {

        if (this.activeRunId) {

          this.subs.apply(this.activeRunId, event, this.chatForRun(this.activeRunId), (chatId) => {

            if (chatId === this.state.activeChatId) this.forceUpdate();

          }, this.state.entries);

        }

      },

      push: (entry: NewEntry) => this.push(entry),

    };

  }

  private push(entry: NewEntry) {

    const id = this.live.nextId();

    this.setState((prev) => ({ entries: [...prev.entries, { ...entry, id } as Entry] }));

  }

  componentDidMount() {

    window.swe.onEvent(({ runId, event }) => {

      if (runId === this.activeRunId) {

        this.live.apply(event, this.liveHooks());

        return;

      }

      if (event.type === "subagent:start" || event.type === "subagent:event" || event.type === "subagent:end") {

        this.subs.apply(runId, event, this.chatForRun(runId), (chatId) => {

          if (chatId === this.state.activeChatId) this.forceUpdate();

        });

      }

    });

    window.swe.onApproval((approval) => {

      this.approvalsByRun.set(approval.runId, approval);
      if (approval.runId === this.activeRunId) this.setState({ approval });

    });

    window.swe.onAsk((ask) => {

      this.asksByRun.set(ask.runId, ask);
      if (ask.runId === this.activeRunId) this.setState({ ask });

    });

    window.swe.onPlan((plan) => {

      this.plansByRun.set(plan.runId, plan);
      if (plan.runId === this.activeRunId) this.setState({ plan });

    });

    window.swe.onRunEnded(({ runId }) => {

      const chatId = this.chatByRun.get(runId);

      if (chatId) {

        this.subs.settle(chatId, (id) => {

          if (id === this.state.activeChatId) this.forceUpdate();

        });

        this.runByChat.delete(chatId);

        if (chatId === this.state.activeChatId) {

          this.setState((prev) => {

            if (!prev.entries.some((entry) => entry.kind === "step" && (entry.streaming || entry.output === null))) {

              return null;

            }

            return {

              entries: prev.entries.map((entry) => (
                entry.kind === "step" && (entry.streaming || entry.output === null)
                  ? { ...entry, output: entry.output ?? "", streaming: false }
                  : entry
              )),
              stream: null,

            };

          });

        }

      }

      this.subs.forgetRun(runId);
      this.chatByRun.delete(runId);
      this.approvalsByRun.delete(runId);
      this.asksByRun.delete(runId);
      this.plansByRun.delete(runId);

      if (runId === this.activeRunId) {

        this.activeRunId = null;
        this.setState({ running: false, startedAt: null, approval: null, ask: null, plan: null, stream: null });

      }

    });

    void this.refreshChats();

    void Promise.all([window.swe.models(), window.swe.preferredModel(), window.swe.prefs()]).then(([assistants, preferredModelId, prefs]) => {

      const known = (id: string | null) => (id && assistants.some((assistant) => assistant.id === id) ? id : null);

      const chosen = known(prefs.defaultModelId) ?? known(preferredModelId) ?? assistants[0]?.id ?? null;

      this.setState((prev) => ({ assistants, prefs, assistantId: prev.assistantId ?? chosen }));

    }).catch((err) => this.push({ kind: "error", text: `Could not load models: ${String(err)}` }));

    void this.refreshUsage();
    void this.refreshRecaps();
    void window.swe.recentProjects().then((recentProjects) => this.setState({ recentProjects }));

  }

  private refreshUsage = async () => {

    try {

      const usage = await window.swe.usage();

      this.setState({ usage });

    } catch {

      // heatmap is best-effort; leave previous totals

    }

  };

  private refreshRecaps = async () => {

    try {

      const recaps = await window.swe.recaps();

      this.setState({ recaps });

    } catch {

      // the timeline keeps whatever it already has

    }

  };

  private refreshChats = async () => {

    this.setState({ chatsLoading: true });

    try {

      const chats = await window.swe.listChats(this.state.cwd);

      this.setState({ chats, chatsLoading: false });

    } catch {

      this.setState({ chatsLoading: false });

    }

  };

  private isOpen = (entry: Entry) => entry.kind === "step" && this.state.toggled.has(entry.id);

  private handleUndo = async (commit: string) => {

    const chatId = this.state.activeChatId;

    if (!chatId || this.state.undoBusy) {

      return;

    }

    this.setState({ undoBusy: commit });

    try {

      const report = await window.swe.undo(chatId, commit);

      if (!report.ok) {

        this.push({ kind: "error", text: report.text });

        return;

      }

      this.setState((prev) => ({

        undos: prev.undos.map((mark) => (mark.commit === commit ? { ...mark, undone: true } : mark)),
        notice: report.text,

      }));

    } catch (err) {

      this.push({ kind: "error", text: `Undo failed: ${String(err)}` });

    } finally {

      this.setState({ undoBusy: null });

    }

  };

  private toggle = (entry: Entry) => {

    this.setState((prev) => {

      const toggled = new Set(prev.toggled);

      if (toggled.has(entry.id)) {

        toggled.delete(entry.id);

      } else {

        toggled.add(entry.id);

      }

      return { toggled };

    });

  };

  private pickFolder = async () => {

    const picked = await window.swe.pickDir();

    if (!picked) {

      return;

    }

    await this.openProject(picked);

  };

  private openProject = async (dir: string): Promise<string | null> => {

    const opened = await window.swe.openProject(dir);
    if (!opened) return null;

    this.live.seq = 0;
    this.live.resetStream();

    this.setState({

      cwd: opened.dir,

      recentProjects: opened.recentProjects,

      chats: [],
      chatsLoading: true,
      activeChatId: null,

      entries: [],

      undos: [],
      undoBusy: null,

      stream: null,

      toggled: new Set(),

      approval: null,
      ask: null,

      tokensUsed: 0,

      agentStatus: this.state.running ? this.state.agentStatus : "",

      lastRun: null,
      notice: null,

    }, () => {

      void this.refreshChats();

    });

    return opened.dir;

  };

  private resolveApproval = (ok: boolean) => {

    const approval = this.state.approval;

    if (!approval) {

      return;

    }

    void window.swe.approve(approval.id, ok);
    this.setState({ approval: null });

  };

  private answerAsk = (answer: Answer) => {

    const ask = this.state.ask;

    if (!ask) {

      return;

    }

    void window.swe.answer(ask.id, answer);

    if (this.activeRunId) {

      this.asksByRun.delete(this.activeRunId);

    }

    this.setState({ ask: null });

  };

  private dismissAsk = () => {

    this.answerAsk({ picked: [], text: "", dismissed: true });

  };

  private decidePlan = (decision: PlanDecision) => {

    const plan = this.state.plan;

    if (!plan) {

      return;

    }

    void window.swe.decide(plan.id, decision);

    if (this.activeRunId) {

      this.plansByRun.delete(this.activeRunId);

    }

    const switched = decision.build && decision.assistantId && decision.assistantId !== this.state.assistantId;

    this.setState(switched ? { plan: null, assistantId: decision.assistantId } : { plan: null, assistantId: this.state.assistantId });

  };

  private dismissPlan = () => {

    this.decidePlan({ build: false, assistantId: "", modelLabel: "", note: "", dismissed: true });

  };

  private newSession = async () => {

    this.activeRunId = null;
    this.live.seq = 0;
    this.live.resetStream();

    const { prefs, assistants, assistantId } = this.state;
    const stored = prefs?.defaultModelId ?? null;
    const nextAssistant = stored && assistants.some((a) => a.id === stored) ? stored : assistantId;

    this.setState({

      assistantId: nextAssistant,

      entries: [],
      stream: null,

      toggled: new Set(),

      approval: null,
      ask: null,

      tokensUsed: 0,
      activeChatId: null,

      view: "chat",

      running: false,
      startedAt: null,

      agentStatus: "",

      lastRun: null,

      notice: null,

      undos: [],
      undoBusy: null,

    });

  };

  /** A card on the timeline knows its repo and its chat id, but not the chat row the sidebar holds. */
  private openRecapChat = async (recap: RunRecap) => {

    if (!recap.chatId) {

      return;

    }

    this.setState({ view: "chat" });

    try {

      const chats = await window.swe.listChats(recap.project);
      const hit = chats.find((row) => row.id === recap.chatId);

      if (!hit) {

        this.push({ kind: "error", text: "That session is no longer on record." });

        return;

      }

      this.setState({ chats });

      await this.selectChat(hit);

    } catch (err) {

      this.push({ kind: "error", text: `Could not open that session: ${String(err)}` });

    }

  };

  private selectChat = async (chat: SweChat) => {

    this.activeRunId = null;
    this.live.resetStream();

    this.setState({

      activeChatId: chat.id,
      view: "chat",
      agentStatus: "",

      lastRun: null,
      notice: null,
      stream: null,

      toggled: new Set(),

      approval: null,
      ask: null,

      tokensUsed: 0,

      running: false,
      startedAt: null,

      undos: [],
      undoBusy: null,

    });

    try {

      let cwd = this.state.cwd;
      const chatProject = chat.project?.trim() || null;

      if (chatProject) {

        const same = sameDir(cwd, chatProject);

        if (!same) {

          await window.swe.setCwd(chatProject);
          cwd = chatProject;
          this.setState({ cwd: chatProject });

        }

      } else if (this.state.cwd) {

        await window.swe.claimChat(chat.id, this.state.cwd);

      }

      const detail = await window.swe.getChat(chat.id);
      const entries = (detail.entries ?? []) as Entry[];
      const project = detail.project ?? chat.project ?? cwd ?? null;

      const live = this.runByChat.get(detail.id);

      this.activeRunId = live?.runId ?? null;

      this.live.seq = 0;
      this.live.syncSeq(entries);
      this.live.streamEntryId = null;

      this.setState((prev) => ({

        activeChatId: detail.id,
        entries,

        cwd: project,

        undos: detail.undos ?? [],

        assistantId: detail.modelId ?? prev.assistantId,

        running: Boolean(live),
        startedAt: live?.startedAt ?? null,

        approval: live ? this.approvalsByRun.get(live.runId) ?? null : null,
        ask: live ? this.asksByRun.get(live.runId) ?? null : null,

        agentStatus: live ? "Working" : "",

        lastRun: null,
        notice: null,

        chats: prev.chats.map((c) => (c.id === detail.id ? { ...c, title: detail.title || c.title, project, name: detail.name || c.name } : c)),

      }));

    } catch (err) {

      this.setState({

        entries: [],

        agentStatus: "",

        lastRun: null,
        notice: null,

      });

      this.push({ kind: "error", text: `Could not load session: ${err instanceof Error ? err.message : String(err)}` });

    }

  };

  private renameChat = async (chat: SweChat, name: string) => {

    try {

      await window.swe.renameChat(chat.id, name);

      this.setState((prev) => ({

        chats: prev.chats.map((item) => (

          item.id === chat.id ? { ...item, name, title: name } : item

        )),

      }));

    } catch (err) {

      this.push({ kind: "error", text: `Could not rename session: ${err instanceof Error ? err.message : String(err)}` });

    }

  };

  private deleteChat = async (chat: SweChat) => {

    try {

      await window.swe.deleteChat(chat.id);

      this.setState((prev) => ({

        chats: prev.chats.filter((c) => c.id !== chat.id),

        activeChatId: prev.activeChatId === chat.id ? null : prev.activeChatId,

        entries: prev.activeChatId === chat.id ? [] : prev.entries,
        notice: prev.activeChatId === chat.id ? null : prev.notice,

      }));

    } catch (err) {

      this.push({ kind: "error", text: `Could not delete session: ${err instanceof Error ? err.message : String(err)}` });

    }

  };

  private interject = async (task: string, imagePaths: string[] = []) => {

    this.live.seq += 1;

    this.setState((prev) => ({

      entries: [...prev.entries, {

        id: `e${this.live.seq}`,
        kind: "task" as const,

        text: task,
        attachments: imagePaths.length ? imagePaths : undefined,

      }],

    }));

    try {

      await window.swe.interject({

        runId: this.activeRunId!,
        text: task,
        imagePaths: imagePaths.length ? imagePaths : undefined,

      });

    } catch (err) {

      this.push({ kind: "error", text: err instanceof Error ? err.message : String(err) });

    }

  };

  private start = async (task: string, imagePaths: string[] = []) => {

    const { cwd, assistantId, mode, assistants, activeChatId, entries, running } = this.state;

    if (!cwd) {

      return;

    }

    if (running) {

      await this.interject(task, imagePaths);

      return;

    }

    const runId = crypto.randomUUID();
    this.activeRunId = runId;

    if (activeChatId) {

      const live = { runId, startedAt: Date.now() };

      this.runByChat.set(activeChatId, live);
      this.chatByRun.set(runId, activeChatId);

    }

    const model = assistants.find((a) => a.id === assistantId);
    const modelLabel = model ? displayName(model.name) : assistantId ?? undefined;

    const chatId = activeChatId ?? undefined;
    const followUp = Boolean(chatId);

    this.live.resetStream();

    if (followUp) {

      this.live.syncSeq(entries);

      const taskId = this.live.nextId();

      this.setState((prev) => ({

        entries: [...prev.entries, {

          id: taskId,
          kind: "task" as const,

          text: task,
          attachments: imagePaths.length ? imagePaths : undefined,

        }],

        running: true,

        startedAt: Date.now(),
        agentStatus: "Starting",
        notice: null,

        stream: null,
        approval: null,

      }));

    } else {

      this.live.seq = 0;

      this.setState({

        entries: [{

          id: this.live.nextId(),
          kind: "task",

          text: task,
          attachments: imagePaths.length ? imagePaths : undefined,

        }],

        running: true,

        startedAt: Date.now(),
        agentStatus: "Starting",
        notice: null,
        lastRun: null,

        toggled: new Set<string>(),
        tokensUsed: 0,

        stream: null,
        approval: null,

      });

    }

    try {

      await window.swe.start({

        runId,
        task,
        cwd,

        assistantId: assistantId ?? undefined,
        modelLabel,

        mode,

        chatId,
        imagePaths: imagePaths.length ? imagePaths : undefined,

      });

    } catch (err) {

      this.push({ kind: "error", text: err instanceof Error ? err.message : String(err) });

    } finally {

      if (this.activeRunId === runId) {

        this.activeRunId = null;
        this.live.streamEntryId = null;

        this.setState({ running: false, startedAt: null, approval: null, ask: null, stream: null });

      }

      const finishedChat = this.chatByRun.get(runId);
      if (finishedChat) this.runByChat.delete(finishedChat);

      this.chatByRun.delete(runId);
      this.approvalsByRun.delete(runId);
      this.asksByRun.delete(runId);
      this.plansByRun.delete(runId);

      void this.refreshChats();
      void this.refreshUsage();
      void this.refreshRecaps();

    }

  };

  render() {

    const { entries, assistantId, stream, tokensUsed, chats, running } = this.state;

    const model = this.state.assistants.find((a) => a.id === assistantId);
    const liveThought = this.live.streamStartedAt != null && this.live.thinkEndedAt != null ? this.live.thinkEndedAt - this.live.streamStartedAt : null;

    const liveStream = stream ?? (this.live.streamReasoning && running ? "" : null);
    const rows = this.subs.place(liveStream === null ? entries : [...entries, streamStep(liveStream, liveThought, this.live.streamReasoning, this.live.streamEntryId ?? "stream")], this.state.activeChatId);

    const limit = contextLimitOf(model ?? assistantId);
    const usage = usageOf(tokensUsed, limit);

    return (

      <Workspace

        state={this.state}
        rows={rows}
        status={statusLine(this.state)}
        usage={usage}
        diff={lineStatsFromEntries(rows)}

        chats={this.subs.sidebarRows(chats, this.state.cwd)}
        runningIds={[...this.runByChat.keys()]}

        isOpen={this.isOpen}
        undoFor={(entry) => undoFor(this.state, entry)}

        onSelect={(chat) => void this.selectChat(chat)}
        onRename={(chat, name) => void this.renameChat(chat, name)}
        onDelete={(chat) => void this.deleteChat(chat)}
        onNew={() => void this.newSession()}

        onOpenSettings={() => this.setState({ prefsOpen: true })}
        onCloseSettings={() => this.setState({ prefsOpen: false })}

        onOpenRecap={() => this.setState({ view: "recap" }, () => void this.refreshRecaps())}
        onOpenRecapChat={(recap) => void this.openRecapChat(recap)}
        onSavedPrefs={(prefs: Preferences) => this.setState({ prefs })}

        onOpenProject={(dir) => void this.openProject(dir)}
        onPickFolder={() => void this.pickFolder()}
        onModeChange={(next: ApprovalMode) => this.setState({ mode: next })}

        onToggle={this.toggle}
        onUndo={(commit) => void this.handleUndo(commit)}

        onResolve={this.resolveApproval}
        onAnswer={this.answerAsk}
        onDismissAsk={this.dismissAsk}
        onBuild={this.decidePlan}
        onDismissPlan={this.dismissPlan}

        onModelChange={(id) => this.setState({ assistantId: id })}
        onSend={(task, imagePaths) => void this.start(task, imagePaths)}
        onStop={() => { if (this.activeRunId) void window.swe.stop(this.activeRunId); }}
        onSpeedUp={() => { if (this.activeRunId) void window.swe.speedUp(this.activeRunId); }}

      />

    );

  }

}

createRoot(document.getElementById("root")!).render(<App />);
