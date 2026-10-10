import { expect, test } from "bun:test";

import { parseActions, parseQuestion } from "../../web/Lib/protocol";

// these mirror pts/tests/tools/tools_test.go: the app must split a reply exactly as the server did, or steps and results misalign

test("an unclosed short block ends where the next block opens", () => {

  const actions = parseActions("Reading the plan first.\n\n<read plan.md>\n\n<done>\nIt is ticked.\n</done>");

  expect(actions.map((action) => [action.verb, action.path, action.body])).toEqual([["read", "plan.md", ""], ["done", "", "It is ticked."]]);
  expect(parseActions("<write page.html>\n<p>Hi</p>\n<input name=\"q\">\n")[0].body).toContain("<input");

});

test("an edit closed around its path takes the pairs after it", () => {

  const actions = parseActions("Tick off the venue\n<edit>plan.md</edit>\n@@ FIND\n- [ ] book the venue\n@@ REPLACE\n- [x] book the venue\n</edit>\n\n<done>\nTicked.\n</done>");

  expect(actions.map((action) => [action.verb, action.path, action.label])).toEqual([["edit", "plan.md", "Tick off the venue"], ["done", "", ""]]);
  expect(actions[0].body).toStartWith("@@ FIND");

});

test("a question reads its choices and write-in", () => {

  expect(parseQuestion("Which one?\n- The 7:05\n2. The 9:40\n+ Other")).toEqual({ prompt: "Which one?", choices: ["The 7:05", "The 9:40"], write: "Other" });

});
