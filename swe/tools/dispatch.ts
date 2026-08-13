import { applyEdit } from "./edit";
import { deleteFiles, grep, listDir, parseReadSpec, readFiles, writeFile } from "./fs";

import type { Action, Result, Verb } from "../protocol";

export type Outcome =

  | { kind: "result"; result: Result }
  | { kind: "run"; command: string }
  | { kind: "say"; text: string }
  | { kind: "done"; summary: string };

function bodyLines(action: Action): string[] {

  return action.body.split("\n").map((line) => line.trim()).filter(Boolean);

}

/** The target of a block, whether the model put it on the tag or on the first line. */
function targetOf(action: Action): string {

  if (action.path) {

    return action.path;

  }

  return bodyLines(action)[0] ?? "";

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

// reading through the shell loses line numbers and costs a whole turn; the real tools are better.
// sed and awk stay allowed on purpose — a bulk transform is exactly what they are for, and a bad
// one shows up in the next build, whereas banning them costs several turns of hand edits.
const READERS = /^\s*(grep|rg|ag|ack|findstr|cat|type|head|tail|less|more|ls|dir|tree|find)\b/i;

export function execute(action: Action, cwd: string): Outcome {

  const ok = (verb: Verb, text: string): Outcome => ({ kind: "result", result: { verb, ok: true, text } });

  if (action.verb === "say") {

    return { kind: "say", text: action.body.trim() };

  }

  if (action.verb === "done") {

    return { kind: "done", summary: action.body.trim() || "Task complete." };

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

    const lines = bodyLines(action);
    const specs = (lines.length ? lines : [action.path]).filter(Boolean).map(parseReadSpec);

    return ok("read", readFiles(cwd, specs));

  }

  if (action.verb === "grep") {

    // every line is a pattern — a model searching for two symbols writes them on two lines
    const patterns = bodyLines(action);
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

    const targets = action.path ? [action.path] : bodyLines(action);

    return ok("delete", deleteFiles(cwd, targets));

  }

  const { path, body } = splitLeadingPath(action);

  if (!path) {

    throw new Error("edit needs a path on the tag: <edit swe/file.ts>");

  }

  const report = applyEdit(cwd, path, body);

  return { kind: "result", result: { verb: "edit", ok: report.ok, text: report.text } };

}
