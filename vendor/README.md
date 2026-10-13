# vendor/

## lame.min.js — "Audio only → MP3"

Unmodified **lamejs** 1.2.1 (JavaScript port of the LAME MP3 encoder), licensed **LGPL-3.0** (full text: `../LICENSES/LGPL-3.0.txt`; details: `../THIRD-PARTY.md`).
Upstream: https://github.com/zhuker/lamejs · npm: `lamejs@1.2.1` (file `lame.min.js`).
SHA-256: `15d285e2587b3bdbfd18a68de6ce07cc074f7480a82c3815da2dc1c348ec6df4`

It is loaded by the background page at start-up and used only for MP3 conversion. It is a
separate, replaceable file: to use another build, replace `vendor/lame.min.js` with a file that exposes
`lamejs.Mp3Encoder`. Do not edit the file. If you distribute the extension, keep this notice and link the upstream
source in your store listing.
