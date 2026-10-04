import { timingSafeEqual } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import type { ServerWebSocket } from "bun";

import { BoodleClient, parseSession } from "../../sdk/index";

import { close as closeBrowser, closeAll } from "../Agent/Tools/Browser";
import { Queue, type AgentState } from "../Agent/Queue";
import { runAgent, type RunControl, type RunEvent } from "../Agent/Runner";
import { isGlyph } from "../Features/Glyph";
import { groupTask, isWaiting, MAX_HOPS, route, type Origin } from "../Features/Group";
import { Live, type LiveMessage } from "./Live";
import { notify, VAPID_PUBLIC_KEY } from "./Push";
import { isTimeZone, nextAt, routineTask, startScheduler, validateRoutine } from "../Features/Routines";
import { addGroupMessage, createAgent, createRoutine, deleteAgent, deletePushSub, deleteRoutine, getAgentById, getRoutine, listAgents, listEvents, listGroupMessages, listRoutines, readCookie, workspaceOf, readMemory, readSetting, readUserDoc, savePushSub, updateAgent, updateRoutine, writeCookie, writeMemory, writeSetting, writeUserDoc, type Agent } from "../Store";

const PORT = Number(process.env.PTS_PORT ?? 7420);
const TOKEN = process.env.PTS_TOKEN ?? "";
const SESSION_COOKIE = "pts_session";
const RECENT_GROUP = 20;
const WEB = join(import.meta.dir, "..", "web", "dist");
const TOPIC = "events";

if (TOKEN.length < 24) {

  throw new Error("Set PTS_TOKEN to a random string of at least 24 characters: openssl rand -hex 24");

}

class HttpError extends Error {

  constructor(readonly status: number, message: string) {

    super(message);

  }

}

let client: BoodleClient | null = null;
let models: { id: string; name: string }[] | null = null;
let account: { name: string | null; email: string | null } | null = null;

/** undefined until looked up; null when Boodle has no preference we can match. */
let preferredModel: string | null | undefined;

/**
 * The model new agents get: the user's pick in settings, else the one they prefer in Boodle itself.
 * Boodle stores that preference as a chat assistant, so it is matched to a bot model by the upstream model id.
 */
async function defaultModel(): Promise<string | null> {

  const chosen = readSetting("defaultModel");

  if (chosen) {

    return chosen;

  }

  if (preferredModel === undefined) {

    const client = boodle();
    const [assistants, custom] = await Promise.all([client.listAssistants(), client.listCustomModels()]);
    const preferred = assistants.find((assistant) => assistant.id === client.preferredAssistantId);

    preferredModel = custom.find((model) => preferred?.model && model.model === preferred.model)?.id ?? custom.find((model) => model.name === preferred?.name)?.id ?? custom[0]?.id ?? null;

  }

  return preferredModel;

}

/** Sockets whose window is on screen right now. */
const watching = new Set<ServerWebSocket<unknown>>();

/** Boodle nests the person two levels down, as `user.user`. */
function accountOf(bootstrap: { user?: unknown }): { name: string | null; email: string | null } {

  const person = (bootstrap.user as { user?: { name?: unknown; email?: unknown } } | undefined)?.user;

  return { name: typeof person?.name === "string" ? person.name : null, email: typeof person?.email === "string" ? person.email : null };

}

function boodle(): BoodleClient {

  if (!client) {

    const cookie = readCookie();

    if (!cookie) {

      throw new HttpError(503, "No Boodle cookie yet. Paste one in settings.");

    }

    client = new BoodleClient({ cookie });

  }

  return client;

}

function broadcast(message: unknown) {

  server.publish(TOPIC, JSON.stringify(message));

}

function onRunEvent(event: RunEvent) {

  if (event.kind === "delta") {

    broadcast({ type: "delta", agentId: event.agentId, text: event.text });
    return;

  }

  broadcast({ type: "event", event });

  const name = getAgentById(event.agentId)?.name ?? "An agent";

  // someone with the app open sees all of this live; buzzing their phone as well is noise
  if (watching.size) {

    return;

  }

  // a finished task does not buzz on its own: the agent decides, with <notify>, when it is worth it
  if (event.kind === "notify" || event.kind === "ask" || event.kind === "handoff") {

    notify({ title: event.kind === "ask" ? `${name} needs your OK` : event.kind === "handoff" ? `${name} needs you in the browser` : name, body: event.text.split("\n")[0], agentId: event.agentId }).catch(() => {});
    return;

  }

  if (event.kind !== "error" || event.text === "Stopped by the user.") {

    return;

  }

  // the SDK surfaces Boodle's status in the message; a 401 means the pasted cookie has expired
  const expired = /failed: 40[13]\b/.test(event.text);

  notify({

    title: expired ? "Boodle cookie expired" : `${name} hit a problem`,
    body: expired ? "Paste a fresh cookie in settings to get agents working again." : event.text.slice(0, 200),
    agentId: event.agentId,

  }).catch(() => {});

}

/** Saves and shows a thread message, then wakes whoever it routes to. */
function postGroup(author: string, agentId: number | null, text: string, origin: Origin | null = null) {

  const recent = listGroupMessages(RECENT_GROUP);
  const message = addGroupMessage(author, agentId, text);
  const agents = listAgents();

  broadcast({ type: "group", message });

  const next = route(message, agents, origin);

  if ("capped" in next) {

    // posted directly: routed like a user message, the note would wake everyone
    broadcast({ type: "group", message: addGroupMessage("system", null, `Hand-off limit reached (${MAX_HOPS} in a row). @mention an agent to keep going.`) });
    return;

  }

  for (const agent of next.recipients) {

    if (agentId !== null && queue.busyIn(agent.id, next.origin.chain)) {

      continue;

    }

    queue.enqueue(agent, groupTask(agent, agents, recent, message), next.origin);

  }

}

async function start(agent: Agent, task: string, control: RunControl, origin?: Origin) {

  const end = await runAgent(boodle(), agent, task, control);

  if (!origin || end.text === "Stopped by the user." || isWaiting(end.text)) {

    return;

  }

  if (end.kind === "done") {

    postGroup(agent.name, agent.id, end.text, origin);
    return;

  }

  broadcast({ type: "group", message: addGroupMessage(agent.name, agent.id, `Could not finish: ${end.text}`) });

}

const queue = new Queue(start, onRunEvent, (agentId: number, state: AgentState) => broadcast({ type: "state", agentId, state }));

// handing the browser back is how the user answers a <handoff>
const live = new Live((agentId) => queue.answer(agentId, true, "handoff"));

function view(agent: Agent) {

  return { id: agent.id, name: agent.name, modelId: agent.modelId, persona: agent.persona, glyph: agent.glyph, createdAt: agent.createdAt, state: queue.state(agent.id), question: queue.question(agent.id), waitingOn: queue.waitingOn(agent.id) };

}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {

  return Response.json(body, { status, headers });

}

function same(a: string, b: string): boolean {

  const x = Buffer.from(a);
  const y = Buffer.from(b);

  return x.length === y.length && timingSafeEqual(x, y);

}

function authorized(req: Request): boolean {

  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const session = new Bun.CookieMap(req.headers.get("cookie") ?? "").get(SESSION_COOKIE) ?? "";

  return same(bearer, TOKEN) || same(session, TOKEN);

}

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

function agentOr404(id: number): Agent {

  const agent = getAgentById(id);

  if (!agent) {

    throw new HttpError(404, "No such agent");

  }

  return agent;

}

async function login(req: Request): Promise<Response> {

  const { token } = await body<{ token?: unknown }>(req);

  if (typeof token !== "string" || !same(token, TOKEN)) {

    // one guess a second keeps a long random token out of brute-force reach
    await Bun.sleep(1000);

    return json({ error: "Wrong token" }, 401);

  }

  return json({ ok: true }, 200, { "Set-Cookie": `${SESSION_COOKIE}=${TOKEN}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000` });

}

async function agentRoute(req: Request, url: URL, agent: Agent, action: string | undefined): Promise<Response> {

  const method = req.method;

  if (!action && method === "GET") {

    return json(view(agent));

  }

  if (!action && method === "PATCH") {

    const changes = await body<{ modelId?: unknown; persona?: unknown; glyph?: unknown }>(req);

    if (changes.glyph !== undefined && !isGlyph(text(changes.glyph, "glyph"))) {

      throw new HttpError(400, "glyph must be shape:color from the known sets");

    }

    updateAgent(agent.id, {

      modelId: changes.modelId === undefined ? undefined : text(changes.modelId, "modelId"),
      persona: changes.persona === undefined ? undefined : text(changes.persona, "persona"),
      glyph: changes.glyph as string | undefined,

    });

    return json(view(agentOr404(agent.id)));

  }

  if (!action && method === "DELETE") {

    queue.stop(agent.id);
    await closeBrowser(workspaceOf(agent), true);

    if (agent.botDraftId) {

      await boodle().deleteCustomBot(agent.botDraftId).catch(() => {});

    }

    deleteAgent(agent.id);

    return json({ ok: true });

  }

  if (action === "events" && method === "GET") {

    const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 200));
    const before = Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER);

    return json(listEvents(agent.id, limit, before));

  }

  if (action === "messages" && method === "POST") {

    const message = text((await body<{ text?: unknown }>(req)).text, "text").trim();

    if (!message) {

      throw new HttpError(400, "text is empty");

    }

    // fail now rather than queue a run that can only error once it starts
    boodle();
    queue.send(agent, message);

    return json(view(agent));

  }

  if (action === "answer" && method === "POST") {

    const { allow } = await body<{ allow?: unknown }>(req);

    if (typeof allow !== "boolean") {

      throw new HttpError(400, "allow must be true or false");

    }

    if (!queue.answer(agent.id, allow)) {

      throw new HttpError(409, "Nothing is waiting for an answer");

    }

    return json(view(agent));

  }

  if (action === "stop" && method === "POST") {

    queue.stop(agent.id);

    return json(view(agent));

  }

  if (action === "memory" && method === "GET") {

    return json({ text: readMemory(agent) });

  }

  if (action === "memory" && method === "PUT") {

    writeMemory(agent, text((await body<{ text?: unknown }>(req)).text, "text"));

    return json({ ok: true });

  }

  if (action === "routines" && method === "GET") {

    return json(listRoutines(agent.id).map((routine) => ({ ...routine, nextAt: nextAt(routine) })));

  }

  if (action === "routines" && method === "POST") {

    const input = await body<{ kind?: unknown; spec?: unknown; target?: unknown; title?: unknown; task?: unknown }>(req);
    const spec = text(input.spec, "spec").trim();
    const target = input.target === undefined ? "" : text(input.target, "target").trim();
    const title = input.title === undefined ? "" : text(input.title, "title").trim().replace(/"/g, "");

    validateRoutine(input.kind, spec, target);

    return json(createRoutine(agent.id, { kind: input.kind as "schedule" | "watch", spec, target, title, task: text(input.task, "task").trim() }), 201);

  }

  throw new HttpError(404, "Not found");

}

async function api(req: Request, url: URL): Promise<Response | undefined> {

  const { pathname: path } = url;
  const method = req.method;

  if (method === "POST" && path === "/api/login") {

    return login(req);

  }

  if (!authorized(req)) {

    return json({ error: "Unauthorized" }, 401);

  }

  if (method === "POST" && path === "/api/logout") {

    return json({ ok: true }, 200, { "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0` });

  }

  if (path === "/api/ws") {

    // Bun answers the handshake itself; a Response after a successful upgrade is an error
    return server.upgrade(req) ? undefined : json({ error: "Expected a WebSocket upgrade" }, 400);

  }

  if (method === "GET" && path === "/api/agents") {

    return json(listAgents().map(view));

  }

  if (method === "POST" && path === "/api/agents") {

    const input = await body<{ name?: unknown; modelId?: unknown; persona?: unknown }>(req);
    const modelId = input.modelId === undefined ? await defaultModel() : text(input.modelId, "modelId");

    if (!modelId) {

      throw new HttpError(503, "No model to give it yet. Connect Boodle in settings.");

    }

    return json(view(createAgent(text(input.name, "name").trim(), modelId, input.persona === undefined ? "" : text(input.persona, "persona"))), 201);

  }

  if (method === "GET" && path === "/api/settings") {

    return json({ defaultModel: readCookie() ? await defaultModel() : null, timezone: readSetting("timezone") || null });

  }

  if (method === "PUT" && path === "/api/settings") {

    const input = await body<{ defaultModel?: unknown; timezone?: unknown }>(req);

    if (input.defaultModel === undefined && input.timezone === undefined) {

      throw new HttpError(400, "Nothing to save");

    }

    if (input.defaultModel !== undefined) {

      const modelId = text(input.defaultModel, "defaultModel");

      models ??= (await boodle().listCustomModels()).map(({ id, name }) => ({ id, name }));

      if (!models.some((model) => model.id === modelId)) {

        throw new HttpError(400, "That model is not available to this Boodle account");

      }

      writeSetting("defaultModel", modelId);

    }

    if (input.timezone !== undefined) {

      const timezone = text(input.timezone, "timezone").trim();

      if (timezone && !isTimeZone(timezone)) {

        throw new HttpError(400, "Unknown time zone. Use a name like America/New_York.");

      }

      writeSetting("timezone", timezone);

    }

    return json({ defaultModel: readCookie() ? await defaultModel() : null, timezone: readSetting("timezone") || null });

  }

  const match = /^\/api\/agents\/(\d+)(?:\/(\w+))?$/.exec(path);

  if (match) {

    return agentRoute(req, url, agentOr404(Number(match[1])), match[2]);

  }

  const routineMatch = /^\/api\/routines\/(\d+)(\/run)?$/.exec(path);

  if (routineMatch) {

    const routine = getRoutine(Number(routineMatch[1]));

    if (!routine) {

      throw new HttpError(404, "No such routine");

    }

    if (routineMatch[2] && method === "POST") {

      // a watch run by hand skips the check and just does its task
      queue.enqueue(agentOr404(routine.agentId), routineTask({ ...routine, kind: "schedule" }));

      return json({ ok: true });

    }

    if (method === "DELETE") {

      deleteRoutine(routine.id);

      return json({ ok: true });

    }

    if (method === "PATCH") {

      const changes = await body<{ spec?: unknown; target?: unknown; task?: unknown; enabled?: unknown }>(req);
      const spec = changes.spec === undefined ? undefined : text(changes.spec, "spec").trim();
      const target = changes.target === undefined ? undefined : text(changes.target, "target").trim();

      if (changes.enabled !== undefined && typeof changes.enabled !== "boolean") {

        throw new HttpError(400, "enabled must be true or false");

      }

      validateRoutine(routine.kind, spec ?? routine.spec, target ?? routine.target);
      updateRoutine(routine.id, { spec, target, task: changes.task === undefined ? undefined : text(changes.task, "task"), enabled: changes.enabled as boolean | undefined });

      return json(getRoutine(routine.id));

    }

  }

  if (method === "GET" && path === "/api/group") {

    const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 200));
    const before = Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER);

    return json(listGroupMessages(limit, before));

  }

  if (method === "POST" && path === "/api/group") {

    const message = text((await body<{ text?: unknown }>(req)).text, "text").trim();

    if (!message) {

      throw new HttpError(400, "text is empty");

    }

    boodle();
    postGroup("user", null, message);

    return json({ ok: true }, 201);

  }

  if (method === "GET" && path === "/api/models") {

    models ??= (await boodle().listCustomModels()).map(({ id, name }) => ({ id, name }));

    return json(models);

  }

  if (method === "GET" && path === "/api/user") {

    return json({ text: readUserDoc() });

  }

  if (method === "PUT" && path === "/api/user") {

    writeUserDoc(text((await body<{ text?: unknown }>(req)).text, "text"));

    return json({ ok: true });

  }

  if (method === "GET" && path === "/api/cookie") {

    const cookie = readCookie();

    if (cookie && !account) {

      // an expired cookie still reads as set; the PWA shows it without a name, and runs say why they fail
      account = await boodle().getUser().then(accountOf).catch(() => null);

    }

    return json({ set: Boolean(cookie), userId: cookie ? parseSession(cookie).userId : null, name: account?.name ?? null, email: account?.email ?? null });

  }

  if (method === "PUT" && path === "/api/cookie") {

    const cookie = text((await body<{ cookie?: unknown }>(req)).cookie, "cookie").trim();
    const next = new BoodleClient({ cookie });

    // a cookie that cannot load the user is one that will fail every run
    const bootstrap = await next.getUser().catch((err) => {

      throw new HttpError(400, `Boodle rejected that cookie: ${err instanceof Error ? err.message : err}`);

    });

    writeCookie(cookie);
    client = next;
    models = null;
    preferredModel = undefined;
    account = accountOf(bootstrap);

    return json({ ok: true, userId: next.userId, ...account });

  }

  if (method === "GET" && path === "/api/push") {

    return json({ publicKey: VAPID_PUBLIC_KEY });

  }

  if (method === "POST" && path === "/api/push") {

    const sub = (await body<{ subscription?: { endpoint?: unknown } }>(req)).subscription;

    savePushSub(text(sub?.endpoint, "subscription.endpoint"), JSON.stringify(sub));

    return json({ ok: true });

  }

  if (method === "DELETE" && path === "/api/push") {

    deletePushSub(text((await body<{ endpoint?: unknown }>(req)).endpoint, "endpoint"));

    return json({ ok: true });

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

  port: PORT,

  async fetch(req) {

    const url = new URL(req.url);

    if (!url.pathname.startsWith("/api/")) {

      return serveWeb(url.pathname);

    }

    try {

      return await api(req, url);

    } catch (err) {

      if (err instanceof HttpError) {

        return json({ error: err.message }, err.status);

      }

      return json({ error: err instanceof Error ? err.message : String(err) }, 400);

    }

  },

  websocket: {

    open(ws: ServerWebSocket<unknown>) {

      ws.subscribe(TOPIC);

    },

    // a client says whether its window is on screen, and drives the live browser; everything else is HTTP
    message(ws: ServerWebSocket<unknown>, raw) {

      let message: { visible?: unknown } | LiveMessage;

      try {

        message = JSON.parse(String(raw));

      } catch {

        return;

      }

      if ("live" in message) {

        live.message(ws, message);
        return;

      }

      if (message.visible === true) {

        watching.add(ws);

      } else {

        watching.delete(ws);

      }

    },

    close(ws: ServerWebSocket<unknown>) {

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

  startScheduler((agent, task) => queue.enqueue(agent, task));

  console.log(`pts listening on http://localhost:${server.port}`);

}
