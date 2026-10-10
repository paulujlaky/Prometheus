// An agent's event log, regrouped into what a person reads: their messages, the agent's words, and the work folded away.

import { parseActions, type Verb } from "./protocol";
import type { AgentEvent, Routine } from "./types";

export interface Step {

  verb: Verb;
  label: string;

  ok: boolean | null;
  detail: string;

}

export type Item =

  | { kind: "user"; key: string; text: string }
  | { kind: "note"; key: string; text: string }
  | { kind: "say"; key: string; text: string }
  | { kind: "notify"; key: string; text: string }
  | { kind: "work"; key: string; steps: Step[]; seconds: number; live: boolean }
  | { kind: "page"; key: string; url: string; title: string }
  | { kind: "routine"; key: string; when: string; title: string }
  | { kind: "ask"; key: string; text: string; answer: "allowed" | "refused" | null }
  | { kind: "handoff"; key: string; text: string; answer: "done" | "skipped" | null }
  | { kind: "question"; key: string; text: string; answer: string | null }
  | { kind: "done"; key: string; text: string }
  | { kind: "error"; key: string; text: string };

const RESULT_HEAD = /^\[([a-z]+) (ok|failed)\]$/gm;
const PAGE_VERBS = new Set<Verb>(["open", "look", "click", "press", "tab", "submit", "handoff"]);

/** The title, or for a routine the agent left untitled, the task's first line. */
export const routineTitle = (routine: Routine) => routine.title || routine.task.split("\n")[0];

export const describeWatch = (target: string, minutes: string) => `${minutes === "60" ? "Hourly" : `Every ${minutes} min`}, watching ${/^https?:\/\//i.test(target) ? target.replace(/^https?:\/\//i, "").replace(/\/$/, "") : "a command"}`;

/** `[verb ok]` sections of one result event, in the order the blocks ran. */
function splitResults(text: string): { ok: boolean; text: string }[] {

  const heads = [...text.matchAll(RESULT_HEAD)];

  return heads.map((head, i) => ({

    ok: head[2] === "ok",
    text: text.slice(head.index! + head[0].length, heads[i + 1]?.index ?? text.length).replace(/\n\n\[harness\][\s\S]*$/, "").trim(),

  }));

}

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

  return watch ? { kind: "note", key, text: watch[1] ? `Watch: ${watch[1]}` : `Watch: ${watch[2]} changed` } : { kind: "user", key, text };

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

    const steps: Step[] = [];
    const after: Item[] = [];

    let pending: Step[] = [];
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

            items.push({ kind: "user", key, text: event.text });

          }

          break;

        case "say":
        case "notify":

          items.push({ kind: event.kind, key, text: event.text });
          break;

        case "assistant":

          // says get results too, so they stay in `pending` to keep results lined up with their blocks
          pending = parseActions(event.text).filter((action) => action.verb !== "done").map((action) => ({ verb: action.verb, label: action.label || `${action.verb} ${action.path}`.trim(), ok: null, detail: "" }));
          steps.push(...pending.filter((step) => step.verb !== "say" && step.verb !== "notify"));
          break;

        case "result": {

          const results = splitResults(event.text);

          pending.forEach((step, i) => {

            step.ok = results[i]?.ok ?? null;
            step.detail = results[i]?.text ?? "";

          });

          pending = [];
          break;

        }

        case "ask":

          after.push({ kind: "ask", key, text: event.text, answer: answer === null ? null : answer === "Allowed." ? "allowed" : "refused" });
          break;

        case "handoff":

          after.push({ kind: "handoff", key, text: event.text, answer: answer === null ? null : answer === "Done." ? "done" : "skipped" });
          break;

        case "question":

          after.push({ kind: "question", key, text: event.text, answer });
          break;

        default:

          ended = true;

          if (event.kind === "error" || event.text.trim().toLowerCase() !== "wait") {

            after.push({ kind: event.kind as "done" | "error", key, text: event.text });

          }

      }

    }

    const ran = steps.filter((step) => step.ok !== null || !ended);

    if (ran.length) {

      items.push({ kind: "work", key: `w${runId}`, steps: ran, seconds: Math.max(1, Math.round((run.at(-1)!.at - run[0].at) / 1000)), live: !ended && busy && runId === lastRun });

    }

    // a tab list is not a page
    const page = [...ran].reverse().find((step) => PAGE_VERBS.has(step.verb) && step.ok && /^https?:\/\//.test(step.detail));

    if (page) {

      const [url, title = ""] = page.detail.split("\n");

      items.push({ kind: "page", key: `p${runId}`, url, title });

    }

    ran.forEach((step, i) => {

      if (step.verb !== "routine" || !step.ok || !step.detail.startsWith("created routine")) {

        return;

      }

      // "schedule 0 9 * * 1-5, next Mon, Oct 5, 9:00 AM EDT — Morning digest"
      const [when, title = ""] = step.detail.replace(/^created routine \d+\s+/, "").split(/\s+—\s+/);
      const watch = /^watch (.+) every (\d+) min/.exec(when);
      const next = /, next (.+)$/.exec(when)?.[1];

      items.push({ kind: "routine", key: `r${runId}${i}`, when: watch ? describeWatch(watch[1], watch[2]) : next ? `Next ${next}` : "Never runs", title });

    });

    items.push(...after);

  }

  return items;

}
