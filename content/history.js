import { h, t, translatePage, renderFooter } from '../utils/dom.js';
import { loadUiLang } from '../utils/i18n.js';

await loadUiLang();
import { getHistory, removeHistory, clearHistory } from '../utils/settings.js';

const $list = document.getElementById('list');
const $empty = document.getElementById('empty');

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
      h('button', { onclick: async () => { await removeHistory(x.id); render(); } }, t('remove'))))));
}

translatePage();
renderFooter();
document.getElementById('btn-clear').onclick = async () => { await clearHistory(); render(); };
render();
