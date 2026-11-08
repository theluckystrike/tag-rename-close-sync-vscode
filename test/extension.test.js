'use strict';
// extension.js with a small fake vscode module: who closes tags, and snippet escaping.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function load(installed, settings) {
  const fake = {
    extensions: { getExtension: (id) => (installed.map((x) => x.toLowerCase()).includes(id.toLowerCase()) ? { id } : undefined), onDidChange: () => ({ dispose() {} }) },
    workspace: { getConfiguration: (s) => ({ get: (k, d) => (settings[s + '.' + k] !== undefined ? settings[s + '.' + k] : d) }) },
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? fake : orig.call(this, req, ...rest); };
  try {
    delete require.cache[require.resolve('../src/extension.js')];
    return require('../src/extension.js');
  } finally {
    Module._load = orig;
  }
}

test('VS Code closes JSX tags itself: this extension stays out; HTML is ours unless the user turns html.autoClosingTags on', () => {
  const e = load([], { 'html.autoClosingTags': false });
  assert.equal(e.otherCloser('html'), '');
  assert.match(load([], { 'html.autoClosingTags': true }).otherCloser('html'), /HTML/);
  assert.match(e.otherCloser('typescriptreact'), /TypeScript/);
  assert.match(e.otherCloser('javascriptreact'), /JavaScript/);
  for (const l of ['vue', 'svelte', 'php', 'blade', 'twig', 'xml', 'markdown', 'erb']) assert.equal(e.otherCloser(l), '', l);
});

test('with the built-in switched off, this extension closes HTML and JSX', () => {
  const e = load([], { 'html.autoClosingTags': false, 'typescript.autoClosingTags': false, 'javascript.autoClosingTags': false });
  assert.equal(e.otherCloser('html'), '');
  assert.equal(e.otherCloser('typescriptreact'), '');
});

test('language extensions that close tags take over; the old Auto Close Tag takes over everywhere', () => {
  const e = load(['Vue.volar', 'svelte.svelte-vscode', 'redhat.vscode-xml'], {});
  assert.match(e.otherCloser('vue'), /Vue/);
  assert.match(e.otherCloser('svelte'), /Svelte/);
  assert.match(e.otherCloser('xml'), /XML/);
  const f = load(['formulahendry.auto-close-tag'], {});
  assert.match(f.otherCloser('php'), /Auto Close Tag/);
});

test('snippet text escapes $, } and backslash', () => {
  const e = load([], {});
  assert.equal(e.snippetText('</$Comp>'), '</\\$Comp>');
  assert.equal(e.snippetText('a}b\\'), 'a\\}b\\\\');
});

test('the "</" handler passes the whole text, so "</" typed before an existing name adds nothing', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/extension.js'), 'utf8');
  assert.match(src, /closeAfterSlash\(res, offset, doc\.getText\(\)\)/);
  const T = require('../src/tags.js');
  const t = '<ul><li>x</div></ul>';
  const off = t.indexOf('</div') + 2;
  assert.equal(T.closeAfterSlash(T.analyze(t, T.profileFor('php')), off, t), null);
});
