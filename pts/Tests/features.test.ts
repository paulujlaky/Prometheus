import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Queue } from "../Agent/Queue";
import { groupTask, isWaiting, MAX_HOPS, mentioned, route } from "../Features/Group";
import type { Agent, GroupMessage } from "../Store";

// Routines reads the store, which opens its database at import
process.env.PTS_HOME ??= mkdtempSync(join(tmpdir(), "pts-routines-"));

const { cronMatches, lineChanges, parseCron, parseInterval, routineBlock, visibleText } = await import("../Features/Routines");
const { createAgent, listRoutines } = await import("../Store");

const at = (text: string) => new Date(text);

test("cron fields, steps, ranges and the day-or-weekday rule", () => {

  const weekdays8am = parseCron("0 8 * * 1-5");

  expect(cronMatches(weekdays8am, at("2026-10-05T08:00:00"))).toBe(true);
  expect(cronMatches(weekdays8am, at("2026-10-04T08:00:00"))).toBe(false);
  expect(cronMatches(weekdays8am, at("2026-10-05T08:01:00"))).toBe(false);

  const quarterHours = parseCron("*/15 * * * *");

  expect([0, 15, 30, 45].every((minute) => cronMatches(quarterHours, at(`2026-10-05T10:${String(minute).padStart(2, "0")}:00`)))).toBe(true);
  expect(cronMatches(quarterHours, at("2026-10-05T10:20:00"))).toBe(false);

  // the 1st of the month OR a Sunday, as in standard cron
  const firstOrSunday = parseCron("0 9 1 * 0");

  expect(cronMatches(firstOrSunday, at("2026-10-01T09:00:00"))).toBe(true);
  expect(cronMatches(firstOrSunday, at("2026-10-04T09:00:00"))).toBe(true);
  expect(cronMatches(firstOrSunday, at("2026-10-05T09:00:00"))).toBe(false);

  expect(cronMatches(parseCron("0 0 * * 7"), at("2026-10-04T00:00:00"))).toBe(true);

  expect(() => parseCron("0 8 * *")).toThrow();
  expect(() => parseCron("60 8 * * *")).toThrow();
  expect(() => parseCron("0 8 * * mon")).toThrow();
  expect(() => parseInterval("0")).toThrow();
  expect(parseInterval("5")).toBe(5);

});

test("an agent's routine block creates, lists and removes its own routines", () => {

  const mine = createAgent(`Planner${Date.now()}`, "model-1");
  const other = createAgent(`Other${Date.now()}`, "model-1");

  expect(routineBlock(mine.id, "").text).toBe("You have no routines.");
  expect(routineBlock(mine.id, "schedule: every morning\ntask: x").ok).toBe(false);
  expect(routineBlock(mine.id, "schedule: 0 8 * * 1-5").ok).toBe(false);

  const daily = routineBlock(mine.id, "schedule: 0 8 * * 1-5\ntask: Summarise HN.\nKeep it to five bullets.");
  const watch = routineBlock(mine.id, "watch: curl -s https://example.com > page.txt && cat page.txt\nevery: 30\ntask: Report changes.");

  expect(daily.ok && watch.ok).toBe(true);

  const [first, second] = listRoutines(mine.id);

  expect(first).toMatchObject({ kind: "schedule", spec: "0 8 * * 1-5", task: "Summarise HN.\nKeep it to five bullets." });
  expect(second).toMatchObject({ kind: "watch", spec: "30", target: "curl -s https://example.com > page.txt && cat page.txt" });
  expect(routineBlock(mine.id, "").text.split("\n").length).toBe(2);

  expect(routineBlock(other.id, `remove: ${first.id}`).ok).toBe(false);
  expect(routineBlock(mine.id, `remove: ${first.id}`).ok).toBe(true);
  expect(listRoutines(mine.id).map((routine) => routine.id)).toEqual([second.id]);

});

test("watch output is reduced to visible text and diffed by line", () => {

  const text = visibleText(`<html><head><style>p{}</style><script>var t = "${Date.now()}";</script></head><body><h1>Price</h1><p>$10 &amp; up</p></body></html>`);

  expect(text).toBe("Price\n$10 & up");
  expect(lineChanges("Price\n$10\nIn stock", "Price\n$12\nIn stock")).toBe("Added:\n  $12\n\nRemoved:\n  $10");

});

test("group messages route by mention, and hand-offs stop at the cap", () => {

  const agents = [{ id: 1, name: "Scout" }, { id: 2, name: "Scout Two" }, { id: 3, name: "Ops" }] as Agent[];
  const message = (text: string, agentId: number | null = null): GroupMessage => ({ id: 10, author: agentId ? "agent" : "user", agentId, text, at: 0 });

  expect(mentioned("ask @scout two and @OPS", agents).map((agent) => agent.id).sort()).toEqual([2, 3]);

  const toEveryone = route(message("morning all"), agents, null);
  const toOne = route(message("@Ops check the disk"), agents, null);

  expect("recipients" in toEveryone && toEveryone.recipients.length).toBe(3);
  expect("recipients" in toOne && toOne.recipients.map((agent) => agent.id)).toEqual([3]);

  const handoff = route(message("@Scout over to you, not me @Ops", 3), agents, { chain: 10, hops: 0 });

  expect(handoff).toEqual({ recipients: [agents[0]], origin: { chain: 10, hops: 1 } });
  expect(route(message("done, nobody tagged", 3), agents, { chain: 10, hops: 2 })).toMatchObject({ recipients: [] });
  expect(route(message("@Scout again", 3), agents, { chain: 10, hops: MAX_HOPS })).toEqual({ capped: true });

  const task = groupTask(agents[2], agents, [message("earlier")], message("@Ops check the disk"));

  expect(task).toContain("Scout, Scout Two");
  expect(task).toContain("user: earlier");

  expect(isWaiting(" Wait. ")).toBe(true);
  expect(isWaiting("Waited for Probe, then wrote the haiku.")).toBe(false);

});

test("a hand-off skips an agent already working on the same chain", () => {

  const queue = new Queue(() => new Promise(() => {}), () => {}, () => {}, 1);
  const agent = (id: number) => ({ id, name: `a${id}` }) as Agent;

  queue.enqueue(agent(1), "fetch", { chain: 5, hops: 0 });
  queue.enqueue(agent(2), "write", { chain: 5, hops: 0 });

  expect(queue.busyIn(1, 5)).toBe(true);
  expect(queue.busyIn(2, 5)).toBe(true);
  expect(queue.busyIn(2, 6)).toBe(false);
  expect(queue.busyIn(3, 5)).toBe(false);

});
