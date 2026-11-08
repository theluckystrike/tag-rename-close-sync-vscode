'use strict';
// Finds tags in HTML-like, XML and JSX text and pairs each open tag with its closing tag.
// Pure JavaScript with no VS Code import, so the unit tests run in plain Node.
//
// Three scanners share one token shape:
//   { t: OPEN | CLOSE, name, s, ns, ne, e, closed, self, parent }
//   s = offset of "<", ns..ne = the tag name, e = offset after ">" (or where the unfinished tag stops),
//   closed = the tag has its ">", self = it ends with "/>", parent = index of the enclosing open tag or -1.
// Text that can never hold a real tag is skipped: comments, CDATA, <?php ?>, <% %>, {{ }}, {% %}, {# #},
// script and style bodies, Svelte/Astro {expressions}, Markdown code, and in JSX: strings, template
// literals, regex literals, comments and every "<" that is a comparison or a TypeScript generic.

const OPEN = 1;
const CLOSE = 2;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
// Words after which "<" starts a JSX element rather than a comparison.
const EXPR_KW = new Set(['return', 'yield', 'await', 'case', 'default', 'else', 'do', 'in', 'of', 'typeof', 'void', 'delete', 'throw', 'instanceof']);

// mode: html (HTML and templates), xml, jsx, md (Markdown with inline HTML).
function profile(mode, extra) {
  const htmlish = mode === 'html' || mode === 'md';
  return Object.assign({
    mode,
    voids: htmlish, // never pair br, img, input...
    raw: htmlish, // script/style/textarea/title bodies are text
    ci: mode === 'html' || mode === 'md', // tag names compare without case
    mustache: false, // {{ }}
    twig: false, // {% %} and {# #}
    braces: false, // { } expressions (Svelte, Astro, MDX)
    php: false, // <?php without ?> runs to the end
    erb: false, // <% %>
    blade: false, // {!! !!}, {{-- --}}, @php @endphp
    frontmatter: false, // --- block at the top (Astro, MDX)
    ts: false, // TypeScript generics are possible (tsx)
  }, extra || {});
}

const PROFILES = {
  html: profile('html', { mustache: true }),
  vue: profile('html', { mustache: true, ci: false }),
  svelte: profile('html', { braces: true, ci: false }),
  astro: profile('html', { braces: true, ci: false, frontmatter: true }),
  php: profile('html', { php: true }),
  blade: profile('html', { mustache: true, php: true, blade: true }),
  twig: profile('html', { mustache: true, twig: true }),
  jinja: profile('html', { mustache: true, twig: true }),
  'jinja-html': profile('html', { mustache: true, twig: true }),
  'django-html': profile('html', { mustache: true, twig: true }),
  nunjucks: profile('html', { mustache: true, twig: true }),
  liquid: profile('html', { mustache: true, twig: true }),
  handlebars: profile('html', { mustache: true }),
  erb: profile('html', { erb: true }),
  ejs: profile('html', { erb: true }),
  markdown: profile('md'),
  mdx: profile('md', { braces: true, frontmatter: true, ci: false }),
  xml: profile('xml'),
  xsl: profile('xml'),
  svg: profile('xml'),
  xaml: profile('xml'),
  javascriptreact: profile('jsx'),
  javascript: profile('jsx'),
  typescriptreact: profile('jsx', { ts: true }),
};

/** The profile for a VS Code language id, or null when tags are not handled there (typescript has generics, not tags). */
function profileFor(languageId, extraHtml) {
  if (Object.prototype.hasOwnProperty.call(PROFILES, languageId)) return PROFILES[languageId];
  if (extraHtml && extraHtml.includes(languageId)) return PROFILES.html;
  return null;
}

const LANGUAGES = Object.keys(PROFILES);

// ---- character helpers ----
const isWs = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
const isAlpha = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isDigit = (c) => c >= 48 && c <= 57;
const isNameStart = (c) => isAlpha(c) || c === 95 || c > 127;
const isNameChar = (c) => isAlpha(c) || isDigit(c) || c === 95 || c === 45 || c === 46 || c === 58 || c > 127;
const isIdStart = (c) => isAlpha(c) || c === 95 || c === 36 || c > 127;
const isIdChar = (c) => isIdStart(c) || isDigit(c);
const isJsxNameChar = (c) => isIdChar(c) || c === 45 || c === 46 || c === 58;

/** A tag name we are willing to write: letters, digits, _ - . and one namespace colon, not ending in ":". */
const NAME_RE = /^[A-Za-z_\u0080-￿$][\w\-.\u0080-￿$]*(?::[A-Za-z_\u0080-￿][\w\-.\u0080-￿]*)?$/;
function validName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 200 && NAME_RE.test(name);
}

function readName(text, i) {
  const n = text.length;
  while (i < n && isNameChar(text.charCodeAt(i))) i++;
  return i;
}

function readJsxName(text, i) {
  const n = text.length;
  while (i < n && isJsxNameChar(text.charCodeAt(i))) i++;
  return i;
}

function lineEnd(text, i) {
  const j = text.indexOf('\n', i);
  return j < 0 ? text.length : j;
}

function after(text, i, s) {
  const j = text.indexOf(s, i);
  return j < 0 ? text.length : j + s.length;
}

// Skips {...} with nesting and quoted strings inside. i is at "{". Returns the offset after the matching "}".
function skipBraces(text, i) {
  const n = text.length;
  let depth = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 123) depth++;
    else if (c === 125) { depth--; if (depth === 0) return i + 1; }
    else if (c === 34 || c === 39 || c === 96) {
      const q = c;
      i++;
      while (i < n && text.charCodeAt(i) !== q) { if (text.charCodeAt(i) === 92) i++; i++; }
    }
    i++;
  }
  return n;
}

// <!DOCTYPE ...> with an optional [internal subset].
function skipDecl(text, i) {
  const n = text.length;
  let depth = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 91) depth++;
    else if (c === 93) depth--;
    else if (c === 62 && depth <= 0) return i + 1;
    else if (c === 34 || c === 39) { const j = text.indexOf(text[i], i + 1); if (j < 0) return n; i = j; }
    i++;
  }
  return n;
}

// Template blocks that start with "{": returns the offset after the block, or -1 when none starts at i.
function skipCurly(text, i, pf) {
  const c1 = text.charCodeAt(i + 1);
  if (pf.blade && c1 === 33 && text.startsWith('{!!', i)) return after(text, i + 3, '!!}');
  if (pf.mustache && c1 === 123) {
    if (text.startsWith('{{--', i)) return after(text, i + 4, '--}}');
    if (text.startsWith('{{!--', i)) return after(text, i + 5, '--}}');
    return after(text, i + 2, '}}');
  }
  if (pf.twig && c1 === 37) return after(text, i + 2, '%}');
  if (pf.twig && c1 === 35) return after(text, i + 2, '#}');
  if (pf.braces) return skipBraces(text, i);
  return -1;
}

// ---- HTML, XML and Markdown ----
function scanMarkup(text, pf) {
  const toks = [];
  const n = text.length;
  const md = pf.mode === 'md';
  let i = 0;
  if (pf.frontmatter && text.startsWith('---')) {
    const m = /\n---[ \t]*(\r?\n|$)/.exec(text.slice(3));
    i = m ? 3 + m.index + m[0].length : 0;
  }
  let lineStart = true;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 10) { lineStart = true; i++; continue; }
    if (md) {
      if (c === 96 || c === 126) {
        let j = i;
        while (j < n && text.charCodeAt(j) === c) j++;
        const run = j - i;
        if (run >= 3 && lineStart) {
          // fenced code: skip to a closing fence of the same character, at least as long
          const fence = text[i].repeat(run);
          let k = lineEnd(text, j);
          let end = n;
          while (k < n) {
            let p = k + 1;
            while (p < n && text.charCodeAt(p) === 32 && p - k <= 4) p++;
            if (text.startsWith(fence, p)) { end = lineEnd(text, p); break; }
            k = lineEnd(text, p);
          }
          i = end;
          continue;
        }
        if (c === 96) {
          // inline code span: the next backtick run of the same length
          const fence = '`'.repeat(run);
          let k = j;
          let end = -1;
          while (k < n) {
            const q = text.indexOf(fence, k);
            if (q < 0) break;
            let r = q + run;
            if (text.charCodeAt(r) === 96 || text.charCodeAt(q - 1) === 96) { while (r < n && text.charCodeAt(r) === 96) r++; k = r; continue; }
            end = r;
            break;
          }
          i = end < 0 ? j : end;
          lineStart = false;
          continue;
        }
      }
      if (lineStart && (c === 32 || c === 9)) { i++; continue; }
    }
    lineStart = false;
    if (c === 123) {
      const j = skipCurly(text, i, pf);
      if (j > 0) { i = j; continue; }
      i++;
      continue;
    }
    if (c === 64 && pf.blade && text.startsWith('@php', i) && isWs(text.charCodeAt(i + 4))) {
      i = after(text, i + 4, '@endphp');
      continue;
    }
    if (c !== 60) { i++; continue; }
    const c1 = text.charCodeAt(i + 1);
    if (c1 === 33) { // <!
      if (text.startsWith('<!--', i)) { i = after(text, i + 4, '-->'); continue; }
      if (text.startsWith('<![CDATA[', i)) { i = after(text, i + 9, ']]>'); continue; }
      i = skipDecl(text, i + 2);
      continue;
    }
    if (c1 === 63) { // <? ... ?>
      const j = text.indexOf('?>', i + 2);
      i = j < 0 ? (pf.php ? n : i + 2) : j + 2;
      continue;
    }
    if (c1 === 37 && pf.erb) { i = after(text, i + 2, '%>'); continue; }
    if (c1 === 47) { // </name>
      const ns = i + 2;
      const ne = isNameStart(text.charCodeAt(ns)) ? readName(text, ns) : ns;
      let j = ne;
      while (j < n && text.charCodeAt(j) !== 62 && text.charCodeAt(j) !== 60) j++;
      const closed = j < n && text.charCodeAt(j) === 62;
      toks.push({ t: CLOSE, name: text.slice(ns, ne), s: i, ns, ne, e: closed ? j + 1 : ne, closed, self: false, parent: -1 });
      i = closed ? j + 1 : Math.max(ne, i + 2);
      continue;
    }
    if (!isNameStart(c1)) { i++; continue; }
    const ns = i + 1;
    const ne = readName(text, ns);
    const a = text.charCodeAt(ne);
    // "<foo@bar.com>" or "<a+b": not a tag
    if (!(ne >= n || isWs(a) || a === 62 || a === 47 || a === 60 || (a === 123 && (pf.braces || pf.mustache)))) { i = ne; continue; }
    let j = ne;
    let closed = false;
    let self = false;
    while (j < n) {
      const d = text.charCodeAt(j);
      if (d === 62) { closed = true; j++; break; }
      if (d === 47 && text.charCodeAt(j + 1) === 62) { closed = true; self = true; j += 2; break; }
      if (d === 34 || d === 39) {
        const k = text.indexOf(text[j], j + 1);
        if (k < 0) break; // unclosed quote: the tag is unfinished
        j = k + 1;
        continue;
      }
      if (d === 60) {
        const d1 = text.charCodeAt(j + 1);
        if (d1 === 63) { const k = text.indexOf('?>', j + 2); if (k < 0) break; j = k + 2; continue; }
        if (d1 === 37 && pf.erb) { const k = text.indexOf('%>', j + 2); if (k < 0) break; j = k + 2; continue; }
        break; // a new tag starts: this one has no ">"
      }
      if (d === 123) {
        const k = skipCurly(text, j, pf);
        if (k > 0) { j = k; continue; }
      }
      j++;
    }
    const name = text.slice(ns, ne);
    toks.push({ t: OPEN, name, s: i, ns, ne, e: closed ? j : ne, closed, self, parent: -1 });
    if (!closed) { i = ne; continue; }
    i = j;
    if (!self && pf.raw) {
      const low = name.toLowerCase();
      if (RAW.has(low)) {
        const re = new RegExp('</' + low + '(?=[\\s/>]|$)', 'ig');
        re.lastIndex = j;
        const m = re.exec(text);
        i = m ? m.index : n;
      }
    }
  }
  return toks;
}

// Pairs close tags with the nearest open tag of the same name; tags in between stay unpaired (HTML's optional
// end tags, or text being typed). Void and self-closing tags never pair.
function pairByName(toks, pf) {
  const partner = new Int32Array(toks.length).fill(-1);
  const stack = [];
  const key = pf.ci ? (s) => s.toLowerCase() : (s) => s;
  const keys = new Array(toks.length);
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t === OPEN) {
      t.parent = stack.length ? stack[stack.length - 1] : -1;
      if (t.self || !t.closed || !t.name) continue;
      if (pf.voids && VOID.has(t.name.toLowerCase())) continue;
      keys[k] = key(t.name);
      stack.push(k);
    } else if (t.name) {
      const nm = key(t.name);
      const stop = Math.max(0, stack.length - 2000);
      for (let d = stack.length - 1; d >= stop; d--) {
        if (keys[stack[d]] === nm) {
          partner[stack[d]] = k;
          partner[k] = stack[d];
          stack.length = d;
          break;
        }
      }
    }
  }
  return partner;
}

// ---- JSX (javascript, javascriptreact, typescriptreact) ----
const F_ROOT = 0;
const F_BRACE = 1;
const F_TEXPR = 2;
const F_AEXPR = 3;
const F_CEXPR = 4;
const F_TPL = 5;
const F_TAG = 6;
const F_KIDS = 7;

function skipString(text, i) {
  const q = text.charCodeAt(i);
  const n = text.length;
  let j = i + 1;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === q) return j + 1;
    if (c === 10) return j; // unterminated: stop at the line end
    j++;
  }
  return n;
}

// A regex literal starting at i ("/"). Returns the offset after its flags, or -1 when this is no regex.
function skipRegex(text, i) {
  const n = text.length;
  let j = i + 1;
  let cls = false;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 10 || c === 13) return -1;
    if (c === 92) { j += 2; continue; }
    if (c === 91) cls = true;
    else if (c === 93) cls = false;
    else if (c === 47 && !cls) {
      j++;
      while (j < n && isIdChar(text.charCodeAt(j))) j++;
      return j;
    }
    j++;
  }
  return -1;
}

// Is the "<" at i the start of a JSX element? Called only where an expression may start.
function jsxStartsAt(text, i, pf) {
  const c1 = text.charCodeAt(i + 1);
  if (c1 === 62) return true; // <> fragment
  if (!isIdStart(c1)) return false;
  const ne = readJsxName(text, i + 1);
  const a = text.charCodeAt(ne);
  if (a === 44) return false; // <T,>() => generic arrow
  if (!(ne >= text.length || isWs(a) || a === 62 || a === 47 || a === 123)) return false;
  if (pf.ts) {
    if (/^\s+extends\s/.test(text.slice(ne, ne + 12))) return false; // <T extends X>(...)
    const name = text.slice(i + 1, ne);
    if (/^[A-Z][A-Za-z0-9]?$/.test(name) && a === 62 && /^\s*\(/.test(text.slice(ne + 1, ne + 40))) return false; // type F = <T>(x: T) => T
  }
  return true;
}

function scanJsx(text, pf) {
  const toks = [];
  const partner = [];
  const n = text.length;
  const st = [{ k: F_ROOT }];
  let prev = 0; // 0: an expression may start here; 1: a value just ended
  let i = 0;

  const enclosing = () => {
    for (let d = st.length - 1; d >= 0; d--) if (st[d].k === F_KIDS) return st[d].tok;
    return -1;
  };
  const isJs = (k) => k === F_ROOT || k === F_BRACE || k === F_TEXPR || k === F_AEXPR || k === F_CEXPR;
  const afterElement = () => { if (isJs(st[st.length - 1].k)) prev = 1; };
  const startTag = (i0) => {
    const parent = enclosing();
    if (text.charCodeAt(i0 + 1) === 62) {
      const k = toks.push({ t: OPEN, name: '', s: i0, ns: i0 + 1, ne: i0 + 1, e: i0 + 2, closed: true, self: false, parent }) - 1;
      partner.push(-1);
      st.push({ k: F_KIDS, tok: k });
      i = i0 + 2;
      return;
    }
    const ne = readJsxName(text, i0 + 1);
    const k = toks.push({ t: OPEN, name: text.slice(i0 + 1, ne), s: i0, ns: i0 + 1, ne, e: ne, closed: false, self: false, parent }) - 1;
    partner.push(-1);
    st.push({ k: F_TAG, tok: k });
    i = ne;
  };
  const abortTag = () => { st.pop(); prev = 1; };

  while (i < n) {
    const top = st[st.length - 1];
    const c = text.charCodeAt(i);
    if (top.k === F_TPL) {
      if (c === 92) { i += 2; continue; }
      if (c === 96) { st.pop(); i++; prev = 1; continue; }
      if (c === 36 && text.charCodeAt(i + 1) === 123) { st.push({ k: F_TEXPR }); i += 2; prev = 0; continue; }
      i++;
      continue;
    }
    if (top.k === F_TAG) {
      if (isWs(c)) { i++; continue; }
      const t = toks[top.tok];
      if (c === 62) {
        t.e = i + 1;
        t.closed = true;
        st.pop();
        st.push({ k: F_KIDS, tok: top.tok });
        i++;
        continue;
      }
      if (c === 47) {
        const c1 = text.charCodeAt(i + 1);
        if (c1 === 47) { i = lineEnd(text, i); continue; }
        if (c1 === 42) { i = after(text, i + 2, '*/'); continue; }
        let j = i + 1;
        while (j < n && isWs(text.charCodeAt(j))) j++;
        if (text.charCodeAt(j) === 62) {
          t.e = j + 1;
          t.closed = true;
          t.self = true;
          st.pop();
          i = j + 1;
          afterElement();
          continue;
        }
        i++;
        continue;
      }
      if (c === 123) { st.push({ k: F_AEXPR }); i++; prev = 0; continue; }
      if (c === 34 || c === 39) {
        const k = text.indexOf(text[i], i + 1);
        if (k < 0) { t.e = i; abortTag(); i++; continue; }
        i = k + 1;
        continue;
      }
      if (c === 60) { t.e = i; abortTag(); continue; }
      i++;
      continue;
    }
    if (top.k === F_KIDS) {
      if (c === 123) { st.push({ k: F_CEXPR }); i++; prev = 0; continue; }
      if (c !== 60) { i++; continue; }
      const c1 = text.charCodeAt(i + 1);
      if (c1 === 47) {
        const ns = i + 2;
        const ne = isIdStart(text.charCodeAt(ns)) ? readJsxName(text, ns) : ns;
        let j = ne;
        while (j < n && isWs(text.charCodeAt(j))) j++;
        const closed = text.charCodeAt(j) === 62;
        const k = toks.push({ t: CLOSE, name: text.slice(ns, ne), s: i, ns, ne, e: closed ? j + 1 : ne, closed, self: false, parent: -1 }) - 1;
        partner.push(top.tok);
        partner[top.tok] = k;
        st.pop();
        i = closed ? j + 1 : Math.max(ne, i + 2);
        afterElement();
        continue;
      }
      if (c1 === 62 || isIdStart(c1)) { startTag(i); continue; }
      i++;
      continue;
    }
    // JavaScript code
    if (isWs(c)) { i++; continue; }
    if (c === 47) {
      const c1 = text.charCodeAt(i + 1);
      if (c1 === 47) { i = lineEnd(text, i); continue; }
      if (c1 === 42) { i = after(text, i + 2, '*/'); continue; }
      if (prev === 0) {
        const j = skipRegex(text, i);
        if (j > 0) { i = j; prev = 1; continue; }
      }
      i++;
      prev = 0;
      continue;
    }
    if (c === 34 || c === 39) { i = skipString(text, i); prev = 1; continue; }
    if (c === 96) { st.push({ k: F_TPL }); i++; continue; }
    if (c === 123) { st.push({ k: F_BRACE }); i++; prev = 0; continue; }
    if (c === 125) {
      if (st.length > 1) {
        const f = st.pop();
        if (f.k === F_BRACE) prev = 1;
      }
      i++;
      continue;
    }
    if (c === 60) {
      if (prev === 0 && jsxStartsAt(text, i, pf)) { startTag(i); continue; }
      i++;
      prev = 0;
      continue;
    }
    if (isIdChar(c)) {
      let j = i + 1;
      while (j < n && isIdChar(text.charCodeAt(j))) j++;
      prev = EXPR_KW.has(text.slice(i, j)) ? 0 : 1;
      i = j;
      continue;
    }
    if (c === 41 || c === 93) { prev = 1; i++; continue; }
    if (c === 35 || c === 64) { i++; continue; } // #private, @decorator
    prev = 0;
    i++;
  }
  // unfinished tag at the end of the text
  return { toks, partner: Int32Array.from(partner) };
}

// ---- public API ----

/** Scans text with the profile and pairs the tags. Returns { toks, partner, pf }. */
function analyze(text, pf) {
  if (pf.mode === 'jsx') {
    const r = scanJsx(text, pf);
    return { toks: r.toks, partner: r.partner, pf };
  }
  const toks = scanMarkup(text, pf);
  return { toks, partner: pairByName(toks, pf), pf };
}

/** Index of the last token with s <= offset, or -1. */
function lastStartingAt(toks, offset) {
  let lo = 0;
  let hi = toks.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (toks[mid].s <= offset) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

function sameName(a, b, pf) {
  return pf.ci ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The token whose name holds the offset (start and end included), or -1. */
function nameAt(res, offset) {
  const k = lastStartingAt(res.toks, offset);
  if (k < 0) return -1;
  const t = res.toks[k];
  return offset >= t.ns && offset <= t.ne && t.ne > t.ns ? k : -1;
}

/** The token that holds the offset: s <= offset < e first, then a tag that ends exactly at offset. -1 if none. */
function tagAt(res, offset) {
  const k = lastStartingAt(res.toks, offset);
  if (k < 0) return -1;
  const t = res.toks[k];
  if (offset < t.e || (offset <= t.ne)) return k;
  if (offset === t.e) return k;
  return -1;
}

/**
 * Ranges to edit together when the cursor is in a tag name: [[ns, ne], [ns, ne]], open tag first.
 * null when the tag has no partner or the two names differ (then renaming one would be a guess).
 */
function linkedRanges(res, offset) {
  const k = nameAt(res, offset);
  if (k < 0) return null;
  const p = res.partner[k];
  if (p < 0) return null;
  const a = res.toks[k];
  const b = res.toks[p];
  if (!a.name || !sameName(a.name, b.name, res.pf)) return null;
  const pair = [[a.ns, a.ne], [b.ns, b.ne]];
  return a.t === OPEN ? pair : pair.reverse();
}

function isVoid(name, pf) {
  return pf.voids && VOID.has(name.toLowerCase());
}

// The open tag k still needs a closing tag: no partner, a partner with another name, or (as in TypeScript) its
// partner really belongs to a same-named parent that has no closing tag of its own.
function needsClose(res, k) {
  const { toks, partner, pf } = res;
  let cur = k;
  for (let guard = 0; guard < 10000 && cur >= 0; guard++) {
    const p = partner[cur];
    if (p < 0 || !sameName(toks[p].name, toks[cur].name, pf)) return true;
    const par = toks[cur].parent;
    if (par < 0 || !sameName(toks[par].name, toks[cur].name, pf)) return false;
    cur = par;
  }
  return false;
}

/**
 * Text to insert after the cursor when ">" was just typed and the cursor is at offset (right after ">").
 * Returns "</name>" or null.
 */
function closeAfterGt(res, offset) {
  const k = lastStartingAt(res.toks, offset - 1);
  if (k < 0) return null;
  const t = res.toks[k];
  if (t.t !== OPEN || !t.closed || t.self || t.e !== offset) return null;
  if (!validName(t.name) || isVoid(t.name, res.pf)) return null;
  if (!needsClose(res, k)) return null;
  return '</' + t.name + '>';
}

/** Text to insert when "</" was just typed and the cursor is at offset (right after "/"). Returns "name>" or null. */
function closeAfterSlash(res, offset, text) {
  const k = lastStartingAt(res.toks, offset - 2);
  if (k < 0) return null;
  const t = res.toks[k];
  if (t.t !== CLOSE || t.s !== offset - 2 || t.name !== '') return null;
  if (text && offset < text.length && isNameChar(text.charCodeAt(offset))) return null;
  let open = -1;
  if (res.pf.mode === 'jsx') {
    open = res.partner[k];
  } else {
    // the innermost element still open before this point
    const stack = [];
    const key = res.pf.ci ? (s) => s.toLowerCase() : (s) => s;
    for (let q = 0; q < k; q++) {
      const u = res.toks[q];
      if (u.t === OPEN) {
        if (u.self || !u.closed || !u.name || isVoid(u.name, res.pf)) continue;
        stack.push(q);
      } else if (u.name) {
        const nm = key(u.name);
        for (let d = stack.length - 1; d >= Math.max(0, stack.length - 2000); d--) {
          if (key(res.toks[stack[d]].name) === nm) { stack.length = d; break; }
        }
      }
    }
    open = stack.length ? stack[stack.length - 1] : -1;
  }
  if (open < 0) return null;
  const name = res.toks[open].name;
  if (!validName(name)) return null;
  return name + '>';
}

/** The element whose tags hold the offset, or the innermost element around it: { open, close } token indexes or null. */
function elementAt(res, offset) {
  const { toks, partner } = res;
  const k = tagAt(res, offset);
  if (k >= 0 && partner[k] >= 0) {
    const p = partner[k];
    return toks[k].t === OPEN ? { open: k, close: p, onTag: k } : { open: p, close: k, onTag: k };
  }
  return enclosingElement(res, offset);
}

/** The innermost paired element with open.e <= offset <= close.s, or null. */
function enclosingElement(res, offset) {
  return elementAround(res, offset, offset);
}

/** The innermost paired element whose content holds start..end (open.e <= start, end <= close.s), or null. */
function elementAround(res, start, end) {
  const { toks, partner } = res;
  for (let q = lastStartingAt(toks, start); q >= 0; q--) {
    const t = toks[q];
    if (t.t !== OPEN) continue;
    const p = partner[q];
    if (p < 0) continue;
    if (t.e <= start && toks[p].s >= end) return { open: q, close: p, onTag: -1 };
  }
  return null;
}

module.exports = {
  OPEN, CLOSE, VOID, RAW, PROFILES, LANGUAGES,
  profile, profileFor, validName, analyze, scanMarkup, scanJsx, pairByName,
  nameAt, tagAt, linkedRanges, closeAfterGt, closeAfterSlash, needsClose, elementAt, enclosingElement, elementAround,
};
