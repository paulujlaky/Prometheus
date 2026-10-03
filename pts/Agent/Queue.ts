import type { RunControl, RunListener } from "./Runner";
import type { Agent } from "../Store";

const MAX_RUNNING = Number(process.env.PTS_MAX_RUNNING ?? 3);

export type AgentState = "idle" | "queued" | "running";

export type StartRun = (agent: Agent, task: string, control: RunControl) => Promise<void>;

interface Job {

  agent: Agent;
  task: string;

}

interface Slot {

  controller: AbortController;
  notes: string[];

}

/** At most MAX_RUNNING agents think at once, one run per agent; everything else waits its turn in arrival order. */
export class Queue {

  private running = new Map<number, Slot>();
  private waiting: Job[] = [];

  constructor(private start: StartRun, private listen: RunListener, private onState: (agentId: number, state: AgentState) => void = () => {}, private limit = MAX_RUNNING) {}

  state(agentId: number): AgentState {

    if (this.running.has(agentId)) {

      return "running";

    }

    return this.waiting.some((job) => job.agent.id === agentId) ? "queued" : "idle";

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
  enqueue(agent: Agent, task: string) {

    const queued = this.waiting.find((job) => job.agent.id === agent.id);

    if (queued) {

      queued.task += `\n\n${task}`;
      return;

    }

    this.waiting.push({ agent, task });
    this.onState(agent.id, "queued");
    this.pump();

  }

  stop(agentId: number) {

    const before = this.waiting.length;

    this.waiting = this.waiting.filter((job) => job.agent.id !== agentId);
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
      const slot: Slot = { controller: new AbortController(), notes: [] };

      this.running.set(job.agent.id, slot);
      this.onState(job.agent.id, "running");

      const control: RunControl = { signal: slot.controller.signal, takeNotes: () => slot.notes.splice(0), listen: this.listen };

      this.start(job.agent, job.task, control).catch(() => {}).finally(() => {

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
