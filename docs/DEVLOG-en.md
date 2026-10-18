<!-- Development log (English translation of DEVLOG-ru.md): build history 1.4-1.6. The Russian original is the master copy. The main README is in English in the repository root. -->

# Video Downloader Legal (VDL)

An extension for Firefox (including Firefox for Android), Chrome and Microsoft Edge (Manifest V3): it finds the video on a page and saves it.
Author: AspidovSS · License: MIT · Current version: 1.6.1 (`version` and `version_name` 1.6.1 in the manifest)

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
