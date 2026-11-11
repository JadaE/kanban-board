#!/usr/bin/env bash
# Run every minute by kanban-watchdog.timer: restart the server if it stops answering 3 checks in a row.
set -u
PORT=8080
HOST_BIND=""
TOKEN=""
if [ -r /etc/kanban.env ]; then
  file_port="$(awk -F= '$1=="PORT"{print substr($0, index($0, "=") + 1); exit}' /etc/kanban.env)"
  file_host="$(awk -F= '$1=="HOST"{print substr($0, index($0, "=") + 1); exit}' /etc/kanban.env)"
  [ -n "$file_port" ] && PORT="$file_port"
  [ -n "$file_host" ] && HOST_BIND="$file_host"
  TOKEN="$(awk '
    /^AUTH_TOKEN=/ { v = substr($0, index($0, "=") + 1); if (v != "") a = v }
    /^KANBAN_TOKEN=/ { v = substr($0, index($0, "=") + 1); if (v != "" && k == "") k = v }
    END { if (a != "") print a; else if (k != "") print k }
  ' /etc/kanban.env)"
fi
case "$HOST_BIND" in
  ''|0.0.0.0|127.0.0.1|localhost|::|::1) HEALTH_HOST=127.0.0.1 ;;
  *) HEALTH_HOST=$HOST_BIND ;;
esac
STATE=/run/kanban-watchdog.fails
healthy=1
if [ -z "$TOKEN" ]; then
  healthy=0
else
  cfg="$(mktemp)"
  chmod 600 "$cfg"
  printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" > "$cfg"
  curl --config "$cfg" -fsS -m 5 -o /dev/null "http://$HEALTH_HOST:$PORT/healthz" || healthy=0
  rm -f "$cfg"
  unset TOKEN cfg
fi
if [ "$healthy" -eq 1 ]; then echo 0 > "$STATE"; exit 0; fi
fails=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$fails" > "$STATE"
if [ "$fails" -ge 3 ]; then
  echo "kanban healthz failed $fails times; restarting kanban.service"
  systemctl restart kanban.service
  echo 0 > "$STATE"
fi
