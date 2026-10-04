import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { arch } from "node:os";
import { join } from "node:path";

import { chromium, errors, type BrowserContext, type CDPSession, type Page } from "playwright";

const IDLE_MS = Number(process.env.PTS_BROWSER_IDLE_MS ?? 10 * 60_000);
const ACTION_MS = 15_000;
const LOAD_MS = 30_000;
const INPUT_MS = 10_000;

// a call still unanswered this long past its own timeout means Chromium, or the pipe to it, is gone
const STALL_MS = 5_000;

const PING_MS = 3_000;

// so a dead Chromium that someone only watches is noticed too
const HEARTBEAT_MS = 30_000;
const HEARTBEAT_PING_MS = 10_000;

const MAX_SNAPSHOT = 16_000;

// taps on a page that has stopped answering are refused rather than replayed long after
const MAX_PENDING = 8;

// a real window instead of an emulated viewport, so inner and outer sizes look like a desktop browser's
const WINDOW = { width: 1280, height: 800 };
const SCREEN = "{1920x1080}";

// where a take-over lands when the agent has not opened anything yet
const START_URL = "https://duckduckgo.com";

// acking a frame late is what paces the stream
const FRAME_MS = 150;

// a page's cache otherwise grows with every site the agent visits, on a disk the VPS may not have to spare
const DISK_CACHE_BYTES = 50 * 1024 * 1024;

// older Bun closes a dead Chromium's pipe fds a second time, later, cutting whichever browser got those numbers next
const MIN_BUN = "1.4.2";

/** Someone looking at an agent's browser. A null frame means the page is blank. */
export interface Viewer {

  frame: (jpeg: Buffer | null) => void;
  fail: (message: string) => void;

}

export type Input =

  | { kind: "click"; x: number; y: number }
  | { kind: "scroll"; x: number; y: number; dx: number; dy: number }
  | { kind: "text"; text: string }
  | { kind: "drag"; x: number; y: number; toX: number; toY: number }
  | { kind: "key"; key: string }
  | { kind: "back" };

type Size = { width: number; height: number };

/** One running Chromium on the agent's own profile. */
interface Chrome {

  context: BrowserContext;
  pid: number;
  born: number;
  dead: boolean;
  heartbeat?: ReturnType<typeof setInterval>;

  /** What the agent and viewers see: the newest tab, the way a person follows a link. */
  page: Page;

  // one per page, kept for its life: detaching would drop the phone emulation it applied
  sessions: Map<Page, Promise<CDPSession>>;
  cast: CDPSession | null;

}

/** An agent's browser as the agent and the user share it; it outlives any one Chromium. */
interface Tab {

  workspace: string;

  chrome: Chrome | null;
  launching: Promise<Chrome> | null;

  // a Chromium still closing holds the profile, and a second one on it would hand off to it and exit
  closing: Promise<void> | null;

  viewers: Set<Viewer>;

  /** The latest frame, so a new viewer sees the page at once; undefined until there is one. */
  frame?: Buffer | null;

  /** Set while the user has the browser; the agent's actions wait for it. */
  hold: PromiseWithResolvers<void> | null;

  /** The holder's phone screen, when they took over from one. */
  phone: Size | null;

  /** The user changed the page since the agent last saw it, so the agent's refs are stale. */
  touched: boolean;

  /** Handoffs waiting on the user; the page they need must still be there when they arrive. */
  pins: number;

  /** The agent's <open> is loading; until it commits the page still reads about:blank. */
  opening: boolean;

  lane: Promise<unknown>;
  pending: number;

  idle?: ReturnType<typeof setTimeout>;

}

const tabs = new Map<string, Tab>();

let fallback = false;
let userAgent: string | undefined;

class Stalled extends Error {}

function tabOf(workspace: string): Tab {

  let tab = tabs.get(workspace);

  if (!tab) {

    tab = { workspace, chrome: null, launching: null, closing: null, viewers: new Set(), hold: null, phone: null, touched: false, pins: 0, opening: false, lane: Promise.resolve(), pending: 0 };
    tabs.set(workspace, tab);

  }

  return tab;

}

function reason(err: unknown): string {

  return err instanceof Error ? err.message.split("\n")[0] : String(err);

}

/** Playwright waits forever on a call Chromium never answers; this gives up instead. */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {

  let timer: ReturnType<typeof setTimeout> | undefined;

  // the abandoned call settles later, or never; nobody is listening either way
  work.catch(() => {});

  try {

    return await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Stalled("no answer")), ms)))]);

  } finally {

    clearTimeout(timer);

  }

}

/** Chrome's own user agent for this build, minus the "Headless" that gives it away; a launch flag reaches workers, a CDP override does not. */
function agentString(): string {

  if (userAgent === undefined) {

    try {

      const major = /(\d+)\.\d+\.\d+\.\d+/.exec(Bun.spawnSync([chromium.executablePath(), "--version"]).stdout.toString())?.[1];

      userAgent = major ? `Mozilla/5.0 (X11; Linux ${arch() === "arm64" ? "aarch64" : "x86_64"}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36` : "";

    } catch {

      userAgent = "";

    }

  }

  return userAgent;

}

/** The real Chromium in its new headless mode looks like a normal browser; the headless shell is easy to spot. */
async function start(profile: string): Promise<BrowserContext> {

  // --headless and the debugging pipe each enable AutomationControlled, which is what makes navigator.webdriver true
  const args = [`--window-size=${WINDOW.width},${WINDOW.height}`, `--screen-info=${SCREEN}`, `--disk-cache-size=${DISK_CACHE_BYTES}`, "--disable-blink-features=AutomationControlled"];
  const options = { headless: true, viewport: null, timeout: LOAD_MS };

  if (!fallback) {

    try {

      const agent = agentString();

      return await chromium.launchPersistentContext(profile, { ...options, channel: "chromium", args: agent ? [...args, `--user-agent=${agent}`] : args });

    } catch (err) {

      if (!/Executable doesn't exist|install/i.test(String(err))) {

        throw err;

      }

      fallback = true;
      console.warn("Full Chromium is not installed, so the browser runs as the headless shell. Fix: bunx playwright install chromium");

    }

  }

  return chromium.launchPersistentContext(profile, { ...options, args });

}

/** Chromium's profile lock names its pid, for a kill when it stops answering. */
function pidOf(profile: string): number {

  try {

    return Number(readlinkSync(join(profile, "SingletonLock")).split("-").pop()) || 0;

  } catch {

    return 0;

  }

}

/** Profiles came after cookie files; carry an old file's logins into the new profile once. */
async function migrate(workspace: string, context: BrowserContext) {

  const old = join(workspace, ".browser.json");

  if (existsSync(old)) {

    await context.addCookies(JSON.parse(readFileSync(old, "utf8")).cookies ?? []).catch(() => {});

  }

}

async function launch(tab: Tab): Promise<Chrome> {

  if (Bun.semver.order(Bun.version, MIN_BUN) < 0) {

    throw new Error(`The browser needs Bun ${MIN_BUN} or newer, and this is ${Bun.version}. Run: bun upgrade`);

  }

  const profile = join(tab.workspace, ".browser");
  const fresh = !existsSync(profile);
  const context = await start(profile);
  const page = context.pages()[0] ?? (await context.newPage());
  const chrome: Chrome = { context, pid: pidOf(profile), born: Date.now(), dead: false, page, sessions: new Map(), cast: null };

  context.on("close", () => gone(tab, chrome));
  context.on("page", (next) => void adopt(tab, chrome, next).catch(() => {}));

  if (fresh) {

    await migrate(tab.workspace, context);

  }

  await adopt(tab, chrome, page);

  chrome.heartbeat = setInterval(async () => {

    if (!chrome.dead && !(await alive(tab, chrome, HEARTBEAT_PING_MS)) && !chrome.dead) {

      restart(tab, chrome, "missed a heartbeat");

    }

  }, HEARTBEAT_MS);

  chrome.heartbeat.unref();

  return chrome;

}

/** Every page gets this once: a crashed one is closed, and closing the shown one shows the newest left. */
function adopt(tab: Tab, chrome: Chrome, page: Page): Promise<void> {

  page.on("crash", () => void page.close().catch(() => {}));

  page.on("close", () => {

    chrome.sessions.delete(page);

    if (chrome.page !== page || chrome.dead) {

      return;

    }

    const rest = chrome.context.pages();

    if (rest.length) {

      void show(tab, chrome, rest[rest.length - 1]).catch(() => {});
      return;

    }

    // the context's "page" event shows it
    chrome.context.newPage().catch(() => {});

  });

  return show(tab, chrome, page);

}

/** Makes `page` the one the agent and viewers see, fitted to whoever holds it. */
async function show(tab: Tab, chrome: Chrome, page: Page) {

  chrome.page = page;

  // nobody sees the other tabs, so they only hold memory; what opened this one stays, for its sign-in popups
  const keep = new Set<Page>();

  for (let one: Page | null = page; one && !keep.has(one); one = await one.opener()) {

    keep.add(one);

  }

  for (const other of chrome.context.pages()) {

    if (!keep.has(other)) {

      void other.close().catch(() => {});

    }

  }

  if (tab.phone) {

    await fit(tab, chrome, page, tab.phone);

  }

  await cast(tab, chrome);

}

/** The page's own CDP session, made once: it streams the page and carries the phone emulation. */
function sessionOf(tab: Tab, chrome: Chrome, page: Page): Promise<CDPSession> {

  let session = chrome.sessions.get(page);

  if (!session) {

    session = chrome.context.newCDPSession(page);
    chrome.sessions.set(page, session);

    session.then((cdp) => cdp.on("Page.screencastFrame", ({ data, sessionId }) => {

      setTimeout(() => cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {}), FRAME_MS);

      if (chrome.cast !== cdp) {

        return;

      }

      tab.frame = page.url() === "about:blank" ? null : Buffer.from(data, "base64");

      for (const viewer of tab.viewers) {

        viewer.frame(tab.frame);

      }

    }), () => chrome.sessions.delete(page));

  }

  return session;

}

/** Streams the shown page while anyone watches it, and nothing otherwise. */
async function cast(tab: Tab, chrome: Chrome) {

  const page = chrome.page;
  const session = tab.viewers.size ? await sessionOf(tab, chrome, page) : null;

  if (chrome.page !== page || chrome.cast === session) {

    return;

  }

  chrome.cast?.send("Page.stopScreencast").catch(() => {});
  chrome.cast = session;

  await session?.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: WINDOW.width, maxHeight: WINDOW.height });

}

/** A phone gets a phone's layout and screen, so sites switch to their mobile pages; null puts the desktop window back. */
async function fit(tab: Tab, chrome: Chrome, page: Page, phone: Size | null) {

  const session = await sessionOf(tab, chrome, page);

  if (!phone) {

    await session.send("Emulation.clearDeviceMetricsOverride");
    return;

  }

  await session.send("Emulation.setDeviceMetricsOverride", { mobile: true, ...phone, deviceScaleFactor: 1, screenWidth: phone.width, screenHeight: phone.height, screenOrientation: { angle: 0, type: "portraitPrimary" } });

}

/** Gives an empty browser somewhere to start when the user holds it. */
async function land(tab: Tab, chrome: Chrome) {

  await fit(tab, chrome, chrome.page, tab.phone);

  if (tab.hold && !tab.opening && chrome.page.url() === "about:blank") {

    await chrome.page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: LOAD_MS }).catch(() => {});

  }

}

/** The browser process answers this itself, so it tells a slow page from a Chromium that is gone; only silence counts. */
function alive(tab: Tab, chrome: Chrome, ms = PING_MS): Promise<boolean> {

  const page = chrome.context.pages()[0];

  if (!page) {

    return Promise.resolve(true);

  }

  return within(sessionOf(tab, chrome, page).then((session) => session.send("Browser.getVersion")), ms).then(() => true, (err) => !(err instanceof Stalled));

}

/** Kills a Chromium that stopped answering; whoever still looks at or holds the browser gets a fresh one. */
function restart(tab: Tab, chrome: Chrome, why: string) {

  console.warn(`browser: Chromium ${chrome.pid} of ${tab.workspace} ${why} on ${chrome.page.url()}; killing it`);
  tell(tab, "The browser stopped responding, so it was restarted");
  tab.closing = kill(chrome);
  gone(tab, chrome);

}

function tell(tab: Tab, message: string) {

  for (const viewer of tab.viewers) {

    viewer.fail(message);

  }

}

/** Playwright starts Chromium as a process group leader, so this takes its renderers with it. Resolves once it has exited. */
async function kill(chrome: Chrome) {

  if (chrome.pid <= 1) {

    return;

  }

  try {

    process.kill(-chrome.pid, "SIGKILL");

  } catch {

    return;

  }

  // the profile lock still names it until then, and a Chromium launched on the profile meanwhile refuses to start
  for (let i = 0; i < 60 && !exited(chrome.pid); i += 1) {

    await Bun.sleep(50);

  }

}

/** Gone, or a zombie waiting to be reaped. */
function exited(pid: number): boolean {

  try {

    return readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ");

  } catch {

    return true;

  }

}

/** True when this was the tab's running Chromium. */
function forget(tab: Tab, chrome: Chrome): boolean {

  chrome.dead = true;
  clearInterval(chrome.heartbeat);

  if (tab.chrome !== chrome) {

    return false;

  }

  tab.chrome = null;
  tab.frame = undefined;

  return true;

}

/** Chromium exited, crashed or was killed: whoever still looks at or holds the browser gets a fresh one now. */
function gone(tab: Tab, chrome: Chrome) {

  // one that dies as it starts would otherwise relaunch in a loop
  if (forget(tab, chrome) && (tab.viewers.size || tab.hold) && Date.now() - chrome.born > 10_000) {

    act(tab, LOAD_MS, (next) => land(tab, next)).catch((err) => tell(tab, reason(err)));

  }

}

/** The running Chromium, launched on first use. A launch that hangs is given up on, and killed if it ever finishes. */
async function chromeOf(tab: Tab): Promise<Chrome> {

  await tab.closing;

  if (tab.chrome) {

    return tab.chrome;

  }

  if (!tab.launching) {

    const started = launch(tab);

    const launching = within(started, LOAD_MS + STALL_MS).then((chrome) => {

      if (chrome.dead) {

        throw new Error("The browser closed as soon as it started");

      }

      tab.chrome = chrome;

      return chrome;

    }, (err) => {

      started.then((late) => {

        forget(tab, late);
        tab.closing = kill(late);

      }).catch(() => {});

      throw err instanceof Stalled ? new Error("The browser did not start in time") : err;

    });

    const done = () => {

      if (tab.launching === launching) {

        tab.launching = null;

      }

    };

    tab.launching = launching;
    launching.then(done, done);

  }

  return tab.launching;

}

/** Every use of the browser goes through here: bounded, and a Chromium that stopped answering is killed, not waited on. */
async function act<T>(tab: Tab, ms: number, work: (chrome: Chrome) => Promise<T>): Promise<T> {

  touch(tab);

  const chrome = await chromeOf(tab);

  try {

    return await within(work(chrome), ms + STALL_MS);

  } catch (err) {

    // a timeout is a slow page or a gone Chromium; only the second is worth a restart
    if (err instanceof Stalled || (err instanceof errors.TimeoutError && !(await alive(tab, chrome)))) {

      if (!chrome.dead) {

        restart(tab, chrome, err instanceof Stalled ? "left a call unanswered" : "stopped answering");

      }

      throw new Error("The browser stopped responding, so it was restarted. Open the page again.");

    }

    if (chrome.dead) {

      throw new Error("The browser closed unexpectedly. Open the page again.");

    }

    throw err;

  } finally {

    touch(tab);

  }

}

/** Idle means nobody used, watched, held or waited on the browser for IDLE_MS. */
function touch(tab: Tab) {

  clearTimeout(tab.idle);
  tab.idle = setTimeout(() => void close(tab.workspace), IDLE_MS);

  // an idle timer is no reason for the process to stay up
  tab.idle.unref();

}

/** The user's taps and keys land in the order they were made; a backlog on a slow page is refused, not replayed later. */
function enqueue<T>(tab: Tab, work: () => Promise<T>): Promise<T> {

  if (tab.pending >= MAX_PENDING) {

    return Promise.reject(new Error("The page is still busy with your last taps"));

  }

  tab.pending += 1;

  const next = tab.lane.then(work);

  tab.lane = next.catch(() => {});

  return next.finally(() => (tab.pending -= 1));

}

/** Closing lets Chromium write the profile's logins out; one that will not close in time is killed. */
async function shut(tab: Tab) {

  const chrome = tab.chrome ?? (await tab.launching?.catch(() => null));

  if (!chrome) {

    return;

  }

  forget(tab, chrome);

  const closing = within(chrome.context.close(), 5000).catch(() => kill(chrome));

  tab.closing = closing;
  await closing;

  if (tab.closing === closing) {

    tab.closing = null;

  }

}

/** `force` is for a deleted agent, whose browser nobody can use any more. */
export async function close(workspace: string, force = false) {

  const tab = tabs.get(workspace);

  if (!tab) {

    return;

  }

  // someone looking at, holding or about to be handed the browser counts as using it
  if (!force && (tab.viewers.size || tab.hold || tab.pins)) {

    touch(tab);
    return;

  }

  clearTimeout(tab.idle);

  if (force) {

    tabs.delete(workspace);
    tab.hold?.resolve();
    tab.hold = null;
    tab.viewers.clear();

  }

  await shut(tab);

}

export async function closeAll() {

  await Promise.all([...tabs.values()].map((tab) => {

    clearTimeout(tab.idle);

    return shut(tab);

  }));

}

/** Keeps the browser open, on its current page, for as long as `work` runs. */
export async function pinned<T>(workspace: string, work: () => Promise<T>): Promise<T> {

  const tab = tabOf(workspace);

  tab.pins += 1;

  try {

    return await work();

  } finally {

    tab.pins -= 1;
    touch(tab);

  }

}

/** Sends frames to `viewer` until the returned function is called. A closed browser stays closed and shows as blank. */
export function watch(workspace: string, viewer: Viewer): () => void {

  const tab = tabOf(workspace);

  tab.viewers.add(viewer);

  // a static page sends no new frames, so a second viewer would otherwise see nothing
  if (tab.frame !== undefined || !(tab.chrome || tab.launching)) {

    viewer.frame(tab.frame ?? null);

  }

  if (tab.chrome || tab.launching) {

    act(tab, ACTION_MS, (chrome) => cast(tab, chrome)).catch((err) => viewer.fail(reason(err)));

  }

  return () => {

    tab.viewers.delete(viewer);

    if (!tab.viewers.size && tab.chrome) {

      within(cast(tab, tab.chrome), ACTION_MS).catch(() => {});

    }

    touch(tab);

  };

}

/**
 * The user takes the browser; the agent's next browser action waits until they hand it back.
 * `size` fits the page to a phone, so sites switch to their mobile layout instead of shrinking to a thumbnail.
 */
export async function takeOver(workspace: string, size?: Size) {

  const tab = tabOf(workspace);
  const clamp = (value: number, max: number) => Math.round(Math.min(max, Math.max(320, value)));

  tab.hold ??= Promise.withResolvers<void>();
  tab.phone = size ? { width: clamp(size.width, WINDOW.width), height: clamp(size.height, WINDOW.height) } : null;

  await enqueue(tab, () => act(tab, LOAD_MS, (chrome) => land(tab, chrome)));

}

export async function handBack(workspace: string) {

  const tab = tabs.get(workspace);

  if (!tab) {

    return;

  }

  const chrome = tab.chrome;
  const phone = tab.phone;

  tab.hold?.resolve();
  tab.hold = null;
  tab.phone = null;

  if (!phone || !chrome) {

    return;

  }

  await enqueue(tab, () => within(Promise.all(chrome.context.pages().map((page) => fit(tab, chrome, page, null))), ACTION_MS)).catch(() => {});

}

/** What the user does in take-over. Coordinates are fractions of the frame, so any screen size maps onto the page. */
export async function input(workspace: string, event: Input) {

  const tab = tabs.get(workspace);

  if (!tab?.hold) {

    throw new Error("Take over the browser first");

  }

  // looking at the page changes nothing; only what the user actually does makes the agent's refs stale
  tab.touched = true;

  await enqueue(tab, () => act(tab, INPUT_MS, (chrome) => perform(tab, chrome.page, event)));

}

async function perform(tab: Tab, page: Page, event: Input) {

  // the frame shows the visual viewport, which a zoomed-out phone page makes wider than the screen; the mouse takes page pixels
  const view = (await within(page.evaluate(() => ({ left: visualViewport!.offsetLeft, top: visualViewport!.offsetTop, width: visualViewport!.width, height: visualViewport!.height })), 2000).catch(() => null)) ?? { left: 0, top: 0, ...(tab.phone ?? WINDOW) };
  const at = (x: number, y: number) => [Math.round(view.left + x * view.width), Math.round(view.top + y * view.height)] as const;

  switch (event.kind) {

    case "click":

      await page.mouse.click(...at(event.x, event.y));
      break;

    case "scroll":

      await page.mouse.move(...at(event.x, event.y));
      await page.mouse.wheel(event.dx * view.width, event.dy * view.height);
      break;

    case "text":

      await page.keyboard.insertText(event.text);
      break;

    case "key":

      await page.keyboard.press(event.key);
      break;

    case "drag":

      // slider captchas want something like a hand: a press, a few steps across, a release
      await page.mouse.move(...at(event.x, event.y));
      await page.mouse.down();
      await page.mouse.move(...at(event.toX, event.toY), { steps: 12 });
      await page.mouse.up();
      break;

    case "back":

      await page.goBack({ waitUntil: "commit", timeout: INPUT_MS });
      break;

  }

}

/** The agent's way in: waits out a take-over, then refuses ref-based actions the user may have made stale. */
async function agentTab(workspace: string, signal?: AbortSignal, refs = false): Promise<Tab> {

  const tab = tabOf(workspace);

  while (tab.hold) {

    const hold = tab.hold.promise;

    await new Promise<void>((resolve) => {

      hold.then(resolve);
      signal?.addEventListener("abort", () => resolve(), { once: true });

    });

    if (signal?.aborted) {

      throw new Error("aborted");

    }

  }

  if (tab.touched && refs) {

    tab.touched = false;

    throw new Error(`The user used the browser while you worked, so that did not run. The page now:\n\n${await act(tab, ACTION_MS * 2, (chrome) => read(chrome.page))}`);

  }

  tab.touched = false;

  return tab;

}

async function settle(page: Page) {

  await page.waitForLoadState("domcontentloaded", { timeout: LOAD_MS }).catch(() => {});

  // most pages finish their own fetches within a few seconds; waiting longer only stalls the agent
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});

}

/** What a click or key does shows up a moment after it returns: a new tab, a menu, a navigation starting. */
async function after(chrome: Chrome) {

  await Bun.sleep(500);
  await settle(chrome.page);

}

async function read(page: Page): Promise<string> {

  const tree = await page.ariaSnapshot({ mode: "ai", timeout: ACTION_MS });
  const cut = tree.length > MAX_SNAPSHOT ? `${tree.slice(0, MAX_SNAPSHOT)}\n... page cut at ${MAX_SNAPSHOT} characters` : tree;

  return `${page.url()}\n${await page.title()}\n\n${cut}`;

}

function refOf(raw: string): string {

  const ref = /^\[?(?:ref=)?(e\d+)\]?$/.exec(raw.trim())?.[1];

  if (!ref) {

    throw new Error(`"${raw}" is not an element ref. Use the ref from the page, like e12.`);

  }

  return ref;

}

// Chromium runs outside the sandbox, so file:// would read the server's own disk
function checkedUrl(url: string): string {

  if (!/^https?:\/\//i.test(url.trim())) {

    throw new Error("open takes an http:// or https:// URL");

  }

  return url.trim();

}

export async function open(workspace: string, url: string, signal?: AbortSignal): Promise<string> {

  const target = checkedUrl(url);
  const tab = await agentTab(workspace, signal);

  tab.opening = true;

  try {

    return await act(tab, LOAD_MS + ACTION_MS * 2, async (chrome) => {

      await chrome.page.goto(target, { waitUntil: "domcontentloaded", timeout: LOAD_MS });
      await settle(chrome.page);

      return read(chrome.page);

    });

  } finally {

    tab.opening = false;

  }

}

export async function look(workspace: string, signal?: AbortSignal): Promise<string> {

  const tab = await agentTab(workspace, signal);
  const blank = new Error("No page is open yet. Use <open https://...> first.");

  // a closed browser has no page to read, and launching one just to say so is waste
  if (!tab.chrome && !tab.launching) {

    throw blank;

  }

  return act(tab, ACTION_MS * 2, async (chrome) => {

    if (chrome.page.url() === "about:blank") {

      throw blank;

    }

    return read(chrome.page);

  });

}

export async function click(workspace: string, ref: string, signal?: AbortSignal): Promise<string> {

  const target = refOf(ref);
  const tab = await agentTab(workspace, signal, true);

  return act(tab, LOAD_MS + ACTION_MS * 3, async (chrome) => {

    await chrome.page.locator(`aria-ref=${target}`).click({ timeout: ACTION_MS });
    await after(chrome);

    return read(chrome.page);

  });

}

export async function type(workspace: string, ref: string, text: string, signal?: AbortSignal): Promise<string> {

  const target = refOf(ref);
  const tab = await agentTab(workspace, signal, true);

  await act(tab, ACTION_MS, (chrome) => chrome.page.locator(`aria-ref=${target}`).fill(text, { timeout: ACTION_MS }));

  return `typed ${text.length} characters into ${target}`;

}

export async function press(workspace: string, key: string, signal?: AbortSignal): Promise<string> {

  const tab = await agentTab(workspace, signal, true);

  return act(tab, LOAD_MS + ACTION_MS * 2, async (chrome) => {

    await chrome.page.keyboard.press(key.trim() || "Enter");
    await after(chrome);

    return read(chrome.page);

  });

}

export async function pageUrl(workspace: string): Promise<string> {

  return tabs.get(workspace)?.chrome?.page.url() ?? "about:blank";

}
