// An agent's event log, regrouped into what a person reads: their messages, the agent's words, and the work folded away.

import { parseActions, type Verb } from "../Agent/Protocol";
import type { AgentEvent } from "../Store";

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
  | { kind: "work"; key: string; steps: Step[]; seconds: number; live: boolean }
  | { kind: "page"; key: string; url: string; title: string }
  | { kind: "routine"; key: string; when: string; task: string }
  | { kind: "ask"; key: string; text: string; answer: "allowed" | "refused" | null }
  | { kind: "done"; key: string; text: string }
  | { kind: "error"; key: string; text: string };

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];

/** Common cron shapes in words; anything unusual stays as the raw spec, which is still exact. */
export function describeSchedule(spec: string): string {

  const parts = spec.trim().split(/\s+/);

  if (parts.length !== 5) {

    return spec;

  }

  const [minute, hour, day, month, weekday] = parts;

  if (day !== "*" || month !== "*") {

    return spec;

  }

  if (hour === "*" && weekday === "*") {

    const every = /^\*\/(\d+)$/.exec(minute)?.[1];

    return minute === "0" ? "Every hour" : every ? `Every ${every} min` : spec;

  }

  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) {

    return spec;

  }

  const time = `${hour}:${minute.padStart(2, "0")}`;

  if (weekday === "*") {

    return `Every day at ${time}`;

  }

  if (weekday === "1-5") {

    return `Weekdays at ${time}`;

  }

  if (weekday === "0,6" || weekday === "6,0") {

    return `Weekends at ${time}`;

  }

  return /^[0-7]$/.test(weekday) ? `${DAYS[Number(weekday)]} at ${time}` : spec;

}

export function describeWatch(target: string, minutes: string): string {

  const what = /^https?:\/\//i.test(target) ? target.replace(/^https?:\/\//i, "").replace(/\/$/, "") : "a command";

  return `${minutes === "60" ? "Hourly" : `Every ${minutes} min`}, watching ${what}`;

}

const RESULT_HEAD =/^\[([a-z]+) (ok|failed)\]$/gm;
const PAGE_VERBS = new Set<Verb>(["open", "look", "click", "press", "submit"]);

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

  if (text.startsWith("[Group thread")) {

    const said = /New message from ([^:\n]+):\n\n([\s\S]*?)(?:\n\nYour <done>|$)/.exec(text);

    return { kind: "note", key, text: said ? `${said[1]} in Everyone: ${said[2].trim()}` : "From Everyone" };

  }

  if (text.startsWith("[Scheduled routine")) {

    return { kind: "note", key, text: `Routine: ${text.replace(/^\[[^\]]*\]\s*/, "").split("\n")[0]}` };

  }

  if (text.startsWith("[Watch:")) {

    return { kind: "note", key, text: `Watch: ${/^\[Watch: (.*?) changed/.exec(text)?.[1] ?? "something"} changed` };

  }

  return { kind: "user", key, text };

}

export function buildItems(events: AgentEvent[], busy: boolean): Item[] {

  const items: Item[] = [];
  const runs = new Map<string, AgentEvent[]>();

  for (const event of events) {

    runs.set(event.runId, [...(runs.get(event.runId) ?? []), event]);

  }

  const lastRun = events[events.length - 1]?.runId;

  for (const [runId, run] of runs) {

    const steps: Step[] = [];
    const after: Item[] = [];

    let pending: Step[] = [];
    let ended = false;

    for (const [index, event] of run.entries()) {

      const key = `e${event.id}`;

      if (event.kind === "task") {

        items.push(taskItem(event));
        continue;

      }

      if (event.kind === "user") {

        const previous = run[index - 1];

        // an approval's answer belongs to its card, not the chat
        if (previous?.kind === "ask") {

          continue;

        }

        items.push({ kind: "user", key, text: event.text });
        continue;

      }

      if (event.kind === "say") {

        items.push({ kind: "say", key, text: event.text });
        continue;

      }

      if (event.kind === "assistant") {

        // says get results too, so they stay in `pending` to keep results lined up with their blocks
        pending = parseActions(event.text).filter((action) => action.verb !== "done").map((action) => ({

          verb: action.verb,
          label: action.label || `${action.verb} ${action.path}`.trim(),

          ok: null,
          detail: "",

        }));

        steps.push(...pending.filter((step) => step.verb !== "say"));
        continue;

      }

      if (event.kind === "result") {

        const results = splitResults(event.text);

        for (const [i, step] of pending.entries()) {

          step.ok = results[i]?.ok ?? null;
          step.detail = results[i]?.text ?? "";

        }

        pending = [];
        continue;

      }

      if (event.kind === "ask") {

        const answer = run[index + 1]?.kind === "user" ? (run[index + 1].text === "Allowed." ? "allowed" : "refused") : null;

        after.push({ kind: "ask", key, text: event.text, answer });
        continue;

      }

      ended = true;

      if (event.kind === "done" && event.text.trim().toLowerCase() !== "wait") {

        after.push({ kind: "done", key, text: event.text });

      }

      if (event.kind === "error") {

        after.push({ kind: "error", key, text: event.text });

      }

    }

    const ran = steps.filter((step) => step.ok !== null || !ended);

    if (ran.length) {

      const seconds = Math.max(1, Math.round((run[run.length - 1].at - run[0].at) / 1000));

      items.push({ kind: "work", key: `w${runId}`, steps: ran, seconds, live: !ended && busy && runId === lastRun });

    }

    const page = [...ran].reverse().find((step) => PAGE_VERBS.has(step.verb) && step.ok);

    if (page) {

      const [url, title] = page.detail.split("\n");

      items.push({ kind: "page", key: `p${runId}`, url, title: title ?? "" });

    }

    for (const step of ran) {

      if (step.verb === "routine" && step.ok && step.detail.startsWith("created routine")) {

        const [when, task = ""] = step.detail.replace(/^created routine \d+\s+/, "").split(/\s+—\s+/);

        const watch = /^watch (.+) every (\d+) min/.exec(when);

        items.push({ kind: "routine", key: `r${runId}${steps.indexOf(step)}`, when: watch ? describeWatch(watch[1], watch[2]) : describeSchedule(when.replace(/^schedule /, "")), task });

      }

    }

    items.push(...after);

  }

  return items;

}
