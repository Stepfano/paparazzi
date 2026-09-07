# Paparazzi for Android

Watches for screenshots you take and pushes them to the Paparazzi hub, which puts them in your
Figma library. No cable, no adb, no manual upload.

## What it does

A foreground service registers a `ContentObserver` on `MediaStore.Images`, so it hears about every
new image within about a second. Each candidate is checked against the screenshot folders before
uploading — otherwise every camera photo and downloaded image would land in your library. The
bytes are POSTed straight to `POST /v1/upload` on the hub.

No third-party dependencies: `HttpURLConnection` and the platform UI classes are enough, so the
build pulls nothing beyond the Android Gradle plugin.

## Build and install

The SDK is not downloaded on this machine yet — Android Studio is installed but its first-run
wizard has not completed. Opening the project handles that:

1. **Android Studio → Open** → this `android/` folder
2. Accept the SDK download when prompted (it needs platform 34 and build-tools)
3. Connect the phone (USB, or `adb connect <ip>:<port>` for wireless)
4. Press **Run**

Command line, once the SDK exists:

```bash
export ANDROID_HOME=~/Library/Android/sdk
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
cd android && ./gradlew installDebug        # or assembleDebug for just the APK
```

There is no Gradle wrapper JAR committed — Android Studio generates it on first open, or run
`gradle wrapper` if you have Gradle installed.

## Using it

1. Start the hub on your Mac: `node bin/serve.js`
2. Open Paparazzi on the phone and set **Hub URL** to the LAN address the hub printed,
   e.g. `http://10.15.39.66:8899`
3. Tap **Test connection** — it should report how many screenshots the library holds
4. Set **Folder** (e.g. `competitors/Agoda`) and optional tags
5. Tap **Start watching**, then grant the image and notification permissions

Now take screenshots normally. Each one appears in the Figma plugin within seconds. The persistent
notification shows the last thing that happened and carries a **Stop** action.

## Xiaomi / HyperOS

This is the part that actually decides whether it keeps working. HyperOS kills background services
aggressively, so also:

- **Autostart**: Settings → Apps → Paparazzi → **Autostart** → on
- **Battery**: Settings → Apps → Paparazzi → Battery saver → **No restrictions**

The **Open app settings** button in the app jumps to the right screen. Without these the service
dies quietly after a while, which is worse than manual capture because you would trust it and lose
screenshots.

## Design notes

- **Duplicates are the hub's job.** The app uploads and the hub answers `duplicate`, so the phone
  needs no signature logic and the dedupe rule stays in one place.
- **The high-water mark advances even for skipped images**, so non-screenshots are never rescanned.
  On an upload *failure* it rolls back one so that screenshot is retried rather than lost.
- **Cleartext HTTP is permitted** via `network_security_config.xml`, because the hub is a private
  address on your LAN. Android blocks cleartext by default since API 28.
- **`START_STICKY`** so Android restarts the service if it is killed for memory.
- The observer can fire several times for a single insert, so the scan is idempotent and driven by
  the id marker rather than by the event.

## Status

**Written but not yet compiled** — there is no Android SDK on this machine to build against, so
this code has never been through a compiler. Expect to fix a small mistake or two on first build;
open it in Studio and send me any errors.
