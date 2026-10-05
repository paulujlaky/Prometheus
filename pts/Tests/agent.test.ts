import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { close, closeAll, handBack, input, look, open, takeOver, watch } from "../Agent/Tools/Browser";
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
  const answers: (boolean | string)[] = [];

  let asked = Promise.resolve();

  const queue = new Queue((_, __, control) => {

    asked = (async () => {

      answers.push(await control.ask("Send it?"));
      answers.push(await control.ask("Which one?\n- A\n- B", "question"));
      answers.push(await control.ask("Sign in to GitHub", "handoff"));

    })();

    return asked;

  }, () => {}, () => {}, 1);

  queue.send(agent, "go");

  expect(queue.state(7)).toBe("waiting");
  expect(queue.question(7)).toBe("Send it?");
  expect(queue.answer(7, true)).toBe(true);

  await Bun.sleep(0);

  expect(queue.waitingOn(7)).toBe("question");
  expect(queue.answer(7, "B", "question")).toBe(true);

  await Bun.sleep(0);

  expect(queue.question(7)).toBe("Sign in to GitHub");
  expect(queue.waitingOn(7)).toBe("handoff");

  // handing the browser back must never answer a <submit>, and an approval must not end a handoff
  expect(queue.answer(7, true, "ask")).toBe(false);

  queue.stop(7);
  await asked;

  expect(answers).toEqual([true, "B", false]);
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

test.skipIf(process.platform !== "linux")("the browser does not call itself headless", async () => {

  const site = Bun.serve({

    port: 0,

    fetch() {

      return new Response(`<!doctype html><title>Who</title><h1></h1><script>

        const data = navigator.userAgentData;

        document.querySelector("h1").textContent = [

          String(navigator.webdriver),

          navigator.userAgent,

          data ? data.brands.map((brand) => brand.brand).join(",") : "",

          String(screen.width),

        ].join(" | ");

      </script>`, { headers: { "Content-Type": "text/html" } });

    },

  });

  const cwd = mkdtempSync(join(tmpdir(), "pts-"));

  try {

    const text = await open(cwd, `http://127.0.0.1:${site.port}/`);

    expect(text).not.toContain("HeadlessChrome");
    expect(text).toContain("false |");
    expect(text).toContain("Google Chrome");
    expect(text).toContain("| 1920");

  } finally {

    await closeAll();
    site.stop(true);

  }

}, 60_000);

test.skipIf(process.platform !== "linux")("a worker's requests do not say HeadlessChrome", async () => {

  const taken = (req: Request) => ({

    ua: req.headers.get("user-agent") ?? "",
    hint: req.headers.get("sec-ch-ua") ?? "",
    mobile: req.headers.get("sec-ch-ua-mobile") ?? "",
    platform: req.headers.get("sec-ch-ua-platform") ?? "",
    language: req.headers.get("accept-language") ?? "",
    full: req.headers.get("sec-ch-ua-full-version-list") ?? "",
    arch: req.headers.get("sec-ch-ua-arch") ?? "",

  });

  const hits: ReturnType<typeof taken>[] = [];
  let documentHint = taken(new Request("http://127.0.0.1/"));
  let later = taken(new Request("http://127.0.0.1/"));
  const workerSource = [

    "const brands = navigator.userAgentData ? navigator.userAgentData.brands.map((brand) => brand.brand).join(',') : '';",

    "fetch('/hit?from=worker').then(() => postMessage(brands + ' ' + navigator.userAgent));",

  ].join("\n");

  const site = Bun.serve({

    port: 0,

    fetch(req) {

      const url = new URL(req.url);

      if (url.pathname === "/sw.js") {

        return new Response([

          "self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));",

          "self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));",

          "self.addEventListener('fetch', (event) => {",

          "  if (new URL(event.request.url).pathname === '/from-sw') event.respondWith(fetch('/hit?from=sw').then(() => new Response('ok')));",

          "});",

        ].join("\n"), { headers: { "Content-Type": "text/javascript" } });

      }

      if (url.pathname === "/hit") {

        hits.push(taken(req));

        return new Response("ok");

      }

      if (url.pathname === "/later") {

        later = taken(req);

        return new Response("ok");

      }

      if (url.pathname === "/") {

        documentHint = taken(req);

      }

      return new Response(`<!doctype html><title>wait</title><h1></h1><script>

        const status = { worker: "", sw: "", net: "" };

        const show = () => {

          document.title = status.worker && status.sw && status.net ? status.worker + " || " + status.sw + " || " + status.net : "wait";
          document.querySelector("h1").textContent = document.title;

        };

        const worker = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerSource)}], { type: "text/javascript" })));

        worker.onmessage = (event) => {

          status.worker = event.data;
          show();

        };

        navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready).then(() => fetch("/from-sw")).then(() => {

          status.sw = "sw-sent";
          show();

        });

        fetch("/later").then(() => {

          status.net = "net-sent";
          show();

        });

      </script>`, { headers: { "Content-Type": "text/html", "Accept-CH": "Sec-CH-UA-Full-Version-List, Sec-CH-UA-Arch, Sec-CH-UA-Platform-Version, Sec-CH-UA-Form-Factors", "Critical-CH": "Sec-CH-UA-Full-Version-List" } });

    },

  });

  const cwd = mkdtempSync(join(tmpdir(), "pts-"));

  try {

    let text = await open(cwd, `http://127.0.0.1:${site.port}/`);

    for (let i = 0; i < 40 && (hits.length < 2 || !text.includes("sw-sent") || !later.full); i += 1) {

      await Bun.sleep(250);
      text = await look(cwd).catch(() => text);

    }

    expect(documentHint.hint).not.toContain("HeadlessChrome");
    expect(documentHint.hint).toContain("Google Chrome");
    expect(documentHint.mobile).toBe("?0");
    expect(documentHint.platform.length).toBeGreaterThan(2);
    expect(documentHint.language.length).toBeGreaterThan(0);
    expect(later.full).toContain("Google Chrome");
    expect(later.full).not.toContain("HeadlessChrome");
    expect(later.arch.length).toBeGreaterThan(0);
    expect(hits.length).toBeGreaterThanOrEqual(2);

    for (const hit of hits) {

      expect(hit.ua).not.toContain("HeadlessChrome");
      expect(hit.hint).not.toContain("HeadlessChrome");
      expect(hit.hint).toContain("Google Chrome");
      expect(hit.mobile).toBe("?0");
      expect(hit.platform.length).toBeGreaterThan(2);
      expect(hit.language.length).toBeGreaterThan(0);

      if (hit.full) {

        expect(hit.full).toContain("Google Chrome");
        expect(hit.full).not.toContain("HeadlessChrome");

      }

    }

    expect(text).not.toContain("HeadlessChrome");
    expect(text).toContain("Google Chrome");
    expect(text).toContain("sw-sent");
    expect(text).toContain("net-sent");

  } finally {

    await closeAll();
    site.stop(true);

  }

}, 60_000);

test.skipIf(process.platform !== "linux")("a watched browser streams, and a take-over holds the agent then refuses its stale refs", async () => {

  const site = Bun.serve({

    port: 0,

    fetch(req) {

      const name = new URL(req.url).searchParams.get("name");

      return new Response(`<!doctype html><title>Greeter</title>${name ? `<h1>Hello ${name}</h1>` : `<a href="?name=Grace" style="position:fixed;inset:0">Greet</a>`}`, { headers: { "Content-Type": "text/html" } });

    },

  });

  const cwd = mkdtempSync(join(tmpdir(), "pts-"));
  const run = (verb: Action["verb"], path = "") => execute({ verb, path, label: "", body: "" }, cwd);
  const frames: Buffer[] = [];
  const failures: string[] = [];

  try {

    const opened = await run("open", `http://localhost:${site.port}/`);
    const link = /\[ref=(e\d+)\]/.exec(opened.text.split("\n").find((line) => line.includes("link"))!)![1];
    const stop = watch(cwd, { frame: (frame) => frame && frames.push(frame), fail: (message) => failures.push(message) });

    await until(() => frames.length > 0);

    // a JPEG starts FF D8
    expect([...frames[0].subarray(0, 2)]).toEqual([0xff, 0xd8]);

    // a static page sends no new frames, so a second viewer is handed the latest at once
    const second: (Buffer | null)[] = [];
    const stopSecond = watch(cwd, { frame: (frame) => second.push(frame), fail: () => {} });

    expect(second.length).toBe(1);
    stopSecond();

    await takeOver(cwd, { width: 400, height: 700 });

    // a phone gets frames of its own width
    await until(() => widthOf(frames[frames.length - 1]) === 400);

    let settled = false;
    const held = run("click", link).finally(() => (settled = true));

    // the link covers the page, so the middle of a phone-sized frame lands on it
    await input(cwd, { kind: "click", x: 0.5, y: 0.5 });
    await Bun.sleep(500);

    expect(settled).toBe(false);

    await handBack(cwd);

    const result = await held;

    expect(result.ok).toBe(false);
    expect(result.text).toContain("Hello Grace");
    expect(failures).toEqual([]);

    stop();

  } finally {

    await closeAll();
    site.stop(true);

  }

}, 60_000);

async function until(ready: () => boolean) {

  for (let i = 0; i < 100 && !ready(); i += 1) {

    await Bun.sleep(100);

  }

  expect(ready()).toBe(true);

}

/** A baseline JPEG's width sits in its SOF0 segment. */
function widthOf(jpeg: Buffer): number {

  const at = jpeg.indexOf(Buffer.from([0xff, 0xc0]));

  return at === -1 ? 0 : jpeg.readUInt16BE(at + 7);

}

function chromePid(cwd: string): number {

  return Number(readlinkSync(join(cwd, ".browser", "SingletonLock")).split("-").pop());

}

/** Gone, or a zombie waiting to be reaped. */
function dead(pid: number): boolean {

  return !existsSync(`/proc/${pid}/stat`) || readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ");

}

function page(title: string, body = "") {

  return new Response(`<!doctype html><title>${title}</title><h1>${title}</h1>${body}`, { headers: { "Content-Type": "text/html" } });

}

test.skipIf(process.platform !== "linux")("a Chromium that dies is replaced on the next use", async () => {

  const site = Bun.serve({ port: 0, fetch: () => page("Alive") });
  const cwd = mkdtempSync(join(tmpdir(), "pts-"));

  try {

    expect(await open(cwd, `http://localhost:${site.port}/`)).toContain("Alive");

    process.kill(-chromePid(cwd), "SIGKILL");
    await Bun.sleep(500);

    await expect(look(cwd)).rejects.toThrow(/No page is open|closed unexpectedly/);
    expect(await open(cwd, `http://localhost:${site.port}/`)).toContain("Alive");

  } finally {

    await closeAll();
    site.stop(true);

  }

}, 60_000);

test.skipIf(process.platform !== "linux")("a frozen Chromium is killed instead of waited on, and another agent's browser carries on", async () => {

  const site = Bun.serve({ port: 0, fetch: () => page("Fine") });
  const url = `http://localhost:${site.port}/`;
  const frozen = mkdtempSync(join(tmpdir(), "pts-"));
  const other = mkdtempSync(join(tmpdir(), "pts-"));

  try {

    await Promise.all([open(frozen, url), open(other, url)]);

    const pid = chromePid(frozen);

    process.kill(-pid, "SIGSTOP");

    const started = Date.now();
    const stuck = look(frozen).then(() => "answered", (err: Error) => err.message);

    expect(await look(other)).toContain("Fine");
    expect(await stuck).toContain("restarted");
    expect(Date.now() - started).toBeLessThan(25_000);
    await until(() => dead(pid));

    expect(await open(frozen, url)).toContain("Fine");

  } finally {

    await closeAll();
    site.stop(true);

  }

}, 90_000);

test.skipIf(process.platform !== "linux")("closing a frozen Chromium kills it within seconds", async () => {

  const site = Bun.serve({ port: 0, fetch: () => page("Stuck") });
  const cwd = mkdtempSync(join(tmpdir(), "pts-"));

  try {

    await open(cwd, `http://localhost:${site.port}/`);

    const pid = chromePid(cwd);

    process.kill(-pid, "SIGSTOP");

    const started = Date.now();

    await close(cwd);

    expect(Date.now() - started).toBeLessThan(8000);
    await until(() => dead(pid));

  } finally {

    await closeAll();
    site.stop(true);

  }

}, 60_000);

test.skipIf(process.platform !== "linux")("deleting an agent mid-take-over lets its waiting action go", async () => {

  const site = Bun.serve({ port: 0, fetch: () => page("Held") });
  const cwd = mkdtempSync(join(tmpdir(), "pts-"));

  try {

    await open(cwd, `http://localhost:${site.port}/`);
    await takeOver(cwd);

    const waiting = look(cwd).then(() => "ran", () => "refused");

    await Bun.sleep(300);
    await close(cwd, true);

    expect(["ran", "refused"]).toContain(await waiting);

  } finally {

    await closeAll();
    site.stop(true);

  }

}, 60_000);

test.skipIf(process.platform !== "linux")("a popup becomes the page, and closing it goes back to its opener", async () => {

  const site = Bun.serve({

    port: 0,

    fetch(req) {

      return new URL(req.url).pathname === "/pop" ? page("Popup", `<button onclick="window.close()">Done</button>`) : page("Opener", `<a href="/pop" target="_blank">Pop</a>`);

    },

  });

  const cwd = mkdtempSync(join(tmpdir(), "pts-"));
  const run = (verb: Action["verb"], path = "") => execute({ verb, path, label: "", body: "" }, cwd);
  const ref = (text: string, role: string) => /\[ref=(e\d+)\]/.exec(text.split("\n").find((line) => line.includes(role))!)![1];

  try {

    const opened = await run("open", `http://localhost:${site.port}/`);
    const popup = await run("click", ref(opened.text, "link"));

    expect(popup.text).toContain("Popup");

    await run("click", ref(popup.text, "button"));
    await Bun.sleep(500);

    expect((await run("look")).text).toContain("Opener");

  } finally {

    await closeAll();
    site.stop(true);

  }

}, 60_000);
