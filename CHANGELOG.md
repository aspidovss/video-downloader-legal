# Changelog

Added features per version (fixes and internal changes are not listed). Version history before 1.5 is condensed from the development log; the short development log is in [docs/DEVLOG-en.md](docs/DEVLOG-en.md) (English) and [docs/DEVLOG-ru.md](docs/DEVLOG-ru.md) (Russian).

## 1.6.4

### Added
* **Servers that refuse the extension (HTTP 403 / 412)** but serve the page's player: the playlist and the pieces are asked again with the page as Referer / Origin (only the extension's own requests), and if that is not enough, through the page itself (its address and cookies).
* **PornHub watch pages:** one card with HLS of every quality (the default, fast) from the page's own data (title, cover, length; sizes estimated from the MP4 files), the MP4 files of every quality under *More*; saved with the page as Referer. MP4 files with a known size are fetched in parallel pieces with progress.
* **Updater package for Chrome / Edge** (`…-chrome-updater-<version>.zip`, `…-edge-updater-…`): checks GitHub for a new release once a day and shows a notice in the popup; can be switched off in the settings.
* **JoyReactor:** one card per post with MP4 / WEBM / the original GIF, named after the post's tags.
* A format with only one choice in the card shows its size instead of a second list.
* **GIF from video** (Firefox, Chrome, Edge): short videos (up to 60 s) can be saved as an animated GIF made in the browser (480 or 320 px, 10 fps, no sound); setting *GIF from video*: JoyReactor only (default) / all sites / off.
* **TS streams as MKV** (Matroska) without re-encoding: the card offers MP4 / MKV / TS; the default is set in the settings (*Save TS streams as*, replaces *Convert TS to MP4*).
* **Speed and time left** next to the percentage while a stream or a file in pieces downloads: `21% · 3.4 MB/s · ~2 min left`.

### Fixed
* A video served by a script (`…/remote_control.php?file=….mp4`) is saved as `.mp4` (not `.php`), named after the page's site instead of the storage server.
* An empty `<source src="">` on a page is no longer offered as a "file" (it was the page's own address).
* JoyReactor: a file the page names but the server does not have (404, e.g. the MP4 of some posts) is not offered; the site's "video with sound" badge is not listed as a video.
* Chrome / Edge: servers that want the page as Referer (JoyReactor) — files are fetched by the extension, as the browser's own download gets no header rules; the page Referers survive the service worker going to sleep; one bad entry no longer breaks all header rules.

## 1.6.2

The same code as 1.6.1, under a new version number: on addons.mozilla.org version 1.6.1 was uploaded by mistake from an earlier test build (1.6.1dev2), and AMO never accepts a version number twice. Everything listed under 1.6.1 is in 1.6.2.

## 1.6.1

### Added
* **Subtitles in the settings** (YouTube → Subtitles): *YouTube subtitles* on/off (off: no Subtitles row in the card, nothing is looked up or saved), *Save subtitles with the video*, *"SRT" button — subtitles only*.
* **Firefox for Android saves files:** the downloads API of Firefox for Android does not reach the browser's download manager (Mozilla bug 1793214), so the finished file is handed to the page of the video and saved like a page download ("Download file?" when the tab is on screen again).
* **HLS with separate video and sound playlists** (Low-Latency HLS and others) when the master playlist cannot be read: one card with the qualities; the recording has sound and is saved as one MP4.
* **Feeds of short HLS videos:** a card gets the video's cover picture and name; videos that are not on screen go under *More*.

### Changed
* HLS / DASH files that came as fragmented MP4 (video and sound in one playlist) are saved as an ordinary MP4 with the index first: players seek in them at once.
* Low-Latency HLS: the playlist the player asks for again and again (`_HLS_msn`, `_HLS_part`) is one card instead of a new one every second.
* Firefox for Android: Settings, History and Help open in a new tab on top (the settings used to stay behind the popup); no "Open folder" button; the "?" buttons of the settings are round again (36 px) and stay at the right of their line.
* The tick in the Subtitles row reads *+ with video*. Subtitles are saved with a video only when it is ticked — then also for a download by keyboard shortcut (with the default track).

### Fixed
* AMO upload packages built on Windows: `.xpi` / `.zip` are written by `scripts/zip.mjs` (Windows `tar` made a tar archive for an `.xpi` name, refused by AMO as corrupt).

The steps (1.6.1dev1 … dev7) are described in the development log.

## 1.6.0

### Added
* **Microsoft Edge and Firefox for Android.** The Chrome build runs in Edge 116+ unchanged (`video-downloader-legal-edge-<version>.zip`, checklist in `EDGE/`). On Firefox for Android 142+ the popup fills the screen with finger-sized buttons; what the phone does not have (hotkeys, notifications, sidebar) is skipped.
* **YouTube subtitles:** a *Subtitles* row in the card (the video's tracks, automatic ones and a YouTube translation into the interface language). *SRT* saves `<title>.<lang>.srt`; *with video* puts them into a joined `.webm` as a switchable track (off by default) or saves an `.srt` next to the video.
* **Why YouTube gave nothing:** the card names the reason — age restriction (18+), robot check, private, removed, not available in your country, members only, paid / DRM, not started yet, content confirmation, cut-off downloads, too many requests, no connection — and says whether recording while playing can help. The diagnostics file has a `verdict` field.
* **Creative Commons badge:** a YouTube video under Creative Commons shows a green *CC BY* badge.
* **Keyboard shortcuts you can set** (Settings → General): open the popup (`Alt+Up`), download the first video (`Alt+Down`), download its audio (`Alt+Shift+Down`), with a master switch. Firefox changes them on the settings page; Chrome / Edge show where to change them.
* **Sidebar button** (Firefox): opens the sidebar from the popup and closes it from the sidebar; the same control in the settings.
* **YouTube recordings in one file:** AV1 or H.264 video with Opus sound (and VP9 with AAC) are joined without re-encoding.
* **Rebuild the MP3 encoder yourself:** `node scripts/build-lamejs.mjs` builds `vendor/lame.js` from the unmodified lamejs 1.2.1 sources and checks it (`--compare`: the same MP3 bytes as upstream).

### Changed
* **Joins into MP4:** video and sound of different formats are saved as an ordinary MP4 (index first) — Telegram sends it as a video, browsers and players seek at once. MKV stays available in Settings → Download and recording.
* **Joined files seek properly:** `.webm` (and `.mkv`, when chosen) get a known size, an index and both tracks in the same clusters; long `.webm` joins go cluster by cluster instead of holding the whole video in memory.
* **Kick (Amazon IVS):** the single-quality playlists the player fetches go under *More* when the main playlist with all qualities is there.
* *Record while playing* with the *BETA* badge on the same line; the diagnostics panel can be closed (✕), belongs to the video it was made on, its buttons no longer jump (*GitHub issue* and *Send an e-mail* on one line).
* *Ignore files smaller than* is 150 KB by default again (installs that kept 10 KB move to 150 KB once).
* Package names: `video-downloader-legal-ff-<version>.xpi`, `video-downloader-legal-chrome-<version>.zip`, `video-downloader-legal-edge-<version>.zip`. `npm run build:amo-dev` / `node scripts/build-amo-dev.mjs --release` make the upload set for AMO (package, source archive, form text).
* Mozilla validator: no errors or warnings (readable `vendor/lame.js` instead of the minified file; Chrome-only code out of the Firefox package; `gecko_android` 142). Authors of lamejs / LAME named in `THIRD-PARTY.md` and `LICENSE`, `LICENSES/lamejs-LICENSE.txt` shipped.
* The README, the help page and the development log link to the add-on on addons.mozilla.org.

### Removed
* The context-menu item *Download this media* and the `contextMenus` permission (the popup and the shortcuts do the same).

### Fixed
* Settings: a changed interface language is applied right after *Save*.

The steps between 1.5.6 and 1.6.0 (1.6.0dev … dev7) are described in the development log.

## 1.5.6

### Added
* **Debug log** (options > Diagnostics, off by default): records what the extension does (found streams, downloads and their errors, YouTube requests, recording status, settings changes, uncaught errors). Links are shortened to host, path and parameter names (full links only with the *include full links* option), no titles or cookies. The log (last 1500 lines) can be viewed, copied, saved to a file, sent through a GitHub issue / e-mail link, or cleared. When the *Auto-diagnostics* button is pressed, its result is added to the log as a `[test]` block. Nothing is sent automatically.
* **Build for AMO:** `npm run build-for-amo` (the script AMO's source builder looks for) builds the Firefox package; `npm run build:chrome` builds the Chrome one.

### Changed
* License file: copyright notice written as `Copyright (c) 2026 AspidovSS`; the README keeps `© 2026 AspidovSS`.

## 1.5.5

### Added
* **Terms of use at first run:** the popup shows them (tool provided "as is", only content you have the right to download, all legal costs are yours) with *I accept* / *I decline*. Declining closes the popup and the terms come back next time; until accepted, downloads, the hotkey and the context menu are disabled. The options page shows the status and can withdraw the consent. Ten languages.
* **Interface language switch** in the options (automatic by default, or any of the 10 shipped languages).
* **Restore default settings** button in the options.
* **Recording from the player for YouTube videos is now an option** (off by default, in a *Recording from the player* block of the YouTube settings). YouTube live streams are always offered for recording.
* **Explanations (?)** next to every option in the options page.
* *Ignore files smaller than* now defaults to 10 KB (was 150 KB). The file name template is pre-filled (`{title} {site} {date}`) and can no longer stay empty.
* **YouTube: "Creative Commons only" is now on by default** (applied once to existing installs). The first time a non-Creative-Commons video is met, the popup explains it once and can turn the restriction off; turning it off means the user confirms the right to download (also stated in the terms of use). The notice links to the license; the options page shows "Restriction disabled by the user" with the date in the terms.
* **Footer** on the options, history and help pages: copyright, build version, browser, GitHub link.
* **Recording from the player is marked Beta.** *Stop* for regular videos (ends the recording at that moment and saves it); a recording that reaches the end is saved automatically; it always starts from 0:00 (start-time parameters are dropped, a recording that does not begin at zero is restarted once, then stopped with a message); the "could not get links" note has a *Turn on recording from the player* button.
* **Options page:** a save bar at the top that appears on any change (with *Cancel*), a warning when leaving with unsaved changes, and foldable blocks (the state is remembered; Diagnostics and Restore defaults start folded).
* The options page is grouped into blocks: Defaults, General, Downloads and recording, YouTube, Diagnostics, Restore defaults, Terms of use.

## 1.5.5dev

### Added
* **Chrome / Chromium support (development build):** the same sources build a Manifest V3 package (`node scripts/build-chrome.mjs`), installed from GitHub in developer mode. Toolbar popup; Chrome 116 or newer.

## 1.5.4 — 2026-10-13

Maintenance release, no new features (re-submission of 1.5.3 with the reviewer notes and listing texts updated).

## 1.5.3 — 2026-10-13

Maintenance release, no new features.

* Third-party notices: `THIRD-PARTY.md` and the store listing name lamejs 1.2.1 (LGPL-3.0) and describe the data the code relies on.

## 1.5.2 — 2026-10-12

### Added
* **TS → MP4 conversion right after download or recording**, with the extension's own code (`lib/ts2mp4.js`, no re-encoding): H.264 + AAC from MPEG-TS into a progressive MP4 that plays in VLC and Windows Media Player. The result starts at 0:00.
* **TS streams are offered in two variants:** MP4 (default) and TS (as it is). A setting turns the conversion off.
* **TikTok support:** the video on screen is listed first with its title and cover; up to five other videos of the feed are under *More*. Files are named `tiktok_<author>_<id>_<date>_<time>.mp4`.
* **Twitch:** one card per stream with the recording inside it; switching channels in the single-page app no longer offers the previous channel.
* Live recordings (Twitch and other HLS) start at 0:00 instead of the stream's own clock.
* Light and dark theme screenshots, updated store listing, English README, privacy policy, contribution and security notes.

## 1.5.1 — live recording

### Added
* **Live stream recording** (Twitch and other HLS streams without DRM): a *Record* button instead of *Download*, elapsed time and size in the window, *Stop* saves what was recorded, *Cancel* discards it. Ends by itself at the end of the stream, at the size limit or at the time limit (new setting, 180 min by default).
* Live quality list shows the format (TS / MP4) and data per minute; the 50/60 fps variants are labelled (`1080p60`).
* **YouTube live recording from the player (beta):** works without reloading the page; video (VP9) and audio (AAC) are joined into one `.mkv` without re-encoding.
* **Twitch:** one card per stream with the recording inside it.
* Recordings of HLS streams start at 0:00 (`lib/rebase.js`).
* Joining of MP4 (H.264 + AAC) into an ordinary progressive MP4 that plays with sound from the first second in VLC and Windows Media Player.
* Fewer false requests on YouTube: no video data is requested on the home page, search and channels.
* Built-in help in 10 languages (features, limits, privacy, contacts, components); settings regrouped (defaults on top, YouTube options in a frame).

## 1.5.0 — localisation and sites

### Added
* Interface in 10 languages: English, Russian, Chinese (Simplified), Spanish, Hindi, French, Arabic (RTL), Portuguese (Brazil), German, Japanese; chosen from the Firefox language.
* **Bilibili** (bilibili.com and bilibili.tv) through the site's public API; **Canva** (`/watch` pages, HLS address from the page data); **Vimeo** through the public player config.
* **Facebook** videos (`/watch`, `/reel`, `/<page>/videos/`) and **Instagram** posts, reels and stories: the page's own data is read, DASH or plain mp4 is picked, video and audio are joined. File names `instagram_<account>_<date>_<time>.mp4`, `facebook_<page>_...`.
* **X / Twitter:** HLS and GIF; only the videos on screen are listed.
* Video is always saved **together with sound** on every site: DASH (including "one file per track", as on VK Video) and HLS with a separate audio track are joined into one file without re-encoding.
* Compact window: type (MP4 H.264, MP4 AV1, WEBM VP9) and resolution lists, size shown, default quality / type / audio format / audio quality in the settings; separate audio row (MP3 128-320 kbps, M4A, WEBM) for DASH too.
* Download card: ✕ to dismiss, *Open folder*; finished downloads disappear after a minute.
* Diagnostics button 🐞 on every site: saves a local file (links masked) and prepares a bug-report text.
* Files below 1 MB are tucked under *More*.

## 1.4.x — YouTube links, audio, MP3

### Added
* **1.4.5:** YouTube links are requested from inside the YouTube page (main method) with the background request as the fallback; setting *Auto / Page / Background*.
* **1.4.4:** *Audio only* block: M4A (AAC) and WEBM (Opus) original tracks without re-encoding, and **MP3** (converted in the browser with lamejs 1.2.1); size of every quality in the list; the recording fallback no longer drifts to the next video or an advert.
* **1.4.3:** YouTube session bootstrap like a regular client (`sw.js_data`), several client profiles (VISIONOS, ANDROID_VR, IOS), one-piece-at-a-time downloading; no cookies permission needed.
* **1.4.0:** YouTube formats by direct links (the main method), video and audio joined into one file.

## 1.3.0 — YouTube recording

### Added
* **"Record while playing"** for YouTube: the extension copies the segments the player itself loads and saves them as one webm or mp4 file (DRM is refused).

## 1.0 – 1.2 — base

### Added
* Direct files (mp4, webm, mp3 and others) found through network responses.
* **HLS (m3u8):** quality choice, separate audio track, AES-128, fMP4, byte ranges.
* **DASH (mpd):** SegmentTemplate / SegmentTimeline / SegmentList / single file.
* Vimeo and Dailymotion through the public player endpoints.
* History, file name template, notifications, hotkey Alt+Down, context-menu item.
* No Native Messaging, no external servers, no telemetry; DRM is detected and never bypassed.
