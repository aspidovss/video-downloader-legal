**Plain, unminified JavaScript (ES modules); no build step.** The `.xpi` is a plain zip of the source code — nothing is transpiled, bundled, minified or generated. Repository: [github.com/aspidovss/video-downloader-legal](https://github.com/aspidovss/video-downloader-legal)

## Build

Files must be at the archive root.

```
git clone https://github.com/aspidovss/video-downloader-legal.git
cd video-downloader-legal
```

Linux / macOS / Git Bash:

```
zip -r video-downloader-legal-1.5.6.xpi manifest.json LICENSE LICENSES THIRD-PARTY.md _locales content icons injected lib service styles utils vendor
```

Or with npm (Firefox build; the `build-for-amo` script in `package.json`, which AMO's builder uses; `web-ext` is the only dev dependency):

```
npm install
npm run build-for-amo
```

The package is written to `build/`.

Windows (PowerShell):

```
tar -a -c -f video-downloader-legal-1.5.6.zip manifest.json LICENSE LICENSES THIRD-PARTY.md _locales content icons injected lib service styles utils vendor
Rename-Item video-downloader-legal-1.5.6.zip video-downloader-legal-1.5.6.xpi
```

## Structure

- Entry points (`manifest.json`): background `service/main.js` (module), popup `content/popup.html`, options `content/settings.html`; CSP `script-src 'self'` (no remote or inline code)
- `service/main.js` — background: detection, manifests, downloads, history
- `lib/` — `hls.js`, `dash.js` parsers; `downloader.js` segments; `liverec.js` live recording; `mux.js` own MP4/WebM muxer; `ts2mp4.js` TS→MP4 without re-encoding; `rebase.js` timestamps to 0:00; `mp3.js` lamejs glue; `youtube.js`, `ytapi.js`, `sites.js` site support; `md5.js`, `util.js`, `mp4info.js`, `sitediag.js` helpers
- `injected/` — content scripts: `page.js` (generic scanner), YouTube (`youtube*.js`, record only on user click), TikTok (read-only), Instagram/Facebook, X, Canva, OK.ru
- `content/` — popup, settings, history, help; `utils/`, `styles/`, `_locales/` (10 languages), `icons/`
- `vendor/lame.min.js` — **unmodified** lamejs 1.2.1 (LGPL-3.0, optional MP3). Verify: `npm pack lamejs@1.2.1`, SHA-256 `15d285e2587b3bdbfd18a68de6ce07cc074f7480a82c3815da2dc1c348ec6df4`. The two validator warnings (line 76) come from this file.
- Not in the `.xpi` (repository only): `tests/`, `docs/`, `AMO/`, `package.json`, README

## Sources of technical values

- `ytapi.js`: names, versions and User-Agent strings of the official YouTube mobile apps (public identifiers the apps send).
- `sites.js`: Bilibili "wbi" signature from the publicly documented algorithm of the site's own player.
- MP4, MPEG-TS, HLS, DASH, Matroska: implemented from the published standards.

## Testing

All declared functionality was **tested manually** in Firefox 157.0.1 and 158.0b5 on Windows 11 24H2 (26100.8246).

## AI disclosure

Code, texts, comments, descriptions and translations are AI-generated. The AI-generated text has been reviewed by the author.
