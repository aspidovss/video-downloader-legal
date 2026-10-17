import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { bundle, encodeSample, header, LAMEJS } from '../scripts/build-lamejs.mjs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function fakeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdl-fake-lamejs-'));
  fs.mkdirSync(path.join(dir, 'src/js'), { recursive: true });
  for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'src/js', n), t);
  return dir;
}

test('build-lamejs: dependencies first, each file once, upstream filters, header and wrapper', () => {
  const dir = fakeRepo({
    'index.js': "var A = require('./a.js');\r\nvar B = require('./b');\r\nA.run();\r\nmodule.exports = { A: A };\r\n",
    'a.js': "var c = require('./common.js');\nvar x = common.x;\nfunction A() {}\nassert (A);\nassert(\n 1);\nmodule.exports = {\n  A: A\n};\nmodule.exports.B = 1;\n",
    'b.js': "var A = require('./a.js');\nfunction B() {}\n",
    'common.js': 'function new_byte() {}\n',
  });
  try {
    const text = bundle(dir);
    assert.ok(text.startsWith(header()), 'starts with the licence header');
    assert.ok(text.includes('\nfunction lamejs() {\n'));
    assert.ok(text.endsWith('lamejs.Mp3Encoder = Mp3Encoder;\nlamejs.WavHeader = WavHeader;\n}\nlamejs();\n'));
    const pos = (s) => text.indexOf(s);
    assert.ok(pos('function new_byte') < pos('function A()'), 'common.js goes before the file that requires it');
    assert.ok(pos('function A()') < pos('function B()'), 'a.js goes before b.js');
    assert.equal(text.split('function A()').length, 2, 'a.js appears once');
    assert.ok(!/require\(/.test(text.slice(header().length)), 'require lines are dropped');
    assert.ok(!text.includes('var x = common.x'), 'lines with common.X; are dropped');
    assert.ok(!text.includes('assert (A)'), 'single-line assert is dropped');
    assert.ok(text.includes('assert(\n 1);'), 'a multi-line assert is kept (upstream filter is line based)');
    assert.ok(text.includes('var module_exports = {\n  A: A\n};'), 'module.exports = { becomes var module_exports = {');
    assert.ok(!text.includes('\r'), 'CRLF sources give LF output');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('vendor/lame.js: header, hash in THIRD-PARTY.md and vendor/README.md, no minified code', () => {
  const code = read('vendor/lame.js');
  assert.ok(code.startsWith(header()), 'the file starts with the header written by the build script');
  assert.ok(code.includes(LAMEJS.commit));
  const h = sha(Buffer.from(code));
  assert.ok(read('THIRD-PARTY.md').includes(h), 'THIRD-PARTY.md documents the SHA-256');
  assert.ok(read('vendor/README.md').includes(h), 'vendor/README.md documents the SHA-256');
  assert.ok(read('_locales/en/messages.json').includes(h), 'the help text documents the SHA-256');
  assert.ok(!code.includes('\r'), 'LF only');
  assert.ok(code.split('\n').length > 10000, 'many readable lines, not minified');
  assert.ok(!/\b\d+\(\)/.test(code.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '')), 'no calls of a number literal (the validator trips over them)');
});

test('vendor/lame.js: the encoder gives the same MP3 bytes as upstream lame.min.js did', () => {
  const r = encodeSample(read('vendor/lame.js'));
  assert.equal(r.bytes, 32600);
  assert.equal(r.sha256, 'df412c99825e13a6748494ca45d2627253f8ecabf6c7519e8d652827be83d829');
});

test('the extension loads vendor/lame.js, not the old pre-built file', () => {
  assert.equal(fs.existsSync(new URL('../vendor/lame.min.js', import.meta.url)), false);
  for (const f of ['platform/offscreen.html', 'service/main.js']) {
    assert.ok(read(f).includes('vendor/lame.js'), `${f} loads vendor/lame.js`);
    assert.ok(!read(f).includes('lame.min.js'), `${f} must not mention lame.min.js`);
  }
});

test('copyright: original authors, licence texts and the modification note are in place', () => {
  const code = read('vendor/lame.js');
  for (const who of ['Mark Taylor', 'Gabriel Bouvigne', 'Robert Hegemann', 'Takehiro', 'Naoki Shibata', 'Alexander Leidinger', 'David Robinson']) {
    assert.ok(code.includes(who), `${who}: the notice of the original author stays in vendor/lame.js`);
    assert.ok(read('THIRD-PARTY.md').includes(who.split(' ')[0] === 'Takehiro' ? 'Takehiro Tominaga' : who), `${who} is named in THIRD-PARTY.md`);
  }
  assert.ok(read('LICENSE').includes('Mark Taylor') && read('LICENSE').includes('Alex Zhukov'));
  assert.ok(/Not modified: .*assembled into one file by scripts\/build-lamejs\.mjs on 2026-/.test(code), 'dated note about the assembly');
  assert.ok(code.includes('https://lame.sourceforge.net/'));
  const faq = read('LICENSES/lamejs-LICENSE.txt');
  assert.ok(faq.includes('lame.sourceforge.net') && faq.includes('LGPL'), 'the licensing notes of lamejs are shipped');
  const lgpl = read('LICENSES/LGPL-3.0.txt');
  assert.ok(lgpl.includes('GNU LESSER GENERAL PUBLIC LICENSE') && lgpl.includes('Version 3, 29 June 2007'));
  for (let n = 0; n <= 6; n++) assert.ok(new RegExp(`^ *${n}\\. `, 'm').test(lgpl), `LGPL section ${n}`);
  assert.ok(read('THIRD-PARTY.md').includes('lamejs-LICENSE.txt') && read('LICENSE').includes('lamejs-LICENSE.txt'));
});
