import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { randomGlyph } from "./Features/Glyph";

export const HOME = process.env.PTS_HOME ?? join(homedir(), ".pts");

const NAME = /^[A-Za-z][\w -]{0,31}$/;

export type EventKind = "task" | "user" | "assistant" | "result" | "say" | "notify" | "ask" | "question" | "handoff" | "done" | "error";

export interface Agent {

  id: number;
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

mkdirSync(join(HOME, "agents"), { recursive: true });

const db = new Database(join(HOME, "pts.db"), { create: true, strict: true });

db.exec("pragma journal_mode = wal; pragma foreign_keys = on;");

db.exec(`
  create table if not exists agents (
    id integer primary key,
    name text not null unique collate nocase,
    model_id text not null,
    persona text not null default '',
    bot_draft_id text,
    bot_assistant_id text,
    bot_hash text,
    created_at integer not null
  );

  create table if not exists events (
    id integer primary key,
    agent_id integer not null references agents(id) on delete cascade,
    run_id text not null,
    kind text not null,
    text text not null,
    at integer not null
  );

  create index if not exists events_by_agent on events(agent_id, id);

  create table if not exists push_subs (
    endpoint text primary key,
    json text not null
  );

  create table if not exists routines (
    id integer primary key,
    agent_id integer not null references agents(id) on delete cascade,
    kind text not null,
    spec text not null,
    target text not null default '',
    task text not null,
    enabled integer not null default 1,
    last_output text,
    last_at integer
  );

  create table if not exists settings (
    key text primary key,
    value text not null
  );

  -- no cascade: a deleted agent's chats still have to be deleted from Boodle
  create table if not exists chats (
    id text primary key,
    agent_id integer not null
  );

  create table if not exists group_chats (
    id integer primary key,
    name text not null,
    created_at integer not null
  );

  create table if not exists group_members (
    group_id integer not null references group_chats(id) on delete cascade,
    agent_id integer not null references agents(id) on delete cascade,
    primary key (group_id, agent_id)
  );

  create table if not exists group_messages (
    id integer primary key,
    author text not null,
    agent_id integer,
    text text not null,
    at integer not null
  );
`);

// added after the first databases existed, so older ones get the column and a mascot here
if (!db.query<{ name: string }, []>("pragma table_info(agents)").all().some((column) => column.name === "glyph")) {

  db.exec("alter table agents add column glyph text not null default ''");

}

for (const { id } of db.query<{ id: number }, []>("select id from agents where glyph = ''").all()) {

  db.query("update agents set glyph = ? where id = ?").run(randomGlyph(), id);

}

if (!db.query<{ name: string }, []>("pragma table_info(agents)").all().some((column) => column.name === "category")) {

  db.exec("alter table agents add column category text not null default ''");

  // history from before unread counts existed is read, or the first load would flag every chat
  for (const { id } of db.query<{ id: number }, []>("select id from agents").all()) {

    markRead("agent", id);

  }

}

// 0 is Everyone, which has no row in group_chats
if (!db.query<{ name: string }, []>("pragma table_info(group_messages)").all().some((column) => column.name === "group_id")) {

  db.exec("alter table group_messages add column group_id integer not null default 0");
  markRead("group", 0);

}

if (!db.query<{ name: string }, []>("pragma table_info(routines)").all().some((column) => column.name === "title")) {

  db.exec("alter table routines add column title text not null default ''");

}

const AGENT_COLUMNS = "id, name, model_id as modelId, persona, bot_draft_id as botDraftId, bot_assistant_id as botAssistantId, bot_hash as botHash, glyph, category, created_at as createdAt";
const EVENT_COLUMNS = "id, agent_id as agentId, run_id as runId, kind, text, at";
const ROUTINE_COLUMNS = "id, agent_id as agentId, kind, spec, target, title, task, enabled, last_output as lastOutput, last_at as lastAt";
const GROUP_COLUMNS = "id, group_id as groupId, author, agent_id as agentId, text, at";

/** `schedule` runs on a cron spec; `watch` checks `target` every `spec` minutes and runs only when it changes. */
export interface Routine {

  id: number;
  agentId: number;

  kind: "schedule" | "watch";
  spec: string;
  target: string;

  /** A few words for the app; empty on routines made before titles existed. */
  title: string;
  task: string;

  enabled: boolean;

  lastOutput: string | null;
  lastAt: number | null;

  /** When a schedule fires next. Worked out by the API, never stored. */
  nextAt?: number | null;

}

/** `author` is "user", "system" or the agent's name; `agentId` is set only for agents. */
export interface GroupMessage {

  id: number;

  /** 0 for Everyone. */
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

/** The folder an agent's commands run in. Its name is the agent's, lower-cased, so it reads well in a shell. */
export function workspaceOf(agent: Pick<Agent, "name">): string {

  return join(HOME, "agents", agent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"));

}

function readOr(path: string, fallback: string): string {

  return existsSync(path) ? readFileSync(path, "utf8") : fallback;

}

export function readUserDoc(): string {

  return readOr(join(HOME, "USER.md"), "");

}

export function writeUserDoc(text: string) {

  writeFileSync(join(HOME, "USER.md"), text);

}

export function readMemory(agent: Agent): string {

  return readOr(join(workspaceOf(agent), "MEMORY.md"), "");

}

export function writeMemory(agent: Agent, text: string) {

  writeFileSync(join(workspaceOf(agent), "MEMORY.md"), text);

}

const COOKIE_FILE = join(HOME, "cookie");

/** Pasted in the PWA, it outlives restarts; the env var is only the first-boot default. */
export function readCookie(): string | null {

  return readOr(COOKIE_FILE, "").trim() || process.env.BOODLE_COOKIE?.trim() || null;

}

export function writeCookie(cookie: string) {

  writeFileSync(COOKIE_FILE, cookie.trim(), { mode: 0o600 });

}

export function createAgent(name: string, modelId: string, persona = ""): Agent {

  if (!NAME.test(name)) {

    throw new Error("Agent names start with a letter and use up to 32 letters, digits, spaces, - or _");

  }

  const workspace = workspaceOf({ name });

  mkdirSync(workspace, { recursive: true });

  if (!existsSync(join(workspace, "MEMORY.md"))) {

    writeFileSync(join(workspace, "MEMORY.md"), "");

  }

  return db.query<Agent, [string, string, string, string, number]>(`insert into agents (name, model_id, persona, glyph, created_at) values (?, ?, ?, ?, ?) returning ${AGENT_COLUMNS}`).get(name, modelId, persona, randomGlyph(), Date.now())!;

}

export function getAgent(name: string): Agent | null {

  return db.query<Agent, [string]>(`select ${AGENT_COLUMNS} from agents where name = ?`).get(name);

}

export function getAgentById(id: number): Agent | null {

  return db.query<Agent, [number]>(`select ${AGENT_COLUMNS} from agents where id = ?`).get(id);

}

export function updateAgent(id: number, changes: { modelId?: string; persona?: string; glyph?: string; category?: string }) {

  db.query("update agents set model_id = coalesce(?, model_id), persona = coalesce(?, persona), glyph = coalesce(?, glyph), category = coalesce(?, category) where id = ?").run(changes.modelId ?? null, changes.persona ?? null, changes.glyph ?? null, changes.category ?? null, id);

}

/** The workspace stays on disk: an agent's files are worth more than the row that pointed at them. */
export function deleteAgent(id: number) {

  db.query("delete from agents where id = ?").run(id);
  db.query("delete from settings where key = ?").run(`read:agent:${id}`);

}

export function listAgents(): Agent[] {

  return db.query<Agent, []>(`select ${AGENT_COLUMNS} from agents order by name`).all();

}

export function saveBot(agentId: number, draftId: string, assistantId: string, hash: string) {

  db.query("update agents set bot_draft_id = ?, bot_assistant_id = ?, bot_hash = ? where id = ?").run(draftId, assistantId, hash, agentId);

}

/** Boodle chats a run opened and has not deleted yet. */
export function trackChat(id: string, agentId: number) {

  db.query("insert or ignore into chats (id, agent_id) values (?, ?)").run(id, agentId);

}

export function untrackChat(id: string) {

  db.query("delete from chats where id = ?").run(id);

}

export function trackedChats(agentId?: number): string[] {

  return db.query<{ id: string }, [number | null, number | null]>("select id from chats where ? is null or agent_id = ?").all(agentId ?? null, agentId ?? null).map((row) => row.id);

}

export function addEvent(agentId: number, runId: string, kind: EventKind, text: string): AgentEvent {

  return db.query<AgentEvent, [number, string, string, string, number]>(`insert into events (agent_id, run_id, kind, text, at) values (?, ?, ?, ?, ?) returning ${EVENT_COLUMNS}`).get(agentId, runId, kind, text, Date.now())!;

}

/** The newest `limit` events before `before`, oldest first — a page of chat history scrolling upward. */
export function listEvents(agentId: number, limit = 200, before = Number.MAX_SAFE_INTEGER): AgentEvent[] {

  return db.query<AgentEvent, [number, number, number]>(`select * from (select ${EVENT_COLUMNS} from events where agent_id = ? and id < ? order by id desc limit ?) order by id`).all(agentId, before, limit);

}

export interface SearchHit {

  id: number;
  source: "agent" | "group";
  threadId: number;
  title: string;
  author: string;
  text: string;
  at: number;

}

const SEARCH_MESSAGES = `
  select e.id, 'agent' as source, e.agent_id as threadId, a.name as title,
    case when e.kind in ('task', 'user') then 'You' else a.name end as author, e.text, e.at
  from events e join agents a on a.id = e.agent_id
  where e.kind in ('task', 'user', 'say', 'done', 'notify', 'question', 'ask', 'handoff', 'error')
    and not (e.kind = 'done' and lower(trim(e.text, ' .!' || char(9, 10, 13))) = 'wait')
  union all
  select m.id, 'group', m.group_id, coalesce(g.name, 'Everyone'),
    case when m.author = 'user' then 'You' else m.author end, m.text, m.at
  from group_messages m left join group_chats g on g.id = m.group_id
`;

export function searchMessages(query: string, scope = "", offset = 0): SearchHit[] {

  return db.query<SearchHit, [string, string, string, number]>(`
    select * from (${SEARCH_MESSAGES})
    where instr(lower(text), lower(?)) > 0 and (? = '' or source || ':' || threadId = ?)
    order by at desc, source, id desc limit 51 offset ?
  `).all(query, scope, scope, offset);

}

export function searchContext(source: string, id: number): SearchHit[] {

  const hit = db.query<SearchHit, [string, number]>(`select * from (${SEARCH_MESSAGES}) where source = ? and id = ?`).get(source, id);

  if (!hit) {

    return [];

  }

  return db.query<SearchHit, [string, number, number]>(`
    with messages as (select * from (${SEARCH_MESSAGES}) where source = ?1 and threadId = ?2)
    select * from (select * from messages where id <= ?3 order by id desc limit 11)
    union all select * from (select * from messages where id > ?3 order by id limit 10)
    order by id
  `).all(source, hit.threadId, id);

}

export function listPushSubs(): string[] {

  return db.query<{ json: string }, []>("select json from push_subs").all().map((row) => row.json);

}

export function savePushSub(endpoint: string, json: string) {

  db.query("insert into push_subs (endpoint, json) values (?, ?) on conflict (endpoint) do update set json = excluded.json").run(endpoint, json);

}

export function deletePushSub(endpoint: string) {

  db.query("delete from push_subs where endpoint = ?").run(endpoint);

}

/** The task and the ending of each recent run, oldest first — what an agent sees of its own past. */
export function recentRuns(agentId: number, runs = 6): { task: string; outcome: string; at: number }[] {

  const rows = db.query<AgentEvent, [number, number]>(`
    select ${EVENT_COLUMNS} from events
    where agent_id = ?1 and kind in ('task', 'done', 'error')
    and run_id in (select run_id from events where agent_id = ?1 and kind = 'task' order by id desc limit ?2)
    order by id
  `).all(agentId, runs);

  const byRun = new Map<string, { task: string; outcome: string; at: number }>();

  for (const row of rows) {

    const run = byRun.get(row.runId) ?? { task: "", outcome: "", at: row.at };

    if (row.kind === "task") {

      run.task = row.text;

    } else {

      run.outcome = row.kind === "error" ? `failed: ${row.text}` : row.text;

    }

    byRun.set(row.runId, run);

  }

  return [...byRun.values()];

}

type RoutineRow = Omit<Routine, "enabled"> & { enabled: number };

function routineOf(row: RoutineRow): Routine {

  return { ...row, enabled: row.enabled === 1 };

}

export function listRoutines(agentId?: number): Routine[] {

  const rows = agentId === undefined
    ? db.query<RoutineRow, []>(`select ${ROUTINE_COLUMNS} from routines order by id`).all()
    : db.query<RoutineRow, [number]>(`select ${ROUTINE_COLUMNS} from routines where agent_id = ? order by id`).all(agentId);

  return rows.map(routineOf);

}

export function getRoutine(id: number): Routine | null {

  const row = db.query<RoutineRow, [number]>(`select ${ROUTINE_COLUMNS} from routines where id = ?`).get(id);

  return row && routineOf(row);

}

export function createRoutine(agentId: number, input: Pick<Routine, "kind" | "spec" | "target" | "title" | "task">): Routine {

  const row = db.query<RoutineRow, [number, string, string, string, string, string]>(`insert into routines (agent_id, kind, spec, target, title, task) values (?, ?, ?, ?, ?, ?) returning ${ROUTINE_COLUMNS}`).get(agentId, input.kind, input.spec, input.target, input.title, input.task)!;

  return routineOf(row);

}

/** A changed spec or target starts the watch over, so the next check sets a fresh baseline instead of waking the agent. */
export function updateRoutine(id: number, changes: Partial<Pick<Routine, "spec" | "target" | "task" | "enabled">>) {

  const reset = changes.spec !== undefined || changes.target !== undefined;

  db.query(`
    update routines set
      spec = coalesce(?, spec),
      target = coalesce(?, target),
      task = coalesce(?, task),
      enabled = coalesce(?, enabled),
      last_output = case when ? then null else last_output end
    where id = ?
  `).run(changes.spec ?? null, changes.target ?? null, changes.task ?? null, changes.enabled === undefined ? null : Number(changes.enabled), reset ? 1 : 0, id);

}

export function markRoutine(id: number, lastOutput: string | null, lastAt: number) {

  db.query("update routines set last_output = coalesce(?, last_output), last_at = ? where id = ?").run(lastOutput, lastAt, id);

}

export function deleteRoutine(id: number) {

  db.query("delete from routines where id = ?").run(id);

}

export function addGroupMessage(groupId: number, author: string, agentId: number | null, text: string): GroupMessage {

  return db.query<GroupMessage, [number, string, number | null, string, number]>(`insert into group_messages (group_id, author, agent_id, text, at) values (?, ?, ?, ?, ?) returning ${GROUP_COLUMNS}`).get(groupId, author, agentId, text, Date.now())!;

}

/** The newest `limit` messages before `before`, oldest first. */
export function listGroupMessages(groupId: number, limit = 200, before = Number.MAX_SAFE_INTEGER): GroupMessage[] {

  return db.query<GroupMessage, [number, number, number]>(`select * from (select ${GROUP_COLUMNS} from group_messages where group_id = ? and id < ? order by id desc limit ?) order by id`).all(groupId, before, limit);

}

type GroupChatRow = Omit<GroupChat, "members"> & { members: string | null };

const GROUP_CHATS = "select g.id, g.name, g.created_at as createdAt, group_concat(m.agent_id) as members from group_chats g left join group_members m on m.group_id = g.id";

function groupChatOf(row: GroupChatRow): GroupChat {

  return { ...row, members: row.members ? row.members.split(",").map(Number) : [] };

}

export function createGroupChat(name: string, members: number[]): GroupChat {

  const { id } = db.query<{ id: number }, [string, number]>("insert into group_chats (name, created_at) values (?, ?) returning id").get(name, Date.now())!;

  for (const agentId of members) {

    db.query("insert or ignore into group_members (group_id, agent_id) values (?, ?)").run(id, agentId);

  }

  return getGroupChat(id)!;

}

export function getGroupChat(id: number): GroupChat | null {

  const row = db.query<GroupChatRow, [number]>(`${GROUP_CHATS} where g.id = ? group by g.id`).get(id);

  return row && groupChatOf(row);

}

export function listGroupChats(): GroupChat[] {

  return db.query<GroupChatRow, []>(`${GROUP_CHATS} group by g.id order by g.id`).all().map(groupChatOf);

}

export function deleteGroupChat(id: number) {

  db.query("delete from group_chats where id = ?").run(id);
  db.query("delete from group_messages where group_id = ?").run(id);
  db.query("delete from settings where key = ?").run(`read:group:${id}`);

}

function readMark(key: string): number {

  return Number(readSetting(key) ?? 0);

}

/** What the agent said to the user since its chat was last open: says, and every <done> but a "wait". */
export function unreadEvents(agentId: number): number {

  return db.query<{ n: number }, [number, number]>("select count(*) as n from events where agent_id = ? and id > ? and (kind = 'say' or (kind = 'done' and lower(trim(text, ' .!' || char(9, 10, 13))) != 'wait'))").get(agentId, readMark(`read:agent:${agentId}`))!.n;

}

export function unreadGroup(groupId: number): number {

  return db.query<{ n: number }, [number, number]>("select count(*) as n from group_messages where group_id = ? and author != 'user' and id > ?").get(groupId, readMark(`read:group:${groupId}`))!.n;

}

export function markRead(target: "agent" | "group", id: number) {

  const latest = target === "agent" ? "select coalesce(max(id), 0) as n from events where agent_id = ?" : "select coalesce(max(id), 0) as n from group_messages where group_id = ?";

  writeSetting(`read:${target}:${id}`, String(db.query<{ n: number }, [number]>(latest).get(id)!.n));

}

export function readSetting(key: string): string | null {

  return db.query<{ value: string }, [string]>("select value from settings where key = ?").get(key)?.value ?? null;

}

/** The one clock schedules, the agent and its shell all read: the user's zone from Settings, else this machine's. */
export function userZone(): string {

  return readSetting("timezone") || Intl.DateTimeFormat().resolvedOptions().timeZone;

}

export function writeSetting(key: string, value: string) {

  db.query("insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value").run(key, value);

}
