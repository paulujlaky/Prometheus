import { runShell } from "../Agent/Tools/Shell";
import { createRoutine, deleteRoutine, getAgentById, listRoutines, markRoutine, workspaceOf, type Agent, type Routine } from "../Store";

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

export function cronMatches(cron: Cron, date: Date): boolean {

  const [minutes, hours, days, months, weekdays] = cron.sets;

  if (!minutes.has(date.getMinutes()) || !hours.has(date.getHours()) || !months.has(date.getMonth() + 1)) {

    return false;

  }

  const day = days.has(date.getDate());
  const weekday = weekdays.has(date.getDay());

  if (cron.anyDay || cron.anyWeekday) {

    return day && weekday;

  }

  return day || weekday;

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

  const { output, exitCode } = await runShell(routine.target, workspaceOf(agent), undefined, CHECK_TIMEOUT_MS);

  return `exit ${exitCode}\n${output}`.slice(0, MAX_OUTPUT);

}

/** Lines that appeared and disappeared — what the agent needs to judge the change, without both full copies. */
export function lineChanges(before: string, after: string): string {

  const old = new Set(before.split("\n"));
  const now = new Set(after.split("\n"));

  const section = (title: string, lines: string[]) => {

    if (!lines.length) {

      return "";

    }

    const shown = lines.slice(0, MAX_DIFF_LINES).map((line) => `  ${line}`).join("\n");
    const more = lines.length > MAX_DIFF_LINES ? `\n  ... ${lines.length - MAX_DIFF_LINES} more` : "";

    return `${title}:\n${shown}${more}`;

  };

  return [

    section("Added", [...now].filter((line) => !old.has(line))),
    section("Removed", [...old].filter((line) => !now.has(line))),

  ].filter(Boolean).join("\n\n") || "Only the order of lines changed.";

}

export function routineTask(routine: Routine, changes?: string): string {

  if (routine.kind === "schedule") {

    return `[Scheduled routine: ${routine.spec}. The user is not watching; tell them only what matters, in a sentence, and <notify> only if it is worth interrupting them.]\n\n${routine.task}`;

  }

  return `[Watch: ${routine.target} changed. The user is not watching; tell them only what matters, in a sentence, and <notify> only if it is worth interrupting them.]\n\n${routine.task}\n\n${changes}`;

}

const BLOCK_KEY = /^\s*(schedule|watch|every|task|remove)\s*:\s*(.*)$/i;

// an agent that schedules itself in a loop would quietly multiply its own runs
const MAX_PER_AGENT = 20;

function describe(routine: Routine): string {

  const when = routine.kind === "schedule" ? `schedule ${routine.spec}` : `watch ${routine.target} every ${routine.spec} min`;

  return `${routine.id}  ${when}${routine.enabled ? "" : "  (paused)"}  — ${routine.task.split("\n")[0]}`;

}

/**
 * The agent's own `<routine>` block. A bare one lists its routines; `remove: 3` deletes one;
 * `schedule:` or `watch:` + `every:` with a `task:` creates one. Everything after `task:` is the task.
 */
export function routineBlock(agentId: number, body: string): { ok: boolean; text: string } {

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

  const mine = listRoutines(agentId);

  if (fields.has("remove")) {

    const routine = mine.find((one) => one.id === Number(fields.get("remove")));

    if (!routine) {

      return { ok: false, text: `You have no routine ${fields.get("remove")}. Yours:\n${mine.map(describe).join("\n") || "none"}` };

    }

    deleteRoutine(routine.id);

    return { ok: true, text: `removed routine ${routine.id}` };

  }

  if (!fields.has("schedule") && !fields.has("watch")) {

    return { ok: true, text: mine.length ? mine.map(describe).join("\n") : "You have no routines." };

  }

  if (mine.length >= MAX_PER_AGENT) {

    return { ok: false, text: `You already have ${MAX_PER_AGENT} routines. Remove one first.` };

  }

  const text = task?.join("\n").trim() ?? "";
  const kind = fields.has("schedule") ? "schedule" : "watch";
  const spec = kind === "schedule" ? fields.get("schedule")! : fields.get("every") ?? "";
  const target = kind === "watch" ? fields.get("watch")! : "";

  try {

    if (!text) {

      throw new Error("A routine needs a task: line saying what to do when it fires");

    }

    validateRoutine(kind, spec, target);

  } catch (err) {

    return { ok: false, text: err instanceof Error ? err.message : String(err) };

  }

  return { ok: true, text: `created routine ${describe(createRoutine(agentId, { kind, spec, target, task: text }))}` };

}

/** Ticks once a minute, on the minute. `wake` hands the agent a task; queueing and folding are its business. */
export function startScheduler(wake: (agent: Agent, task: string) => void) {

  const checking = new Set<number>();

  const watch = async (routine: Routine, agent: Agent, now: number) => {

    checking.add(routine.id);

    try {

      const output = await observe(routine, agent);

      markRoutine(routine.id, output, now);

      if (routine.lastOutput !== null && output !== routine.lastOutput) {

        wake(agent, routineTask(routine, lineChanges(routine.lastOutput, output)));

      }

    } catch {

      // a flaky target retries on the next interval; recording the failure as output would wake the agent for nothing
      markRoutine(routine.id, null, now);

    } finally {

      checking.delete(routine.id);

    }

  };

  const tick = () => {

    const now = new Date();

    for (const routine of listRoutines()) {

      const agent = routine.enabled ? getAgentById(routine.agentId) : null;

      if (!agent) {

        continue;

      }

      if (routine.kind === "schedule") {

        const firedThisMinute = routine.lastAt !== null && Math.floor(routine.lastAt / 60_000) === Math.floor(now.getTime() / 60_000);

        if (!firedThisMinute && cronMatches(parseCron(routine.spec), now)) {

          markRoutine(routine.id, null, now.getTime());
          wake(agent, routineTask(routine));

        }

        continue;

      }

      const due = routine.lastAt === null || now.getTime() - routine.lastAt >= parseInterval(routine.spec) * 60_000 - 1000;

      if (due && !checking.has(routine.id)) {

        watch(routine, agent, now.getTime());

      }

    }

  };

  const untilNextMinute = 60_000 - (Date.now() % 60_000);

  setTimeout(() => {

    tick();
    setInterval(tick, 60_000);

  }, untilNextMinute);

}
