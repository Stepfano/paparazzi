#!/bin/sh
# One-time setup for a new person on their own Mac. Everything that CAN be automated is
# automated here; the two things that can't (importing the plugin into Figma, and choosing
# how screenshots reach the phone) are printed as the last step, since neither has a scriptable
# equivalent — Figma has no CLI for importing a dev plugin, and "how you take screenshots" is
# a personal choice between three real options.

set -eu
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="$(id -un)"
UID_N="$(id -u)"
PLIST="$HOME/Library/LaunchAgents/com.traveloka.paparazzi.hub.plist"

echo "Paparazzi setup"
echo "  project: $PROJECT"
echo

if [ "$(uname)" != "Darwin" ]; then
  echo "This auto-start step is macOS-only (it uses launchd)."
  echo "On other platforms, just run 'node bin/serve.js' yourself whenever you want the hub up."
  SKIP_LAUNCHD=1
else
  SKIP_LAUNCHD=0
fi

command -v node >/dev/null 2>&1 || { echo "Node.js is required — install it first (nodejs.org), then re-run this."; exit 1; }
echo "node: $(node --version)"

echo "installing dependencies…"
cd "$PROJECT"
npm install --silent

if [ "$SKIP_LAUNCHD" = "0" ]; then
  echo "setting up the hub to start automatically at login…"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.traveloka.paparazzi.hub</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>$PROJECT/bin/hub-launchd.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>StandardOutPath</key><string>$PROJECT/.launchd.out.log</string>
  <key>StandardErrorPath</key><string>$PROJECT/.launchd.err.log</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>ThrottleInterval</key><integer>5</integer>
</dict>
</plist>
EOF
  launchctl bootout "gui/$UID_N/com.traveloka.paparazzi.hub" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_N" "$PLIST"
  launchctl enable "gui/$UID_N/com.traveloka.paparazzi.hub"
  sleep 1
fi

echo
echo "checking the hub is actually up…"
for i in 1 2 3 4 5; do
  if curl -s -m 2 -o /dev/null http://localhost:8899/v1/health; then HUB_UP=1; break; fi
  sleep 1
done

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "<your-mac-ip>")"

echo
echo "============================================================"
if [ "${HUB_UP:-0}" = "1" ]; then
  echo "Hub is running:  http://localhost:8899"
else
  echo "Hub did not start automatically. Run it yourself with:"
  echo "  node $PROJECT/bin/serve.js"
fi
echo
echo "Two things left — neither can be scripted:"
echo
echo "1. Import the Figma plugin (Figma desktop app):"
echo "   Plugins -> Development -> Import plugin from manifest..."
echo "   $PROJECT/figma-plugin/manifest.json"
echo
echo "2. Get screenshots from your phone into it — pick one:"
echo "   a) No install: open http://$LAN_IP:8899 on your phone, add to home screen"
echo "   b) adb + auto: node $PROJECT/bin/capture.js --mode auto"
echo "   c) Native app (Android): open $PROJECT/android in Android Studio and Run"
echo "============================================================"
