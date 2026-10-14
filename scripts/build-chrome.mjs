// Builds the Chrome (Manifest V3, service worker) package from the same sources as Firefox.
//   node scripts/build-chrome.mjs        -> build/chrome/            (load unpacked in chrome://extensions)
//   node scripts/build-chrome.mjs --zip  -> build/video-downloader-legal-chrome-<version>.zip   (`zip` tool; on Windows the built-in `tar` is the fallback)
//   node scripts/build-chrome.mjs --zip --edge -> build/video-downloader-legal-edge-<version>.zip  (the same package: Microsoft Edge runs the Chrome build unchanged;
//                                                the name only tells the two store uploads apart)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build', 'chrome');
const DIRS = ['_locales', 'content', 'icons', 'injected', 'lib', 'platform', 'service', 'styles', 'utils', 'vendor'];

export function chromeManifest(src) {
  const m = JSON.parse(JSON.stringify(src));
  delete m.browser_specific_settings;
  delete m.sidebar_action;
  m.minimum_chrome_version = '116';
  m.background = { service_worker: 'platform/sw.js', type: 'module' };
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

export function build() {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const d of DIRS) copyDir(path.join(root, d), path.join(out, d));
  // the real offscreen client is Chrome-only: it replaces the stub that the Firefox package ships in service/
  fs.renameSync(path.join(out, 'platform', 'offscreen-client.js'), path.join(out, 'service', 'offscreen-client.js'));
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
  fs.copyFileSync(path.join(root, 'THIRD-PARTY.md'), path.join(out, 'THIRD-PARTY.md'));
  copyDir(path.join(root, 'LICENSES'), path.join(out, 'LICENSES'));
  const src = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(chromeManifest(src), null, 2)}\n`);
  // extension pages: load the shim before their module scripts
  for (const f of fs.readdirSync(path.join(out, 'content')).filter((n) => n.endsWith('.html'))) {
    const p = path.join(out, 'content', f);
    const html = fs.readFileSync(p, 'utf8');
    if (!html.includes('shim.js')) fs.writeFileSync(p, html.replace(/(\s*)<script /, '$1<script src="../platform/shim.js"></script>$1<script '));
  }
  return { dir: out, version: src.version_name || src.version };
}

export const packageName = (version, edge = false) => `video-downloader-legal-${edge ? 'edge' : 'chrome'}-${version}.zip`;

// zip tool first; on Windows (no `zip` by default) the built-in bsdtar writes a normal zip with `tar -a`.
export function packFolder(dir, zip, platform = process.platform) {
  fs.rmSync(zip, { force: true });
  const tools = [['zip', ['-qr', zip, '.']]];
  if (platform === 'win32') tools.push(['tar', ['-a', '-c', '-f', zip, '-C', dir, '.']]);
  for (const [cmd, args] of tools) {
    const r = spawnSync(cmd, args, { cwd: dir, stdio: 'inherit' });
    if (r.status === 0) return true;
  }
  return false;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { dir, version } = build();
  console.log(`Chrome build: ${dir}`);
  if (process.argv.includes('--zip')) {
    const zip = path.join(root, 'build', packageName(version, process.argv.includes('--edge')));
    console.log(packFolder(dir, zip) ? `Zip: ${zip}` : 'No zip or tar tool found: pack the folder build/chrome yourself (the files must be at the archive root)');
  }
}
