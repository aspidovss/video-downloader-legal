// Builds vendor/lame.js (the MP3 encoder) from the lamejs sources, so nobody has to trust a pre-built file.
//
//   node scripts/build-lamejs.mjs            fetch lamejs 1.2.1 from GitHub, bundle it, compare with vendor/lame.js
//   node scripts/build-lamejs.mjs --write    ...and overwrite vendor/lame.js with the result
//   node scripts/build-lamejs.mjs --src DIR  use an existing checkout of the lamejs repository (no network)
//   node scripts/build-lamejs.mjs --compare  also encode a test signal with the bundle and with the upstream
//                                            lame.min.js of the same checkout and require identical MP3 bytes
//   node scripts/build-lamejs.mjs --out FILE write the bundle to FILE (default build/lamejs/lame.js)
//
// What it does (the same job as upstream makeall.sh, without browserify and without a minifier):
//   1. takes the CommonJS files under src/js, starting at index.js;
//   2. puts every file after the files it require()s (a plain depth-first walk, each file once);
//   3. drops the lines that only wire the modules together (`require(...)`, `common.X;`, `module.exports ...;`),
//      turns `module.exports = {` into `var module_exports = {` and drops single-line assert(...) calls
//      (exactly the filters of upstream makeall.sh);
//   4. wraps the result in `function lamejs() { ... } lamejs();` and exposes Mp3Encoder and WavHeader.
// The result is plain readable JavaScript. Needs Node.js 18+ and git; nothing else, no npm packages.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const LAMEJS = {
  repo: 'https://github.com/zhuker/lamejs.git',
  tag: '1.2.1',
  commit: '32f6198fc9d7dc69894977152a08442607738c40',
  bundled: '2026-10-14', // date written into the header; changes only when the bundling rules change
};

const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');

export function header(meta = LAMEJS) {
  return [
    `/* lamejs ${meta.tag} - JavaScript port of the LAME MP3 encoder (lamejs is a rewrite of jump3r, which is a rewrite of libmp3lame).`,
    ' * License: LGPL-3.0 (LICENSES/LGPL-3.0.txt). LAME project: https://lame.sourceforge.net/',
    ` * Upstream: ${meta.repo.replace(/\.git$/, '')} (tag ${meta.tag}, commit ${meta.commit}).`,
    ` * Not modified: the code below is the upstream source of src/js, assembled into one file by scripts/build-lamejs.mjs on ${meta.bundled}.`,
    ' * The assembly is the one of upstream makeall.sh without the minifier: the lines that only wire the modules together',
    ' * (require(), module.exports, single-line assert()) are left out, nothing else is changed.',
    ' * The copyright notices of the original authors are kept in the files below. */',
  ].join('\n');
}

// srcDir = a checkout of the lamejs repository. Returns the bundle text.
export function bundle(srcDir, meta = LAMEJS) {
  const entry = path.resolve(srcDir, 'src/js/index.js');
  const order = [];
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      let dep = path.resolve(path.dirname(file), m[1]);
      if (!dep.endsWith('.js')) dep += '.js';
      visit(dep);
    }
    order.push(file);
  };
  visit(entry);
  const out = ['function lamejs() {'];
  for (const file of order) {
    for (const line of fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n')) {
      if (/common\..*;/.test(line) || /require\(/.test(line) || /module\.exports.*;$/.test(line)) continue;
      out.push(line.replace(/^module\.exports = \{/, 'var module_exports = {'));
    }
  }
  out.push('L3Side.SFBMAX = (Encoder.SBMAX_s * 3);', 'lamejs.Mp3Encoder = Mp3Encoder;', 'lamejs.WavHeader = WavHeader;', '}', 'lamejs();');
  return `${header(meta)}\n${out.filter((l) => !/^\s*assert\s*\(.*\);/.test(l)).join('\n')}\n`;
}

// Encodes a fixed 2-second stereo test signal with the encoder defined by `code`; returns the SHA-256 of the MP3.
export function encodeSample(code) {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const enc = new ctx.lamejs.Mp3Encoder(2, 44100, 128);
  const n = 44100 * 2;
  const l = new Int16Array(n);
  const r = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = Math.round(12000 * Math.sin(i * 0.05) + 3000 * Math.sin(i * 0.31));
    r[i] = Math.round(9000 * Math.sin(i * 0.037 + 1));
  }
  const parts = [];
  for (let i = 0; i < n; i += 1152) {
    const b = enc.encodeBuffer(l.subarray(i, i + 1152), r.subarray(i, i + 1152));
    if (b.length) parts.push(Buffer.from(b));
  }
  parts.push(Buffer.from(enc.flush()));
  const mp3 = Buffer.concat(parts);
  return { bytes: mp3.length, sha256: sha256(mp3) };
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error) throw new Error(`git is needed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return r.stdout.trim();
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const vendorFile = path.join(root, 'vendor', 'lame.js');
  const outFile = path.resolve(opt('--out') || path.join(root, 'build', 'lamejs', 'lame.js'));
  let srcDir = opt('--src');
  let tmp = null;
  try {
    if (!srcDir) {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-lamejs-'));
      srcDir = path.join(tmp, 'lamejs');
      console.log(`Fetching ${LAMEJS.repo} (tag ${LAMEJS.tag}) ...`);
      git(['clone', '--quiet', '--depth', '1', '--branch', LAMEJS.tag, LAMEJS.repo, srcDir]);
    }
    srcDir = path.resolve(srcDir);
    let head = '';
    try { head = git(['rev-parse', 'HEAD'], srcDir); } catch { /* not a git checkout */ }
    if (head && head !== LAMEJS.commit) throw new Error(`the checkout is at ${head}, expected ${LAMEJS.commit} (tag ${LAMEJS.tag})`);
    if (!head) console.log('Warning: the source folder is not a git checkout, so its commit cannot be verified.');

    const text = bundle(srcDir);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, text);
    const built = sha256(text);
    console.log(`Built:   ${outFile}\nSHA-256: ${built}`);

    if (argv.includes('--compare')) {
      const min = path.join(srcDir, 'lame.min.js');
      if (!fs.existsSync(min)) throw new Error('--compare needs lame.min.js in the checkout');
      const a = encodeSample(text);
      const b = encodeSample(fs.readFileSync(min, 'utf8'));
      const same = a.sha256 === b.sha256 && a.bytes === b.bytes;
      console.log(`Test signal: bundle ${a.bytes} bytes ${a.sha256.slice(0, 16)}, upstream lame.min.js ${b.bytes} bytes ${b.sha256.slice(0, 16)} -> ${same ? 'identical MP3' : 'DIFFERENT'}`);
      if (!same) process.exitCode = 1;
    }

    if (argv.includes('--write')) {
      fs.copyFileSync(outFile, vendorFile);
      console.log(`Written: ${vendorFile}`);
    } else if (fs.existsSync(vendorFile)) {
      const have = sha256(fs.readFileSync(vendorFile));
      if (have === built) console.log('vendor/lame.js: MATCH - the file in the repository is exactly what the sources produce.');
      else { console.log(`vendor/lame.js: DIFFERENT (${have})`); process.exitCode = 1; }
    }
  } catch (e) {
    console.error(`build-lamejs: ${e.message}`);
    process.exitCode = 1;
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
