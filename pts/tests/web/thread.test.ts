import { expect, test } from "bun:test";

import { buildItems } from "../../web/Lib/thread";

import type { AgentEvent } from "../../web/Lib/types";

let id = 0;

const event = (runId: string, kind: AgentEvent["kind"], text: string, at = id * 1000): AgentEvent => ({ id: ++id, agentId: 1, runId, kind, text, at });

test("a run folds into the user's message, one work row, its cards and the report", () => {

  const events = [

    event("r1", "task", "Order the pizza"),
    event("r1", "assistant", "tell them\n<say>\nOn it.\n</say>\n\nopen the form\n<open https://httpbin.org/forms/post>\n</open>\n\nname\n<type e5>\nAda\n</type>"),
    event("r1", "say", "On it."),
    event("r1", "result", "[say ok]\nshown to the user\n\n[open ok]\nhttps://httpbin.org/forms/post\nPizza form\n\n- textbox\n\n[type ok]\ntyped 3 characters into e5"),
    event("r1", "assistant", "send\n<submit e44>\nSubmit the order\n</submit>"),
    event("r1", "ask", "Submit the order\nhttps://httpbin.org/forms/post"),
    event("r1", "user", "Allowed."),
    event("r1", "result", "[submit ok]\nhttps://httpbin.org/post\n\n{}"),
    event("r1", "assistant", "<done>\nSent.\n</done>"),
    event("r1", "done", "Sent."),
    event("r2", "task", "[Scheduled routine \"Morning HN\": 0 9 * * 1-5. The user is not watching; report what matters in <done>.]\n\nTop HN story"),
    event("r2", "done", "wait"),

  ];

  const items = buildItems(events, false);

  expect(items.map((item) => item.kind)).toEqual(["user", "say", "work", "page", "ask", "done", "note"]);

  const work = items.find((item) => item.kind === "work")!;

  expect(work.kind === "work" && work.steps.map((step) => [step.verb, step.ok])).toEqual([["open", true], ["type", true], ["submit", true]]);
  expect(items.find((item) => item.kind === "page")).toMatchObject({ url: "https://httpbin.org/post" });
  expect(items.find((item) => item.kind === "ask")).toMatchObject({ answer: "allowed" });
  expect(items.find((item) => item.kind === "note")).toMatchObject({ text: "Routine: Morning HN" });

});

test("a routine card shows when it next fires, never cron", () => {

  const card = (detail: string) => buildItems([

    event("r9", "task", "Set it up"),
    event("r9", "assistant", "<routine>\nschedule: 15 * * * *\n</routine>"),
    event("r9", "result", `[routine ok]\n${detail}`),
    event("r9", "done", "Set."),

  ], false).find((item) => item.kind === "routine");

  expect(card("created routine 5  schedule 15 * * * *, next Sun, Oct 4, 12:15 AM EDT  — Hourly browser test")).toMatchObject({ when: "Next Sun, Oct 4, 12:15 AM EDT", title: "Hourly browser test" });
  expect(card("created routine 6  schedule 0 9 30 2 *  — Never")).toMatchObject({ when: "Never runs" });
  expect(card("created routine 7  watch https://example.com/ every 60 min  — Page")).toMatchObject({ when: "Hourly, watching example.com" });
  expect(card("created routine 8  watch cat stock.txt every 5 min  — Stock")).toMatchObject({ when: "Every 5 min, watching a command" });

});

test("a running run's unanswered steps show live; a finished run drops blocks that never ran", () => {

  const live = buildItems([event("r3", "task", "go"), event("r3", "assistant", "look\n<run>\nls\n</run>")], true);

  expect(live.find((item) => item.kind === "work")).toMatchObject({ live: true });

  const held = buildItems([

    event("r4", "task", "go"),
    event("r4", "assistant", "a\n<run>\nfalse\n</run>\n\nb\n<run>\ntrue\n</run>"),
    event("r4", "result", "[run failed]\nexit 1"),
    event("r4", "error", "Stopped by the user."),

  ], false);

  expect(held.find((item) => item.kind === "work")).toMatchObject({ live: false, steps: [{ ok: false }] });

});

test("a handoff gets its own card, open until the user hands the browser back", () => {

  const asked = [event("r9", "task", "Check my orders"), event("r9", "assistant", "<handoff>\nSign in to the shop\n</handoff>"), event("r9", "handoff", "Sign in to the shop")];

  expect(buildItems(asked, true).find((item) => item.kind === "handoff")).toMatchObject({ text: "Sign in to the shop", answer: null });

  const done = buildItems([...asked, event("r9", "user", "Done."), event("r9", "done", "Two orders on the way.")], false);

  expect(done.find((item) => item.kind === "handoff")).toMatchObject({ answer: "done" });
  expect(done.some((item) => item.kind === "user" && item.text === "Done.")).toBe(false);

});

test("another agent's message and reply show as notes, not as the user's words", () => {

  const items = buildItems([

    event("r9", "task", "[Message from Scout]\n\n@Pen please write a line about 29.\n\n[Your <done> goes back to Scout: put the result itself in it.]"),
    event("r9", "done", "Twenty-nine stands alone."),
    event("r10", "task", "[Reply from Pen]\n\nTwenty-nine stands alone.\n\n[Carry on with the task it was for; your <done> goes to the user.]"),
    event("r10", "done", "Pen wrote: Twenty-nine stands alone."),

  ], false);

  expect(items.filter((item) => item.kind === "note").map((item) => item.kind === "note" && item.text)).toEqual(["Scout: @Pen please write a line about 29.", "Pen replied: Twenty-nine stands alone."]);

});
