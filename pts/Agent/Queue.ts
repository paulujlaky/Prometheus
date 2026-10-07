import type { RunControl, RunListener } from "./Runner";
import type { Origin } from "../Features/Group";
import type { Agent } from "../Store";

const MAX_RUNNING = Number(process.env.PTS_MAX_RUNNING ?? 5);

// a run waiting on the user still holds one of the MAX_RUNNING slots, so an unanswered question must end
const ANSWER_MS = Number(process.env.PTS_ANSWER_MS ?? 30 * 60_000);

export type AgentState = "idle" | "queued" | "running" | "waiting";

/** What a waiting run waits on: an OK for a <submit>, the user doing something in the browser, or an answer to an <ask>. */
export type WaitKind = "ask" | "handoff" | "question";

/** Allow or refuse; an <ask> is answered in words, and refused when skipped. */
export type Reply = boolean | string;

export type StartRun = (agent: Agent, task: string, control: RunControl, origin?: Origin) => Promise<unknown>;

interface Job {

  agent: Agent;
  task: string;

  origin?: Origin;

}

interface Slot {

  userId: number;

  controller: AbortController;
  notes: string[];

  pending: { question: string; kind: WaitKind; answer: (reply: Reply) => void } | null;

  origin?: Origin;

}

/** At most MAX_RUNNING agents think at once across every user, one run per agent; everything else waits its turn. */
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
  busyIn = (agentId: number, chain: number) => this.running.get(agentId)?.origin?.chain === chain || this.waiting.some((job) => job.agent.id === agentId && job.origin?.chain === chain);

  /** What this agent is waiting on, if anything. */
  question = (agentId: number) => this.running.get(agentId)?.pending?.question ?? null;
  waitingOn = (agentId: number) => this.running.get(agentId)?.pending?.kind ?? null;

  /** False when nothing was waiting, e.g. the question already timed out. `kind` limits it to one sort of wait. */
  answer(agentId: number, reply: Reply, kind?: WaitKind): boolean {

    const pending = this.running.get(agentId)?.pending;

    if (kind && pending?.kind !== kind) {

      return false;

    }

    pending?.answer(reply);

    return Boolean(pending);

  }

  /** What a chat message does: joins the agent's current run if there is one, otherwise starts a new one. */
  send(agent: Agent, text: string) {

    const slot = this.running.get(agent.id);

    if (slot) {

      slot.notes.push(text);

    } else {

      this.enqueue(agent, text);

    }

  }

  /** A fresh run. Two waiting for the same agent fold into one, since the agent would only see them back to back. */
  enqueue(agent: Agent, task: string, origin?: Origin) {

    const queued = this.waiting.find((job) => job.agent.id === agent.id);

    if (queued) {

      // a routine that fires every minute behind a long run would otherwise pile up one copy per minute
      if (!queued.task.includes(task)) {

        queued.task += `\n\n${task}`;

      }

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

  /** The oldest job of whichever user has the fewest runs going, so one user's burst cannot take every slot on a shared host. */
  private next(): number {

    const load = (job: Job) => [...this.running.values()].filter((slot) => slot.userId === job.agent.userId).length;

    return this.waiting.reduce((best, job, index) => !this.running.has(job.agent.id) && (best === -1 || load(job) < load(this.waiting[best])) ? index : best, -1);

  }

  private pump() {

    while (this.running.size < this.limit) {

      const index = this.next();

      if (index === -1) {

        return;

      }

      const [job] = this.waiting.splice(index, 1);
      const slot: Slot = { userId: job.agent.userId, controller: new AbortController(), notes: [], pending: null, origin: job.origin };
      const id = job.agent.id;

      this.running.set(id, slot);
      this.onState(id, "running");

      const ask = (question: string, kind: WaitKind = "ask") => new Promise<Reply>((resolve) => {

        const timer = setTimeout(() => slot.pending?.answer(false), ANSWER_MS);

        slot.pending = {

          question,
          kind,

          answer: (reply) => {

            clearTimeout(timer);
            slot.pending = null;
            this.onState(id, "running");
            resolve(reply);

          },

        };

        this.onState(id, "waiting");

      });

      const control: RunControl = { signal: slot.controller.signal, takeNotes: () => slot.notes.splice(0), listen: this.listen, ask };

      this.start(job.agent, job.task, control, job.origin).catch((err) => console.error(`run for ${job.agent.name} failed:`, err)).finally(() => {

        this.running.delete(id);

        // a message that arrived after the agent's last step still deserves an answer
        if (slot.notes.length && !slot.controller.signal.aborted) {

          this.enqueue(job.agent, slot.notes.join("\n\n"));

        }

        this.onState(id, this.state(id));
        this.pump();

      });

    }

  }

}
