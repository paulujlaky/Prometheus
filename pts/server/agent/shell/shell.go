package shell

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"boombox/config"
)

const (
	head = 4_000
	tail = 20_000
)

var (
	timeout = config.Millis("PTS_CMD_TIMEOUT_MS", 600_000*time.Millisecond)
	memoryMax = config.String("PTS_MEMORY_MAX", "1G")
	cpuQuota = config.String("PTS_CPU_QUOTA", "100%")
	tasksMax = config.String("PTS_TASKS_MAX", "512")
)

// what tools need from /etc: certificates, name and user lookups, Debian's alternatives; the rest can hold the host's secrets
var etc = []string{"alternatives", "fonts", "group", "hosts", "ld.so.cache", "localtime", "nsswitch.conf", "os-release", "passwd", "protocols", "services", "ssl"}

// pasta answers DNS sent here from the host's own resolver, which often listens only on the host's loopback
const dns = "192.0.2.53"

// cloud metadata, private networks and carrier NAT; the namespace's own subnet stays routed, or the gateway would be too
var fenced = []string{"10.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16"}

type Result struct {

	Output string
	ExitCode int

}

// DefaultTimeout is how long one agent command may run, from PTS_CMD_TIMEOUT_MS.
func DefaultTimeout() time.Duration { return timeout }

// sandboxArgv caps the cgroup with systemd-run, gives pasta's own network fenced off from this machine, and lets bwrap show only /usr, a little /etc and the workspace.
func sandboxArgv(command, workspace, zone string) []string {

	routes := make([]string, 0, len(fenced))

	for _, network := range fenced {

		routes = append(routes, "ip route add blackhole "+network)

	}

	// pasta closes every descriptor it did not open, so the resolver config is handed over on fd 3 after it
	fence := "set -e; PATH=/usr/sbin:/usr/bin:/sbin:/bin; " + strings.Join(routes, "; ") + "; ip -6 route add blackhole fc00::/7 2>/dev/null || true; exec \"$@\" 3<<EOF\nnameserver " + dns + "\nEOF"

	argv := []string{

		"systemd-run", "--user", "--scope", "--quiet", "--collect",
		"-p", "MemoryMax=" + memoryMax, "-p", "MemorySwapMax=0", "-p", "CPUQuota=" + cpuQuota, "-p", "TasksMax=" + tasksMax,
		"--",

		// no port forwarding either way, and no address that maps to the host's loopback
		"pasta", "--config-net", "--quiet", "--no-map-gw", "--dns-forward", dns, "-t", "none", "-u", "none", "-T", "none", "-U", "none",
		"--",

		"sh", "-c", fence, "sh",

		"bwrap",
		"--ro-bind", "/usr", "/usr",

	}

	for _, name := range etc {

		argv = append(argv, "--ro-bind-try", "/etc/"+name, "/etc/"+name)

	}

	argv = append(argv,

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
		"--cap-drop", "ALL", "--uid", strconv.Itoa(os.Getuid()), "--gid", strconv.Itoa(os.Getgid()),
		"--die-with-parent", "--new-session",
		"--clearenv",
		"--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin",
		"--setenv", "HOME", "/work",
		"--setenv", "LANG", "C.UTF-8",
		"--setenv", "TERM", "dumb",

	)

	// date in the sandbox should agree with the clock schedules run on
	if zone != "" {

		argv = append(argv, "--setenv", "TZ", zone)

	}

	return append(argv, "bash", "-c", command)

}

// capture keeps the head and a rolling tail: failures are explained at the end, so a plain cap loses what matters.
type capture struct {

	mu sync.Mutex

	head []byte
	tail []byte
	total int

}

func (c *capture) Write(chunk []byte) (int, error) {

	c.mu.Lock()
	defer c.mu.Unlock()

	n := len(chunk)
	c.total += n

	if room := head - len(c.head); room > 0 {

		take := min(room, len(chunk))
		c.head = append(c.head, chunk[:take]...)
		chunk = chunk[take:]

	}

	c.tail = append(c.tail, chunk...)

	if len(c.tail) > tail {

		c.tail = append([]byte(nil), c.tail[len(c.tail)-tail:]...)

	}

	return n, nil

}

func (c *capture) String() string {

	c.mu.Lock()
	defer c.mu.Unlock()

	gap := ""

	if c.total > head+tail {

		gap = fmt.Sprintf("\n\n... %d characters cut ...\n\n", c.total-head-tail)

	}

	return strings.ToValidUTF8(string(c.head)+gap+string(c.tail), "")

}

// Run runs command in the workspace's sandbox; zone is the user's time zone, passed in so this package never opens the store.
func Run(ctx context.Context, command, workspace string, limit time.Duration, zone string) Result {

	if runtime.GOOS != "linux" {

		return Result{Output: "Commands only run on Linux, where they can be sandboxed. Start pts under WSL.", ExitCode: -1}

	}

	if _, err := exec.LookPath("pasta"); err != nil {

		return Result{Output: "Commands need pasta, which keeps them off this machine's own network. Install it: sudo apt install passt", ExitCode: -1}

	}

	if limit <= 0 {

		limit = timeout

	}

	result, err := InLane(context.Background(), workspace, func() (Result, error) {

		// a stop that came while this waited for the workspace
		if ctx.Err() != nil {

			return Result{Output: "stopped", ExitCode: 124}, nil

		}

		return runSandboxed(ctx, command, workspace, limit, zone), nil

	})

	if err != nil {

		return Result{Output: err.Error(), ExitCode: -1}

	}

	return result

}

func runSandboxed(ctx context.Context, command, workspace string, limit time.Duration, zone string) Result {

	argv := sandboxArgv(command, workspace, zone)
	cmd := exec.Command(argv[0], argv[1:]...)
	output := &capture{}

	reader, writer, err := os.Pipe()

	if err != nil {

		return Result{Output: "failed to start the sandbox: " + err.Error(), ExitCode: -1}

	}

	// a plain file as stdout means Wait returns at exit, even while a backgrounded grandchild holds the pipe open
	cmd.Stdout = writer
	cmd.Stderr = writer
	detach(cmd)

	if err := cmd.Start(); err != nil {

		reader.Close()
		writer.Close()

		return Result{Output: "failed to start the sandbox: " + err.Error(), ExitCode: -1}

	}

	writer.Close()

	copied := make(chan struct{})

	go func() {

		defer close(copied)

		buffer := make([]byte, 32*1024)

		for {

			n, err := reader.Read(buffer)

			output.Write(buffer[:n])

			if err != nil {

				return

			}

		}

	}()

	var killedMu sync.Mutex

	killedFor := ""

	kill := func(reason string) {

		killedMu.Lock()

		if killedFor == "" {

			killedFor = reason

		}

		killedMu.Unlock()
		killGroup(cmd)

	}

	timer := time.AfterFunc(limit, func() { kill(fmt.Sprintf("timed out after %ds", int(limit.Round(time.Second)/time.Second))) })
	stop := context.AfterFunc(ctx, func() { kill("stopped") })

	cmd.Wait()
	timer.Stop()
	stop()

	select {

	case <-copied:

	case <-time.After(50 * time.Millisecond):

	}

	reader.Close()

	code := cmd.ProcessState.ExitCode()

	if code < 0 {

		code = 1

	}

	killedMu.Lock()
	reason := killedFor
	killedMu.Unlock()

	text := output.String()

	if reason != "" {

		text += "\n\n" + reason
		code = 124

	}

	return Result{Output: strings.TrimSpace(text), ExitCode: code}

}
