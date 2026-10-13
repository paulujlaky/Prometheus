import { expect, test } from "bun:test";
import { cardReply, parseCard, webURL, type Card } from "../../web/Lib/card";
import { buildItems } from "../../web/Lib/thread";
import type { AgentEvent } from "../../web/Lib/types";

const content: Card = {

  title: "Trip options",
  icon: "calendar-days",
  blocks: [

    { type: "text", text: "**Choose** a destination." },
    { type: "list", items: ["A", "B"] },
    { type: "metric", label: "Budget", value: "$200", detail: "Per person", icon: "wallet" },
    { type: "table", columns: ["Place", "Cost"], rows: [["A", "$100"]] },
    { type: "section", title: "More", blocks: [{ type: "image", url: "https://example.com/photo.png", alt: "Destination" }, { type: "link", url: "https://example.com", label: "Source" }] },

  ],
  actions: [{ label: "Choose A", reply: "Choose A for the trip", icon: "arrow-right" }],
  fields: [{ name: "date", label: "Travel date", required: true }, { name: "notes", label: "Notes", multiline: true }],

};

test("cards validate and forms send labeled values with their context", () => {

  const source = JSON.stringify(content);
  const card = parseCard(source)!;

  expect(card).toEqual(content);

  const form = new FormData();

  form.set("date", " Friday ");
  form.set("notes", "Window seat");

  expect(cardReply(card, form)).toBe("Trip options\nTravel date: Friday\nNotes: Window seat");

});

test("malformed cards and executable URLs are never rendered", () => {

  for (const source of ["null", "[]", "{", '{"blocks":[]}', '{"blocks":[{"type":"html","text":"<script>"}]}', '{"blocks":[{"type":"table","columns":["A"],"rows":[["A","B"]]}]}', JSON.stringify({ ...content, fields: [{ name: "a", label: "A" }, { name: "a", label: "B" }] })]) {

    expect(parseCard(source)).toBeNull();

  }

  for (const url of ["javascript:alert(1)", "data:text/html,<script>", "//example.com", "https://user:password@example.com"]) {

    expect(webURL(url)).toBe(false);
    expect(parseCard(JSON.stringify({ blocks: [{ type: "link", url, label: "Click" }] }))).toBeNull();

  }

});

test("icon names use bounded Lucide slugs and leave unknown names available for fallback", () => {

  for (const icon of ["CalendarDays", "../calendar", "<svg>", "calendar--days", "x".repeat(65), 1]) {

    expect(parseCard(JSON.stringify({ ...content, icon }))).toBeNull();
    expect(parseCard(JSON.stringify({ ...content, blocks: [{ type: "text", text: "Hello", icon }] }))).toBeNull();
    expect(parseCard(JSON.stringify({ ...content, actions: [{ label: "Go", reply: "Go", icon }] }))).toBeNull();

  }

  expect(parseCard(JSON.stringify({ ...content, icon: "unknown-icon-name" }))?.icon).toBe("unknown-icon-name");

});

test("cards show in the chat and do not end a run", () => {

  const source = JSON.stringify(content);
  const event = (id: number, kind: AgentEvent["kind"], text: string): AgentEvent => ({ id, agentId: 1, runId: "r", kind, text, at: id * 1000 });
  const items = buildItems([

    event(1, "task", "Investigate"),
    event(2, "step", "create_agent"),
    event(3, "card", source),
    event(4, "step", "read notes.md"),

  ], true);

  expect(items.find((item) => item.kind === "card")).toMatchObject({ text: source });
  expect(items.find((item) => item.kind === "work")).toMatchObject({ live: true, steps: 2, current: "read notes.md" });

});
