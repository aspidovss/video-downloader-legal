# vendor/

## lame.js — "Audio only → MP3"

**lamejs** 1.2.1 (JavaScript port of the LAME MP3 encoder), licensed **LGPL-3.0** (full text: `../LICENSES/LGPL-3.0.txt`; details: `../THIRD-PARTY.md`).
Upstream: https://github.com/zhuker/lamejs, tag `1.2.1`, commit `32f6198fc9d7dc69894977152a08442607738c40`.
SHA-256 of `lame.js`: `f7f74b09d1190d9935e776169dd76c7b66e30db7e2f51b816af88f85a44ed9a8`

`lame.js` is **assembled from the lamejs sources, not modified,** by `../scripts/build-lamejs.mjs`: the sources under `src/js` are put into one file
(readable JavaScript, no minifier); only the lines that merely wire the modules together (`require()`, `module.exports`, single-line `assert()`) are left out, as in upstream's own `makeall.sh`.
The copyright notices of the original LAME authors stay in the code. Copyright holders, licence and the licensing notes of lamejs: `../THIRD-PARTY.md`, `../LICENSE`, `../LICENSES/`. Anyone can rebuild it and check the hash:

```
node scripts/build-lamejs.mjs            # fetches lamejs 1.2.1 from GitHub, builds, compares with vendor/lame.js
node scripts/build-lamejs.mjs --compare  # also encodes a test signal with the bundle and with the upstream lame.min.js
```

Needs Node.js 18+ and git; no npm packages. The script prints `vendor/lame.js: MATCH` when the file here is exactly what the sources produce.
The bundle gives the same MP3 bytes as the upstream pre-built `lame.min.js` (checked with `--compare`).

It is loaded by the background page at start-up (in Chrome by the offscreen document) and used only for MP3 conversion. It is a
separate, replaceable file: to use another build, replace `vendor/lame.js` with a file that exposes `lamejs.Mp3Encoder`.
Do not edit the file by hand; change the sources and rebuild. If you distribute the extension, keep this notice and link the upstream
source in your store listing.
