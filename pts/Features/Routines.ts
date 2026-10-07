import { runShell } from "../Agent/Tools/Shell";
import { createRoutine, deleteRoutine, getAgentById, listRoutines, markRoutine, userZone, workspaceOf, type Agent, type Routine } from "../Store";

const FIELDS = [

  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "weekday", min: 0, max: 7 },

];

const MAX_OUTPUT = 20_000;
const MAX_DIFF_LINES = 60;
const CHECK_TIMEOUT_MS = 120_000;

export interface Cron {

  sets: Set<number>[];

  // standard cron: when both day fields are restricted, either one matching is enough
  anyDay: boolean;
  anyWeekday: boolean;

}

export function parseCron(spec: string): Cron {

  const parts = spec.trim().split(/\s+/);

  if (parts.length !== 5) {

    throw new Error("A schedule is five fields — minute hour day month weekday — like 0 8 * * 1-5");

  }

  const sets = parts.map((part, i) => {

    const { name, min, max } = FIELDS[i];
    const set = new Set<number>();

    for (const item of part.split(",")) {

      const [range, stepText] = item.split("/");
      const step = stepText === undefined ? 1 : Number(stepText);
      const [lo, hi] = range === "*" ? [min, max] : range.includes("-") ? range.split("-").map(Number) : [Number(range), stepText === undefined ? Number(range) : max];

      if (![lo, hi, step].every(Number.isInteger) || lo < min || hi > max || lo > hi || step < 1) {

        throw new Error(`"${item}" is not a valid ${name} in "${spec}"`);

      }

      for (let value = lo; value <= hi; value += step) {

        set.add(value);

      }

    }

    return set;

  });

  // 7 is Sunday too
  if (sets[4].has(7)) {

    sets[4].add(0);

  }

  return { sets, anyDay: parts[2] === "*", anyWeekday: parts[4] === "*" };

}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// five years: the longest wait a cron can name is a February 29th
const SEARCH_MS = 5 * 366 * 86_400_000;

export function isTimeZone(zone: string): boolean {

  try {

    return Boolean(Intl.DateTimeFormat("en-US", { timeZone: zone }));

  } catch {

    return false;

  }

}

const clocks = new Map<string, Intl.DateTimeFormat>();

/** The wall clock at `at` in `zone`. */
export function clockOf(at: number, zone: string) {

  const format = clocks.get(zone) ?? new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });

  clocks.set(zone, format);

  const parts = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]));

  return { minute: Number(parts.minute), hour: Number(parts.hour), day: Number(parts.day), month: Number(parts.month), weekday: WEEKDAY_INDEX[parts.weekday] };

}

/** The first whole minute after `after` that `cron` names on `zone`'s wall clock; null for a date that never comes, like February 30th. */
export function nextRun(cron: Cron, zone: string, after: number): number | null {

  const [minutes, hours, days, months, weekdays] = cron.sets;

  for (let at = Math.floor(after / 60_000) * 60_000 + 60_000; at < after + SEARCH_MS;) {

    const clock = clockOf(at, zone);
    const day = days.has(clock.day);
    const weekday = weekdays.has(clock.weekday);
    const dayMatches = cron.anyDay || cron.anyWeekday ? day && weekday : day || weekday;

    if (months.has(clock.month) && dayMatches && hours.has(clock.hour)) {

      if (minutes.has(clock.minute)) {

        return at;

      }

      at += 60_000;
      continue;

    }

    // on to the top of the next hour; clocks change on the hour, so a skipped stretch never hides a matching minute
    at += (60 - clock.minute) * 60_000;

  }

  return null;

}

/** How the agent and its notes read a time: on the user's clock, with the zone's short name. */
export function localTime(at: number, zone: string): string {

  return new Date(at).toLocaleString("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });

}

/** When a routine next fires; null for watches and paused ones. */
export function nextAt(routine: Routine, zone: string, now = Date.now()): number | null {

  return routine.kind === "schedule" && routine.enabled ? nextRun(parseCron(routine.spec), zone, now) : null;

}

/** Minutes between checks; anything below one would hammer the target for nothing. */
export function parseInterval(spec: string): number {

  const minutes = Number(spec);

  if (!Number.isInteger(minutes) || minutes < 1) {

    throw new Error("A watch interval is a whole number of minutes, 1 or more");

  }

  return minutes;

}

export function validateRoutine(kind: unknown, spec: string, target: string) {

  if (kind === "schedule") {

    parseCron(spec);
    return;

  }

  if (kind !== "watch") {

    throw new Error("kind must be schedule or watch");

  }

  parseInterval(spec);

  if (!target.trim()) {

    throw new Error("A watch needs a target: a URL, or a command whose output to compare");

  }

}

/** Roughly what a reader sees. Markup churn (tokens, script hashes) would otherwise look like a change every check. */
export function visibleText(html: string): string {

  return html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|p|div|li|tr|h\d|section|article|header|footer)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");

}

/** URLs are fetched by the server (the user wrote them); commands run in the agent's sandbox. */
export async function observe(routine: Routine, agent: Agent): Promise<string> {

  if (/^https?:\/\//i.test(routine.target.trim())) {

    const res = await fetch(routine.target.trim(), { signal: AbortSignal.timeout(30_000), redirect: "follow" });
    const body = await res.text();
    const type = res.headers.get("content-type") ?? "";

    return `status ${res.status}\n${type.includes("html") ? visibleText(body) : body}`.slice(0, MAX_OUTPUT);

  }

  const { output, exitCode } = await runShell(routine.target, workspaceOf(agent), undefined, CHECK_TIMEOUT_MS, userZone(agent.userId));

  return `exit ${exitCode}\n${output}`.slice(0, MAX_OUTPUT);

}

/** Lines that appeared and disappeared — what the agent needs to judge the change, without both full copies. */
export function lineChanges(before: string, after: string): string {

  const old = new Set(before.split("\n"));
  const now = new Set(after.split("\n"));

  const section = (title: string, lines: string[]) => lines.length ? `${title}:\n${lines.slice(0, MAX_DIFF_LINES).map((line) => `  ${line}`).join("\n")}${lines.length > MAX_DIFF_LINES ? `\n  ... ${lines.length - MAX_DIFF_LINES} more` : ""}` : "";

  return [

    section("Added", [...now].filter((line) => !old.has(line))),
    section("Removed", [...old].filter((line) => !now.has(line))),

  ].filter(Boolean).join("\n\n") || "Only the order of lines changed.";

}

/** The title, or for a routine the agent left untitled, the task's first line. */
export const routineTitle = (routine: Routine) => routine.title || routine.task.split("\n")[0];

export function routineTask(routine: Routine, zone: string, changes?: string): string {

  // the chat reads the quoted title back out of this header
  const named = routine.title ? ` "${routine.title}"` : "";
  const quiet = "The user is not watching; tell them only what matters, in a sentence, and <notify> only if it is worth interrupting them.";

  return routine.kind === "schedule"
    ? `[Scheduled routine${named}: ${routine.spec}, ${localTime(Date.now(), zone)}. ${quiet}]\n\n${routine.task}`
    : `[Watch${named}: ${routine.target} changed. ${quiet}]\n\n${routine.task}\n\n${changes}`;

}

const BLOCK_KEY = /^\s*(schedule|watch|every|title|task|remove)\s*:\s*(.*)$/i;

// an agent that schedules itself in a loop would quietly multiply its own runs
const MAX_PER_AGENT = 20;

function describe(routine: Routine, zone: string): string {

  const next = nextAt(routine, zone);
  const when = routine.kind === "schedule" ? `schedule ${routine.spec}${next ? `, next ${localTime(next, zone)}` : ""}` : `watch ${routine.target} every ${routine.spec} min`;

  return `${routine.id}  ${when}${routine.enabled ? "" : "  (paused)"}  — ${routineTitle(routine)}`;

}

/**
 * The agent's own `<routine>` block. A bare one lists its routines; `remove: 3` deletes one;
 * `schedule:` or `watch:` + `every:` with a `title:` and `task:` creates one. Everything after `task:` is the task.
 */
export function routineBlock(agent: Agent, body: string): { ok: boolean; text: string } {

  const fields = new Map<string, string>();

  let task: string[] | null = null;

  for (const line of body.split("\n")) {

    if (task) {

      task.push(line);
      continue;

    }

    const match = BLOCK_KEY.exec(line);

    if (!match) {

      continue;

    }

    if (match[1].toLowerCase() === "task") {

      task = [match[2]];
      continue;

    }

    fields.set(match[1].toLowerCase(), match[2].trim());

  }

  const zone = userZone(agent.userId);
  const mine = listRoutines(agent.id);
  const list = mine.map((routine) => describe(routine, zone)).join("\n");

  if (fields.has("remove")) {

    const routine = mine.find((one) => one.id === Number(fields.get("remove")));

    if (!routine) {

      return { ok: false, text: `You have no routine ${fields.get("remove")}. Yours:\n${list || "none"}` };

    }

    deleteRoutine(routine.id);

    return { ok: true, text: `removed routine ${routine.id}` };

  }

  if (!fields.has("schedule") && !fields.has("watch")) {

    return { ok: true, text: list || "You have no routines." };

  }

  if (mine.length >= MAX_PER_AGENT) {

    return { ok: false, text: `You already have ${MAX_PER_AGENT} routines. Remove one first.` };

  }

  const text = task?.join("\n").trim() ?? "";
  const kind = fields.has("schedule") ? "schedule" : "watch";
  const spec = kind === "schedule" ? fields.get("schedule")! : fields.get("every") ?? "";
  const target = kind === "watch" ? fields.get("watch")! : "";

  // optional, so a model that forgets it still gets its routine; the app falls back to the task
  const title = (fields.get("title") ?? "").replace(/"/g, "");

  try {

    if (!text) {

      throw new Error("A routine needs a task: line saying what to do when it fires");

    }

    validateRoutine(kind, spec, target);

  } catch (err) {

    return { ok: false, text: err instanceof Error ? err.message : String(err) };

  }

  return { ok: true, text: `created routine ${describe(createRoutine(agent.id, { kind, spec, target, title, task: text }), zone)}` };

}

// how often the scheduler looks; schedules fire on the first check at or after their minute
const CHECK_MS = 15_000;

/**
 * Each schedule keeps the instant it fires next, worked out on the user's clock, so a late check still fires it once
 * and a skipped minute is not lost to timer drift. `wake` hands the agent a task; queueing and folding are its business.
 */
export function startScheduler(wake: (agent: Agent, task: string) => void) {

  const checking = new Set<number>();

  // the spec and zone each plan was worked out for; a change to either works it out again
  const plans = new Map<number, { key: string; at: number | null }>();

  const watch = async (routine: Routine, agent: Agent, now: number) => {

    checking.add(routine.id);

    try {

      const output = await observe(routine, agent);

      markRoutine(routine.id, output, now);

      if (routine.lastOutput !== null && output !== routine.lastOutput) {

        wake(agent, routineTask(routine, userZone(agent.userId), lineChanges(routine.lastOutput, output)));

      }

    } catch {

      // a flaky target retries on the next interval; recording the failure as output would wake the agent for nothing
      markRoutine(routine.id, null, now);

    } finally {

      checking.delete(routine.id);

    }

  };

  const tick = () => {

    const now = Date.now();

    for (const routine of listRoutines()) {

      const agent = routine.enabled ? getAgentById(routine.agentId) : null;

      if (!agent) {

        // a resumed routine plans from then, instead of firing for a time that passed while it was paused
        plans.delete(routine.id);
        continue;

      }

      // one broken routine must not stop the rest
      try {

        if (routine.kind === "schedule") {

          const zone = userZone(agent.userId);
          const cron = parseCron(routine.spec);
          const key = `${routine.spec} ${zone}`;

          let plan = plans.get(routine.id);

          if (plan?.key !== key) {

            // looking back one check catches a minute that passed just before a restart; lastAt keeps it from firing twice
            plan = { key, at: nextRun(cron, zone, Math.max(routine.lastAt ?? 0, now - CHECK_MS)) };
            plans.set(routine.id, plan);

          }

          if (plan.at !== null && now >= plan.at) {

            console.log(`routine ${routine.id} fired for ${agent.name}`);
            markRoutine(routine.id, null, now);
            wake(agent, routineTask(routine, zone));
            plan.at = nextRun(cron, zone, now);

          }

          continue;

        }

        const due = routine.lastAt === null || now - routine.lastAt >= parseInterval(routine.spec) * 60_000 - 1000;

        if (due && !checking.has(routine.id)) {

          watch(routine, agent, now);

        }

      } catch (err) {

        console.error(`routine ${routine.id} failed:`, err);

      }

    }

  };

  setInterval(tick, CHECK_MS);
  tick();

}
