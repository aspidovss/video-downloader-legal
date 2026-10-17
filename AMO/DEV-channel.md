# VDL DEV: separate add-on for test builds (AMO, "On your own")

The release add-on (`video-downloader-legal@aspidovss`) is not touched. For the release itself: `npm run build:amo` (`node scripts/build-amo-dev.mjs --release`) -> `dist/amo/<version>/`.

* **Upload set (recommended):** `npm run build:amo-dev` (only Node.js 18+ and `zip`/`tar`, no `npm install`) -> `dist/amo-dev/<version>.<n>/` with the `.xpi`, the source `.zip` and `AMO-upload.txt` (what to paste into the AMO form). The build number only grows (last one kept in `last.json` there), so AMO never rejects a repeated version. Other folder: `node scripts/build-amo-dev.mjs --out ../dist/amo-dev`; fixed number: `--n 7`.
* Build with web-ext: `npm run build:dev` (needs `npm install`) -> `build/video-downloader-legal-dev-<version_name>.xpi`. `node scripts/build-ff.mjs --dev --n 4` sets the build number (version `1.6.0.4`); without `--n` it is taken from `version_name` (`1.6.0dev3` -> `1.6.0.3`).
* The package has its own id `video-downloader-legal-dev@aspidovss`, the name "VDL DEV - Video Downloader Legal" and a numeric version `<version>.<n>`. `manifest.json` in the repository is not changed. It installs next to the release add-on; settings and history are separate.
* Submit: addons.mozilla.org -> Developer Hub -> Submit a New Add-on -> **On your own** (unlisted) -> upload the `.xpi`. Mozilla signs it automatically; download the signed file from the version page and install it.
* The version number can't be reused on AMO: raise `--n` (or the number in `version_name`) for every upload.
* Auto-update needs `update_url` in the manifest and an `updates.json` at a stable address; without it install new builds by hand.
* Same source, same `LICENSE` and `THIRD-PARTY.md`; the reviewer notes in `AMO/developer-comments.md` apply (build steps are the same, only the manifest id, name and version differ).
