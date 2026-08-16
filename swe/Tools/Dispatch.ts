import { parseAsk, type Question } from "./Ask";
import { applyEdit } from "./Edit";
import { deleteFiles, grep, listDir, parseReadSpec, readFiles, writeFile } from "./FS";
import { parsePlan, type Plan } from "./Plan";
import { parseSpawn, type SubagentTask } from "./Subagent";

import { bodyLines } from "../Agent/Lines";
import type { Action, Result, Verb } from "../Agent/Protocol";

export type Outcome =

  | { kind: "result"; result: Result }
  | { kind: "run"; command: string }

  /** Parked rather than executed: spawning needs the client and the parent's own loop. */
  | { kind: "spawn"; tasks: SubagentTask[] }

  | { kind: "ask"; question: Question }

  /** Parked too: the user decides whether it gets built, and which model builds it. */
  | { kind: "plan"; plan: Plan }
  | { kind: "say"; text: string }
  | { kind: "done"; summary: string };

/** The target of a block, whether the model put it on the tag or on the first line. */
function targetOf(action: Action): string {

  if (action.path) {

    return action.path;

  }

  return bodyLines(action.body)[0] ?? "";

}

const PATH_ONLY = /^[\w./@-]+\.\w+$/;

/** `<edit>` with the path on its own first line instead of on the tag. */
function splitLeadingPath(action: Action): { path: string; body: string } {

  if (action.path) {

    return { path: action.path, body: action.body };

  }

  const [first, ...rest] = action.body.split("\n");

  if (PATH_ONLY.test(first.trim())) {

    return { path: first.trim(), body: rest.join("\n") };

  }

  return { path: "", body: action.body };

}

// The verbs that are likely to be used to read files, and which we want to disallow in <run> blocks.
const READERS = /^\s*(grep|rg|ag|ack|findstr|cat|type|head|tail|less|more|ls|dir|tree|find)\b/i;

export function execute(action: Action, cwd: string): Outcome {

  const ok = (verb: Verb, text: string): Outcome => ({ kind: "result", result: { verb, ok: true, text } });

  if (action.verb === "say") {

    return { kind: "say", text: action.body.trim() };

  }

  if (action.verb === "done") {

    return { kind: "done", summary: action.body.trim() || "Task complete." };

  }

  if (action.verb === "ask") {

    return { kind: "ask", question: parseAsk(action) };

  }

  if (action.verb === "plan") {

    return { kind: "plan", plan: parsePlan(action) };

  }

  // the loop swaps retry for the held blocks before dispatch ever sees it
  if (action.verb === "retry") {

    throw new Error("retry replays the blocks a failed batch held, and none are held right now. Send the block itself.");

  }

  if (action.verb === "spawn") {

    return { kind: "spawn", tasks: parseSpawn(action) };

  }

  if (action.verb === "run") {

    const command = action.body.trim();

    if (!command) {

      throw new Error("run needs a command");

    }

    if (READERS.test(command)) {

      throw new Error(`Use <read>, <grep> or <ls> to look at files — they give line numbers. <run> is for building, testing and git.`);

    }

    return { kind: "run", command };

  }

  if (action.verb === "ls") {

    return ok("ls", listDir(cwd, targetOf(action) || "."));

  }

  if (action.verb === "read") {

    const lines = bodyLines(action.body);
    const specs = (lines.length ? lines : [action.path]).filter(Boolean).map(parseReadSpec);

    return ok("read", readFiles(cwd, specs));

  }

  if (action.verb === "grep") {

    // every line is a pattern

    const patterns = bodyLines(action.body);
    const where = action.path;

    const options = where.includes("*") ? { glob: where } : { path: where || "." };

    return ok("grep", grep(cwd, patterns, options));

  }

  if (action.verb === "write") {

    const { path, body } = splitLeadingPath(action);

    if (!path) {

      throw new Error("write needs a path on the tag: <write swe/file.ts>");

    }

    return ok("write", writeFile(cwd, path, body));

  }

  if (action.verb === "delete") {

    const targets = action.path ? [action.path] : bodyLines(action.body);

    return ok("delete", deleteFiles(cwd, targets));

  }

  const { path, body } = splitLeadingPath(action);

  if (!path) {

    throw new Error("edit needs a path on the tag: <edit swe/file.ts>");

  }

  const report = applyEdit(cwd, path, body);

  return { kind: "result", result: { verb: "edit", ok: report.ok, text: report.text } };

}
