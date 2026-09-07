# Paparazzi

Phone screenshots → a searchable local library → your Figma canvas.

Everything stays on this Mac. No cloud, no accounts, no tokens to expire.

```
phone ──┬─ web page (zero install) ──┐
        ├─ automation app ───────────┼──▶ hub (localhost:8899) ──▶ Figma plugin
        └─ adb capture ──────────────┘         │
                                          library/ on disk
```

## Start it

```bash
node bin/serve.js
```

It prints two URLs: `http://localhost:8899` for the Figma plugin, and a LAN address for your phone.

Import the plugin once: Figma **desktop** → Plugins → Development → Import plugin from manifest… →
`figma-plugin/manifest.json`. Then run **Paparazzi** from that menu.

## Getting screenshots in

**From your phone, no install.** Open the LAN URL the hub printed, add it to your home screen,
tap **Choose screenshots**. Folder and tags are remembered per device. Multi-select works.

**Hands-free, no custom app.** Point an automation app at the upload endpoint:

- **MacroDroid**: Trigger → *File/Folder* → folder `/sdcard/Pictures/Screenshots`, event *File added*.
  Action → *HTTP Request* → POST to
  `http://<mac-ip>:8899/v1/upload?collection=competitors/Agoda&platform=android`
  with the triggered file as the raw body and Content-Type `image/png`.
- **Tasker**: Profile → *Event* → *File Modified* on the same folder;
  Task → *HTTP Request*, method POST, File to Send = `%evtprm1`, same URL.

On Xiaomi/HyperOS also enable **Autostart** for the automation app and set its battery saver to
**No restrictions**, or Android will kill it and screenshots will silently stop arriving.

**Over adb**, when the phone is connected:

```bash
node bin/capture.js                    # pull the current screen
node bin/capture.js --watch            # auto-pull every new phone screenshot
node bin/capture.js --n 5 --delay 3    # 5 shots, 3s apart
```

`capture.js` also records the real foreground package and `versionName` from the device, so app and
version are captured rather than guessed.

**A captured journey** from the competitor-screenshot-insights-android Skill:

```bash
node bin/ingest-journey.js /path/to/screenshots/<slug>
```

Reads `target.json` for the app identity and preserves frame order.

## Finding things

```bash
node bin/search.js --all
node bin/search.js --collection competitors/agoda
node bin/search.js --app agoda --version 12.3.0
node bin/search.js --tag pricing
node bin/search.js --step checkout
node bin/search.js --month 202609
```

The filename **is** the index, so these also work in any file browser:

```
hub__c-competitors~trip.com~novotel-bsd__a-trip.com__p-android__o-03__s-hotel-detail__
d-20260904-1728__ar-0450__h-90c8c83b5d4c5971__t-journey__scr_0mtquqp4qa5236co352.png
```

`c-` folder · `a-` app · `v-` version · `p-` platform · `o-` order · `s-` step · `d-` captured ·
`ar-` aspect · `h-` hash · `t-` tags

## Removing things

```bash
node bin/prune.js --dry-run --orphans --dups
node bin/prune.js --id scr_xxx
node bin/prune.js --match agoda-probe
```

Image and sidecar go together, and the index plus the shrink-guard baseline are rebuilt from what
survives.

## Deduplication

Two signals, because neither works alone. Measured on real screenshots, "same layout, different
content" falls as low as **0.64** structural while two genuinely *different* screens reach **0.70** —
those ranges overlap, so no structural threshold can separate them. A difference hash does:

```
dhash ≤ 6                           → same image, whatever the content edits
structural ≥ 0.85 and dhash ≤ 16    → same layout, meaningfully different content
```

A suspected duplicate is reported, never silently discarded. `--force` stores it anyway.

## Layout

| Path | What |
|---|---|
| `library/` | the screenshots, their sidecars, and the snapshot |
| `lib/signature.js` | structural signature + the dedupe verdict |
| `lib/naming.js` | the filename index — encode, parse, search terms |
| `lib/local-store.js` | the default backend: this Mac |
| `lib/drive-store.js` | the Lark Drive backend, kept for `storage: "lark"` |
| `lib/store.js` | picks the backend from `hub.config.json` |
| `bin/serve.js` | hub API + the phone page |
| `figma-plugin/` | the Figma plugin |

## Notes

The hub must be running for the plugin to show anything — a red dot means it isn't.

The hub binds to all interfaces so your phone can reach it. That means anyone on the same network
can reach it too, so don't run it on untrusted Wi-Fi. `HUB_BIND=127.0.0.1 node bin/serve.js`
restricts it to this machine (and disables phone uploads).

`ARCHITECTURE.md` records the design decisions and the measurements behind them, including the
Lark-backed multi-user design this was scoped down from.
