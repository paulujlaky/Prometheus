//go:build !windows

package shell

import (
	"os/exec"
	"syscall"
)

const (
	noFollow = syscall.O_NOFOLLOW
	nonBlock = syscall.O_NONBLOCK
)

// detach makes the sandbox a process-group leader, so killing the group takes bwrap and --die-with-parent takes the rest.
func detach(cmd *exec.Cmd) {

	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

}

func killGroup(cmd *exec.Cmd) {

	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {

		cmd.Process.Kill()

	}

}
