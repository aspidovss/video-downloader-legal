// Firefox package: build/video-downloader-legal-ff-<version_name>.xpi (same file set as `web-ext build` with the ignore list below).
// Needs web-ext (npm install). The name uses version_name (for example 1.6.0dev3), web-ext itself would use only "version".
import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const m = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
export const ffName = (version) => `video-downloader-legal-ff-${version}.xpi`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tmp = 'video-downloader-legal-ff-tmp.xpi';
  const ignore = ['tests', 'AMO', 'EDGE', 'docs', 'scripts', 'platform', '.github', '.gitignore', 'build', 'dist', 'node_modules', 'package.json', 'package-lock.json', 'README.md', 'README.ru.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'DONATE.md', 'PRIVACY.md', 'SECURITY.md'];
  const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'web-ext.cmd' : 'web-ext');
  execFileSync(existsSync(bin) ? bin : 'web-ext', ['build', '--source-dir', '.', '--overwrite-dest', '--filename', tmp, '--artifacts-dir', 'build', '--ignore-files', ...ignore], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  const out = path.join(root, 'build', ffName(m.version_name || m.version));
  renameSync(path.join(root, 'build', tmp), out);
  console.log('Firefox package: ' + out);
}
