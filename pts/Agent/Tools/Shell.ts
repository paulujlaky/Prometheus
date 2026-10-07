import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, ftruncateSync, openSync, readFileSync, writeFileSync } from "node:fs";

const TIMEOUT_MS = Number(process.env.PTS_CMD_TIMEOUT_MS ?? 600_000);
const MEMORY_MAX = process.env.PTS_MEMORY_MAX ?? "1G";
const CPU_QUOTA = process.env.PTS_CPU_QUOTA ?? "100%";
const TASKS_MAX = process.env.PTS_TASKS_MAX ?? "512";

const HEAD = 4_000;
const TAIL = 20_000;

// bigger than any file worth reading into the prompt, small enough that a planted one cannot exhaust the server
const MAX_FILE = 20_000_000;

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

// what tools need from /etc: certificates, name and user lookups, Debian's alternatives. The rest can hold the host's secrets
const ETC = ["alternatives", "fonts", "group", "hosts", "ld.so.cache", "localtime", "nsswitch.conf", "os-release", "passwd", "protocols", "services", "ssl"];

// pasta answers DNS sent here from the host's own resolver, which often listens only on the host's loopback
const DNS = "192.0.2.53";

// cloud metadata, private networks and carrier NAT; the namespace's own subnet stays routed, or the gateway would be too
const FENCED = ["10.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16"];

export interface ShellResult {

  output: string;
  exitCode: number;

}

/**
 * systemd-run caps the command's cgroup. pasta gives it a network of its own that reaches the internet but not this machine,
 * and the fence drops routes to metadata and private ranges while it still holds the namespace's capabilities.
 * bwrap then shows it only /usr, a little of /etc and the workspace at /work, as the server's user with no capabilities at all.
 */
function sandboxArgv(command: string, workspace: string, zone?: string): string[] {

  const etc = ETC.flatMap((name) => ["--ro-bind-try", `/etc/${name}`, `/etc/${name}`]);

  // pasta closes every descriptor it did not open, so the resolver config is handed over on fd 3 after it
  const fence = `set -e; PATH=/usr/sbin:/usr/bin:/sbin:/bin; ${FENCED.map((net) => `ip route add blackhole ${net}`).join("; ")}; ip -6 route add blackhole fc00::/7 2>/dev/null || true; exec "$@" 3<<EOF\nnameserver ${DNS}\nEOF`;

  return [

    "systemd-run", "--user", "--scope", "--quiet", "--collect",
    "-p", `MemoryMax=${MEMORY_MAX}`, "-p", "MemorySwapMax=0", "-p", `CPUQuota=${CPU_QUOTA}`, "-p", `TasksMax=${TASKS_MAX}`,
    "--",

    // no port forwarding either way, and no address that maps to the host's loopback
    "pasta", "--config-net", "--quiet", "--no-map-gw", "--dns-forward", DNS, "-t", "none", "-u", "none", "-T", "none", "-U", "none",
    "--",

    "sh", "-c", fence, "sh",

    "bwrap",
    "--ro-bind", "/usr", "/usr",
    ...etc,
    "--ro-bind-data", "3", "/etc/resolv.conf",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/sbin", "/sbin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--bind", workspace, "/work",
    "--chdir", "/work",
    "--unshare-all", "--share-net", "--unshare-user", "--disable-userns",
    "--cap-drop", "ALL", "--uid", String(process.getuid?.() ?? 1000), "--gid", String(process.getgid?.() ?? 1000),
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

const lanes = new Map<string, Promise<unknown>>();

/**
 * One thing at a time per workspace. While the server reads or writes an agent's files none of its commands run,
 * so nothing can swap a checked path for a link before the server uses it. A finished command leaves nothing behind:
 * its pid namespace dies with it.
 */
export function inLane<T>(workspace: string, work: () => T | Promise<T>): Promise<T> {

  const next = (lanes.get(workspace) ?? Promise.resolve()).then(work);

  lanes.set(workspace, next.catch(() => {}));

  return next;

}

/** An agent's file, only if it is a plain one: a FIFO would block the whole server, a huge file would exhaust it. */
function openRegular(path: string, flags: number): number {

  const fd = openSync(path, flags | (constants.O_NONBLOCK ?? 0));
  const stat = fstatSync(fd);

  if (!stat.isFile() || stat.size > MAX_FILE) {

    closeSync(fd);
    throw new Error(stat.isFile() ? "too big to read whole; use <run> with sed -n to take part of it" : "not a regular file");

  }

  return fd;

}

/** `follow: false` refuses a link outright, for a path the agent's shell could swap at any moment. */
export function readRegular(path: string, follow = true): string {

  const fd = openRegular(path, constants.O_RDONLY | (follow ? 0 : NOFOLLOW));

  try {

    return readFileSync(fd, "utf8");

  } finally {

    closeSync(fd);

  }

}

/** Never through a link, which the agent's shell could point at any file the server can write. */
export function writeRegular(path: string, text: string) {

  const fd = openRegular(path, constants.O_WRONLY | constants.O_CREAT | NOFOLLOW);

  try {

    ftruncateSync(fd);
    writeFileSync(fd, text);

  } finally {

    closeSync(fd);

  }

}

/** `zone` is the user's time zone; taken as an argument so this module never opens the store. */
export function runShell(command: string, workspace: string, signal?: AbortSignal, timeoutMs = TIMEOUT_MS, zone?: string): Promise<ShellResult> {

  if (process.platform !== "linux") {

    return Promise.resolve({ output: "Commands only run on Linux, where they can be sandboxed. Start pts under WSL.", exitCode: -1 });

  }

  if (!Bun.which("pasta")) {

    return Promise.resolve({ output: "Commands need pasta, which keeps them off this machine's own network. Install it: sudo apt install passt", exitCode: -1 });

  }

  return inLane(workspace, () => new Promise<ShellResult>((resolve) => {

    // a stop that came while this waited for the workspace
    if (signal?.aborted) {

      resolve({ output: "stopped", exitCode: 124 });
      return;

    }

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

  }));

}
