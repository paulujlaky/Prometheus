import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "test-token-0123456789abcdef";

// the store and server read these once, at import
process.env.PTS_HOME = mkdtempSync(join(tmpdir(), "pts-server-"));
process.env.PTS_TOKEN = TOKEN;
process.env.PTS_PORT = "0";
process.env.BOODLE_COOKIE = "";

const { server } = await import("../Server/server");

const base = `http://localhost:${server.port}`;
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

afterAll(() => server.stop(true));

function call(path: string, init: RequestInit = {}) {

  return fetch(`${base}${path}`, { ...init, headers: { ...auth, ...init.headers } });

}

test("everything but login needs the token", async () => {

  expect((await fetch(`${base}/api/agents`)).status).toBe(401);
  expect((await fetch(`${base}/api/agents`, { headers: { Authorization: "Bearer nope" } })).status).toBe(401);

  const wrong = await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ token: "nope" }) });

  expect(wrong.status).toBe(401);

  const right = await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ token: TOKEN }) });
  const cookie = right.headers.get("set-cookie") ?? "";

  expect(cookie).toContain("HttpOnly");
  expect((await fetch(`${base}/api/agents`, { headers: { Cookie: cookie.split(";")[0] } })).status).toBe(200);

});

test("agents can be created, changed, remembered and deleted", async () => {

  const created = await call("/api/agents", { method: "POST", body: JSON.stringify({ name: "Tester", modelId: "model-1" }) });
  const agent = await created.json();

  expect(created.status).toBe(201);
  expect(agent).toMatchObject({ name: "Tester", modelId: "model-1", persona: "", state: "idle" });

  // without a model in the request it falls back to the default, which needs Boodle to resolve
  expect((await call("/api/agents", { method: "POST", body: JSON.stringify({ name: "Modelless" }) })).status).toBe(503);
  expect(await (await call("/api/settings")).json()).toEqual({ defaultModel: null });

  const duplicate = await call("/api/agents", { method: "POST", body: JSON.stringify({ name: "tester", modelId: "model-1" }) });

  expect(duplicate.status).toBe(400);

  const patched = await call(`/api/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ persona: "Terse." }) });

  expect((await patched.json()).persona).toBe("Terse.");

  await call(`/api/agents/${agent.id}/memory`, { method: "PUT", body: JSON.stringify({ text: "- likes tea" }) });

  expect(await (await call(`/api/agents/${agent.id}/memory`)).json()).toEqual({ text: "- likes tea" });
  expect(await (await call(`/api/agents/${agent.id}/events`)).json()).toEqual([]);

  // without a Boodle cookie a message cannot run, so it is refused rather than queued to fail
  const message = await call(`/api/agents/${agent.id}/messages`, { method: "POST", body: JSON.stringify({ text: "hi" }) });

  expect(message.status).toBe(503);

  expect((await call(`/api/agents/${agent.id}`, { method: "DELETE" })).status).toBe(200);
  expect((await call(`/api/agents/${agent.id}`)).status).toBe(404);

});

test("routines are validated, edited and removed; the group needs a cookie", async () => {

  const agent = await (await call("/api/agents", { method: "POST", body: JSON.stringify({ name: "Router", modelId: "model-1" }) })).json();
  const create = (routine: object) => call(`/api/agents/${agent.id}/routines`, { method: "POST", body: JSON.stringify(routine) });

  expect((await create({ kind: "schedule", spec: "every morning", task: "x" })).status).toBe(400);
  expect((await create({ kind: "watch", spec: "5", task: "x" })).status).toBe(400);

  const routine = await (await create({ kind: "watch", spec: "5", target: "https://example.com", task: "Tell me what changed" })).json();

  expect(routine).toMatchObject({ kind: "watch", enabled: true, lastOutput: null });

  const paused = await (await call(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) })).json();

  expect(paused.enabled).toBe(false);
  expect((await (await call(`/api/agents/${agent.id}/routines`)).json()).length).toBe(1);
  expect((await call(`/api/routines/${routine.id}`, { method: "DELETE" })).status).toBe(200);
  expect((await call(`/api/routines/${routine.id}`, { method: "DELETE" })).status).toBe(404);

  expect((await call("/api/group", { method: "POST", body: JSON.stringify({ text: "hi all" }) })).status).toBe(503);
  expect(await (await call("/api/group")).json()).toEqual([]);

});

test("push hands out a stable VAPID key", async () => {

  const first = await (await call("/api/push")).json();
  const second = await (await call("/api/push")).json();

  expect(first.publicKey).toBeString();
  expect(first.publicKey).toBe(second.publicKey);

});

test("the socket upgrades only when authorized", async () => {

  const opened = await new Promise<boolean>((resolve) => {

    const ws = new WebSocket(`ws://localhost:${server.port}/api/ws`, { headers: { Authorization: `Bearer ${TOKEN}` } } as unknown as string[]);

    ws.onopen = () => {

      ws.close();
      resolve(true);

    };

    ws.onerror = () => resolve(false);

  });

  const refused = await new Promise<boolean>((resolve) => {

    const ws = new WebSocket(`ws://localhost:${server.port}/api/ws`);

    ws.onopen = () => resolve(false);
    ws.onerror = () => resolve(true);

  });

  expect(opened).toBe(true);
  expect(refused).toBe(true);

});
