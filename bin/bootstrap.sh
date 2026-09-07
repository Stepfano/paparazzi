#!/bin/sh
# Onboard a new person in one command:
#   curl -fsSL <raw-url-to-this-file> | sh
#
# Clones the repo (if not already present) and hands off to bin/setup.sh, which does
# everything else scriptable: install dependencies, start the hub, keep it running at login.
# What's still NOT scriptable (a hard Figma/platform limit, not a gap here): installing the
# Figma plugin itself, and each person's library always starts empty — this gets someone their
# own working copy of the tool, not a copy of anyone else's captured screenshots.

set -eu
REPO_URL="${PAPARAZZI_REPO:-https://github.com/Stepfano/paparazzi.git}"
TARGET="${PAPARAZZI_DIR:-$HOME/paparazzi}"

if [ -d "$TARGET/.git" ]; then
  echo "Already cloned at $TARGET — leaving it as is (not re-cloning over local changes)."
else
  echo "Cloning into $TARGET…"
  git clone "$REPO_URL" "$TARGET"
fi

sh "$TARGET/bin/setup.sh"
