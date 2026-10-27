#!/usr/bin/env bash
# Starts Chromium full screen on the board and keeps it running. Launched by the desktop autostart.
# Pi 3 friendly: memory-saving flags, relaunch on crash or when RAM runs very low.
set -u
LOCK="${XDG_RUNTIME_DIR:-/tmp}/kanban-kiosk.lock"
exec 9>"$LOCK"
flock -n 9 || exit 0   # already running (several autostart hooks point here)

PORT=8080
KIOSK_URL=""
# shellcheck disable=SC1091
[ -r /etc/kanban.env ] && . /etc/kanban.env
URL="${KIOSK_URL:-http://localhost:$PORT/?tv=1}"
HEALTH="http://localhost:$PORT/healthz"
PROFILE="$HOME/.config/kanban-kiosk"
LOG="$HOME/.cache/kanban-kiosk.log"
mkdir -p "$PROFILE" "$(dirname "$LOG")"
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

BROWSER="$(command -v chromium-browser || command -v chromium || true)"
[ -n "$BROWSER" ] || { log "Chromium not found"; exit 1; }

# Wait for the board server on this Pi. It only needs localhost, so this works the same with Ethernet,
# Wi-Fi, or no network at all. (If it's still not up after 2 minutes we open anyway; the page retries.)
for _ in $(seq 1 120); do curl -fsS -m 2 "$HEALTH" >/dev/null 2>&1 && break; sleep 1; done

if [ -z "${WAYLAND_DISPLAY:-}" ] && [ -n "${DISPLAY:-}" ]; then
  # X11: no screensaver, no power-saving blanking, hide the mouse
  xset s off 2>/dev/null; xset -dpms 2>/dev/null; xset s noblank 2>/dev/null
  command -v unclutter >/dev/null 2>&1 && { unclutter -idle 0.5 -root >/dev/null 2>&1 & }
  PLATFORM=(--ozone-platform=x11)
else
  PLATFORM=(--ozone-platform=wayland)
fi

# shellcheck disable=SC2054  # commas inside --disable-features are intentional
FLAGS=(
  --kiosk --start-fullscreen --noerrdialogs --disable-infobars
  --disable-session-crashed-bubble --disable-restore-session-state --hide-crash-restore-bubble
  --no-first-run --no-default-browser-check --password-store=basic
  --disable-translate --disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,CalculateNativeWinOcclusion
  --check-for-update-interval=31536000 --overscroll-history-navigation=0 --disable-pinch
  # memory savers for a 1 GB Pi 3
  --enable-low-end-device-mode --disable-extensions --disable-background-networking --disable-sync
  --disable-default-apps --disable-component-update --disable-breakpad --renderer-process-limit=1
  --process-per-site --disk-cache-size=16777216 --media-cache-size=1 --js-flags=--max-old-space-size=128
  --user-data-dir="$PROFILE"
)

while true; do
  # Pretend the last run ended cleanly so Chromium never shows a "Restore pages?" bubble
  for f in "$PROFILE/Default/Preferences" "$PROFILE/Local State"; do
    [ -f "$f" ] && sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[A-Za-z]*"/"exit_type":"Normal"/' "$f"
  done
  log "Starting Chromium: $URL"
  "$BROWSER" "${PLATFORM[@]}" "${FLAGS[@]}" "$URL" >/dev/null 2>&1 &
  pid=$!
  # Watchdog: relaunch if Chromium exits, or if the Pi is about to run out of memory.
  while kill -0 "$pid" 2>/dev/null; do
    sleep 30
    avail="$(awk '/MemAvailable/{print $2}' /proc/meminfo)"
    if [ "${avail:-999999}" -lt 40000 ]; then log "Low memory (${avail} kB free): restarting Chromium"; kill "$pid" 2>/dev/null; sleep 5; kill -9 "$pid" 2>/dev/null; fi
  done
  wait "$pid" 2>/dev/null
  log "Chromium exited; relaunching in 3 s"
  sleep 3
done
