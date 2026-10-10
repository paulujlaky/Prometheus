// Package config loads .env before any other pts package reads the environment.
package config

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/joho/godotenv"
)

func init() {

	// .env never overrides the real environment, so a variable the service manager sets wins
	if path := os.Getenv("PTS_ENV_FILE"); path != "" {

		godotenv.Load(path)

		return

	}

	godotenv.Load(".env")

	// run from server, the settings are still the repository's, one folder up beside web
	if _, err := os.Stat(filepath.Join("..", "web", "vite.config.ts")); err == nil {

		godotenv.Load(filepath.Join("..", ".env"))

	}

}

// String is the variable's value, or fallback when it is unset.
func String(name, fallback string) string {

	if value, ok := os.LookupEnv(name); ok {

		return value

	}

	return fallback

}

func Int(name string, fallback int) int {

	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name)))

	if err != nil {

		return fallback

	}

	return value

}

// Millis reads a duration given in milliseconds, as every PTS_*_MS variable is.
func Millis(name string, fallback time.Duration) time.Duration {

	value, err := strconv.ParseInt(strings.TrimSpace(os.Getenv(name)), 10, 64)

	if err != nil {

		return fallback

	}

	return time.Duration(value) * time.Millisecond

}

// Home is where the database, workspaces and browser profiles live.
func Home() string {

	if home := os.Getenv("PTS_HOME"); home != "" {

		return home

	}

	dir, err := os.UserHomeDir()

	if err != nil {

		dir = "."

	}

	return filepath.Join(dir, ".pts")

}

// Proxy is the one HTTP proxy every agent's browser goes through; empty for none.
func Proxy() string {

	return strings.TrimSpace(os.Getenv("PTS_PROXY"))

}

// SystemZone is this machine's IANA zone name, the clock users get until they pick one.
func SystemZone() string {

	if zone := os.Getenv("TZ"); zone != "" {

		if _, err := time.LoadLocation(strings.TrimPrefix(zone, ":")); err == nil {

			return strings.TrimPrefix(zone, ":")

		}

	}

	if link, err := os.Readlink("/etc/localtime"); err == nil {

		if _, name, found := strings.Cut(link, "zoneinfo/"); found {

			return name

		}

	}

	if data, err := os.ReadFile("/etc/timezone"); err == nil {

		if zone := strings.TrimSpace(string(data)); zone != "" {

			return zone

		}

	}

	return "UTC"

}
