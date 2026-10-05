import type { Agent, GroupMessage } from "../Store";

// each agent-to-agent hand-off costs a full run; a loop of two polite agents would otherwise never end
export const MAX_HOPS = Number(process.env.PTS_MAX_HOPS ?? 6);

const RECENT_MESSAGES = 20;
const RECENT_CHARS = 600;

/** A chain starts at one user message; every hand-off it causes carries the count forward. */
export interface Origin {

  chain: number;
  hops: number;

  /** The thread replies go back to; 0 is Everyone. */
  group: number;

}

/** Agents named as `@Name`, longest names first so "@Scout Two" is not read as "@Scout". */
export function mentioned(text: string, agents: Agent[]): Agent[] {

  const lower = text.toLowerCase();
  const found: Agent[] = [];

  let rest = lower;

  for (const agent of [...agents].sort((a, b) => b.name.length - a.name.length)) {

    const tag = `@${agent.name.toLowerCase()}`;

    if (rest.includes(tag)) {

      found.push(agent);
      rest = rest.replaceAll(tag, "");

    }

  }

  return found;

}

export type Route = { recipients: Agent[]; origin: Origin } | { capped: true };

/**
 * Who a new group message wakes, out of the thread's `agents`.
 * The user: whoever they @mention, or everyone. An agent: only whom it @mentions, and never itself.
 */
export function route(message: GroupMessage, agents: Agent[], origin: Origin | null): Route {

  const named = mentioned(message.text, agents).filter((agent) => agent.id !== message.agentId);
  const group = message.groupId;

  if (message.agentId === null) {

    return { recipients: named.length ? named : agents, origin: { chain: message.id, hops: 0, group } };

  }

  if (!named.length) {

    return { recipients: [], origin: origin ?? { chain: message.id, hops: 0, group } };

  }

  const hops = (origin?.hops ?? 0) + 1;

  return hops > MAX_HOPS ? { capped: true } : { recipients: named, origin: { chain: origin?.chain ?? message.id, hops, group } };

}

/** `<done>wait</done>`: the agent's turn comes after someone else's, so there is nothing to post. */
export function isWaiting(done: string): boolean {

  return done.trim().toLowerCase().replace(/[.!]$/, "") === "wait";

}

function clip(text: string): string {

  return text.length > RECENT_CHARS ? `${text.slice(0, RECENT_CHARS - 1)}…` : text;

}

export function groupTask(agent: Agent, agents: Agent[], recent: GroupMessage[], message: GroupMessage, title = "Everyone"): string {

  const others = agents.filter((other) => other.id !== agent.id).map((other) => other.name);
  const history = recent.slice(-RECENT_MESSAGES).map((line) => `${line.author}: ${clip(line.text)}`).join("\n\n");

  return [

    `[Group thread "${title}". You share it with the user${others.length ? ` and the other agents: ${others.join(", ")}` : ""}.]`,
    history ? `Recent messages:\n\n${history}` : "",
    `New message from ${message.author}:\n\n${message.text}`,
    `Your <done> is posted to the thread as your reply, so keep it to a sentence, like a message in a group chat. To hand part of the work to another agent, @mention them in it and say what you need. Mention no one you do not need.`,
    `If your part has to wait for another agent's result, do nothing yet: reply with only <done>wait</done>. Nothing is posted, and you are woken when they @mention you.`,

  ].filter(Boolean).join("\n\n");

}
