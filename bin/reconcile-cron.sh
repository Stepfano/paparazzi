#!/bin/sh
# Scheduled wrapper around bin/reconcile.js.
#
# launchd runs jobs with a minimal PATH, so node and lark-cli are located explicitly.
# A lock file prevents overlapping runs — a reconcile that downloads several drops can
# outlast the interval.

set -u

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$PROJECT/reconcile.log"
LOCK="$PROJECT/.reconcile.lock"
PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export PATH

stamp() { date '+%Y-%m-%d %H:%M:%S'; }

# mkdir is atomic, so it works as a lock without needing flock (absent on macOS).
if ! mkdir "$LOCK" 2>/dev/null; then
  # Clear a lock older than an hour: a previous run died without cleaning up.
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then
    echo "$(stamp)  stale lock cleared" >> "$LOG"
    rmdir "$LOCK" 2>/dev/null
    mkdir "$LOCK" 2>/dev/null || exit 0
  else
    exit 0   # a run is already in progress
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM

cd "$PROJECT" || exit 1

OUT="$(node bin/reconcile.js 2>&1)"
CODE=$?

# Keep the log quiet when there is nothing to do — this runs every 10 minutes.
if [ $CODE -ne 0 ]; then
  echo "$(stamp)  FAILED (exit $CODE)" >> "$LOG"
  echo "$OUT" | sed 's/^/    /' >> "$LOG"
  case "$OUT" in
    *"missing required scope"*|*"user_access_token"*|*"authorization"*)
      echo "$(stamp)  -> Lark auth needs attention: run 'lark-cli auth login' in a terminal" >> "$LOG" ;;
    *"index shrank"*)
      echo "$(stamp)  -> index shrank: files were probably deleted in Lark. Not ingesting, by design." >> "$LOG" ;;
  esac
elif echo "$OUT" | grep -q "nothing to reconcile"; then
  :   # idle, say nothing
else
  echo "$(stamp)  $(echo "$OUT" | tail -1)" >> "$LOG"
  echo "$OUT" | grep -E '^\+|^=' | sed 's/^/    /' >> "$LOG"
fi

# Keep the log from growing without bound.
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 2000 ]; then
  tail -500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
