'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const T = require('../src/tags.js');

test('every word of each target phrase is in the display name', () => {
  const name = pkg.displayName.toLowerCase();
  for (const phrase of ['auto rename tag', 'rename tag', 'auto close tag', 'close tag', 'highlight matching tag', 'jsx', 'vue']) {
    for (const w of phrase.split(' ')) assert.ok(name.includes(w), `${w} (${phrase})`);
  }
  assert.ok(pkg.displayName.startsWith('Tag Auto Rename'));
  // NAME GUARD: no rival product name as a run of words.
  for (const rival of ['auto rename tag', 'auto close tag', 'highlight matching tag', 'auto complete tag']) assert.ok(!name.includes(rival), rival);
});

test('engine floor from OVX1 and matching @types/vscode', () => {
  assert.equal(pkg.engines.vscode, '^1.90.0');
  assert.equal(pkg.devDependencies['@types/vscode'], '~1.90.0');
  assert.deepEqual(Object.keys(pkg.dependencies || {}), []);
});

test('linked editing is on by default for every handled language, and each one activates the extension', () => {
  for (const l of T.LANGUAGES) {
    assert.equal(pkg.contributes.configurationDefaults[`[${l}]`]['editor.linkedEditing'], true, l);
    assert.ok(pkg.activationEvents.includes(`onLanguage:${l}`), l);
  }
  assert.ok(!T.LANGUAGES.includes('typescript'));
});

test('every command in extension.js is declared, and every declared command is registered', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'extension.js'), 'utf8');
  const registered = [...src.matchAll(/registerCommand\(`\$\{SECTION\}\.(\w+)`/g)].map((m) => 'zovoTags.' + m[1]);
  registered.push('zovoTags.supportDeveloper', 'zovoTags.moreViewers'); // support.js
  const declared = pkg.contributes.commands.map((c) => c.command);
  for (const c of declared) assert.ok(registered.includes(c), 'not registered: ' + c);
  for (const c of registered) assert.ok(declared.includes(c), 'not declared: ' + c);
});

test('HTML closing is done here (one undo step), so VS Code\'s own HTML closing is off by default', () => {
  assert.equal(pkg.contributes.configurationDefaults['html.autoClosingTags'], false);
});

test('settings section, rating and support settings exist', () => {
  const p = pkg.contributes.configuration.properties;
  for (const k of ['renameOnType', 'closeOnType', 'highlightMatchingTag', 'disabledLanguages', 'maxFileSizeKB', 'maxFileLines', 'askForRating', 'showSupportLinks']) assert.ok(p['zovoTags.' + k], k);
  assert.equal(p['zovoTags.maxFileSizeKB'].default, 1024);
  assert.equal(p['zovoTags.maxFileLines'].default, 50000);
});

test('walkthrough media and icon exist; nothing reaches the network', () => {
  for (const s of pkg.contributes.walkthroughs[0].steps) assert.ok(fs.existsSync(path.join(root, s.media.markdown)), s.media.markdown);
  assert.ok(fs.existsSync(path.join(root, pkg.icon)));
  for (const f of fs.readdirSync(path.join(root, 'src'))) {
    const s = fs.readFileSync(path.join(root, 'src', f), 'utf8');
    assert.ok(!/require\(['"](https?|net|http2|dgram|child_process)['"]\)|fetch\(|XMLHttpRequest/.test(s), f);
  }
});

test('description says free, no sign-in, works offline', () => {
  assert.match(pkg.description, /Free, no sign-in, works offline\./);
  assert.ok(pkg.description.length <= 300);
});
