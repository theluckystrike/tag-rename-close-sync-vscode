'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../src/tags.js');

const pf = (lang) => T.profileFor(lang);
const an = (text, lang) => T.analyze(text, pf(lang));
// "|" marks the cursor; returns [text without it, offset]
const at = (s) => [s.replace('|', ''), s.indexOf('|')];
const linked = (s, lang) => { const [t, o] = at(s); const r = T.linkedRanges(an(t, lang), o); return r && r.map(([a, b]) => t.slice(a, b) + '@' + a); };
const gt = (s, lang) => { const [t, o] = at(s); return T.closeAfterGt(an(t, lang), o); };
const slash = (s, lang) => { const [t, o] = at(s); return T.closeAfterSlash(an(t, lang), o, t); };
const pairs = (text, lang) => { const r = an(text, lang); return r.toks.map((t, k) => (t.t === T.OPEN ? '<' : '</') + t.name + (r.partner[k] >= 0 ? '=' + r.partner[k] : '')).join(' '); };

test('profiles: typescript has none (generics), tsx and html do', () => {
  assert.equal(T.profileFor('typescript'), null);
  assert.equal(T.profileFor('plaintext'), null);
  assert.equal(pf('typescriptreact').mode, 'jsx');
  assert.equal(pf('html').mode, 'html');
  assert.equal(pf('xml').ci, false);
  assert.equal(T.profileFor('mytemplates', ['mytemplates']).mode, 'html');
});

test('rename: open and close tag names are linked, open first', () => {
  assert.deepEqual(linked('<di|v class="a">x</div>', 'html'), ['div@1', 'div@18']);
  assert.deepEqual(linked('<div class="a">x</d|iv>', 'html'), ['div@1', 'div@18']);
  assert.deepEqual(linked('<div|>x</div>', 'html'), ['div@1', 'div@8']);
  assert.deepEqual(linked('<|div>x</div>', 'html'), ['div@1', 'div@8']);
});

test('rename: nothing outside a name, for voids, for unpaired or differently named tags', () => {
  assert.equal(linked('<div cl|ass="a">x</div>', 'html'), null);
  assert.equal(linked('<div>x|</div>', 'html'), null);
  assert.equal(linked('<p>a<b|r>b</p>', 'html'), null);
  assert.equal(linked('<p>a<br|/>b</p>', 'html'), null);
  assert.equal(linked('<di|v>x', 'html'), null);
  assert.equal(linked('<section>x</sec|tio>', 'html'), null);
});

test('the reported <br> case: a <br> inside a paragraph never pairs and is never closed', () => {
  assert.equal(pairs('<p>line<br>next</p>', 'html'), '<p=2 <br </p=0');
  assert.equal(gt('<p>line<br>|</p>', 'html'), null);
  assert.equal(gt('<p>line<BR>|</p>', 'html'), null);
  assert.deepEqual(linked('<p|>line<br>next</p>', 'html'), ['p@1', 'p@17']);
  for (const v of ['img', 'input', 'hr', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']) assert.equal(gt(`<${v}>|`, 'html'), null, v);
});

test('html names compare without case, xml and vue with case', () => {
  assert.deepEqual(linked('<D|IV>x</div>', 'html'), ['DIV@1', 'div@8']);
  assert.equal(linked('<D|IV>x</div>', 'xml'), null);
  assert.equal(linked('<My|Comp>x</mycomp>', 'vue'), null);
  assert.deepEqual(linked('<My|Comp>x</MyComp>', 'vue'), ['MyComp@1', 'MyComp@11']);
});

test('tags in comments, strings, CDATA, script, style and textarea are skipped', () => {
  const html = '<div><!-- <p> --><script>var s = "</div>"; if (a<b) {}</script><style>a>b{content:"<i>"}</style><textarea><b></textarea>' +
    '<![CDATA[ <x> ]]><span title="a > b" data-x=\'<em>\'>t</span></div>';
  const r = an(html, 'html');
  assert.deepEqual(r.toks.map((t) => (t.t === T.OPEN ? '<' : '</') + t.name), ['<div', '<script', '</script', '<style', '</style', '<textarea', '</textarea', '<span', '</span', '</div']);
  assert.equal(r.partner[0], 9);
});

test('script body with an unclosed script runs to the end; xml has no raw elements', () => {
  assert.deepEqual(an('<script>if (a < b) "<div>"', 'html').toks.map((t) => t.name), ['script']);
  assert.deepEqual(an('<script><b>x</b></script>', 'xml').toks.map((t) => t.name), ['script', 'b', 'b', 'script']);
});

test('tolerant pairing: optional end tags and stray closing tags', () => {
  const t = '<ul><li>one<li>two</li></ul></span><div><p>a<p>b</div>';
  assert.equal(pairs(t, 'html'), '<ul=4 <li <li=3 </li=2 </ul=0 </span <div=9 <p <p </div=6');
});

test('auto close after ">"', () => {
  assert.equal(gt('<div>|', 'vue'), '</div>');
  assert.equal(gt('<div class="a" :x="b > c">|', 'vue'), '</div>');
  assert.equal(gt('<my-comp v-if="a">|\n</div>', 'vue'), '</my-comp>');
  assert.equal(gt('<x-alert type="error">|', 'blade'), '</x-alert>');
  assert.equal(gt('<svelte:head>|', 'svelte'), '</svelte:head>');
  assert.equal(gt('<button on:click={() => n > 1}>|', 'svelte'), '</button>');
  assert.equal(gt('<LinearLayout android:orientation="vertical">|', 'xml'), '</LinearLayout>');
  assert.equal(gt('<div/>|', 'vue'), null);
  assert.equal(gt('<div>|</div>', 'vue'), null);
  assert.equal(gt('<div>x</div>|', 'vue'), null);
  assert.equal(gt('a > b|', 'vue'), null);
  assert.equal(gt('<div class="a>|', 'vue'), null);
});

test('auto close inside an element of the same name (TypeScript rule)', () => {
  assert.equal(gt('<div>\n  <div>|\n</div>', 'vue'), '</div>');
  assert.equal(gt('<div>\n  <div>|\n</div>\n</div>', 'vue'), null);
  assert.equal(gt('<section>\n  <div>|\n</section>', 'vue'), '</div>');
});

test('auto close never fires in comments, strings, template blocks or code', () => {
  assert.equal(gt('<!-- <div>| -->', 'html'), null);
  assert.equal(gt('<?php echo "<div>|"; ?>', 'php'), null);
  assert.equal(gt('<?php if ($a <b>|) {}', 'php'), null);
  assert.equal(gt('{{ a <b>| }}', 'vue'), null);
  assert.equal(gt('{% if a <b>| %}', 'twig'), null);
  assert.equal(gt('<% if a <b>| %>', 'erb'), null);
  assert.equal(gt('{#if a <b>|}{/if}', 'svelte'), null);
  assert.equal(gt('```html\n<div>|\n```', 'markdown'), null);
  assert.equal(gt('Use `<div>|` here', 'markdown'), null);
  assert.equal(gt('<details>|', 'markdown'), '</details>');
});

test('markdown autolinks and e-mails are not tags', () => {
  assert.equal(gt('see <https://example.com>|', 'markdown'), null);
  assert.equal(gt('mail <me@example.com>|', 'markdown'), null);
});

test('auto close after "</"', () => {
  assert.equal(slash('<ul><li>x</|', 'php'), 'li>');
  assert.equal(slash('<ul><li>x</li></|', 'php'), 'ul>');
  assert.equal(slash('<p>a<br></|', 'php'), 'p>');
  assert.equal(slash('<div><img src=x></|', 'html'), 'div>');
  assert.equal(slash('<div>x</|div>', 'html'), null);
  assert.equal(slash('</|', 'html'), null);
  assert.equal(slash('<div><!-- </| -->', 'html'), null);
  assert.equal(slash('<div><script>"</|"', 'html'), null);
  assert.equal(slash('<root><item>x</|', 'xml'), 'item>');
});

test('JSX: comparisons and generics are not tags', () => {
  const src = 'const a = b < c && d > e;\nconst s = useState<string>("");\nconst f = <T,>(x: T) => x;\nconst g = <T extends object>(x: T) => x;\ntype F = <T>(x: T) => T;\nconst m = new Map<string, number>();';
  assert.equal(an(src, 'typescriptreact').toks.length, 0);
});

test('JSX: strings, regexes, template literals and comments are skipped', () => {
  const src = 'const r = /<div>/g; const s = "<p>"; const t = `<b>${"<i>"}</b>`; // <x>\n/* <y> */ const el = <span>ok</span>;';
  assert.equal(pairs(src, 'typescriptreact'), '<span=1 </span=0');
});

test('JSX: expression containers, text with quotes, fragments, member names', () => {
  const src = 'return (<div className="a">\n {a < b && c > d ? <span>x</span> : null}\n <p>It\'s "fine"</p>\n <>\n <Box.Item />\n </>\n</div>);';
  const r = an(src, 'typescriptreact');
  assert.deepEqual(r.toks.map((t) => (t.t === T.OPEN ? '<' : '</') + t.name + (t.self ? '/' : '')), ['<div', '<span', '</span', '<p', '</p', '<', '<Box.Item/', '</', '</div']);
  assert.equal(r.partner[0], 8);
  assert.equal(r.partner[5], 7);
});

test('JSX: linked rename and closing', () => {
  {
    const src = 'const a = <Butt|on onClick={() => x > 1}>Go</Button>;';
    assert.deepEqual(linked(src, 'typescriptreact'), ['Button@11', 'Button@' + (src.replace('|', '').indexOf('</Button') + 2)]);
  }
  assert.equal(gt('const a = <div className="x">|', 'typescriptreact'), '</div>');
  assert.equal(gt('const a = <div>\n  <span>|\n</div>;', 'typescriptreact'), '</span>');
  assert.equal(gt('const a = <div>\n  <div>|\n</div>;', 'typescriptreact'), '</div>');
  assert.equal(gt('const a = <div>|</div>;', 'typescriptreact'), null);
  assert.equal(gt('const s = useState<string>|', 'typescriptreact'), null);
  assert.equal(gt('if (a <b>|', 'javascriptreact'), null);
  assert.equal(slash('const a = <ul><li>x</|', 'javascriptreact'), 'li>');
});

test('JSX: keywords that start an expression', () => {
  assert.equal(pairs('function A() { return <a></a> }', 'javascriptreact'), '<a=1 </a=0');
  assert.equal(pairs('export default <a></a>', 'javascriptreact'), '<a=1 </a=0');
  assert.equal(pairs('x = y ? <a/> : <b/>', 'javascriptreact'), '<a <b');
});

test('the generics review case: Observable<boolean> in a .ts file is never closed', () => {
  assert.equal(T.profileFor('typescript'), null);
  assert.equal(gt('const x: Observable<boolean>|', 'typescriptreact'), null);
});

test('unfinished tags while typing do not break the rest of the file', () => {
  assert.equal(pairs('<div class="a\n<p>x</p>', 'html'), '<div <p=2 </p=1');
  assert.equal(pairs('<div <p>x</p>', 'html'), '<div <p=2 </p=1');
});

test('elementAt and elementAround', () => {
  const t = '<a><b>xy</b></a>';
  const r = an(t, 'html');
  const e = T.elementAt(r, 7);
  assert.deepEqual([r.toks[e.open].name, e.onTag], ['b', -1]);
  const f = T.elementAround(r, 3, 12);
  assert.equal(r.toks[f.open].name, 'a');
  const g = T.elementAt(r, 10);
  assert.equal(g.onTag, 2);
});

test('5,000 nested divs: no stack overflow, all paired', () => {
  const n = 5000;
  const t = '<div>'.repeat(n) + 'x' + '</div>'.repeat(n);
  for (const lang of ['html', 'typescriptreact', 'xml']) {
    const src = lang === 'typescriptreact' ? 'const a = ' + t + ';' : t;
    const r = an(src, lang);
    assert.equal(r.toks.length, 2 * n);
    assert.ok([...r.partner].every((p) => p >= 0), lang);
  }
});

test('speed: a 10,000-line file answers ">" in under 30 ms', () => {
  const row = (i) => `  <tr data-i="${i}"><td class="a">${i}</td><td>${i} &lt; ${i + 1}</td></tr>`;
  const t = '<table>\n' + Array.from({ length: 10000 }, (_, i) => row(i)).join('\n') + '\n<div>';
  const t0 = performance.now();
  const ins = T.closeAfterGt(T.analyze(t, pf('vue')), t.length);
  const ms = performance.now() - t0;
  assert.equal(ins, '</div>');
  assert.ok(ms < 30, ms + ' ms');
});

test('real sample files: every tag pairs or is void/self-closing', () => {
  const dir = path.join(__dirname, '..', 'samples');
  const lang = { html: 'html', vue: 'vue', svelte: 'svelte', tsx: 'typescriptreact', twig: 'twig', xml: 'xml', svg: 'xml', md: 'markdown' };
  let files = 0;
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith('hostile') || f === 'SOURCES.md') continue;
    const l = f.endsWith('.blade.php') ? 'blade' : f.endsWith('.php') ? 'php' : lang[f.split('.').pop()];
    if (!l) continue;
    const r = an(fs.readFileSync(path.join(dir, f), 'utf8'), l);
    const bad = r.toks.filter((t, k) => r.partner[k] < 0 && !t.self && !(t.t === T.OPEN && r.pf.voids && T.VOID.has(t.name.toLowerCase())));
    assert.equal(bad.length, 0, f + ': ' + bad.map((t) => t.name).join(','));
    assert.ok(r.toks.length > 0, f);
    files++;
  }
  assert.ok(files >= 12, String(files));
});

test('hostile samples pair as a browser or the TypeScript parser would', () => {
  const dir = path.join(__dirname, '..', 'samples');
  const h = an(fs.readFileSync(path.join(dir, 'hostile-unbalanced.html'), 'utf8'), 'html');
  const names = h.toks.map((t) => (t.t === T.OPEN ? '<' : '</') + t.name).join(' ');
  assert.ok(!/<nav|<em|<span(?! )/.test(names.replace('</span', '')), names);
  const outer = h.toks.findIndex((t) => t.name === 'div');
  assert.equal(h.toks[h.partner[outer]].name, 'div');
  const j = an(fs.readFileSync(path.join(dir, 'hostile-jsx.tsx'), 'utf8'), 'typescriptreact');
  assert.equal(j.toks.filter((t) => t.t === T.OPEN).map((t) => t.name).join(','), 'div,span,em,p,li,,Box.Item,input');
});

test('validName', () => {
  for (const ok of ['div', 'my-comp', 'svelte:head', 'Box.Item', 'x-slot:title', 'h1']) assert.ok(T.validName(ok), ok);
  for (const bad of ['', 'https:', '1a', 'a b', 'a>b', 'a"b']) assert.ok(!T.validName(bad), bad);
});
