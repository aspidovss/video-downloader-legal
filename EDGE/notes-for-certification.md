Video Downloader Legal (VDL) 1.6.0 for Microsoft Edge. Open source (MIT): https://github.com/aspidovss/video-downloader-legal

The package is the Chrome build of the repository (plain, unminified JavaScript ES modules; no bundler, no minifier, no remote code, no WebAssembly). Build: `npm run build:edge` (Node.js 18+; it only copies files and rewrites manifest.json for Chromium). The only third-party file is vendor/lame.js (lamejs 1.2.1, LGPL-3.0, optional MP3 conversion): the unmodified lamejs sources bundled into one readable file by scripts/build-lamejs.mjs (`node scripts/build-lamejs.mjs` rebuilds it and prints MATCH).

Permissions: downloads (save the detected file), webRequest (observe media requests to list what the page plays), declarativeNetRequest (the extension's own background requests to YouTube/Bilibili/TikTok video hosts need the site's Referer/Origin/User-Agent), offscreen (create blob: links for saving and run the MP3 conversion, which needs the DOM audio decoder), webNavigation + tabs (per-tab lists), storage + unlimitedStorage (settings, history, large Blob staging), notifications, clipboardWrite (copy buttons of the diagnostics), host <all_urls> (video sites are not known in advance).

Nothing is sent to the developer or to any analytics service; settings and history stay in the browser. DRM-protected streams are detected and refused, never decrypted.

How to test: install, open the popup on any page with an MP4/HLS video (for example a page with a <video> element), press Accept in the terms window, then Download. The bug button runs a local self-test and saves a diagnostics file.
