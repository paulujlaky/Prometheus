import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright";

const IDLE_MS = Number(process.env.PTS_BROWSER_IDLE_MS ?? 10 * 60_000);
const ACTION_MS = 15_000;
const LOAD_MS = 30_000;
const MAX_SNAPSHOT = 16_000;
const VIEWPORT = { width: 1280, height: 800 };

// where a take-over lands when the agent has not opened anything yet
const START_URL = "https://duckduckgo.com";

// headless otherwise reports 800x600, which is smaller than the window the page is laid out in
const SCREEN = { width: 1920, height: 1080 };

// acking a frame late is what paces the stream: roughly ten a second, however busy the page
const FRAME_MS = 100;

// a page's cache otherwise grows with every site the agent visits, on a disk the VPS may not have to spare
const DISK_CACHE_BYTES = 50 * 1024 * 1024;

/** One JPEG frame of the agent's page, or null while it is blank, which would only stream white. */
type Watcher = (frame: Buffer | null) => void;

interface Tab {

  context: BrowserContext;
  page: Page;

  idle: ReturnType<typeof setTimeout>;

  watchers: Set<Watcher>;
  cast: CDPSession | null;

  // bumped by every recast, so a slower earlier one that finishes late knows to back out
  casting: number;

  /** Set while the user has the browser; the agent's browser actions wait for it. */
  hold: PromiseWithResolvers<void> | null;

  /** The user changed the page since the agent last saw it, so the agent's refs are stale. */
  touched: boolean;

  /** The viewport every page gets: the desktop one, or the user's phone while they hold it. */
  size: { width: number; height: number };

  /** Handoffs waiting on the user; the page they need must still be there when they arrive. */
  pins: number;

  /** The agent's <open> is loading; until it commits the page still reads about:blank. */
  opening: boolean;

}

const tabs = new Map<string, Promise<Tab>>();

let fallback = false;

/** A full profile, so logins kept in IndexedDB or service workers survive too, not just cookies. */
function profilePath(workspace: string): string {

  return join(workspace, ".browser");

}

type Brand = { brand: string; version: string };

type Identity = {

  ua: string;

  // null when the probe could not read client hints; sending an empty list would strip Sec-CH-UA
  metadata: {

    brands: Brand[];
    fullVersionList: Brand[];
    fullVersion?: string;
    platform: string;
    platformVersion: string;
    architecture: string;
    model: string;
    mobile: boolean;
    bitness?: string;
    wow64?: boolean;
    formFactors?: string[];

  } | null;

};

let identity: Promise<Identity> | null = null;

const revealed = new WeakMap<Page, CDPSession>();

/** Headless Chrome brands itself "HeadlessChrome"; headed Chrome for Testing uses "Google Chrome" in that same slot. */
function headed(list: Brand[]): Brand[] {

  return list.map((item) => ({

    brand: item.brand === "HeadlessChrome" ? "Google Chrome" : item.brand,
    version: item.version,

  }));

}

/** Probe the real client hints once. A metadata-less userAgent override drops Sec-CH-UA and never reaches workers. */
function browserIdentity(): Promise<Identity> {

  identity ??= chromium.launch({ channel: "chromium", headless: true }).then(async (probe) => {

    try {

      const page = await probe.newPage();

      // userAgentData exists only in a secure context, and about:blank is not one; nothing is fetched
      await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html>" }));

      const read = await page.goto("https://example.com", { timeout: 10_000 }).then(() => page.evaluate(async () => {

        type Hint = { brand: string; version: string };
        type High = { architecture?: string; bitness?: string; model?: string; platformVersion?: string; uaFullVersion?: string; fullVersionList?: Hint[]; wow64?: boolean; formFactors?: string[] };
        type UAData = { brands: Hint[]; mobile: boolean; platform: string; getHighEntropyValues: (hints: string[]) => Promise<High> };

        const data = (navigator as Navigator & { userAgentData?: UAData }).userAgentData;

        if (!data) {

          return null;

        }

        const names = ["architecture", "bitness", "model", "platformVersion", "uaFullVersion", "fullVersionList", "wow64", "formFactors"];
        const high = await data.getHighEntropyValues(names).catch(() => data.getHighEntropyValues(names.filter((name) => name !== "formFactors")));

        return {

          ua: navigator.userAgent,
          brands: data.brands,
          mobile: data.mobile,
          platform: data.platform,
          high,

        };

      })).catch(() => null);

      if (!read?.high?.fullVersionList?.length || !read.brands.length) {

        const ua = read?.ua ?? await page.evaluate(() => navigator.userAgent).catch(() => "");

        return { ua: ua.replace("HeadlessChrome", "Chrome"), metadata: null };

      }

      const fullVersion = read.high.uaFullVersion;

      return {

        ua: read.ua.replace("HeadlessChrome", "Chrome"),

        metadata: {

          brands: headed(read.brands),
          fullVersionList: headed(read.high.fullVersionList),
          ...(fullVersion ? { fullVersion } : {}),
          platform: read.platform,
          platformVersion: read.high.platformVersion ?? "",
          architecture: read.high.architecture ?? "",
          model: read.high.model ?? "",
          mobile: read.mobile,
          ...(read.high.bitness ? { bitness: read.high.bitness } : {}),
          ...(typeof read.high.wow64 === "boolean" ? { wow64: read.high.wow64 } : {}),
          ...(read.high.formFactors?.length ? { formFactors: read.high.formFactors } : {}),

        },

      };

    } finally {

      await probe.close();

    }

  });

  // a failed probe must not be cached, or a later install of the full Chromium is never picked up
  identity.catch(() => (identity = null));

  return identity;

}

/** One session kept for the life of the page: detaching it drops the overrides it applied. */
async function sessionFor(page: Page): Promise<CDPSession> {

  const existing = revealed.get(page);

  if (existing) {

    return existing;

  }

  const session = await page.context().newCDPSession(page);

  revealed.set(page, session);
  page.on("close", () => {

    revealed.delete(page);
    session.detach().catch(() => {});

  });

  return session;

}

/** Puts the headed brand list back. The UA string itself comes from the launch flag, including inside workers. */
async function reveal(page: Page) {

  const id = await browserIdentity().catch(() => null);

  if (!id?.metadata) {

    return;

  }

  const metadata = id.metadata;
  const session = await sessionFor(page);
  const send = (formFactors: boolean) => session.send("Emulation.setUserAgentOverride", {

    userAgent: id.ua,
    userAgentMetadata: formFactors ? metadata : { ...metadata, formFactors: undefined },

  });

  await send(true).catch(() => send(false).catch(() => {}));

}

/** A phone-sized viewport has to keep a phone-sized screen, or sites that check screen.width stay on the desktop layout. */
async function fit(page: Page, size: { width: number; height: number }) {

  const desktop = size.width === VIEWPORT.width && size.height === VIEWPORT.height;

  if (page.viewportSize()?.width !== size.width || page.viewportSize()?.height !== size.height) {

    // this also copies the viewport onto the screen, which on the desktop size is too small
    await page.setViewportSize(size);

  }

  const session = await sessionFor(page);

  // a phone gets a phone's layout: a wide desktop page scales down to fit instead of scrolling sideways out of view
  await session.send("Emulation.setDeviceMetricsOverride", {

    mobile: !desktop,
    width: size.width,
    height: size.height,
    deviceScaleFactor: 1,
    screenWidth: desktop ? SCREEN.width : size.width,
    screenHeight: desktop ? SCREEN.height : size.height,
    screenOrientation: { angle: 0, type: desktop ? "landscapePrimary" : "portraitPrimary" },

  });

}

/** The real Chromium in its new headless mode looks like a normal browser; the headless shell is easy to spot. */
async function launch(workspace: string): Promise<BrowserContext> {

  // --headless and the debugging pipe each enable AutomationControlled, which is what makes navigator.webdriver true
  const args = [

    `--disk-cache-size=${DISK_CACHE_BYTES}`,
    "--disable-blink-features=AutomationControlled",
    `--screen-info={${SCREEN.width}x${SCREEN.height}}`,

  ];

  const options = { viewport: VIEWPORT, screen: SCREEN, headless: true, args };

  if (!fallback) {

    try {

      const id = await browserIdentity();

      return await chromium.launchPersistentContext(profilePath(workspace), {

        ...options,
        channel: "chromium",

        // a string override here would be metadata-less and would erase Sec-CH-UA; the flag does not
        args: id.ua ? [...args, `--user-agent=${id.ua}`] : args,

      });

    } catch (err) {

      if (!/Executable doesn't exist|install/i.test(String(err))) {

        throw err;

      }

      fallback = true;
      console.warn("Full Chromium is not installed, so the browser runs as the headless shell. Fix: bunx playwright install chromium");

    }

  }

  return chromium.launchPersistentContext(profilePath(workspace), options);

}

/** Profiles came after cookie files; carry an old file's logins into the new profile once. */
async function migrate(workspace: string, context: BrowserContext) {

  const old = join(workspace, ".browser.json");

  if (existsSync(old)) {

    await context.addCookies(JSON.parse(readFileSync(old, "utf8")).cookies ?? []).catch(() => {});

  }

}

function keepAlive(workspace: string, tab: Tab) {

  clearTimeout(tab.idle);
  tab.idle = setTimeout(() => close(workspace), IDLE_MS);

}

async function close(workspace: string) {

  const tab = await tabs.get(workspace)?.catch(() => null);

  if (!tab) {

    return;

  }

  // someone looking at, holding or about to be handed the browser counts as using it
  if (tab.watchers.size || tab.hold || tab.pins) {

    keepAlive(workspace, tab);
    return;

  }

  tabs.delete(workspace);
  clearTimeout(tab.idle);

  await tab.context.close().catch(() => {});

}

async function follow(tab: Tab, page: Page) {

  tab.page = page;

  // before any navigation: the launch flag cleaned the UA string, this puts the headed brand on Sec-CH-UA
  await reveal(page).catch(() => {});
  await fit(page, tab.size).catch(() => {});
  recast(tab);

  // a crashed renderer (out of memory, usually) streams nothing and hangs startScreencast; closing it moves on to a fresh page
  page.on("crash", () => {

    page.close().catch(() => {});

  });

  // a sign-in popup closes itself when done; the agent carries on in the page it came from
  page.on("close", () => {

    if (tab.page !== page) {

      return;

    }

    const rest = tab.context.pages();

    if (rest.length) {

      void follow(tab, rest[rest.length - 1]);
      return;

    }

    // the context's "page" event follows the new one
    tab.context.newPage().catch(() => {});

  });

}

async function tabFor(workspace: string): Promise<Tab> {

  let pending = tabs.get(workspace);

  if (!pending) {

    pending = (async () => {

      const fresh = !existsSync(profilePath(workspace));
      const context = await launch(workspace);

      if (fresh) {

        await migrate(workspace, context);

      }

      const tab: Tab = { context, page: context.pages()[0] ?? (await context.newPage()), idle: setTimeout(() => {}, 0), watchers: new Set(), cast: null, casting: 0, hold: null, touched: false, size: VIEWPORT, pins: 0, opening: false };

      // a link that opens a new tab is where the agent meant to go
      context.on("page", (next) => {

        void follow(tab, next);

      });

      await follow(tab, tab.page);

      // Chromium killed or crashed (say, out of memory): the next action launches a fresh one instead of failing forever
      context.on("close", () => {

        clearTimeout(tab.idle);
        tab.hold?.resolve();

        if (tabs.get(workspace) === pending) {

          tabs.delete(workspace);

        }

      });

      return tab;

    })();

    tabs.set(workspace, pending);

    // a failed launch must not be cached, or the browser stays broken until restart
    pending.catch(() => tabs.delete(workspace));

  }

  const tab = await pending;

  keepAlive(workspace, tab);

  return tab;

}

/** Streams the current page to whoever watches; restarted whenever the agent's page changes. */
async function recast(tab: Tab) {

  const turn = ++tab.casting;
  const old = tab.cast;

  tab.cast = null;
  await old?.detach().catch(() => {});

  if (!tab.watchers.size || tab.page.isClosed()) {

    return;

  }

  const page = tab.page;
  const cdp = await tab.context.newCDPSession(page);

  if (turn !== tab.casting || !tab.watchers.size) {

    await cdp.detach().catch(() => {});
    return;

  }

  tab.cast = cdp;

  cdp.on("Page.screencastFrame", ({ data, sessionId }) => {

    const frame = page.url() === "about:blank" ? null : Buffer.from(data, "base64");

    for (const watcher of tab.watchers) {

      watcher(frame);

    }

    setTimeout(() => cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {}), FRAME_MS);

  });

  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height }).catch(() => {});

}

/** Keeps the browser open, on its current page, for as long as `work` runs. */
export async function pinned<T>(workspace: string, work: () => Promise<T>): Promise<T> {

  const tab = await tabs.get(workspace)?.catch(() => null);

  if (tab) {

    tab.pins += 1;

  }

  try {

    return await work();

  } finally {

    if (tab) {

      tab.pins -= 1;

    }

  }

}

/** Sends frames to `watcher` until the returned function is called. Opens the browser if it was closed. */
export async function watch(workspace: string, watcher: Watcher): Promise<() => void> {

  const tab = await tabFor(workspace);

  tab.watchers.add(watcher);

  if (tab.watchers.size === 1) {

    await recast(tab);

  } else {

    // a second watcher still needs a first frame; a static page sends none on its own
    if (tab.page.url() === "about:blank") {

      watcher(null);

    } else {

      tab.page.screenshot({ type: "jpeg", quality: 70 }).then(watcher).catch(() => {});

    }

  }

  return () => {

    tab.watchers.delete(watcher);

    if (!tab.watchers.size) {

      recast(tab);

    }

    keepAlive(workspace, tab);

  };

}

/**
 * The user takes the browser; the agent's next browser action waits until they hand it back.
 * `size` fits the page to a phone, so sites switch to their mobile layout instead of shrinking to a thumbnail.
 */
export async function takeOver(workspace: string, size?: { width: number; height: number }) {

  const tab = await tabFor(workspace);

  tab.hold ??= Promise.withResolvers<void>();

  if (size) {

    const clamp = (value: number, max: number) => Math.round(Math.min(max, Math.max(320, value)));

    tab.size = { width: clamp(size.width, VIEWPORT.width), height: clamp(size.height, VIEWPORT.height) };
    await fit(tab.page, tab.size).catch(() => {});

  }

  // the agent's next <open> waits on the hold, so only one already loading could clash
  if (!tab.opening && tab.page.url() === "about:blank") {

    await tab.page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: LOAD_MS }).catch(() => {});

  }

}

export async function handBack(workspace: string) {

  const tab = await tabs.get(workspace)?.catch(() => null);

  if (!tab) {

    return;

  }

  tab.hold?.resolve();
  tab.hold = null;
  tab.size = VIEWPORT;

  await fit(tab.page, VIEWPORT).catch(() => {});

}

export type Input =

  | { kind: "click"; x: number; y: number }
  | { kind: "scroll"; x: number; y: number; dx: number; dy: number }
  | { kind: "text"; text: string }
  | { kind: "drag"; x: number; y: number; toX: number; toY: number }
  | { kind: "key"; key: string }
  | { kind: "back" };

/** What the user does in take-over. Coordinates are fractions of the frame, so any screen size maps onto the page. */
export async function input(workspace: string, event: Input) {

  const tab = await tabFor(workspace);

  if (!tab.hold) {

    throw new Error("Take over the browser first");

  }

  // looking at the page changes nothing; only what the user actually does makes the agent's refs stale
  tab.touched = true;

  const page = tab.page;

  // the frame shows the visual viewport, which a scaled-down phone page makes wider than the screen; the mouse takes page pixels
  const view = await page.evaluate(() => ({ left: visualViewport!.offsetLeft, top: visualViewport!.offsetTop, width: visualViewport!.width, height: visualViewport!.height })).catch(() => ({ left: 0, top: 0, ...tab.size }));
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

      await page.goBack({ timeout: LOAD_MS }).catch(() => null);
      break;

  }

}

/** The agent's way in: waits out a take-over, then refuses ref-based actions the user may have made stale. */
async function agentTab(workspace: string, signal?: AbortSignal, refs = false): Promise<Tab> {

  const tab = await tabFor(workspace);

  while (tab.hold) {

    const hold = tab.hold;

    await new Promise<void>((resolve) => {

      hold.promise.then(resolve);
      signal?.addEventListener("abort", () => resolve(), { once: true });

    });

    if (signal?.aborted) {

      throw new Error("aborted");

    }

  }

  if (tab.touched && refs) {

    tab.touched = false;

    throw new Error(`The user used the browser while you worked, so that did not run. The page now:\n\n${await snapshot(tab.page)}`);

  }

  tab.touched = false;

  return tab;

}

async function settle(page: Page) {

  await page.waitForLoadState("domcontentloaded", { timeout: LOAD_MS }).catch(() => {});

  // most pages finish their own fetches within a few seconds; waiting longer only stalls the agent
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});

}

async function snapshot(page: Page): Promise<string> {

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
  const { page } = tab;

  tab.opening = true;

  try {

    await page.goto(target, { waitUntil: "domcontentloaded", timeout: LOAD_MS });

  } finally {

    tab.opening = false;

  }

  await settle(page);

  return snapshot(page);

}

export async function look(workspace: string, signal?: AbortSignal): Promise<string> {

  const { page } = await agentTab(workspace, signal);

  if (page.url() === "about:blank") {

    throw new Error("No page is open yet. Use <open https://...> first.");

  }

  return snapshot(page);

}

export async function click(workspace: string, ref: string, signal?: AbortSignal): Promise<string> {

  const { page } = await agentTab(workspace, signal, true);

  await page.locator(`aria-ref=${refOf(ref)}`).click({ timeout: ACTION_MS });
  await settle(page);

  return snapshot(page);

}

export async function type(workspace: string, ref: string, text: string, signal?: AbortSignal): Promise<string> {

  const { page } = await agentTab(workspace, signal, true);

  await page.locator(`aria-ref=${refOf(ref)}`).fill(text, { timeout: ACTION_MS });

  return `typed ${text.length} characters into ${refOf(ref)}`;

}

export async function press(workspace: string, key: string, signal?: AbortSignal): Promise<string> {

  const { page } = await agentTab(workspace, signal, true);

  await page.keyboard.press(key.trim() || "Enter");
  await settle(page);

  return snapshot(page);

}

export async function pageUrl(workspace: string): Promise<string> {

  return (await tabs.get(workspace)?.catch(() => null))?.page.url() ?? "about:blank";

}

export async function closeAll() {

  await Promise.all([...tabs.keys()].map(async (workspace) => {

    const tab = await tabs.get(workspace)?.catch(() => null);

    tabs.delete(workspace);
    await tab?.context.close().catch(() => {});

  }));

}
