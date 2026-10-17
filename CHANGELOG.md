# Changelog

Added features per version (fixes and internal changes are not listed). Version history before 1.5 is condensed from the development log; the short development log is in [docs/DEVLOG-en.md](docs/DEVLOG-en.md) (English) and [docs/DEVLOG-ru.md](docs/DEVLOG-ru.md) (Russian).

## 1.6.0dev3

### Changed
* Package names: `video-downloader-legal-ff-<version>.xpi` (Firefox, `npm run build`), `video-downloader-legal-chrome-<version>.zip` and `video-downloader-legal-edge-<version>.zip`.
* The settings page: the *Keyboard shortcuts* block moved inside *General*, at its very end.

## 1.6.0dev2

### Added
* **Sidebar button (Firefox):** a button in the popup opens the sidebar and closes the popup; in the sidebar the same button closes the panel. The settings page has the same control. Chrome, Edge and Firefox for Android do not show it.
* **Keyboard shortcuts you can set:** a new settings block with a master switch and three shortcuts: open the popup (default `Alt+Up`), download the first video (`Alt+Down`) and the new *download the audio of the first media* (`Alt+Shift+Down`; the audio format and quality of the settings are used). Firefox: type the shortcut into the field (Backspace clears it, *Default* resets it). Chrome and Edge cannot change shortcuts from an extension, so the page shows the address `chrome://extensions/shortcuts` / `edge://extensions/shortcuts` with a copy button. Hidden on Android.

## 1.6.0dev1

### Added
* **YouTube recording: AV1 video + Opus audio in one file.** The recorder used to leave them as two files (an MP4 and a `.weba`) because neither container can hold both. They are now joined into one Matroska file (`.mkv`) without re-encoding: the AV1 (or H.264) samples are cut out of the MP4 fragments and the Opus clusters are kept (`mergeMp4Opus` in `lib/mux.js`). Both tracks are cut to the span they have in common. If the join is not possible, the two files are saved as before.

### Fixed
* Settings: after *Save* the page did not apply a changed interface language until it was refreshed by hand (the language was compared after it had already been overwritten).

## 1.6.0dev

### Added
* **Firefox for Android:** the toolbar popup fills the screen and has finger-sized buttons; what the phone does not have is skipped: context menu, hotkeys, notifications and the sidebar (the background no longer fails on the missing `contextMenus` / `commands` APIs), the folder buttons and the "Save as" / notification options are hidden. Needs Firefox for Android 142+. The footer shows `Firefox Android`.
* **Microsoft Edge:** the Chrome build runs in Edge 116+ unchanged; `npm run build:edge` names the package `video-downloader-legal-edge-<version>.zip`; the folder `EDGE/` has the install steps and the Edge Add-ons checklist; Edge is recognised in the page footer and in the bug-report template.
* **Rebuild the MP3 encoder yourself:** `node scripts/build-lamejs.mjs` fetches lamejs 1.2.1 from GitHub, bundles it into `vendor/lame.js` and checks it against the file in the repository (`--compare`: same MP3 bytes as upstream's `lame.min.js`).
* The "Download anywhere" banner is part of the store screenshots (`AMO/screenshots`).

### Changed
* Copyright notices for lamejs / LAME: the original authors are named in `THIRD-PARTY.md` and `LICENSE`, the licensing notes of lamejs are shipped (`LICENSES/lamejs-LICENSE.txt`), and the header of `vendor/lame.js` states that the code is not modified, only assembled.
* `vendor/lame.min.js` is replaced by `vendor/lame.js`: the unmodified lamejs sources in one readable, non-minified file (clears the two `no-unsanitized` validator warnings).
* Chrome-only code (offscreen document client) moved out of the Firefox package (clears the `offscreen.createDocument` warning); the Chrome build puts it back.
* `gecko_android.strict_min_version` 142.0 (clears the Android warning about `data_collection_permissions`).

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
