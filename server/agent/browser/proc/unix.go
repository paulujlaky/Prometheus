//go:build !windows

package proc

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// Detach makes Chromium a process-group leader, so killing the group takes its renderers with it.
func Detach(cmd *exec.Cmd) {

	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

}

func KillGroup(pid int) {

	if pid > 1 {

		syscall.Kill(-pid, syscall.SIGKILL)

	}

}

// Exited is true for a pid that is gone, or a zombie waiting to be reaped.
func Exited(pid int) bool {

	stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")

	return err != nil || strings.Contains(string(stat), ") Z ")

}

// Renice drops a background Chromium and its renderers, which share its process group.
func Renice(pid, level int) {

	cmd := exec.Command("renice", "-n", strconv.Itoa(level), "-g", strconv.Itoa(pid))

	if cmd.Start() == nil {

		go cmd.Wait()

	}

}
