# Microsoft Edge

Edge is built on Chromium, so it runs the **Chrome build** of VDL unchanged (Manifest V3, service worker, offscreen document, `declarativeNetRequest`). All of these APIs exist in Edge 116 and newer; the build declares `minimum_chrome_version: 116`, which Edge honours as its own minimum.

## Install (developer mode)

1. Get `video-downloader-legal-edge-<version>.zip` from the [Releases](https://github.com/aspidovss/video-downloader-legal/releases) page and unpack it into a folder, or build it yourself (below).
2. Open `edge://extensions`, turn on *Developer mode* (left side), press *Load unpacked* and pick the folder.
3. Allow the extension on all sites if Edge asks (*Details → Site access → On all sites*); otherwise the page scanner cannot see the media.

The extension is not published in the Microsoft Edge Add-ons store yet; the steps for publishing it are below.

## Build

```
npm run build:edge      # build/chrome/ and build/video-downloader-legal-edge-<version>.zip (no npm install needed)
```

`npm run build:edge` makes the same package as `npm run build:chrome`; only the file name differs, so the two uploads are easy to tell apart. The zip tool is used for packing; on Windows (no `zip`) the built-in `tar` is used. Files must be at the archive root.

## What differs from Firefox

Toolbar popup only (no sidebar); the background is a service worker; request headers are set with `declarativeNetRequest`; the MP3 conversion and the download links are made in an offscreen document. The extension pages show `Edge` in the footer and in the bug-report template (detected from the user agent).

## Publishing in Microsoft Edge Add-ons (checklist)

Partner Center → *Edge program* → *Extensions* → *Create new extension* (the account is free for individual developers). Check the current requirements there; they change.

* **Package:** `video-downloader-legal-edge-<version>.zip` from `npm run build:edge`.
* **Name / short description / description:** use `../AMO/listing-en.md` (Name, Summary, Description); drop the paragraph about Firefox settings in *Good to know* and say instead: "After installing, allow the extension on all sites (Details → Site access)".
* **Category:** Productivity (or the closest one offered). **Language:** English (the interface has 10 languages).
* **Screenshots:** `../AMO/screenshots/en/` (1280×800); the banner `en-0-anywhere.png` can serve as the promotional image after scaling to the size the store asks for.
* **Privacy policy URL:** <https://github.com/aspidovss/video-downloader-legal/blob/main/PRIVACY.md>. **Support / website:** the GitHub repository; **e-mail:** vdl@aspidov.ru.
* **Notes for certification:** paste `notes-for-certification.md` (permissions, no remote code, how to test).
* **Remote code / data:** no remote code; no personal data is collected, sold or sent anywhere.
