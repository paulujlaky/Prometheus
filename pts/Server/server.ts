import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import type { ServerWebSocket } from "bun";

import { BoodleClient, parseSession } from "../../sdk/index";

import { close as closeBrowser, closeAll, proxyLabel, proxyUrl, setProxy, setZone, warm } from "../Agent/Tools/Browser";
import { Queue, type AgentState } from "../Agent/Queue";
import { dropChats, runAgent, type RunControl, type RunEvent } from "../Agent/Runner";
import { isGlyph } from "../Features/Glyph";
import { groupTask, isWaiting, MAX_HOPS, route, type Origin } from "../Features/Group";
import { Live, type LiveMessage } from "./Live";
import { notify, VAPID_PUBLIC_KEY } from "./Push";
import { isTimeZone, nextAt, routineTask, startScheduler, validateRoutine } from "../Features/Routines";
import { addGroupMessage, createAgent, createGroupChat, createRoutine, deleteAgent, deleteGroupChat, deletePushSub, deleteRoutine, getAgentById, getGroupChat, getRoutine, listAgents, listEvents, listGroupChats, listGroupMessages, listRoutines, listUsers, markRead, readCookie, unreadEvents, unreadGroup, trackedChats, userByKey, userDir, userZone, workspaceOf, readMemory, readSetting, readUserDoc, savePushSub, updateAgent, updateRoutine, writeCookie, writeMemory, writeSetting, writeUserDoc, type Agent, type User } from "../Store";

const PORT = Number(process.env.PTS_PORT ?? 7420);

// one proxy for every user's browsers, http://user:pass@host:port; Bun reads it from .env
const PROXY = process.env.PTS_PROXY?.trim() || null;
const SESSION_COOKIE = "pts_session";
const RECENT_GROUP = 20;
const WEB = join(import.meta.dir, "..", "web", "dist");

class HttpError extends Error {

  constructor(readonly status: number, message: string) {

    super(message);

  }

}

type Socket = ServerWebSocket<{ userId: number }>;
type Account = { name: string | null; email: string | null };

/** What the server keeps for each user between requests: their Boodle client and what it has looked up. */
interface Tenant {

  client: BoodleClient | null;
  models: { id: string; name: string }[] | null;
  account: Account | null;

  /** undefined until looked up; null when Boodle has no preference we can match. */
  preferredModel?: string | null;

}

const tenants = new Map<number, Tenant>();

function tenant(userId: number): Tenant {

  if (!tenants.has(userId)) {

    tenants.set(userId, { client: null, models: null, account: null });

  }

  return tenants.get(userId)!;

}

function boodle(userId: number): BoodleClient {

  const state = tenant(userId);
  const cookie = state.client ? null : readCookie(userId);

  if (!state.client && !cookie) {

    throw new HttpError(503, "No Boodle cookie yet. Paste one in settings.");

  }

  return (state.client ??= new BoodleClient({ cookie: cookie! }));

}

async function modelsOf(userId: number) {

  return (tenant(userId).models ??= (await boodle(userId).listCustomModels()).map(({ id, name }) => ({ id, name })));

}

/**
 * The model new agents get: the user's pick in settings, else the one they prefer in Boodle itself.
 * Boodle stores that preference as a chat assistant, so it is matched to a bot model by the upstream model id.
 */
async function defaultModel(userId: number): Promise<string | null> {

  const state = tenant(userId);
  const chosen = readSetting(userId, "defaultModel");

  if (chosen || state.preferredModel !== undefined) {

    return chosen || state.preferredModel!;

  }

  const client = boodle(userId);
  const [assistants, custom] = await Promise.all([client.listAssistants(), client.listCustomModels()]);
  const preferred = assistants.find((assistant) => assistant.id === client.preferredAssistantId);

  return (state.preferredModel = custom.find((model) => preferred?.model && model.model === preferred.model)?.id ?? custom.find((model) => model.name === preferred?.name)?.id ?? custom[0]?.id ?? null);

}

const settingsView = async (userId: number) => ({ defaultModel: readCookie(userId) ? await defaultModel(userId) : null, timezone: readSetting(userId, "timezone") || null });

/** Sockets whose window is on screen right now. */
const watching = new Set<Socket>();

/** Boodle nests the person two levels down, as `user.user`. */
function accountOf(bootstrap: { user?: unknown }): Account {

  const person = (bootstrap.user as { user?: { name?: unknown; email?: unknown } } | undefined)?.user;

  return { name: typeof person?.name === "string" ? person.name : null, email: typeof person?.email === "string" ? person.email : null };

}

/** Each user's sockets subscribe to their own topic, so nobody sees another's agents. */
const broadcast = (userId: number, message: unknown) => server.publish(`user:${userId}`, JSON.stringify(message));

// a finished task does not buzz on its own: the agent decides, with <notify>, when it is worth it
const BUZZ: Partial<Record<RunEvent["kind"], (name: string) => string>> = {

  notify: (name) => name,
  ask: (name) => `${name} needs your OK`,
  handoff: (name) => `${name} needs you in the browser`,
  question: (name) => `${name} has a question`,

};

function onRunEvent(event: RunEvent) {

  // an agent deleted mid-run has nobody left to tell
  const agent = getAgentById(event.agentId);

  if (!agent) {

    return;

  }

  broadcast(agent.userId, event.kind === "delta" ? { type: "delta", agentId: event.agentId, text: event.text } : { type: "event", event });

  // someone with the app open sees all of this live; buzzing their phone as well is noise
  if (event.kind === "delta" || [...watching].some((ws) => ws.data.userId === agent.userId)) {

    return;

  }

  const title = BUZZ[event.kind];

  if (title) {

    notify(agent.userId, { title: title(agent.name), body: event.text.split("\n")[0], agentId: event.agentId }).catch(() => {});

  } else if (event.kind === "error" && event.text !== "Stopped by the user.") {

    // the SDK surfaces Boodle's status in the message; a 401 means the pasted cookie has expired
    const expired = /failed: 40[13]\b/.test(event.text);

    notify(agent.userId, {

      title: expired ? "Boodle cookie expired" : `${agent.name} hit a problem`,
      body: expired ? "Paste a fresh cookie in settings to get agents working again." : event.text.slice(0, 200),
      agentId: event.agentId,

    }).catch(() => {});

  }

}

const postSystem = (userId: number, groupId: number, author: string, agentId: number | null, text: string) => broadcast(userId, { type: "group", message: addGroupMessage(userId, groupId, author, agentId, text) });

/** Saves and shows a thread message, then wakes whoever in that thread it routes to. Group 0 is Everyone. */
function postGroup(userId: number, groupId: number, author: string, agentId: number | null, text: string, origin: Origin | null = null) {

  const group = groupId ? getGroupChat(userId, groupId) : null;

  // a reply finishing after its group was deleted has nowhere to go
  if (groupId && !group) {

    return;

  }

  const recent = listGroupMessages(userId, groupId, RECENT_GROUP);
  const message = addGroupMessage(userId, groupId, author, agentId, text);
  const agents = listAgents(userId).filter((agent) => !group || group.members.includes(agent.id));

  broadcast(userId, { type: "group", message });

  const next = route(message, agents, origin);

  if ("capped" in next) {

    // posted directly: routed like a user message, the note would wake everyone
    postSystem(userId, groupId, "system", null, `Hand-off limit reached (${MAX_HOPS} in a row). @mention an agent to keep going.`);
    return;

  }

  for (const agent of next.recipients.filter((one) => agentId === null || !queue.busyIn(one.id, next.origin.chain))) {

    queue.enqueue(agent, groupTask(agent, agents, recent, message, group?.name), next.origin);

  }

}

async function start(agent: Agent, task: string, control: RunControl, origin?: Origin) {

  const end = await runAgent(boodle(agent.userId), agent, task, control);

  if (!origin || end.text === "Stopped by the user." || isWaiting(end.text)) {

    return;

  }

  if (end.kind === "done") {

    postGroup(agent.userId, origin.group, agent.name, agent.id, end.text, origin);

  } else if (!origin.group || getGroupChat(agent.userId, origin.group)) {

    postSystem(agent.userId, origin.group, agent.name, agent.id, `Could not finish: ${end.text}`);

  }

}

const queue = new Queue(start, onRunEvent, (agentId: number, state: AgentState) => {

  const agent = getAgentById(agentId);

  if (agent) {

    broadcast(agent.userId, { type: "state", agentId, state });

  }

});

// handing the browser back is how the user answers a <handoff>
const live = new Live((agentId) => queue.answer(agentId, true, "handoff"));

const view = (agent: Agent) => ({ id: agent.id, name: agent.name, modelId: agent.modelId, persona: agent.persona, glyph: agent.glyph, category: agent.category, createdAt: agent.createdAt, state: queue.state(agent.id), question: queue.question(agent.id), waitingOn: queue.waitingOn(agent.id), unread: unreadEvents(agent) });

/** Everyone first, as group 0 with no member list, since it is all of them. */
const groupViews = (userId: number) => [{ id: 0, name: "Everyone", members: [] as number[], createdAt: 0 }, ...listGroupChats(userId)].map((group) => ({ ...group, unread: unreadGroup(userId, group.id) }));

function groupIdOr404(userId: number, value: unknown): number {

  const id = Number(value ?? 0);

  if (!Number.isInteger(id) || (id && !getGroupChat(userId, id))) {

    throw new HttpError(404, "No such group chat");

  }

  return id;

}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers });
const ok = () => json({ ok: true });
const sessionCookie = (value: string, age: number) => ({ "Set-Cookie": `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${age}` });

/** A page of history scrolling upward: `limit` items before `before`. */
const page = (url: URL) => [Math.min(500, Number(url.searchParams.get("limit") ?? 200)), Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER)] as const;

/** The key from the CLI, as a bearer token or the cookie a sign-in set. */
const userOf = (req: Request): User | null => userByKey(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "") ?? userByKey(new Bun.CookieMap(req.headers.get("cookie") ?? "").get(SESSION_COOKIE) ?? "");

async function body<T>(req: Request): Promise<T> {

  try {

    return (await req.json()) as T;

  } catch {

    throw new HttpError(400, "Expected a JSON body");

  }

}

function text(value: unknown, field: string): string {

  if (typeof value !== "string") {

    throw new HttpError(400, `${field} must be a string`);

  }

  return value;

}

const optional = (value: unknown, field: string) => value === undefined ? undefined : text(value, field);

function filled(value: unknown, field: string): string {

  const message = text(value, field).trim();

  if (!message) {

    throw new HttpError(400, `${field} is empty`);

  }

  return message;

}

/** Another user's agent answers exactly like one that does not exist. */
function agentOr404(userId: number, id: number): Agent {

  const agent = getAgentById(id);

  if (agent?.userId !== userId) {

    throw new HttpError(404, "No such agent");

  }

  return agent;

}

async function login(req: Request): Promise<Response> {

  const key = (await body<{ key?: unknown }>(req)).key;

  if (typeof key !== "string" || !userByKey(key.trim())) {

    // one guess a second keeps a long random key out of brute-force reach
    await Bun.sleep(1000);

    return json({ error: "That key did not work" }, 401);

  }

  return json({ ok: true }, 200, sessionCookie(key.trim(), 31536000));

}

async function agentRoute(req: Request, url: URL, agent: Agent, action = ""): Promise<Response> {

  const route = `${req.method} ${action}`;

  switch (route) {

    case "GET ":

      return json(view(agent));

    case "PATCH ": {

      const changes = await body<{ modelId?: unknown; persona?: unknown; glyph?: unknown; category?: unknown }>(req);
      const glyph = optional(changes.glyph, "glyph");
      const category = optional(changes.category, "category")?.trim();

      if (glyph !== undefined && !isGlyph(glyph)) {

        throw new HttpError(400, "glyph must be shape:color from the known sets");

      }

      if (category && category.length > 32) {

        throw new HttpError(400, "Categories are at most 32 characters");

      }

      updateAgent(agent.id, { modelId: optional(changes.modelId, "modelId"), persona: optional(changes.persona, "persona"), glyph, category });

      return json(view(getAgentById(agent.id)!));

    }

    case "DELETE ":

      queue.stop(agent.id);
      await closeBrowser(workspaceOf(agent), true);

      if (agent.botDraftId) {

        await boodle(agent.userId).deleteCustomBot(agent.botDraftId).catch(() => {});

      }

      deleteAgent(agent.id);

      return ok();

    case "GET events":

      return json(listEvents(agent.id, ...page(url)));

    case "POST messages": {

      const message = filled((await body<{ text?: unknown }>(req)).text, "text");

      // fail now rather than queue a run that can only error once it starts
      boodle(agent.userId);
      queue.send(agent, message);

      return json(view(agent));

    }

    case "POST answer": {

      const { allow, text: reply } = await body<{ allow?: unknown; text?: unknown }>(req);

      if (typeof allow !== "boolean" && typeof reply !== "string") {

        throw new HttpError(400, "allow must be true or false, or text the answer to a question");

      }

      // words only ever answer a question, never an approval
      if (!(typeof reply === "string" ? queue.answer(agent.id, reply, "question") : queue.answer(agent.id, allow as boolean))) {

        throw new HttpError(409, "Nothing is waiting for an answer");

      }

      return json(view(agent));

    }

    case "POST stop":

      queue.stop(agent.id);

      return json(view(agent));

    case "GET memory":

      return json({ text: readMemory(agent) });

    case "PUT memory":

      writeMemory(agent, text((await body<{ text?: unknown }>(req)).text, "text"));

      return ok();

    case "GET routines": {

      const zone = userZone(agent.userId);

      return json(listRoutines(agent.id).map((routine) => ({ ...routine, nextAt: nextAt(routine, zone) })));

    }

    case "POST routines": {

      const input = await body<{ kind?: unknown; spec?: unknown; target?: unknown; title?: unknown; task?: unknown }>(req);
      const spec = text(input.spec, "spec").trim();
      const target = optional(input.target, "target")?.trim() ?? "";

      validateRoutine(input.kind, spec, target);

      return json(createRoutine(agent.id, { kind: input.kind as "schedule" | "watch", spec, target, title: optional(input.title, "title")?.trim().replace(/"/g, "") ?? "", task: text(input.task, "task").trim() }), 201);

    }

  }

  throw new HttpError(404, "Not found");

}

async function routineRoute(req: Request, userId: number, id: number, run: boolean): Promise<Response> {

  const routine = getRoutine(id);

  if (!routine || getAgentById(routine.agentId)?.userId !== userId) {

    throw new HttpError(404, "No such routine");

  }

  if (run && req.method === "POST") {

    // a watch run by hand skips the check and just does its task
    queue.enqueue(agentOr404(userId, routine.agentId), routineTask({ ...routine, kind: "schedule" }, userZone(userId)));

    return ok();

  }

  if (req.method === "DELETE") {

    deleteRoutine(routine.id);

    return ok();

  }

  if (req.method !== "PATCH") {

    throw new HttpError(404, "Not found");

  }

  const changes = await body<{ spec?: unknown; target?: unknown; task?: unknown; enabled?: unknown }>(req);
  const spec = optional(changes.spec, "spec")?.trim();
  const target = optional(changes.target, "target")?.trim();

  if (changes.enabled !== undefined && typeof changes.enabled !== "boolean") {

    throw new HttpError(400, "enabled must be true or false");

  }

  validateRoutine(routine.kind, spec ?? routine.spec, target ?? routine.target);
  updateRoutine(routine.id, { spec, target, task: optional(changes.task, "task"), enabled: changes.enabled as boolean | undefined });

  return json(getRoutine(routine.id));

}

async function saveSettings(req: Request, userId: number): Promise<Response> {

  const input = await body<{ defaultModel?: unknown; timezone?: unknown }>(req);
  const modelId = optional(input.defaultModel, "defaultModel");
  const timezone = optional(input.timezone, "timezone")?.trim();

  if (modelId === undefined && timezone === undefined) {

    throw new HttpError(400, "Nothing to save");

  }

  if (modelId !== undefined && !(await modelsOf(userId)).some((model) => model.id === modelId)) {

    throw new HttpError(400, "That model is not available to this Boodle account");

  }

  if (timezone && !isTimeZone(timezone)) {

    throw new HttpError(400, "Unknown time zone. Use a name like America/New_York.");

  }

  if (modelId !== undefined) {

    writeSetting(userId, "defaultModel", modelId);

  }

  if (timezone !== undefined) {

    writeSetting(userId, "timezone", timezone);
    await setZone(userDir(userId), timezone);

  }

  return json(await settingsView(userId));

}

async function api(req: Request, url: URL): Promise<Response | undefined> {

  const path = url.pathname;
  const route = `${req.method} ${path}`;

  if (route === "POST /api/login") {

    return login(req);

  }

  const user = userOf(req);

  if (!user) {

    return json({ error: "Unauthorized" }, 401);

  }

  const userId = user.id;

  if (path === "/api/ws") {

    // Bun answers the handshake itself; a Response after a successful upgrade is an error
    return server.upgrade(req, { data: { userId } }) ? undefined : json({ error: "Expected a WebSocket upgrade" }, 400);

  }

  const agentMatch = /^\/api\/agents\/(\d+)(?:\/(\w+))?$/.exec(path);
  const routineMatch = /^\/api\/routines\/(\d+)(\/run)?$/.exec(path);

  // never 0: Everyone cannot be deleted
  const groupMatch = /^\/api\/groups\/([1-9]\d*)$/.exec(path);

  if (agentMatch) {

    return agentRoute(req, url, agentOr404(userId, Number(agentMatch[1])), agentMatch[2]);

  }

  if (routineMatch) {

    return routineRoute(req, userId, Number(routineMatch[1]), Boolean(routineMatch[2]));

  }

  if (groupMatch && req.method === "DELETE") {

    deleteGroupChat(userId, groupIdOr404(userId, groupMatch[1]));

    return ok();

  }

  switch (route) {

    case "POST /api/logout":

      return json({ ok: true }, 200, sessionCookie("", 0));

    case "GET /api/agents":

      return json(listAgents(userId).map(view));

    case "POST /api/agents": {

      const input = await body<{ name?: unknown; modelId?: unknown; persona?: unknown }>(req);
      const modelId = optional(input.modelId, "modelId") ?? (await defaultModel(userId));

      if (!modelId) {

        throw new HttpError(503, "No model to give it yet. Connect Boodle in settings.");

      }

      return json(view(createAgent(userId, text(input.name, "name").trim(), modelId, optional(input.persona, "persona") ?? "")), 201);

    }

    case "GET /api/settings":

      return json(await settingsView(userId));

    case "PUT /api/settings":

      return saveSettings(req, userId);

    case "GET /api/group":

      return json(listGroupMessages(userId, groupIdOr404(userId, url.searchParams.get("group")), ...page(url)));

    case "POST /api/group": {

      const input = await body<{ text?: unknown; group?: unknown }>(req);
      const message = filled(input.text, "text");
      const groupId = groupIdOr404(userId, input.group);

      boodle(userId);
      postGroup(userId, groupId, "user", null, message);

      return json({ ok: true }, 201);

    }

    case "GET /api/groups":

      return json(groupViews(userId));

    case "POST /api/groups": {

      const input = await body<{ name?: unknown; members?: unknown }>(req);
      const members = Array.isArray(input.members) ? [...new Set(input.members.map(Number))].map((id) => getAgentById(id)) : [];

      if (members.length < 2 || members.some((agent) => agent?.userId !== userId)) {

        throw new HttpError(400, "members must name at least two agents");

      }

      // quotes would break the thread title the agent's chat reads back
      const name = (optional(input.name, "name") ?? "").trim().replace(/"/g, "").slice(0, 60) || members.map((agent) => agent!.name).join(", ");

      return json({ ...createGroupChat(userId, name, members.map((agent) => agent!.id)), unread: 0 }, 201);

    }

    case "POST /api/read": {

      const input = await body<{ agent?: unknown; group?: unknown }>(req);

      if (input.agent !== undefined) {

        markRead(userId, "agent", agentOr404(userId, Number(input.agent)).id);

      } else {

        markRead(userId, "group", groupIdOr404(userId, input.group));

      }

      return ok();

    }

    case "GET /api/models":

      return json(await modelsOf(userId));

    case "GET /api/user":

      return json({ text: readUserDoc(userId) });

    case "PUT /api/user":

      writeUserDoc(userId, text((await body<{ text?: unknown }>(req)).text, "text"));

      return ok();

    case "GET /api/cookie": {

      const state = tenant(userId);

      // an expired cookie still reads as set; the PWA shows it without a name, and runs say why they fail
      if (user.cookie && !state.account) {

        state.account = await boodle(userId).getUser().then(accountOf).catch(() => null);

      }

      return json({ set: Boolean(user.cookie), userId: user.cookie ? parseSession(user.cookie).userId : null, name: state.account?.name ?? null, email: state.account?.email ?? null });

    }

    case "PUT /api/cookie": {

      const cookie = text((await body<{ cookie?: unknown }>(req)).cookie, "cookie").trim();
      const next = new BoodleClient({ cookie });

      // a cookie that cannot load the user is one that will fail every run
      const account = accountOf(await next.getUser().catch((err) => {

        throw new HttpError(400, `Boodle rejected that cookie: ${err instanceof Error ? err.message : err}`);

      }));

      writeCookie(userId, cookie);
      tenants.set(userId, { client: next, models: null, account });

      return json({ ok: true, userId: next.userId, ...account });

    }

    case "GET /api/push":

      return json({ publicKey: VAPID_PUBLIC_KEY });

    case "POST /api/push": {

      const sub = (await body<{ subscription?: { endpoint?: unknown } }>(req)).subscription;

      savePushSub(userId, text(sub?.endpoint, "subscription.endpoint"), JSON.stringify(sub));

      return ok();

    }

    case "DELETE /api/push":

      deletePushSub(text((await body<{ endpoint?: unknown }>(req)).endpoint, "endpoint"));

      return ok();

  }

  throw new HttpError(404, "Not found");

}

/** The built PWA. Unknown paths get index.html, since the app routes in the hash. */
function serveWeb(pathname: string): Response {

  // left percent-encoded on purpose: decoding would let %2e%2e climb out of WEB, and no built file needs it
  const target = resolve(WEB, `.${pathname}`);
  const inside = target.startsWith(`${WEB}${sep}`) && existsSync(target) && statSync(target).isFile();
  const index = join(WEB, "index.html");

  if (!inside && !existsSync(index)) {

    return new Response("The PWA is not built yet: bun run pts:web", { status: 404 });

  }

  // hashed bundles never change under one name; everything else must be re-checked or a deploy never lands
  const cache = inside && pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";

  return new Response(Bun.file(inside ? target : index), { headers: { "Cache-Control": cache } });

}

export const server = Bun.serve({

  // a proxy in front terminates TLS; nothing else should reach the server directly
  hostname: process.env.PTS_HOST ?? "127.0.0.1",
  port: PORT,

  async fetch(req) {

    const url = new URL(req.url);

    if (!url.pathname.startsWith("/api/")) {

      return serveWeb(url.pathname);

    }

    try {

      return await api(req, url);

    } catch (err) {

      return json({ error: err instanceof Error ? err.message : String(err) }, err instanceof HttpError ? err.status : 400);

    }

  },

  websocket: {

    data: {} as { userId: number },

    open(ws: Socket) {

      ws.subscribe(`user:${ws.data.userId}`);

    },

    // a client says whether its window is on screen, and drives the live browser; everything else is HTTP
    message(ws: Socket, raw) {

      let message: { visible?: unknown } | LiveMessage;

      try {

        message = JSON.parse(String(raw));

      } catch {

        return;

      }

      if ("live" in message) {

        live.message(ws, message);

      } else if (message.visible === true) {

        watching.add(ws);

      } else {

        watching.delete(ws);

      }

    },

    close(ws: Socket) {

      watching.delete(ws);
      live.close(ws);

    },

  },

});

// not import.meta.main: pm2 loads the file through its own wrapper, which made that false and left the scheduler off
if (process.env.NODE_ENV !== "test") {

  // closing the browser writes each agent's logins to its workspace; a hard kill would lose the latest
  for (const signal of ["SIGINT", "SIGTERM"] as const) {

    process.on(signal, () => closeAll().finally(() => process.exit(0)));

  }

  const users = listUsers();

  if (!users.length) {

    console.log("pts: nobody can sign in yet. Make a key: bun pts/cli.ts key <name>");

  }

  // nothing runs yet, so every tracked chat was left by a crash or a failed delete
  for (const user of users.filter((one) => one.cookie)) {

    dropChats(boodle(user.id), trackedChats(user.id));

  }

  // localhost goes through the proxy too; without one, agents' browsers can reach every service on this machine
  console.log(PROXY ? `pts: browsers go through ${proxyLabel(proxyUrl(PROXY))}` : "pts: no PTS_PROXY, so agents' browsers can reach this machine's local services");

  // no top-level await: pm2 require()s this file, and Bun cannot require an async module
  // before the scheduler, so no browser starts without the proxy; a failure stops the server rather than browse direct
  setProxy(PROXY).then(() => Promise.all(users.map((user) => setZone(userDir(user.id), readSetting(user.id, "timezone"))))).then(() => {

    warm();
    startScheduler((agent, task) => queue.enqueue(agent, task));
    console.log(`pts listening on http://localhost:${server.port}`);

  }, (err) => {

    console.error(`pts: could not apply a browser proxy or time zone: ${err instanceof Error ? err.message : err}`);
    process.exit(1);

  });

}
