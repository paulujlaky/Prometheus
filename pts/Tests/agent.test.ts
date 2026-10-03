import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeAll } from "../Agent/Tools/Browser";
import { Queue, type AgentState } from "../Agent/Queue";
import { runShell } from "../Agent/Tools/Shell";
import { applyEdit, execute, relPath } from "../Agent/Tools/Tools";
import { parseActions, type Action } from "../Agent/Protocol";
import type { Agent } from "../Store";

test("parses labelled blocks, aliases, targets and an unclosed tail", () => {

  const actions = parseActions(`thinking first\n\nread the plan\n<cat notes/plan.md>\n</cat>\n\n<ignored>\n\nsave it\n<write path="a.md">\nhello\n</write>\n\n<done>\nall good`);

  expect(actions.map((action) => [action.verb, action.path, action.label])).toEqual([

    ["read", "notes/plan.md", "read the plan"],
    ["write", "a.md", "save it"],
    ["done", "", ""],

  ]);

  expect(actions[1].body).toBe("hello");
  expect(actions[2].body).toBe("all good");

  const mentioned = parseActions("I should use the `<run>` block here.\n\n<run>\nwhoami\n</run>");

  expect(mentioned.map((action) => action.body)).toEqual(["whoami"]);

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

test("queue caps concurrency, folds messages and stops runs", async () => {

  const agent = (id: number) => ({ id, name: `a${id}` }) as Agent;
  const finish = new Map<number, () => void>();
  const started: string[] = [];
  const states: [number, AgentState][] = [];

  let notes: string[] = [];
  let aborted = false;

  const queue = new Queue((job, task, control) => {

    started.push(`${job.id}:${task}`);
    control.signal.addEventListener("abort", () => (aborted = true));

    return new Promise<void>((resolve) => finish.set(job.id, () => {

      notes = control.takeNotes();
      resolve();

    }));

  }, () => {}, (id, state) => states.push([id, state]), 2);

  queue.send(agent(1), "one");
  queue.send(agent(2), "two");
  queue.send(agent(3), "three");
  queue.send(agent(3), "three again");
  queue.send(agent(1), "note for one");

  expect(started).toEqual(["1:one", "2:two"]);
  expect(queue.state(3)).toBe("queued");

  finish.get(1)!();
  await Bun.sleep(0);

  expect(notes).toEqual(["note for one"]);
  expect(started).toEqual(["1:one", "2:two", "3:three\n\nthree again"]);

  queue.stop(2);
  expect(aborted).toBe(true);
  expect(states).toContainEqual([3, "running"]);

});

test.skipIf(process.platform !== "linux")("commands run sandboxed in the workspace", async () => {

  const cwd = mkdtempSync(join(tmpdir(), "pts-"));

  process.env.BOODLE_COOKIE = "secret-cookie";

  const { output, exitCode } = await runShell("pwd; echo hi > made.txt; ls /home 2>&1; echo \"cookie=$BOODLE_COOKIE\"", cwd);

  expect(exitCode).toBe(0);
  expect(output).toContain("/work");
  expect(output).toContain("No such file");
  expect(output).not.toContain("secret-cookie");
  expect(readFileSync(join(cwd, "made.txt"), "utf8")).toBe("hi\n");

  expect((await runShell("sleep 5", cwd, undefined, 300)).exitCode).toBe(124);

});

test("a run asking for approval waits, then hears the answer or a stop", async () => {

  const agent = { id: 7, name: "a7" } as Agent;
  const answers: boolean[] = [];

  let asked = Promise.resolve();

  const queue = new Queue((_, __, control) => {

    asked = (async () => {

      answers.push(await control.ask("Send it?"));
      answers.push(await control.ask("And this?"));

    })();

    return asked;

  }, () => {}, () => {}, 1);

  queue.send(agent, "go");

  expect(queue.state(7)).toBe("waiting");
  expect(queue.question(7)).toBe("Send it?");
  expect(queue.answer(7, true)).toBe(true);

  await Bun.sleep(0);

  expect(queue.question(7)).toBe("And this?");

  queue.stop(7);
  await asked;

  expect(answers).toEqual([true, false]);
  expect(queue.answer(7, true)).toBe(false);

});

test.skipIf(process.platform !== "linux")("the browser opens, reads, types and clicks by ref", async () => {

  const site = Bun.serve({

    port: 0,

    fetch(req) {

      const name = new URL(req.url).searchParams.get("name");
      const page = name ? `<h1>Hello ${name}</h1>` : `<form><label>Name <input name="name"></label><button>Greet</button></form>`;

      return new Response(`<!doctype html><title>Greeter</title>${page}`, { headers: { "Content-Type": "text/html" } });

    },

  });

  const cwd = mkdtempSync(join(tmpdir(), "pts-"));
  const run = (verb: Action["verb"], path = "", body = "") => execute({ verb, path, label: "", body }, cwd);

  try {

    expect((await run("open", "file:///etc/passwd")).ok).toBe(false);

    const opened = await run("open", `http://localhost:${site.port}/`);
    const ref = (role: string) => /\[ref=(e\d+)\]/.exec(opened.text.split("\n").find((line) => line.includes(role))!)![1];

    expect(opened.text).toContain("Greeter");
    expect((await run("type", ref("textbox"), "Ada")).ok).toBe(true);

    const greeted = await run("click", ref("button"));

    expect(greeted.text).toContain("Hello Ada");

  } finally {

    await closeAll();
    site.stop(true);

  }

}, 60_000);
