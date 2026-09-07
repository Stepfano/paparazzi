#!/bin/sh
# launchd wrapper for the hub, so it's already running whenever Figma is opened.
#
# launchd gives a minimal PATH, so node is located explicitly. Logs go next to the project
# rather than to stdout, since launchd's own StandardOutPath is set to the same files anyway —
# this just keeps one clear place to look regardless of how it was started.

set -u
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export PATH

cd "$PROJECT" || exit 1
exec node bin/serve.js >> "$PROJECT/hub.log" 2>&1
