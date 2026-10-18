// "VDL DEV" for AMO (unlisted, "On your own"): everything one upload needs, in one folder.
//   node scripts/build-amo-dev.mjs          (npm run build:amo-dev)
//   node scripts/build-amo-dev.mjs --n 7    build number 7 (version <version>.7)
//   node scripts/build-amo-dev.mjs --out ../dist/amo-dev   another output folder (default: dist/amo-dev in the repository)
//   node scripts/build-amo-dev.mjs --release   the released add-on itself (manifest as it is, id video-downloader-legal@aspidovss):
//        dist/amo/<version_name>/ with video-downloader-legal-ff-<version>.xpi, the source archive and AMO-upload.txt
// Writes <output folder>/<version>.<n>/:
//   video-downloader-legal-dev-<version>.<n>.xpi     the add-on (own id, name and version; the source manifest is not changed)
//   video-downloader-legal-source-<version>.<n>.zip  the source code for the reviewers ("Do you need to submit source code?" -> Yes)
//   AMO-upload.txt                                    what to paste into the AMO form
// AMO never accepts the same version twice, so the build number only grows: it is the number after "dev" in
// version_name, or the last one used + 1 (kept in last.json of the output folder), whichever is larger.
// Needs only Node.js 18+ (the archives are written by scripts/zip.mjs). No npm packages, no web-ext, no zip tool.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { devManifest } from './build-ff.mjs';
import { packFolder } from './build-chrome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGE_FILES = ['manifest.json', 'LICENSE', 'LICENSES', 'THIRD-PARTY.md', '_locales', 'content', 'icons', 'injected', 'lib', 'service', 'styles', 'utils', 'vendor'];
const SOURCE_SKIP = /^(node_modules|build|dist|\.git)(\/|$)|\.(xpi|zip)$/;

// next build number: never below the one in version_name, always above the last one used for this version
export function nextDevNumber(versionName, last) {
  const fromName = Number((/dev(\d+)/.exec(versionName || '') || [])[1] || 1);
  return Math.max(fromName, (last || 0) + 1);
}

function sourceFiles() {
  const g = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  if (g.status === 0 && g.stdout.trim()) return g.stdout.split('\n').map((s) => s.trim()).filter((f) => f && !SOURCE_SKIP.test(f) && fs.existsSync(path.join(root, f)));
  const out = []; // no git: walk the folder
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (SOURCE_SKIP.test(r)) continue;
      if (e.isDirectory()) walk(r); else out.push(r);
    }
  };
  walk('');
  return out;
}

function copyInto(dir, rel) {
  const to = path.join(dir, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(path.join(root, rel), to, { recursive: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const release = process.argv.includes('--release');
  const oi = process.argv.indexOf('--out');
  const base = oi > 0 ? path.resolve(process.cwd(), process.argv[oi + 1]) : path.join(root, 'dist', release ? 'amo' : 'amo-dev');
  fs.mkdirSync(base, { recursive: true });
  const lastFile = path.join(base, 'last.json');
  let last = {};
  try { last = JSON.parse(fs.readFileSync(lastFile, 'utf8')); } catch { /* first build */ }
  const ni = process.argv.indexOf('--n');
  const n = release ? 0 : (ni > 0 ? Number(process.argv[ni + 1]) : nextDevNumber(m.version_name, last[m.version]));
  if (!release && (!Number.isInteger(n) || n < 1)) { console.error('Bad build number'); process.exit(1); }
  if (release && /dev/i.test(m.version_name || '')) { console.error(`version_name is ${m.version_name}: remove "dev" before a release build`); process.exit(1); }
  const dm = release ? m : devManifest(m, n);
  const ver = release ? (m.version_name || m.version) : dm.version;
  const outDir = path.join(base, ver);
  const stage = path.join(root, 'build', 'amo-dev');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // the add-on
  const pkg = path.join(stage, 'pkg');
  for (const f of PACKAGE_FILES) if (fs.existsSync(path.join(root, f))) copyInto(pkg, f);
  fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify(dm, null, 2) + '\n');
  const xpi = path.join(outDir, `video-downloader-legal-${release ? 'ff' : 'dev'}-${ver}.xpi`);
  if (!packFolder(pkg, xpi)) { console.error('The archive was not written'); process.exit(1); }

  // the source code (the files of the repository, uncommitted changes included; nothing built)
  const src = path.join(stage, 'src');
  for (const f of sourceFiles()) copyInto(src, f);
  const srcZip = path.join(outDir, `video-downloader-legal-source-${ver}.zip`);
  if (!packFolder(src, srcZip)) { console.error('The archive was not written'); process.exit(1); }

  fs.writeFileSync(path.join(outDir, 'AMO-upload.txt'), [
    release ? `Video Downloader Legal ${ver} (release)` : `VDL DEV ${ver} (${m.version_name || m.version})`,
    '',
    release ? 'addons.mozilla.org -> Developer Hub -> VDL - Video Downloader Legal -> Upload New Version -> On this site (listed)' : 'addons.mozilla.org -> Developer Hub -> VDL DEV -> Upload New Version -> On your own',
    `1. Upload: video-downloader-legal-${release ? 'ff' : 'dev'}-${ver}.xpi`,
    '2. "Do you need to submit source code?" -> Yes',
    `3. Source code: video-downloader-legal-source-${ver}.zip`,
    '4. Notes for reviewers (build instructions):',
    '',
    '   Plain, unminified JavaScript (ES modules); the package is a zip of the source folders, nothing is transpiled or minified.',
    '   vendor/lame.js is lamejs 1.2.1 joined from its unmodified sources by scripts/build-lamejs.mjs (check: node scripts/build-lamejs.mjs -> MATCH).',
    release ? '   Rebuild: Node.js 18+, then: node scripts/build-amo-dev.mjs --release (or: npm install && npm run build)' : '   This add-on is the test channel of Video Downloader Legal; only id, name and version in manifest.json differ.',
    ...(release ? ['5. Release notes: AMO/listing-en.md and AMO/listing-ru.md, section "Version ' + ver + '"'] : [`   Rebuild: Node.js 18+, then: node scripts/build-amo-dev.mjs --n ${n}`]),
    '',
    'After signing: download the signed .xpi from the version page and install it in Firefox.',
    '',
  ].join('\n'));

  if (!release) {
    last[m.version] = Math.max(n, last[m.version] || 0);
    fs.writeFileSync(lastFile, JSON.stringify(last, null, 2) + '\n');
  }
  fs.rmSync(stage, { recursive: true, force: true });
  console.log(`${release ? 'Video Downloader Legal' : 'VDL DEV'} ${ver}: ${outDir}`);
}
