// Minimal XML parser with the small DOM surface lib/dash.js needs (documentElement, childNodes,
// nodeType, localName, getAttribute, textContent). The Chrome service worker has no DOMParser.
// Supports elements, attributes, text, comments, CDATA, processing instructions, self-closing tags
// and the standard / numeric character references.

class El {
  constructor(name) {
    this.nodeType = 1;
    this.nodeName = name;
    this.localName = name.includes(':') ? name.split(':')[1] : name;
    this.attrs = {};
    this.childNodes = [];
  }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  get textContent() { return this.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); }
}

const unescapeXml = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export class MiniDOMParser {
  parseFromString(text) {
    const root = new El('#document');
    const stack = [root];
    const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(text))) {
      const top = stack[stack.length - 1];
      if (m[1] !== undefined) top.childNodes.push({ nodeType: 3, data: m[1] });
      else if (m[2]) { if (stack.length > 1) stack.pop(); }
      else if (m[3]) {
        const el = new El(m[3]);
        const ar = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
        let a;
        while ((a = ar.exec(m[4]))) el.attrs[a[1]] = unescapeXml(a[3] ?? a[4]);
        top.childNodes.push(el);
        if (!m[5]) stack.push(el);
      } else if (m[6] !== undefined && m[6].trim()) top.childNodes.push({ nodeType: 3, data: unescapeXml(m[6]) });
    }
    return { documentElement: root.childNodes.find((n) => n.nodeType === 1) };
  }
}
