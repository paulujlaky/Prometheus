import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = process.env.PTS_HOME ?? join(homedir(), ".pts");

const NAME = /^[A-Za-z][\w -]{0,31}$/;

export type EventKind = "task" | "user" | "assistant" | "result" | "say" | "done" | "error";

export interface Agent {

  id: number;
  name: string;

  modelId: string;
  persona: string;

  botDraftId: string | null;
  botAssistantId: string | null;
  botHash: string | null;

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
`);

const AGENT_COLUMNS = "id, name, model_id as modelId, persona, bot_draft_id as botDraftId, bot_assistant_id as botAssistantId, bot_hash as botHash, created_at as createdAt";
const EVENT_COLUMNS = "id, agent_id as agentId, run_id as runId, kind, text, at";

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

export function readMemory(agent: Agent): string {

  return readOr(join(workspaceOf(agent), "MEMORY.md"), "");

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

  return db.query<Agent, [string, string, string, number]>(`insert into agents (name, model_id, persona, created_at) values (?, ?, ?, ?) returning ${AGENT_COLUMNS}`).get(name, modelId, persona, Date.now())!;

}

export function getAgent(name: string): Agent | null {

  return db.query<Agent, [string]>(`select ${AGENT_COLUMNS} from agents where name = ?`).get(name);

}

export function getAgentById(id: number): Agent | null {

  return db.query<Agent, [number]>(`select ${AGENT_COLUMNS} from agents where id = ?`).get(id);

}

export function listAgents(): Agent[] {

  return db.query<Agent, []>(`select ${AGENT_COLUMNS} from agents order by name`).all();

}

export function saveBot(agentId: number, draftId: string, assistantId: string, hash: string) {

  db.query("update agents set bot_draft_id = ?, bot_assistant_id = ?, bot_hash = ? where id = ?").run(draftId, assistantId, hash, agentId);

}

export function addEvent(agentId: number, runId: string, kind: EventKind, text: string): AgentEvent {

  return db.query<AgentEvent, [number, string, string, string, number]>(`insert into events (agent_id, run_id, kind, text, at) values (?, ?, ?, ?, ?) returning ${EVENT_COLUMNS}`).get(agentId, runId, kind, text, Date.now())!;

}

export function listEvents(agentId: number, limit = 200): AgentEvent[] {

  return db.query<AgentEvent, [number, number]>(`select * from (select ${EVENT_COLUMNS} from events where agent_id = ? order by id desc limit ?) order by id`).all(agentId, limit);

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
