# Contributing

Thanks for helping! Bug reports, site checks, translations and pull requests are welcome.

## Reporting a problem

1. Reproduce it with the latest version.
2. Press the 🐞 button in the extension window. It creates a diagnostics file (links masked) and prepares a report text.
3. [Open an issue](https://github.com/aspidovss/video-downloader-legal/issues/new/choose) and attach the file. Say which site, what you did and what you expected.

Please do **not** post cookies, tokens or full links to private content.

## Scope — what will not be accepted

* Bypassing DRM, decrypting protected streams, forging tokens/signatures/sessions.
* Anything that needs Native Messaging or other programs installed by the user.
* Telemetry or remote code.

## Development

* Plain ES modules, no build step, no minification.
* Add a test for a bug fix or a new parser (`tests/*.test.js`, `node:test`). Run them with `npm test`. Tests of the converters and muxers need **FFmpeg** (`ffmpeg`, `ffprobe` in `PATH`) and are skipped without it; FFmpeg is used only to make sample files and check results, never inside the extension.
* User-visible text goes to `_locales/<lang>/messages.json` in **all** ten languages; `tests/locales.test.js` requires identical keys. If you are not sure about a translation, provide English and mention it in the pull request.
* Keep changes focused; describe how you tested.

## Translations

Some translations (for example Arabic and Hindi) were written with the help of AI and need review by native speakers. Corrections are very welcome: edit the file in `_locales/<lang>/messages.json`.
