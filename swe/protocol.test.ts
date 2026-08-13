import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseActions, parsePartial, systemPrompt } from "./protocol";
import { cleanSummary, parseReply, parseResults, parseWrites } from "./parse";
import { execute } from "./tools/dispatch";
import { applyEdit } from "./tools/edit";
import { grep, listDir, projectDoc, readFiles, repoMap } from "./tools/fs";

function repo(): string {

  const dir = mkdtempSync(join(tmpdir(), "swe-test-"));

  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "app.ts"), "export function boot() {\n\n  const port = 3000;\n  return port;\n\n}\n");
  writeFileSync(join(dir, "readme.md"), "# demo\n");

  return dir;

}

test("prose before a block is thinking, the block is the action", () => {

  const { thinking, actions } = parseActions("The loop drops the last result.\nRule it out first.\n\nread the agent\n<read>\nswe/agent.ts\n</read>");

  expect(thinking).toBe("The loop drops the last result.\nRule it out first.");
  expect(actions).toHaveLength(1);
  expect(actions[0].verb).toBe("read");
  expect(actions[0].body).toBe("swe/agent.ts");

});

test("the line above a block titles its row, and rides along in the stored block", () => {

  const { actions } = parseActions("trace chat deletion\n<grep>\ndeleteChat\n</grep>");

  expect(actions[0].label).toBe("trace chat deletion");
  expect(parseReply(actions[0].raw).desc).toBe("trace chat deletion");

});

test("each block in a batch keeps its own title", () => {

  const { actions } = parseActions("find the call sites\n<grep>\ndeleteChat\n</grep>\n\nread the owners\n<read>\nswe/main.ts\n</read>");

  expect(actions.map((action) => action.label)).toEqual(["find the call sites", "read the owners"]);

});

test("a paragraph above a block is thinking, not a title", () => {

  const long = "I should check whether the sidebar context menu already routes through the same bridge call that deletion uses, since that would decide the shape of this.";
  const { thinking, actions } = parseActions(`${long}\n<read>\nswe/sidebar.tsx\n</read>`);

  expect(actions[0].label).toBe("");
  expect(thinking).toBe(long);

});

test("a bare block still labels itself from what it touches", () => {

  expect(parseReply("<read>\nswe/sidebar.tsx\nsdk/client.ts\n</read>").desc).toBe("sidebar.tsx +1");

});

test("several blocks run in order, and aliases resolve", () => {

  const { actions } = parseActions("<list>\nsrc\n</list>\n<search>\nboot\n</search>\n<bash>\nbun test\n</bash>");

  expect(actions.map((action) => action.verb)).toEqual(["ls", "grep", "run"]);

});

test("a tag inside a written file is content, not an action", () => {

  const { actions } = parseActions("<write page.html>\n<run>not a command</run>\n</write>");

  expect(actions).toHaveLength(1);
  expect(actions[0].path).toBe("page.html");
  expect(actions[0].body).toBe("<run>not a command</run>");

});

test("path attribute survives every spelling models use", () => {

  expect(parseActions(`<edit path="a/b.ts">\nx\n</edit>`).actions[0].path).toBe("a/b.ts");
  expect(parseActions("<edit 'a/b.ts'>\nx\n</edit>").actions[0].path).toBe("a/b.ts");
  expect(parseActions("<edit a\\b.ts>\nx\n</edit>").actions[0].path).toBe("a/b.ts");

});

test("an unclosed block still runs, so a cut-off reply is not wasted", () => {

  const { actions } = parseActions("<read>\nsrc/app.ts");

  expect(actions[0].body).toBe("src/app.ts");

});

test("the row labels itself from a half-typed tag", () => {

  expect(parsePartial("thinking...\n<edit src/app.ts>").verb).toBe("edit");
  expect(parseReply("<grep>\nboot\n</grep>").desc).toBe("boot");

});

test("read numbers lines and takes a range in any punctuation", () => {

  const cwd = repo();

  expect(readFiles(cwd, [{ path: "src/app.ts" }])).toContain("1  export function boot() {");

  const ranged = execute({ verb: "read", path: "", label: "", body: "src/app.ts 3-4", raw: "" }, cwd);

  expect(ranged.kind).toBe("result");
  expect(ranged.kind === "result" && ranged.result.text).toContain("lines 3-4 of 6");

});

test("house rules ship in the prompt instead of costing a turn to find", () => {

  const cwd = repo();

  writeFileSync(join(cwd, "CLAUDE.md"), "# Style\n\nNo trailing whitespace.\n");

  const doc = projectDoc(cwd);

  expect(doc).toBe("CLAUDE.md");
  expect(systemPrompt("map", doc, "do a thing")).toContain("## House rules");

});

test("a repo with no conventions file adds no section", () => {

  expect(projectDoc(repo())).toBe("");
  expect(systemPrompt("map", "", "do a thing")).not.toContain("House rules");

});

test("ls and the repo map carry line counts and symbols", () => {

  const cwd = repo();

  expect(listDir(cwd, "src")).toContain("boot");
  expect(repoMap(cwd)).toContain("src/");

});

test("grep groups hits under their file", () => {

  const cwd = repo();

  expect(grep(cwd, "port")).toContain("src/app.ts\n");
  expect(grep(cwd, "/po.t/")).toContain("3 matches");
  expect(grep(cwd, "nothinghere")).toContain("no matches");

});

test("two search terms on two lines are two patterns, not a pattern and a directory", () => {

  const cwd = repo();
  const outcome = execute({ verb: "grep", path: "", label: "", body: "boot\nreturn", raw: "" }, cwd);

  expect(outcome.kind).toBe("result");
  expect(outcome.kind === "result" && outcome.result.ok).toBeTrue();
  expect(outcome.kind === "result" && outcome.result.text).toContain("2 matches");

});

test("grep scope comes off the tag", () => {

  const cwd = repo();

  expect(grep(cwd, ["boot"], { path: "src" })).toContain("src/app.ts");
  expect(grep(cwd, ["boot"], { path: "src" })).not.toContain("readme");
  expect(() => grep(cwd, ["boot"], { path: "nope" })).toThrow();

});

test("an exact edit lands and reports the change", () => {

  const cwd = repo();
  const result = applyEdit(cwd, "src/app.ts", "@@ FIND\n  const port = 3000;\n@@ REPLACE\n  const port = 8080;");

  expect(result.ok).toBeTrue();
  expect(readFileSync(join(cwd, "src/app.ts"), "utf8")).toContain("8080");

});

test("a FIND copied with the read gutter still matches", () => {

  const cwd = repo();
  const result = applyEdit(cwd, "src/app.ts", "@@ FIND\n  3    const port = 3000;\n  4    return port;\n@@ REPLACE\n  const port = 8080;\n  return port;");

  expect(result.ok).toBeTrue();
  expect(readFileSync(join(cwd, "src/app.ts"), "utf8")).toContain("8080");

});

test("wrong indentation matches and the replacement is re-indented", () => {

  const cwd = repo();
  const result = applyEdit(cwd, "src/app.ts", "@@ FIND\nconst port = 3000;\n@@ REPLACE\nconst port = 8080;");

  expect(result.ok).toBeTrue();
  expect(readFileSync(join(cwd, "src/app.ts"), "utf8")).toContain("  const port = 8080;");

});

test("the SEARCH/REPLACE form models already know is accepted", () => {

  const cwd = repo();
  const result = applyEdit(cwd, "src/app.ts", "<<<<<<< SEARCH\n  return port;\n=======\n  return port + 1;\n>>>>>>> REPLACE");

  expect(result.ok).toBeTrue();
  expect(readFileSync(join(cwd, "src/app.ts"), "utf8")).toContain("return port + 1;");

});

test("several pairs apply in one block", () => {

  const cwd = repo();
  const result = applyEdit(cwd, "src/app.ts", "@@ FIND\n  const port = 3000;\n@@ REPLACE\n  const port = 8080;\n@@ FIND\n  return port;\n@@ REPLACE\n  return port * 2;");

  const after = readFileSync(join(cwd, "src/app.ts"), "utf8");

  expect(result.ok).toBeTrue();
  expect(after).toContain("8080");
  expect(after).toContain("port * 2");

});

test("an ambiguous FIND is refused with the lines it hit", () => {

  const cwd = repo();

  writeFileSync(join(cwd, "src/app.ts"), "let a = 1;\nlet a = 1;\n");

  const result = applyEdit(cwd, "src/app.ts", "@@ FIND\nlet a = 1;\n@@ REPLACE\nlet a = 2;");

  expect(result.ok).toBeFalse();
  expect(result.text).toContain("lines 1, 2");

});

test("a stale FIND comes back with the nearest real lines", () => {

  const cwd = repo();
  const result = applyEdit(cwd, "src/app.ts", "@@ FIND\n  const port = 9999;\n  return nothing;\n@@ REPLACE\n  const port = 1;");

  expect(result.ok).toBeFalse();
  expect(result.text).toContain("Closest match");
  expect(result.text).toContain("const port = 3000;");

});

test("re-applying an edit is a no-op, not a failure", () => {

  const cwd = repo();
  const body = "@@ FIND\n  const port = 3000;\n@@ REPLACE\n  const port = 8080;";

  applyEdit(cwd, "src/app.ts", body);

  const again = applyEdit(cwd, "src/app.ts", body);

  expect(again.ok).toBeTrue();
  expect(again.text).toContain("already applied");

});

test("editing a missing file points at write instead", () => {

  const cwd = repo();
  const result = applyEdit(cwd, "src/gone.ts", "@@ FIND\na\n@@ REPLACE\nb");

  expect(result.ok).toBeFalse();
  expect(result.text).toContain("<write src/gone.ts>");

});

test("paths escaping the repo are refused", () => {

  const cwd = repo();

  expect(() => readFiles(cwd, [{ path: "../secrets" }])).toThrow();

});

test("shelling out to read files is redirected to the real tools", () => {

  const cwd = repo();

  expect(() => execute({ verb: "run", path: "", label: "", body: "grep -r boot .", raw: "" }, cwd)).toThrow(/<grep>/);
  expect(execute({ verb: "run", path: "", label: "", body: "git status", raw: "" }, cwd).kind).toBe("run");

});

test("a batched reply replays as one row per block, each with its own result", () => {

  const reply = "look around\n<ls>\nsrc\n</ls>\n\nread the app\n<read>\nsrc/app.ts\n</read>";
  const { actions } = parseActions(reply);

  const results = parseResults("[ls ok]\nsrc/\n  app.ts\n\n[read failed]\nsrc/app.ts  no such file");

  expect(actions).toHaveLength(2);
  expect(results).toHaveLength(2);

  expect(results[0].exitCode).toBe(0);
  expect(results[0].output).toContain("app.ts");

  expect(results[1].exitCode).toBe(1);
  expect(results[1].output).toBe("src/app.ts  no such file");

});

test("a single result still parses, and prose is not mistaken for one", () => {

  expect(parseResults("[run ok]\nexit 0 in 12ms")).toHaveLength(1);
  expect(parseResults("just some text")).toHaveLength(0);

});

test("a done summary keeps the line structure its markdown depends on", () => {

  const summary = cleanSummary("Fixed rename in the sidebar.\n\n- Replaced the `window.prompt` flow.\n- Enter submits, Escape cancels.  \n\n\n- `bun run swe:build` passes.\n");

  expect(summary).toBe("Fixed rename in the sidebar.\n\n- Replaced the `window.prompt` flow.\n- Enter submits, Escape cancels.\n\n- `bun run swe:build` passes.");
  expect(cleanSummary("   ")).toBe("Task complete.");

});

test("the transcript reads a diff back out of a stored block", () => {

  const writes = parseWrites("<edit src/app.ts>\n@@ FIND\nold\n@@ REPLACE\nnew\n</edit>");

  expect(writes[0]).toMatchObject({ file: "src/app.ts", kind: "update", added: 1, removed: 1 });

});
