import { expect, test } from "bun:test";

import { buildItems } from "../../web/Lib/thread";

import type { AgentEvent } from "../../web/Lib/types";

let id = 0;

const event = (runId: string, kind: AgentEvent["kind"], text: string, at = id * 1000): AgentEvent => ({ id: ++id, agentId: 1, runId, kind, text, at });

test("a run folds into the user's message, one work row, its cards and the report", () => {

  const events = [

    event("r1", "task", "Order the pizza\n\n[attached]\nuploads/menu.pdf"),
    event("r1", "say", "On it."),
    event("r1", "step", "open the form"),
    event("r1", "page", "https://httpbin.org/forms/post\nPizza form"),
    event("r1", "step", "name"),
    event("r1", "step", "send"),
    event("r1", "ask", "Submit the order\nhttps://httpbin.org/forms/post"),
    event("r1", "user", "Allowed."),
    event("r1", "page", "https://httpbin.org/post\n"),
    event("r1", "done", "Sent."),
    event("r2", "task", "[Scheduled routine \"Morning HN\": 0 9 * * 1-5. The user is not watching; report what matters in <done>.]\n\nTop HN story"),
    event("r2", "done", "wait"),

  ];

  const items = buildItems(events, false);

  expect(items.map((item) => item.kind)).toEqual(["user", "say", "work", "page", "ask", "done", "note"]);
  expect(items[0]).toMatchObject({ text: "Order the pizza", files: ["uploads/menu.pdf"] });
  expect(items.find((item) => item.kind === "work")).toMatchObject({ steps: 3, live: false });
  expect(items.find((item) => item.kind === "page")).toMatchObject({ url: "https://httpbin.org/post" });
  expect(items.find((item) => item.kind === "ask")).toMatchObject({ answer: "allowed" });
  expect(items.find((item) => item.kind === "note")).toMatchObject({ text: "Routine: Morning HN" });

});

test("a routine card shows when it next fires, never cron", () => {

  const card = (detail: string) => buildItems([

    event("r9", "task", "Set it up"),
    event("r9", "step", "routine"),
    event("r9", "routine", detail),
    event("r9", "done", "Set."),

  ], false).find((item) => item.kind === "routine");

  expect(card("created routine 5  schedule 15 * * * *, next Sun, Oct 4, 12:15 AM EDT  — Hourly browser test")).toMatchObject({ when: "Next Sun, Oct 4, 12:15 AM EDT", title: "Hourly browser test" });
  expect(card("created routine 6  schedule 0 9 30 2 *  — Never")).toMatchObject({ when: "Never runs" });
  expect(card("created routine 7  watch https://example.com/ every 60 min  — Page")).toMatchObject({ when: "Hourly, watching example.com" });
  expect(card("created routine 8  watch cat stock.txt every 5 min  — Stock")).toMatchObject({ when: "Every 5 min, watching a command" });

});

test("a running run shows the step it is on; a finished one sums up, and old reply events are ignored", () => {

  const live = buildItems([event("r3", "task", "go"), event("r3", "step", "list the files")], true);

  expect(live.find((item) => item.kind === "work")).toMatchObject({ live: true, current: "list the files" });

  const ended = buildItems([

    event("r4", "task", "go"),
    { ...event("r4", "step", "a"), kind: "assistant" as AgentEvent["kind"] },
    event("r4", "step", "b"),
    event("r4", "error", "Stopped by the user."),

  ], false);

  expect(ended.find((item) => item.kind === "work")).toMatchObject({ live: false, steps: 1 });
  expect(ended.at(-1)).toMatchObject({ kind: "error" });

});

test("a handoff gets its own card, open until the user hands the browser back", () => {

  const asked = [event("r9", "task", "Check my orders"), event("r9", "step", "sign in"), event("r9", "handoff", "Sign in to the shop")];

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
