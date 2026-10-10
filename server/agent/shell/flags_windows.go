//go:build windows

package shell

import "os/exec"

const (
	noFollow = 0
	nonBlock = 0
)

func detach(cmd *exec.Cmd) {}

func killGroup(cmd *exec.Cmd) {

	cmd.Process.Kill()

}
