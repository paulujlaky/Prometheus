// Package shell runs agents' commands in a sandbox and touches their files without following links they plant.
package shell

import (
	"context"
	"errors"
	"io"
	"os"
	"sync"
)

// bigger than any file worth reading into the prompt, small enough that a planted one cannot exhaust the server
const maxFile = 20_000_000

var (
	lanesMu sync.Mutex
	lanes = map[string]*sync.Mutex{}
)

func laneOf(workspace string) *sync.Mutex {

	lanesMu.Lock()
	defer lanesMu.Unlock()

	lane := lanes[workspace]

	if lane == nil {

		lane = &sync.Mutex{}
		lanes[workspace] = lane

	}

	return lane

}

// InLane runs work while nothing else touches the workspace, so no command can swap a checked path for a link before it is used.
func InLane[T any](ctx context.Context, workspace string, work func() (T, error)) (T, error) {

	lane := laneOf(workspace)

	lane.Lock()
	defer lane.Unlock()

	if err := ctx.Err(); err != nil {

		var zero T

		return zero, err

	}

	return work()

}

// openRegular refuses anything but a plain file: a FIFO would block the server, a huge file would exhaust it.
func openRegular(path string, flags int) (*os.File, error) {

	file, err := os.OpenFile(path, flags|nonBlock, 0o666)

	if err != nil {

		return nil, err

	}

	stat, err := file.Stat()

	if err != nil {

		file.Close()

		return nil, err

	}

	if !stat.Mode().IsRegular() {

		file.Close()

		return nil, errors.New("not a regular file")

	}

	if stat.Size() > maxFile {

		file.Close()

		return nil, errors.New("too big to read whole; use <run> with sed -n to take part of it")

	}

	return file, nil

}

// ReadRegular reads a plain file; follow false refuses a link outright, for a path the agent's shell could swap.
func ReadRegular(path string, follow bool) (string, error) {

	flags := os.O_RDONLY

	if !follow {

		flags |= noFollow

	}

	file, err := openRegular(path, flags)

	if err != nil {

		return "", err

	}

	defer file.Close()

	data, err := io.ReadAll(file)

	return string(data), err

}

// WriteRegular never writes through a link, which the agent's shell could point at any file the server can write.
func WriteRegular(path, text string) error {

	file, err := openRegular(path, os.O_WRONLY|os.O_CREATE|noFollow)

	if err != nil {

		return err

	}

	defer file.Close()

	if err := file.Truncate(0); err != nil {

		return err

	}

	_, err = file.WriteString(text)

	return err

}
