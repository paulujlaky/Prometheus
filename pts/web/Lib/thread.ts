// An agent's event log, regrouped into what a person reads: their messages, the agent's words, and the work folded away.

import { parseActions, type Verb } from "../../Agent/Protocol";
import type { AgentEvent, Routine } from "../../Store";

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
  | { kind: "done"; key: string; text: string }
  | { kind: "error"; key: string; text: string };

/** The title, or for routines made before titles, the task's first line. */
export function routineTitle(routine: Routine): string {

  return routine.title || routine.task.split("\n")[0];

}

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function ordinal(day: number): string {

  const teen = day % 100;
  const ending = teen >= 11 && teen <= 13 ? "th" : ["th", "st", "nd", "rd"][day % 10] ?? "th";

  return `${day}${ending}`;

}

/** 12-hour clock. Midnight and noon read as words; other times keep the minutes. */
function clock(hourText: string, minuteText: string): string | null {

  const hour = Number(hourText);
  const minute = Number(minuteText);

  if (!/^\d{1,2}$/.test(hourText) || !/^\d{1,2}$/.test(minuteText) || hour > 23 || minute > 59) {

    return null;

  }

  if (minute === 0 && (hour === 0 || hour === 12)) {

    return hour ? "noon" : "midnight";

  }

  return `${hour % 12 || 12}:${minuteText.padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;

}

function dayPhrase(weekday: string): string | null {

  if (weekday === "*") {

    return "Every day";

  }

  if (weekday === "1-5") {

    return "Weekdays";

  }

  if (weekday === "0,6" || weekday === "6,0") {

    return "Weekends";

  }

  if (/^[0-7]$/.test(weekday)) {

    return DAYS[Number(weekday)];

  }

  const range = /^([0-7])-([0-7])$/.exec(weekday);

  if (range && Number(range[1]) <= Number(range[2])) {

    return `${DAYS[Number(range[1])]} to ${DAYS[Number(range[2])]}`;

  }

  const days = weekday.split(",");

  if (days.length > 1 && days.every((day) => /^[0-7]$/.test(day))) {

    const names = days.map((day) => DAYS[Number(day)]);

    return names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

  }

  return null;

}

function scheduleWords(spec: string): string {

  const parts = spec.trim().split(/\s+/);

  if (parts.length !== 5) {

    return spec;

  }

  const [minute, hour, day, month, weekday] = parts;

  if (day === "*" && month === "*" && weekday === "*") {

    if (hour === "*") {

      if (minute === "0") {

        return "Every hour";

      }

      const every = /^\*\/(\d+)$/.exec(minute)?.[1];

      if (every) {

        return every === "1" ? "Every minute" : `Every ${every} min`;

      }

      if (/^\d{1,2}$/.test(minute) && Number(minute) < 60) {

        return `Every hour at :${minute.padStart(2, "0")}`;

      }

    }

    const everyHour = minute === "0" ? /^\*\/(\d+)$/.exec(hour)?.[1] : undefined;

    if (everyHour) {

      return everyHour === "1" ? "Every hour" : `Every ${everyHour} hours`;

    }

  }

  const time = clock(hour, minute);

  if (!time) {

    return spec;

  }

  if (day === "*" && month === "*") {

    const days = dayPhrase(weekday);

    return days ? `${days} at ${time}` : spec;

  }

  if (weekday === "*" && month === "*" && /^\d{1,2}$/.test(day)) {

    const date = Number(day);

    return date >= 1 && date <= 31 ? `The ${ordinal(date)} of every month at ${time}` : spec;

  }

  if (weekday === "*" && /^\d{1,2}$/.test(day) && /^\d{1,2}$/.test(month)) {

    const date = Number(day);
    const monthIndex = Number(month) - 1;

    if (date >= 1 && date <= 31 && monthIndex >= 0 && monthIndex < 12) {

      return `${MONTHS[monthIndex]} ${ordinal(date)} at ${time}`;

    }

  }

  return spec;

}

/** Short label such as EDT. Empty when the name is not a real zone. */
export function zoneLabel(timeZone: string, at = new Date()): string {

  try {

    return new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? "";

  } catch {

    return "";

  }

}

/** Common cron shapes in words. A time zone adds its abbreviation. Anything unusual stays as the raw spec. */
export function describeSchedule(spec: string, timeZone?: string | null): string {

  const words = scheduleWords(spec);

  if (!timeZone || words === spec) {

    return words;

  }

  const zone = zoneLabel(timeZone);

  return zone ? `${words} ${zone}` : words;

}

export function describeWatch(target: string, minutes: string): string {

  const what = /^https?:\/\//i.test(target) ? target.replace(/^https?:\/\//i, "").replace(/\/$/, "") : "a command";

  return `${minutes === "60" ? "Hourly" : `Every ${minutes} min`}, watching ${what}`;

}

const RESULT_HEAD =/^\[([a-z]+) (ok|failed)\]$/gm;
const PAGE_VERBS = new Set<Verb>(["open", "look", "click", "press", "submit", "handoff"]);

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

    const title = /^\[Scheduled routine "(.*?)": /.exec(text)?.[1];

    return { kind: "note", key, text: `Routine: ${title ?? text.replace(/^\[[^\]]*\]\s*/, "").split("\n")[0]}` };

  }

  const watch = /^\[Watch(?: "(.*?)")?: (.*?) changed/.exec(text);

  if (watch) {

    return { kind: "note", key, text: watch[1] ? `Watch: ${watch[1]}` : `Watch: ${watch[2]} changed` };

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
        if (previous?.kind === "ask" || previous?.kind === "handoff") {

          continue;

        }

        items.push({ kind: "user", key, text: event.text });
        continue;

      }

      if (event.kind === "say" || event.kind === "notify") {

        items.push({ kind: event.kind, key, text: event.text });
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

        steps.push(...pending.filter((step) => step.verb !== "say" && step.verb !== "notify"));
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

      if (event.kind === "handoff") {

        const answer = run[index + 1]?.kind === "user" ? (run[index + 1].text === "Done." ? "done" : "skipped") : null;

        after.push({ kind: "handoff", key, text: event.text, answer });
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

        const [when, title = ""] = step.detail.replace(/^created routine \d+\s+/, "").split(/\s+—\s+/);

        const watch = /^watch (.+) every (\d+) min/.exec(when);

        items.push({ kind: "routine", key: `r${runId}${steps.indexOf(step)}`, when: watch ? describeWatch(watch[1], watch[2]) : describeSchedule(when.replace(/^schedule /, "")), title });

      }

    }

    items.push(...after);

  }

  return items;

}
