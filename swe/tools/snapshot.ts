import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BBX_DIR, normalizeProjectPath } from "../settings";

/** The worktree as it stood before one run touched it. */
export interface UndoMark {

  commit: string;
  project: string;

  summary: string;
  at: number;

  undone?: boolean;

}

export interface RestoreReport {

  ok: boolean;

  files: string[];
  text: string;

}

const SNAPSHOT_ROOT = join(BBX_DIR, "snapshots");
const MARKS_PATH = join(BBX_DIR, "rollback.json");

const MARKS_PER_CHAT = 50;

const BRANCH = "refs/heads/snapshots";

// mirrors the SKIP set in fs.ts, because a project with no .gitignore of its own
// would otherwise drag node_modules into the store
const EXCLUDES = [
  "/.git/",
  "node_modules/",
  "dist/",
  "out/",
  "build/",
  "coverage/",
  ".next/",
  ".cache/",
  ".venv/",
  "venv/",
  "target/",
  "vendor/",
  "__pycache__/",
  "*.min.js",
  "*.min.css",
  "*.map",
  "nul",
].join("\n");

let probed = false;
let present = false;

/** Rollback needs a git binary; without one the UI hides the control instead of failing late. */
export function snapshotsAvailable(): boolean {

  if (probed) {

    return present;

  }

  probed = true;

  try {

    execFileSync("git", ["--version"], { stdio: "ignore" });
    present = true;

  } catch {

    present = false;

  }

  return present;

}

function git(gitDir: string, worktree: string, args: string[]): string {

  const env = { ...process.env };

  // an inherited GIT_* from the launching shell would silently retarget the store at the user's repo
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;

  // identity through the environment, so the store never depends on the user having configured one
  env.GIT_AUTHOR_NAME = "bbx";
  env.GIT_AUTHOR_EMAIL = "bbx@localhost";
  env.GIT_COMMITTER_NAME = "bbx";
  env.GIT_COMMITTER_EMAIL = "bbx@localhost";

  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";

  const out = execFileSync("git", ["--git-dir", gitDir, "--work-tree", worktree, ...args], {

    cwd: worktree,
    env,

    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],

  });

  return typeof out === "string" ? out : String(out);

}

function writeExcludes(gitDir: string) {

  const dir = join(gitDir, "info");

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "exclude"), `${EXCLUDES}\n`, "utf8");

}

function storeFor(project: string): string | null {

  if (!snapshotsAvailable()) {

    return null;

  }

  const key = createHash("sha1").update(project.toLowerCase()).digest("hex").slice(0, 16);
  const gitDir = join(SNAPSHOT_ROOT, key);

  if (existsSync(join(gitDir, "HEAD"))) {

    writeExcludes(gitDir);

    return gitDir;

  }

  mkdirSync(gitDir, { recursive: true });

  execFileSync("git", ["init", "--bare", "--quiet", gitDir], { stdio: "ignore" });

  // bare on disk keeps it out of the project, but it commits a real worktree, so git must not refuse the checkout
  git(gitDir, project, ["config", "core.bare", "false"]);
  git(gitDir, project, ["config", "core.autocrlf", "false"]);
  git(gitDir, project, ["config", "core.safecrlf", "false"]);

  // a global hooksPath would otherwise fire the user's hooks against their repo on our behalf
  git(gitDir, project, ["config", "core.hooksPath", join(gitDir, "hooks")]);

  writeExcludes(gitDir);

  return gitDir;

}

function headOf(gitDir: string, project: string): string | null {

  try {

    return git(gitDir, project, ["rev-parse", "--verify", "--quiet", BRANCH]).trim() || null;

  } catch {

    return null;

  }

}

/** Commit the current worktree to the shadow store. Returns the commit, or null when unavailable. */
export function captureSnapshot(cwd: string, label = "snapshot"): string | null {

  const project = normalizeProjectPath(cwd);

  if (!project || !existsSync(project)) {

    return null;

  }

  try {

    const gitDir = storeFor(project);

    if (!gitDir) {

      return null;

    }

    git(gitDir, project, ["add", "--all", "."]);

    const tree = git(gitDir, project, ["write-tree"]).trim();
    const parent = headOf(gitDir, project);

    const args = ["commit-tree", tree, "-m", label];

    if (parent) {

      args.push("-p", parent);

    }

    const commit = git(gitDir, project, args).trim();

    git(gitDir, project, ["update-ref", BRANCH, commit]);

    return commit;

  } catch {

    return null;

  }

}

/** Put the worktree back the way the snapshot found it. */
export function restoreSnapshot(cwd: string, commit: string): RestoreReport {

  const project = normalizeProjectPath(cwd);

  if (!project || !existsSync(project)) {

    return { ok: false, files: [], text: "That project folder is gone." };

  }

  const gitDir = storeFor(project);

  if (!gitDir) {

    return { ok: false, files: [], text: "Git is not available, so there is no snapshot to roll back to." };

  }

  try {

    git(gitDir, project, ["cat-file", "-e", `${commit}^{commit}`]);

  } catch {

    return { ok: false, files: [], text: "That snapshot is no longer in the store." };

  }

  // the state we are leaving becomes a commit of its own, so an undo is itself undoable
  const safety = captureSnapshot(project, "before undo");

  try {

    const named = git(gitDir, project, ["diff", "--name-only", commit]).trim();
    const files = named ? named.split("\n").map((line) => line.trim()).filter(Boolean) : [];

    // --reset restores what changed, brings back what was deleted, and drops what the run created
    git(gitDir, project, ["read-tree", "-u", "--reset", commit]);

    const tree = git(gitDir, project, ["write-tree"]).trim();
    const args = ["commit-tree", tree, "-m", "undo"];

    if (safety) {

      args.push("-p", safety);

    }

    git(gitDir, project, ["update-ref", BRANCH, git(gitDir, project, args).trim()]);

    return {

      ok: true,
      files,

      text: files.length ? `restored ${files.length} ${files.length === 1 ? "file" : "files"}` : "nothing to restore — the tree already matches",

    };

  } catch (err) {

    return { ok: false, files: [], text: err instanceof Error ? err.message : String(err) };

  }

}

interface MarkFile {

  chats?: Record<string, UndoMark[]>;

}

function loadFile(): MarkFile {

  try {

    if (!existsSync(MARKS_PATH)) {

      return {};

    }

    const raw = JSON.parse(readFileSync(MARKS_PATH, "utf8")) as MarkFile;

    return raw && typeof raw === "object" ? raw : {};

  } catch {

    return {};

  }

}

function saveFile(file: MarkFile) {

  mkdirSync(BBX_DIR, { recursive: true });
  writeFileSync(MARKS_PATH, `${JSON.stringify(file, null, 2)}\n`, "utf8");

}

/** Marks for one chat, oldest first — the order the verdict rows appear in. */
export function loadMarks(chatId: string): UndoMark[] {

  if (!chatId) {

    return [];

  }

  const rows = loadFile().chats?.[chatId];

  return Array.isArray(rows) ? rows.filter((row) => Boolean(row && typeof row.commit === "string" && row.commit)) : [];

}

export function recordMark(chatId: string, mark: UndoMark): void {

  if (!chatId || !mark.commit) {

    return;

  }

  const file = loadFile();
  const chats = { ...(file.chats ?? {}) };

  chats[chatId] = [...loadMarks(chatId), mark].slice(-MARKS_PER_CHAT);

  saveFile({ ...file, chats });

}

export function markUndone(chatId: string, commit: string, undone = true): void {

  const marks = loadMarks(chatId);
  const hit = marks.find((mark) => mark.commit === commit);

  if (!hit) {

    return;

  }

  hit.undone = undone;

  const file = loadFile();

  saveFile({ ...file, chats: { ...(file.chats ?? {}), [chatId]: marks } });

}

export function forgetMarks(chatId: string): void {

  const file = loadFile();
  const chats = { ...(file.chats ?? {}) };

  if (!Object.prototype.hasOwnProperty.call(chats, chatId)) {

    return;

  }

  delete chats[chatId];

  saveFile({ ...file, chats });

}
