import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const dir = new URL('../_locales/', import.meta.url);
const read = (l) => JSON.parse(fs.readFileSync(new URL(`${l}/messages.json`, dir), 'utf8'));
const en = read('en');
const langs = fs.readdirSync(dir);

test('10 languages shipped', () => {
  assert.deepEqual(langs.sort(), ['ar', 'de', 'en', 'es', 'fr', 'hi', 'ja', 'pt_BR', 'ru', 'zh_CN']);
});

for (const l of fs.readdirSync(dir)) {
  test(`locale ${l}: same keys, placeholders kept, description fits AMO limit`, () => {
    const m = read(l);
    assert.deepEqual(Object.keys(m).sort(), Object.keys(en).sort());
    for (const [k, v] of Object.entries(m)) {
      assert.ok(typeof v.message === 'string' && v.message.length > 0, `${l}.${k} empty`);
      for (const tok of en[k].message.match(/\{\w+\}/g) || []) assert.ok(v.message.includes(tok), `${l}.${k} lost ${tok}`);
    }
    assert.ok(m.appDesc.message.length <= 132, `${l} appDesc ${m.appDesc.message.length}`);
  });
}
