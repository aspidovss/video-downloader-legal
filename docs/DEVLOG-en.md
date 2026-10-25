<!-- Development log (English translation of DEVLOG-ru.md): build history 1.4-1.6. The Russian original is the master copy. The main README is in English in the repository root. -->

# Video Downloader Legal (VDL)

An extension for Firefox (including Firefox for Android), Chrome and Microsoft Edge (Manifest V3): it finds the video on a page and saves it.
Author: AspidovSS · License: MIT · Current version: 1.6.7

## What it does

| Feature | Status |
|---|---|
| Direct files (mp4, webm, mp3 and others) by intercepting network responses | works |
| HLS (m3u8): quality choice, separate audio track, AES-128, fMP4, byte-range; TS is saved as MP4 without re-encoding | works |
| DASH (mpd): SegmentTemplate / SegmentTimeline / SegmentList / single file; video and audio are joined into one file without re-encoding | works |
| Vimeo and Dailymotion through the public endpoints of their players | best-effort |
| Instagram (reels, posts, stories) and Facebook: reading the page data, joining video with audio | best-effort |
| X / Twitter: HLS + GIF, only the videos on screen are listed in the feed | best-effort |
| Bilibili (.com and .tv) through the public API of the site, Canva (`/watch`), TikTok (the video on screen) | best-effort |
| OK.ru (parsing the player data on the page), VK and other sites through the general stream interception | best-effort |
| Live HLS streams (Twitch and others): recording with a stop button, limits by time and size | works |
| History, file name template, notifications, hotkeys | works (no hotkeys and no notifications on Android) |
| Keyboard shortcuts: open the popup, download the first video, download the audio of the first media; configurable on the settings page in Firefox | works (not on Android) |
| Sidebar with a toggle button in the popup and in the settings | Firefox for desktop only |
| YouTube: main method through the mobile clients (ANDROID_VR/IOS), joined into one file; fallback: recording during playback (video and audio are joined into webm, mp4, or mkv for VP9+AAC and AV1+Opus), recording of live streams | **works (checked on live YouTube); best-effort: YouTube changes often, the method may stop working** |
| Audio only: M4A/WEBM without re-encoding and MP3 (the lamejs encoder, built from source by `scripts/build-lamejs.mjs`) | works |
| Interface in 10 languages, terms of use on first start, debug log | works |
| DRM (Widevine, FairPlay, SAMPLE-AES, ContentProtection), encrypted YouTube `signatureCipher` formats, SABR streams | **not supported and not bypassed** |
| Batch download, playlists, subtitles, re-encoding (except MP3) | no |

No Native Messaging, no external servers, no telemetry (`data_collection_permissions: none`).

## Versions
- **1.5.0** — the first release of the 1.5 line: YouTube (two ways to get the links), a compact window with type/resolution choice, MP3, joining video and audio (DASH/HLS), the 🐞 diagnostics button (file + e-mail template), Instagram, Facebook, X, Bilibili, Canva, file names like `site_account_date_time`.
- **1.5.5 / 1.5.6** — Chrome, terms of use, 10 languages and manual language choice, live stream recording, TS→MP4, TikTok, debug log (see below).
- **1.6.0** — Microsoft Edge, Firefox for Android, YouTube subtitles, reasons why YouTube gives nothing, CC BY badge, joins into MP4 (Telegram), indexed joined files, configurable keyboard shortcuts, sidebar button, Kick, building lamejs yourself; context menu removed. The intermediate builds 1.6.0dev … dev7 are at the end of the log.

Details of every build are in the log below.

## Installation

**Firefox (desktop)**
0. **From the Mozilla catalogue (for regular users):** https://addons.mozilla.org/en-US/firefox/addon/video-downloader-legal/
1. **Quick check:** `about:debugging#/runtime/this-firefox` -> "Load Temporary Add-on" -> pick `manifest.json`. It disappears when Firefox restarts.
2. **Permanent installation (recommended):** sign it as *unlisted* on addons.mozilla.org (free), get the `.xpi` and open it in Firefox.
3. **Developer Edition / Nightly / ESR:** set `xpinstall.signatures.required = false` in `about:config`, then open the `.xpi`. This does not work in regular release Firefox.

Firefox MV3 does not grant access to sites automatically: after installing, open `about:addons` -> the extension -> "Permissions" and allow access to all sites. Minimum version: Firefox 140.

**Chrome and Microsoft Edge:** `node scripts/build-chrome.mjs` (or `npm run build:chrome` / `npm run build:edge` for a zip) -> `chrome://extensions` or `edge://extensions` -> developer mode -> "Load unpacked" -> the folder `build/chrome`. Needs Chrome or Edge 116+. Edge runs the Chrome package unchanged.

**Firefox for Android (142+):** an unsigned `.xpi` cannot be installed. For testing: USB debugging, then `npx web-ext run --source-dir <unpacked package> --target firefox-android --android-device <id> --firefox-apk org.mozilla.firefox`. A permanent installation comes from the AMO catalog after publication.

## Development

Structure:

```
manifest.json
service/main.js          background script: interception, manifest parsing, downloads, history, commands (shortcuts)
service/headers.js       header rules (declarativeNetRequest in Chrome), the shared ytHdr object
service/offscreen-client.js  a stub for Firefox (replaced by the file from platform/ in the Chrome build)
platform/                Chrome/Edge only: sw.js (service worker), shim.js (browser.*), offscreen.* (Blob links and MP3), offscreen-client.js
lib/hls.js               m3u8 parser + AES-128
lib/dash.js, xmlmini.js  MPD parser and a mini XML parser for the service worker
lib/downloader.js        segment download (parallel, retries, cancel, size limit)
lib/mux.js               fMP4/WebM parsing and joining video+audio (shared by the background and the page)
lib/ts2mp4.js, rebase.js MPEG-TS -> MP4 and timestamp shifting without re-encoding
lib/liverec.js           recording of live HLS streams
lib/youtube.js, ytapi.js building the quality variants, /player requests of the mobile clients, diagnostics
lib/mp3.js               MP3 (calls the lamejs encoder, size estimate)
lib/shortcuts.js         keyboard shortcuts: Firefox format, key press parsing
lib/sites.js             Vimeo, Dailymotion
lib/util.js, env.js, consent.js, debuglog.js, blobstore.js, sitediag.js, mp4info.js  helpers
injected/                page scripts: page.js (video/audio scanner), youtube*.js, tiktok*.js, instagram.js, x.js, ok.js, canva.js
content/                 the window (popup, also the sidebar), history, settings, help
utils/                   settings and history (storage.local), DOM helpers, i18n
vendor/lame.js           the MP3 encoder (lamejs 1.2.1, LGPL-3.0), built by scripts/build-lamejs.mjs
scripts/                 build-chrome.mjs (Chrome/Edge package), build-lamejs.mjs (encoder build)
LICENSES/, THIRD-PARTY.md  license texts and information about third-party code
AMO/, EDGE/              publishing material (not part of the extension package)
tests/                   node --test (205 tests; some use ffmpeg and are skipped without it)
```

Commands: `npm test`, `npm run build` (the Firefox `.xpi`), `npm run build:chrome`, `npm run build:edge`, `npm run build-lamejs`, `npm run verify-lamejs`.

## YouTube: how it works and what it risks

**Main method (since 1.4.0).** The extension asks YouTube for the video data itself, but as the app clients `IOS`, `IOS_VDL` (an extra iPhone profile), `VISIONOS`, `ANDROID_VR` (a request to `/youtubei/v1/player`). These clients return ordinary stream links without SABR. The client data are public identifiers of the YouTube mobile apps. The links are downloaded in 5 MB pieces. Video and audio are **joined into one file** after the download, without re-encoding. Requests from the extension to YouTube are sent with the User-Agent of that client (through `webRequestBlocking`, only for the extension's own requests; pages are not affected).

- **Check before choosing a client.** YouTube gives `IOS` and `ANDROID_VR` links that are cut off with 403 after ~20 MB (no PO token). So for every client the extension requests one byte at the start, at 10/20/30 MB and at the end of the file. A client with cut-off links is skipped. If all are cut off, the variants larger than the limit are marked ">20 MB" and are not downloaded, the others are available.
- **What works in practice (checked by the user).** Without signing in, YouTube answers `VISIONOS` and `ANDROID_VR` with "Sign in to confirm you're not a bot"; `IOS` 21.x gives only SABR. `IOS` 20.x gives links that are cut off after ~20 MB: audio and short videos download directly, long videos have to be recorded (the record button).
- The clients and their order are set in the settings; you can add your own client as JSON there. Versions and User-Agents get old, so the settings have JSON overrides: if YouTube stops answering, update the version without updating the extension.
- The `n` parameter and the PO token are **not computed and not forged**. If YouTube refuses (HTTP 403), the extension says so and offers the fallback method.
- No cookies: the mobile clients do not use them. Age-restricted and private videos should be taken by recording.
- The diagnostics ("Copy YouTube diagnostics") show, for each client, the HTTP status, the playability status, the number of formats and the **names** of the link parameters without values.

The **fallback method** is described below: recording during playback.

What to know:
- This violates the YouTube terms unless the rights holder allows it. The responsibility is yours.
- **Checked on live YouTube, works.** But YouTube changes often, and the method may stop working later: client versions, token and header requirements may break. Send the diagnostics if the method does not work.
- The option "YouTube: allow only Creative Commons videos" blocks the others (the license is read from the page metadata; if it cannot be determined, the video is counted as non-CC).

### YouTube: the "Record during playback" mode (v1.3.0)

The diagnostics on Firefox 158 showed that the player goes only through SABR (POST requests, no direct links), so the formats cannot be downloaded by links. Instead, the extension can **record what the player itself downloaded and handed to `MediaSource`**:

1. Open the video and press "Record during playback" in the extension window. The page reloads and the video plays to the end, muted, at accelerated speed (the "recording speed" option, 2x by default; Firefox limits it to about 5x).
2. Do not close the tab while recording. The player chooses the quality.
3. When the recording is ready, press "Save file": video and audio are joined into **one file** without re-encoding (webm+weba into webm, mp4+m4a into mp4; VP9+AAC and AV1+Opus into mkv, since 1.5.1debug15 and 1.6.0dev1). If joining failed, two files are saved (the audio with the suffix `.audio`). The "Audio only" button saves the audio track separately (`.weba` or `.m4a`).

Limits: DRM content is rejected; ads are dropped; the size limit comes from "max stream size"; the data is kept in the tab's memory. Checked on live YouTube, works; but YouTube changes, and the recording may stop working later. If it does not work, send the diagnostics.

## Limitations (honestly)

- HLS/DASH are assembled in the browser's memory and handed over as one file; the default limit is 4096 MB (configurable). A phone has less memory, long streams may not fit.
- Video and audio of the same container are joined without re-encoding (DASH, HLS with a separate audio track, YouTube recording). When joining is impossible, two files are saved: `name.ext` and `name.audio.ext`. Direct YouTube download picks audio of the same container; mixed containers are joined only by the recording from the player (VP9+AAC and AV1+Opus into mkv).
- HLS in TS format is converted to MP4 without re-encoding if the codecs are H.264 + AAC and the file is not larger than ~700 MB; otherwise a `.ts` is saved.
- Only the first Period is taken from DASH.
- For sites with special headers the extension sets `Referer`/`Origin` only for the known addresses (YouTube, TikTok, Bilibili, live HLS) with header rules; for the others a 403 is possible.
- Firefox for Android: no context menu, keyboard shortcuts, notifications and sidebar, no "Open folder" buttons; the features on a real phone had not been checked by the author as of 1.6.0dev2.
- Site support was checked on live pages (Firefox, Chrome, Edge), but sites change, and the support may stop working; in that case send the diagnostics.
- DRM content is not supported and not bypassed.

## Legal side

Save only what you are allowed to save. Following the rules of the sites is your responsibility.


## History (highlights only)

Details of every build are in `CHANGELOG.md` and the git history.

- **1.4.3 – 1.4.4.** YouTube links via API clients (VISIONOS → ANDROID_VR → IOS), no `cookies` permission; download in 5 MiB pieces; "Audio only" mode (M4A/WEBM without re-encoding, MP3 via lamejs); recording from the player as a fallback.
- **1.4.5.** Requesting YouTube from inside the page became the main method (request from the background is the reserve). Compact window: type, resolution, size; default preferences. Other sites: DASH and HLS, video always with sound (joined without re-encoding). Instagram, Facebook, X, Bilibili, Canva, Vimeo. 🐞 diagnostics.
- **1.5.0.** Interface in 10 languages.
- **1.5.1.** Recording of live HLS streams (Twitch etc., YouTube in beta), hints when a site limits requests.
- **1.5.2.** TS to MP4 conversion without re-encoding (`lib/ts2mp4.js`).
- **1.5.5.** Chrome / Chromium (MV3: service worker, offscreen document, `declarativeNetRequest`); terms of use on first launch; manual interface language; settings in blocks; "Creative Commons only" by default; licenses (`LICENSE`, `THIRD-PARTY.md`, `LICENSES/`).
- **1.5.6.** Debug log (off by default).
- **1.6.0dev.** Microsoft Edge (the Chrome build unchanged); Firefox for Android; reproducible lamejs build (`vendor/lame.js`, `scripts/build-lamejs.mjs`); Mozilla validator warnings fixed; copyright check and LGPL-3.0 text verified (against ftp.gnu.org).
- **1.6.0dev1.** AV1/H.264 + Opus joined into one `.mkv` without re-encoding (`mergeMp4Opus`). FFmpeg deliberately not used: 25–30 MB core, harder AMO review, patents and GPL builds, phone memory. If re-encoding is ever needed, look at WebCodecs.
- **1.6.0dev2.** Sidebar button (Firefox only); configurable shortcuts (open popup, download video, download audio); Chrome rejects a manifest with Ctrl+Alt shortcuts, a test guards this. AMO validator: no errors or warnings. 205 tests.
- **1.6.0dev3.** Log trimmed; "Hotkeys" block inside "General"; new package names (`-ff-`, `-chrome-`, `-edge-`); separate "VDL DEV" add-on for AMO signing (`npm run build:dev`, branch `1.6.0dev_amo` kept local).
- **1.6.7 (release).** Captions on a GIF in the converter: a white bar (top / bottom / both), text on the video (white or black; top / center / bottom), a demotivator (frame, title and a second line), with a preview. Goes to AMO together with 1.6.6 (converter, Edge fix): 1.6.6 was only on GitHub. 297 tests.
- **1.6.7dev1.** Captions on a GIF in the converter (`lib/caption.js`): "White bar" — top, bottom or both, black bold text (Arial Black); "Text on the video" — white with a black outline or black with a white one (Impact), top / center / bottom; "Demotivator" — the video in a white frame on black, a big title and a second line in a serif font. The font size is fitted and the text wrapped by itself (bar and text on the video up to 3 lines, demotivator 2 each); Enter starts a new line. A preview on the player's current frame at the GIF's size. Only the style and position are remembered, not the text. `videoToGif` got `compose` (background, frame, video, text on every frame; static parts cost almost nothing as unchanged pixels are transparent). The size estimate counts the caption. 297 tests; checked in Chromium on both of the author's examples.
- **1.6.6 (release).** Builds 1.6.6dev1 … dev2: file converter (GIF, MP3, PNG frame, TS → MP4 / MKV, fragmented MP4 → MP4; the button right after "Settings" and "Convert…" in History), Edge header rules fixed. 289 tests.
- **1.6.6dev2.** File converter: the 🎞️ button in the popup (right after "Settings") and "Convert…" in History open `content/convert.html`. The file is picked or dropped (an extension cannot read the downloads folder itself; from History the file name is shown, with "Show in folder"); everything runs in the page, nothing is uploaded. Outputs: GIF (width, FPS, "from–to" part, rough size, time left; up to 180 s), MP3 (bitrate, part; files up to 30 min), a PNG frame (a time or the player's current frame), TS → MP4 / MKV and fragmented MP4 → plain MP4 without re-encoding. A player on the page; the "Now" buttons take its time. Saved through the browser's downloads (with "Save as" when that is on), on Android through a link. Logic in `lib/convert.js`; `videoToGif` got `start` / `end`. 289 tests; checked in Chromium: WEBM → GIF / MP3 / PNG, TS → MP4 / MKV, fragmented MP4 → MP4, OGG → MP3.
- **1.6.6dev1.** Edge: the header rules (Referer for JoyReactor and servers answering 403/412, TikTok, Bilibili, YouTube) never applied. Checked in Edge's service worker console: a rule with `tabIds: [-1]` does not match, one with `initiatorDomains: [extension id]` and type `xmlhttprequest` does (Edge does not give the extension's requests tab -1). The rules are now limited by the extension's id only (page requests are still never touched); without an id (tests) still tab -1. 281 tests.
- **1.6.5 (release).** Builds 1.6.5dev1 … dev3: "GIF" settings block (on for all sites, length limit, sites and exceptions as regular expressions, default width and FPS); in the card every width, an FPS list, the rough size, the time left while converting. 281 tests.
- **1.6.5dev3.** The GIF card always offers every width (640 / 480 / 320 / 240 px); the settings have "Default GIF width" instead of width ticks (chosen in the card at first, 480 px by default). 281 tests.
- **1.6.5dev2.** Card: a GIF made from the video has a frame-rate choice next to the width (5 / 8 / 10 / 12 / 15, default from the settings); the "· from video" label is gone; when the GIF can be made from more than one file: "480px · WEBM", "480px · MP4". 281 tests.
- **1.6.5dev2.** GIF-from-video card: a third list "FPS" (5 / 8 / 10 / 12 / 15, default from the settings; "FPS" in every language), "· from video" removed, with several sources "480 · WEBM" / "480 · MP4". Under the row, the rough GIF size (`~4 MB`): width × height (from the cover's shape, else 16:9) × length × FPS × 0.25 byte per pixel (measured on the own encoder: calm pictures 0.02–0.1, ordinary video 0.1–0.3, much motion up to 0.5). While converting, the time left: "GIF 44% · ~15 s left" (from the pace of the frames). 281 tests; layout checked in Chromium.
- **1.6.5dev1.** "GIF" block in the settings (sub-block of "Downloads"): "GIF from video" is on for all sites by default (1.6.4's "off" is kept, "JoyReactor only" becomes all sites); "At most, seconds" 1–180 (default 60); "Sites for GIF" and "Except sites" as regular expressions, one per line, matched against the page's host, then the video's, case-insensitive, # lines are notes, a broken line is highlighted and blocks saving, and is skipped at work; widths 640 / 480 / 320 / 240 px (ticks) and 5–15 fps. Logic in `lib/gifrules.js`. Checked in Chromium (block layout, expression error, saving). 281 tests.
- **1.6.4 (release).** Builds 1.6.4dev1 … dev11: download speed and time left, TS streams as MKV, GIF from video (Firefox, Chrome, Edge), JoyReactor, PornHub, requests repeated with the page's Referer (403 / 412 / 404 without Referer), updater package for Chrome and Edge (GitHub release check), FFmpeg in the tests described in THIRD-PARTY.md and README. Checked by the author in Firefox and Chrome. 278 tests.
- **1.6.4dev11.** GIF from video in Chrome and Edge: frames are read and encoded in the offscreen document (it has `<video>` and a canvas; the same `lib/gifvideo.js` as in Firefox's background page), the video and the result go through IndexedDB, progress by messages. JoyReactor's "video with sound" badge (`/images/videowithsound.mp4`) is no longer listed as a video. Checked in Chromium: WEBM → 320 px GIF, 60 frames. 278 tests.
- **1.6.4dev10.** Chrome/Edge and JoyReactor: the pictures server answers 404 without the site as Referer (checked in Chrome's console: with Referer 206, without 404; cookies and Origin do not matter). Fixed: (1) the browser's own downloads (`downloads.download`) in Chrome get no header rules — a file of such a server is now fetched by the extension and saved from memory; (2) the list of page Referers is kept in `storage.session` and restored after the background slept (the rules used to vanish after sleep); before a JoyReactor download the rule is set again; (3) rule domains are plain host names only (one bad entry broke Chrome's whole rule set); (4) a file the page loaded itself is not marked missing by a probe. 278 tests; checked in Chromium with a local "JoyReactor".
- **1.6.4dev9.** #62: a separate "updater" package for Chrome and Edge (`video-downloader-legal-chrome-updater-<version>.zip`, `…-edge-updater-…`; `npm run build:chrome-updater`, `build-chrome.mjs --updater`). Once a day, when the service worker wakes, it looks at the latest GitHub release (`api.github.com/…/releases/latest`, no cookies, no extra permission); the popup shows "Version X is available: Download / What's new / ✕" (download = the updater archive of that browser from the release, else the release page). Settings of this package only: "Notify about new versions", a note that the package checks for updates by itself, "Check now" and the last result. The regular Chrome/Edge packages and Firefox check nothing. PRIVACY.md and README updated. Checked in Chromium: popup notice, switching off, settings, network error. 277 tests.
- **1.6.4dev8.** JoyReactor: the page names both MP4 and WEBM, but for some posts the server has no MP4 (404) — such a file is no longer offered (the size probe marks it missing), and the default is the one that is there. GIF from video — from every available video ("480px · from WEBM", "480px · from MP4" …). The extension's requests to the pictures server carry the site's page as Referer, like the player's. Card: when the chosen format has one choice, there is no second list, only the size. The name from the tags keeps `_` (`s_nobody`). 274 tests.
- **1.6.4dev7.** JoyReactor: the files of one post (`…/pics/post/webm/<tags>-<id>.webm` and `…/mp4/…mp4`) are one card with MP4 / WEBM / GIF instead of two cards called "Homepage - funny pictures…"; the name comes from the file's tags without the service ones (`videogif-gif-parrot` → "parrot"). The post's original GIF is looked for next to them (`…/pics/post/<tags>-<id>.gif`, then `/full/`) with a probe and shown only when the server answers with `image/gif` (`lib/joyreactor.js`). GIF from video: own GIF encoder (`lib/gif.js`: 255-colour palette per frame by median cut, unchanged pixels transparent, only the changed box stored, LZW) and frame-by-frame reading of the video with `<video>` + canvas in the Firefox background page (`lib/gifvideo.js`: 10 fps, 480 or 320 wide, up to 60 s, no sound; from the WEBM, else the MP4). Setting "GIF from video": JoyReactor only (default) / on all sites / off. Chrome does not offer GIFs made from video (a service worker has no document). 274 tests; checked in Chromium: 6 s WEBM → 60-frame GIF in ~3 s.
- **1.6.4dev6.** TS streams (H.264 + AAC) can be saved as MKV without re-encoding: the card offers MP4 / MKV / TS, the settings have "Save TS streams as" (instead of the "Convert TS to MP4" checkbox; the old "off" becomes TS). The default format comes first and is what a hotkey takes. MKV is written from the same frames as MP4 (`convertTsMkv` in `lib/ts2mp4.js`, `writeMkvAvcAac` in `lib/mux.js`) with an index (Cues) for seeking; other codecs (HEVC etc.) keep the TS file. WEBM is not offered for TS: TS in HLS carries only H.264/HEVC with AAC/MP3/AC-3, which WebM cannot hold without re-encoding. 270 tests.
- **1.6.4dev5.** The download row shows the current speed and the approximate time left next to the percentage: `21% · 3.4 MB/s · ~2 min left` ("estimating…" at first). Speed is bytes over the last ~5 s, the time left comes from the pace of finished parts (HLS/DASH segments or 4 MB pieces), so it works without a known size (omgjav: 1803 segments). Not shown while joining / MP3 and for live recordings. `lib/rate.js`, 267 tests.
- **1.6.4dev4.** A file served by a storage script (KVS: `remote_control.php?file=….mp4&acctoken=…`) was saved as `cdn-08_viidoos_com_cdn-08_viidoos_com_….php` although it is an ordinary MP4 (366 MB, 720p, 29.5 min). The file extension now comes from the address only when it is a media type, else from a query value (`file=….mp4`), else from the server's type (`mediaExt` in `lib/util.js`); a page without a title is named after the page's site, not the storage host, and the site is not written twice. Slow direct files (dojki.tv: 245 KB/s — the server's per-connection limit) — left as they are, the author's decision. 262 tests.
- **1.6.4dev3.** Author's check: MP4 1080p downloaded (219 MB in 27 s), but the site limits MP4 720p (`rate=500k` in the address) — without progress the download looked stuck. pornhub only: the default is now **HLS of every quality** from the page data (`mediaDefinitions` → `format: hls`): one card, each quality is its own master playlist read at download time; quality sizes are estimated from the MP4 of the same quality. The MP4 list goes under "More". MP4 with a known size is fetched in 4 MB pieces in parallel (progress, faster where each connection is limited). The playlist the player fetched is a separate card under "More" (entries from site data have their own stable id). 260 tests.
- **1.6.4dev2.** Author's check: downloading from pornhub works (HLS 240p, 45 MB, MP4 with an index), but the site's HLS has one quality — the one playing. Now the MP4 files from the page data are **one card with a quality choice** (1080p / 720p / 480p / 240p with sizes: the first byte of each file, `Content-Range`), the chosen one is downloaded; with such a card, HLS with one quality goes under "More". Plain files can now carry a quality list (`variants`). Fixed: when the player asked for the playlist before the page script reported the page, the Referer for the retry comes from the request itself (`documentUrl`). 260 tests.
- **1.6.4dev1.** Servers that answer the extension 403 / 412 but serve the page's player (pornhub: `*.phncdn.com`, HTTP 412): the playlist and pieces are asked again with the page's `Referer` / `Origin` — `hdr.setRef` in `service/headers.js`, a blocking `webRequest` in Firefox for the extension's own requests only, a DNR session rule in Chrome; not enough — through the page (`vdl_fetch` in `injected/page.js`, Firefox `content.fetch`). What worked goes to the debug log. PornHub page module (`resolvePornhub` in `lib/sites.js`): `flashvars_*` → `mediaDefinitions` → `/video/get_media` — MP4 of every quality with title, cover and length; such files are fetched by the extension itself. An empty `<source src="">` (the page's own address) is no longer a card. Idea for later: update check on GitHub for Chrome/Edge. The approaches were seen in another extension (proprietary licence, view only) — the code is our own. 259 tests. Firefox build only.
- **1.6.2 (release).** The same code as 1.6.1: on AMO version 1.6.1 was uploaded by mistake from an early test build (1.6.1dev2), and AMO never accepts a version number twice.
- **1.6.1 (release).** Builds 1.6.1dev1 … dev7: subtitle settings, Firefox for Android saves files, Low-Latency HLS as one card, separate video and sound without a master into one MP4, feeds of short videos, fMP4 with an index, .xpi/.zip writer without zip/tar. Checked by the author on the phone (Firefox 160, Android 15) and on the desktop. The "?" buttons of the settings on the phone are round again (36 px) and stay at the right of their line — touch screens and Firefox for Android only, the desktop is unchanged. Open: long LL-HLS recordings.
- **1.6.1dev7.** HLS fMP4 with video and sound in one playlist (xhamster: AV1 + AAC, an init with two tracks) was saved as moof/mdat pieces without an index — players seeked badly. `defragMp4` in `lib/mux.js` reads every traf/trun of every moof and writes the same samples with `writeMp4` (index first, tracks interleaved in ~0.5 s chunks); checked on the author's file (412 s, 1080p, 82 MB): the same packets (framemd5), 0.4 s. Single fMP4 files from HLS/DASH and live recordings are saved the same way. Android: the save link is clicked without being put into the page (m.youtube.com caught the click and opened the video in a new window). 253 tests.
- **1.6.1dev6.** Android, after the author's check: saving through the page works (files of 5.6 and 9.9 MB). The "Download file?" dialog sometimes vanished at once — the file was handed to the tab while the popup was on top of it; now the tab waits until it is on screen again (`visibilitychange`) and saves the files one by one 1.5 s apart; while it waits, a notification says to go back to the video page. The Settings, History and Help buttons of the popup on Android open a new tab and close the popup (the settings used to open behind the popup until "Back"); the "Open folder" button is hidden on Android.
- **1.6.1dev5.** Firefox for Android: the log from the phone (Firefox 160, Android 15) showed that `downloads.download()` never answers — the downloads API on Android is not connected to the browser's download manager (Mozilla bug 1793214). Now on the phone the finished file is handed to the page of the video (`tabs.sendMessage` with the Blob) and `injected/page.js` saves it with an `<a download>` link, like any page download; direct files are fetched into the extension first. .srt and diagnostics files are saved the same way. The tab of the video must stay open until the end. 252 tests.
- **1.6.1dev4.** Firefox for Android: a job stayed at 100 % and the file was not saved. Handing the file to the browser is limited to 60 s (else an error with the reason), the download state is asked every 2 s via `downloads.search` (the `onChanged` event may not come), a download that has not started in 2 minutes counts as interrupted; every step goes to the debug log. The cause on the phone is still to be found from the log. Build: on Windows the built-in `tar` wrote a tar archive (not a zip) for an `.xpi` name and AMO answered "Invalid or corrupt add-on file"; now .xpi/.zip are written by `scripts/zip.mjs` in plain Node.js, without zip or tar.
- **1.6.1dev3.** Feeds of short HLS videos (like TikTok, but not tied to a site): `injected/page.js` reports every `<video>` of the page — cover, direct address, on screen or not, playing or not; `lib/feed.js` matches a playlist to a video by file name (the media file name or a folder of the playlist address = the cover name without `-poster`, `-mobile` etc.). The card gets the cover and its own name ("Weekly Skyblue Chick" instead of the page title, also used for the file name); playlists of videos not on screen go under "More", and the main card follows the scrolling. Diagnostics: `feed` (how many videos, with a cover, on screen) and `feedMatch` for playlists. 251 tests.
- **1.6.1dev2.** Low-Latency HLS: the player asks for the same playlist again with new `_HLS_msn` / `_HLS_part` — now that is one card and the address is kept without these parameters (it was up to 60 cards). Video and sound as separate playlists with an unreadable master (a one-time token answers 403 to a second request): `lib/hlsgroup.js` puts the playlists of one folder into one card — track type, size and codec from the init segment (`describeInit` now reads width and height), bitrate from the last segment; qualities by height, each joined with the sound, recorded as two streams and saved as one MP4. The single playlists and the unreadable master go under "More"; the badge counts only the main cards. Not tied to any site. 248 tests. Firefox build only.
- **1.6.1dev1.** Subtitles can be switched off: a *Subtitles* block in the YouTube settings — "YouTube subtitles" (off: no row in the card, no tracks looked up or saved), "Save subtitles with the video" (the same tick as in the card) and "\"SRT\" button — subtitles only". The tick in the card is now "+ with video"; without it no subtitles are saved with the video, with it also when downloading by a keyboard shortcut (the default track is taken, `defaultSubs` in `lib/subs.js`). 242 tests.
- **1.6.0 (release).** The builds dev … dev7 became version 1.6.0: `version_name` without `dev`, one section in `CHANGELOG.md`, AMO description and release notes (`AMO/listing-en.md`, `AMO/listing-ru.md`), reviewer notes, `npm run build:amo` (`scripts/build-amo-dev.mjs --release`) makes the package, the source archive and the AMO form text. Firefox for Android has not yet been checked by the author on a real phone.
- **1.6.0dev7.** Kick / Amazon IVS (`*.live-video.net`): single-quality playlists without a quality list go under "More" when the main playlist is there (like Twitch, but not hidden completely). Open question: in a Kick live recording after TS→MP4 some frames are a few bytes short (decoder errors in the bottom rows); the raw .ts is needed to compare.
- **1.6.0dev6.** Joins of different containers are written as an ordinary MP4 (`writeMp4` in `lib/mux.js`: moov first, ~0.5 s chunks; Opus in MP4 — `Opus` + `dOps` from OpusHead, packet durations from the TOC; VP9 from WebM — `vp09` + `vpcC` from the keyframe header; AV1 from WebM — `av01` + `av1C`). Reason: Telegram Desktop test of 17.10 — any MP4 and WEBM goes as a video, MKV as a document; the author checked "The Wait" recording as MP4: video, sound, seeking. MKV is the `joinFormat` setting. *Ignore files smaller than* is 150 KB again (one-time migration from 10). AMO link in the README, the log and the help page. 240 tests.
- **1.6.0dev5.** YouTube subtitles (`lib/subs.js`: the track list from the API clients and the page, timedtext json3 → SRT, a YouTube translation into the interface language; a D_WEBVTT/SUBTITLES track inside .webm, else an .srt next to the video). Why YouTube gave nothing (`lib/ytverdict.js`: status codes first, then the reason text in en/ru) and a `verdict` field in the diagnostics. CC BY badge. Indexed .webm join, cluster by cluster. Context menu removed (and the `contextMenus` permission). Diagnostics panel: ✕, tied to the page, buttons do not move. AMO builder `scripts/build-amo-dev.mjs`. Subtitles on live YouTube cannot be checked in this environment (no access to the site): the author checks them.
- **1.6.0dev4.** Joined .mkv files (AV1/H.264 + Opus, VP9 + AAC) are written by one shared `writeMkv` in `lib/mux.js`: known Segment size, SeekHead, Cues on the clusters with keyframes, video and sound in the same clusters (a new cluster at a keyframe, at least every 5 s). Before, the sound came in separate 10-second clusters and could start late after a seek. Checked on the user's recording (AV1 1280×720 + Opus, 60 s): a seek to 45 s reads 230 KB instead of 3.5 MB, all 1440 frames and 3000 audio packets are there. 210 tests.

## Tools used by tests
- `ffmpeg`/`ffprobe` are needed only by tests (`tests/*.test.js` generate reference files with them). They are not part of the extension package, are not linked to the code and are not distributed, so they are not listed in `LICENSE`/`THIRD-PARTY.md`. It is a developer's external tool (its license, LGPL/GPL, depends on the build).

## Open questions and notes for the future
- **Android:** test on a real phone (install, download, HLS, MP3, hidden UI elements).
- **Chrome / Edge:** a side panel via `sidePanel` — not planned for now.
- **Players:** the Windows player may need the "AV1 Video Extension" from the Microsoft Store for AV1.
- **Subtitles:** covered by tests; the author checks them on live YouTube (timedtext may need the player's token — turning subtitles on in the player for a couple of seconds helps then).
