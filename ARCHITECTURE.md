# Screenshot Hub — architecture & feasibility

A centralised, searchable screenshot library for the team, feeding a Figma plugin.
Supersedes the single-user LAN relay in `../phone-to-figma/`.

```
 Android app ──┐                        ┌──▶ Figma plugin (browse / search / folders)
 iOS app ──────┼──▶ Hub API ──▶ storage ┤
 Share sheet ──┤      │                 └──▶ live feed (your own devices only)
 Web upload ───┘      └── dedupe · metadata · tags · platform · version
```

## Feasibility verdict per requirement

| # | Requirement | Verdict |
|---|---|---|
| 1 | Central hosted library, shared pool | ✅ Straightforward |
| 2 | Structural dedupe, content-ignorant | ✅ **Built and measured** — but 80% is the wrong number, see below |
| 3 | Tags + description, searchable | ✅ Straightforward |
| 4 | Auto-tag Android/iOS | ✅ Client declares it; server infers as a fallback |
| 5 | Timestamp captured | ✅ Trivial |
| 6 | App version | ⚠️ **Better than asked on Android, impossible on iOS** |
| 7 | Plugin browse/search/folders | ✅ Straightforward |
| 8 | Android auto-listen | ✅ Feasible — foreground service |
| 9 | **iOS auto-listen** | ❌ **Not possible.** Hard OS limit |
| 10 | Plugin live-follow | ✅ Straightforward |
| 11 | Per-user isolation | ✅ Straightforward |

### 2 — Dedupe: measured, and the threshold needs to change

`lib/signature.js` crops the status/nav bars, greyscales, resizes to a fixed raster, takes Sobel
edge magnitude, averages it into a 16×32 block grid, and compares two grids with **Pearson
correlation** (not cosine — block-edge maps are all non-negative, so plain cosine reads ~0.8 even
for unrelated screens and an 80% threshold would be meaningless).

Measured on real screenshots (`test/similarity.test.js`):

| Case | Structural score |
|---|---|
| Identical / re-encoded / resized 55% | 1.00 / 1.00 / 1.00 |
| Status bar painted over (different clock) | 1.00 |
| Brightness + contrast shifted | 0.96 |
| **12% of the screen replaced (content changed)** | **0.64** |
| Scrolled 8% | 0.68 |
| Four genuinely different screens, cross-compared | **0.00 – 0.16** |

Two conclusions:

- **Separation is excellent.** Unrelated screens land at 0.00–0.16 against 1.00 for matches, so the
  signal is strong and reliable.
- **80% is too strict for your actual goal.** You want "same layout, different content" to read as a
  duplicate — but replacing 12% of the screen already drops it to 0.64. Set the layout bar around
  **0.65**, and keep a second, independent check (64-bit dHash, Hamming ≤ 6) to catch
  near-identical re-uploads regardless. Both are in place and tunable per collection.
- Calibrate on a real corpus before fixing the number. Once a few hundred screenshots are in, the
  right threshold is measurable rather than guessed.

Known weakness: a horizontally mirrored image scores 0.87, because phone UIs are near-symmetric in
edge density. Irrelevant in practice (nobody uploads mirrored screenshots) but it means two
different screens made purely of full-width list rows can correlate. Fixable with a left/right
asymmetry term if it ever shows up in real data.

Policy: **warn and link, never silently reject.** An upload that looks like a duplicate returns
`201` plus `{duplicateOf, similarity, reason}` so the client can offer "keep anyway" or "use the
existing one". Silently discarding someone's screenshot is how people stop trusting the tool.

### 6 — App version: don't estimate it from a timestamp

You asked to infer the app version from the capture time. On Android we can do better and read the
**real** version: `UsageStatsManager` gives the foreground package at capture time, then
`PackageManager.getPackageInfo(pkg).versionName` gives its exact version. That needs the
`PACKAGE_USAGE_STATS` special permission, which the user grants once in Settings.

On iOS there is no API for the foreground app or its version — impossible.

So: exact version where we can get it, and a server-side **version timeline** (app × date range →
version) as the fallback everywhere else. That fallback is your timestamp idea, used only when the
real answer is unavailable, and it degrades honestly — records are marked `versionSource:
"declared" | "inferred"` so nobody mistakes a guess for a fact.

### 8 vs 9 — auto-listen is an Android-only feature

**Android: works.** A foreground service with a `ContentObserver` on `MediaStore.Images` fires
within ~1s of any screenshot, anywhere on the device, and uploads it. Costs a persistent
notification (Android requires it) and `READ_MEDIA_IMAGES`.

**iOS: cannot be done.** `userDidTakeScreenshotNotification` only fires while *your own* app is
foreground — which it never is when someone is screenshotting a competitor's app. There is no
system-wide screenshot hook and no long-lived background daemon; Apple does not permit it. No
amount of engineering changes this, and any tool claiming otherwise is doing manual capture.

Best honest iOS options:

1. **Share sheet, one tap** — screenshot → share → Hub. Immediate, reliable, ~2s of friction. Works today.
2. **Catch-up sync** — on app open, `PHPhotoLibraryChangeObserver` finds every screenshot since the
   last sync and uploads the batch. Zero friction per screenshot, but delayed until the app is opened.
3. Combine both: tap-to-send when it matters now, catch-up so nothing is ever lost.

Recommendation: ship Android auto-listen and iOS options 1+2, and label the feature "auto-capture
(Android) / quick-send + sync (iOS)" so expectations are set by the UI rather than by disappointment.

### 11 — Keeping concurrent users apart

Two different scopes, deliberately:

- **The library is shared.** Everyone browses, searches and pulls from the whole pool — that is the point.
- **The live feed is private.** `GET /live?after=<cursor>` is scoped to the caller's own devices, so
  two people capturing at the same time never see each other's stream.

Identity: user (company email) → one or more registered devices, each with its own `device_id` and
token. The Figma plugin authenticates as the user and follows only that user's devices, with an
optional device picker when someone has several.

## Hosting decision: Lark Base + Lark Drive, plus a thin proxy

Two candidates were evaluated against the real APIs.

### MarTech Pages — rejected

`pages.mte.traveloka.com` publishes static HTML only (`publish_page` takes a `path` ending in
`.html` plus markup). No request endpoints, no blob storage, no database, no server-side
execution. Decisively: **a phone cannot upload to it** — publishing runs through the MCP tool with
a Google login from a laptop, so there is no endpoint a mobile client could POST to. Still useful
later for hosting the static web UI and for circulating docs on the office network.

### Lark — accepted for storage, identity and search

Verified against the granted scopes on this account:

- **Lark Base** as the metadata database — `table-create` with an explicit schema,
  `record-batch-create`, `record-search`, `data-query` (JSON DSL: filter, sort, aggregate),
  views, roles and advanced permissions. Covers metadata, tags, search and folders.
- **Lark Drive** for the image blobs (`drive:file:upload` / `drive:file:download`). Keep bytes in
  Drive rather than Base attachments so Base rows stay small and clear of attachment quotas.
- **Lark identity** for requirement 11 — every employee already has an account, so per-user
  isolation and auth come free and sanctioned, with no new credential store to build.

### The CORS finding — why a small proxy is unavoidable

Tested directly against live endpoints with an `Origin: https://www.figma.com` header:

| Endpoint | Status | `Access-Control-Allow-Origin` |
|---|---|---|
| `POST /open-apis/auth/v3/tenant_access_token/internal` | 200 | **absent** |
| `GET /open-apis/authen/v1/user_info` | 200 | **absent** |
| `GET /open-apis/drive/v1/files` | 400 | **absent** |

Lark OpenAPI sends no CORS headers, so **browser-based clients cannot call it**. That splits the
clients in two:

- **Native Android / iOS apps — direct to Lark.** CORS is a browser restriction; native HTTP
  clients ignore it. No proxy needed on the capture path.
- **Figma plugin and web UI — blocked.** A Figma plugin's UI runs in a sandboxed iframe, a browser
  context, with no way to opt out of CORS. These need a proxy.

So the design keeps a **thin proxy**: authenticate the caller, forward to Lark, add CORS headers.
It holds no data at rest — no database, no object storage, no backups, which makes it a far
easier infrastructure request than a full service.

And since the proxy exists anyway, it should own dedupe. Signatures computed purely client-side
make deduplication best-effort — two people uploading at the same moment each miss the other.
Running the comparison in the proxy makes it authoritative again, which recovers the one real
weakness of the serverless approach.

```
 Android app ────────────────────────────▶ Lark Base + Lark Drive
 iOS app ────────────────────────────────▶      ▲
 Figma plugin ──▶ proxy (CORS + dedupe) ────────┘
 Web UI ────────▶      (no data at rest)
```

Remaining unknowns to check before committing:

- **Base per-table record ceiling and Drive quota** against expected volume. Blobs in Drive and
  compact signatures keep rows light, but the ceiling is a real number that needs looking up for
  this tenant's plan rather than assumed.
- **Lark OpenAPI rate limits** under a team of concurrent uploaders.
- Whether Drive public-share URLs carry permissive CORS. If they do, the plugin can pull image
  bytes straight from Drive and the proxy only ever handles metadata.

## Data model

```
users        id, email, display_name, created_at
devices      id, user_id, platform(android|ios|web), model, os_version, label, token_hash
collections  id, path("competitors/agoda/hotel-detail"), parent_id, name
screenshots  id, collection_id, user_id, device_id, storage_key,
             width, height, bytes, mime,
             captured_at, uploaded_at,
             platform, app_package, app_version, version_source,
             description, tags[],
             dhash, structure_sig(blob), aspect,
             duplicate_of (nullable)
```

Folders are `collections`; the plugin mirrors the same tree, so grouping is defined once, server-side.

## API sketch

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/devices/register` | Exchange an enrolment code for a device token |
| `POST` | `/v1/screenshots` | Upload + metadata; returns dedupe verdict |
| `GET` | `/v1/screenshots?q=&tags=&platform=&collection=&app=&version=&from=&to=` | Search |
| `GET` | `/v1/screenshots/:id/image` | Bytes (with `?w=` for thumbnails) |
| `PATCH` | `/v1/screenshots/:id` | Edit description / tags / collection |
| `GET` | `/v1/collections` | Folder tree |
| `GET` | `/v1/live?after=<cursor>` | Caller's own devices only; long-poll |

## Open dependencies

- **Hosting must be company-sanctioned.** This becomes a shared store of competitor and possibly
  internal-product screenshots — company data. It needs to sit on approved infrastructure with
  real authentication, not a personal cloud account.
- **App distribution needs the mobile/IT team.** Android: internal Play track or MDM. iOS:
  TestFlight or MDM under the company Apple Developer account. This is the long-lead item — worth
  starting before the code is finished.

---

## Live coordinates (built 2026-09-07)

Base: **https://traveloka.sg.larksuite.com/base/Iy5ibe9iWa15t0sXNlulIXuFgEd**

| Table | id | Fields |
|---|---|---|
| `screenshots` | `tblpk1VPZ8glkRc8` | 28 |
| `collections` | `tblgSffbMDDH36iU` | 6 |
| `devices` | `tblL4125HUuk2BHO` | 9 |
| `_unused-import-placeholder` | `tbl2aFRoLwEvC22a` | leftover from Base creation, see below |

Blobs go to Lark Drive root (no folder — see scope limits). Images are stored full-size in Drive
with the Base row holding `drive_file_token`; the `thumbnail` attachment column stays free for a
small preview so the Base remains browsable by a human.

### Lark scope limits hit while building

Two blockers, both worked around rather than escalated:

- **`base:table:delete` is not grantable.** Device-flow authorization completed but Lark returned
  it as not granted, most likely disabled at app or tenant level. `base +base-create` pre-flights
  this scope, so the Base could not be created that way. **Workaround:** create the Base with
  `drive +import --type bitable` from a stub CSV, then add properly-typed tables with
  `base +table-create` (`base:table:create` *is* granted). The import leaves one placeholder table
  which cannot be deleted for the same reason — renamed `_unused-import-placeholder` instead.
- **`drive:drive` is not granted**, so `drive +create-folder` fails. Blobs land in Drive root.
  Cosmetic only; request `drive:drive` if folder organisation on the Drive side matters.

Also worth knowing: `lark-cli` restricts `--file` to the working directory, `/tmp` or `~/files`,
so `lib/lark.js` stages uploads through `/tmp`. And `+record-list --limit` caps at **200**, not the
2000 the domain guide implies, so `listRecords` paginates — a partial read would silently weaken
dedupe, which is why it reads every page.

### Verified end to end

Real screenshots, real Lark, no mocks:

1. `drive +upload` → blob in Drive (613 KB JPEG, token returned)
2. signature computed → 512-dim map quantised to 684 base64 chars
3. `record-batch-create` → row in `screenshots`
4. `record-list` read back → signature intact
5. dedupe re-check → the already-stored image scored **1.0000 / near-identical** and was skipped;
   three genuinely different screenshots were stored as unique

Quantising the signature to one byte per block shifts correlation by at most **0.0004**, so
storing it as text costs nothing in accuracy.

## Build status

| Component | State |
|---|---|
| Structural signature + dedupe (`lib/signature.js`) | ✅ Built, measured on real data |
| Signature packing + record shaping (`lib/record.js`) | ✅ Built, quantisation verified |
| Lark client (`lib/lark.js`) | ✅ Built — paginated reads, staged uploads, scope-aware errors |
| Lark Base schema | ✅ Created, 3 tables live |
| Ingest CLI (`bin/ingest.js`) | ✅ Built, 4 screenshots ingested, dedupe fired correctly |
| CORS proxy | ⬜ Blocked on a compute target |
| Figma plugin (browse/search/folders/live) | ⬜ Needs the proxy |
| Web upload UI | ⬜ Needs the proxy |
| Android auto-capture app | ⬜ Needs the proxy + a distribution channel |

---

## Superseded: Drive-only, filename as the index (2026-09-07)

At the user's direction the store moved off Lark Base entirely. **The filename is the index.**

```
hub__c-competitors.agoda.hotel-detail__a-agoda__v-12.3.0__p-android__d-20260907-1125__
ar-0450__h-0c80884d51800100__t-pricing.badge__scr_0mtqqmiyi7f6hs0ut83.jpg
```

Each field carries a short key prefix, so a substring search is unambiguous:

| Search | Returns |
|---|---|
| `p-android` | every Android screenshot |
| `a-agoda` | every Agoda screenshot |
| `c-competitors.agoda` | that folder and everything beneath it |
| `t-pricing` | one tag |
| `d-202609` | one month |
| `hub__` | the whole library |

Fields are separated by `__`, which is stripped from every value, so a value cannot forge a field
boundary — verified with an injection test. Single underscores survive, which is why `scr_xxx`
ids stay intact. Names are capped at 200 characters; when a name would exceed that, tags are
dropped first, then the collection, so the id and the hash always survive.

### Three objects per screenshot

- **The image**, named as above — carries every searchable field.
- **A sidecar** `hub__meta__<id>.json` — the 512-dim signature and the free-text description,
  which cannot fit or be indexed in a filename.
- **A snapshot** `hub__snapshot.json` — every signature in one file, so a dedupe pass is one
  download instead of one per screenshot.

**Concurrency:** every write creates its own new file and never mutates shared state, so two
people uploading simultaneously cannot lose each other's record — the failure mode that a single
shared `index.json` would have had. The snapshot is only a cache: a stale one is detected and
topped up from the sidecars it lacks, so racing rebuilds are harmless. Measured: first pass read
4 sidecars, the next read 1 snapshot.

### What this trade cost

- **Free-text descriptions are no longer searchable.** Lark Drive content-indexes documents but
  not binary files — for a JPEG it matches the title and nothing else. Verified: searching
  "competitor" returned ten wiki docs and none of our images. Descriptions live in the sidecar
  and are readable, not findable. Every *structured* field stayed searchable.
- **No structured queries.** No equivalent of `data-query` for ranges or aggregation; filtering
  happens over the index client-side.
- **Search results are truncated.** Drive returns the filename only in `title_highlighted`,
  tag-wrapped and cut short for long names, so it cannot be parsed reliably. `search()` therefore
  filters the **root listing**, which returns every entry with its full name in one unpaginated
  call. `searchTokens()` keeps Drive-side narrowing available for when the library outgrows that.

The Base at `Iy5ibe9iWa15t0sXNlulIXuFgEd` is now unused. It can't be deleted through the API
(no scope), so remove it by hand if you want it gone.

## Build status

| Component | State |
|---|---|
| Structural signature + dedupe (`lib/signature.js`) | ✅ Measured on real data |
| Signature packing (`lib/record.js`) | ✅ Quantisation drift ≤ 0.0004 |
| Filename index (`lib/naming.js`) | ✅ Round-trip, injection and truncation tested |
| Lark client (`lib/lark.js`) | ✅ Drive list/search/download/upload, scope-aware errors |
| Drive store (`lib/drive-store.js`) | ✅ Concurrency-safe writes, snapshot cache |
| Ingest CLI (`bin/ingest.js`) | ✅ 5 screenshots stored, dedupe fired on all 3 cases |
| Search CLI (`bin/search.js`) | ✅ 12 filter assertions pass |
| CORS proxy | ⬜ Blocked on a compute target |
| Figma plugin (browse/search/folders/live) | ⬜ Needs the proxy |
| Web upload UI | ⬜ Needs the proxy |
| Android auto-capture app | ⬜ Needs the proxy + distribution |

---

## Dedicated folder (2026-09-07)

The hub lives in its own Drive folder rather than loose in root:

**https://traveloka.sg.larksuite.com/drive/folder/RvlEfcxEllqrESdEpcBlatUtgHd**

Configured in `hub.config.json` (`folder_token`), overridable with `HUB_FOLDER_TOKEN`, falling
back to Drive root when neither is set. All 11 objects live there — 5 screenshots, 5 sidecars,
1 snapshot — and root is clean.

Folder **creation** needs `drive:drive`, which is not granted, so the folder was made by hand in
the Lark UI. **Moving** only needs `space:document:move`, which is granted, so `bin/organize.js`
did the rest.

Two things this surfaced, both fixed:

- **A named folder is paginated; Drive root is not.** Root listing returns every entry in one
  response, but a folder caps at 100 per page. Without `--page-all` the hub would silently see
  only the first 100 files, quietly weakening dedupe — the kind of bug that produces duplicates
  rather than errors.
- **One move reported a network timeout but had actually applied.** `read tcp … operation timed
  out` came back for one file, yet verification found it already in the folder. So treat a
  timeout on a Lark write as *unknown*, not failed: re-check state before retrying, or a retry
  may duplicate work. `bin/organize.js` is idempotent — re-running it moves only what is still
  outside the folder.

`lib/lark.js` also stops inheriting the CLI's stderr, which was leaking pagination progress lines
into command output; stderr is now captured and surfaced only when a call fails.

---

## Integrated with competitor-screenshot-insights-android (2026-09-07)

The capture side is that Skill, not a custom app — it drives a physical Android phone over adb and
writes an ordered journey to disk. So the hub does not need its own capture code; it needs a
bridge and a read API.

```
Android phone ──adb──▶ the Skill ──▶ screenshots/<slug>/NN-step.png + target.json
                                              │
                                    bin/ingest-journey.js
                                              ▼
                                    Lark Drive (Paparazzi folder)
                                              ▲
        Figma plugin ──▶ bin/serve.js (localhost:8899) ──┘
```

**`bin/ingest-journey.js`** reads a journey folder, derives the app and bundle id from
`target.json`, preserves frame order, and ingests each frame with dedupe. Verified on the real
`tripcom-novotel-bsd-2026-09-04` capture: 9 frames, all stored, and re-running skips all 9 at
1.000 — the ingest is idempotent.

**`bin/serve.js`** is the proxy, running locally. Lark needs an `Authorization` header and sends
no CORS headers, so a plugin iframe cannot call it; this sits on the machine that already has an
authenticated `lark-cli`. **No cloud compute is needed for a single operator** — the earlier
blocker only applies to serving a whole team.

| Endpoint | Purpose |
|---|---|
| `/v1/health` | folder, count, threshold |
| `/v1/collections` | folder tree derived from the flat collection paths |
| `/v1/screenshots?collection=&platform=&app=&version=&tag=&step=&month=&q=` | search |
| `/v1/image/:id` | bytes, disk-cached (1.46s cold, 0.04s warm) |
| `/v1/live?after=<cursor>` | additions since a cursor, for follow mode |

The API deliberately exposes no Drive tokens and no signatures — verified. The plugin addresses
screenshots by `screenshot_id` and never holds a Lark credential, which matters because plugin
bundles are readable by anyone who installs them.

**`figma-plugin/`** is the v2 plugin: folder tree, live search, thumbnail grid, click-to-insert,
insert-all-in-order, and a follow toggle that polls `/v1/live`. Images are fetched as bytes and
rendered from blob URLs rather than `<img src="http://localhost">`, sidestepping mixed-content
rules. Journeys land as a labelled row so a reviewer reads them left to right.

Verified in a browser against the live hub: 9 of 9 shown, tree built correctly
(competitors → trip.com → novotel-bsd), search "checkout" → exactly 2 frames, platform `ios` → 0,
no console errors.

### The dedupe rule changed, on evidence

The single structural threshold did not survive real data. Frame `00-launch` scored **0.697**
against an unrelated seed screenshot — a false positive — while a same-layout-different-content
pair had measured **0.64**. Those ranges overlap, so no structural threshold separates them.

`dhash` does separate them: a content edit keeps the hash close, a different screen does not. The
rule is now **both** signals:

```
dhash <= 6                          -> same image, whatever the content edits
structural >= 0.85 and dhash <= 16  -> same layout, meaningfully different content
```

Re-verified across every measured case. This also fixed the mirrored-image false positive
(0.867 structural, dhash 19) that the old rule accepted.

### Two failures worth remembering

- **Split-brain writes.** `put()` uploaded to Drive root while the index read the configured
  folder, so the store saw an empty library. Uploads now always target the hub's configured home
  (`lib/lark.js` `uploadArgs`), because reads and writes disagreeing is silently destructive.
- **The index shrank twice** when files were deleted in the Lark UI. An empty corpus makes dedupe
  pass everything, so the next ingest would re-upload the whole library as "unique".
  `loadCorpus()` now refuses when the listing holds fewer screenshots than `last_known_count` in
  `hub.config.json`, naming the likely causes; `--allow-shrunk-index` accepts it deliberately.
  `bin/reindex.js` migrates filenames when the scheme changes.

---

## Multi-user contribution — the inbox pattern (2026-09-07)

Contributors need **no setup at all**: no repo, no Node, no `lark-cli`, no auth, no config. They
drop screenshots straight into the Paparazzi Drive folder from the Lark app they already have —
desktop or phone — and `bin/reconcile.js` does the rest.

```
colleague's phone ──Lark app──▶ Paparazzi folder (raw drop)
                                        │
                              bin/reconcile.js  (scheduled or on demand)
                                        │
                     attribute · dedupe · rename into the index · sidecar
```

Attribution is free: Drive's file listing reports `owner_id` per file, so the reconciler resolves
who uploaded each drop via `contact +get-user` and writes it into the filename as `u-<name>`.
That makes "my screenshots" a search (`u-stepfano`) and gives the live feed something to scope by,
without building any auth of our own.

The reconciler **renames the contributor's existing file** rather than re-uploading its bytes —
the blob is already in the right place, it just needs an indexed name and a sidecar.

Non-image files dropped into the folder are left strictly alone. A dropped duplicate is left in
place too, with a message naming the original, since deleting someone else's upload is not a
decision this tool should make.

Verified with simulated drops: a new screenshot was ingested and attributed
(`uploader=stepfano`, resolved from `owner_id`), and a re-drop of an existing frame was caught at
1.000 and left in place.

| Path to contribute | Setup per person | Attribution |
|---|---|---|
| **Drop into the Lark folder** | none | from `owner_id` |
| Run `bin/ingest.js` locally | repo + Node + own lark-cli auth | from their own OAuth |
| Hosted hub (future) | none | from the authenticated session |

One bug found here: `listRoot()` was dropping the `owner_id` the API returns, so the first
reconciled drop recorded `uploader=unknown`. Fixed; the mapper now carries `owner_id` and
`created_time`.

---

## Scheduled reconcile, and why the project lives outside ~/Documents (2026-09-07)

`bin/reconcile-cron.sh` runs every 10 minutes via a launchd agent
(`~/Library/LaunchAgents/com.traveloka.paparazzi.reconcile.plist`), so screenshots dropped into the
Drive folder are indexed without anyone running a command.

**The project had to move to `/Users/stepfano/paparazzi`.** `~/Documents` is TCC-protected on
macOS, so a launchd agent cannot read it — the job failed with `Operation not permitted` (exit 126)
while the identical script ran fine from a terminal. Moving the project out of the protected tree
fixes it with no Full Disk Access grant, which would otherwise have meant giving *every* shell
script on the machine access to every protected folder.

The wrapper handles the things a 10-minute job needs:

- **Explicit PATH** — launchd gives a minimal one, so `node` and `lark-cli` are located directly.
- **Lock via `mkdir`** (atomic; macOS has no `flock`) so a slow run cannot overlap the next tick;
  a lock older than an hour is treated as stale.
- **Quiet when idle** — nothing is logged unless work happened or something failed.
- **Named failure modes** — expired Lark auth and the index-shrink guard each get an explanatory
  line rather than a bare stack trace.
- **Log trimming** at 2000 lines.

Duplicates are renamed `dup-of-<id>__<original>` and excluded from future inbox scans. Without
that a rejected duplicate would be re-downloaded and re-reported every 10 minutes forever.

Verified: exit status 0, empty stderr, and a dropped screenshot ingested and attributed by the
scheduled run (`+ post-move-drop.jpg (Stepfano)`).

**Operational note:** the Lark refresh token expires 2026-09-14. After that the job fails until
`lark-cli auth login` is run again; the wrapper writes an explicit line saying so.

Paths that moved with the project: the launchd plist, `.claude/launch.json` (now an absolute path),
and the Figma plugin import path — **`/Users/stepfano/paparazzi/figma-plugin/manifest.json`**.

---

## Hub auto-starts at login (2026-09-07)

A Figma plugin cannot start a local server — its sandbox has no process-spawning, socket-listening,
or shell access, the same limit every web page has. So instead of "the plugin starts the hub", the
hub is a `launchd` agent that is already running by the time you log in, well before Figma opens.

`com.traveloka.paparazzi.hub.plist` runs `bin/hub-launchd.sh` with `RunAtLoad` (starts at login) and
`KeepAlive` (restarts on crash).

**`launchctl load` is not reliable for this.** It worked immediately after loading — verified with
a SIGKILL/respawn test — but the registration silently vanished some time later with nothing
logged anywhere (no denial in Background Task Management, no launchd log entry, plist still on
disk). `load`/`unload` are the legacy interface; on modern macOS the persistent form is
`launchctl bootstrap gui/<uid> <plist>` plus `launchctl enable gui/<uid>/<label>`. Re-registered
that way and re-verified the SIGKILL/respawn test — both times, killed PID -> new PID within
seconds, `/v1/health` answering again. Use `bootstrap`/`bootout`, never `load`/`unload`, for this
agent.

If "No hub" ever appears in the plugin with no other explanation, check registration first:
`launchctl print gui/$(id -u)/com.traveloka.paparazzi.hub` — a missing entry means it needs
re-bootstrapping, and that is a mundane launchd hygiene issue, not evidence about whether Figma's
sandbox can reach `localhost` (a still-open, separate question).

This is exactly why the project had to move back to `/Users/stepfano/paparazzi`: `~/Documents` is
TCC-protected from background launchd agents — we hit this identical wall with the earlier Lark
reconciler, moved out, then the user moved the project back into `Documents/Claude/RRI` for
unrelated reasons, which silently reintroduced the same block for this new agent. Confirmed clean
here: no TCC errors in `.launchd.err.log`, and the library's 11 screenshots were read correctly
immediately after `launchctl load`.

To stop it: `launchctl unload ~/Library/LaunchAgents/com.traveloka.paparazzi.hub.plist`
