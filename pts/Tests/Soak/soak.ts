// Soak test for the browser stack, Linux only: bun pts/Tests/Soak/soak.ts [minutes=30] [agents=6] [chaos=1]
// Runs the real server in-process. Agents browse real heavy sites and local 2FA-like pages, desktops and phones watch
// and take over through the app's WebSocket, and chaos kills, freezes and cuts the DevTools pipe of random browsers.
// It prints a line a minute and a summary; any action that outlives its bound is reported as a HANG.

import { closeSync, existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";

const MINUTES = Number(process.argv[2] ?? 30);
const AGENTS = Number(process.argv[3] ?? 6);
const CHAOS = process.argv[4] !== "0";
const TOKEN = "soak-token-0123456789abcdefgh";

// past this an action is hung, not slow: the longest bound plus a phone's take-over that it waited out
const HANG_MS = 240_000;

process.env.PTS_HOME = mkdtempSync(join(process.env.SOAK_HOME ?? tmpdir(), "pts-soak-"));
process.env.PTS_TOKEN = TOKEN;
process.env.PTS_PORT = "0";
process.env.NODE_ENV = "test";
process.env.PTS_BROWSER_IDLE_MS ??= "30000";
process.env.PTS_HOLD_GRACE_MS ??= "20000";

const { server } = await import("../../Server/server");
const browser = await import("../../Agent/Tools/Browser");
const { workspaceOf } = await import("../../Store");

const SITES = [

  "https://www.cnn.com", "https://www.bbc.com/news", "https://www.theguardian.com/international", "https://www.nytimes.com",
  "https://www.reddit.com/r/popular/", "https://news.ycombinator.com", "https://en.wikipedia.org/wiki/Special:Random",
  "https://www.youtube.com", "https://www.google.com/maps", "https://github.com/trending", "https://www.amazon.com",
  "https://www.ebay.com", "https://www.espn.com", "https://weather.com", "https://www.twitch.tv", "https://www.yahoo.com",
  "https://www.imdb.com", "https://stackoverflow.com/questions", "https://accounts.google.com/", "https://login.microsoftonline.com",
  "https://duo.com", "https://www.linkedin.com/login", "https://x.com/i/flow/login", "https://mail.google.com",

];

const started = Date.now();
const until = started + MINUTES * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];
const clock = () => `${((Date.now() - started) / 60_000).toFixed(1).padStart(5)}m`;
const say = (line: string) => console.log(`${clock()} ${line}`);

// --- local pages: a "check your phone" lookalike, a page of busy frames, a form, popups, a hung script

const other = Bun.serve({

  port: 0,

  fetch(req) {

    const path = new URL(req.url).pathname;

    if (path === "/poll") {

      return sleep(20_000).then(() => new Response(null, { status: 204 }));

    }

    return html(`<p>Duo frame</p><script>setInterval(() => fetch("/poll").catch(() => {}), 25000); fetch("/poll").catch(() => {})</script>`);

  },

});

function html(body: string, title = "Fixture") {

  return new Response(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title>${body}`, { headers: { "Content-Type": "text/html" } });

}

const fixtures = Bun.serve({

  port: 0,

  fetch(req) {

    const path = new URL(req.url).pathname;

    switch (path) {

      case "/poll":

        return sleep(20_000).then(() => new Response(null, { status: 204 }));

      case "/beat":

        return new Response(null, { status: 204 });

      case "/worker.js":

        return new Response(`setInterval(() => fetch("/beat").catch(() => {}), ${req.url.includes("fast") ? 15 : 200});`, { headers: { "Content-Type": "text/javascript" } });

      case "/sw.js":

        return new Response(`self.addEventListener("fetch", () => {});`, { headers: { "Content-Type": "text/javascript" } });

      case "/twofa":

        return html(`<h1>Check your phone</h1><div style="width:40px;height:40px;border:4px solid #888;border-top-color:transparent;border-radius:50%;animation:s 1s linear infinite"></div><style>@keyframes s{to{transform:rotate(360deg)}}</style>
          <iframe src="http://127.0.0.1:${other.port}/frame" width=300 height=120></iframe>
          <a href="/form">Try another way</a>
          <script>
            new Worker("/worker.js");
            navigator.serviceWorker?.register("/sw.js").catch(() => {});
            (function poll() { fetch("/poll").finally(poll); })();
            PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => {});
            navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), timeout: 20000, userVerification: "preferred", allowCredentials: [] } }).catch(() => {});
          </script>`, "Check your phone");

      case "/busy":

        return html(`<h1>Busy</h1><script>for (let i = 0; i < 20; i++) { const f = document.createElement("iframe"); f.src = "/frame?i=" + i; document.body.append(f); }</script>`, "Busy");

      case "/frame":

        return html(`<script>new Worker("/worker.js?fast")</script>`);

      case "/form":

        return html(`<h1>Sign in</h1><form action="/done"><label>Email <input name=email></label><label>Code <input name=code></label><button>Continue</button></form>`, "Sign in");

      case "/done":

        return html(`<h1>Signed in</h1><a href="/popup">Next</a>`, "Signed in");

      case "/popup":

        return html(`<h1>Popups</h1><a href="/form" target="_blank">Open sign-in tab</a><button onclick="window.open('/twofa', 'w', 'width=400,height=600')">Sign in with popup</button>`, "Popups");

      case "/hang":

        return html(`<h1>Hang</h1><script>setTimeout(() => { for (;;) {} }, 1500)</script>`, "Hang");

    }

    return html(`<ul>${Array.from({ length: 4000 }, (_, i) => `<li><a href="/form?${i}">Résumé ✉️ 你好 — message ${i}</a></li>`).join("")}</ul>`, "Inbox");

  },

});

const LOCAL = `http://localhost:${fixtures.port}`;
const PAGES = ["/twofa", "/busy", "/form", "/popup", "/inbox"].map((path) => LOCAL + path);

// --- bookkeeping

type Kind = "open" | "look" | "click" | "type" | "press";

interface Stat {

  count: number;
  failed: number;
  total: number;
  max: number;

}

const stats = new Map<string, Stat>();
const errors = new Map<string, number>();
const hangs: string[] = [];
const running = new Set<{ agent: string; kind: Kind; since: number }>();
const faults: { at: number; agent: string; kind: string; recovered?: number }[] = [];

function note(kind: string, ms: number, ok: boolean) {

  const stat = stats.get(kind) ?? { count: 0, failed: 0, total: 0, max: 0 };

  stat.count += 1;
  stat.failed += ok ? 0 : 1;
  stat.total += ms;
  stat.max = Math.max(stat.max, ms);
  stats.set(kind, stat);

}

/** Times an agent action; one still running past HANG_MS is reported the moment it crosses it. */
async function timed<T>(agent: Agent, kind: Kind, work: () => Promise<T>): Promise<T | null> {

  const begun = Date.now();
  const entry = { agent: agent.name, kind, since: begun };

  running.add(entry);

  const watchdog = setTimeout(() => {

    hangs.push(`${agent.name} ${kind} still running after ${HANG_MS / 1000}s at ${clock()}`);
    say(`HANG ${agent.name} ${kind}`);

  }, HANG_MS);

  try {

    const result = await work();

    note(kind, Date.now() - begun, true);

    for (const fault of faults) {

      if (fault.agent === agent.name && fault.recovered === undefined) {

        fault.recovered = Date.now() - fault.at;

      }

    }

    return result;

  } catch (err) {

    const message = (err instanceof Error ? err.message : String(err)).split("\n")[0].replace(/\d+/g, "N").slice(0, 90);

    note(kind, Date.now() - begun, false);
    errors.set(message, (errors.get(message) ?? 0) + 1);
    say(`${agent.name} ${kind} failed after ${((Date.now() - begun) / 1000).toFixed(1)}s: ${message}`);

    return null;

  } finally {

    clearTimeout(watchdog);
    running.delete(entry);

  }

}

// --- the app's socket, as a desktop or a phone uses it

class Device {

  frames = 0;
  failures: string[] = [];
  closed = false;

  private constructor(private ws: WebSocket) {

    ws.binaryType = "arraybuffer";

    ws.onmessage = (message) => {

      if (typeof message.data !== "string") {

        this.frames += 1;
        return;

      }

      const event = JSON.parse(message.data);

      if (event.type === "browser" && event.error) {

        this.failures.push(event.error);

      }

    };

    ws.onclose = () => (this.closed = true);

  }

  static async connect(): Promise<Device> {

    const ws = new WebSocket(`ws://localhost:${server.port}/api/ws`, { headers: { Authorization: `Bearer ${TOKEN}` } } as unknown as string[]);

    await Promise.race([new Promise((resolve) => (ws.onopen = resolve)), sleep(5000)]);

    return new Device(ws);

  }

  send(message: unknown) {

    if (this.ws.readyState === WebSocket.OPEN) {

      this.ws.send(JSON.stringify(message));

    }

  }

  close() {

    this.ws.close();

  }

}

// --- agents

interface Agent {

  id: number;
  name: string;
  workspace: string;
  actions: number;

}

async function makeAgent(i: number): Promise<Agent> {

  const res = await fetch(`http://localhost:${server.port}/api/agents`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: `Soak${i}`, modelId: "soak" }) });
  const agent = await res.json();

  return { id: agent.id, name: agent.name, workspace: workspaceOf(agent), actions: 0 };

}

/** Links on the same site, so clicking around stays on pages that were chosen to be visited. */
function links(snapshot: string, origin: string): string[] {

  const lines = snapshot.split("\n");
  const found: string[] = [];

  for (let i = 0; i < lines.length - 1; i += 1) {

    const ref = /- link .*\[ref=(e\d+)\]/.exec(lines[i])?.[1];
    const url = /\/url: (\S+)/.exec(lines[i + 1])?.[1];

    if (ref && url && (url.startsWith("/") || url.startsWith(origin))) {

      found.push(ref);

    }

  }

  return found;

}

async function agentLoop(agent: Agent) {

  let snapshot = "";

  while (Date.now() < until) {

    const roll = Math.random();
    const run = async <T>(kind: Kind, work: () => Promise<T>) => {

      agent.actions += 1;

      return timed(agent, kind, work);

    };

    if (roll < 0.4) {

      const url = pick(SITES);

      snapshot = (await run("open", () => browser.open(agent.workspace, url))) ?? "";

      const ref = snapshot && pick(links(snapshot, new URL(url).origin));

      if (ref && Math.random() < 0.5) {

        snapshot = (await run("click", () => browser.click(agent.workspace, ref))) ?? "";

      }

    } else if (roll < 0.62) {

      const url = pick(PAGES);

      snapshot = (await run("open", () => browser.open(agent.workspace, url))) ?? "";

      // a 2FA page is where an agent sits and waits for the user
      if (url.endsWith("/twofa")) {

        for (let i = 0; i < 3 && Date.now() < until; i += 1) {

          await sleep(rand(3000, 8000));
          await run("look", () => browser.look(agent.workspace));

        }

      }

      if (url.endsWith("/form") && snapshot) {

        const field = /textbox "Email" \[ref=(e\d+)\]/.exec(snapshot)?.[1];
        const button = /button "Continue" \[ref=(e\d+)\]/.exec(snapshot)?.[1];

        if (field && button) {

          await run("type", () => browser.type(agent.workspace, field, "agent@example.com"));
          snapshot = (await run("click", () => browser.click(agent.workspace, button))) ?? "";

        }

      }

      if (url.endsWith("/popup") && snapshot) {

        const link = /link "Open sign-in tab" \[ref=(e\d+)\]/.exec(snapshot)?.[1];
        const button = /button "Sign in with popup" \[ref=(e\d+)\]/.exec(snapshot)?.[1];
        const target = Math.random() < 0.5 ? link : button;

        if (target) {

          snapshot = (await run("click", () => browser.click(agent.workspace, target))) ?? "";

        }

      }

    } else if (roll < 0.75) {

      snapshot = (await run("press", () => browser.press(agent.workspace, pick(["PageDown", "End", "Home", "ArrowDown"])))) ?? snapshot;

    } else if (roll < 0.9) {

      snapshot = (await run("look", () => browser.look(agent.workspace))) ?? snapshot;

    } else {

      // long enough for the idle close; the next action has to launch Chromium again
      await sleep(Number(process.env.PTS_BROWSER_IDLE_MS) + rand(2000, 10_000));

    }

    await sleep(rand(500, 4000));

  }

}

async function deskLoop(agent: Agent) {

  while (Date.now() < until) {

    const device = await Device.connect();

    device.send({ live: "watch", agentId: agent.id });
    await sleep(rand(5000, 60_000));
    device.send({ live: "unwatch" });
    device.close();
    await sleep(rand(5000, 40_000));

  }

}

async function phoneLoop(agent: Agent) {

  await sleep(rand(10_000, 60_000));

  while (Date.now() < until) {

    let device = await Device.connect();
    const take = { live: "take", width: 390, height: 664 };

    device.send({ live: "watch", agentId: agent.id });
    await sleep(800);
    device.send(take);

    for (let i = Math.floor(rand(10, 40)); i > 0 && Date.now() < until; i -= 1) {

      const local = (await browser.pageUrl(agent.workspace)).startsWith(LOCAL);
      const kinds = local ? ["scroll", "scroll", "key", "click", "text", "back"] : ["scroll", "scroll", "key", "back"];
      const kind = pick(kinds);
      const event = kind === "scroll" ? { kind, x: Math.random(), y: Math.random(), dx: 0, dy: rand(-0.6, 0.9) }
        : kind === "key" ? { kind, key: pick(["ArrowDown", "PageDown", "Tab"]) }
        : kind === "click" ? { kind, x: Math.random(), y: Math.random() }
        : kind === "text" ? { kind, text: "123456" }
        : { kind };

      device.send({ live: "input", event });
      await sleep(rand(150, 1500));

      // iOS drops the socket when the user switches apps to copy a code, and the app reconnects and takes it again
      if (Math.random() < 0.02) {

        device.close();
        await sleep(rand(1000, 8000));
        device = await Device.connect();
        device.send({ live: "watch", agentId: agent.id });
        device.send(take);

      }

    }

    device.send({ live: "give" });
    device.send({ live: "unwatch" });
    device.close();
    await sleep(rand(60_000, 150_000));

  }

}

// --- chaos: what production did to Chromium, and what the Bun bug did to its pipe

function pidOf(agent: Agent): number {

  try {

    const pid = Number(readlinkSync(join(agent.workspace, ".browser", "SingletonLock")).split("-").pop());

    return existsSync(`/proc/${pid}/stat`) ? pid : 0;

  } catch {

    return 0;

  }

}

function children(pid: number, type: string): number[] {

  return readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(Number).filter((one) => {

    try {

      const stat = readFileSync(`/proc/${one}/stat`, "utf8");

      return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]) === pid && readFileSync(`/proc/${one}/cmdline`, "utf8").includes(`--type=${type}`);

    } catch {

      return false;

    }

  });

}

/** Closes this process's ends of Chromium's DevTools pipe, the way Bun 1.3's stale close did. */
function cut(pid: number): number {

  const ends = [3, 4].map((fd) => /socket:\[(\d+)\]/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`))?.[1]);
  const table = Bun.spawnSync(["ss", "-xpn"]).stdout.toString().split("\n").map((line) => line.trim().split(/\s+/));
  let closed = 0;

  for (const row of table) {

    const fd = new RegExp(`pid=${process.pid},fd=(\\d+)`).exec(row.join(" "))?.[1];

    if (fd && ends.includes(row[7])) {

      closeSync(Number(fd));
      closed += 1;

    }

  }

  return closed;

}

async function chaosLoop(agents: Agent[]) {

  while (Date.now() < until) {

    await sleep(rand(40_000, 80_000));

    const live = agents.filter((agent) => pidOf(agent));

    if (!live.length) {

      continue;

    }

    const agent = pick(live);
    const pid = pidOf(agent);
    const kind = pick(["kill", "renderer", "gpu", "freeze", "cut"]);

    try {

      if (kind === "kill") {

        process.kill(-pid, "SIGKILL");

      } else if (kind === "renderer" || kind === "gpu") {

        const victim = pick(children(pid, kind === "gpu" ? "gpu-process" : "renderer"));

        if (!victim) {

          continue;

        }

        process.kill(victim, "SIGKILL");

      } else if (kind === "freeze") {

        process.kill(-pid, "SIGSTOP");
        setTimeout(() => {

          try {

            process.kill(-pid, "SIGCONT");

          } catch {

            // killed meanwhile, as it should be
          }

        }, 40_000);

      } else if (!cut(pid)) {

        continue;

      }

      faults.push({ at: Date.now(), agent: agent.name, kind });
      say(`chaos: ${kind} on ${agent.name}'s Chromium ${pid}`);

    } catch (err) {

      say(`chaos: ${kind} on ${agent.name} failed: ${err}`);

    }

  }

}

// --- resources

function chromium() {

  let count = 0;
  let rss = 0;

  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {

    try {

      if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("ms-playwright")) {

        count += 1;
        rss += Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0);

      }

    } catch {

      // exited while being read
    }

  }

  return { count, rss: Math.round(rss / 1024) };

}

function fds(): number {

  return readdirSync("/proc/self/fd").length;

}

async function sampler(agents: Agent[]) {

  while (Date.now() < until) {

    await sleep(60_000);

    const chrome = chromium();
    const available = Math.round(Number(/MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1]) / 1024);

    say(`${agents.reduce((sum, agent) => sum + agent.actions, 0)} actions, ${[...stats.values()].reduce((sum, stat) => sum + stat.failed, 0)} failed, ${hangs.length} hangs | bun ${Math.round(process.memoryUsage().rss / 2 ** 20)} MB, ${fds()} fds | ${chrome.count} chromium processes, ${chrome.rss} MB RSS | ${available} MB free, load ${loadavg()[0].toFixed(1)}`);

  }

}

// --- run

const baseline = fds();
const agents = await Promise.all(Array.from({ length: AGENTS }, (_, i) => makeAgent(i)));

say(`soak: ${AGENTS} agents for ${MINUTES} min, chaos ${CHAOS ? "on" : "off"}, Bun ${Bun.version}, idle close ${process.env.PTS_BROWSER_IDLE_MS} ms`);

// a hung action never returns, so the loops get a few minutes past the end and then the report goes out regardless
await Promise.race([

  Promise.all([

    ...agents.map(agentLoop),
    ...agents.map(deskLoop),
    ...agents.filter((_, i) => i % 2 === 0).map(phoneLoop),
    ...(CHAOS ? [chaosLoop(agents)] : []),
    sampler(agents),

  ]),

  sleep(until - Date.now() + 5 * 60_000),

]);

say("stopping; closing every browser");

const stuck = [...running].map((entry) => `${entry.agent} ${entry.kind} running for ${((Date.now() - entry.since) / 1000).toFixed(0)}s`);
const closing = Date.now();
const closed = await Promise.race([browser.closeAll().then(() => true), sleep(60_000).then(() => false)]);

await sleep(3000);

const left = chromium();

console.log(`\n=== summary after ${MINUTES} min, Bun ${Bun.version} ===`);

for (const [kind, stat] of stats) {

  console.log(`${kind.padEnd(6)} ${String(stat.count).padStart(5)} runs, ${String(stat.failed).padStart(4)} failed, mean ${(stat.total / stat.count / 1000).toFixed(1)}s, max ${(stat.max / 1000).toFixed(1)}s`);

}

console.log(`\nerrors:\n${[...errors].sort((a, b) => b[1] - a[1]).map(([message, count]) => `  ${String(count).padStart(4)}  ${message}`).join("\n") || "  none"}`);
console.log(`\nfaults: ${faults.length}; recovered, seconds to the agent's next good action: ${faults.map((fault) => `${fault.kind} ${fault.recovered === undefined ? "never" : (fault.recovered / 1000).toFixed(0)}`).join(", ") || "none"}`);
console.log(`hangs: ${hangs.length ? `\n  ${hangs.join("\n  ")}` : "none"}`);
console.log(`still running at the end: ${stuck.length ? `\n  ${stuck.join("\n  ")}` : "none"}`);
console.log(`closeAll ${closed ? `took ${((Date.now() - closing - 3000) / 1000).toFixed(1)}s` : "did not finish in 60s"}; Chromium processes left: ${left.count}; Bun fds ${baseline} at start, ${fds()} at end`);

server.stop(true);
fixtures.stop(true);
other.stop(true);
process.exit(hangs.length || stuck.length || left.count ? 1 : 0);
