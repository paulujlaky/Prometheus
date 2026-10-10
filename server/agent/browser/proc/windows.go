//go:build windows

package proc

import (
	"os"
	"os/exec"
)

func Detach(cmd *exec.Cmd) {}

func KillGroup(pid int) {

	if process, err := os.FindProcess(pid); err == nil {

		process.Kill()

	}

}

func Exited(pid int) bool {

	_, err := os.FindProcess(pid)

	return err != nil

}

func Renice(pid, level int) {}
