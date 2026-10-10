#!/usr/bin/env bash
# Installs or updates pts on a Debian or Ubuntu server: bash pts/server/setup.sh

set -euo pipefail

cd "$(dirname "$0")/../.."

GO_VERSION=1.27.2

# bwrap and pasta sandbox agents' commands, ip fences their routes, and systemd-run reaches this user's manager over its bus
sudo apt-get update -q
sudo apt-get install -yq curl bubblewrap passt iproute2 unzip dbus-user-session

# commands run in systemd-run --user scopes: this user's manager must run at boot and may hand out CPU and memory limits
sudo loginctl enable-linger "$USER"

if ! grep -qs "Delegate=cpu memory pids" /etc/systemd/system/user@.service.d/pts.conf; then

  sudo mkdir -p /etc/systemd/system/user@.service.d
  printf "[Service]\nDelegate=cpu memory pids\n" | sudo tee /etc/systemd/system/user@.service.d/pts.conf >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl restart "user@$(id -u)"

fi

# Ubuntu 23.10+ denies user namespaces to bwrap, pasta and Chromium's sandbox unless this is off
if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then

  echo "kernel.apparmor_restrict_unprivileged_userns=0" | sudo tee /etc/sysctl.d/60-pts.conf >/dev/null
  sudo sysctl -q --system

fi

# the distro's Go is usually older than go.mod asks for, so the official build goes in ~/.local/go
export PATH="$HOME/.local/go/bin:$HOME/.bun/bin:$PATH"

if ! go version 2>/dev/null | grep -q "go1.27."; then

  case "$(uname -m)" in

    x86_64) ARCH=amd64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) echo "No Go build for $(uname -m)"; exit 1 ;;

  esac

  rm -rf "$HOME/.local/go"
  mkdir -p "$HOME/.local"
  curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" | tar -xz -C "$HOME/.local"

fi

# bun still builds the PWA, and Playwright still installs the Chromium agents' profiles were made with
if ! command -v bun >/dev/null; then

  curl -fsSL https://bun.sh/install | bash

fi

(

  cd pts/web
  bun install
  bunx playwright install --with-deps chromium
  bun run pts:web

)

(cd pts/server && go build -o bin/pts .)

# its example values are placeholders, so pts only starts once they are real
if [ ! -f .env ]; then

  cp .env.example .env
  chmod 600 .env
  echo "Wrote .env from .env.example. Fill in PTS_HOME, PTS_VAPID_SUBJECT and PTS_PROXY, then run this again."
  exit 0

fi

echo "pts is installed. Start it: pts/server/bin/pts serve, from the repository root or pts/server. Give someone a key: pts/server/bin/pts key <name>"
