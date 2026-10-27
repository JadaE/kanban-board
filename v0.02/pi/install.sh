#!/usr/bin/env bash
# Kanban Board v0.02: Raspberry Pi installer (safe to run again; it only fixes what's missing or outdated).
# Targets Raspberry Pi OS Bookworm (and Trixie) with desktop, 32-bit (armv7l) or 64-bit (aarch64), incl. Pi 3 / 1 GB.
#
#   sudo ./pi/install.sh
#
# Optional settings (put them before the command, e.g. "sudo KANBAN_X11=1 ./pi/install.sh"):
#   KIOSK_USER=pi        desktop user that shows the TV board (default: the user who ran sudo)
#   PORT=8080            port for the board server
#   AUTOLOGIN=0          don't switch the Pi to "boot to desktop, logged in" (the kiosk needs it; default 1)
#   KANBAN_X11=1         switch the desktop to X11/Openbox (lighter on a Pi 3; default: leave the session alone)
#   KANBAN_HOSTNAME=kanban  rename the Pi so phones can use http://kanban.local:8080 (default: keep the name)
#   NO_KIOSK=1           install only the server (no TV autostart)
set -euo pipefail

APP=/opt/kanban
DATA="$APP/data"
ENV_FILE=/etc/kanban.env
UNIT=/etc/systemd/system/kanban.service
MARK='# kanban-kiosk'
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8080}"

say()  { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Please run with sudo:  sudo $0"
[ -f "$SRC/server.js" ] && [ -f "$SRC/public/index.html" ] || die "Run this from the copied kanban folder (couldn't find server.js next to pi/)."

# ---------- who sees the TV ----------
KIOSK_USER="${KIOSK_USER:-${SUDO_USER:-}}"
if [ -z "$KIOSK_USER" ] || [ "$KIOSK_USER" = root ]; then KIOSK_USER="$(getent passwd 1000 | cut -d: -f1 || true)"; fi
[ -n "$KIOSK_USER" ] || die "Couldn't work out the desktop user. Run again as: sudo KIOSK_USER=<name> $0"
KIOSK_HOME="$(getent passwd "$KIOSK_USER" | cut -d: -f6)"
[ -d "$KIOSK_HOME" ] || die "Home folder for $KIOSK_USER not found."
ARCH="$(uname -m)"
say "Installing Kanban Board for desktop user '$KIOSK_USER' on $ARCH"

export DEBIAN_FRONTEND=noninteractive
APT_UPDATED=0
apt_install() {
  local missing=() p
  for p in "$@"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
  [ "${#missing[@]}" -eq 0 ] && return 0
  if [ "$APT_UPDATED" -eq 0 ]; then apt-get update -qq; APT_UPDATED=1; fi
  apt-get install -y -qq --no-install-recommends "${missing[@]}"
}
node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# ---------- Node.js 18+ ----------
apt_install ca-certificates curl
if [ "$(node_major)" -lt 18 ]; then
  say "Installing Node.js (distro package first: Bookworm ships Node 18, Trixie Node 20)"
  apt_install nodejs || true
fi
if [ "$(node_major)" -lt 18 ]; then
  case "$ARCH" in
    aarch64|arm64|x86_64)
      say "Distro Node too old; using NodeSource Node 20"
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
      apt-get install -y -qq nodejs ;;
    armv7l)
      say "Distro Node too old; installing official Node 20 armv7l build into /usr/local"
      base=https://nodejs.org/dist/latest-v20.x
      file="$(curl -fsSL "$base/SHASUMS256.txt" | awk '/linux-armv7l\.tar\.xz$/{print $2; exit}')"
      [ -n "$file" ] || die "Couldn't find a Node armv7l download."
      tmp="$(mktemp -d)"
      curl -fsSL "$base/$file" -o "$tmp/$file"
      (cd "$tmp" && curl -fsSL "$base/SHASUMS256.txt" | grep " $file\$" | sha256sum -c -)
      tar -xJf "$tmp/$file" -C /usr/local --strip-components=1 --exclude='*.md' --exclude=LICENSE
      rm -rf "$tmp" ;;
    *) die "No Node 18+ available for $ARCH (Pi Zero/1 are armv6 and aren't supported)." ;;
  esac
fi
NODE_BIN="$(command -v node)"
say "Node $(node -v) at $NODE_BIN"

# ---------- app files ----------
id kanban >/dev/null 2>&1 || useradd --system --home-dir "$APP" --no-create-home --shell /usr/sbin/nologin kanban
install -d -m 755 "$APP" "$APP/public" "$APP/pi"
install -m 644 "$SRC/server.js" "$APP/server.js"
cp -r "$SRC/public/." "$APP/public/"
install -m 755 "$SRC/pi/kiosk.sh" "$SRC/pi/watchdog.sh" "$SRC/pi/uninstall.sh" "$APP/pi/"
[ -f "$SRC/README.md" ] && install -m 644 "$SRC/README.md" "$APP/README.md"
install -d -m 750 -o kanban -g kanban "$DATA"   # board.json + backups live here; never overwritten by reinstalls
chown -R root:root "$APP/public" "$APP/pi" "$APP/server.js"

if [ ! -f "$ENV_FILE" ]; then
  say "Writing settings to $ENV_FILE"
  cat > "$ENV_FILE" <<CONF
# Kanban Board settings. After changing: sudo systemctl restart kanban
PORT=$PORT
# 0.0.0.0 = reachable from phones on the home network (Ethernet or Wi-Fi), not just this Pi
HOST=0.0.0.0
DATA_DIR=$DATA
BACKUPS=30
BACKUP_MIN_INTERVAL_S=300
TOMBSTONE_DAYS=60
# What the TV opens (add &theme=dark for dark mode, &reload=6 = clean reload every N hours)
KIOSK_URL=http://localhost:$PORT/?tv=1
# --- Optional overnight screen-off (placeholder, not active in v0.02) ---
# SCREEN_OFF_AT=23:00
# SCREEN_ON_AT=06:30
CONF
fi

# ---------- server service ----------
say "Setting up kanban.service (starts at boot, restarts itself if it stops)"
cat > "$UNIT" <<UNITEOF
[Unit]
Description=Kanban Board (Kanban server)
After=network.target
Wants=network-online.target

[Service]
User=kanban
Group=kanban
EnvironmentFile=-$ENV_FILE
WorkingDirectory=$APP
# Small-memory V8 settings: keeps the server around 30-50 MB RSS (no JIT needed for a tiny JSON API)
ExecStart=$NODE_BIN --no-expose-wasm --lite-mode --max-old-space-size=32 --max-semi-space-size=1 $APP/server.js
Restart=always
RestartSec=2
MemoryMax=120M
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
UNITEOF

cat > /etc/systemd/system/kanban-watchdog.service <<WEOF
[Unit]
Description=Restart Kanban Board if it stops answering
[Service]
Type=oneshot
ExecStart=$APP/pi/watchdog.sh
WEOF
cat > /etc/systemd/system/kanban-watchdog.timer <<'TEOF'
[Unit]
Description=Check Kanban Board every minute
[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
TEOF
systemctl daemon-reload
systemctl enable --now kanban.service >/dev/null
systemctl restart kanban.service
systemctl enable --now kanban-watchdog.timer >/dev/null

ok=0
for _ in $(seq 1 30); do
  if curl -fsS -m 2 "http://localhost:$PORT/healthz" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ "$ok" -eq 1 ]; then say "Server is up on port $PORT"; else warn "Server didn't answer yet. Check: journalctl -u kanban -n 50"; fi

# ---------- TV kiosk ----------
add_line() { # file line: append once (idempotent)
  local f="$1" line="$2"
  grep -qF -- "$line" "$f" 2>/dev/null || printf '%s\n' "$line" >> "$f"
}
as_user() { sudo -u "$KIOSK_USER" "$@"; }

if [ "${NO_KIOSK:-0}" != 1 ]; then
  say "Setting up the TV kiosk"
  if ! command -v chromium-browser >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1; then
    apt_install chromium-browser 2>/dev/null || apt_install chromium
  fi
  apt_install unclutter 2>/dev/null || warn "unclutter not available (only used to hide the mouse on X11)"
  apt_install avahi-daemon 2>/dev/null || true

  # Which desktop session? Bookworm 2024-10+ and Trixie default to labwc (Wayland) on every model, Pi 3 included.
  # Older Bookworm installs on a Pi 3 run X11 (LXDE-pi/Openbox). We hook all of them; kiosk.sh has a lock so it starts once.
  SESSION="unknown"
  if grep -qs 'rpd-labwc\|labwc' /etc/lightdm/lightdm.conf; then SESSION="labwc (Wayland)"
  elif grep -qs 'wayfire' /etc/lightdm/lightdm.conf; then SESSION="wayfire (Wayland)"
  elif grep -qs 'LXDE-pi-x\|openbox\|LXDE' /etc/lightdm/lightdm.conf; then SESSION="X11 (LXDE-pi/Openbox)"; fi
  say "Desktop session looks like: $SESSION"

  cfg="$KIOSK_HOME/.config"
  as_user mkdir -p "$cfg/labwc" "$cfg/lxsession/LXDE-pi"
  # X11 / LXDE-pi: a user autostart file replaces the system one, so start from a copy of it
  x11="$cfg/lxsession/LXDE-pi/autostart"
  if [ ! -f "$x11" ] && [ -f /etc/xdg/lxsession/LXDE-pi/autostart ]; then as_user cp /etc/xdg/lxsession/LXDE-pi/autostart "$x11"; fi
  as_user touch "$x11"; add_line "$x11" "@$APP/pi/kiosk.sh $MARK"
  # labwc
  lab="$cfg/labwc/autostart"
  if [ ! -f "$lab" ] && [ -f /etc/xdg/labwc/autostart ]; then as_user cp /etc/xdg/labwc/autostart "$lab"; fi
  as_user touch "$lab"; add_line "$lab" "$APP/pi/kiosk.sh & $MARK"
  # wayfire (older Pi 4/5 installs)
  wf="$cfg/wayfire.ini"
  if [ -f "$wf" ] && ! grep -q '^kanban *=' "$wf"; then
    if grep -q '^\[autostart\]' "$wf"; then sed -i "/^\[autostart\]/a kanban = $APP/pi/kiosk.sh" "$wf"
    else printf '\n[autostart]\nkanban = %s\n' "$APP/pi/kiosk.sh" >> "$wf"; fi
  fi
  chown -R "$KIOSK_USER": "$cfg/labwc" "$cfg/lxsession"

  if command -v raspi-config >/dev/null 2>&1; then
    raspi-config nonint do_blanking 1 || warn "Couldn't turn off screen blanking with raspi-config"
    if [ "${AUTOLOGIN:-1}" = 1 ]; then raspi-config nonint do_boot_behaviour B4 || warn "Couldn't enable desktop autologin"; fi
    if [ "${KANBAN_X11:-0}" = 1 ]; then raspi-config nonint do_wayland W1 && say "Switched the desktop to X11 (takes effect after reboot)"; fi
  else
    warn "raspi-config not found: turn off screen blanking and enable desktop autologin yourself."
  fi
fi

if [ -n "${KANBAN_HOSTNAME:-}" ]; then
  if command -v raspi-config >/dev/null 2>&1; then raspi-config nonint do_hostname "$KANBAN_HOSTNAME"; else hostnamectl set-hostname "$KANBAN_HOSTNAME"; fi
  say "Hostname set to $KANBAN_HOSTNAME (takes full effect after reboot)"
fi

# ---------- how to reach it ----------
HOSTN="${KANBAN_HOSTNAME:-$(hostname)}"
ETH_IP="$(ip -4 -o addr show dev eth0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1 || true)"
ALL_IPS="$(hostname -I 2>/dev/null || true)"
echo
say "Done! Kanban Board is installed."
echo "   TV:      opens by itself after a reboot  (sudo reboot)"
echo "   Phones:  on the same home network, open one of these:"
[ -n "$ETH_IP" ] && echo "              http://$ETH_IP:$PORT        (Ethernet)"
for ip in $ALL_IPS; do
  case "$ip" in *:*|"$ETH_IP") ;; *) echo "              http://$ip:$PORT";; esac
done
systemctl is-active --quiet avahi-daemon 2>/dev/null && echo "              http://$HOSTN.local:$PORT   (name-based; works on most phones)"
[ -z "$ETH_IP" ] && warn "eth0 has no IPv4 address yet. Is the Ethernet cable plugged in? (Wi-Fi also works.)"
echo "   Data:    $DATA/board.json  (backups in $DATA/backups)"
echo "   Logs:    journalctl -u kanban -f"
