import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyEdit, execute, relPath } from "./Agent/Tools";
import { parseActions } from "./Agent/Protocol";

test("parses labelled blocks, aliases, targets and an unclosed tail", () => {

  const actions = parseActions(`thinking first\n\nread the plan\n<cat notes/plan.md>\n</cat>\n\n<ignored>\n\nsave it\n<write path="a.md">\nhello\n</write>\n\n<done>\nall good`);

  expect(actions.map((action) => [action.verb, action.path, action.label])).toEqual([

    ["read", "notes/plan.md", "read the plan"],
    ["write", "a.md", "save it"],
    ["done", "", ""],

  ]);

  expect(actions[1].body).toBe("hello");
  expect(actions[2].body).toBe("all good");

});

test("edits match exactly, then loosely, and roll back whole on a miss", () => {

  const cwd = mkdtempSync(join(tmpdir(), "pts-"));
  const file = join(cwd, "a.ts");

  writeFileSync(file, "function a() {\n\n    return 1;\n\n}\n");

  expect(applyEdit(cwd, "a.ts", "@@ FIND\n  return 1;\n@@ REPLACE\n  return 2;").ok).toBe(true);
  expect(readFileSync(file, "utf8")).toBe("function a() {\n\n    return 2;\n\n}\n");

  const miss = applyEdit(cwd, "a.ts", "@@ FIND\nreturn 2;\n@@ REPLACE\nreturn 3;\n@@ FIND\nreturn 99;\n@@ REPLACE\nreturn 4;");

  expect(miss.ok).toBe(false);
  expect(miss.text).toContain("Closest match");
  expect(readFileSync(file, "utf8")).not.toContain("return 3;");

});

test("paths cannot leave the workspace", async () => {

  const cwd = mkdtempSync(join(tmpdir(), "pts-"));

  expect(() => relPath("../secret", cwd)).toThrow();
  expect((await execute({ verb: "read", path: "", label: "", body: "../../etc/passwd" }, cwd)).ok).toBe(false);

});
