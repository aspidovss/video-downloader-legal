# Third-party code

## lamejs — the only third-party component

| | |
|---|---|
| **Name** | lamejs (JavaScript port of the LAME MP3 encoder) |
| **Version** | 1.2.1 |
| **File in this project** | `vendor/lame.min.js` |
| **Status** | **unmodified** — byte-for-byte the file `lame.min.js` of the npm package `lamejs@1.2.1` (SHA-256 `15d285e2587b3bdbfd18a68de6ce07cc074f7480a82c3815da2dc1c348ec6df4`, also in `vendor/README.md`) |
| **License** | GNU Lesser General Public License v3.0 (LGPL-3.0) — full text in [`LICENSES/LGPL-3.0.txt`](LICENSES/LGPL-3.0.txt) |
| **Copyright** | lamejs authors |
| **Source code, this version** | npm package <https://www.npmjs.com/package/lamejs/v/1.2.1> (`npm pack lamejs@1.2.1` downloads the sources together with the minified file); repository: <https://github.com/zhuker/lamejs> |
| **Used for** | the optional *Audio only → MP3* conversion; runs locally in the browser and makes no network requests |

**Acknowledgment.** lamejs is a JavaScript port of **LAME**, the MP3 encoder of the LAME project — <https://lame.sourceforge.net/>. This extension uses LAME (through lamejs) for the optional MP3 conversion and gratefully acknowledges the LAME project. The file is linked as a separate, unmodified library; no modifications are made, so there is nothing to release back. Any future modification of it would be published under the LGPL.

`vendor/lame.min.js` is **not** covered by this project's MIT license (see the notice at the end of [`LICENSE`](LICENSE)).

**Replacing it (LGPL).** `lame.min.js` is a separate, replaceable file: to use another or a modified build, replace it with a file that exposes `lamejs.Mp3Encoder`; nothing else in the extension needs to change. The file is not edited, merged or bundled with other code.

Everything else — HLS/DASH parsers, the MP4 / WebM muxer (`lib/mux.js`), the MPEG-TS → MP4 converter (`lib/ts2mp4.js`) and the timestamp tool (`lib/rebase.js`) — is the project's own code under the MIT license. There is no WebAssembly and no remote code.


## Data, not code

* **YouTube client profiles** (`lib/ytapi.js`): client names, numbers, versions and User-Agent strings of the official YouTube mobile apps (Android VR, iOS, visionOS). These are public identifiers that the apps themselves send; no code is taken from any other project. `IOS_VDL` is our own extra iOS profile.
* **Bilibili "wbi" signature** (`lib/sites.js`): implemented from the publicly documented algorithm of the site's own web player; the extension uses it only to call the same public API for the page the user is viewing.
* Format specifications (ISO BMFF / MP4, MPEG-TS, HLS, DASH, Matroska / WebM) were implemented from the published standards.
