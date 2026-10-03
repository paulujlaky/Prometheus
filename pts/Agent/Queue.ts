import type { RunControl, RunListener } from "./Runner";
import type { Origin } from "../Features/Group";
import type { Agent } from "../Store";

const MAX_RUNNING = Number(process.env.PTS_MAX_RUNNING ?? 3);

// a run waiting on the user still holds one of the MAX_RUNNING slots, so an unanswered question must end
const ANSWER_MS = Number(process.env.PTS_ANSWER_MS ?? 30 * 60_000);

export type AgentState = "idle" | "queued" | "running" | "waiting";

/** What a waiting run waits on: an OK for a <submit>, or the user doing something in the browser. */
export type WaitKind = "ask" | "handoff";

export type StartRun = (agent: Agent, task: string, control: RunControl, origin?: Origin) => Promise<unknown>;

interface Job {

  agent: Agent;
  task: string;

  origin?: Origin;

}

interface Slot {

  controller: AbortController;
  notes: string[];

  pending: { question: string; kind: WaitKind; answer: (allow: boolean) => void } | null;

  origin?: Origin;

}

/** At most MAX_RUNNING agents think at once, one run per agent; everything else waits its turn in arrival order. */
export class Queue {

  private running = new Map<number, Slot>();
  private waiting: Job[] = [];

  constructor(private start: StartRun, private listen: RunListener, private onState: (agentId: number, state: AgentState) => void = () => {}, private limit = MAX_RUNNING) {}

  state(agentId: number): AgentState {

    const slot = this.running.get(agentId);

    if (slot) {

      return slot.pending ? "waiting" : "running";

    }

    return this.waiting.some((job) => job.agent.id === agentId) ? "queued" : "idle";

  }

  /** Already running or queued for this group chain, so a hand-off to it would only repeat the work. */
  busyIn(agentId: number, chain: number): boolean {

    if (this.running.get(agentId)?.origin?.chain === chain) {

      return true;

    }

    return this.waiting.some((job) => job.agent.id === agentId && job.origin?.chain === chain);

  }

  /** The approval this agent is waiting on, if any. */
  question(agentId: number): string | null {

    return this.running.get(agentId)?.pending?.question ?? null;

  }

  waitingOn(agentId: number): WaitKind | null {

    return this.running.get(agentId)?.pending?.kind ?? null;

  }

  /** False when nothing was waiting, e.g. the question already timed out. `kind` limits it to one sort of wait. */
  answer(agentId: number, allow: boolean, kind?: WaitKind): boolean {

    const pending = this.running.get(agentId)?.pending;

    if (kind && pending?.kind !== kind) {

      return false;

    }

    pending?.answer(allow);

    return Boolean(pending);

  }

  /** What a chat message does: joins the agent's current run if there is one, otherwise starts a new one. */
  send(agent: Agent, text: string) {

    const slot = this.running.get(agent.id);

    if (slot) {

      slot.notes.push(text);
      return;

    }

    this.enqueue(agent, text);

  }

  /** A fresh run. Two waiting for the same agent fold into one, since the agent would only see them back to back. */
  enqueue(agent: Agent, task: string, origin?: Origin) {

    const queued = this.waiting.find((job) => job.agent.id === agent.id);

    if (queued) {

      queued.task += `\n\n${task}`;
      queued.origin ??= origin;
      return;

    }

    this.waiting.push({ agent, task, origin });
    this.onState(agent.id, "queued");
    this.pump();

  }

  stop(agentId: number) {

    const before = this.waiting.length;

    this.waiting = this.waiting.filter((job) => job.agent.id !== agentId);
    this.answer(agentId, false);
    this.running.get(agentId)?.controller.abort();

    if (before !== this.waiting.length && !this.running.has(agentId)) {

      this.onState(agentId, "idle");

    }

  }

  private pump() {

    while (this.running.size < this.limit) {

      const index = this.waiting.findIndex((job) => !this.running.has(job.agent.id));

      if (index === -1) {

        return;

      }

      const [job] = this.waiting.splice(index, 1);
      const slot: Slot = { controller: new AbortController(), notes: [], pending: null, origin: job.origin };
      const id = job.agent.id;

      this.running.set(job.agent.id, slot);
      this.onState(job.agent.id, "running");

      const ask = (question: string, kind: WaitKind = "ask") => new Promise<boolean>((resolve) => {

        const timer = setTimeout(() => slot.pending?.answer(false), ANSWER_MS);

        slot.pending = {

          question,
          kind,

          answer: (allow) => {

            clearTimeout(timer);
            slot.pending = null;
            this.onState(id, "running");
            resolve(allow);

          },

        };

        this.onState(id, "waiting");

      });

      const control: RunControl = { signal: slot.controller.signal, takeNotes: () => slot.notes.splice(0), listen: this.listen, ask };

      this.start(job.agent, job.task, control, job.origin).catch(() => {}).finally(() => {

        this.running.delete(job.agent.id);

        // a message that arrived after the agent's last step still deserves an answer
        if (slot.notes.length && !slot.controller.signal.aborted) {

          this.enqueue(job.agent, slot.notes.join("\n\n"));

        }

        this.onState(job.agent.id, this.state(job.agent.id));
        this.pump();

      });

    }

  }

}
