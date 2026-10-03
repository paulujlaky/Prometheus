import { BoodleClient, ChatSession } from "../../sdk/index";

import { execute } from "./Tools";
import { botInstructions, formatResults, NUDGE, parseActions, taskMessage, type Result } from "./Protocol";
import { addEvent, getAgentById, readMemory, readUserDoc, recentRuns, saveBot, workspaceOf, type Agent, type AgentEvent } from "../Store";

const MAX_STEPS = Number(process.env.PTS_MAX_STEPS ?? 60);

// a model that will not emit a block usually keeps not emitting one; bail rather than burn the budget
const MAX_MISSES = 3;

// a wall of blocks is a model that has stopped looking at its results
const MAX_ACTIONS_PER_TURN = 8;

const RECENT_CHARS = 300;

export type RunEvent = AgentEvent | { kind: "delta"; agentId: number; text: string };

export type RunListener = (event: RunEvent) => void;

export interface RunControl {

  signal: AbortSignal;

  /** Messages the user sent while this run was going; each call takes them. */
  takeNotes: () => string[];

  listen: RunListener;

}

function clip(text: string, max = RECENT_CHARS): string {

  const one = text.replace(/\s+/g, " ").trim();

  return one.length > max ? `${one.slice(0, max - 1)}…` : one;

}

/** The agent's bot, re-minted only when its persona or model changes. Memory rides in each task instead. */
async function ensureBot(client: BoodleClient, agent: Agent): Promise<string> {

  const instructions = botInstructions(agent.name, agent.persona);
  const hash = Bun.hash(`${agent.modelId}\n${instructions}`).toString(36);

  if (agent.botAssistantId && agent.botHash === hash) {

    return agent.botAssistantId;

  }

  const created = await client.createCustomBot({

    name: `Prometheus · ${agent.name}`,
    modelId: agent.modelId,
    instructions,
    description: "Prometheus agent",

  });

  const published = await client.publishCustomBot(created.draft.id);
  const assistantId = published.published?.id;

  if (!assistantId) {

    throw new Error("Boodle published the bot without an assistant id");

  }

  if (agent.botDraftId) {

    // the old bot is dead weight in the account, but losing it is not worth failing the run
    await client.deleteCustomBot(agent.botDraftId).catch(() => {});

  }

  saveBot(agent.id, created.draft.id, assistantId, hash);

  return assistantId;

}

/** One task, start to <done>, in a fresh chat. Everything the agent did lands in the store as it happens. */
export async function runAgent(client: BoodleClient, queued: Agent, task: string, control: RunControl): Promise<void> {

  // the row may have changed while this run waited in the queue, e.g. an earlier run minted the bot
  const agent = getAgentById(queued.id) ?? queued;

  const { signal, listen } = control;
  const runId = crypto.randomUUID();
  const cwd = workspaceOf(agent);

  const record = (kind: AgentEvent["kind"], text: string) => listen(addEvent(agent.id, runId, kind, text));

  const recent = recentRuns(agent.id).map((run) => `- ${new Date(run.at).toISOString().slice(0, 16).replace("T", " ")} — ${clip(run.task)} → ${clip(run.outcome) || "no outcome"}`);

  record("task", task);

  let session: ChatSession | null = null;

  // a stop has to reach a reply that is still streaming, not just the gap between steps
  const onAbort = () => {

    session?.cancel().catch(() => {});
    session?.dispose();

  };

  signal.addEventListener("abort", onAbort, { once: true });

  try {

    const assistantId = await ensureBot(client, agent);

    if (signal.aborted) {

      throw new Error("aborted");

    }

    session = await ChatSession.create(client, { assistantId, refreshOnComplete: false, reuseEmpty: false });

    session.on((event) => {

      if (event.type === "stream" && event.change.kind === "delta" && event.change.sectionType?.toLowerCase() !== "reasoning") {

        listen({ kind: "delta", agentId: agent.id, text: event.change.text });

      }

    });

    let message = taskMessage({ user: readUserDoc(), memory: readMemory(agent), recent }, task);
    let misses = 0;

    for (let step = 1; step <= MAX_STEPS; step += 1) {

      const notes = control.takeNotes();

      for (const note of notes) {

        record("user", note);

      }

      if (notes.length) {

        message += `\n\n[user]\nThe user sent this while you were working — take it into account:\n\n${notes.join("\n\n")}`;

      }

      const turn = await session.send(message, { assistantId });

      record("assistant", turn.text);

      const actions = parseActions(turn.text);

      if (!actions.length) {

        misses += 1;

        if (misses >= MAX_MISSES) {

          record("error", `${misses} replies in a row had no block, so nothing could run.`);
          return;

        }

        message = NUDGE;
        continue;

      }

      misses = 0;

      const batch = actions.slice(0, MAX_ACTIONS_PER_TURN);
      const results: Result[] = [];

      for (const action of batch) {

        if (action.verb === "done") {

          record("done", action.body.trim() || "Done.");
          return;

        }

        if (action.verb === "say") {

          record("say", action.body.trim());
          results.push({ verb: "say", ok: true, text: "shown to the user" });
          continue;

        }

        const result = await execute(action, cwd, signal);

        if (signal.aborted) {

          throw new Error("aborted");

        }

        results.push(result);

        // a failed block usually invalidates the ones behind it; let the model look first
        if (!result.ok) {

          break;

        }

      }

      const held = actions.length - results.length;

      message = formatResults(results);

      if (held > 0) {

        message += `\n\n[harness]\n${held} later ${held === 1 ? "block" : "blocks"} in that reply did not run. Send ${held === 1 ? "it" : "them"} again if still needed.`;

      }

      record("result", message);

    }

    record("error", `Stopped after ${MAX_STEPS} steps without <done>.`);

  } catch (err) {

    record("error", signal.aborted ? "Stopped by the user." : err instanceof Error ? err.message : String(err));

  } finally {

    signal.removeEventListener("abort", onAbort);
    session?.dispose();

  }

}
