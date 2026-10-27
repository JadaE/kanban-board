#!/usr/bin/env bash
# Run every minute by kanban-watchdog.timer: restart the server if it stops answering 3 checks in a row.
set -u
PORT=8080
# shellcheck disable=SC1091
[ -r /etc/kanban.env ] && . /etc/kanban.env
STATE=/run/kanban-watchdog.fails
if curl -fsS -m 5 "http://localhost:$PORT/healthz" >/dev/null 2>&1; then echo 0 > "$STATE"; exit 0; fi
fails=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$fails" > "$STATE"
if [ "$fails" -ge 3 ]; then
  echo "kanban healthz failed $fails times; restarting kanban.service"
  systemctl restart kanban.service
  echo 0 > "$STATE"
fi
