import { expect, test } from "bun:test";

import { buildItems } from "./thread";

import type { AgentEvent } from "../Store";

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
    event("r2", "task", "[Scheduled routine: 0 9 * * 1-5. The user is not watching; report what matters in <done>.]\n\nTop HN story"),
    event("r2", "done", "wait"),

  ];

  const items = buildItems(events, false);

  expect(items.map((item) => item.kind)).toEqual(["user", "say", "work", "page", "ask", "done", "note"]);

  const work = items.find((item) => item.kind === "work")!;

  expect(work.kind === "work" && work.steps.map((step) => [step.verb, step.ok])).toEqual([["open", true], ["type", true], ["submit", true]]);
  expect(items.find((item) => item.kind === "page")).toMatchObject({ url: "https://httpbin.org/post" });
  expect(items.find((item) => item.kind === "ask")).toMatchObject({ answer: "allowed" });
  expect(items.find((item) => item.kind === "note")).toMatchObject({ text: "Routine: Top HN story" });

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
