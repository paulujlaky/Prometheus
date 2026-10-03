import { spawn } from "node:child_process";

const TIMEOUT_MS = Number(process.env.PTS_CMD_TIMEOUT_MS ?? 600_000);
const HEAD = 4_000;
const TAIL = 20_000;

// the agent's commands must never see the server's credentials
const HIDDEN_ENV = ["BOODLE_COOKIE", "PTS_TOKEN"];

export interface ShellResult {

  output: string;
  exitCode: number;

}

function shellEnv(): NodeJS.ProcessEnv {

  const env = { ...process.env };

  for (const key of HIDDEN_ENV) {

    delete env[key];

  }

  return env;

}

// ponytail: unsandboxed; phase 2 wraps this in bwrap + systemd-run
export function runShell(command: string, cwd: string, timeoutMs = TIMEOUT_MS): Promise<ShellResult> {

  return new Promise((resolve) => {

    // detached makes bash a process-group leader, so a timeout kills everything it started
    const child = spawn("bash", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: shellEnv() });

    let head = "";
    let tail = "";
    let total = 0;
    let timedOut = false;
    let settled = false;

    // keep the head and a rolling tail: failures are explained at the end, so a plain cap loses what matters
    const take = (chunk: Buffer) => {

      let text = chunk.toString("utf8");

      total += text.length;

      if (head.length < HEAD) {

        const room = HEAD - head.length;

        head += text.slice(0, room);
        text = text.slice(room);

      }

      tail = (tail + text).slice(-TAIL);

    };

    const done = (exitCode: number, extra = "") => {

      if (settled) {

        return;

      }

      settled = true;
      clearTimeout(timer);

      const gap = total > HEAD + TAIL ? `\n\n... ${total - HEAD - TAIL} characters cut ...\n\n` : "";
      const note = timedOut ? `\n\ntimed out after ${Math.round(timeoutMs / 1000)}s` : "";

      resolve({ output: `${head}${gap}${tail}${note}${extra}`.trim(), exitCode: timedOut ? 124 : exitCode });

    };

    const timer = setTimeout(() => {

      timedOut = true;

      try {

        process.kill(-child.pid!, "SIGKILL");

      } catch {

        child.kill("SIGKILL");

      }

    }, timeoutMs);

    child.stdout.on("data", take);
    child.stderr.on("data", take);

    child.on("error", (err) => done(-1, `\n\nfailed to start bash: ${err.message}`));

    // "exit", not "close": a backgrounded grandchild can hold the pipes open forever
    child.on("exit", (code) => setTimeout(() => done(code ?? 1), 50));

  });

}
