#!/usr/bin/env bash
# Removes Kanban Board from the Pi. Your board data is kept unless you add --purge.
#   sudo /opt/kanban/pi/uninstall.sh            (keeps a copy of the data in /var/backups)
#   sudo /opt/kanban/pi/uninstall.sh --purge    (deletes everything, including the data)
set -euo pipefail
APP=/opt/kanban
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1
[ "$(id -u)" -eq 0 ] || { echo "Please run with sudo: sudo $0" >&2; exit 1; }
KIOSK_USER="${KIOSK_USER:-${SUDO_USER:-}}"
if [ -z "$KIOSK_USER" ] || [ "$KIOSK_USER" = root ]; then KIOSK_USER="$(getent passwd 1000 | cut -d: -f1 || true)"; fi

echo "==> Stopping services"
systemctl disable --now kanban-watchdog.timer kanban.service >/dev/null 2>&1 || true
rm -f /etc/systemd/system/kanban.service /etc/systemd/system/kanban-watchdog.service /etc/systemd/system/kanban-watchdog.timer
systemctl daemon-reload
pkill -f "$APP/pi/kiosk.sh" 2>/dev/null || true
pkill -f "kanban-kiosk" 2>/dev/null || true

if [ -n "$KIOSK_USER" ]; then
  home="$(getent passwd "$KIOSK_USER" | cut -d: -f6)"
  echo "==> Removing TV autostart for $KIOSK_USER"
  for f in "$home/.config/labwc/autostart" "$home/.config/lxsession/LXDE-pi/autostart"; do
    [ -f "$f" ] && sed -i '/# kanban-kiosk/d' "$f"
  done
  [ -f "$home/.config/wayfire.ini" ] && sed -i '/^kanban *= /d' "$home/.config/wayfire.ini"
  rm -rf "$home/.config/kanban-kiosk"
fi

if [ -d "$APP/data" ] && [ "$PURGE" -eq 0 ]; then
  dest="/var/backups/kanban-data-$(date +%Y%m%d-%H%M%S)"
  cp -a "$APP/data" "$dest"
  echo "==> Your board data was saved to $dest"
fi
rm -rf "$APP"
rm -f /etc/kanban.env /run/kanban-watchdog.fails
id kanban >/dev/null 2>&1 && userdel kanban 2>/dev/null || true
echo "==> Removed. (Screen blanking and desktop autologin were left as they are; change them in raspi-config if you like.)"
