import { existsSync } from "node:fs";
import { join } from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const IDLE_MS = Number(process.env.PTS_BROWSER_IDLE_MS ?? 10 * 60_000);
const ACTION_MS = 15_000;
const LOAD_MS = 30_000;
const MAX_SNAPSHOT = 16_000;

interface Tab {

  context: BrowserContext;
  page: Page;

  idle: ReturnType<typeof setTimeout>;

}

// one Chromium for every agent; each agent gets its own context, so logins never cross
let browser: Promise<Browser> | null = null;

const tabs = new Map<string, Tab>();

/** Logins survive idle closes and restarts: the agent's cookies live in its own workspace. */
function statePath(workspace: string): string {

  return join(workspace, ".browser.json");

}

async function close(workspace: string) {

  const tab = tabs.get(workspace);

  if (!tab) {

    return;

  }

  tabs.delete(workspace);
  clearTimeout(tab.idle);

  await tab.context.storageState({ path: statePath(workspace) }).catch(() => {});
  await tab.context.close().catch(() => {});

  if (!tabs.size && browser) {

    const idle = browser;

    browser = null;
    await (await idle).close().catch(() => {});

  }

}

async function tabFor(workspace: string): Promise<Tab> {

  let tab = tabs.get(workspace);

  if (!tab) {

    // a failed launch must not be cached, or the browser stays broken until restart
    browser ??= chromium.launch().catch((err) => {

      browser = null;
      throw err;

    });

    const context = await (await browser).newContext({ storageState: existsSync(statePath(workspace)) ? statePath(workspace) : undefined });
    const page = await context.newPage();

    tab = { context, page, idle: setTimeout(() => {}, 0) };
    tabs.set(workspace, tab);

    const opened = tab;

    // a link that opens a new tab is where the agent meant to go
    context.on("page", (next) => {

      opened.page = next;

    });

  }

  clearTimeout(tab.idle);
  tab.idle = setTimeout(() => close(workspace), IDLE_MS);

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

export async function open(workspace: string, url: string): Promise<string> {

  // Chromium runs outside the sandbox, so file:// would read the server's own disk
  if (!/^https?:\/\//i.test(url.trim())) {

    throw new Error("open takes an http:// or https:// URL");

  }

  const { page } = await tabFor(workspace);

  await page.goto(url.trim(), { waitUntil: "domcontentloaded", timeout: LOAD_MS });
  await settle(page);

  return snapshot(page);

}

export async function look(workspace: string): Promise<string> {

  const { page } = await tabFor(workspace);

  if (page.url() === "about:blank") {

    throw new Error("No page is open yet. Use <open https://...> first.");

  }

  return snapshot(page);

}

export async function click(workspace: string, ref: string): Promise<string> {

  const tab = await tabFor(workspace);

  await tab.page.locator(`aria-ref=${refOf(ref)}`).click({ timeout: ACTION_MS });
  await settle(tab.page);

  return snapshot(tab.page);

}

export async function type(workspace: string, ref: string, text: string): Promise<string> {

  const { page } = await tabFor(workspace);

  await page.locator(`aria-ref=${refOf(ref)}`).fill(text, { timeout: ACTION_MS });

  return `typed ${text.length} characters into ${refOf(ref)}`;

}

export async function press(workspace: string, key: string): Promise<string> {

  const tab = await tabFor(workspace);

  await tab.page.keyboard.press(key.trim() || "Enter");
  await settle(tab.page);

  return snapshot(tab.page);

}

export function pageUrl(workspace: string): string {

  return tabs.get(workspace)?.page.url() ?? "about:blank";

}

export async function closeAll() {

  await Promise.all([...tabs.keys()].map(close));

}
