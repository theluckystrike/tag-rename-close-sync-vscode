'use strict';
// Auto Rename Tag & Auto Close Tag by Zovo.
// - Rename: a LinkedEditingRangeProvider, so VS Code's own linked editing mirrors the edit in the same undo step.
//   The extension turns editor.linkedEditing on for its languages (configurationDefaults in package.json).
// - Close: on ">" and "</" it inserts the closing tag with one snippet edit that joins the typing undo step.
//   Where VS Code or a language extension already closes tags (HTML, JSX/TSX, Vue, Svelte...), it lets that run.
// - Highlight: the matching tag of the tag under the cursor.
// No network, no telemetry. The only message is the rating ask (src/rate.js) after real use.
const vscode = require('vscode');
const tags = require('./tags');
const { createRatingPrompt } = require('./rate');
const { registerSupport, footerMarkdown } = require('./support');

const EXT_ID = 'zovo.zovo-auto-rename-tag';
const SECTION = 'zovoTags';
const NAME = 'Auto Rename Tag';
const WORD = /[^\s<>/="'`{}]+/;

let rating = { success() {}, failure() {} };
const counted = new Set(); // documents already counted for the rating ask in this window session
const practice = new Set(); // practice documents opened from the walkthrough

// ---- settings ----
function cfg(doc) {
  const c = vscode.workspace.getConfiguration(SECTION, doc ? { uri: doc.uri, languageId: doc.languageId } : undefined);
  return {
    rename: c.get('renameOnType', true) !== false,
    close: c.get('closeOnType', true) !== false,
    highlight: c.get('highlightMatchingTag', true) !== false,
    disabled: c.get('disabledLanguages', []) || [],
    extra: c.get('additionalHtmlLanguages', []) || [],
    maxKB: Number(c.get('maxFileSizeKB', 1024)) || 1024,
    maxLines: Number(c.get('maxFileLines', 50000)) || 50000,
    statusBar: c.get('showStatusBar', true) !== false,
  };
}

function profileOf(doc) {
  if (!doc) return null;
  const c = cfg(doc);
  if (c.disabled.includes(doc.languageId)) return null;
  return tags.profileFor(doc.languageId, c.extra);
}

function handled(doc) {
  return !!doc && !!tags.profileFor(doc.languageId, cfg(doc).extra);
}

function isLarge(doc) {
  const c = cfg(doc);
  if (doc.lineCount > c.maxLines) return true;
  // offsetAt of the end is the length in UTF-16 units; close enough to bytes for this limit
  return doc.offsetAt(doc.lineAt(doc.lineCount - 1).range.end) > c.maxKB * 1024;
}

// ---- one scan per document version ----
const cache = new Map();
function analyzeDoc(doc, pf) {
  const key = doc.uri.toString();
  const hit = cache.get(key);
  if (hit && hit.version === doc.version && hit.pf === pf) return hit.res;
  const res = tags.analyze(doc.getText(), pf);
  cache.set(key, { version: doc.version, pf, res });
  return res;
}

function countUse(doc) {
  const key = doc.uri.toString();
  if (counted.has(key)) return;
  counted.add(key);
  if (practice.has(key)) rating.success({ sample: true });
  else rating.success(doc.uri);
}

// ---- who else closes tags ----
const extOn = (id) => { try { return !!vscode.extensions.getExtension(id); } catch { return false; } };
const setting = (section, key) => vscode.workspace.getConfiguration(section).get(key);

/** Name of the feature that already closes tags in this language, or '' when we do it. */
function otherCloser(languageId) {
  if (extOn('formulahendry.auto-close-tag')) return 'the Auto Close Tag extension';
  switch (languageId) {
    case 'html':
    case 'handlebars':
      return setting('html', 'autoClosingTags') !== false ? "VS Code's HTML support" : '';
    case 'javascript':
    case 'javascriptreact':
      return setting('javascript', 'autoClosingTags') !== false ? "VS Code's JavaScript support" : '';
    case 'typescriptreact':
      return setting('typescript', 'autoClosingTags') !== false ? "VS Code's TypeScript support" : '';
    case 'vue':
      return extOn('Vue.volar') ? 'the Vue extension' : '';
    case 'svelte':
      return extOn('svelte.svelte-vscode') ? 'the Svelte extension' : '';
    case 'astro':
      return extOn('astro-build.astro-vscode') ? 'the Astro extension' : '';
    case 'xml':
    case 'xsl':
    case 'svg':
      return extOn('redhat.vscode-xml') && setting('xml', 'completion.autoCloseTags') !== false ? 'the XML extension' : '';
    default:
      return '';
  }
}

function linkedEditingOn(doc) {
  return vscode.workspace.getConfiguration('editor', { uri: doc.uri, languageId: doc.languageId }).get('linkedEditing') === true;
}

// ---- auto close ----
function snippetText(s) {
  return s.replace(/[\\$}]/g, (m) => '\\' + m);
}

function onChange(e) {
  const doc = e.document;
  if (e.contentChanges.length === 0) return;
  // the first edit inside tag names that this extension linked counts as a use of rename
  if (lastLinked && lastLinked.uri === doc.uri.toString() && doc.version === lastLinked.version + 1) {
    const hit = e.contentChanges.some((c) => { const o = c.rangeOffset; return lastLinked.ranges.some(([a, b]) => o >= a && o <= b); });
    lastLinked = null;
    if (hit) countUse(doc);
  }
  if (e.reason || e.contentChanges.length !== 1) return; // undo, redo, multi-cursor
  const ch = e.contentChanges[0];
  if (ch.rangeLength !== 0 || (ch.text !== '>' && ch.text !== '/')) return;
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document !== doc) return;
  const pf = profileOf(doc);
  if (!pf) return;
  const c = cfg(doc);
  if (!c.close || isLarge(doc) || otherCloser(doc.languageId)) return;
  const offset = doc.offsetAt(ch.range.start) + 1;
  const version = doc.version;
  let ins = null;
  try {
    const res = analyzeDoc(doc, pf);
    ins = ch.text === '>' ? tags.closeAfterGt(res, offset) : tags.closeAfterSlash(res, offset, doc.getText());
  } catch {
    return;
  }
  if (!ins || doc.version !== version) return;
  const pos = doc.positionAt(offset);
  const snip = new vscode.SnippetString(ch.text === '>' ? '$0' + snippetText(ins) : snippetText(ins) + '$0');
  ed.insertSnippet(snip, pos, { undoStopBefore: false, undoStopAfter: false }).then((ok) => { if (ok) countUse(doc); }, () => {});
}

// ---- rename (linked editing) ----
let lastLinked = null;
const linkedProvider = {
  provideLinkedEditingRanges(doc, pos) {
    const pf = profileOf(doc);
    if (!pf || !cfg(doc).rename || isLarge(doc)) return undefined;
    let r;
    try { r = tags.linkedRanges(analyzeDoc(doc, pf), doc.offsetAt(pos)); } catch { return undefined; }
    if (!r) return undefined;
    lastLinked = { uri: doc.uri.toString(), version: doc.version, ranges: r };
    return new vscode.LinkedEditingRanges(r.map(([a, b]) => new vscode.Range(doc.positionAt(a), doc.positionAt(b))), WORD);
  },
};

// ---- highlight ----
let deco;
let hlTimer;
function makeDecoration() {
  return vscode.window.createTextEditorDecorationType({
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('editorBracketMatch.border'),
    backgroundColor: new vscode.ThemeColor('editorBracketMatch.background'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.bracketMatchForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
}

function highlight(ed) {
  if (!ed || !deco) return;
  const doc = ed.document;
  const pf = profileOf(doc);
  if (!pf || !cfg(doc).highlight || isLarge(doc) || !ed.selection.isEmpty) { ed.setDecorations(deco, []); return; }
  let ranges = [];
  try {
    const res = analyzeDoc(doc, pf);
    const k = tags.tagAt(res, doc.offsetAt(ed.selection.active));
    if (k >= 0 && res.partner[k] >= 0) {
      const a = res.toks[k];
      const b = res.toks[res.partner[k]];
      const r = (t) => new vscode.Range(doc.positionAt(t.s), doc.positionAt(t.t === tags.OPEN ? Math.max(t.ne, t.s + 1) : t.e));
      ranges = [r(a), r(b)];
    }
  } catch {
    ranges = [];
  }
  ed.setDecorations(deco, ranges);
}

function scheduleHighlight(ed) {
  clearTimeout(hlTimer);
  hlTimer = setTimeout(() => highlight(ed), 30);
}

// ---- commands ----
function activeTag() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return null;
  const pf = profileOf(ed.document);
  if (!pf) {
    vscode.window.setStatusBarMessage(`${NAME}: tags are not handled in ${ed.document.languageId} files`, 4000);
    return null;
  }
  return { ed, doc: ed.document, res: analyzeDoc(ed.document, pf) };
}

function goToMatchingTag() {
  const a = activeTag();
  if (!a) return;
  const { ed, doc, res } = a;
  const off = doc.offsetAt(ed.selection.active);
  const el = tags.elementAt(res, off);
  if (!el) { vscode.window.setStatusBarMessage(`${NAME}: no matching tag here`, 4000); return; }
  const target = el.onTag === el.open ? el.close : el.onTag === el.close ? el.open : el.open;
  const t = res.toks[target];
  const p = doc.positionAt(t.ns);
  ed.selection = new vscode.Selection(p, p);
  ed.revealRange(new vscode.Range(p, p), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  countUse(doc);
}

function selectTagContent() {
  const a = activeTag();
  if (!a) return;
  const { ed, doc, res } = a;
  const s0 = doc.offsetAt(ed.selection.start);
  const e0 = doc.offsetAt(ed.selection.end);
  const select = (x, y) => { ed.selection = new vscode.Selection(doc.positionAt(x), doc.positionAt(y)); countUse(doc); };
  // cursor on a tag: that element's content
  if (s0 === e0) {
    const k = tags.tagAt(res, s0);
    if (k >= 0 && res.partner[k] >= 0) {
      const o = res.toks[res.toks[k].t === tags.OPEN ? k : res.partner[k]];
      const c = res.toks[res.toks[k].t === tags.OPEN ? res.partner[k] : k];
      select(o.e, c.s);
      return;
    }
  }
  // content first, then the whole element; the next run moves to the parent
  const el = tags.elementAround(res, s0, e0);
  if (!el) { vscode.window.setStatusBarMessage(`${NAME}: no element around the cursor`, 4000); return; }
  const o = res.toks[el.open];
  const c = res.toks[el.close];
  if (s0 === o.e && e0 === c.s) select(o.s, c.e);
  else select(o.e, c.s);
}

async function renameTagPair() {
  const a = activeTag();
  if (!a) return;
  const { ed, doc, res } = a;
  const off = doc.offsetAt(ed.selection.active);
  let k = tags.tagAt(res, off);
  if (k < 0 || res.partner[k] < 0) {
    const el = tags.enclosingElement(res, off);
    k = el ? el.open : -1;
  }
  if (k < 0 || res.partner[k] < 0) { vscode.window.setStatusBarMessage(`${NAME}: put the cursor on a tag that has a matching tag`, 4000); return; }
  const t = res.toks[k];
  const p = res.toks[res.partner[k]];
  const version = doc.version;
  const name = await vscode.window.showInputBox({
    title: 'Rename tag pair',
    value: t.name,
    prompt: `Renames <${t.name}> and </${p.name}> in one step (one undo).`,
    validateInput: (v) => (tags.validName(v) ? null : 'Use letters, digits, _ - . and one namespace colon'),
  });
  if (!name || name === t.name) return;
  if (doc.version !== version) { vscode.window.setStatusBarMessage(`${NAME}: the file changed; run Rename Tag Pair again`, 4000); return; }
  const we = new vscode.WorkspaceEdit();
  we.replace(doc.uri, new vscode.Range(doc.positionAt(t.ns), doc.positionAt(t.ne)), name);
  we.replace(doc.uri, new vscode.Range(doc.positionAt(p.ns), doc.positionAt(p.ne)), name);
  if (await vscode.workspace.applyEdit(we)) countUse(doc);
}

async function toggleLanguage() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const lang = ed.document.languageId;
  const c = vscode.workspace.getConfiguration(SECTION);
  const list = [...(c.get('disabledLanguages', []) || [])];
  const off = list.includes(lang);
  const next = off ? list.filter((x) => x !== lang) : [...list, lang];
  await c.update('disabledLanguages', next, vscode.ConfigurationTarget.Global);
  vscode.window.setStatusBarMessage(`${NAME}: ${off ? 'on' : 'off'} for ${lang}`, 4000);
}

async function turnOnLinkedEditing() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const lang = ed.document.languageId;
  await vscode.workspace.getConfiguration('editor', { languageId: lang }).update('linkedEditing', true, vscode.ConfigurationTarget.Global, true);
  vscode.window.setStatusBarMessage(`${NAME}: rename as you type is on for ${lang}`, 4000);
  updateStatus();
}

async function openPractice() {
  const content = [
    '<!-- Practice file: nothing here is saved unless you save it. -->',
    '<template>',
    '  <section class="card">',
    '    <h2>Rename me</h2>',
    '    <p>Put the cursor in <code>section</code> above and type: the closing tag follows.<br>',
    '      Undo once and both tags are back.</p>',
    '    <ul>',
    '      <li>Type <kbd>&lt;div&gt;</kbd> on the next line to see the closing tag appear.</li>',
    '      ',
    '    </ul>',
    '  </section>',
    '</template>',
    '',
  ].join('\n');
  const doc = await vscode.workspace.openTextDocument({ language: tags.profileFor('vue') && languageKnown('vue') ? 'vue' : 'html', content });
  practice.add(doc.uri.toString());
  const ed = await vscode.window.showTextDocument(doc);
  const p = new vscode.Position(2, 6);
  ed.selection = new vscode.Selection(p, p);
}

let knownLanguages = new Set();
function languageKnown(id) {
  return knownLanguages.has(id);
}

// ---- status bar ----
let status;
function updateStatus() {
  if (!status) return;
  const ed = vscode.window.activeTextEditor;
  const doc = ed && ed.document;
  if (!doc || !handled(doc) || !cfg(doc).statusBar) { status.hide(); return; }
  // plain .js files: show the item only when the file has JSX in it
  if (doc.languageId === 'javascript' && !isLarge(doc)) {
    const pf = profileOf(doc);
    try { if (pf && analyzeDoc(doc, pf).toks.length === 0) { status.hide(); return; } } catch { status.hide(); return; }
  }
  const c = cfg(doc);
  const lang = doc.languageId;
  const lines = [`**${NAME}** in ${lang} files`, ''];
  let text = '$(symbol-tag) Tags';
  if (c.disabled.includes(lang)) {
    text = '$(symbol-tag) Tags off';
    lines.push(`Off for ${lang} (setting \`zovoTags.disabledLanguages\`). Click to turn it on again.`);
  } else if (isLarge(doc)) {
    text = '$(symbol-tag) Tags: large file';
    lines.push(`This file is over ${c.maxKB.toLocaleString('en-US')} KB or ${c.maxLines.toLocaleString('en-US')} lines, so rename, close and highlight as you type are off here and typing stays smooth.`,
      '', 'Go to Matching Tag, Select Tag Content and Rename Tag Pair still work.');
  } else {
    const rival = extOn('formulahendry.auto-rename-tag');
    const le = linkedEditingOn(doc);
    if (rival) text = '$(warning) Tags: 2 renamers';
    else if (c.rename && !le) text = '$(symbol-tag) Tags: rename off';
    const closer = otherCloser(lang);
    lines.push(`- Rename as you type: ${!c.rename ? 'off (setting)' : le ? 'on, one undo step' : 'off, because `editor.linkedEditing` is off for ' + lang + '. Click to turn it on'}`);
    lines.push(`- Close tags as you type: ${!c.close ? 'off (setting)' : closer ? 'done by ' + closer : 'on'}`);
    lines.push(`- Highlight the matching tag: ${c.highlight ? 'on' : 'off'}`);
    if (rival) lines.push('', 'The Auto Rename Tag extension by another publisher is on too. Two renamers can edit the same tag twice; turn one of them off.');
  }
  lines.push('');
  if (showSupport()) lines.push(footerMarkdown(SECTION));
  const md = new vscode.MarkdownString(lines.join('\n'), true);
  md.isTrusted = true;
  status.text = text;
  status.tooltip = md;
  status.show();
}

let showSupport = () => true;

async function menu() {
  const ed = vscode.window.activeTextEditor;
  const doc = ed && ed.document;
  const items = [];
  if (doc && handled(doc)) {
    const c = cfg(doc);
    const lang = doc.languageId;
    if (c.rename && !linkedEditingOn(doc) && !c.disabled.includes(lang)) items.push({ label: `$(check) Turn on rename as you type for ${lang}`, run: turnOnLinkedEditing });
    items.push({ label: c.disabled.includes(lang) ? `$(check) Turn on for ${lang}` : `$(circle-slash) Turn off for ${lang}`, run: toggleLanguage });
    items.push({ label: '$(arrow-swap) Go to Matching Tag', run: goToMatchingTag });
    items.push({ label: '$(selection) Select Tag Content', run: selectTagContent });
    items.push({ label: '$(edit) Rename Tag Pair…', run: renameTagPair });
  }
  items.push({ label: '$(gear) Settings', run: () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXT_ID}`) });
  items.push({ label: '$(book) Get Started', run: openWalkthrough });
  if (showSupport()) {
    items.push({ label: '$(extensions) More free tools by Zovo', run: () => vscode.commands.executeCommand(`${SECTION}.moreViewers`) });
    items.push({ label: '$(heart) Sponsor', run: () => vscode.commands.executeCommand(`${SECTION}.supportDeveloper`) });
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: NAME });
  if (pick) await pick.run();
}

function openWalkthrough() {
  return vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#zovoTags.start`, false);
}

// ---- activation ----
let registered = [];
function registerProviders(context) {
  for (const d of registered) d.dispose();
  const extra = vscode.workspace.getConfiguration(SECTION).get('additionalHtmlLanguages', []) || [];
  const langs = [...new Set([...tags.LANGUAGES, ...extra])];
  const selector = langs.map((language) => ({ language }));
  registered = [vscode.languages.registerLinkedEditingRangeProvider(selector, linkedProvider)];
  vscode.commands.executeCommand('setContext', 'zovoTags.languages', langs).then(undefined, () => {});
  context.subscriptions.push(...registered);
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: SECTION, name: NAME });
  const sup = registerSupport({ vscode, context, prefix: SECTION, selfId: EXT_ID });
  showSupport = sup.showLinks;
  vscode.languages.getLanguages().then((l) => { knownLanguages = new Set(l); }, () => {});
  deco = makeDecoration();
  status = vscode.window.createStatusBarItem('zovoTags.status', vscode.StatusBarAlignment.Right, 100);
  status.name = NAME;
  status.command = `${SECTION}.menu`;
  registerProviders(context);
  context.subscriptions.push(
    deco,
    status,
    vscode.workspace.onDidChangeTextDocument(onChange),
    vscode.workspace.onDidCloseTextDocument((d) => cache.delete(d.uri.toString())),
    vscode.window.onDidChangeTextEditorSelection((e) => scheduleHighlight(e.textEditor)),
    vscode.window.onDidChangeActiveTextEditor((ed) => { updateStatus(); scheduleHighlight(ed); }),
    vscode.workspace.onDidOpenTextDocument(() => updateStatus()),
    vscode.extensions.onDidChange(() => updateStatus()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SECTION}.additionalHtmlLanguages`)) registerProviders(context);
      if (e.affectsConfiguration(SECTION) || e.affectsConfiguration('editor.linkedEditing') || e.affectsConfiguration('html') || e.affectsConfiguration('javascript') || e.affectsConfiguration('typescript')) {
        cache.clear();
        updateStatus();
        scheduleHighlight(vscode.window.activeTextEditor);
      }
    }),
    vscode.commands.registerCommand(`${SECTION}.goToMatchingTag`, goToMatchingTag),
    vscode.commands.registerCommand(`${SECTION}.selectTagContent`, selectTagContent),
    vscode.commands.registerCommand(`${SECTION}.renameTagPair`, renameTagPair),
    vscode.commands.registerCommand(`${SECTION}.toggleLanguage`, toggleLanguage),
    vscode.commands.registerCommand(`${SECTION}.turnOnLinkedEditing`, turnOnLinkedEditing),
    vscode.commands.registerCommand(`${SECTION}.menu`, menu),
    vscode.commands.registerCommand(`${SECTION}.openPractice`, openPractice),
    vscode.commands.registerCommand(`${SECTION}.openWalkthrough`, openWalkthrough),
  );
  updateStatus();
  scheduleHighlight(vscode.window.activeTextEditor);
}

function deactivate() {
  clearTimeout(hlTimer);
}

module.exports = { activate, deactivate, otherCloser, snippetText };
