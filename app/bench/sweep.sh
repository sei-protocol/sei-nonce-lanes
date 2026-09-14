#!/usr/bin/env bash
# Runs bench/lanes-tps.ts over a list of "RELAYER_COUNT MAX_OPS_PER_BUNDLE [ORDERS]" combos.
#
# ORDERS defaults to clamp(R * W * 8, 32, 1024) so a client-bound combo (1 relayer,
# width 1) does not run for ten minutes while a saturating combo still gets a
# steady-state window of several seconds. LANE_POOL_SIZE always equals ORDERS.
#
# Usage:  bench/sweep.sh <label> "R W [ORDERS]" "R W [ORDERS]" ...
# Logs:   .state/bench/logs/sweep-<label>-r<R>-w<W>.log ; results in lanes-results.jsonl.
# The app already prints the RPC without its path; the sed below also strips the
# path from any URL viem embeds in an error dump, since RPC paths often carry keys.
set -u
cd "$(dirname "$0")/.." || exit 1
label="${1:?label}"; shift
mkdir -p .state/bench/logs
pause="${SWEEP_PAUSE_SECONDS:-5}"

for combo in "$@"; do
  set -- $combo
  r="$1"; w="$2"; orders="${3:-}"
  if [ -z "$orders" ]; then
    orders=$(( r * w * 8 ))
    [ "$orders" -lt 32 ] && orders=32
    [ "$orders" -gt 1024 ] && orders=1024
  fi
  log=".state/bench/logs/sweep-${label}-r${r}-w${w}-o${orders}.log"
  echo "=== [$(date +%H:%M:%S)] relayers=$r width=$w orders=$orders -> $log"
  RELAYER_COUNT="$r" MAX_OPS_PER_BUNDLE="$w" ORDERS="$orders" LANE_POOL_SIZE="$orders" \
    REVERT_ORDER_INDEX="${SWEEP_REVERT_INDEX:--1}" \
    BENCH_LABEL="${label} r${r} w${w} o${orders}" \
    npx tsx bench/lanes-tps.ts 2>&1 \
    | sed -l -E 's#(https?://[^/[:space:]"]+)/[^[:space:]"]+#\1/<redacted>#g' > "$log"
  status=${PIPESTATUS[0]}
  grep -E '^(throughput|ops landed|  mined|outer gas|submit time|  failed|  pending)' "$log" | sed 's/^/    /'
  [ "$status" -ne 0 ] && echo "    EXIT $status (see $log)"
  sleep "$pause"
done
echo "=== sweep '$label' done"
