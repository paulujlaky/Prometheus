import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";

const TIMEOUT_MS = Number(process.env.PTS_CMD_TIMEOUT_MS ?? 600_000);
const MEMORY_MAX = process.env.PTS_MEMORY_MAX ?? "1G";
const CPU_QUOTA = process.env.PTS_CPU_QUOTA ?? "100%";
const TASKS_MAX = process.env.PTS_TASKS_MAX ?? "512";

const HEAD = 4_000;
const TAIL = 20_000;

export interface ShellResult {

  output: string;
  exitCode: number;

}

/** systemd-run caps the command's cgroup; bwrap shows it only /usr, /etc and the workspace, mounted at /work. */
function sandboxArgv(command: string, workspace: string, zone?: string): string[] {

  const binds = ["--ro-bind", "/usr", "/usr", "--ro-bind", "/etc", "/etc"];

  // resolv.conf is usually a symlink (systemd-resolved, WSL), and its target is not under /etc
  const resolv = existsSync("/etc/resolv.conf") ? realpathSync("/etc/resolv.conf") : "";

  if (resolv && resolv !== "/etc/resolv.conf") {

    binds.push("--ro-bind", resolv, resolv);

  }

  return [

    "systemd-run", "--user", "--scope", "--quiet", "--collect",
    "-p", `MemoryMax=${MEMORY_MAX}`, "-p", "MemorySwapMax=0", "-p", `CPUQuota=${CPU_QUOTA}`, "-p", `TasksMax=${TASKS_MAX}`,
    "--",

    "bwrap",
    ...binds,
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/sbin", "/sbin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--bind", workspace, "/work",
    "--chdir", "/work",
    "--unshare-all", "--share-net",
    "--die-with-parent", "--new-session",
    "--clearenv",
    "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin",
    "--setenv", "HOME", "/work",
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "TERM", "dumb",

    // date in the sandbox should agree with the clock schedules run on
    ...(zone ? ["--setenv", "TZ", zone] : []),

    "bash", "-c", command,

  ];

}

/** `zone` is the user's time zone; taken as an argument so this module never opens the store. */
export function runShell(command: string, workspace: string, signal?: AbortSignal, timeoutMs = TIMEOUT_MS, zone?: string): Promise<ShellResult> {

  if (process.platform !== "linux") {

    return Promise.resolve({ output: "Commands only run on Linux, where they can be sandboxed. Start pts under WSL.", exitCode: -1 });

  }

  return new Promise((resolve) => {

    const [bin, ...argv] = sandboxArgv(command, workspace, zone);

    // detached makes the sandbox a process-group leader; killing it takes bwrap, and --die-with-parent takes the rest
    const child = spawn(bin, argv, { detached: true, stdio: ["ignore", "pipe", "pipe"] });

    let head = "";
    let tail = "";
    let total = 0;
    let killedFor = "";
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

    const kill = (reason: string) => {

      killedFor = reason;

      try {

        process.kill(-child.pid!, "SIGKILL");

      } catch {

        child.kill("SIGKILL");

      }

    };

    const onAbort = () => kill("stopped");

    const timer = setTimeout(() => kill(`timed out after ${Math.round(timeoutMs / 1000)}s`), timeoutMs);

    const done = (exitCode: number, extra = "") => {

      if (settled) {

        return;

      }

      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);

      const gap = total > HEAD + TAIL ? `\n\n... ${total - HEAD - TAIL} characters cut ...\n\n` : "";

      resolve({ output: `${head}${gap}${tail}${killedFor ? `\n\n${killedFor}` : ""}${extra}`.trim(), exitCode: killedFor ? 124 : exitCode });

    };

    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", take);
    child.stderr.on("data", take);

    child.on("error", (err) => done(-1, `\n\nfailed to start the sandbox: ${err.message}`));

    // "exit", not "close": a backgrounded grandchild can hold the pipes open forever
    child.on("exit", (code) => setTimeout(() => done(code ?? 1), 50));

  });

}
