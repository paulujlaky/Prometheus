import { existsSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { setPriority } from "node:os";
import { join } from "node:path";
import { connect as connectTls } from "node:tls";

import { chromium, errors, type BrowserContext, type CDPSession, type Page } from "playwright";

const IDLE_MS = Number(process.env.PTS_BROWSER_IDLE_MS ?? 10 * 60_000);
const ACTION_MS = 15_000;
const LOAD_MS = 30_000;
const INPUT_MS = 10_000;

// a take-over may first reload a suspended tab
const LAND_MS = LOAD_MS + ACTION_MS;

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

// each agent is its own Chromium, and a site's iframes otherwise become a process each
const RENDERERS = 4;

// a browser nobody is watching or driving gives the CPU back, so the one in use stays quick
const REST_MS = 5_000;
const SLOW = 6;

// auto-attach matches the first entry; the last one drops every target we do not rewrite
const ROOT_TARGETS = [{ type: "service_worker" }, { type: "shared_worker" }, { type: "page" }, { exclude: true }];
const CHILD_TARGETS = [{ type: "iframe" }, { type: "worker" }, { exclude: true }];

// Playwright writes an empty user-agent onto a service worker while it is still paused; the second write is the one the first fetch sees
const REWRITE_MS = 100;

// older Bun closes a dead Chromium's pipe fds a second time, later, cutting whichever browser got those numbers next
const MIN_BUN = "1.4.2";

// past MAX_TABS the least recently used tab closes; past LIVE_TABS it is suspended to its URL, so memory stays flat
const MAX_TABS = 10;
const LIVE_TABS = 3;

const MAX_PROXY_HEAD = 64 * 1024;

// Chromium's own table for placing the GREASE, Chromium and product brands
const BRAND_ORDERS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

/** Someone looking at an agent's browser. A null frame means the page is blank. */
export interface Viewer {

  frame: (jpeg: Buffer | null) => void;
  fail: (message: string) => void;
  tabs?: (tabs: TabView[]) => void;

}

/** A tab as the app shows it. `live` is false while it is suspended to its URL. */
export type TabView = { id: number; title: string; url: string; active: boolean; live: boolean };

export type TabAction = "switch" | "close" | "new";

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

  /** The active tab's page: what the agent and viewers see. */
  page: Page;

  /** Suspended tabs waiting for the page being made for them; any other new page is a tab the site opened. */
  claims: Tab[];

  // one per page, kept for its life: detaching would drop the phone emulation it applied
  sessions: Map<Page, Promise<CDPSession>>;
  cast: CDPSession | null;

  /** Serializes throttle changes; a wake that overlaps a rest must not leave the slow rate on. */
  pace: Promise<void>;

  /** False once the browser has been asked to yield. Undefined until the first request. */
  full?: boolean;
  foreground?: boolean;

}

/** One of an agent's tabs. It outlives any one Chromium; `page` is null while it is suspended. */
interface Tab {

  id: number;
  url: string;
  title: string;

  page: Page | null;

  /** The tab that was active when this one opened, so closing a sign-in popup goes back to it. */
  opener: number | null;

  used: number;

}

/** An agent's browser as the agent and the user share it; it outlives any one Chromium. */
interface Browser {

  workspace: string;

  tabs: Tab[];
  active: number;
  lastTab: number;

  /** What viewers and the tabs file were last given, so a navigation that changes nothing sends nothing. */
  announced: string;
  saved: string;

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

  /** Browser calls in flight. A rest must not throttle one of these. */
  acting: number;

  idle?: ReturnType<typeof setTimeout>;
  nap?: ReturnType<typeof setTimeout>;

}

const browsers = new Map<string, Browser>();

type Brand = { brand: string; version: string };

type Identity = {

  ua: string;

  // null when the probe could not read client hints; an empty list would strip Sec-CH-UA
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

  // empty when the probe could not read navigator.languages; sending "" would clear Accept-Language
  acceptLanguage: string;

  // navigator.platform; empty when the probe did not read it. Sent beside Sec-CH-UA-Platform so the two agree
  platform: string;

};

/** What Chromium is pointed at: the user's proxy, or the local relay that signs in to it. */
type Proxy = { server: string; host: string };

let fallback = false;
let identity: Promise<Identity> | null = null;

let proxy: Proxy | null = null;
let zone: string | null = null;
let relay: Server | null = null;

class Stalled extends Error {}

function browserOf(workspace: string): Browser {

  let browser = browsers.get(workspace);

  if (!browser) {

    browser = { workspace, tabs: [], active: 0, lastTab: 0, announced: "", saved: "", chrome: null, launching: null, closing: null, viewers: new Set(), hold: null, phone: null, touched: false, pins: 0, opening: false, lane: Promise.resolve(), pending: 0, acting: 0 };
    browsers.set(workspace, browser);
    restore(browser);

  }

  return browser;

}

function tabsFile(browser: Browser): string {

  return join(browser.workspace, ".browser", "Tabs.json");

}

/** The tabs the last Chromium left. The file sits in the agent's workspace, so only web URLs come back from it. */
function restore(browser: Browser) {

  let saved: { active?: unknown; tabs?: { url?: unknown; title?: unknown }[] };

  try {

    saved = JSON.parse(readFileSync(tabsFile(browser), "utf8"));

  } catch {

    return;

  }

  for (const one of (Array.isArray(saved.tabs) ? saved.tabs : []).slice(0, MAX_TABS)) {

    if (typeof one?.url === "string" && /^https?:\/\//i.test(one.url)) {

      addTab(browser, one.url, null).title = typeof one.title === "string" ? one.title.slice(0, 200) : "";

    }

  }

  browser.active = browser.tabs[Number(saved.active)]?.id ?? browser.tabs.at(-1)?.id ?? 0;

}

function addTab(browser: Browser, url: string, opener: number | null): Tab {

  const tab: Tab = { id: (browser.lastTab += 1), url, title: "", page: null, opener, used: Date.now() };

  browser.tabs.push(tab);

  return tab;

}

function activeTab(browser: Browser): Tab | undefined {

  return browser.tabs.find((tab) => tab.id === browser.active);

}

function tabOfPage(browser: Browser, page: Page): Tab | undefined {

  return browser.tabs.find((tab) => tab.page === page);

}

function viewsOf(browser: Browser): TabView[] {

  return browser.tabs.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url, active: tab.id === browser.active, live: !!tab.page }));

}

/** Tells viewers what changed in the tab strip, and writes it down so a new Chromium can bring the tabs back. */
function announce(browser: Browser) {

  const views = viewsOf(browser);
  const json = JSON.stringify(views);

  if (json !== browser.announced) {

    browser.announced = json;

    for (const viewer of browser.viewers) {

      viewer.tabs?.(views);

    }

  }

  const saved = JSON.stringify({ active: browser.tabs.findIndex((tab) => tab.id === browser.active), tabs: browser.tabs.map(({ url, title }) => ({ url, title })) });

  if (saved === browser.saved || !browsers.has(browser.workspace)) {

    return;

  }

  browser.saved = saved;

  try {

    writeFileSync(tabsFile(browser), saved);

  } catch {

    // no profile yet, or the agent is being deleted

  }

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

/** Old headless builds say "HeadlessChrome" where Chrome says "Google Chrome"; new ones leave Chrome out, so it is added in Chrome's order. */
function headed(list: Brand[]): Brand[] {

  const named = list.map((item) => ({ brand: item.brand === "HeadlessChrome" ? "Google Chrome" : item.brand, version: item.version }));
  const chromium = named.find((item) => item.brand === "Chromium");
  const grease = named.find((item) => item.brand !== "Chromium" && item.brand !== "Google Chrome");

  if (named.length !== 2 || !chromium || !grease) {

    return named;

  }

  const order = BRAND_ORDERS[parseInt(chromium.version, 10) % BRAND_ORDERS.length];
  const ordered: Brand[] = [];

  ordered[order[0]] = grease;
  ordered[order[1]] = chromium;
  ordered[order[2]] = { brand: "Google Chrome", version: chromium.version };

  return ordered;

}

/** `--accept-lang` takes tags. The q-values belong on the header, which the network override writes. */
function acceptLangFlag(header: string): string {

  return header.split(",").map((part) => part.split(";")[0].trim()).filter(Boolean).join(",");

}

/** `en-US,en;q=0.9`, the shape Chrome puts on Accept-Language. An empty list must not clear the header. */
function languageHeader(languages: string[]): string {

  const list = languages.filter((language) => language);

  if (!list.length) {

    return "";

  }

  return list.map((language, index) => index === 0 ? language : `${language};q=${Math.max(0.1, 1 - index * 0.1).toFixed(1)}`).join(",");

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

        const languages = [...navigator.languages];

        const navPlatform = navigator.platform;

        if (!data) {

          return { ua: navigator.userAgent, brands: [] as { brand: string; version: string }[], mobile: false, platform: "", navPlatform, languages, high: null };

        }

        const names = ["architecture", "bitness", "model", "platformVersion", "uaFullVersion", "fullVersionList", "wow64", "formFactors"];
        const high = await data.getHighEntropyValues(names).catch(() => data.getHighEntropyValues(names.filter((name) => name !== "formFactors")));

        return {

          ua: navigator.userAgent,
          brands: data.brands,
          mobile: data.mobile,
          platform: data.platform,
          navPlatform,
          languages,
          high,

        };

      })).catch(() => null);

      if (!read?.high?.fullVersionList?.length || !read.brands.length) {

        const ua = read?.ua ?? await page.evaluate(() => navigator.userAgent).catch(() => "");

        return { ua: ua.replace("HeadlessChrome", "Chrome"), acceptLanguage: languageHeader(read?.languages ?? []), platform: read?.navPlatform ?? "", metadata: null };

      }

      const fullVersion = read.high.uaFullVersion;

      return {

        ua: read.ua.replace("HeadlessChrome", "Chrome"),
        acceptLanguage: languageHeader(read.languages ?? []),
        platform: read.navPlatform ?? "",

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
          // a headless probe often omits the form factor a site asks for with Accept-CH; desktop Chrome answers "Desktop"
          ...(read.high.formFactors?.length ? { formFactors: read.high.formFactors } : !read.mobile ? { formFactors: ["Desktop"] } : {}),

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

/** The real Chromium in its new headless mode looks like a normal browser; the headless shell is easy to spot. */
async function start(profile: string): Promise<BrowserContext> {

  // --headless and the debugging pipe each enable AutomationControlled, which is what makes navigator.webdriver true
  const args = [`--window-size=${WINDOW.width},${WINDOW.height}`, `--screen-info=${SCREEN}`, `--disk-cache-size=${DISK_CACHE_BYTES}`, `--renderer-process-limit=${RENDERERS}`, "--disable-blink-features=AutomationControlled", ...proxyArgs()];
  // TZ rather than Playwright's timezoneId, which is a per-page override that service workers never get
  const options = { headless: true, viewport: null, timeout: LOAD_MS, env: zone ? { ...process.env, TZ: zone } : process.env };

  if (!fallback) {

    try {

      const id = await browserIdentity();
      const acceptLang = acceptLangFlag(id.acceptLanguage);

      // Playwright's userAgent option drops Sec-CH-UA; the flag reaches workers, and --accept-lang covers the first packet
      return await chromium.launchPersistentContext(profile, { ...options, channel: "chromium", args: [...args, ...(id.ua ? [`--user-agent=${id.ua}`] : []), ...(acceptLang ? [`--accept-lang=${acceptLang}`] : [])] });

    } catch (err) {

      if (!/Executable doesn't exist|install/i.test(String(err))) {

        throw err;

      }

      fallback = true;
      console.warn("Full Chromium is not installed, so the browser runs as the headless shell. Fix: bunx playwright install chromium");

    }

  }

  // the shell blanks client hints when given --user-agent, which is louder than the headless token
  return chromium.launchPersistentContext(profile, { ...options, args });

}

/** Behind a proxy, WebRTC and DNS would still go out from this machine and give its address away. */
function proxyArgs(): string[] {

  if (!proxy) {

    return [];

  }

  // localhost bypasses the proxy, so the agent's own dev servers still need it resolved
  return [`--proxy-server=${proxy.server}`, "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE ${proxy.host} , EXCLUDE localhost`];

}

/** `http://user:pass@host:port`, with the scheme optional. Null clears it; anything else unusable throws. */
export function proxyUrl(raw: string | null): URL | null {

  const text = raw?.trim() ?? "";

  if (!text) {

    return null;

  }

  let url: URL;

  try {

    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);

  } catch {

    throw new Error("That is not a proxy address. Use http://user:pass@host:port");

  }

  if (!/^https?:$/.test(url.protocol) || !url.hostname || (url.pathname !== "/" && url.pathname !== "")) {

    throw new Error("Use an HTTP proxy, like http://user:pass@host:port");

  }

  return url;

}

/** What Settings shows: never the password. */
export function proxyLabel(url: URL | null): string | null {

  return url ? `${url.protocol}//${url.username ? `${decodeURIComponent(url.username)}@` : ""}${url.host}` : null;

}

/** Signs in to the proxy for Chromium, which takes no credentials; Playwright's way pauses every request and turns the cache off. */
function openRelay(upstream: URL): Promise<Server> {

  const auth = `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`).toString("base64")}`;
  const host = upstream.hostname.replace(/^\[|\]$/g, "");
  const port = Number(upstream.port) || (upstream.protocol === "https:" ? 443 : 80);

  const server = createServer((client) => {

    let head = Buffer.alloc(0);

    client.on("error", () => client.destroy());

    const first = (chunk: Buffer) => {

      head = Buffer.concat([head, chunk]);

      const end = head.indexOf("\r\n\r\n");

      if (end === -1) {

        if (head.length > MAX_PROXY_HEAD) {

          client.destroy();

        }

        return;

      }

      client.off("data", first);

      const lines = head.subarray(0, end).toString("latin1").split("\r\n");
      const tunnel = /^CONNECT /i.test(lines[0]);

      // ponytail: only a connection's first request is signed, so plain-http requests each get their own; https tunnels are unaffected
      const kept = lines.slice(1).filter((line) => !/^proxy-authorization:/i.test(line) && (tunnel || !/^(proxy-)?connection:/i.test(line)));
      const far = upstream.protocol === "https:" ? connectTls({ host, port, servername: host }) : connect({ host, port });

      far.write([lines[0], auth, ...kept, ...(tunnel ? [] : ["Connection: close"]), "", ""].join("\r\n"));
      far.write(head.subarray(end + 4));

      splice(client, far);

    };

    client.on("data", first);

  });

  // the browsers using it keep the process up, not the relay
  server.unref();

  return new Promise((resolve, reject) => {

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));

  });

}

/** Either side failing or dropping takes the other with it; a clean end is passed on by the pipe, so nothing unsent is lost. */
function splice(a: Socket, b: Socket) {

  for (const [from, to] of [[a, b], [b, a]]) {

    from.on("error", () => to.destroy());
    from.on("close", () => !from.readableEnded && to.destroy());
    from.pipe(to);

  }

}

/** Points every Chromium at `raw`, or straight out for null. Running ones restart onto it, and their tabs come back. */
export async function setProxy(raw: string | null) {

  const url = proxyUrl(raw);
  const old = relay;

  relay = url?.username ? await openRelay(url) : null;

  const address = relay?.address();

  proxy = !url ? null : address && typeof address === "object" ? { server: `http://127.0.0.1:${address.port}`, host: "127.0.0.1" } : { server: `${url.protocol}//${url.host}`, host: url.hostname };

  await relaunch();

  old?.close();

}

/** The user's time zone for every Chromium, or null for this machine's. Running ones restart onto it, and their tabs come back. */
export async function setZone(next: string | null) {

  if ((next || null) === zone) {

    return;

  }

  zone = next || null;

  await relaunch();

}

/** Closes every running Chromium so the next one starts with the new settings; whoever looks at or holds one gets it back at once. */
async function relaunch() {

  await Promise.all([...browsers.values()].map(async (browser) => {

    if (!browser.chrome && !browser.launching) {

      return;

    }

    await shut(browser);

    if (browser.viewers.size || browser.hold) {

      act(browser, LAND_MS, (next) => land(browser, next)).catch((err) => tell(browser, reason(err)));

    }

  }));

}

/** The client-hints probe launches a Chromium of its own; a server does it at boot, not on the agent's first <open>. */
export function warm() {

  void browserIdentity().catch(() => {});

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

async function launch(browser: Browser): Promise<Chrome> {

  if (Bun.semver.order(Bun.version, MIN_BUN) < 0) {

    throw new Error(`The browser needs Bun ${MIN_BUN} or newer, and this is ${Bun.version}. Run: bun upgrade`);

  }

  const profile = join(browser.workspace, ".browser");
  const fresh = !existsSync(profile);
  const context = await start(profile);
  const page = context.pages()[0] ?? (await context.newPage());
  const chrome: Chrome = { context, pid: pidOf(profile), born: Date.now(), dead: false, page, claims: [], sessions: new Map(), cast: null, pace: Promise.resolve() };
  const handle = context.browser();

  // service workers are not children of a page. A new page is paused so its first request waits for the headed client hints
  if (handle) {

    const root = await handle.newBrowserCDPSession();

    await watchTargets(root, ROOT_TARGETS, true).catch(() => {});

  }

  context.on("close", () => gone(browser, chrome));
  context.on("page", (next) => void adopt(browser, chrome, next, chrome.claims.shift()).catch(() => {}));

  if (fresh) {

    await migrate(browser.workspace, context);

  }

  // the active tab gets the first page; it loads its URL again the first time something needs it
  await adopt(browser, chrome, page, activeTab(browser) ?? browser.tabs.at(-1));

  chrome.heartbeat = setInterval(async () => {

    if (!chrome.dead && !(await alive(browser, chrome, HEARTBEAT_PING_MS)) && !chrome.dead) {

      restart(browser, chrome, "missed a heartbeat");

    }

  }, HEARTBEAT_MS);

  chrome.heartbeat.unref();

  return chrome;

}

/** What `adopt` is doing with each page, so whoever made the page can wait until it is shown. */
const adopted = new WeakMap<Page, Promise<void>>();

/** Every page gets this once and becomes a tab: `claimed` when it was made for a suspended one, a new tab when the site opened it. */
function adopt(browser: Browser, chrome: Chrome, page: Page, claimed?: Tab): Promise<void> {

  const tab = claimed ?? addTab(browser, page.url(), browser.active || null);

  tab.page = page;

  page.on("crash", () => void page.close().catch(() => {}));

  page.on("close", () => {

    chrome.sessions.delete(page);

    // a dying Chromium closes its pages just before its context; waiting a turn lets that mark it dead, which suspends the tabs instead
    setTimeout(() => {

      // a tab suspended or closed on purpose has let go of its page already
      if (!chrome.dead && tab.page === page) {

        void closeTab(browser, chrome, tab).catch(() => {});

      }

    }, 0);

  });

  page.on("framenavigated", (frame) => {

    if (frame === page.mainFrame() && frame.url() !== "about:blank") {

      tab.url = frame.url();
      announce(browser);

    }

  });

  page.on("domcontentloaded", () => void page.title().then((title) => {

    tab.title = title;
    announce(browser);

  }, () => {}));

  const shown = show(browser, chrome, page);

  adopted.set(page, shown);

  return shown;

}

/** Makes `page` the one the agent and viewers see, fitted to whoever holds it. The tab it replaces keeps running, slowly. */
async function show(browser: Browser, chrome: Chrome, page: Page) {

  const before = chrome.page;
  const tab = tabOfPage(browser, page);

  chrome.page = page;

  if (tab) {

    browser.active = tab.id;
    tab.used = Date.now();

  }

  // before any navigation: the launch flag cleaned the UA string, this puts the headed brand on the request
  await reveal(browser, chrome, page).catch(() => {});

  await throttle(browser, chrome, page, chrome.full === false ? SLOW : 1);

  if (before !== page && !before.isClosed()) {

    void throttle(browser, chrome, before, SLOW);

  }

  trim(browser);

  if (browser.phone) {

    await fit(browser, chrome, page, browser.phone);

  }

  announce(browser);

  await cast(browser, chrome);

}

async function throttle(browser: Browser, chrome: Chrome, page: Page, rate: number) {

  const session = await sessionOf(browser, chrome, page).catch(() => null);

  await session?.send("Emulation.setCPUThrottlingRate", { rate }).catch(() => {});

}

/** Shows `tab`, making it a page first if it is suspended. */
async function focus(browser: Browser, chrome: Chrome, tab: Tab) {

  if (tab.page) {

    await show(browser, chrome, tab.page);
    return;

  }

  chrome.claims.push(tab);

  // the context's "page" event hands the new page to the claim and shows it
  const page = await chrome.context.newPage();

  await adopted.get(page);

}

/** Closing the active tab goes back to the one it was opened from, else the newest; the last tab is replaced by a blank one. */
async function closeTab(browser: Browser, chrome: Chrome | null, tab: Tab) {

  const page = tab.page;

  tab.page = null;
  browser.tabs = browser.tabs.filter((other) => other !== tab);

  if (browser.active === tab.id) {

    const next = browser.tabs.find((other) => other.id === tab.opener) ?? browser.tabs.at(-1) ?? addTab(browser, "about:blank", null);

    browser.active = next.id;

    // before the old page goes, so Chromium is never left without a window
    if (chrome && !chrome.dead) {

      await focus(browser, chrome, next);

    }

  }

  announce(browser);
  await page?.close().catch(() => {});

}

/** The active tab and the tabs it was opened from stay live, for sign-in popups; the rest go by least recent use. */
function trim(browser: Browser) {

  const keep = new Set<Tab>();

  for (let tab = activeTab(browser); tab && !keep.has(tab); tab = browser.tabs.find((other) => other.id === tab!.opener)) {

    keep.add(tab);

  }

  const rest = browser.tabs.filter((tab) => !keep.has(tab)).sort((a, b) => b.used - a.used);
  let live = [...keep].filter((tab) => tab.page).length;

  rest.forEach((tab, index) => {

    if (keep.size + index >= MAX_TABS) {

      void closeTab(browser, browser.chrome, tab).catch(() => {});
      return;

    }

    if (!tab.page) {

      return;

    }

    if (live < LIVE_TABS) {

      live += 1;
      return;

    }

    const page = tab.page;

    tab.page = null;
    void page.close().catch(() => {});

  });

}

/** The active tab's page. One suspended when its Chromium closed loads its URL again the first time it is needed. */
async function current(browser: Browser, chrome: Chrome): Promise<Page> {

  const page = chrome.page;
  const tab = tabOfPage(browser, page);

  if (tab && !browser.opening && page.url() === "about:blank" && /^https?:\/\//i.test(tab.url)) {

    await page.goto(tab.url, { waitUntil: "domcontentloaded", timeout: LOAD_MS }).catch(() => {});
    await settle(page);

  }

  return page;

}

type Reply = (method: string, params: object) => Promise<unknown>;

type Arrived = { sessionId?: string; waitingForDebugger?: boolean; targetInfo?: { type?: string } };

type Delivered = { sessionId?: string; message?: string };

const WORKER = new Set(["worker", "service_worker", "shared_worker"]);

const listening = new WeakSet<CDPSession>();

/** User-Agent and Sec-CH-UA-* for one target. Emulation is what script reads; Network is what the request carries. */
async function apply(reply: Reply, id: Identity, deep: boolean) {

  const metadata = id.metadata;

  if (!metadata || !id.ua) {

    return;

  }

  const attempt = async (formFactors: boolean) => {

    const params = {

      userAgent: id.ua,
      ...(id.acceptLanguage ? { acceptLanguage: id.acceptLanguage } : {}),
      ...(id.platform ? { platform: id.platform } : {}),
      userAgentMetadata: formFactors ? metadata : { ...metadata, formFactors: undefined },

    };

    await reply("Emulation.setUserAgentOverride", params);
    await network(reply, params, deep);

  };

  try {

    await attempt(true);

  } catch {

    // an older build rejects formFactors and would otherwise keep the headless brand
    await attempt(false);

  }

}

/** The network-stack override. Enabling the domain on a page would deliver every request, so only a worker gets that fallback. */
async function network(reply: Reply, params: object, deep: boolean) {

  try {

    await reply("Network.setUserAgentOverride", params);

  } catch {

    if (!deep) {

      return;

    }

    await reply("Network.enable", {});
    await reply("Network.setUserAgentOverride", params);

  }

}

type Answer = { sessionId: string; done: (body: { error?: { message?: string } }) => void };

/**
 * A flat child session is not addressable from here, so commands go the old way and replies come back as events.
 * One listener per root reads each reply once, and parses nothing while no command waits.
 */
function commander(root: CDPSession): (sessionId: string, method: string, params: object) => Promise<void> {

  const waiting = new Map<number, Answer>();

  let n = 0;

  root.on("Target.receivedMessageFromTarget", (event: Delivered) => {

    if (!waiting.size || !event.message) {

      return;

    }

    let body: { id?: number; error?: { message?: string } };

    try {

      body = JSON.parse(event.message);

    } catch {

      return;

    }

    const answer = waiting.get(body.id ?? 0);

    if (answer && answer.sessionId === event.sessionId) {

      waiting.delete(body.id!);
      answer.done(body);

    }

  });

  return (sessionId, method, params) => new Promise((resolve, reject) => {

    const id = (n += 1);

    const timer = setTimeout(() => {

      waiting.delete(id);
      reject(new Error("no answer"));

    }, 2_000);

    waiting.set(id, { sessionId, done: (body) => {

      clearTimeout(timer);

      if (body.error) {

        reject(new Error(body.error.message ?? "failed"));

      } else {

        resolve();

      }

    } });

    root.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) }).catch((err) => {

      clearTimeout(timer);
      waiting.delete(id);
      reject(err);

    });

  });

}

/** Pauses a new target, rewrites its request headers, then lets it run. A worker's first fetch happens before any page script. */
async function watchTargets(root: CDPSession, filter: { type?: string; exclude?: boolean }[], pause: boolean) {

  if (fallback || listening.has(root)) {

    return;

  }

  const id = await browserIdentity().catch(() => null);

  if (!id?.metadata) {

    return;

  }

  listening.add(root);

  const command = commander(root);

  root.on("Target.attachedToTarget", (event: Arrived) => {

    const sessionId = event.sessionId;
    const type = event.targetInfo?.type;

    if (!sessionId || !type) {

      return;

    }

    const reply: Reply = (method, params) => command(sessionId, method, params);
    const deep = WORKER.has(type);

    void stamp(reply, id, !!event.waitingForDebugger, deep);

  });

  // held once, at creation, until the headed hints are on the wire. A later navigation of the same page is not held
  await root.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: pause, flatten: false, filter });

}

/** The override has to land before the target is released, or its first request still says HeadlessChrome. */
async function stamp(reply: Reply, id: Identity, waiting: boolean, deep: boolean) {

  try {

    await apply(reply, id, deep);

    if (deep) {

      await new Promise((resolve) => setTimeout(resolve, REWRITE_MS));
      await apply(reply, id, deep);

    }

  } catch {

    // the target is released below either way

  } finally {

    if (waiting) {

      await reply("Runtime.runIfWaitingForDebugger", {}).catch(() => {});

    }

  }

  if (!deep) {

    return;

  }

  // Playwright's own worker override can land after ours and put the headless brand back on the wire
  const again = setTimeout(() => void apply(reply, id, deep).catch(() => {}), 250);

  again.unref();

}

const revealed = new WeakMap<Page, Promise<void>>();

/** Puts the headed brand on the page's script and on its requests, once per page. The session stays: detaching clears both. */
function reveal(browser: Browser, chrome: Chrome, page: Page): Promise<void> {

  let done = revealed.get(page);

  if (!done) {

    done = stampPage(browser, chrome, page);
    revealed.set(page, done);

  }

  return done;

}

async function stampPage(browser: Browser, chrome: Chrome, page: Page) {

  if (fallback) {

    return;

  }

  const id = await browserIdentity().catch(() => null);

  if (!id?.metadata) {

    return;

  }

  const session = await sessionOf(browser, chrome, page);

  // a dedicated worker is a child of the page, not of the browser, so the page session is what hears it
  await watchTargets(session, CHILD_TARGETS, true).catch(() => {});
  await apply((method, params) => session.send(method, params), id, false).catch(() => {});

}

/** The page's own CDP session, made once: it streams the page and carries the phone emulation. */
function sessionOf(browser: Browser, chrome: Chrome, page: Page): Promise<CDPSession> {

  let session = chrome.sessions.get(page);

  if (!session) {

    session = chrome.context.newCDPSession(page);
    chrome.sessions.set(page, session);

    session.then((cdp) => cdp.on("Page.screencastFrame", ({ data, sessionId }) => {

      setTimeout(() => cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {}), FRAME_MS);

      if (chrome.cast !== cdp) {

        return;

      }

      browser.frame = page.url() === "about:blank" ? null : Buffer.from(data, "base64");

      for (const viewer of browser.viewers) {

        viewer.frame(browser.frame);

      }

    }), () => chrome.sessions.delete(page));

  }

  return session;

}

/** Streams the shown page while anyone watches it, and nothing otherwise. */
async function cast(browser: Browser, chrome: Chrome) {

  const page = chrome.page;
  const session = browser.viewers.size ? await sessionOf(browser, chrome, page) : null;

  if (chrome.page !== page || chrome.cast === session) {

    return;

  }

  chrome.cast?.send("Page.stopScreencast").catch(() => {});
  chrome.cast = session;

  await session?.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: WINDOW.width, maxHeight: WINDOW.height });

}

/** A phone gets a phone's layout and screen, so sites switch to their mobile pages; null puts the desktop window back. */
async function fit(browser: Browser, chrome: Chrome, page: Page, phone: Size | null) {

  const session = await sessionOf(browser, chrome, page);

  if (!phone) {

    await session.send("Emulation.clearDeviceMetricsOverride");
    return;

  }

  await session.send("Emulation.setDeviceMetricsOverride", { mobile: true, ...phone, deviceScaleFactor: 1, screenWidth: phone.width, screenHeight: phone.height, screenOrientation: { angle: 0, type: "portraitPrimary" } });

}

/** Gives an empty browser somewhere to start when the user holds it. */
async function land(browser: Browser, chrome: Chrome) {

  await fit(browser, chrome, chrome.page, browser.phone);

  const page = await current(browser, chrome);

  if (browser.hold && !browser.opening && page.url() === "about:blank") {

    await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: LOAD_MS }).catch(() => {});

  }

}

/** The browser process answers this itself, so it tells a slow page from a Chromium that is gone; only silence counts. */
function alive(browser: Browser, chrome: Chrome, ms = PING_MS): Promise<boolean> {

  const page = chrome.context.pages()[0];

  if (!page) {

    return Promise.resolve(true);

  }

  return within(sessionOf(browser, chrome, page).then((session) => session.send("Browser.getVersion")), ms).then(() => true, (err) => !(err instanceof Stalled));

}

/** Kills a Chromium that stopped answering; whoever still looks at or holds the browser gets a fresh one. */
function restart(browser: Browser, chrome: Chrome, why: string) {

  console.warn(`browser: Chromium ${chrome.pid} of ${browser.workspace} ${why} on ${chrome.page.url()}; killing it`);
  tell(browser, "The browser stopped responding, so it was restarted");
  browser.closing = kill(chrome);
  gone(browser, chrome);

}

function tell(browser: Browser, message: string) {

  for (const viewer of browser.viewers) {

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

/** True when this was the browser's running Chromium. */
function forget(browser: Browser, chrome: Chrome): boolean {

  chrome.dead = true;
  clearInterval(chrome.heartbeat);

  // its tabs stay as URLs, and come back with the next Chromium
  for (const tab of browser.tabs) {

    if (tab.page?.context() === chrome.context) {

      tab.page = null;

    }

  }

  announce(browser);

  if (browser.chrome !== chrome) {

    return false;

  }

  browser.chrome = null;
  browser.frame = undefined;

  return true;

}

/** Chromium exited, crashed or was killed: whoever still looks at or holds the browser gets a fresh one now. */
function gone(browser: Browser, chrome: Chrome) {

  // one that dies as it starts would otherwise relaunch in a loop
  if (forget(browser, chrome) && (browser.viewers.size || browser.hold) && Date.now() - chrome.born > 10_000) {

    act(browser, LAND_MS, (next) => land(browser, next)).catch((err) => tell(browser, reason(err)));

  }

}

/** The running Chromium, launched on first use. A launch that hangs is given up on, and killed if it ever finishes. */
async function chromeOf(browser: Browser): Promise<Chrome> {

  await browser.closing;

  if (browser.chrome) {

    return browser.chrome;

  }

  if (!browser.launching) {

    const started = launch(browser);

    const launching = within(started, LOAD_MS + STALL_MS).then((chrome) => {

      if (chrome.dead) {

        throw new Error("The browser closed as soon as it started");

      }

      browser.chrome = chrome;

      return chrome;

    }, (err) => {

      started.then((late) => {

        forget(browser, late);
        browser.closing = kill(late);

      }).catch(() => {});

      throw err instanceof Stalled ? new Error("The browser did not start in time") : err;

    });

    const done = () => {

      if (browser.launching === launching) {

        browser.launching = null;

      }

    };

    browser.launching = launching;
    launching.then(done, done);

  }

  return browser.launching;

}

/** True while someone is looking, holding, signing in, or a call is in flight. */
function busy(browser: Browser): boolean {

  return browser.viewers.size > 0 || !!browser.hold || browser.pending > 0 || browser.pins > 0 || browser.opening || browser.acting > 0;

}

/** Background Chromiums otherwise run at full speed, and a few of them make the one in front sluggish. */
function prefer(chrome: Chrome, foreground: boolean) {

  if (chrome.pid <= 1 || chrome.foreground === foreground) {

    return;

  }

  chrome.foreground = foreground;

  const level = foreground ? 0 : 10;

  if (process.platform === "linux") {

    // the browser is a process group, so the renderers have to drop with it
    const child = Bun.spawn(["renice", "-n", String(level), "-g", String(chrome.pid)], { stdout: "ignore", stderr: "ignore" });

    child.unref();
    void child.exited.catch(() => {});

    return;

  }

  try {

    setPriority(chrome.pid, level);

  } catch {

    // the lock can name a pid that has already gone

  }

}

function pace(browser: Browser, chrome: Chrome, full: boolean): Promise<void> {

  const job = chrome.pace.then(async () => {

    if (chrome.dead || browser.chrome !== chrome || chrome.full === full || (!full && busy(browser))) {

      return;

    }

    prefer(chrome, full);

    // set first, so a tab shown meanwhile gets the new rate too
    chrome.full = full;

    // a tab in the background stays slow either way
    await Promise.all(chrome.context.pages().map((page) => throttle(browser, chrome, page, full && page === chrome.page ? 1 : SLOW)));

  });

  chrome.pace = job.then(() => {}, () => {});

  return job;

}

function wake(browser: Browser, chrome: Chrome): Promise<void> {

  clearTimeout(browser.nap);

  return pace(browser, chrome, true);

}

function rest(browser: Browser) {

  clearTimeout(browser.nap);

  if (busy(browser) || !browser.chrome) {

    return;

  }

  browser.nap = setTimeout(() => {

    const chrome = browser.chrome;

    if (!chrome || busy(browser) || chrome.dead) {

      return;

    }

    void pace(browser, chrome, false);

  }, REST_MS);

  browser.nap.unref();

}

/** Every use of the browser goes through here: bounded, and a Chromium that stopped answering is killed, not waited on. */
async function act<T>(browser: Browser, ms: number, work: (chrome: Chrome) => Promise<T>): Promise<T> {

  touch(browser);
  browser.acting += 1;

  try {

    const chrome = await chromeOf(browser);

    await wake(browser, chrome);

    try {

      return await within(work(chrome), ms + STALL_MS);

    } catch (err) {

      // a timeout is a slow page or a gone Chromium; only the second is worth a restart
      if (err instanceof Stalled || (err instanceof errors.TimeoutError && !(await alive(browser, chrome)))) {

        if (!chrome.dead) {

          restart(browser, chrome, err instanceof Stalled ? "left a call unanswered" : "stopped answering");

        }

        throw new Error("The browser stopped responding, so it was restarted. Open the page again.");

      }

      if (chrome.dead) {

        throw new Error("The browser closed unexpectedly. Open the page again.");

      }

      throw err;

    }

  } finally {

    browser.acting -= 1;
    touch(browser);
    rest(browser);

  }

}

/** Idle means nobody used, watched, held or waited on the browser for IDLE_MS. */
function touch(browser: Browser) {

  clearTimeout(browser.idle);
  browser.idle = setTimeout(() => void close(browser.workspace), IDLE_MS);

  // an idle timer is no reason for the process to stay up
  browser.idle.unref();

}

/** The user's taps and keys land in the order they were made; a backlog on a slow page is refused, not replayed later. */
function enqueue<T>(browser: Browser, work: () => Promise<T>): Promise<T> {

  if (browser.pending >= MAX_PENDING) {

    return Promise.reject(new Error("The page is still busy with your last taps"));

  }

  browser.pending += 1;

  const next = browser.lane.then(work);

  browser.lane = next.catch(() => {});

  return next.finally(() => {

    browser.pending -= 1;
    rest(browser);

  });

}

/** Closing lets Chromium write the profile's logins out; one that will not close in time is killed. */
async function shut(browser: Browser) {

  const chrome = browser.chrome ?? (await browser.launching?.catch(() => null));

  if (!chrome) {

    return;

  }

  forget(browser, chrome);

  const closing = within(chrome.context.close(), 5000).catch(() => kill(chrome));

  browser.closing = closing;
  await closing;

  if (browser.closing === closing) {

    browser.closing = null;

  }

}

/** `force` is for a deleted agent, whose browser nobody can use any more. */
export async function close(workspace: string, force = false) {

  const browser = browsers.get(workspace);

  if (!browser) {

    return;

  }

  // someone looking at, holding or about to be handed the browser counts as using it
  if (!force && (browser.viewers.size || browser.hold || browser.pins)) {

    touch(browser);
    return;

  }

  clearTimeout(browser.idle);
  clearTimeout(browser.nap);

  if (force) {

    browsers.delete(workspace);
    browser.hold?.resolve();
    browser.hold = null;
    browser.viewers.clear();

  }

  await shut(browser);

}

export async function closeAll() {

  await Promise.all([...browsers.values()].map((browser) => {

    clearTimeout(browser.idle);
    clearTimeout(browser.nap);

    return shut(browser);

  }));

}

/** Keeps the browser open, on its current page, for as long as `work` runs. */
export async function pinned<T>(workspace: string, work: () => Promise<T>): Promise<T> {

  const browser = browserOf(workspace);

  browser.pins += 1;

  if (browser.chrome) {

    void wake(browser, browser.chrome);

  }

  try {

    return await work();

  } finally {

    browser.pins -= 1;
    touch(browser);
    rest(browser);

  }

}

/** Sends frames to `viewer` until the returned function is called. A closed browser stays closed and shows as blank. */
export function watch(workspace: string, viewer: Viewer): () => void {

  const browser = browserOf(workspace);

  browser.viewers.add(viewer);

  // a static page sends no new frames, so a second viewer would otherwise see nothing
  if (browser.frame !== undefined || !(browser.chrome || browser.launching)) {

    viewer.frame(browser.frame ?? null);

  }

  viewer.tabs?.(viewsOf(browser));

  if (browser.chrome || browser.launching) {

    act(browser, ACTION_MS, (chrome) => cast(browser, chrome)).catch((err) => viewer.fail(reason(err)));

  }

  return () => {

    browser.viewers.delete(viewer);

    if (!browser.viewers.size && browser.chrome) {

      within(cast(browser, browser.chrome), ACTION_MS).catch(() => {});

    }

    touch(browser);
    rest(browser);

  };

}

/**
 * The user takes the browser; the agent's next browser action waits until they hand it back.
 * `size` fits the page to a phone, so sites switch to their mobile layout instead of shrinking to a thumbnail.
 */
export async function takeOver(workspace: string, size?: Size) {

  const browser = browserOf(workspace);
  const clamp = (value: number, max: number) => Math.round(Math.min(max, Math.max(320, value)));

  browser.hold ??= Promise.withResolvers<void>();
  browser.phone = size ? { width: clamp(size.width, WINDOW.width), height: clamp(size.height, WINDOW.height) } : null;

  await enqueue(browser, () => act(browser, LAND_MS, (chrome) => land(browser, chrome)));

}

export async function handBack(workspace: string) {

  const browser = browsers.get(workspace);

  if (!browser) {

    return;

  }

  const chrome = browser.chrome;
  const phone = browser.phone;

  browser.hold?.resolve();
  browser.hold = null;
  browser.phone = null;

  if (!phone || !chrome) {

    rest(browser);

    return;

  }

  await enqueue(browser, () => within(Promise.all(chrome.context.pages().map((page) => fit(browser, chrome, page, null))), ACTION_MS)).catch(() => {});
  rest(browser);

}

/** What the user does in take-over. Coordinates are fractions of the frame, so any screen size maps onto the page. */
export async function input(workspace: string, event: Input) {

  const browser = browsers.get(workspace);

  if (!browser?.hold) {

    throw new Error("Take over the browser first");

  }

  // looking at the page changes nothing; only what the user actually does makes the agent's refs stale
  browser.touched = true;

  await enqueue(browser, () => act(browser, INPUT_MS, (chrome) => perform(browser, chrome.page, event)));

}

/** The user's tab strip in take-over: `id` names the tab to show or close. */
export async function userTab(workspace: string, action: TabAction, id?: number) {

  const browser = browsers.get(workspace);

  if (!browser?.hold) {

    throw new Error("Take over the browser first");

  }

  browser.touched = true;

  await enqueue(browser, () => act(browser, LAND_MS, async (chrome) => {

    const tab = action === "new" ? addTab(browser, "about:blank", browser.active) : browser.tabs.find((one) => one.id === id);

    if (!tab) {

      return;

    }

    if (action === "close") {

      await closeTab(browser, chrome, tab);

    } else {

      await focus(browser, chrome, tab);

    }

    // a suspended tab loads again, and a new one starts somewhere
    await land(browser, chrome);

  }));

}

async function perform(browser: Browser, page: Page, event: Input) {

  // the frame shows the visual viewport, which a zoomed-out phone page makes wider than the screen; the mouse takes page pixels
  const view = (await within(page.evaluate(() => ({ left: visualViewport!.offsetLeft, top: visualViewport!.offsetTop, width: visualViewport!.width, height: visualViewport!.height })), 2000).catch(() => null)) ?? { left: 0, top: 0, ...(browser.phone ?? WINDOW) };
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
async function agentBrowser(workspace: string, signal?: AbortSignal, refs = false): Promise<Browser> {

  const browser = browserOf(workspace);

  while (browser.hold) {

    const hold = browser.hold.promise;

    await new Promise<void>((resolve) => {

      hold.then(resolve);
      signal?.addEventListener("abort", () => resolve(), { once: true });

    });

    if (signal?.aborted) {

      throw new Error("aborted");

    }

  }

  if (browser.touched && refs) {

    browser.touched = false;

    throw new Error(`The user used the browser while you worked, so that did not run. The page now:\n\n${await act(browser, ACTION_MS * 2, (chrome) => read(browser, chrome.page))}`);

  }

  browser.touched = false;

  return browser;

}

async function settle(page: Page) {

  await page.waitForLoadState("domcontentloaded", { timeout: LOAD_MS }).catch(() => {});

  // most pages finish their own fetches within a few seconds; waiting longer only stalls the agent
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});

}

/** What a click or key does shows up a moment after it returns: a new browser, a menu, a navigation starting. */
async function after(chrome: Chrome) {

  await Bun.sleep(500);
  await settle(chrome.page);

}

async function read(browser: Browser, page: Page): Promise<string> {

  const [tree, title] = await Promise.all([page.ariaSnapshot({ mode: "ai", timeout: ACTION_MS }), page.title()]);
  const cut = tree.length > MAX_SNAPSHOT ? `${tree.slice(0, MAX_SNAPSHOT)}\n... page cut at ${MAX_SNAPSHOT} characters` : tree;
  const at = browser.tabs.findIndex((tab) => tab.page === page);
  const tabs = browser.tabs.length > 1 && at !== -1 ? `\n\n(tab ${at + 1} of ${browser.tabs.length}; <tab> lists them)` : "";

  return `${page.url()}\n${title}\n\n${cut}${tabs}`;

}

function listTabs(browser: Browser): string {

  if (!browser.tabs.length) {

    return "No tabs are open yet. Use <open https://...> first.";

  }

  return browser.tabs.map((tab, index) => `${index + 1}. ${tab.title || "(untitled)"} — ${tab.url}${tab.id === browser.active ? "  ← current" : ""}`).join("\n");

}

function nthTab(browser: Browser, raw: string): Tab {

  const tab = /^\d+$/.test(raw) ? browser.tabs[Number(raw) - 1] : undefined;

  if (!tab) {

    throw new Error(`There is no tab ${raw}. The tabs:\n\n${listTabs(browser)}`);

  }

  return tab;

}

/** `<tab>` lists the tabs; `<tab 2>` shows one, `<tab https://…>` opens one, `<tab close 2>` closes one. Numbers are places in the list. */
export async function tab(workspace: string, target: string, signal?: AbortSignal): Promise<string> {

  const [word = "", arg = ""] = target.trim().split(/\s+/);
  const browser = await agentBrowser(workspace, signal);
  const running = !!(browser.chrome || browser.launching);

  if (!word) {

    return listTabs(browser);

  }

  if (word.toLowerCase() === "close") {

    const doomed = arg ? nthTab(browser, arg) : activeTab(browser);

    if (doomed) {

      await (running ? act(browser, ACTION_MS, (chrome) => closeTab(browser, chrome, doomed)) : closeTab(browser, null, doomed));

    }

    return listTabs(browser);

  }

  const url = /^https?:\/\//i.test(word) ? word : word.toLowerCase() === "new" && arg ? checkedUrl(arg) : "";

  if (!url && !/^\d+$/.test(word)) {

    throw new Error("tab takes a number to switch to, a URL to open in a new tab, or close and a number:\n\n  <tab 2>\n  <tab https://example.com>\n  <tab close 2>");

  }

  const next = url ? addTab(browser, url, browser.active || null) : nthTab(browser, word);

  // a closed browser starts on this tab, rather than on the old one and then a second page
  if (!running) {

    browser.active = next.id;

  }

  browser.opening = !!url;

  try {

    return await act(browser, LOAD_MS + ACTION_MS * 2, async (chrome) => {

      if (chrome.page !== next.page) {

        await focus(browser, chrome, next);

      }

      if (url) {

        await chrome.page.goto(url, { waitUntil: "domcontentloaded", timeout: LOAD_MS });
        await settle(chrome.page);

      }

      browser.opening = false;

      return read(browser, await current(browser, chrome));

    });

  } finally {

    browser.opening = false;
    rest(browser);

  }

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
  const browser = await agentBrowser(workspace, signal);

  browser.opening = true;

  try {

    return await act(browser, LOAD_MS + ACTION_MS * 2, async (chrome) => {

      await chrome.page.goto(target, { waitUntil: "domcontentloaded", timeout: LOAD_MS });
      await settle(chrome.page);

      return read(browser, chrome.page);

    });

  } finally {

    browser.opening = false;
    rest(browser);

  }

}

export async function look(workspace: string, signal?: AbortSignal): Promise<string> {

  const browser = await agentBrowser(workspace, signal);
  const blank = new Error("No page is open yet. Use <open https://...> first.");

  // a closed browser with no tab to bring back has no page to read, and launching one just to say so is waste
  if (!browser.chrome && !browser.launching && !/^https?:\/\//i.test(activeTab(browser)?.url ?? "")) {

    throw blank;

  }

  return act(browser, LOAD_MS + ACTION_MS * 2, async (chrome) => {

    const page = await current(browser, chrome);

    if (page.url() === "about:blank") {

      throw blank;

    }

    return read(browser, page);

  });

}

export async function click(workspace: string, ref: string, signal?: AbortSignal): Promise<string> {

  const target = refOf(ref);
  const browser = await agentBrowser(workspace, signal, true);

  return act(browser, LOAD_MS + ACTION_MS * 3, async (chrome) => {

    await chrome.page.locator(`aria-ref=${target}`).click({ timeout: ACTION_MS });
    await after(chrome);

    return read(browser, chrome.page);

  });

}

export async function type(workspace: string, ref: string, text: string, signal?: AbortSignal): Promise<string> {

  const target = refOf(ref);
  const browser = await agentBrowser(workspace, signal, true);

  await act(browser, ACTION_MS, (chrome) => chrome.page.locator(`aria-ref=${target}`).fill(text, { timeout: ACTION_MS }));

  return `typed ${text.length} characters into ${target}`;

}

export async function press(workspace: string, key: string, signal?: AbortSignal): Promise<string> {

  const browser = await agentBrowser(workspace, signal, true);

  return act(browser, LOAD_MS + ACTION_MS * 2, async (chrome) => {

    await chrome.page.keyboard.press(key.trim() || "Enter");
    await after(chrome);

    return read(browser, chrome.page);

  });

}

export async function pageUrl(workspace: string): Promise<string> {

  return browsers.get(workspace)?.chrome?.page.url() ?? "about:blank";

}
