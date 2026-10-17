// Firefox package.
//   node scripts/build-ff.mjs            -> build/video-downloader-legal-ff-<version_name>.xpi      (release, id video-downloader-legal@aspidovss)
//   node scripts/build-ff.mjs --dev      -> build/video-downloader-legal-dev-<version_name>.xpi     (separate add-on "VDL DEV" for AMO "On your own")
//   node scripts/build-ff.mjs --dev --n 4 -> version 1.6.0.4 (default: the number after "dev" in version_name, else 1)
// The source manifest is never changed: the dev package gets its own id, name and version in a temporary copy.
// Needs web-ext (npm install).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, existsSync, cpSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEV_ID = 'video-downloader-legal-dev@aspidovss';
export const DEV_NAME = 'VDL DEV - Video Downloader Legal';
export const ffName = (version, dev = false) => `video-downloader-legal-${dev ? 'dev' : 'ff'}-${version}.xpi`;

// dev manifest: own id and name; "version" must be unique on AMO and has to be numeric, so 1.6.0 + build number
export function devManifest(m, n) {
  const d = JSON.parse(JSON.stringify(m));
  const num = n ?? Number((/dev(\d+)/.exec(m.version_name || '') || [])[1] || 1);
  d.name = DEV_NAME;
  d.version = `${m.version}.${num}`;
  d.browser_specific_settings.gecko.id = DEV_ID;
  if (d.action) d.action.default_title = DEV_NAME;
  if (d.sidebar_action) d.sidebar_action.default_title = DEV_NAME;
  return d;
}

const IGNORE = ['tests', 'AMO', 'EDGE', 'docs', 'scripts', 'platform', '.github', '.gitignore', '.gitattributes', '.git', 'build', 'dist', 'node_modules', 'package.json', 'package-lock.json', 'README.md', 'README.ru.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'DONATE.md', 'PRIVACY.md', 'SECURITY.md'];

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dev = process.argv.includes('--dev');
  const ni = process.argv.indexOf('--n');
  const n = ni > 0 ? Number(process.argv[ni + 1]) : undefined;
  const m = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  let src = '.';
  if (dev) {
    const stage = path.join(root, 'build', 'ff-dev');
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    for (const f of ['manifest.json', 'LICENSE', 'LICENSES', 'THIRD-PARTY.md', '_locales', 'content', 'icons', 'injected', 'lib', 'service', 'styles', 'utils', 'vendor']) {
      if (existsSync(path.join(root, f))) cpSync(path.join(root, f), path.join(stage, f), { recursive: true });
    }
    writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(devManifest(m, n), null, 2) + '\n');
    src = path.join('build', 'ff-dev');
  }
  const tmp = 'video-downloader-legal-tmp.xpi';
  const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'web-ext.cmd' : 'web-ext');
  execFileSync(existsSync(bin) ? bin : 'web-ext', ['build', '--source-dir', src, '--overwrite-dest', '--filename', tmp, '--artifacts-dir', 'build', ...(dev ? [] : ['--ignore-files', ...IGNORE])], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  const out = path.join(root, 'build', ffName(m.version_name || m.version, dev));
  renameSync(path.join(root, 'build', tmp), out);
  console.log('Firefox package: ' + out);
}
