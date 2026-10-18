// Builds the Chrome (Manifest V3, service worker) package from the same sources as Firefox.
//   node scripts/build-chrome.mjs        -> build/chrome/            (load unpacked in chrome://extensions)
//   node scripts/build-chrome.mjs --zip  -> build/video-downloader-legal-chrome-<version>.zip   (written by scripts/zip.mjs, no tools needed)
//   node scripts/build-chrome.mjs --zip --edge -> build/video-downloader-legal-edge-<version>.zip  (the same package: Microsoft Edge runs the Chrome build unchanged;
//                                                the name only tells the two store uploads apart)
//   node scripts/build-chrome.mjs --zip --updater -> build/video-downloader-legal-chrome-updater-<version>.zip  (#62, 1.6.4: for "Load unpacked"
//                                                installs without a store: once a day it looks at the latest GitHub release and shows a line in the popup)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeZip } from './zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME_OUT = path.join(root, 'build', 'chrome');
const DIRS = ['_locales', 'content', 'icons', 'injected', 'lib', 'platform', 'service', 'styles', 'utils', 'vendor'];

export function chromeManifest(src, { updater = false } = {}) {
  const m = JSON.parse(JSON.stringify(src));
  delete m.browser_specific_settings;
  delete m.sidebar_action;
  m.minimum_chrome_version = '116';
  m.background = { service_worker: updater ? 'platform/sw-updater.js' : 'platform/sw.js', type: 'module' };
  // the updater package says so in its version name (the settings page shows the update check only there)
  if (updater) m.version_name = `${src.version_name || src.version} (updater)`;
  m.permissions = [...new Set([...m.permissions.filter((p) => p !== 'webRequestBlocking'), 'declarativeNetRequest', 'offscreen'])];
  // extension-world content scripts need the `browser` shim first; MAIN-world scripts do not use it
  m.content_scripts = m.content_scripts.map((cs) => (cs.world === 'MAIN' ? cs : { ...cs, js: ['platform/shim.js', ...cs.js] }));
  return m;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

export function build({ updater = false, outDir } = {}) {
  const out = outDir || CHROME_OUT;
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const d of DIRS) copyDir(path.join(root, d), path.join(out, d));
  // the real offscreen client is Chrome-only: it replaces the stub that the Firefox package ships in service/
  fs.renameSync(path.join(out, 'platform', 'offscreen-client.js'), path.join(out, 'service', 'offscreen-client.js'));
  // the GitHub release check exists only in the updater package
  if (!updater) for (const f of ['updater.js', 'sw-updater.js']) fs.rmSync(path.join(out, 'platform', f), { force: true });
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
  fs.copyFileSync(path.join(root, 'THIRD-PARTY.md'), path.join(out, 'THIRD-PARTY.md'));
  copyDir(path.join(root, 'LICENSES'), path.join(out, 'LICENSES'));
  const src = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(chromeManifest(src, { updater }), null, 2)}\n`);
  // extension pages: load the shim before their module scripts
  for (const f of fs.readdirSync(path.join(out, 'content')).filter((n) => n.endsWith('.html'))) {
    const p = path.join(out, 'content', f);
    const html = fs.readFileSync(p, 'utf8');
    if (!html.includes('shim.js')) fs.writeFileSync(p, html.replace(/(\s*)<script /, '$1<script src="../platform/shim.js"></script>$1<script '));
  }
  return { dir: out, version: src.version_name || src.version };
}

export const packageName = (version, edge = false, updater = false) => `video-downloader-legal-${edge ? 'edge' : 'chrome'}${updater ? '-updater' : ''}-${version}.zip`;

// zip tool first; on Windows (no `zip` by default) the built-in bsdtar writes a normal zip with `tar -a`.
// A real .zip on every system, written by scripts/zip.mjs (no zip / tar tool needed; Windows' tar made a tar
// archive for an .xpi name, which AMO refused as corrupt)
export function packFolder(dir, zip) {
  fs.rmSync(zip, { force: true });
  try { return writeZip(dir, zip) > 0; } catch (e) { console.error(String(e?.message || e)); return false; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const updater = process.argv.includes('--updater');
  const { dir, version } = build({ updater });
  console.log(`Chrome build${updater ? ' (updater)' : ''}: ${dir}`);
  if (process.argv.includes('--zip')) {
    const zip = path.join(root, 'build', packageName(version, process.argv.includes('--edge'), updater));
    console.log(packFolder(dir, zip) ? `Zip: ${zip}` : 'The zip was not written: pack the folder build/chrome yourself (the files must be at the archive root)');
  }
}
