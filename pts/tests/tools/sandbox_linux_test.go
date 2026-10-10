//go:build linux

package tools_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"boombox/agent/protocol"
	"boombox/agent/shell"
	"boombox/agent/tools"
)

func needsSandbox(t *testing.T) {

	t.Helper()

	for _, tool := range []string{"pasta", "bwrap", "systemd-run"} {

		if _, err := exec.LookPath(tool); err != nil {

			t.Skip(tool + " is not installed")

		}

	}

}

func TestCommandsRunSandboxedInTheWorkspace(t *testing.T) {

	needsSandbox(t)

	cwd := t.TempDir()

	t.Setenv("BOODLE_COOKIE", "secret-cookie")

	result := shell.Run(context.Background(), `pwd; echo hi > made.txt; ls /home 2>&1; echo "cookie=$BOODLE_COOKIE"`, cwd, 0, "")

	if result.ExitCode != 0 || !strings.Contains(result.Output, "/work") || !strings.Contains(result.Output, "No such file") || strings.Contains(result.Output, "secret-cookie") {

		t.Fatalf("exit %d:\n%s", result.ExitCode, result.Output)

	}

	if data, _ := os.ReadFile(filepath.Join(cwd, "made.txt")); string(data) != "hi\n" {

		t.Fatalf("made.txt %q", data)

	}

	if slow := shell.Run(context.Background(), "sleep 5", cwd, 300*time.Millisecond, ""); slow.ExitCode != 124 {

		t.Fatalf("timeout exit %d:\n%s", slow.ExitCode, slow.Output)

	}

}

func TestAgentCannotReachTheHostThroughNetworkLinksOrFifos(t *testing.T) {

	needsSandbox(t)

	cwd := t.TempDir()
	hostDir := t.TempDir()
	secret := filepath.Join(hostDir, "secret.txt")
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "host service") }))

	defer host.Close()

	os.WriteFile(secret, []byte("host secret"), 0o644)

	command := fmt.Sprintf("ln -s %s out; ln -s %s dir; mkfifo pipe; curl -sS -m 3 %s/ 2>&1; grep CapEff /proc/self/status; ls /etc/shadow 2>&1", secret, hostDir, host.URL)
	result := shell.Run(context.Background(), command, cwd, 0, "")

	if strings.Contains(result.Output, "host service") || !strings.Contains(result.Output, "CapEff:\t0000000000000000") || !strings.Contains(result.Output, "No such file") {

		t.Fatalf("shell:\n%s", result.Output)

	}

	run := func(verb, path, body string) protocol.Result {

		return tools.Execute(context.Background(), protocol.Action{Verb: protocol.Verb(verb), Path: path, Body: body}, cwd, "")

	}

	for _, action := range [][3]string{{"read", "out", ""}, {"read", "dir/secret.txt", ""}, {"write", "out", "x"}, {"edit", "out", "@@ FIND\nhost\n@@ REPLACE\nx"}, {"write", "dir/new.txt", "x"}} {

		if result := run(action[0], action[1], action[2]); !strings.Contains(result.Text, "outside your workspace") {

			t.Errorf("%v: %s", action, result.Text)

		}

	}

	if result := run("read", "pipe", ""); !strings.Contains(result.Text, "not a regular file") {

		t.Errorf("fifo: %s", result.Text)

	}

	if result := run("grep", "", "host secret"); !strings.HasPrefix(result.Text, "no matches") {

		t.Errorf("grep: %s", result.Text)

	}

	if result := run("ls", "", ""); !strings.Contains(result.Text, "out  link") {

		t.Errorf("ls: %s", result.Text)

	}

	if data, _ := os.ReadFile(secret); string(data) != "host secret" {

		t.Fatal("the host file changed")

	}

	var stat syscall.Stat_t

	if syscall.Stat(cwd, &stat) != nil {

		t.Fatal("workspace is gone")

	}

}
