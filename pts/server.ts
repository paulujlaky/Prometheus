import { timingSafeEqual } from "node:crypto";

import type { ServerWebSocket } from "bun";

import { BoodleClient, parseSession } from "../sdk/index";

import { Queue, type AgentState } from "./Agent/Queue";
import { runAgent, type RunEvent } from "./Agent/Runner";
import { notify, VAPID_PUBLIC_KEY } from "./Push";
import { createAgent, deleteAgent, deletePushSub, getAgentById, listAgents, listEvents, readCookie, readMemory, readUserDoc, savePushSub, updateAgent, writeCookie, writeMemory, writeUserDoc, type Agent } from "./Store";

const PORT = Number(process.env.PTS_PORT ?? 7420);
const TOKEN = process.env.PTS_TOKEN ?? "";
const SESSION_COOKIE = "pts_session";
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

  if (event.kind === "done") {

    notify({ title: name, body: event.text.split("\n")[0], agentId: event.agentId }).catch(() => {});
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

const queue = new Queue((agent, task, control) => runAgent(boodle(), agent, task, control), onRunEvent, (agentId: number, state: AgentState) => broadcast({ type: "state", agentId, state }));

function view(agent: Agent) {

  return { id: agent.id, name: agent.name, modelId: agent.modelId, persona: agent.persona, createdAt: agent.createdAt, state: queue.state(agent.id) };

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

    const changes = await body<{ modelId?: unknown; persona?: unknown }>(req);

    updateAgent(agent.id, {

      modelId: changes.modelId === undefined ? undefined : text(changes.modelId, "modelId"),
      persona: changes.persona === undefined ? undefined : text(changes.persona, "persona"),

    });

    return json(view(agentOr404(agent.id)));

  }

  if (!action && method === "DELETE") {

    queue.stop(agent.id);

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

    return json(view(createAgent(text(input.name, "name").trim(), text(input.modelId, "modelId"), input.persona === undefined ? "" : text(input.persona, "persona"))), 201);

  }

  const match = /^\/api\/agents\/(\d+)(?:\/(\w+))?$/.exec(path);

  if (match) {

    return agentRoute(req, url, agentOr404(Number(match[1])), match[2]);

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

    return json({ set: Boolean(cookie), userId: cookie ? parseSession(cookie).userId : null });

  }

  if (method === "PUT" && path === "/api/cookie") {

    const cookie = text((await body<{ cookie?: unknown }>(req)).cookie, "cookie").trim();
    const next = new BoodleClient({ cookie });

    // a cookie that cannot load the user is one that will fail every run
    await next.getUser().catch((err) => {

      throw new HttpError(400, `Boodle rejected that cookie: ${err instanceof Error ? err.message : err}`);

    });

    writeCookie(cookie);
    client = next;
    models = null;

    return json({ ok: true, userId: next.userId });

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

export const server = Bun.serve({

  port: PORT,

  async fetch(req) {

    const url = new URL(req.url);

    if (!url.pathname.startsWith("/api/")) {

      return new Response("Prometheus API. The PWA is served here from phase 7.", { status: 404 });

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

    // the socket only pushes; everything the client does goes through HTTP
    message() {},

  },

});

if (import.meta.main) {

  console.log(`pts listening on http://localhost:${server.port}`);

}
