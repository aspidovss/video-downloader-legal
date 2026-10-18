# Third-party code

## lamejs — the only third-party component

| | |
|---|---|
| **Name** | lamejs (JavaScript port of the LAME MP3 encoder) |
| **Version** | 1.2.1 |
| **File in this project** | `vendor/lame.js` |
| **Status** | the lamejs sources **not modified, only assembled** (the lines that merely wire the modules together — `require()`, `module.exports`, single-line `assert()` — are left out, exactly as upstream's own `makeall.sh` does, but without the minifier) into one readable file by [`scripts/build-lamejs.mjs`](scripts/build-lamejs.mjs) (no minifier, no code change); SHA-256 `f7f74b09d1190d9935e776169dd76c7b66e30db7e2f51b816af88f85a44ed9a8`, also in `vendor/README.md`. The script reproduces it byte for byte: `node scripts/build-lamejs.mjs` |
| **License** | GNU Lesser General Public License v3.0 (LGPL-3.0) — full text in [`LICENSES/LGPL-3.0.txt`](LICENSES/LGPL-3.0.txt); the licensing notes that ship with lamejs (link as a separate file, acknowledge LAME, release modifications under the LGPL) are in [`LICENSES/lamejs-LICENSE.txt`](LICENSES/lamejs-LICENSE.txt) |
| **Copyright** | lamejs © Alex Zhukov and contributors (a rewrite of jump3r, itself a rewrite of libmp3lame); LAME © the LAME authors named in the file headers: Mark Taylor, Gabriel Bouvigne, Robert Hegemann, Takehiro Tominaga, Naoki Shibata, Alexander Leidinger, David Robinson and Glen Sawyer. The original notices are kept in the headers of the code inside `vendor/lame.js`. |
| **Source code, this version** | repository <https://github.com/zhuker/lamejs>, tag `1.2.1`, commit `32f6198fc9d7dc69894977152a08442607738c40`; the same sources are also in the npm package `lamejs@1.2.1` |
| **Used for** | the optional *Audio only → MP3* conversion; runs locally in the browser and makes no network requests |

**Acknowledgment.** lamejs is a JavaScript port of **LAME**, the MP3 encoder of the LAME project — <https://lame.sourceforge.net/>. This extension uses LAME (through lamejs) for the optional MP3 conversion and gratefully acknowledges the LAME project. The sources are used unmodified (only bundled into one file), so there is nothing to release back. Any future modification of them would be published under the LGPL.

`vendor/lame.js` is **not** covered by this project's MIT license (see the notice at the end of [`LICENSE`](LICENSE)).

**Replacing it (LGPL).** `vendor/lame.js` is a separate, replaceable file: to use another or a modified build, replace it with a file that exposes `lamejs.Mp3Encoder`; nothing else in the extension needs to change. It is not merged with any other code of this project. **Rebuilding it:** `node scripts/build-lamejs.mjs` (add `--write` to overwrite the file, `--compare` to check the MP3 output against upstream's own `lame.min.js`).

Everything else — HLS/DASH parsers, the MP4 / WebM muxer (`lib/mux.js`), the MPEG-TS → MP4 / MKV converter (`lib/ts2mp4.js`), the GIF encoder (`lib/gif.js`) and the timestamp tool (`lib/rebase.js`) — is the project's own code under the MIT license. There is no WebAssembly and no remote code.


## Tools used only for development (not shipped)

These programs are **not part of the extension**: they are not in the repository, not in the `.xpi` / `.zip` packages, not linked with the extension's code, and the extension never runs them. No code of theirs is copied into this project.

| Tool | License | What it is used for |
|---|---|---|
| **[FFmpeg](https://ffmpeg.org/)** (`ffmpeg`, `ffprobe`), installed by the developer | LGPL-2.1-or-later; builds with GPL parts (for example with libx264) are under the GPL — see [ffmpeg.org/legal.html](https://ffmpeg.org/legal.html) | **Tests only** (`tests/*.test.js`, run by `npm test`). It is started as a separate program (`child_process.spawnSync`) to make short sample videos (test picture and tone, H.264 / VP9 / AV1 with AAC / Opus / MP3, TS / MP4 / WebM / HLS segments) and to check the files written by the extension's own code: identical frames (`framemd5`), decodable sound, duration, start time, codecs, seeking. Without FFmpeg these tests are skipped; the others still run. |
| **[web-ext](https://github.com/mozilla/web-ext)** (npm dev dependency) | MPL-2.0 | Building and linting the Firefox package (`npm run build`, `npm run lint`). |

The extension itself does all converting and joining with its own code in the browser (`lib/ts2mp4.js`, `lib/mux.js`, `lib/rebase.js`); FFmpeg is only the independent reference that the tests compare the results with. Thanks to the FFmpeg project.

## Data, not code

* **YouTube client profiles** (`lib/ytapi.js`): client names, numbers, versions and User-Agent strings of the official YouTube mobile apps (Android VR, iOS, visionOS). These are public identifiers that the apps themselves send; no code is taken from any other project. `IOS_VDL` is our own extra iOS profile.
* **Bilibili "wbi" signature** (`lib/sites.js`): implemented from the publicly documented algorithm of the site's own web player; the extension uses it only to call the same public API for the page the user is viewing.
* Format specifications (ISO BMFF / MP4, MPEG-TS, HLS, DASH, Matroska / WebM) were implemented from the published standards.
