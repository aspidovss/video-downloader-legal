import { translatePage, renderFooter, initFoldable, h, t } from '../utils/dom.js';
import { loadUiLang } from '../utils/i18n.js';

await loadUiLang();

const REPO = 'https://github.com/aspidovss/video-downloader-legal';
const MAIL = 'vdl@aspidov.ru';
const LAME = 'https://github.com/zhuker/lamejs';
const LGPL = 'https://www.gnu.org/licenses/lgpl-3.0.html';

// **bold** and `code` inside a message -> elements (textContent only, never innerHTML)
function rich(text) {
  const out = [];
  const re = /\*\*(.+?)\*\*|`(.+?)`/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[1] ? h('strong', {}, m[1]) : h('code', {}, m[2]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
const link = (href, label) => h('a', { href, target: '_blank', rel: 'noopener' }, label || href);
const li = (key) => h('li', {}, rich(t(key)));
const list = (keys, ordered) => h(ordered ? 'ol' : 'ul', {}, keys.map(li));
const section = (titleKey, ...body) => h('fieldset', { class: 'prefs', 'data-fold': titleKey }, h('legend', {}, t(titleKey)), ...body);
const intro = (...body) => h('fieldset', { class: 'prefs', 'data-fold': 'helpIntro' }, h('legend', {}, t('appName')), ...body);

function build() {
  const root = document.getElementById('help');
  root.replaceChildren(
    intro(h('p', { class: 'src' }, h('strong', {}, `${t('helpLabelCode')}: `), link(REPO)), h('p', {}, t('helpLead'))),
    section('helpS1', list(['helpS1a', 'helpS1b', 'helpS1c', 'helpS1d'], true), h('p', {}, t('helpS1q'))),
    section('helpS2', list(['helpF1', 'helpF2', 'helpF3', 'helpF4', 'helpF5', 'helpF6'])),
    section('helpS3', list(['helpP1', 'helpP2', 'helpP3'])),
    section('helpS4', list(['helpT1', 'helpT2', 'helpT3', 'helpT4'])),
    section('helpS5', list(['helpL1', 'helpL2', 'helpL3', 'helpL4'])),
    section('helpS6', h('p', {}, t('helpV1'))),
    section('helpS7', h('ul', {},
      h('li', {}, `${t('helpLabelIssues')}: `, link(REPO)),
      h('li', {}, `${t('helpLabelMail')}: `, link(`mailto:${MAIL}`, MAIL)),
      h('li', {}, `${t('helpLabelAuthor')}: AspidovSS · MIT`))),
    section('helpS8',
      h('p', {}, rich(t('helpC1'))),
      h('ul', {},
        h('li', {}, `${t('helpLabelLink')}: `, link(LAME)),
        h('li', {}, 'LAME: ', link('https://lame.sourceforge.net/')),
        h('li', {}, `${t('helpLabelLicense')}: `, link(LGPL, 'LGPL-3.0')),
        li('helpC2'), li('helpC3')),
      h('p', {}, rich(t('helpLame')), ' ', link('https://lame.sourceforge.net/')),
      h('p', {}, rich(t('helpC4'))),
      h('p', {}, t('helpC5'))));
}

translatePage();
renderFooter();
build();
initFoldable(document.querySelectorAll('#help > fieldset.prefs'), 'vdlHelpFolded');
