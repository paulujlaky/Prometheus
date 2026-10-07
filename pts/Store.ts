import { Database, type SQLQueryBindings } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { readRegular, writeRegular } from "./Agent/Tools/Shell";
import { randomGlyph } from "./Features/Glyph";

export const HOME = process.env.PTS_HOME ?? join(homedir(), ".pts");

const NAME = /^[A-Za-z][\w -]{0,31}$/;

export type EventKind = "task" | "user" | "assistant" | "result" | "say" | "notify" | "ask" | "question" | "handoff" | "done" | "error";

/** Someone with a key from the CLI. `cookie` is their Boodle cookie, null until they paste one. */
export interface User {

  id: number;
  name: string;

  cookie: string | null;

  createdAt: number;

}

export interface Agent {

  id: number;
  userId: number;
  name: string;

  modelId: string;
  persona: string;

  botDraftId: string | null;
  botAssistantId: string | null;
  botHash: string | null;

  /** "shape:color", see Glyph.ts. */
  glyph: string;

  /** The sidebar heading it sits under; empty for none. */
  category: string;

  createdAt: number;

}

export interface AgentEvent {

  id: number;
  agentId: number;
  runId: string;

  kind: EventKind;
  text: string;

  at: number;

}

/** `schedule` runs on a cron spec; `watch` checks `target` every `spec` minutes and runs only when it changes. */
export interface Routine {

  id: number;
  agentId: number;

  kind: "schedule" | "watch";
  spec: string;
  target: string;

  title: string;
  task: string;

  enabled: boolean;

  lastOutput: string | null;
  lastAt: number | null;

  /** When a schedule fires next. Worked out by the API, never stored. */
  nextAt?: number | null;

}

/** `author` is "user", "system" or the agent's name; `agentId` is set only for agents. `groupId` 0 is Everyone. */
export interface GroupMessage {

  id: number;
  groupId: number;

  author: string;
  agentId: number | null;

  text: string;

  at: number;

}

/** A thread with some of the agents. `name` defaults to theirs, joined. */
export interface GroupChat {

  id: number;
  name: string;
  members: number[];

  createdAt: number;

}

// every user's Boodle cookie is in the database, so nobody else on the machine gets to read it
mkdirSync(HOME, { recursive: true, mode: 0o700 });
chmodSync(HOME, 0o700);

const db = new Database(join(HOME, "pts.db"), { create: true, strict: true });

db.exec(`
  pragma journal_mode = wal;
  pragma foreign_keys = on;

  create table if not exists users (
    id integer primary key,
    name text not null unique collate nocase,
    key_hash text not null unique,
    cookie text,
    created_at integer not null
  );

  -- autoincrement: a reused id would hand a deleted agent's late events to someone else's new one
  create table if not exists agents (
    id integer primary key autoincrement,
    user_id integer not null references users(id) on delete cascade,
    name text not null collate nocase,
    model_id text not null,
    persona text not null default '',
    bot_draft_id text,
    bot_assistant_id text,
    bot_hash text,
    glyph text not null default '',
    category text not null default '',
    created_at integer not null,
    unique (user_id, name)
  );

  create table if not exists settings (
    user_id integer not null references users(id) on delete cascade,
    key text not null,
    value text not null,
    primary key (user_id, key)
  );

  create table if not exists events (
    id integer primary key,
    agent_id integer not null references agents(id) on delete cascade,
    run_id text not null,
    kind text not null,
    text text not null,
    at integer not null
  );

  create table if not exists push_subs (
    endpoint text primary key,
    json text not null,
    user_id integer not null references users(id) on delete cascade
  );

  create table if not exists routines (
    id integer primary key,
    agent_id integer not null references agents(id) on delete cascade,
    kind text not null,
    spec text not null,
    target text not null default '',
    title text not null default '',
    task text not null,
    enabled integer not null default 1,
    last_output text,
    last_at integer
  );

  -- no cascade from agents: a deleted agent's chats still have to be deleted from Boodle
  create table if not exists chats (
    id text primary key,
    agent_id integer not null,
    user_id integer not null references users(id) on delete cascade
  );

  create table if not exists group_chats (
    id integer primary key,
    name text not null,
    created_at integer not null,
    user_id integer not null references users(id) on delete cascade
  );

  create table if not exists group_members (
    group_id integer not null references group_chats(id) on delete cascade,
    agent_id integer not null references agents(id) on delete cascade,
    primary key (group_id, agent_id)
  );

  -- group 0 is each user's Everyone, which has no row in group_chats
  create table if not exists group_messages (
    id integer primary key,
    author text not null,
    agent_id integer,
    text text not null,
    at integer not null,
    group_id integer not null default 0,
    user_id integer not null references users(id) on delete cascade
  );

  create index if not exists events_by_agent on events(agent_id, id);
  create index if not exists group_messages_by_thread on group_messages(user_id, group_id, id);
`);

const one = <T>(sql: string, ...args: SQLQueryBindings[]) => db.query<T, SQLQueryBindings[]>(sql).get(...args);
const all = <T>(sql: string, ...args: SQLQueryBindings[]) => db.query<T, SQLQueryBindings[]>(sql).all(...args);
const run = (sql: string, ...args: SQLQueryBindings[]) => void db.query(sql).run(...args);

const USER = "select id, name, cookie, created_at as createdAt from users";
const AGENT = "id, user_id as userId, name, model_id as modelId, persona, bot_draft_id as botDraftId, bot_assistant_id as botAssistantId, bot_hash as botHash, glyph, category, created_at as createdAt";
const EVENT = "id, agent_id as agentId, run_id as runId, kind, text, at";
const ROUTINE = "id, agent_id as agentId, kind, spec, target, title, task, enabled = 1 as enabled, last_output as lastOutput, last_at as lastAt";
const GROUP_MESSAGE = "id, group_id as groupId, author, agent_id as agentId, text, at";
const GROUP_CHATS = "select g.id, g.name, g.created_at as createdAt, group_concat(m.agent_id) as members from group_chats g left join group_members m on m.group_id = g.id where g.user_id = ?";

const hashKey = (key: string) => new Bun.CryptoHasher("sha256").update(key).digest("hex");

// sqlite hands booleans back as 0 and 1
const routineOf = (row: Routine | null) => row && { ...row, enabled: Boolean(row.enabled) };
const groupChatOf = (row: (Omit<GroupChat, "members"> & { members: string | null }) | null): GroupChat | null => row && { ...row, members: row.members ? row.members.split(",").map(Number) : [] };

/** Where a user's agents and USER.md live. Browser settings are scoped to it too. */
export const userDir = (userId: number) => join(HOME, "users", String(userId));

/** Makes the user if they are new and gives them a fresh key either way; the old one stops working. Only its hash is kept. */
export function issueKey(name: string): string {

  if (!NAME.test(name)) {

    throw new Error("User names start with a letter and use up to 32 letters, digits, spaces, - or _");

  }

  const key = `pts_${randomBytes(24).toString("base64url")}`;

  run("insert into users (name, key_hash, created_at) values (?, ?, ?) on conflict (name) do update set key_hash = excluded.key_hash", name, hashKey(key), Date.now());

  return key;

}

export const userByKey = (key: string) => key ? one<User>(`${USER} where key_hash = ?`, hashKey(key)) : null;
export const getUser = (name: string) => one<User>(`${USER} where name = ?`, name);
export const listUsers = () => all<User>(`${USER} order by name`);

/** Everything of theirs in the database goes with them; their workspaces stay on disk, like a deleted agent's. */
export const deleteUser = (id: number) => run("delete from users where id = ?", id);

export const readCookie = (userId: number) => one<{ cookie: string | null }>("select cookie from users where id = ?", userId)?.cookie ?? null;
export const writeCookie = (userId: number, cookie: string) => run("update users set cookie = ? where id = ?", cookie.trim(), userId);

/** The folder an agent's commands run in. Its name is the agent's, lower-cased, so it reads well in a shell. */
export const workspaceOf = (agent: Pick<Agent, "userId" | "name">) => join(userDir(agent.userId), "agents", agent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"));

export const readUserDoc = (userId: number) => existsSync(join(userDir(userId), "USER.md")) ? readFileSync(join(userDir(userId), "USER.md"), "utf8") : "";

export function writeUserDoc(userId: number, text: string) {

  mkdirSync(userDir(userId), { recursive: true });
  writeFileSync(join(userDir(userId), "USER.md"), text);

}

/** The agent's shell can swap MEMORY.md for a link or a FIFO at any moment, so neither is ever followed. */
export function readMemory(agent: Agent): string {

  try {

    return readRegular(join(workspaceOf(agent), "MEMORY.md"), false);

  } catch {

    return "";

  }

}

export const writeMemory = (agent: Agent, text: string) => writeRegular(join(workspaceOf(agent), "MEMORY.md"), text);

export function createAgent(userId: number, name: string, modelId: string, persona = ""): Agent {

  if (!NAME.test(name)) {

    throw new Error("Agent names start with a letter and use up to 32 letters, digits, spaces, - or _");

  }

  const workspace = workspaceOf({ userId, name });

  mkdirSync(workspace, { recursive: true });

  // a deleted agent's workspace comes back with its name, and "wx" never creates through a link left in it
  try {

    writeFileSync(join(workspace, "MEMORY.md"), "", { flag: "wx" });

  } catch {}

  return one<Agent>(`insert into agents (user_id, name, model_id, persona, glyph, created_at) values (?, ?, ?, ?, ?, ?) returning ${AGENT}`, userId, name, modelId, persona, randomGlyph(), Date.now())!;

}

export const getAgent = (userId: number, name: string) => one<Agent>(`select ${AGENT} from agents where user_id = ? and name = ?`, userId, name);
export const getAgentById = (id: number) => one<Agent>(`select ${AGENT} from agents where id = ?`, id);
export const listAgents = (userId: number) => all<Agent>(`select ${AGENT} from agents where user_id = ? order by name`, userId);

export const updateAgent = (id: number, changes: { modelId?: string; persona?: string; glyph?: string; category?: string }) => run("update agents set model_id = coalesce(?, model_id), persona = coalesce(?, persona), glyph = coalesce(?, glyph), category = coalesce(?, category) where id = ?", changes.modelId ?? null, changes.persona ?? null, changes.glyph ?? null, changes.category ?? null, id);

/** The workspace stays on disk: an agent's files are worth more than the row that pointed at them. */
export function deleteAgent(id: number) {

  run("delete from agents where id = ?", id);
  run("delete from settings where key = ?", `read:agent:${id}`);

}

export const saveBot = (agentId: number, draftId: string, assistantId: string, hash: string) => run("update agents set bot_draft_id = ?, bot_assistant_id = ?, bot_hash = ? where id = ?", draftId, assistantId, hash, agentId);

/** Boodle chats a run opened and has not deleted yet. */
export const trackChat = (id: string, agentId: number, userId: number) => run("insert or ignore into chats (id, agent_id, user_id) values (?, ?, ?)", id, agentId, userId);
export const untrackChat = (id: string) => run("delete from chats where id = ?", id);
export const trackedChats = (userId: number, agentId?: number) => all<{ id: string }>("select id from chats where user_id = ?1 and (?2 is null or agent_id = ?2)", userId, agentId ?? null).map((row) => row.id);

export const addEvent = (agentId: number, runId: string, kind: EventKind, text: string) => one<AgentEvent>(`insert into events (agent_id, run_id, kind, text, at) values (?, ?, ?, ?, ?) returning ${EVENT}`, agentId, runId, kind, text, Date.now())!;

/** The newest `limit` events before `before`, oldest first — a page of chat history scrolling upward. */
export const listEvents = (agentId: number, limit = 200, before = Number.MAX_SAFE_INTEGER) => all<AgentEvent>(`select * from (select ${EVENT} from events where agent_id = ? and id < ? order by id desc limit ?) order by id`, agentId, before, limit);

export const listPushSubs = (userId: number) => all<{ json: string }>("select json from push_subs where user_id = ?", userId).map((row) => row.json);

/** A device belongs to whoever subscribed it last. */
export const savePushSub = (userId: number, endpoint: string, json: string) => run("insert into push_subs (endpoint, json, user_id) values (?, ?, ?) on conflict (endpoint) do update set json = excluded.json, user_id = excluded.user_id", endpoint, json, userId);
export const deletePushSub = (endpoint: string) => run("delete from push_subs where endpoint = ?", endpoint);

/** The task and the ending of each recent run, oldest first — what an agent sees of its own past. */
export function recentRuns(agentId: number, runs = 6): { task: string; outcome: string; at: number }[] {

  const rows = all<AgentEvent>(`
    select ${EVENT} from events
    where agent_id = ?1 and kind in ('task', 'done', 'error')
    and run_id in (select run_id from events where agent_id = ?1 and kind = 'task' order by id desc limit ?2)
    order by id
  `, agentId, runs);

  const byRun = new Map<string, { task: string; outcome: string; at: number }>();

  for (const row of rows) {

    const entry = byRun.get(row.runId) ?? { task: "", outcome: "", at: row.at };

    if (row.kind === "task") {

      entry.task = row.text;

    } else {

      entry.outcome = row.kind === "error" ? `failed: ${row.text}` : row.text;

    }

    byRun.set(row.runId, entry);

  }

  return [...byRun.values()];

}

export const listRoutines = (agentId?: number) => all<Routine>(`select ${ROUTINE} from routines where ?1 is null or agent_id = ?1 order by id`, agentId ?? null).map((row) => routineOf(row)!);
export const getRoutine = (id: number) => routineOf(one<Routine>(`select ${ROUTINE} from routines where id = ?`, id));

export const createRoutine = (agentId: number, input: Pick<Routine, "kind" | "spec" | "target" | "title" | "task">) => routineOf(one<Routine>(`insert into routines (agent_id, kind, spec, target, title, task) values (?, ?, ?, ?, ?, ?) returning ${ROUTINE}`, agentId, input.kind, input.spec, input.target, input.title, input.task))!;

/** A changed spec or target starts the watch over, so the next check sets a fresh baseline instead of waking the agent. */
export const updateRoutine = (id: number, changes: Partial<Pick<Routine, "spec" | "target" | "task" | "enabled">>) => run(`
  update routines set
    spec = coalesce(?, spec),
    target = coalesce(?, target),
    task = coalesce(?, task),
    enabled = coalesce(?, enabled),
    last_output = case when ? then null else last_output end
  where id = ?
`, changes.spec ?? null, changes.target ?? null, changes.task ?? null, changes.enabled === undefined ? null : Number(changes.enabled), changes.spec !== undefined || changes.target !== undefined ? 1 : 0, id);

export const markRoutine = (id: number, lastOutput: string | null, lastAt: number) => run("update routines set last_output = coalesce(?, last_output), last_at = ? where id = ?", lastOutput, lastAt, id);
export const deleteRoutine = (id: number) => run("delete from routines where id = ?", id);

export const addGroupMessage = (userId: number, groupId: number, author: string, agentId: number | null, text: string) => one<GroupMessage>(`insert into group_messages (user_id, group_id, author, agent_id, text, at) values (?, ?, ?, ?, ?, ?) returning ${GROUP_MESSAGE}`, userId, groupId, author, agentId, text, Date.now())!;

/** The newest `limit` messages before `before`, oldest first. */
export const listGroupMessages = (userId: number, groupId: number, limit = 200, before = Number.MAX_SAFE_INTEGER) => all<GroupMessage>(`select * from (select ${GROUP_MESSAGE} from group_messages where user_id = ? and group_id = ? and id < ? order by id desc limit ?) order by id`, userId, groupId, before, limit);

export function createGroupChat(userId: number, name: string, members: number[]): GroupChat {

  const { id } = one<{ id: number }>("insert into group_chats (user_id, name, created_at) values (?, ?, ?) returning id", userId, name, Date.now())!;

  for (const agentId of members) {

    run("insert or ignore into group_members (group_id, agent_id) values (?, ?)", id, agentId);

  }

  return getGroupChat(userId, id)!;

}

export const getGroupChat = (userId: number, id: number) => groupChatOf(one(`${GROUP_CHATS} and g.id = ? group by g.id`, userId, id));
export const listGroupChats = (userId: number) => all<never>(`${GROUP_CHATS} group by g.id order by g.id`, userId).map((row) => groupChatOf(row)!);

export function deleteGroupChat(userId: number, id: number) {

  run("delete from group_chats where user_id = ? and id = ?", userId, id);
  run("delete from group_messages where user_id = ? and group_id = ?", userId, id);
  run("delete from settings where user_id = ? and key = ?", userId, `read:group:${id}`);

}

const readMark = (userId: number, key: string) => Number(readSetting(userId, key) ?? 0);

/** What the agent said to the user since its chat was last open: says, and every <done> but a "wait". */
export const unreadEvents = (agent: Agent) => one<{ n: number }>("select count(*) as n from events where agent_id = ? and id > ? and (kind = 'say' or (kind = 'done' and lower(trim(text, ' .!' || char(9, 10, 13))) != 'wait'))", agent.id, readMark(agent.userId, `read:agent:${agent.id}`))!.n;
export const unreadGroup = (userId: number, groupId: number) => one<{ n: number }>("select count(*) as n from group_messages where user_id = ? and group_id = ? and author != 'user' and id > ?", userId, groupId, readMark(userId, `read:group:${groupId}`))!.n;

export function markRead(userId: number, target: "agent" | "group", id: number) {

  const latest = target === "agent"
    ? one<{ n: number }>("select coalesce(max(id), 0) as n from events where agent_id = ?", id)!
    : one<{ n: number }>("select coalesce(max(id), 0) as n from group_messages where user_id = ? and group_id = ?", userId, id)!;

  writeSetting(userId, `read:${target}:${id}`, String(latest.n));

}

export const readSetting = (userId: number, key: string) => one<{ value: string }>("select value from settings where user_id = ? and key = ?", userId, key)?.value ?? null;
export const writeSetting = (userId: number, key: string, value: string) => run("insert into settings (user_id, key, value) values (?, ?, ?) on conflict (user_id, key) do update set value = excluded.value", userId, key, value);

/** The one clock a user's schedules, agents and shells read: their zone from Settings, else this machine's. */
export const userZone = (userId: number) => readSetting(userId, "timezone") || Intl.DateTimeFormat().resolvedOptions().timeZone;
