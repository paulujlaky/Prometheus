package tools

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"boombox/agent/shell"
)

// Entry is one workspace file as the app lists it.
type Entry struct {

	Path string `json:"path"`
	Size int64 `json:"size"`
	Modified int64 `json:"modified"`

}

var unsafeName = regexp.MustCompile(`[^\w.\-() ]+`)

// Resolve is a workspace path the server may read or write, refusing one a planted link would carry outside.
func Resolve(cwd, raw string) (string, string, error) {

	rel, err := RelPath(raw, cwd)

	if err != nil {

		return "", "", err

	}

	if rel == "." {

		return "", "", errors.New("name a file, not the workspace")

	}

	path, err := inside(cwd, rel)

	return rel, path, err

}

// Load reads whole workspace files, one path per entry.
func Load(cwd string, paths []string) ([]shell.File, error) {

	if len(paths) == 0 {

		return nil, errors.New("name at least one workspace file, one per line")

	}

	files := make([]shell.File, 0, len(paths))

	for _, raw := range paths {

		rel, path, err := Resolve(cwd, raw)

		if err != nil {

			return nil, err

		}

		data, err := shell.ReadRegular(path, false)

		if err != nil {

			return nil, fmt.Errorf("%s: %w", rel, err)

		}

		files = append(files, shell.File{Name: filepath.Base(path), Data: []byte(data)})

	}

	return files, nil

}

// List is every file in the workspace, skipping what <ls> skips.
func List(cwd string) []Entry {

	paths := []string{}

	walkFiles(cwd, ".", &paths)

	entries := make([]Entry, 0, len(paths))

	for _, rel := range paths {

		if stat, err := os.Lstat(abs(cwd, rel)); err == nil && stat.Mode().IsRegular() {

			entries = append(entries, Entry{Path: rel, Size: stat.Size(), Modified: stat.ModTime().UnixMilli()})

		}

	}

	return entries

}

// Save puts a file the user sent into uploads/, beside one of the same name rather than over it.
func Save(cwd, name string, data []byte) (string, error) {

	base := strings.TrimLeft(unsafeName.ReplaceAllString(filepath.Base(strings.ReplaceAll(name, `\`, "/")), "_"), ". ")

	if base == "" {

		base = "file"

	}

	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)

	for n := 1; n < 1000; n++ {

		rel := "uploads/" + base

		if n > 1 {

			rel = "uploads/" + stem + "-" + strconv.Itoa(n) + ext

		}

		path, err := inside(cwd, rel)

		if err != nil {

			return "", err

		}

		if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {

			continue

		}

		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {

			return "", err

		}

		return rel, shell.WriteRegular(path, string(data))

	}

	return "", fmt.Errorf("uploads/ already holds too many files named %s", base)

}
