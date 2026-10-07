import { BoodleClient, ChatSession } from "../../sdk/index";

import { look, pageUrl, pinned } from "./Tools/Browser";
import type { Reply, WaitKind } from "./Queue";
import { execute } from "./Tools/Tools";
import { botInstructions, formatResults, NUDGE, parseActions, parseQuestion, taskMessage, type Action, type Result } from "./Protocol";
import { localTime, routineBlock } from "../Features/Routines";
import { addEvent, getAgentById, readMemory, readUserDoc, recentRuns, saveBot, trackChat, trackedChats, untrackChat, userZone, workspaceOf, type Agent, type AgentEvent } from "../Store";

const MAX_STEPS = Number(process.env.PTS_MAX_STEPS ?? 60);

// a model that will not emit a block usually keeps not emitting one; bail rather than burn the budget
const MAX_MISSES = 3;

// a wall of blocks is a model that has stopped looking at its results
const MAX_ACTIONS_PER_TURN = 8;

const RECENT_CHARS = 300;

// verbs whose output the model has to see before it can honestly report
const LOOKING = new Set(["run", "read", "grep", "ls", "open", "look", "click", "press", "tab", "submit", "handoff", "ask"]);

export type RunEvent = AgentEvent | { kind: "delta"; agentId: number; text: string };

export type RunListener = (event: RunEvent) => void;

export interface RunControl {

  signal: AbortSignal;

  /** Messages the user sent while this run was going; each call takes them. */
  takeNotes: () => string[];

  /** Parks the run until the user allows or refuses, hands the browser back, or answers a question; resolves false on stop or timeout. */
  ask: (question: string, kind?: WaitKind) => Promise<Reply>;

  listen: RunListener;

}

function clip(text: string): string {

  const one = text.replace(/\s+/g, " ").trim();

  return one.length > RECENT_CHARS ? `${one.slice(0, RECENT_CHARS - 1)}…` : one;

}

/** The agent's bot, re-minted when its persona or model changes, or when that bot is gone. Memory rides in each task instead. */
async function ensureBot(client: BoodleClient, agent: Agent): Promise<string> {

  const instructions = botInstructions(agent.name, agent.persona);
  const hash = Bun.hash(`${agent.modelId}\n${instructions}`).toString(36);

  // a delete in Boodle leaves the stored id behind, so reuse it only while the bot is still listed
  if (agent.botAssistantId && agent.botHash === hash && (await client.listCustomBotDrafts()).entries.some((entry) => entry.published?.id === agent.botAssistantId)) {

    return agent.botAssistantId;

  }

  const created = await client.createCustomBot({ name: `Prometheus · ${agent.name}`, modelId: agent.modelId, instructions, description: "Prometheus agent" });
  const assistantId = (await client.publishCustomBot(created.draft.id)).published?.id;

  if (!assistantId) {

    throw new Error("Boodle published the bot without an assistant id");

  }

  // the old bot is dead weight in the account, but losing it is not worth failing the run
  if (agent.botDraftId) {

    await client.deleteCustomBot(agent.botDraftId).catch(() => {});

  }

  saveBot(agent.id, created.draft.id, assistantId, hash);

  return assistantId;

}

/** Deletes the given chats from Boodle; one that fails stays tracked for the next sweep. */
export async function dropChats(client: BoodleClient, ids: string[]) {

  await Promise.all(ids.map(async (id) => {

    // already gone, or left behind on an account whose cookie was swapped out; retrying cannot help
    const done = await client.deleteChat(id).then(() => true, (err) => / (403|404) /.test(String(err)));

    if (done) {

      untrackChat(id);

    }

  }));

}

/** One task, start to <done>, in a fresh chat. Everything lands in the store as it happens; resolves with the ending event. */
export async function runAgent(client: BoodleClient, queued: Agent, task: string, control: RunControl): Promise<AgentEvent> {

  // the row may have changed while this run waited in the queue, e.g. an earlier run minted the bot
  const agent = getAgentById(queued.id) ?? queued;

  const { signal, listen } = control;
  const runId = crypto.randomUUID();
  const cwd = workspaceOf(agent);
  const zone = userZone(agent.userId);

  const record = (kind: AgentEvent["kind"], text: string) => {

    // an agent deleted mid-run is gone from the database; its run is already stopping and has nowhere to write
    const event = getAgentById(agent.id) ? addEvent(agent.id, runId, kind, text) : { id: 0, agentId: agent.id, runId, kind, text, at: Date.now() };

    listen(event);

    return event;

  };

  const check = () => {

    if (signal.aborted) {

      throw new Error("aborted");

    }

  };

  const wait = async (question: string, kind?: WaitKind) => {

    const reply = await control.ask(question, kind);

    check();

    return reply;

  };

  let notified = false;

  /** One block that is not <done>. A failed result stops the blocks behind it, except a refused <notify>. */
  async function step(action: Action): Promise<Result> {

    const body = action.body.trim();
    const line = body.split("\n")[0];
    const pass = (text: string): Result => ({ verb: action.verb, ok: true, text });
    const fail = (text: string): Result => ({ verb: action.verb, ok: false, text });

    switch (action.verb) {

      case "say":

        record("say", body);

        return pass("shown to the user");

      case "notify":

        // one buzz per task: a second would be the agent narrating, which is what the limit exists to stop
        if (notified || !line) {

          return fail(notified ? "You already notified the user this task. Put the rest in <done>." : "notify needs one line to send.");

        }

        notified = true;
        record("notify", line);

        return pass("sent to the user's phone");

      case "routine":

        return { verb: action.verb, ...routineBlock(agent, action.body) };

      case "submit": {

        if (!action.path || !body) {

          return fail("submit needs the button's ref on the tag and one line saying what it sends:\n\n  <submit e31>\n  Send the reply to Sam\n  </submit>");

        }

        const question = `${body}\n${await pageUrl(cwd)}`;

        record("ask", question);

        const allowed = (await wait(question)) === true;

        record("user", allowed ? "Allowed." : "Not allowed.");

        if (!allowed) {

          return fail("The user did not allow this. Do not send it another way. If the task cannot go on without it, say so in <done>.");

        }

        return { ...(await execute({ ...action, verb: "click" }, cwd, signal, zone)), verb: "submit" };

      }

      case "ask": {

        if (!parseQuestion(body).prompt) {

          return fail("ask needs the question on its first line, then any choices one per line:\n\n  <ask>\n  Which one?\n  - The first\n  - The second\n  </ask>");

        }

        record("question", body);

        const reply = await wait(body, "question");
        const answer = typeof reply === "string" ? reply.trim() : "";

        record("user", answer || "Skipped.");

        return pass(answer ? `The user answered: ${answer}` : "The user skipped the question. Decide it yourself and keep going.");

      }

      case "handoff": {

        if (!line) {

          return fail("handoff needs one line saying what the user should do in the browser.");

        }

        record("handoff", line);

        const finished = (await pinned(cwd, () => wait(line, "handoff"))) === true;

        record("user", finished ? "Done." : "Skipped.");

        if (!finished) {

          return fail("The user did not do it. If the task cannot go on without it, say so in <done>.");

        }

        // the page first, like every browser result, so the chat shows where the user left off
        return pass(`${await look(cwd, signal).catch((err: Error) => err.message)}\n\n[harness]\nThe user handed the browser back; this is the page as they left it.`);

      }

    }

    return execute(action, cwd, signal, zone);

  }

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

    check();

    // tracked before connecting, so a chat whose socket never opens is still cleaned up
    const chat = await client.createChat();

    trackChat(chat.id, agent.id, agent.userId);

    session = await ChatSession.open(client, chat.id, { assistantId, refreshOnComplete: false });

    session.on((event) => {

      if (event.type === "stream" && event.change.kind === "delta" && event.change.sectionType?.toLowerCase() !== "reasoning") {

        listen({ kind: "delta", agentId: agent.id, text: event.change.text });

      }

    });

    let message = taskMessage({ user: readUserDoc(agent.userId), memory: readMemory(agent), recent, now: `${localTime(Date.now(), zone)} (${zone})` }, task);
    let misses = 0;

    for (let turnNo = 1; turnNo <= MAX_STEPS; turnNo += 1) {

      const notes = control.takeNotes();

      notes.forEach((note) => record("user", note));

      if (notes.length) {

        message += `\n\n[user]\nThe user sent this while you were working — take it into account:\n\n${notes.join("\n\n")}`;

      }

      const turn = await session.send(message, { assistantId });

      record("assistant", turn.text);

      const actions = parseActions(turn.text);

      if (!actions.length) {

        misses += 1;

        if (misses >= MAX_MISSES) {

          return record("error", `${misses} replies in a row had no block, so nothing could run.`);

        }

        message = NUDGE;
        continue;

      }

      misses = 0;

      const results: Result[] = [];

      let unseen = false;
      let heldDone = false;

      for (const action of actions.slice(0, MAX_ACTIONS_PER_TURN)) {

        // a report written before the output came back can only guess at it
        if (action.verb === "done" && unseen) {

          heldDone = true;
          break;

        }

        if (action.verb === "done") {

          return record("done", action.body.trim() || "Done.");

        }

        unseen ||= LOOKING.has(action.verb);

        const result = await step(action);

        check();
        results.push({ ...result, verb: action.verb });

        // a failed block usually invalidates the ones behind it; let the model look first
        if (!result.ok && action.verb !== "notify") {

          break;

        }

      }

      const held = actions.length - results.length - (heldDone ? 1 : 0);

      message = formatResults(results);

      if (heldDone) {

        message += "\n\n[harness]\nYour <done> was held: it came before you had seen the output above. Check it, then send <done> with what actually happened.";

      }

      if (held > 0) {

        message += `\n\n[harness]\n${held} later ${held === 1 ? "block" : "blocks"} in that reply did not run. Send ${held === 1 ? "it" : "them"} again if still needed.`;

      }

      record("result", message);

    }

    return record("error", `Stopped after ${MAX_STEPS} steps without <done>.`);

  } catch (err) {

    return record("error", signal.aborted ? "Stopped by the user." : err instanceof Error ? err.message : String(err));

  } finally {

    signal.removeEventListener("abort", onAbort);
    session?.dispose();

    // an agent runs one task at a time, so every chat tracked for it is finished, including earlier failed deletes
    await dropChats(client, trackedChats(agent.userId, agent.id));

  }

}
