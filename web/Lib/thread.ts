// An agent's event log, regrouped into what a person reads: their messages, the agent's words, and the work summed up.

import { splitAttached } from "./protocol";
import type { AgentEvent, Routine } from "./types";

export type Item =

  | { kind: "user"; key: string; text: string; files: string[] }
  | { kind: "note"; key: string; text: string }
  | { kind: "say"; key: string; text: string }
  | { kind: "card"; key: string; text: string }
  | { kind: "notify"; key: string; text: string }
  | { kind: "work"; key: string; steps: number; current: string; seconds: number; live: boolean }
  | { kind: "page"; key: string; url: string; title: string }
  | { kind: "routine"; key: string; when: string; title: string }
  | { kind: "ask"; key: string; text: string; answer: "allowed" | "refused" | null }
  | { kind: "handoff"; key: string; text: string; answer: "done" | "skipped" | null }
  | { kind: "question"; key: string; text: string; answer: string | null }
  | { kind: "done"; key: string; text: string }
  | { kind: "error"; key: string; text: string };

/** The title, or for a routine the agent left untitled, the task's first line. */
export const routineTitle = (routine: Routine) => routine.title || routine.task.split("\n")[0];

export const describeWatch = (target: string, minutes: string) => `${minutes === "60" ? "Hourly" : `Every ${minutes} min`}, watching ${/^https?:\/\//i.test(target) ? target.replace(/^https?:\/\//i, "").replace(/\/$/, "") : "a command"}`;

const userItem = (key: string, message: string): Item => ({ kind: "user", key, ...splitAttached(message) });

/** The harness wraps routine and group tasks; a person only needs to know where the task came from. */
function taskItem(event: AgentEvent): Item {

  const key = `t${event.id}`;
  const text = event.text;
  const group = /^\[Group thread "(.*?)"[\s\S]*?New message from ([^:\n]+):\n\n([\s\S]*?)(?:\n\nYour <done>|$)/.exec(text);
  const routine = /^\[Scheduled routine(?: "(.*?)")?: /.exec(text);
  const watch = /^\[Watch(?: "(.*?)")?: (.*?) changed/.exec(text);
  const direct = /^\[(Message|Reply) from ([^\]\n]+)\]\n\n([\s\S]*?)(?:\n\n\[[^\n]*\]$|$)/.exec(text);

  if (group) {

    return { kind: "note", key, text: `${group[2]} in ${group[1]}: ${group[3].trim()}` };

  }

  // another agent writing from its own chat, or answering what this one asked
  if (direct) {

    return { kind: "note", key, text: `${direct[2]}${direct[1] === "Reply" ? " replied" : ""}: ${direct[3].trim()}` };

  }

  if (routine) {

    return { kind: "note", key, text: `Routine: ${routine[1] ?? text.replace(/^\[[^\]]*\]\s*/, "").split("\n")[0]}` };

  }

  return watch ? { kind: "note", key, text: watch[1] ? `Watch: ${watch[1]}` : `Watch: ${watch[2]} changed` } : userItem(key, text);

}

/** "created routine 3 schedule 0 9 * * 1-5, next Mon, Oct 5, 9:00 AM EDT — Morning digest" */
function routineItem(key: string, text: string): Item {

  const [when, title = ""] = text.replace(/^created routine \d+\s+/, "").split(/\s+—\s+/);
  const watch = /^watch (.+) every (\d+) min/.exec(when);
  const next = /, next (.+)$/.exec(when)?.[1];

  return { kind: "routine", key, when: watch ? describeWatch(watch[1], watch[2]) : next ? `Next ${next}` : "Never runs", title };

}

/** What the user answered, from the event after the card's own. */
function answerOf(run: AgentEvent[], index: number): string | null {

  return run[index + 1]?.kind === "user" ? run[index + 1].text : null;

}

export function buildItems(events: AgentEvent[], busy: boolean): Item[] {

  const items: Item[] = [];
  const runs = new Map<string, AgentEvent[]>();
  const lastRun = events.at(-1)?.runId;

  for (const event of events) {

    runs.set(event.runId, [...(runs.get(event.runId) ?? []), event]);

  }

  for (const [runId, run] of runs) {

    const after: Item[] = [];
    const routines: Item[] = [];

    let steps = 0;
    let current = "";
    let page: Item | null = null;
    let ended = false;

    for (const [index, event] of run.entries()) {

      const key = `e${event.id}`;
      const answer = answerOf(run, index);

      switch (event.kind) {

        case "task":

          items.push(taskItem(event));
          break;

        case "user":

          // an approval's answer belongs to its card, not the chat
          if (!/^(ask|handoff|question)$/.test(run[index - 1]?.kind ?? "")) {

            items.push(userItem(key, event.text));

          }

          break;

        case "say":
        case "card":
        case "notify":

          items.push({ kind: event.kind, key, text: event.text });
          break;

        case "step":

          steps++;
          current = event.text;
          break;

        case "page": {

          const [url, title = ""] = event.text.split("\n");

          page = { kind: "page", key: `p${runId}`, url, title };
          break;

        }

        case "routine":

          routines.push(routineItem(key, event.text));
          break;

        case "ask":

          after.push({ kind: "ask", key, text: event.text, answer: answer === null ? null : answer === "Allowed." ? "allowed" : "refused" });
          break;

        case "handoff":

          after.push({ kind: "handoff", key, text: event.text, answer: answer === null ? null : answer === "Done." ? "done" : "skipped" });
          break;

        case "question":

          after.push({ kind: "question", key, text: event.text, answer });
          break;

        case "done":
        case "error":

          ended = true;

          if (event.kind === "error" || event.text.trim().toLowerCase() !== "wait") {

            after.push({ kind: event.kind, key, text: event.text });

          }

          break;

      }

    }

    if (steps) {

      items.push({ kind: "work", key: `w${runId}`, steps, current, seconds: Math.max(1, Math.round((run.at(-1)!.at - run[0].at) / 1000)), live: !ended && busy && runId === lastRun });

    }

    items.push(...(page ? [page] : []), ...routines, ...after);

  }

  return items;

}
