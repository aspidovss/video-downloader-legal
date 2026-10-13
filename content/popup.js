import { h, t, translatePage, browserName } from '../utils/dom.js';
import { loadUiLang } from '../utils/i18n.js';

await loadUiLang();
import { formatBytes, formatDuration } from '../lib/util.js';
import { hasConsent, acceptConsent } from '../utils/consent.js';
import { saveSettings } from '../utils/settings.js';
import { groupByType, pickQuality, pickType, groupAudio, pickAudioQuality } from '../lib/youtube.js';

let tabId = null;

const $list = document.getElementById('list');
const $jobs = document.getElementById('jobs');
const $empty = document.getElementById('empty');
const selectedVariant = new Map(); // itemId -> variant index

async function refresh(force = false) {
  if (tabId === null) return;
  let state;
  try {
    state = await browser.runtime.sendMessage({ type: 'get_state', tabId });
  } catch {
    return;
  }
  prefs = state.prefs || prefs;
  const ids = new Set((state.items || []).map((i) => i.id));
  liveJobs = new Map((state.jobs || []).filter((j) => j.recording && j.state === 'running' && ids.has(j.itemId)).map((j) => [j.itemId, j]));
  renderJobs((state.jobs || []).filter((j) => !(j.recording && j.state === 'running' && ids.has(j.itemId))));
  renderItems(state.items, force);
  maybeCcNotice(state.items);
  renderBug(state.bug || null);
}

function kindBadge(it) {
  const label = { file: 'FILE', hls: 'HLS', dash: 'DASH', yt: 'YT' }[it.kind] || it.kind.toUpperCase();
  return h('span', { class: `badge kind-${it.kind}` }, label);
}
const clock = (sec) => `${Math.floor(sec / 3600)}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;

// "● Recording 0:00:44" / "4.5 MB": two lines, white on red
const recStat = (sec, size) => h('div', { class: 'recstat' }, h('span', { class: 'rs-time' }, `● ${t('liveRecording')} ${clock(sec)}`), h('span', { class: 'rs-size' }, size || '0 MB'));

let showSmall = false;
let liveJobs = new Map(); // item id -> running live recording job (shown inside the item's card)
let prefs = { defaultQuality: 'best', defaultType: 'auto', defaultAudioFormat: 'mp3', defaultAudioQuality: 'best', ytRecordUi: false };

// Per card: chosen type + quality for YouTube videos (indexes refer to it.variants).
function ytPick(it, groups) {
  const sel = selectedVariant.get(it.id) || {};
  const group = groups.find((g) => g.type === sel.type) || pickType(groups, prefs.defaultType, prefs.defaultQuality);
  const chosen = group.items.find((v) => v.index === sel.index) || pickQuality(group.items, prefs.defaultQuality);
  return { group, chosen };
}

function card(it) {
  const liveRec = it.live && it.kind === 'hls';
  const disabled = it.protected || (it.live && !liveRec) || !!it.noteKey || it.status === 'error' || it.status === 'parsing';
  const meta = [
    it.kind === 'yt' ? '' : it.quality,
    it.kind === 'yt' ? '' : (it.size ? formatBytes(it.size) : ''),
    it.hasAudioTrack ? t('twoFiles') : '',
  ].filter(Boolean).join(' · ');

  const sizeText = (v) => (v.size ? ` · ${v.sizeEstimated ? '~' : ''}${formatBytes(v.size)}${v.perMin ? `/${t('perMinute')}` : ''}` : '');
  // Video variants and audio-only variants are shown separately; indexes refer to it.variants.
  const withIdx = (it.variants || []).map((v, index) => ({ ...v, index }));
  const videoVariants = it.kind === 'yt' ? withIdx.filter((v) => !v.audio) : withIdx;
  const audioVariants = it.kind === 'yt' ? withIdx.filter((v) => v.audio) : (it.audioVariants || []);

  const download = async (e, variant) => {
    e.target.disabled = true;
    const res = await browser.runtime.sendMessage({
      type: 'download', tabId, itemId: it.id, variant, variantLabel: it.variants?.[variant]?.label,
    });
    if (!res.ok) e.target.disabled = false;
    setTimeout(refresh, 300);
  };

  // ---- video row: [type] [resolution · size] [Download]. Same for YouTube, DASH and HLS; plain files: just the button.
  let videoRow = null;
  const quick = (e, variant) => download(e, variant);
  if (!it.noteKey && videoVariants.length && (it.kind === 'yt' || it.kind === 'dash' || it.kind === 'hls')) {
    const groups = groupByType(videoVariants);
    const { group, chosen } = ytPick(it, groups);
    const typeSel = groups.length > 1 || it.kind === 'yt' ? h('select', {
      class: 'type', 'aria-label': t('videoType'), title: group.codec,
      onchange: (e) => { selectedVariant.set(it.id, { type: e.target.value }); refresh(true); },
    }, groups.map((g) => h('option', { value: g.type, selected: g.type === group.type, title: g.codec }, g.label))) : null;
    const qSel = h('select', {
      class: 'quality', 'aria-label': t('quality'),
      onchange: (e) => selectedVariant.set(it.id, { type: group.type, index: Number(e.target.value) }),
    }, group.items.map((v) => h('option', { value: v.index, selected: v.index === chosen.index }, `${(v.label || `#${v.index + 1}`).split(' · ')[0]}${v.fmt ? ` · ${v.fmt.toUpperCase()}` : ''}${sizeText(v)}`)));
    videoRow = h('div', { class: 'row-dl' }, typeSel, qSel,
      h('button', { class: 'primary', disabled, onclick: (e) => quick(e, Number(qSel.value)) }, t(liveRec ? 'liveRecord' : 'download')));
  } else if (!it.noteKey && !(it.kind === 'yt' && it.live)) {
    videoRow = h('div', { class: 'row-dl' }, h('button', { class: 'primary wide', disabled, onclick: (e) => download(e, 0) }, t(liveRec ? 'liveRecord' : 'download')));
  }

  const rj = liveJobs.get(it.id);
  if (rj) {
    videoRow = h('div', { class: 'rec' }, h('div', { class: 'row' },
      recStat(rj.seconds || 0, formatBytes(rj.bytes || 0)),
      h('button', { class: 'primary small', disabled: !!rj.stopping, onclick: () => browser.runtime.sendMessage({ type: 'stop_job', jobId: rj.id }) }, t('liveStop')),
      h('button', { class: 'small', onclick: () => browser.runtime.sendMessage({ type: 'cancel_job', jobId: rj.id }) }, t('cancel'))));
  }

  let note = null;
  if (it.noteKey) note = h('div', { class: 'note warn' }, t(it.noteKey));
  else if (it.protected) note = h('div', { class: 'note warn' }, t('drm'));
  else if (it.kind === 'yt' && it.live) note = h('div', { class: 'note warn' }, t('ytLiveNote'));
  else if (liveRec) note = h('div', { class: 'note' }, t('liveNote'));
  else if (it.live) note = h('div', { class: 'note warn' }, t('liveStream'));
  else if (it.status === 'error') note = h('div', { class: 'note warn' }, t('parseError'));
  else if (it.status === 'parsing') note = h('div', { class: 'note' }, t('parsing'));

  if (!note && it.limitMB) note = h('div', { class: 'note warn' }, t('ytLimitedNote').replace('{mb}', String(it.limitMB)));

  const dur = it.duration && !liveRec ? h('span', { class: 'dur' }, formatDuration(it.duration)) : null;
  const thumb = it.thumbnail && /^https?:/i.test(it.thumbnail)
    ? h('img', { class: 'thumb', src: it.thumbnail, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy', onerror: (e) => e.target.replaceWith(h('div', { class: 'thumb empty' }, '▶')) })
    : h('div', { class: 'thumb empty' }, '▶');

  return h('article', { class: 'card' },
    h('div', { class: 'head' },
      h('div', { class: 'thumbwrap' }, thumb, dur),
      h('div', { class: 'info' },
        h('div', { class: 'title', title: it.caption ? `${it.caption}\n${it.title}` : it.title }, it.caption || it.title),it.caption ? h('div', { class: 'subtitle' }, it.title) : null,
        h('div', { class: 'meta' }, kindBadge(it), liveRec ? h('span', { class: 'badge live' }, 'LIVE') : null, it.beta ? h('span', { class: 'badge live' }, 'BETA') : null, meta ? ` ${meta}` : ''))),
    note,
    videoRow,
    !it.noteKey && audioVariants.length ? audioControls(it, audioVariants, sizeText) : null,
    it.kind === 'yt' && (it.apiState === 'failed' || it.dlFailed) ? h('div', { class: 'note' }, t('busyHint')) : null,
    it.kind === 'yt' && showFallback(it) ? recControls(it) : null,
    recordHidden(it) ? h('div', { class: 'note warn' }, t('ytRecordDisabledHint'), h('div', { class: 'actions' }, h('button', { class: 'primary small', onclick: enableRecordUi }, t('ytRecordEnable')))) : null,
    it.kind === 'yt' && it.apiState === 'loading' && !it.variants.length ? h('div', { class: 'note' }, t('ytApiLoading')) : null);
}

// The recording fallback is offered only when no method produced downloadable links,
// when a real download failed, or while a recording is already in progress / finished.
function showFallback(it) {
  const r = it.rec?.state;
  if (r && r !== 'idle') return true; // a recording in progress / finished stays visible
  if (it.live) return true; // live streams are recorded from the player: always offered
  return !!prefs.ytRecordUi; // regular videos: only when the option is turned on in the settings
}

// Option off and no way to get the video: say where the recording option is
// Turns the option on and reloads the page, so the recording controls appear
async function enableRecordUi() {
  try { await saveSettings({ ytRecordUi: true }); } catch { /* ignore */ }
  try { if (tabId !== null) await browser.tabs.reload(tabId); } catch { /* ignore */ }
  window.close();
}
const recordHidden = (it) => it.kind === 'yt' && !it.live && !prefs.ytRecordUi && !(it.rec?.state && it.rec.state !== 'idle') && (it.apiState === 'failed' || !!it.dlFailed);

// "Audio only": [format] [bitrate · size] [Download]. MP3 is converted in the browser; M4A/WEBM are the original tracks.
function audioControls(it, audioVariants, sizeText) {
  const groups = groupAudio(audioVariants);
  if (!groups.length) return null;
  const sel = selectedVariant.get(`${it.id}:audio`) || {};
  const usableGroup = (g) => g.items.some((v) => !v.unavailable && !v.tooLong);
  const group = groups.find((g) => g.type === sel.type)
    || groups.find((g) => g.type === prefs.defaultAudioFormat && usableGroup(g))
    || groups.find(usableGroup) || groups[0];
  const usable = group.items.filter((v) => !v.unavailable && !v.tooLong);
  const chosen = group.items.find((v) => v.index === sel.index)
    || pickAudioQuality(usable.length ? usable : group.items, prefs.defaultAudioQuality, group.type === 'mp3');
  const liveYt = it.kind === 'yt' && !!it.live; // a live stream is only recorded from the player: no separate audio download
  const typeSel = h('select', {
    class: 'type', 'aria-label': t('audioOnly'), disabled: liveYt,
    onchange: (e) => { selectedVariant.set(`${it.id}:audio`, { type: e.target.value }); refresh(true); },
  }, groups.map((g) => h('option', { value: g.type, selected: g.type === group.type }, g.label)));
  const note = (v) => (v.unavailable ? ` · ${t('mp3Unavailable')}` : v.tooLong ? ` · ${t('mp3TooLongShort')}` : '');
  const qSel = h('select', {
    class: 'quality', 'aria-label': t('quality'), disabled: liveYt,
    onchange: (e) => selectedVariant.set(`${it.id}:audio`, { type: group.type, index: Number(e.target.value) }),
  }, group.items.map((v) => h('option', { value: v.index, selected: v.index === chosen.index, disabled: v.unavailable || v.tooLong },
    `${v.kbps ? `${v.kbps}k` : ''}${sizeText(v)}${note(v)}`.replace(/^ · /, ''))));
  return h('div', { class: 'row-dl audio' },
    typeSel, qSel,
    h('button', {
      class: 'primary', title: t('downloadAudio'),
      disabled: liveYt || !chosen || chosen.unavailable || chosen.tooLong || it.status === 'parsing',
      onclick: async (e) => {
        e.target.disabled = true;
        const v = Number(qSel.value);
        const pickedAudio = group.items.find((x) => x.index === v);
        const msg = it.kind === 'yt'
          ? { type: 'download', tabId, itemId: it.id, variant: v, variantLabel: it.variants?.[v]?.label }
          : { type: 'download', tabId, itemId: it.id, variant: 0, audio: { rep: pickedAudio?.rep ?? 0, mp3: !!pickedAudio?.mp3, kbps: pickedAudio?.kbps || 0 } };
        const res = await browser.runtime.sendMessage(msg);
        if (!res.ok) e.target.disabled = false;
        setTimeout(refresh, 300);
      },
    }, t('download')));
}

function recControls(it) {
  const r = it.rec || { state: 'idle' };
  const send = (cmd) => browser.runtime.sendMessage({ type: 'yt_rec', tabId, cmd }).then(() => setTimeout(refresh, 300));
  const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

  if (r.state === 'recording' && r.draining) {
    return h('div', { class: 'rec' }, h('div', { class: 'meta' }, `● ${t('ytLiveFinishing')} ${r.live ? `${clock(r.seconds || 0)} · ` : ''}${mb(r.bytes || 0)}`));
  }
  if (r.state === 'recording' && r.live) {
    return h('div', { class: 'rec' },
      h('div', { class: 'row' },
        recStat(r.seconds || 0, mb(r.bytes || 0)),
        h('button', { class: 'primary small', onclick: () => send('stop_save') }, t('liveStop')),
        h('button', { class: 'small', onclick: () => send('cancel') }, t('cancel'))));
  }
  if (r.state === 'recording') {
    const pct = Math.round((r.progress || 0) * 100);
    return h('div', { class: 'rec' },
      h('div', { class: 'bar' }, h('div', { class: 'fill', style: `width:${pct}%` })),
      h('div', { class: 'row' },
        h('span', { class: 'meta' }, `${t('ytRecording')}: ${pct}% · ${mb(r.bytes || 0)}`),
        h('button', { class: 'primary small', onclick: () => send('stop_save') }, t('liveStop')),
        h('button', { class: 'small', onclick: () => send('cancel') }, t('cancel'))));
  }

  if (r.state === 'done' || r.state === 'saved') {
    const tracks = (r.tracks || []).map((x) => `${x.kind === 'video' ? `${x.height || '?'}p ` : 'audio '}${x.ext}`).join(' + ');
    return h('div', { class: 'rec' },
      r.interrupted ? h('div', { class: 'note warn' }, t('ytRecInterrupted')) : null,
      h('div', { class: 'meta' }, `${t(r.state === 'saved' ? 'ytRecSaved' : 'ytRecDone')} ${tracks} · ${mb(r.bytes || 0)}`),
      h('div', { class: 'actions' },
        h('button', { class: 'primary', onclick: () => send('save') }, t('ytRecSave')),
        (r.tracks || []).some((x) => x.kind === 'audio')
          ? h('button', { onclick: () => send('save_audio') }, t('ytRecSaveAudio')) : null));
  }

  const err = r.state === 'error'
    ? h('div', { class: 'note warn' }, { drm: t('ytRecErrDrm'), toolarge: t('ytRecErrTooLarge'), start: t('ytRecErrStart') }[r.error] || `${t('ytRecError')}: ${r.error}`)
    : null;
  return h('div', { class: 'rec' },
    err,
    h('div', { class: 'actions' }, h('button', { class: it.live || !(it.variants || []).length ? 'primary' : '', onclick: () => send('start') }, t(it.live ? 'ytLiveRecord' : 'ytRecord')), it.live ? null : h('span', { class: 'badge live' }, 'BETA')),
    h('div', { class: 'meta' }, t(it.live ? 'ytLiveHint' : 'ytRecordHint')));
}

function renderItems(items, force = false) {
  // Keep the open <select> alone while the user interacts with it.
  if (!force && document.activeElement && document.activeElement.tagName === 'SELECT') return;
  // DASH first, then HLS, then plain files; plain files go under "More" when a stream was found (and files under 1 MB, usually previews, always) unless nothing else was found.
  const rank = (it) => ({ yt: 0, dash: 1, hls: 2 }[it.kind] ?? 3);
  const sorted = items.map((it, i) => ({ it, i })).sort((a, b) => rank(a.it) - rank(b.it) || a.i - b.i).map((x) => x.it);
  const hasStream = items.some((x) => ['yt', 'dash', 'hls'].includes(x.kind));
  const small = (it) => it.kind === 'file' && (it.secondary || hasStream || (it.size > 0 && it.size < 1048576));
  const main = sorted.filter((x) => !small(x));
  const rest = sorted.filter(small);
  const nodes = main.length ? main.map(card) : rest.map(card);
  if (main.length && rest.length) {
    nodes.push(h('button', { class: 'more', onclick: () => { showSmall = !showSmall; refresh(true); } }, `${t('moreFiles')} (${rest.length}) ${showSmall ? '▴' : '▾'}`));
    if (showSmall) nodes.push(...rest.map(card));
  }
  $list.replaceChildren(...nodes);
  $empty.hidden = items.length > 0;
}

function renderJobs(jobs) {
  $jobs.replaceChildren(...jobs.map((j) => {
    const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
    const label = j.recording ? `● ${t('liveRecording')} ${clock(j.seconds || 0)} · ${formatBytes(j.bytes || 0)}` : {
      running: `${j.phase === 'mp3' ? 'MP3 ' : j.phase === 'convert' ? 'MP4 ' : ''}${pct}%${j.fileCount > 1 ? ` (${j.fileIndex}/${j.fileCount})` : ''}`,
      done: t('done'),
      canceled: t('canceled'),
      error: j.errorKey ? t(j.errorKey) : `${t('failed')}: ${j.error}`,
    }[j.state];
    const finished = j.state !== 'running';
    return h('div', { class: `job ${j.state}` },
      h('div', { class: 'jobhead' },
        h('div', { class: 'title' }, j.title),
        finished ? h('button', { class: 'close', title: t('dismiss'), 'aria-label': t('dismiss'), onclick: async () => { await browser.runtime.sendMessage({ type: 'dismiss_job', jobId: j.id, tabId }); refresh(true); } }, '✕') : null),
      j.recording ? null : h('div', { class: 'bar' }, h('div', { class: 'fill', style: `width:${j.state === 'done' ? 100 : pct}%` })),
      h('div', { class: 'row' },
        h('span', {}, label),
        j.recording
          ? h('button', { class: 'primary small', disabled: !!j.stopping, onclick: () => browser.runtime.sendMessage({ type: 'stop_job', jobId: j.id }) }, t('liveStop'))
          : null,
        j.state === 'running'
          ? h('button', { onclick: () => browser.runtime.sendMessage({ type: 'cancel_job', jobId: j.id }) }, t('cancel'))
          : null),
      j.state === 'error' && (/HTTP (?:403|410|429)\b/.test(j.error || '') || ['ytDirectBlocked', 'ytLimited'].includes(j.errorKey)) ? h('div', { class: 'note' }, t('busyHint')) : null,
      j.state === 'done' && j.downloadId !== null && j.downloadId !== undefined && typeof browser.downloads.show === 'function'
        ? h('div', { class: 'jobbtns' },
          h('button', { class: 'small', onclick: () => { try { browser.downloads.show(j.downloadId); } catch { /* ignore */ } } }, t('openFolder')))
        : null);
  }));
}

const REPO = 'https://github.com/aspidovss/video-downloader-legal';
const MAIL = 'vdl@aspidov.ru';

function reportText(file, site) {
  const v = browser.runtime.getManifest().version_name || browser.runtime.getManifest().version;
  return [
    `VDL ${v}, ${site || 'YouTube'}`,
    `${t('bugTplSite')}: ${site || 'YouTube'}`,
    `${t('bugTplVersion')}: ${v}`,
    `${browserName()} / ${t('bugTplSystem')}: ${navigator.userAgent}`,
    `${t('bugTplDid')}: `,
    `${t('bugTplHappened')}: `,
    `${t('bugTplFile')}: ${file}`,
  ].join('\n');
}

// Once: a YouTube video that is not Creative Commons was met while the (default) restriction is on.
let ccChecked = false;
async function maybeCcNotice(items) {
  if (ccChecked || !(items || []).some((i) => i.noteKey === 'ytCcBlocked')) return;
  ccChecked = true;
  try { if ((await browser.storage.local.get('ccNoticeShown')).ccNoticeShown) return; } catch { /* show it */ }
  const $n = document.getElementById('cc-notice');
  $n.hidden = false;
  document.body.classList.add('cc-notice-open');
  const close = async (turnOff) => {
    try { await browser.storage.local.set({ ccNoticeShown: true }); } catch { /* ignore */ }
    if (turnOff) { try { await saveSettings({ ytCcOnly: false }); } catch { /* ignore */ } }
    $n.hidden = true;
    document.body.classList.remove('cc-notice-open');
  };
  document.getElementById('cc-off').onclick = () => close(true);
  document.getElementById('cc-keep').onclick = () => close(false);
}
let bugKey = '';

function renderBug(bug) {
  const $p = document.getElementById('bug-panel');
  const $btn = document.getElementById('btn-bug');
  const key = bug ? `${bug.state}:${bug.file}:${bug.startedAt}` : '';
  if (!bug) { $p.hidden = true; $btn.disabled = false; bugKey = ''; return; }
  $p.hidden = false;
  $btn.disabled = bug.state === 'running';
  if (key === bugKey) return; // keep scroll / selection while nothing changed
  bugKey = key;
  if (bug.state === 'running') {
    $p.replaceChildren(h('div', { class: 'panel wait' },
      h('h3', {}, h('span', { class: 'spinner' }), t('bugRunningTitle')),
      h('div', {}, t('bugRunningText'))));
    return;
  }
  if (bug.state === 'error') {
    $p.replaceChildren(h('div', { class: 'panel' }, h('div', { class: 'note warn' }, t('bugNotifError'))));
    return;
  }
  const text = reportText(bug.file, bug.site);
  const title = encodeURIComponent(`VDL ${browser.runtime.getManifest().version_name || ''}: ${bug.site || 'YouTube'}`);
  const body = encodeURIComponent(text);
  const copy = (value) => async (e) => {
    try { await navigator.clipboard.writeText(value); e.target.textContent = t('bugCopied'); } catch { e.target.textContent = t('bugCopyFail'); }
  };
  // One block: the short report (editable: fill in what you did / what happened) + the diagnostics file content.
  const SEP = '\n\n\n';
  const box = h('textarea', { class: 'bugjson', rows: 14, spellcheck: 'false' });
  box.value = text;
  browser.runtime.sendMessage({ type: 'bug_text', tabId }).then((r) => { if (r?.text) box.value = `${box.value}${SEP}${r.text}`; }).catch(() => {});
  // links carry only the short part (a URL cannot hold the whole file)
  const headOf = () => { const i = box.value.indexOf(`${SEP}{`); return i >= 0 ? box.value.slice(0, i) : box.value; };
  const gh = h('a', { class: 'btn', href: `${REPO}/issues/new?title=${title}&body=${body}`, target: '_blank', rel: 'noopener' }, t('bugGithub'));
  const mail = h('a', { class: 'btn', href: `mailto:${MAIL}?subject=${title}&body=${body}` }, t('bugEmail'));
  const relink = () => {
    const b = encodeURIComponent(headOf());
    gh.href = `${REPO}/issues/new?title=${title}&body=${b}`;
    mail.href = `mailto:${MAIL}?subject=${title}&body=${b}`;
  };
  box.addEventListener('input', relink);
  $p.replaceChildren(h('div', { class: 'panel' },
    h('h3', {}, t('bugDoneTitle')),
    h('div', {}, `${t('bugDoneText')} `, h('b', {}, bug.file)),
    h('div', { class: 'note' }, t('bugPrivacy')),
    h('div', {}, t('bugSendIntro')),
    box,
    h('div', { class: 'btns' },
      h('button', { onclick: (e) => copy(box.value)(e) }, t('bugCopy')),
      gh, mail),
    h('div', { class: 'note' }, t('bugAttachHint'))));
}

// First run (and after the consent is withdrawn): the terms cover the whole window until accepted.
// Declining closes the popup (and the Firefox sidebar); the terms are shown again next time.
function consentGate() {
  return new Promise((resolve) => {
    document.getElementById('consent-accept').onclick = async () => {
      await acceptConsent();
      document.body.classList.remove('needs-consent');
      resolve();
    };
    document.getElementById('consent-decline').onclick = () => {
      try { browser.sidebarAction?.close?.(); } catch { /* not a sidebar */ }
      window.close();
    };
  });
}

async function init() {
  translatePage();
  if (!(await hasConsent())) await consentGate();
  else document.body.classList.remove('needs-consent');
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;

  document.getElementById('btn-settings').onclick = () => browser.runtime.openOptionsPage();
  document.getElementById('btn-history').onclick = () => browser.tabs.create({ url: browser.runtime.getURL('content/history.html') });
  document.getElementById('btn-reload').onclick = async () => {
    if (tabId !== null) await browser.tabs.reload(tabId);
    window.close();
  };

  if (typeof browser.downloads.showDefaultFolder !== 'function') document.getElementById('btn-folder').hidden = true; // Android
  document.getElementById('btn-folder').onclick = () => { try { browser.downloads.showDefaultFolder(); } catch { /* ignore */ } };
  document.getElementById('btn-help').onclick = () => browser.tabs.create({ url: browser.runtime.getURL('content/help.html') });
  document.getElementById('btn-bug').onclick = async () => {
    document.getElementById('btn-bug').disabled = true;
    try { await browser.runtime.sendMessage({ type: 'yt_bug', tabId }); } catch { /* shown through state */ }
    refresh();
  };

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'state_changed') refresh();
  });
  await refresh();
  setInterval(refresh, 2000);
}

init();
