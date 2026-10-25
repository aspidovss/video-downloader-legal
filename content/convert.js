// The converter page (1.6.6): a file picked by the user (or dropped here) is converted in this page, on this computer.
// GIF and the PNG frame are taken from a <video> element, MP3 from the browser's audio decoder + lamejs,
// TS -> MP4 / MKV and fragmented MP4 -> MP4 are carried over without re-encoding (lib/ts2mp4.js, lib/mux.js).
import { t, translatePage, renderFooter, isAndroid } from '../utils/dom.js';
import { loadUiLang } from '../utils/i18n.js';
import '../lib/mux.js'; // publishes globalThis.__vdlMux
import { sniffKind, mp4TopBoxes, isFragmented, convertTargets, targetTrims, trimRange, parseTime, formatTime, pcmSlice, outName, gifEstimateBytes } from '../lib/convert.js';
import { videoToGif } from '../lib/gifvideo.js';
import { GIF_SIZES, GIF_FPS, GIF_LIMIT_SECONDS, gifPrefs } from '../lib/gifrules.js';
import { encodeMp3, decodeToPcm, MP3_MAX_SECONDS, MP3_BITRATES } from '../lib/mp3.js';
import { tsToMp4, tsToMkv, TS_MP4_MAX_BYTES } from '../lib/ts2mp4.js';
import { formatBytes, formatDuration } from '../lib/util.js';
import { makeRate, etaText } from '../lib/rate.js';
import { getSettings, addHistory } from '../utils/settings.js';

await loadUiLang();

const $ = (id) => document.getElementById(id);
const video = $('preview');
const state = { file: null, kind: '', work: null, workUrl: '', duration: 0, width: 0, height: 0, playable: false, fragmented: false, last: null, abort: null, busy: false };
let settings = {};

const TARGET_LABEL = { gif: 'convTgtGif', mp3: 'convTgtMp3', png: 'convTgtPng', mp4: 'convTgtMp4', mkv: 'convTgtMkv', defrag: 'convTgtDefrag' };
const fill = (sel, values, label, chosen) => {
  sel.replaceChildren(...values.map((v) => { const o = document.createElement('option'); o.value = String(v); o.textContent = label(v); return o; }));
  if (chosen != null && values.map(String).includes(String(chosen))) sel.value = String(chosen);
};

function waitFor(el, ok, ms = 20000) {
  return new Promise((resolve, reject) => {
    const done = (fn, v) => { clearTimeout(timer); el.removeEventListener(ok, onOk); el.removeEventListener('error', onBad); fn(v); };
    const onOk = () => done(resolve);
    const onBad = () => done(reject, new Error('decode'));
    const timer = setTimeout(() => done(reject, new Error('timeout')), ms);
    el.addEventListener(ok, onOk);
    el.addEventListener('error', onBad);
  });
}

// ---- status / progress ---------------------------------------------------------------
const rate = makeRate();
function progress(text, frac) {
  $('progress').hidden = false;
  $('progress').classList.remove('done', 'error');
  $('bar').style.width = `${Math.round(Math.max(0, Math.min(1, frac || 0)) * 100)}%`;
  let eta = '';
  if (frac > 0 && frac < 1) {
    rate.add(0, Math.round(frac * 1000));
    const left = etaText(rate.eta(1000), { s: t('unitSec'), min: t('unitMin'), h: t('unitHour') });
    eta = ` · ${left ? t('etaLeft').replace('{t}', left) : t('etaCalc')}`;
  }
  $('status').textContent = text + eta;
}
function finish(ok, text) {
  $('progress').hidden = false;
  $('progress').classList.add(ok ? 'done' : 'error');
  if (ok) $('bar').style.width = '100%';
  $('status').textContent = text;
}

// ---- picking a file --------------------------------------------------------------------
async function readHead(file, n = 4096) { return new Uint8Array(await file.slice(0, n).arrayBuffer()); }

async function openFile(file) {
  if (!file || state.busy) return;
  if (state.workUrl) URL.revokeObjectURL(state.workUrl);
  Object.assign(state, { file, kind: '', work: null, workUrl: '', duration: 0, width: 0, height: 0, playable: false, fragmented: false, last: null });
  $('work').hidden = false;
  $('result').hidden = true;
  $('progress').hidden = true;
  $('file-name').textContent = file.name;
  $('file-info').textContent = `· ${formatBytes(file.size)}`;
  $('target').replaceChildren();
  $('btn-run').disabled = true;
  video.hidden = true;
  $('no-preview').hidden = true;

  state.kind = sniffKind(await readHead(file), file.name, file.type);
  if (state.kind === 'mp4') {
    try {
      const boxes = await mp4TopBoxes(file.size, async (a, b) => new Uint8Array(await file.slice(a, b).arrayBuffer()), 64);
      state.fragmented = isFragmented(boxes);
    } catch { /* not an MP4 after all */ }
  }
  state.work = file;
  if (state.kind === 'ts') { // the browser plays no TS: a copy in MP4 is used for the preview, GIF, MP3 and PNG
    progress(t('convPreparing'), 0);
    state.work = file.size <= TS_MP4_MAX_BYTES ? await tsToMp4(file) : null;
    $('progress').hidden = true;
  }
  if (state.work) {
    state.workUrl = URL.createObjectURL(state.work);
    video.src = state.workUrl;
    try {
      if (video.readyState < 1) await waitFor(video, 'loadedmetadata');
      state.duration = isFinite(video.duration) ? video.duration : 0;
      state.width = video.videoWidth;
      state.height = video.videoHeight;
      state.playable = state.duration > 0;
    } catch { state.playable = false; }
  }
  if (!state.playable) { video.removeAttribute('src'); video.load(); }
  video.hidden = !state.playable;
  video.classList.toggle('audio-only', state.playable && !state.width);
  const info = [formatBytes(file.size)];
  if (state.duration) info.push(formatDuration(state.duration));
  if (state.width) info.push(`${state.width}×${state.height}`);
  $('file-info').textContent = `· ${info.join(' · ')}`;

  // GIF / PNG need a picture the browser can show, MP3 a file it can play; MP4 / MKV / fixed MP4 are carried over as they are
  const targets = convertTargets(state.kind, { video: state.playable && state.width > 0, audio: state.playable, fragmented: state.fragmented });
  $('no-preview').hidden = state.playable || !targets.length;
  if (!targets.length) {
    finish(false, t(state.kind === 'other' ? 'convNoTargets' : 'convNoPreview'));
    return;
  }
  fill($('target'), targets, (x) => t(TARGET_LABEL[x]), targets[0]);
  $('start').value = '';
  $('end').value = state.duration ? formatTime(state.duration) : '';
  $('at').value = '';
  $('btn-run').disabled = false;
  showOptions();
}

// ---- options ---------------------------------------------------------------------------
function showOptions() {
  const target = $('target').value;
  for (const el of document.querySelectorAll('[data-for]')) el.hidden = !el.dataset.for.split(' ').includes(target);
  checkRange();
}

function checkRange() {
  const target = $('target').value;
  const err = $('range-err');
  let msg = '';
  if (targetTrims(target)) {
    const r = trimRange($('start').value, $('end').value, state.duration);
    if (r.error) msg = t(r.error);
    else if (target === 'gif' && r.length > GIF_LIMIT_SECONDS + 0.5) msg = t('convTooLongGif').replace('{n}', String(GIF_LIMIT_SECONDS));
    else if (target === 'mp3' && state.duration > MP3_MAX_SECONDS) msg = t('convTooLongMp3').replace('{n}', String(MP3_MAX_SECONDS / 60));
    if (target === 'gif' && !r.error) {
      const bytes = gifEstimateBytes(Number($('gif-width').value), state.width / state.height || 16 / 9, r.length, Number($('gif-fps').value));
      $('gif-est').textContent = bytes ? `≈ ${formatBytes(bytes)}` : '';
    }
  } else if (target === 'png') {
    const at = parseTime($('at').value);
    if (Number.isNaN(at)) msg = t('convBadTime');
  } else if ((target === 'mp4' || target === 'mkv') && state.file.size > TS_MP4_MAX_BYTES) {
    msg = t('convTooLarge').replace('{n}', String(Math.round(TS_MP4_MAX_BYTES / 1048576)));
  }
  err.textContent = msg;
  err.hidden = !msg;
  $('btn-run').disabled = !!msg || state.busy;
  return !msg;
}

// ---- converting ------------------------------------------------------------------------
async function frameAt(sec) {
  video.pause();
  video.currentTime = Math.max(0, Math.min(sec, Math.max(0, state.duration - 0.001)));
  await waitFor(video, 'seeked');
  const c = document.createElement('canvas');
  c.width = state.width;
  c.height = state.height;
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('png'))), 'image/png'));
}

async function convert() {
  if (state.busy || !checkRange()) return;
  const target = $('target').value;
  const ac = new AbortController();
  state.abort = ac;
  state.busy = true;
  $('btn-run').disabled = true;
  $('btn-cancel').hidden = false;
  $('result').hidden = true;
  rate.reset();
  const range = targetTrims(target) ? trimRange($('start').value, $('end').value, state.duration) : {};
  try {
    let blob = null;
    let at;
    if (target === 'gif') {
      progress(t('convWorking').replace('{p}', '0'), 0);
      blob = await videoToGif(state.work, {
        maxWidth: Number($('gif-width').value), fps: Number($('gif-fps').value), maxSeconds: GIF_LIMIT_SECONDS,
        start: range.start, end: range.end, signal: ac.signal,
        onProgress: (p) => progress(t('convWorking').replace('{p}', String(Math.round(p * 100))), p),
      });
    } else if (target === 'mp3') {
      const lame = globalThis.lamejs;
      if (!lame?.Mp3Encoder) throw new Error(t('mp3Missing'));
      progress(t('convDecoding'), 0);
      let pcm;
      try { pcm = await decodeToPcm(await state.work.arrayBuffer()); } catch { throw new Error(t('convNoAudio')); }
      if (ac.signal.aborted) throw new Error('aborted');
      pcm = pcmSlice(pcm, range.start, range.end);
      rate.reset();
      const stem = state.file.name.replace(/\.[a-z0-9]{1,5}$/i, '');
      const parts = await encodeMp3(pcm, {
        kbps: Number($('kbps').value), lame, signal: ac.signal, title: stem,
        onProgress: (p) => progress(t('convWorking').replace('{p}', String(Math.round(p * 100))), p),
      });
      blob = new Blob(parts, { type: 'audio/mpeg' });
    } else if (target === 'png') {
      const typed = parseTime($('at').value);
      at = typed == null ? video.currentTime : typed;
      progress(t('convWorking').replace('{p}', '0'), 0);
      blob = await frameAt(at);
    } else if (target === 'mp4') {
      progress(t('convWorking').replace('{p}', '0'), 0);
      blob = state.kind === 'ts' && state.work !== state.file ? state.work : await tsToMp4(state.file);
      if (!blob) throw new Error(t('convRemuxFailed'));
    } else if (target === 'mkv') {
      progress(t('convWorking').replace('{p}', '0'), 0);
      blob = await tsToMkv(state.file, globalThis.__vdlMux);
      if (!blob) throw new Error(t('convRemuxFailed'));
      blob = new Blob([blob], { type: 'video/x-matroska' });
    } else if (target === 'defrag') {
      progress(t('convWorking').replace('{p}', '0'), 0);
      blob = await globalThis.__vdlMux.defragMp4(state.file);
      if (!blob) throw new Error(t('convRemuxFailed'));
      blob = new Blob([blob], { type: 'video/mp4' });
    }
    if (ac.signal.aborted) throw new Error('aborted');
    const name = outName(state.file.name, target, { ...range, at });
    state.last = { blob, name };
    finish(true, `${t('convDone')} · ${formatBytes(blob.size)}`);
    await save(blob, name);
    if (settings.history) {
      try { await addHistory({ title: name, url: `${t('convTitle')}: ${state.file.name}`, kind: 'file', filename: name }); } catch { /* ignore */ }
    }
  } catch (e) {
    const m = String(e?.message || e);
    const aborted = ac.signal.aborted || e?.code === 'aborted' || m === 'aborted';
    finish(false, aborted ? t('convCanceled') : e?.code === 'gifTooLong' ? t('convTooLongGif').replace('{n}', String(GIF_LIMIT_SECONDS))
      : e?.code === 'gifDecode' ? t('convNoPreview') : t('convFailed').replace('{e}', m));
  } finally {
    state.busy = false;
    state.abort = null;
    $('btn-cancel').hidden = true;
    checkRange();
  }
}

// ---- saving ----------------------------------------------------------------------------
const revokeLater = new Map(); // download id -> blob: address
async function save(blob, name) {
  const url = URL.createObjectURL(blob);
  $('result').hidden = false;
  $('result-text').textContent = t('convSaved').replace('{name}', name).replace('{size}', formatBytes(blob.size));
  if (!isAndroid() && typeof browser.downloads?.download === 'function') {
    try {
      const id = await browser.downloads.download({ url, filename: name, saveAs: !!settings.saveAs, conflictAction: 'uniquify' });
      revokeLater.set(id, url);
      return;
    } catch (e) {
      if (/cancel/i.test(String(e?.message || e))) { URL.revokeObjectURL(url); $('result-text').textContent = t('convCanceled'); return; }
      // anything else: the link below
    }
  }
  const a = document.createElement('a'); // Firefox for Android, or downloads.download refused the file
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}
try {
  browser.downloads.onChanged.addListener((d) => {
    const st = d.state?.current;
    if (!revokeLater.has(d.id) || (st !== 'complete' && st !== 'interrupted')) return;
    URL.revokeObjectURL(revokeLater.get(d.id));
    revokeLater.delete(d.id);
  });
} catch { /* no downloads API */ }

// ---- opened from History: "Convert…" names the file to pick ------------------------------
async function historyHint() {
  const name = new URLSearchParams(location.search).get('name');
  if (!name) return;
  $('from-history').hidden = false;
  $('from-history-text').textContent = t('convFromHistory').replace('{name}', name);
  const btn = $('btn-show-file');
  if (isAndroid() || typeof browser.downloads?.show !== 'function') { btn.hidden = true; return; }
  let id = null;
  try {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = await browser.downloads.search({ filenameRegex: `(^|[\\\\/])${esc}$`, orderBy: ['-startTime'], limit: 5 });
    id = found.find((d) => d.exists !== false && d.state === 'complete')?.id ?? null;
  } catch { /* ignore */ }
  if (id == null) { btn.hidden = true; return; }
  btn.onclick = () => { try { browser.downloads.show(id); } catch { /* ignore */ } };
}

// ---- wiring ----------------------------------------------------------------------------
async function init() {
  translatePage();
  renderFooter();
  document.title = t('convTitle');
  settings = await getSettings();
  const gp = gifPrefs(settings);
  fill($('gif-width'), GIF_SIZES, (w) => `${w}px`, gp.width);
  fill($('gif-fps'), GIF_FPS, (n) => String(n), gp.fps);
  fill($('kbps'), MP3_BITRATES, (k) => `${k} kbps`, 192);

  $('file').addEventListener('change', (e) => openFile(e.target.files?.[0]));
  const drop = $('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); openFile(e.dataTransfer?.files?.[0]); });
  document.addEventListener('dragover', (e) => e.preventDefault()); // a file dropped beside the box is not opened as a page
  document.addEventListener('drop', (e) => { e.preventDefault(); if (e.target !== drop && !drop.contains(e.target)) openFile(e.dataTransfer?.files?.[0]); });

  $('target').addEventListener('change', showOptions);
  for (const id of ['start', 'end', 'at', 'gif-width', 'gif-fps']) $(id).addEventListener('input', checkRange);
  for (const id of ['gif-width', 'gif-fps']) $(id).addEventListener('change', checkRange);
  const now = (id) => () => { $(id).value = formatTime(video.currentTime || 0); checkRange(); };
  $('start-now').onclick = now('start');
  $('end-now').onclick = now('end');
  $('at-now').onclick = now('at');
  $('btn-run').onclick = convert;
  $('btn-cancel').onclick = () => state.abort?.abort();
  $('btn-save-again').onclick = () => state.last && save(state.last.blob, state.last.name);
  await historyHint();
}

init();
