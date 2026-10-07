import { readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { setPriority } from "node:os";
import { join, sep } from "node:path";
import { connect as connectTls } from "node:tls";

import { chromium, errors, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright";

const IDLE_MS = Number(process.env.PTS_BROWSER_IDLE_MS ?? 10 * 60_000);
const ACTION_MS = 15_000;
const LOAD_MS = 30_000;
const INPUT_MS = 10_000;

// an element from the outline is clickable within a moment or covered; waiting longer only stalls the agent
const ELEMENT_MS = 5_000;

// most pages finish their own fetches within a few seconds; waiting longer only stalls the agent
const QUIET_MS = 3_000;

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

const WORKER = new Set(["worker", "service_worker", "shared_worker"]);

const WEB_URL = /^https?:\/\//i;

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

type Reply = (method: string, params: object) => Promise<unknown>;

const browsers = new Map<string, Browser>();

let fallback = false;
let identity: Promise<Identity> | null = null;

/** What Chromium is pointed at: the shared proxy, or the local relay that signs in to it. */
let proxy: { server: string; host: string } | null = null;
let relay: Server | null = null;

/** Each user's time zone, keyed by the folder their agents' workspaces sit in. */
const zones = new Map<string, string | null>();

/** What `adopt` is doing with each page, so whoever made the page can wait until it is shown. */
const adopted = new WeakMap<Page, Promise<void>>();
const revealed = new WeakMap<Page, Promise<void>>();
const listening = new WeakSet<CDPSession>();

class Stalled extends Error {}

export const reason = (err: unknown) => err instanceof Error ? err.message.split("\n")[0] : String(err);

/** Chromium's profile sits beside the workspace, never in it: Chromium runs outside the sandbox and would follow any link the agent's shell planted there. */
export const profileOf = (workspace: string) => `${workspace}.browser`;

const tabsFile = (browser: Browser) => join(profileOf(browser.workspace), "Tabs.json");
const activeTab = (browser: Browser) => browser.tabs.find((tab) => tab.id === browser.active);
const tabOfPage = (browser: Browser, page: Page) => browser.tabs.find((tab) => tab.page === page);
const viewsOf = (browser: Browser): TabView[] => browser.tabs.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url, active: tab.id === browser.active, live: !!tab.page }));
const zoneOf = (workspace: string) => [...zones].find(([scope]) => workspace.startsWith(scope + sep))?.[1] ?? null;
const running = (browser: Browser) => !!(browser.chrome || browser.launching);

function browserOf(workspace: string): Browser {

  let browser = browsers.get(workspace);

  if (!browser) {

    browser = { workspace, tabs: [], active: 0, lastTab: 0, announced: "", saved: "", chrome: null, launching: null, closing: null, viewers: new Set(), hold: null, phone: null, touched: false, pins: 0, opening: false, lane: Promise.resolve(), pending: 0, acting: 0 };
    browsers.set(workspace, browser);
    restore(browser);

  }

  return browser;

}

/** The tabs the last Chromium left. Only web URLs come back from it. */
function restore(browser: Browser) {

  let saved: { active?: unknown; tabs?: { url?: unknown; title?: unknown }[] };

  try {

    saved = JSON.parse(readFileSync(tabsFile(browser), "utf8"));

  } catch {

    return;

  }

  for (const one of (Array.isArray(saved.tabs) ? saved.tabs : []).slice(0, MAX_TABS)) {

    if (typeof one?.url === "string" && WEB_URL.test(one.url)) {

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

/** Tells viewers what changed in the tab strip, and writes it down so a new Chromium can bring the tabs back. */
function announce(browser: Browser) {

  const views = viewsOf(browser);
  const json = JSON.stringify(views);

  if (json !== browser.announced) {

    browser.announced = json;
    browser.viewers.forEach((viewer) => viewer.tabs?.(views));

  }

  const saved = JSON.stringify({ active: browser.tabs.findIndex((tab) => tab.id === browser.active), tabs: browser.tabs.map(({ url, title }) => ({ url, title })) });

  if (saved === browser.saved || !browsers.has(browser.workspace)) {

    return;

  }

  browser.saved = saved;

  // no profile yet, or the agent is being deleted
  try {

    writeFileSync(tabsFile(browser), saved);

  } catch {}

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

/** `en-US,en;q=0.9`, the shape Chrome puts on Accept-Language. */
const languageHeader = (languages: string[]) => languages.filter(Boolean).map((language, index) => index ? `${language};q=${Math.max(0.1, 1 - index * 0.1).toFixed(1)}` : language).join(",");

/** Probe the real client hints once. A metadata-less userAgent override drops Sec-CH-UA and never reaches workers. */
function browserIdentity(): Promise<Identity> {

  identity ??= chromium.launch({ channel: "chromium", headless: true, chromiumSandbox: true }).then(async (probe) => {

    try {

      const page = await probe.newPage();

      // userAgentData exists only in a secure context, and about:blank is not one; nothing is fetched
      await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html>" }));

      const read = await page.goto("https://example.com", { timeout: 10_000 }).then(() => page.evaluate(async () => {

        type Hint = { brand: string; version: string };
        type High = { architecture?: string; bitness?: string; model?: string; platformVersion?: string; uaFullVersion?: string; fullVersionList?: Hint[]; wow64?: boolean; formFactors?: string[] };

        const data = (navigator as Navigator & { userAgentData?: { brands: Hint[]; mobile: boolean; platform: string; getHighEntropyValues: (hints: string[]) => Promise<High> } }).userAgentData;
        const high = await data?.getHighEntropyValues(["architecture", "bitness", "model", "platformVersion", "uaFullVersion", "fullVersionList", "wow64", "formFactors"]);

        return { ua: navigator.userAgent, brands: data?.brands ?? [], mobile: data?.mobile ?? false, platform: data?.platform ?? "", navPlatform: navigator.platform, languages: [...navigator.languages], high };

      })).catch(() => null);

      const ua = (read?.ua ?? await page.evaluate(() => navigator.userAgent).catch(() => "")).replace("HeadlessChrome", "Chrome");
      const base = { ua, acceptLanguage: languageHeader(read?.languages ?? []), platform: read?.navPlatform ?? "" };

      if (!read?.high?.fullVersionList?.length || !read.brands.length) {

        return { ...base, metadata: null };

      }

      const high = read.high;

      return {

        ...base,

        metadata: {

          brands: headed(read.brands),
          fullVersionList: headed(high.fullVersionList!),
          ...(high.uaFullVersion ? { fullVersion: high.uaFullVersion } : {}),
          platform: read.platform,
          platformVersion: high.platformVersion ?? "",
          architecture: high.architecture ?? "",
          model: high.model ?? "",
          mobile: read.mobile,
          ...(high.bitness ? { bitness: high.bitness } : {}),
          ...(typeof high.wow64 === "boolean" ? { wow64: high.wow64 } : {}),

          // a headless probe often omits the form factor a site asks for with Accept-CH; desktop Chrome answers "Desktop"
          ...(high.formFactors?.length ? { formFactors: high.formFactors } : !read.mobile ? { formFactors: ["Desktop"] } : {}),

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
async function start(profile: string, zone: string | null): Promise<BrowserContext> {

  // behind a proxy, WebRTC and DNS would still go out from this machine; loopback goes through it too, so no page reaches this machine's services
  const proxied = proxy ? [`--proxy-server=${proxy.server}`, "--proxy-bypass-list=<-loopback>", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE ${proxy.host}`] : [];

  // --headless and the debugging pipe each enable AutomationControlled, which is what makes navigator.webdriver true
  const args = [`--window-size=${WINDOW.width},${WINDOW.height}`, `--screen-info=${SCREEN}`, `--disk-cache-size=${DISK_CACHE_BYTES}`, `--renderer-process-limit=${RENDERERS}`, "--disable-blink-features=AutomationControlled", ...proxied];

  // TZ rather than Playwright's timezoneId, which is a per-page override that service workers never get; Playwright turns Chromium's own sandbox off unless asked
  const options = { headless: true, viewport: null, timeout: LOAD_MS, chromiumSandbox: true, env: zone ? { ...process.env, TZ: zone } : process.env };

  if (!fallback) {

    try {

      const id = await browserIdentity();

      // `--accept-lang` takes tags; the q-values belong on the header, which the network override writes
      const acceptLang = id.acceptLanguage.split(",").map((part) => part.split(";")[0].trim()).filter(Boolean).join(",");

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
export const proxyLabel = (url: URL | null) => url ? `${url.protocol}//${url.username ? `${decodeURIComponent(url.username)}@` : ""}${url.host}` : null;

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

/** The time zone for every Chromium under `scope`, or null for this machine's. Running ones restart onto it, and their tabs come back. */
export async function setZone(scope: string, next: string | null) {

  if ((next || null) !== zoneOf(`${scope}${sep}`)) {

    zones.set(scope, next || null);
    await relaunch(scope);

  }

}

/** Whoever still looks at or holds the browser gets it back at once. */
function reland(browser: Browser) {

  if (browser.viewers.size || browser.hold) {

    act(browser, LAND_MS, (next) => land(browser, next)).catch((err) => tell(browser, reason(err)));

  }

}

/** Closes every running Chromium, or those under `scope`, so the next one starts with the new settings. */
async function relaunch(scope?: string) {

  await Promise.all([...browsers.values()].filter((browser) => running(browser) && (!scope || browser.workspace.startsWith(scope + sep))).map(async (browser) => {

    await shut(browser);
    reland(browser);

  }));

}

/** The client-hints probe launches a Chromium of its own; a server does it at boot, not on the agent's first <open>. */
export const warm = () => void browserIdentity().catch(() => {});

/** Chromium's profile lock names its pid, for a kill when it stops answering. */
function pidOf(profile: string): number {

  try {

    return Number(readlinkSync(join(profile, "SingletonLock")).split("-").pop()) || 0;

  } catch {

    return 0;

  }

}

async function launch(browser: Browser): Promise<Chrome> {

  if (Bun.semver.order(Bun.version, MIN_BUN) < 0) {

    throw new Error(`The browser needs Bun ${MIN_BUN} or newer, and this is ${Bun.version}. Run: bun upgrade`);

  }

  const profile = profileOf(browser.workspace);
  const context = await start(profile, zoneOf(browser.workspace));
  const page = context.pages()[0] ?? (await context.newPage());
  const chrome: Chrome = { context, pid: pidOf(profile), born: Date.now(), dead: false, page, claims: [], sessions: new Map(), cast: null, pace: Promise.resolve() };
  const handle = context.browser();

  // service workers are not children of a page. A new page is paused so its first request waits for the headed client hints
  if (handle) {

    await watchTargets(await handle.newBrowserCDPSession(), ROOT_TARGETS).catch(() => {});

  }

  context.on("close", () => gone(browser, chrome));
  context.on("page", (next) => void adopt(browser, chrome, next, chrome.claims.shift()).catch(() => {}));

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

/** Every page gets this once and becomes a tab: `claimed` when it was made for a suspended one, a new tab when the site opened it. */
function adopt(browser: Browser, chrome: Chrome, page: Page, claimed?: Tab): Promise<void> {

  const tab = claimed ?? addTab(browser, page.url(), browser.active || null);

  tab.page = page;

  page.on("crash", () => void page.close().catch(() => {}));

  page.on("close", () => {

    chrome.sessions.delete(page);

    // a dying Chromium closes its pages just before its context; waiting a turn lets that mark it dead, which suspends the tabs instead.
    // A tab suspended or closed on purpose has let go of its page already
    setTimeout(() => !chrome.dead && tab.page === page && void closeTab(browser, chrome, tab).catch(() => {}), 0);

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

    return show(browser, chrome, tab.page);

  }

  chrome.claims.push(tab);

  // the context's "page" event hands the new page to the claim and shows it
  await adopted.get(await chrome.context.newPage());

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

    } else if (tab.page && live < LIVE_TABS) {

      live += 1;

    } else if (tab.page) {

      const page = tab.page;

      tab.page = null;
      void page.close().catch(() => {});

    }

  });

}

const go = async (page: Page, url: string) => {

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: LOAD_MS });
  await settle(page);

};

/** The active tab's page. One suspended when its Chromium closed loads its URL again the first time it is needed. */
async function current(browser: Browser, chrome: Chrome): Promise<Page> {

  const page = chrome.page;
  const tab = tabOfPage(browser, page);

  if (tab && !browser.opening && page.url() === "about:blank" && WEB_URL.test(tab.url)) {

    await go(page, tab.url).catch(() => {});

  }

  return page;

}

/** User-Agent and Sec-CH-UA-* for one target. Emulation is what script reads; Network is what the request carries. */
async function apply(reply: Reply, id: Identity, deep: boolean) {

  if (!id.metadata || !id.ua) {

    return;

  }

  const params = { userAgent: id.ua, ...(id.acceptLanguage ? { acceptLanguage: id.acceptLanguage } : {}), ...(id.platform ? { platform: id.platform } : {}), userAgentMetadata: id.metadata };

  await reply("Emulation.setUserAgentOverride", params);

  // enabling the network domain on a page would deliver every request, so only a worker gets that fallback
  await reply("Network.setUserAgentOverride", params).catch(async () => {

    if (deep) {

      await reply("Network.enable", {});
      await reply("Network.setUserAgentOverride", params);

    }

  });

}

/**
 * A flat child session is not addressable from here, so commands go the old way and replies come back as events.
 * One listener per root reads each reply once, and parses nothing while no command waits.
 */
function commander(root: CDPSession) {

  const waiting = new Map<number, { sessionId: string; done: (error?: { message?: string }) => void }>();

  let n = 0;

  root.on("Target.receivedMessageFromTarget", (event: { sessionId?: string; message?: string }) => {

    if (!waiting.size || !event.message) {

      return;

    }

    let body: { id?: number; error?: { message?: string } } = {};

    try {

      body = JSON.parse(event.message);

    } catch {}

    const answer = waiting.get(body.id ?? 0);

    if (answer && answer.sessionId === event.sessionId) {

      answer.done(body.error);

    }

  });

  return (sessionId: string, method: string, params: object) => new Promise<void>((resolve, reject) => {

    const id = (n += 1);
    const finish = (err?: unknown) => {

      clearTimeout(timer);
      waiting.delete(id);

      if (err) {

        reject(err);

      } else {

        resolve();

      }

    };

    const timer = setTimeout(() => finish(new Error("no answer")), 2_000);

    waiting.set(id, { sessionId, done: (error) => finish(error && new Error(error.message ?? "failed")) });
    root.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) }).catch(finish);

  });

}

/** Pauses each new target, rewrites its request headers, then lets it run. A worker's first fetch happens before any page script. */
async function watchTargets(root: CDPSession, filter: { type?: string; exclude?: boolean }[]) {

  if (fallback || listening.has(root)) {

    return;

  }

  const id = await browserIdentity().catch(() => null);

  if (!id?.metadata) {

    return;

  }

  listening.add(root);

  const command = commander(root);

  root.on("Target.attachedToTarget", (event: { sessionId?: string; waitingForDebugger?: boolean; targetInfo?: { type?: string } }) => {

    const { sessionId, targetInfo } = event;

    if (sessionId && targetInfo?.type) {

      void stamp((method, params) => command(sessionId, method, params), id, !!event.waitingForDebugger, WORKER.has(targetInfo.type));

    }

  });

  // held once, at creation, until the headed hints are on the wire. A later navigation of the same page is not held
  await root.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: false, filter });

}

/** The override has to land before the target is released, or its first request still says HeadlessChrome. */
async function stamp(reply: Reply, id: Identity, waiting: boolean, deep: boolean) {

  try {

    await apply(reply, id, deep);

    if (deep) {

      await Bun.sleep(REWRITE_MS);
      await apply(reply, id, deep);

    }

  } catch {

    // the target is released below either way

  } finally {

    if (waiting) {

      await reply("Runtime.runIfWaitingForDebugger", {}).catch(() => {});

    }

  }

  // Playwright's own worker override can land after ours and put the headless brand back on the wire
  if (deep) {

    setTimeout(() => void apply(reply, id, deep).catch(() => {}), 250).unref();

  }

}

/** Puts the headed brand on the page's script and on its requests, once per page. The session stays: detaching clears both. */
function reveal(browser: Browser, chrome: Chrome, page: Page): Promise<void> {

  if (!revealed.has(page)) {

    revealed.set(page, (async () => {

      const id = fallback ? null : await browserIdentity().catch(() => null);

      if (!id?.metadata) {

        return;

      }

      const session = await sessionOf(browser, chrome, page);

      // a dedicated worker is a child of the page, not of the browser, so the page session is what hears it
      await watchTargets(session, CHILD_TARGETS).catch(() => {});
      await apply((method, params) => session.send(method as any, params), id, false).catch(() => {});

    })());

  }

  return revealed.get(page)!;

}

/** The page's own CDP session, made once: it streams the page and carries the phone emulation. */
function sessionOf(browser: Browser, chrome: Chrome, page: Page): Promise<CDPSession> {

  let session = chrome.sessions.get(page);

  if (!session) {

    session = chrome.context.newCDPSession(page);
    chrome.sessions.set(page, session);

    session.then((cdp) => cdp.on("Page.screencastFrame", ({ data, sessionId }) => {

      setTimeout(() => cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {}), FRAME_MS);

      if (chrome.cast === cdp) {

        browser.frame = page.url() === "about:blank" ? null : Buffer.from(data, "base64");
        browser.viewers.forEach((viewer) => viewer.frame(browser.frame!));

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

  await (phone
    ? session.send("Emulation.setDeviceMetricsOverride", { mobile: true, ...phone, deviceScaleFactor: 1, screenWidth: phone.width, screenHeight: phone.height, screenOrientation: { angle: 0, type: "portraitPrimary" } })
    : session.send("Emulation.clearDeviceMetricsOverride"));

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

  return page ? within(sessionOf(browser, chrome, page).then((session) => session.send("Browser.getVersion")), ms).then(() => true, (err) => !(err instanceof Stalled)) : Promise.resolve(true);

}

/** Kills a Chromium that stopped answering; whoever still looks at or holds the browser gets a fresh one. */
function restart(browser: Browser, chrome: Chrome, why: string) {

  console.warn(`browser: Chromium ${chrome.pid} of ${browser.workspace} ${why} on ${chrome.page.url()}; killing it`);
  tell(browser, "The browser stopped responding, so it was restarted");
  browser.closing = kill(chrome);
  gone(browser, chrome);

}

const tell = (browser: Browser, message: string) => browser.viewers.forEach((viewer) => viewer.fail(message));

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

/** True when this was the browser's running Chromium. Its tabs stay as URLs, and come back with the next one. */
function forget(browser: Browser, chrome: Chrome): boolean {

  chrome.dead = true;
  clearInterval(chrome.heartbeat);

  for (const tab of browser.tabs.filter((one) => one.page?.context() === chrome.context)) {

    tab.page = null;

  }

  announce(browser);

  if (browser.chrome !== chrome) {

    return false;

  }

  browser.chrome = null;
  browser.frame = undefined;

  return true;

}

/** Chromium exited, crashed or was killed. One that dies as it starts would otherwise relaunch in a loop. */
function gone(browser: Browser, chrome: Chrome) {

  if (forget(browser, chrome) && Date.now() - chrome.born > 10_000) {

    reland(browser);

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

      return (browser.chrome = chrome);

    }, (err) => {

      started.then((late) => {

        forget(browser, late);
        browser.closing = kill(late);

      }).catch(() => {});

      throw err instanceof Stalled ? new Error("The browser did not start in time") : err;

    });

    const done = () => browser.launching === launching && (browser.launching = null);

    browser.launching = launching;
    launching.then(done, done);

  }

  return browser.launching;

}

/** True while someone is looking, holding, signing in, or a call is in flight. */
const busy = (browser: Browser) => browser.viewers.size > 0 || !!browser.hold || browser.pending > 0 || browser.pins > 0 || browser.opening || browser.acting > 0;

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

  // the lock can name a pid that has already gone
  try {

    setPriority(chrome.pid, level);

  } catch {}

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

    if (chrome && !busy(browser) && !chrome.dead) {

      void pace(browser, chrome, false);

    }

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

      throw chrome.dead ? new Error("The browser closed unexpectedly. Open the page again.") : err;

    }

  } finally {

    browser.acting -= 1;
    touch(browser);
    rest(browser);

  }

}

/** Idle means nobody used, watched, held or waited on the browser for IDLE_MS. An idle timer is no reason for the process to stay up. */
function touch(browser: Browser) {

  clearTimeout(browser.idle);
  browser.idle = setTimeout(() => void close(browser.workspace), IDLE_MS);
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

  clearTimeout(browser.idle);
  clearTimeout(browser.nap);

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

    return touch(browser);

  }

  if (force) {

    browsers.delete(workspace);
    browser.hold?.resolve();
    browser.hold = null;
    browser.viewers.clear();

  }

  await shut(browser);

}

export const closeAll = () => Promise.all([...browsers.values()].map(shut));

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
  if (browser.frame !== undefined || !running(browser)) {

    viewer.frame(browser.frame ?? null);

  }

  viewer.tabs?.(viewsOf(browser));

  if (running(browser)) {

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

  if (phone && chrome) {

    await enqueue(browser, () => within(Promise.all(chrome.context.pages().map((page) => fit(browser, chrome, page, null))), ACTION_MS)).catch(() => {});

  }

  rest(browser);

}

/** The browser the user holds. Looking changes nothing; only what the user actually does makes the agent's refs stale. */
function held(workspace: string): Browser {

  const browser = browsers.get(workspace);

  if (!browser?.hold) {

    throw new Error("Take over the browser first");

  }

  browser.touched = true;

  return browser;

}

/** What the user does in take-over. Coordinates are fractions of the frame, so any screen size maps onto the page. */
export async function input(workspace: string, event: Input) {

  const browser = held(workspace);

  await enqueue(browser, () => act(browser, INPUT_MS, (chrome) => perform(browser, chrome.page, event)));

}

/** The user's tab strip in take-over: `id` names the tab to show or close. */
export async function userTab(workspace: string, action: TabAction, id?: number) {

  const browser = held(workspace);

  await enqueue(browser, () => act(browser, LAND_MS, async (chrome) => {

    const tab = action === "new" ? addTab(browser, "about:blank", browser.active) : browser.tabs.find((one) => one.id === id);

    if (!tab) {

      return;

    }

    await (action === "close" ? closeTab(browser, chrome, tab) : focus(browser, chrome, tab));

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

      return page.mouse.click(...at(event.x, event.y));

    case "scroll":

      await page.mouse.move(...at(event.x, event.y));
      return page.mouse.wheel(event.dx * view.width, event.dy * view.height);

    case "text":

      return page.keyboard.insertText(event.text);

    case "key":

      return page.keyboard.press(event.key);

    case "drag":

      // slider captchas want something like a hand: a press, a few steps across, a release
      await page.mouse.move(...at(event.x, event.y));
      await page.mouse.down();
      await page.mouse.move(...at(event.toX, event.toY), { steps: 12 });
      return page.mouse.up();

    case "back":

      await page.goBack({ waitUntil: "commit", timeout: INPUT_MS });

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

  const touched = browser.touched;

  browser.touched = false;

  if (touched && refs) {

    throw new Error(`The user used the browser while you worked, so that did not run. The page now:\n\n${await act(browser, ACTION_MS * 2, (chrome) => read(browser, chrome.page))}`);

  }

  return browser;

}

async function settle(page: Page) {

  await page.waitForLoadState("domcontentloaded", { timeout: LOAD_MS }).catch(() => {});

  await page.waitForLoadState("networkidle", { timeout: QUIET_MS }).catch(() => {});

}

async function read(browser: Browser, page: Page): Promise<string> {

  const [tree, title] = await Promise.all([page.ariaSnapshot({ mode: "ai", timeout: ACTION_MS }), page.title()]);
  const cut = tree.length > MAX_SNAPSHOT ? `${tree.slice(0, MAX_SNAPSHOT)}\n... page cut at ${MAX_SNAPSHOT} characters` : tree;
  const at = browser.tabs.findIndex((tab) => tab.page === page);
  const tabs = browser.tabs.length > 1 && at !== -1 ? `\n\n(tab ${at + 1} of ${browser.tabs.length}; <tab> lists them)` : "";

  return `${page.url()}\n${title}\n\n${cut}${tabs}`;

}

const listTabs = (browser: Browser) => browser.tabs.length ? browser.tabs.map((tab, index) => `${index + 1}. ${tab.title || "(untitled)"} — ${tab.url}${tab.id === browser.active ? "  ← current" : ""}`).join("\n") : "No tabs are open yet. Use <open https://...> first.";

function nthTab(browser: Browser, raw: string): Tab {

  const tab = /^\d+$/.test(raw) ? browser.tabs[Number(raw) - 1] : undefined;

  if (!tab) {

    throw new Error(`There is no tab ${raw}. The tabs:\n\n${listTabs(browser)}`);

  }

  return tab;

}

/** Marks the browser as loading the agent's page for as long as `work` runs. */
async function loading<T>(browser: Browser, opening: boolean, work: (chrome: Chrome) => Promise<T>): Promise<T> {

  browser.opening = opening;

  try {

    return await act(browser, LOAD_MS + ACTION_MS * 2, work);

  } finally {

    browser.opening = false;
    rest(browser);

  }

}

/** `<tab>` lists the tabs; `<tab 2>` shows one, `<tab https://…>` opens one, `<tab close 2>` closes one. Numbers are places in the list. */
export async function tab(workspace: string, target: string, signal?: AbortSignal): Promise<string> {

  const [word = "", arg = ""] = target.trim().split(/\s+/);
  const browser = await agentBrowser(workspace, signal);
  const on = running(browser);

  if (!word) {

    return listTabs(browser);

  }

  if (word.toLowerCase() === "close") {

    const doomed = arg ? nthTab(browser, arg) : activeTab(browser);

    if (doomed) {

      await (on ? act(browser, ACTION_MS, (chrome) => closeTab(browser, chrome, doomed)) : closeTab(browser, null, doomed));

    }

    return listTabs(browser);

  }

  const url = WEB_URL.test(word) ? word : word.toLowerCase() === "new" && arg ? checkedUrl(arg) : "";

  if (!url && !/^\d+$/.test(word)) {

    throw new Error("tab takes a number to switch to, a URL to open in a new tab, or close and a number:\n\n  <tab 2>\n  <tab https://example.com>\n  <tab close 2>");

  }

  const next = url ? addTab(browser, url, browser.active || null) : nthTab(browser, word);

  // a closed browser starts on this tab, rather than on the old one and then a second page
  if (!on) {

    browser.active = next.id;

  }

  return loading(browser, !!url, async (chrome) => {

    if (chrome.page !== next.page) {

      await focus(browser, chrome, next);

    }

    if (url) {

      await go(chrome.page, url);

    }

    browser.opening = false;

    return read(browser, await current(browser, chrome));

  });

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

  if (!WEB_URL.test(url.trim())) {

    throw new Error("open takes an http:// or https:// URL");

  }

  return url.trim();

}

export async function open(workspace: string, url: string, signal?: AbortSignal): Promise<string> {

  const target = checkedUrl(url);
  const browser = await agentBrowser(workspace, signal);

  return loading(browser, true, async (chrome) => {

    await go(chrome.page, target);

    return read(browser, chrome.page);

  });

}

export async function look(workspace: string, signal?: AbortSignal): Promise<string> {

  const browser = await agentBrowser(workspace, signal);
  const blank = new Error("No page is open yet. Use <open https://...> first.");

  // a closed browser with no tab to bring back has no page to read, and launching one just to say so is waste
  if (!running(browser) && !WEB_URL.test(activeTab(browser)?.url ?? "")) {

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

/** Pages that keep redrawing (Gmail's inbox, feeds) swap elements out under a ref; say so with the page now instead of timing out. */
async function byRef<T>(browser: Browser, page: Page, target: string, work: (locator: Locator) => Promise<T>): Promise<T> {

  const locator = page.locator(`aria-ref=${target}`);
  const gone = async () => new Error(`${target} is no longer on the page — it redrew since you looked, so nothing ran. Use a ref from the page below. If it keeps redrawing, don't retry the click: open the item by its URL, or search for it.\n\n${await read(browser, page)}`);

  if (!(await locator.count())) {

    throw await gone();

  }

  try {

    return await work(locator);

  } catch (err) {

    if (err instanceof errors.TimeoutError && !(await locator.count())) {

      throw await gone();

    }

    throw err;

  }

}

/** What a click or key does shows up a moment after it returns: a new browser, a menu, a navigation starting. */
async function interact(workspace: string, signal: AbortSignal | undefined, ms: number, work: (page: Page, browser: Browser) => Promise<unknown>): Promise<string> {

  const browser = await agentBrowser(workspace, signal, true);

  return act(browser, ms, async (chrome) => {

    const page = chrome.page;
    const pending = new Set<object>();
    const start = (request: object) => pending.add(request);
    const end = (request: object) => pending.delete(request);

    // only what the action started counts: Gmail and other apps hold a connection open, so they are never network-idle
    page.on("request", start).on("requestfinished", end).on("requestfailed", end);

    try {

      await work(page, browser);
      await Bun.sleep(500);

      if (chrome.page !== page) {

        await settle(chrome.page);

      } else {

        await page.waitForLoadState("domcontentloaded", { timeout: LOAD_MS }).catch(() => {});

        for (const until = Date.now() + QUIET_MS; pending.size && Date.now() < until;) {

          await Bun.sleep(100);

        }

      }

    } finally {

      page.off("request", start).off("requestfinished", end).off("requestfailed", end);

    }

    return read(browser, chrome.page);

  });

}

export async function click(workspace: string, ref: string, signal?: AbortSignal): Promise<string> {

  const target = refOf(ref);

  return interact(workspace, signal, LOAD_MS + ACTION_MS * 3, (page, browser) => byRef(browser, page, target, (locator) => locator.click({ timeout: ELEMENT_MS })));

}

export async function press(workspace: string, key: string, signal?: AbortSignal): Promise<string> {

  return interact(workspace, signal, LOAD_MS + ACTION_MS * 2, (page) => page.keyboard.press(key.trim() || "Enter"));

}

export async function type(workspace: string, ref: string, text: string, signal?: AbortSignal): Promise<string> {

  const target = refOf(ref);
  const browser = await agentBrowser(workspace, signal, true);

  await act(browser, ACTION_MS * 3, (chrome) => byRef(browser, chrome.page, target, (locator) => locator.fill(text, { timeout: ELEMENT_MS })));

  return `typed ${text.length} characters into ${target}`;

}

export const pageUrl = async (workspace: string) => browsers.get(workspace)?.chrome?.page.url() ?? "about:blank";
