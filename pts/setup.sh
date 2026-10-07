#!/usr/bin/env bash
# Installs or updates pts on a Debian or Ubuntu server: bash pts/setup.sh

set -euo pipefail

cd "$(dirname "$0")/.."

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

if ! command -v bun >/dev/null && [ ! -x "$HOME/.bun/bin/bun" ]; then

  curl -fsSL https://bun.sh/install | bash

fi

export PATH="$HOME/.bun/bin:$PATH"

bun install
bunx playwright install --with-deps chromium
bun run pts:web

# its example values are placeholders, so pts only starts once they are real
if [ ! -f .env ]; then

  cp .env.example .env
  chmod 600 .env
  echo "Wrote .env from .env.example. Fill in PTS_HOME, PTS_VAPID_SUBJECT and PTS_PROXY, then run this again."
  exit 0

fi

echo "pts is installed. Start it: bun run pts:serve. Give someone a key: bun pts/cli.ts key <name>"
