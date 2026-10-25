import { h, t, translatePage, renderFooter } from '../utils/dom.js';
import { loadUiLang } from '../utils/i18n.js';

await loadUiLang();
import { getHistory, removeHistory, clearHistory } from '../utils/settings.js';

const $list = document.getElementById('list');
const $empty = document.getElementById('empty');

// 1.6.6: "Convert…" opens the converter with the name of the file to pick (an extension cannot read the downloads folder itself)
const MEDIA = /\.(mp4|m4v|webm|mkv|ts|mov|m4a|mp3|ogg|opus)$/i;
const firstFile = (x) => String(x.filename || '').split(' + ').map((f) => f.split(/[\\/]/).pop()).find((f) => MEDIA.test(f)) || '';
const convertable = (x) => !!firstFile(x);
async function openConvert(x) {
  await browser.tabs.create({ url: browser.runtime.getURL(`content/convert.html?name=${encodeURIComponent(firstFile(x))}`) });
}

async function render() {
  const items = await getHistory();
  $empty.hidden = items.length > 0;
  $list.replaceChildren(...items.map((x) => h('article', { class: 'card' },
    h('div', { class: 'info' },
      h('div', { class: 'title', title: x.title }, x.title),
      h('div', { class: 'meta' }, new Date(x.ts).toLocaleString(), ' · ', x.filename),
      h('div', { class: 'meta' }, h('span', { class: `badge kind-${x.kind}` }, x.kind.toUpperCase()), ' ', x.url.slice(0, 90)),
    ),
    h('div', { class: 'actions' },
      convertable(x) ? h('button', { title: t('convFromHistoryHint'), onclick: () => openConvert(x) }, t('convOpen')) : null,
      h('button', { onclick: async () => { await removeHistory(x.id); render(); } }, t('remove'))))));
}

translatePage();
renderFooter();
document.getElementById('btn-clear').onclick = async () => { await clearHistory(); render(); };
render();
