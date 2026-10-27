#!/usr/bin/env bash
# Runs memory.test.js inside a cgroup v2 memory cap (default 450 MB, no swap) to mimic what's left for
# Chromium + the server on a 1 GB Pi 3 after the OS and desktop. Needs sudo and cgroup v2. Box-only helper.
set -euo pipefail
LIMIT_MB="${LIMIT_MB:-450}"
CG=/sys/fs/cgroup/kanban-memtest
HERE="$(cd "$(dirname "$0")" && pwd)"
sudo mkdir -p "$CG"
echo "$((LIMIT_MB * 1024 * 1024))" | sudo tee "$CG/memory.max" >/dev/null
echo 0 | sudo tee "$CG/memory.swap.max" >/dev/null 2>&1 || true
set +e
sudo bash -c "echo \$\$ > $CG/cgroup.procs && exec sudo -u $(id -un) env HOME=$HOME PATH=$PATH node $HERE/memory.test.js"
rc=$?
set -e
sudo rmdir "$CG" 2>/dev/null || true
exit $rc
