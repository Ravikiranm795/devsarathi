'use strict';

// Framework-aware "facts": couplings the name-based call graph cannot see.
//
// The call graph links `a()` to `b()` when the text `b(` appears in a's body.
// Angular DI (a constructor parameter type), Spring wiring (@Autowired), a
// template using <app-user-card>, a route table pointing at a component -
// none of those contain a call, so a blast-radius walk reports "nothing
// depends on this" for exactly the classes most worth a warning (spec
// MASTER 7.5 accuracy limits / 7.6 mandatory impact analysis). Each fact is
// one such coupling, recorded per file by regex/text scan - no tree-sitter,
// no new native dependency - and stored in framework_facts (graphStore.js).
//
// Fact shape: { symbolName, framework, role, detail, line }
//   symbolName  enclosing class/function/method, or null for file-level
//   detail      a plain string (type or tag name) or a JSON object string
//
// Everything here is heuristic and deliberately forgiving: a missed fact is a
// gap in the coupling list (the dynamic-hint facts exist to flag that gap),
// a thrown exception would abort the whole build. So extractFrameworkFacts
// never throws and returns whatever it collected before any failure.

const path = require('path');

// A single generated/minified bundle must not stall a build. The call graph
// is cheap per file; these scans are several regex passes plus bracket
// matching, so the cap is lower than the walker's own file-size limit.
const MAX_SOURCE_CHARS = 400 * 1024;

// A pathological file (huge route table, generated code) would otherwise
// bloat the table with rows nobody can read.
const MAX_FACTS = 1000;

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

/**
 * Index just past the string literal that opens at src[i]. ' and " strings
 * end at the line break if unterminated, so one stray apostrophe (a regex
 * literal, JSX prose) can only damage the line it is on; template literals
 * may legitimately span lines.
 */
function skipString(src, i) {
  const q = src[i];
  const stopAtEol = q !== '`';
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === q) return j + 1;
    if (stopAtEol && c === '\n') return j;
  }
  return src.length;
}

/**
 * Same-length copy of `src` with comments blanked to spaces (newlines kept),
 * so every offset - and therefore every line number - still lines up with the
 * original. Without this a commented-out `@Autowired` or `eval(` would be
 * reported as live coupling. Strings are skipped as units so `'http://x'` is
 * not mistaken for a `//` comment. For Python, triple-quoted strings are
 * blanked as well: docstrings routinely hold example decorators.
 */
function blankComments(src, style) {
  const n = src.length;
  const out = src.split('');
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  const eol = (i) => { const e = src.indexOf('\n', i); return e < 0 ? n : e; };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (style === 'html') {
      if (c === '<' && src.startsWith('<!--', i)) {
        const e = src.indexOf('-->', i + 4);
        const end = e < 0 ? n : e + 3;
        blank(i, end);
        i = end;
      } else i++;
      continue;
    }
    if (style === 'py') {
      if (c === '#') { const e = eol(i); blank(i, e); i = e; continue; }
      if (c === '"' || c === "'") {
        if (src.startsWith(c + c + c, i)) {
          const e = src.indexOf(c + c + c, i + 3);
          const end = e < 0 ? n : e + 3;
          blank(i + 3, end - 3 > i + 3 ? end - 3 : i + 3);
          i = end;
        } else i = skipString(src, i);
        continue;
      }
      i++;
      continue;
    }
    // c-like (js/ts/java) and php
    const d = src[i + 1];
    if (c === '/' && d === '/') { const e = eol(i); blank(i, e); i = e; continue; }
    if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      blank(i, end);
      i = end;
      continue;
    }
    // PHP 8 attributes start with '#[' and are code, not comments.
    if (style === 'php' && c === '#' && d !== '[') { const e = eol(i); blank(i, e); i = e; continue; }
    if (c === '"' || c === "'" || (c === '`' && style !== 'php')) { i = skipString(src, i); continue; }
    i++;
  }
  return out.join('');
}

/**
 * Index of the bracket that closes the one at src[openIdx], or -1. String
 * aware so a `)` inside `"..."` does not end an annotation early.
 */
function matchBalanced(src, openIdx, open, close, maxScan = 200000) {
  let depth = 0;
  const limit = Math.min(src.length, openIdx + maxScan);
  for (let i = openIdx; i < limit; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i) - 1; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Copy of an object/argument text with everything nested deeper than the
 * outermost bracket blanked. `{ path: 'a', children: [{ component: B }] }`
 * must not credit B to the parent route, and `template` must not be read out
 * of a nested object. Length is preserved so indices map back.
 */
function topLevel(text) {
  const out = text.split('');
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const end = skipString(text, i);
      if (depth > 1) blank(i, end);
      i = end - 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
      if (depth >= 2) blank(i, i + 1);
    } else if (c === ')' || c === ']' || c === '}') {
      if (depth >= 2) blank(i, i + 1);
      if (depth > 0) depth--;
    } else if (depth >= 2) blank(i, i + 1);
  }
  return out.join('');
}

/** Splits a parameter list on commas that are not inside (), [], {} or <> (an `=>` is not a bracket). */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(text, i) - 1; continue; }
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '>' && text[i - 1] !== '=') depth--;
    else if (c === ',' && depth <= 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function skipWs(code, i) {
  while (i < code.length && /\s/.test(code[i])) i++;
  return i;
}

/** Index just past any run of annotations/decorators ('@Foo(..)') or PHP attributes ('#[..]') starting at i. */
function skipAnnotations(code, i, marker) {
  for (;;) {
    i = skipWs(code, i);
    if (!code.startsWith(marker, i) || code.startsWith('@interface', i)) return i;
    if (marker === '#[') {
      const close = matchBalanced(code, i + 1, '[', ']');
      if (close < 0) return i;
      i = close + 1;
      continue;
    }
    const name = /[\w.]+/y;
    name.lastIndex = i + 1;
    const nm = name.exec(code);
    if (!nm) return i;
    let j = i + 1 + nm[0].length;
    const k = skipWs(code, j);
    if (code[k] === '(') {
      const close = matchBalanced(code, k, '(', ')');
      if (close < 0) return i;
      j = close + 1;
    }
    i = j;
  }
}

/** Index just past an annotation's own `(...)` argument list, if it has one. */
function skipArgs(code, i) {
  const k = skipWs(code, i);
  if (code[k] !== '(') return i;
  const close = matchBalanced(code, k, '(', ')');
  return close < 0 ? i : close + 1;
}

const lastSegment = (s) => String(s).split(/[.\\]/).filter(Boolean).pop() || '';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------
// Scopes: which class / function / method encloses an offset
// ---------------------------------------------------------------------------

// A '{' only opens a declaration body if what sits between the header and the
// brace looks like a header (extends/implements lists, throws, return types).
// That filter is what stops the prose in `"this class handles errors"` from
// becoming a scope that swallows half the file.
const HEADER_TAIL = /^[\w\s,.<>?&[\]$|:]*$/;

function bodyBraceAfter(code, from) {
  const j = code.indexOf('{', from);
  if (j < 0 || j - from > 300) return -1;
  return HEADER_TAIL.test(code.slice(from, j)) ? j : -1;
}

const NOT_METHODS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'synchronized', 'return', 'else', 'new', 'throw', 'try', 'with',
  'elif', 'function', 'constructor', 'foreach', 'using', 'lock', 'fixed', 'match'
]);

function braceScopes(code) {
  // A minified line makes the line-anchored method regex pathological and
  // the names useless anyway.
  if (/[^\n]{4000}/.test(code)) return [];
  const scopes = [];
  const push = (name, kind, start, bodyOpen) => {
    if (bodyOpen < 0) return;
    const close = matchBalanced(code, bodyOpen, '{', '}');
    scopes.push({ name, kind, start, end: close < 0 ? code.length : close + 1 });
  };

  let m;
  const classRe = /\b(?:class|interface|enum|trait)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = classRe.exec(code))) push(m[1], 'class', m.index, bodyBraceAfter(code, classRe.lastIndex));

  const fnRe = /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = fnRe.exec(code))) {
    const close = matchBalanced(code, fnRe.lastIndex - 1, '(', ')');
    if (close >= 0) push(m[1], 'function', m.index, bodyBraceAfter(code, close + 1));
  }

  // Class members in TS/JS/Java/PHP: `[modifiers/return type] name(...) {`.
  const methodRe = /^[ \t]*((?:[\w$@.<>[\],?]+[ \t]+)*)([A-Za-z_$][\w$]*)[ \t]*\(/gm;
  while ((m = methodRe.exec(code))) {
    const name = m[2];
    if (NOT_METHODS.has(name) || /\b(?:new|return|else|throw|case|await|yield|typeof|in|of)\s*$/.test(m[1])) continue;
    const open = m.index + m[0].length - 1;
    const close = matchBalanced(code, open, '(', ')');
    if (close >= 0) push(name, 'method', m.index, bodyBraceAfter(code, close + 1));
  }

  const arrowRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]{0,80})?=\s*(?:async\s+)?(?:\([^()\n]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=\n]{0,80})?=>\s*(\{)?/g;
  while ((m = arrowRe.exec(code))) {
    if (m[1] && m[0].endsWith('{')) {
      push(m[1], 'function', m.index, m.index + m[0].length - 1);
    } else {
      // Expression body: runs to the end of the statement.
      const semi = code.indexOf(';', arrowRe.lastIndex);
      const nl = code.indexOf('\n', arrowRe.lastIndex);
      const ends = [semi, nl].filter((x) => x >= 0);
      scopes.push({ name: m[1], kind: 'function', start: m.index, end: ends.length ? Math.min(...ends) : code.length });
    }
  }
  return scopes;
}

/** Indentation-delimited def/class scopes. A `)` line at def indent is still the signature, not the next statement. */
function pythonScopes(code) {
  const lines = code.split('\n');
  const starts = [];
  let off = 0;
  for (const l of lines) { starts.push(off); off += l.length + 1; }
  const indentOf = (l) => { const m = /^[ \t]*/.exec(l); return m[0].length; };
  const scopes = [];
  for (let li = 0; li < lines.length; li++) {
    const m = /^([ \t]*)(?:async[ \t]+)?(def|class)[ \t]+([A-Za-z_]\w*)/.exec(lines[li]);
    if (!m) continue;
    const indent = m[1].length;
    let lj = li + 1;
    for (; lj < lines.length; lj++) {
      const l = lines[lj];
      if (!l.trim()) continue;
      if (indentOf(l) > indent || /^[ \t]*[)\]}]/.test(l)) continue;
      break;
    }
    scopes.push({
      name: m[3],
      kind: m[2] === 'class' ? 'class' : 'function',
      start: starts[li],
      end: lj < lines.length ? starts[lj] : code.length
    });
  }
  return scopes;
}

/** Name of the innermost scope containing idx (optionally only of one kind), or null. */
function scopeAt(scopes, idx, kind) {
  let best = null;
  for (const s of scopes) {
    if (kind && s.kind !== kind) continue;
    if (idx >= s.start && idx < s.end && (!best || s.start >= best.start)) best = s;
  }
  return best ? best.name : null;
}

// ---------------------------------------------------------------------------
// Fact collector
// ---------------------------------------------------------------------------

function makeCollector(source) {
  const facts = [];
  const seen = new Set();
  const newlines = [];
  for (let i = source.indexOf('\n'); i >= 0; i = source.indexOf('\n', i + 1)) newlines.push(i);

  const lineOf = (idx) => {
    let lo = 0;
    let hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (newlines[mid] < idx) lo = mid + 1; else hi = mid;
    }
    return lo + 1;
  };

  const json = (obj) => {
    const clean = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null || v === '') continue;
      clean[k] = v;
    }
    return JSON.stringify(clean);
  };

  // Deduped on everything but the line: a `Class.forName` repeated ten times
  // in one method is one fact, not ten.
  const add = (symbolName, framework, role, detail, index) => {
    if (facts.length >= MAX_FACTS) return;
    const d = detail == null ? null : typeof detail === 'string' ? detail : json(detail);
    const key = `${symbolName}|${framework}|${role}|${d}`;
    if (seen.has(key)) return;
    seen.add(key);
    facts.push({ symbolName: symbolName || null, framework, role, detail: d, line: lineOf(index) });
  };

  return { facts, add, lineOf, json };
}

// ---------------------------------------------------------------------------
// HTML templates (Angular)
// ---------------------------------------------------------------------------

// Hyphenated names that are real HTML/SVG/MathML elements, not custom ones,
// and Angular's own structural tags.
const BUILTIN_HYPHEN_TAGS = /^(?:ng-|annotation-xml$|color-profile$|font-face|missing-glyph$)/;

/** Custom-element tags and pipes used by a template string; `base` shifts offsets to file coordinates. */
function scanTemplate(html, base, onTag, onPipe) {
  const tagRe = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)(?=[\s/>])/g;
  let m;
  while ((m = tagRe.exec(html))) {
    if (!BUILTIN_HYPHEN_TAGS.test(m[1])) onTag(m[1], base + m.index);
  }

  const pipesIn = (expr, at) => {
    const bare = expr.replace(/'[^']*'|"[^"]*"/g, (s) => ' '.repeat(s.length));
    const pipeRe = /(?<!\|)\|(?!\|)\s*([A-Za-z_]\w*)/g;
    let p;
    while ((p = pipeRe.exec(bare))) onPipe(p[1], base + at + p.index);
  };
  const interpRe = /\{\{([\s\S]*?)\}\}/g;
  while ((m = interpRe.exec(html))) pipesIn(m[1], m.index + 2);
  const attrRe = /\s(?:\[\([^)\s]+\)\]|\[[^\]\s]+\]|\([^)\s]+\)|\*\w+)\s*=\s*(["'])([\s\S]*?)\1/g;
  while ((m = attrRe.exec(html))) pipesIn(m[2], m.index + m[0].length - m[2].length - 1);
}

function htmlFacts(code, ctx) {
  const framework = /\*ng[A-Z]|\[\(|\{\{|\s\([a-zA-Z.]+\)=|\s\[[a-zA-Z.]+\]=|\bng-/.test(code) ? 'angular' : 'html';
  scanTemplate(
    code,
    0,
    (tag, idx) => ctx.add(null, framework, 'template-uses', tag, idx),
    (name, idx) => ctx.add(null, framework, 'template-pipe', name, idx)
  );
}

// ---------------------------------------------------------------------------
// Angular / TypeScript
// ---------------------------------------------------------------------------

const TS_NOT_INJECTABLE = new Set([
  'String', 'Number', 'Boolean', 'Object', 'Array', 'Function', 'Date', 'Promise', 'Observable', 'Map', 'Set',
  'Record', 'Partial', 'Symbol', 'RegExp', 'Error', 'Event', 'Element', 'HTMLElement'
]);

function strProp(text, key) {
  const m = new RegExp(`(?:^|[\\s,{])${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`).exec(text);
  if (!m) return null;
  return { value: m[2], start: m.index + m[0].length - m[2].length - 1 };
}

function identifierList(text, key) {
  const m = new RegExp(`(?:^|[\\s,{])${key}\\s*:\\s*\\[`).exec(text);
  if (!m) return [];
  const open = m.index + m[0].length - 1;
  const close = matchBalanced(text, open, '[', ']');
  const inner = text.slice(open + 1, close < 0 ? text.length : close);
  const names = inner.match(/\b[A-Z][\w$]*/g) || [];
  return [...new Set(names)].slice(0, 200);
}

function classAfter(code, from) {
  const re = /\bclass\s+([A-Za-z_$][\w$]*)/g;
  re.lastIndex = from;
  const m = re.exec(code);
  return m && m.index - from < 500 ? m[1] : null;
}

/** Start of the `{` that directly encloses idx (not through a nested [] or ()), or -1. */
function enclosingObjectStart(code, idx) {
  let depth = 0;
  for (let j = idx - 1; j >= 0 && idx - j < 3000; j--) {
    const c = code[j];
    if (c === '}' || c === ']' || c === ')') depth++;
    else if (c === '{') { if (depth === 0) return j; depth--; }
    else if (c === '[' || c === '(') { if (depth === 0) return -1; depth--; }
  }
  return -1;
}

function tsParamTypes(text) {
  const out = [];
  for (const raw of splitTopLevel(text)) {
    let token = null;
    let p = raw.replace(/@Inject\s*\(\s*([A-Za-z_$][\w$.]*)\s*\)/, (_, t) => { token = t; return ' '; });
    p = p.replace(/@[A-Za-z_$][\w$]*\s*(?:\((?:[^()]|\([^()]*\))*\))?/g, ' ').trim();
    const m = /^(?:(?:public|private|protected|readonly|override)\s+)*[A-Za-z_$][\w$]*\??\s*:\s*([A-Za-z_$][\w$.]*)/.exec(p);
    // An explicit @Inject(TOKEN) names what is really injected; the declared
    // type is then often just `string` or an interface.
    const type = token || (m ? m[1] : null);
    if (!type) continue;
    const name = lastSegment(type);
    if (/^[A-Z]/.test(name) && !TS_NOT_INJECTABLE.has(name)) out.push(name);
  }
  return out;
}

function angularFacts(code, ctx, source) {
  const { add, lineOf } = ctx;
  const scopes = braceScopes(code);
  const framework = /@angular\//.test(source) || /@(?:Component|NgModule)\s*\(/.test(code) ? 'angular' : 'typescript';
  let m;

  // --- decorators ---------------------------------------------------------
  const decRe = /@(Component|Directive|Pipe|Injectable|NgModule)\s*\(/g;
  while ((m = decRe.exec(code))) {
    const open = decRe.lastIndex - 1;
    const close = matchBalanced(code, open, '(', ')');
    if (close < 0) continue;
    const args = code.slice(open + 1, close);
    const top = topLevel(args);
    const cls = classAfter(code, close + 1);
    const kind = m[1];

    if (kind === 'Component') {
      const selector = strProp(top, 'selector');
      const templateUrl = strProp(top, 'templateUrl');
      add(cls, framework, 'component', {
        selector: selector && selector.value,
        templateUrl: templateUrl && templateUrl.value
      }, m.index);
      // An inline template is the same coupling as a templateUrl file, just
      // owned by this class directly.
      const inline = strProp(top, 'template');
      if (inline) {
        scanTemplate(
          inline.value,
          open + 1 + inline.start,
          (tag, idx) => add(cls, framework, 'template-uses', tag, idx),
          (name, idx) => add(cls, framework, 'template-pipe', name, idx)
        );
      }
    } else if (kind === 'Directive') {
      const selector = strProp(top, 'selector');
      add(cls, framework, 'directive', { selector: selector && selector.value }, m.index);
    } else if (kind === 'Pipe') {
      const name = strProp(top, 'name');
      add(cls, framework, 'pipe', { name: name && name.value }, m.index);
    } else if (kind === 'Injectable') {
      const provided = strProp(top, 'providedIn');
      add(cls, framework, 'service', provided ? { providedIn: provided.value } : null, m.index);
    } else {
      add(cls, framework, 'module', {
        declarations: identifierList(args, 'declarations'),
        imports: identifierList(args, 'imports'),
        providers: identifierList(args, 'providers')
      }, m.index);
    }
  }

  // --- constructor injection ---------------------------------------------
  const ctorRe = /\bconstructor\s*\(/g;
  while ((m = ctorRe.exec(code))) {
    const open = ctorRe.lastIndex - 1;
    const close = matchBalanced(code, open, '(', ')');
    if (close < 0) continue;
    const cls = scopeAt(scopes, m.index, 'class');
    if (!cls) continue;
    for (const type of tsParamTypes(code.slice(open + 1, close))) add(cls, framework, 'injects', type, m.index);
  }

  // --- inject(Foo) --------------------------------------------------------
  const injectRe = /(?<![\w$.])inject\s*(?:<[^()]*?>)?\s*\(\s*([A-Za-z_$][\w$.]*)/g;
  while ((m = injectRe.exec(code))) {
    const name = lastSegment(m[1]);
    if (/^[A-Z]/.test(name)) add(scopeAt(scopes, m.index), framework, 'injects', name, m.index);
  }

  // --- route definitions --------------------------------------------------
  const pathRe = /\bpath\s*:\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
  while ((m = pathRe.exec(code))) {
    const start = enclosingObjectStart(code, m.index);
    if (start < 0) continue;
    const end = matchBalanced(code, start, '{', '}');
    if (end < 0) continue;
    const obj = code.slice(start, end + 1);
    const top = topLevel(obj);

    const comp = /(?:^|[\s,{])component\s*:\s*([A-Za-z_$][\w$.]*)/.exec(top);
    const route = { path: m[2], component: comp ? lastSegment(comp[1]) : null };

    // loadChildren/loadComponent values are arrow functions, which topLevel()
    // blanked - so find the key there and read the value from the original.
    for (const key of ['loadChildren', 'loadComponent']) {
      const k = new RegExp(`(?:^|[\\s,{])${key}\\s*:`).exec(top);
      if (!k) continue;
      const value = obj.slice(k.index + k[0].length, k.index + k[0].length + 400);
      const lazy = /import\s*\(\s*(['"`])([^'"`]+)\1\s*\)(?:\s*\.then\s*\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.([\w$]+))?/.exec(value);
      const legacy = /^\s*(['"])([^'"]+)\1/.exec(value);
      if (lazy) {
        route[key] = lazy[3] || lazy[2];
        route.importPath = lazy[2];
      } else if (legacy) {
        const [file, sym] = legacy[2].split('#');
        route[key] = sym || file;
      }
    }
    if (route.component || route.loadChildren || route.loadComponent) {
      add(scopeAt(scopes, m.index), /@angular\//.test(source) ? 'angular' : 'js-router', 'route', route, m.index);
    }
  }
}

// ---------------------------------------------------------------------------
// Dynamic-dispatch hints (JS/TS)
// ---------------------------------------------------------------------------

/**
 * True when the first argument starting at `i` is a plain string literal -
 * a literal require/import is an ordinary static dependency, and flagging
 * every one would drown the hints that matter.
 */
function isLiteralArg(code, i) {
  const k = skipWs(code, i);
  const q = code[k];
  if (q === "'" || q === '"') return true;
  if (q === '`') {
    const end = skipString(code, k);
    return !code.slice(k, end).includes('${');
  }
  return false;
}

function jsDynamicFacts(code, ctx) {
  const { add } = ctx;
  const scopes = braceScopes(code);
  const hint = (idx, pattern) => add(scopeAt(scopes, idx), 'javascript', 'dynamic', pattern, idx);
  let m;

  const callRe = /(?<![\w$.])(require|import)\s*\(/g;
  while ((m = callRe.exec(code))) {
    if (!isLiteralArg(code, callRe.lastIndex)) hint(m.index, `${m[1]}(variable)`);
  }
  const evalRe = /(?<![\w$.])eval\s*\(/g;
  while ((m = evalRe.exec(code))) hint(m.index, 'eval');
  const fnRe = /\bnew\s+Function\s*\(/g;
  while ((m = fnRe.exec(code))) hint(m.index, 'new Function');
  // `window['x']` / `this['x']` with a literal is just property access.
  const idxRe = /(?<![\w$.])(window|this|self|globalThis)\s*\[\s*(?!['"`\d\s])/g;
  while ((m = idxRe.exec(code))) hint(m.index, `${m[1]}[variable]`);
}

// ---------------------------------------------------------------------------
// Java / Spring
// ---------------------------------------------------------------------------

const JAVA_STEREOTYPES = {
  RestController: ['controller', 'spring'],
  Controller: ['controller', 'spring'],
  Service: ['service', 'spring'],
  Repository: ['repository', 'spring'],
  Component: ['component', 'spring'],
  Configuration: ['configuration', 'spring'],
  Entity: ['entity', 'jpa']
};
const JAVA_BEAN_ANNOTATIONS = new Set(['RestController', 'Controller', 'Service', 'Repository', 'Component', 'Configuration']);

// Value types that are never a wired collaborator; keeping them out stops
// every `final String name` field from becoming an injection.
const JAVA_NOT_INJECTABLE = new Set([
  'String', 'Integer', 'Long', 'Short', 'Byte', 'Boolean', 'Double', 'Float', 'Character', 'int', 'long', 'short',
  'byte', 'boolean', 'double', 'float', 'char', 'void', 'Object', 'Class', 'BigDecimal', 'BigInteger', 'Date',
  'UUID', 'Instant', 'LocalDate', 'LocalDateTime', 'Duration', 'Pattern', 'Logger'
]);

// Containers whose type argument is the thing actually injected
// (`List<Handler>` wires every Handler bean).
const JAVA_WRAPPERS = new Set([
  'List', 'Set', 'Collection', 'Map', 'Optional', 'Provider', 'ObjectProvider', 'Lazy', 'Supplier', 'Iterable',
  'Stream', 'ObjectFactory'
]);

function normalizeJavaType(base, generic) {
  let name = lastSegment(base);
  if (generic && JAVA_WRAPPERS.has(name)) {
    const args = splitTopLevel(generic.replace(/^</, '').replace(/>$/, ''));
    const inner = args.length ? /^(?:\?\s+extends\s+)?([A-Za-z_][\w.]*)/.exec(args[args.length - 1]) : null;
    name = inner ? lastSegment(inner[1]) : '';
  }
  return name && !JAVA_NOT_INJECTABLE.has(name) ? name : null;
}

function javaParamTypes(text) {
  const out = [];
  for (const raw of splitTopLevel(text)) {
    const s = raw.replace(/@[\w.]+(?:\s*\([^)]*\))?/g, ' ').replace(/\bfinal\b/g, ' ').trim();
    const m = /^([A-Za-z_][\w.]*)\s*(<.*>)?\s*(?:\[\])?\s*(?:\.\.\.)?\s*[A-Za-z_]\w*$/s.exec(s);
    const type = m ? normalizeJavaType(m[1], m[2]) : null;
    if (type) out.push(type);
  }
  return out;
}

function joinPath(base, sub) {
  const joined = `/${base || ''}/${sub || ''}`.replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

function javaFacts(code, ctx) {
  const { add } = ctx;
  const scopes = braceScopes(code);
  const classDecl = /(?:(?:public|protected|private|abstract|final|static|sealed|strictfp)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/y;
  const declAt = (i) => {
    classDecl.lastIndex = skipWs(code, i);
    const d = classDecl.exec(code);
    return d ? d[1] : null;
  };
  let m;

  // --- stereotypes --------------------------------------------------------
  const beanClasses = new Set();
  const stereoRe = /@(RestController|Controller|Service|Repository|Component|Configuration|Entity)\b/g;
  while ((m = stereoRe.exec(code))) {
    const after = skipAnnotations(code, skipArgs(code, m.index + m[0].length), '@');
    const cls = declAt(after);
    if (!cls) continue;
    const [role, framework] = JAVA_STEREOTYPES[m[1]];
    if (JAVA_BEAN_ANNOTATIONS.has(m[1])) beanClasses.add(cls);
    add(cls, framework, role, null, m.index);
  }
  // Spring Data repositories are beans with no annotation at all.
  const repoRe = /\binterface\s+([A-Za-z_$][\w$]*)\s+extends\s+([^{]*)\{/g;
  while ((m = repoRe.exec(code))) {
    const base = /\b\w*Repository\s*<\s*([A-Za-z_][\w.]*)/.exec(m[2]);
    if (base) add(m[1], 'spring', 'repository', lastSegment(base[1]), m.index);
  }

  // --- field / setter / constructor injection ----------------------------
  const injectRe = /@(Autowired|Inject|Resource)\b/g;
  const fieldRe = /^(?:(?:public|protected|private|final|static|transient|volatile)\s+)*([A-Za-z_][\w.]*)\s*(<[^;=(){}]*>)?\s*(?:\[\])?\s+\w+\s*[;=]/;
  const memberRe = /^(?:(?:public|protected|private|final|static|synchronized)\s+)*(?:[\w.]+(?:<[^;=(){}]*>)?\s+)?\w+\s*\(/;
  while ((m = injectRe.exec(code))) {
    const at = skipAnnotations(code, skipArgs(code, m.index + m[0].length), '@');
    const tail = code.slice(at, at + 500);
    const owner = scopeAt(scopes, m.index, 'class');
    const field = fieldRe.exec(tail);
    if (field) {
      const type = normalizeJavaType(field[1], field[2]);
      if (type) add(owner, 'spring', 'injects', type, m.index);
      continue;
    }
    const member = memberRe.exec(tail);
    if (member) {
      const open = at + member[0].length - 1;
      const close = matchBalanced(code, open, '(', ')');
      if (close > 0) for (const t of javaParamTypes(code.slice(open + 1, close))) add(owner, 'spring', 'injects', t, m.index);
    }
  }

  // --- implicit constructor injection ------------------------------------
  // Spring wires a bean's only constructor with no annotation, and Lombok's
  // @RequiredArgsConstructor writes it for you - so for bean classes (and any
  // class holding final fields, which a constructor must fill) the
  // constructor's parameter types are the collaborators.
  for (const s of scopes) {
    if (s.kind !== 'class') continue;
    const body = code.slice(s.start, s.end);
    const finals = [];
    const finalRe = /\b(?:private|protected|public)\s+final\s+([A-Za-z_][\w.]*)\s*(<[^;=(){}]*>)?\s+\w+\s*;/g;
    let f;
    while ((f = finalRe.exec(body))) {
      const t = normalizeJavaType(f[1], f[2]);
      if (t) finals.push({ type: t, index: s.start + f.index });
    }
    const isBean = beanClasses.has(s.name);
    if (!isBean && !finals.length) continue;

    const ctorRe = new RegExp(`(?:^|[\\s;{}])(?:(?:public|protected|private)\\s+)?${escapeRe(s.name)}\\s*\\(`, 'g');
    let c;
    let found = false;
    while ((c = ctorRe.exec(body))) {
      const open = ctorRe.lastIndex - 1;
      const nameStart = body.lastIndexOf(s.name, open);
      if (/\bnew\s+$/.test(body.slice(Math.max(0, nameStart - 8), nameStart))) continue;
      const close = matchBalanced(body, open, '(', ')');
      if (close < 0) continue;
      if (!/^\s*(?:throws[\w\s,.]*)?\{/.test(body.slice(close + 1, close + 200))) continue;
      found = true;
      for (const t of javaParamTypes(body.slice(open + 1, close))) add(s.name, 'spring', 'injects', t, s.start + c.index);
    }
    if (!found && isBean) for (const fin of finals) add(s.name, 'spring', 'injects', fin.type, fin.index);
  }

  // --- routes -------------------------------------------------------------
  const basePaths = new Map();
  const mapRe = /@(Get|Post|Put|Delete|Patch|Request)Mapping\b/g;
  while ((m = mapRe.exec(code))) {
    const afterName = m.index + m[0].length;
    const k = skipWs(code, afterName);
    let args = '';
    let next = afterName;
    if (code[k] === '(') {
      const close = matchBalanced(code, k, '(', ')');
      if (close < 0) continue;
      args = code.slice(k + 1, close);
      next = close + 1;
    }
    const pathMatch = /\b(?:value|path)\s*=\s*\{?\s*"([^"]*)"/.exec(args) || /^\s*\{?\s*"([^"]*)"/.exec(args);
    const sub = pathMatch ? pathMatch[1] : '';
    let method = m[1].toUpperCase();
    if (m[1] === 'Request') {
      const mm = /\bmethod\s*=\s*\{?\s*(?:RequestMethod\.)?([A-Z]+)/.exec(args);
      method = mm ? mm[1] : 'ANY';
    }

    const after = skipAnnotations(code, next, '@');
    const cls = declAt(after);
    if (cls) {
      basePaths.set(cls, sub);
      add(cls, 'spring', 'route', { method, path: joinPath('', sub) }, m.index);
      continue;
    }
    const sig = /^(?:(?:public|protected|private|static|final|synchronized|abstract|default)\s+)*[\w.]+(?:\s*<[^;(){}]*>)?(?:\s*\[\])?\s+(\w+)\s*\(/.exec(code.slice(after, after + 400));
    const owner = scopeAt(scopes, m.index, 'class');
    add(sig ? sig[1] : owner, 'spring', 'route', { method, path: joinPath(basePaths.get(owner) || '', sub) }, m.index);
  }

  // --- @Bean methods ------------------------------------------------------
  const beanRe = /@Bean\b/g;
  while ((m = beanRe.exec(code))) {
    const after = skipAnnotations(code, skipArgs(code, m.index + m[0].length), '@');
    const sig = /^(?:(?:public|protected|private|static|final|synchronized)\s+)*([\w.]+)(?:\s*<[^;(){}]*>)?(?:\s*\[\])?\s+(\w+)\s*\(/.exec(code.slice(after, after + 400));
    // detail is the produced type: that is what other classes inject.
    if (sig) add(sig[2], 'spring', 'bean', lastSegment(sig[1]), m.index);
  }

  // --- reflection hints ---------------------------------------------------
  const reflect = [
    [/\bClass\s*\.\s*forName\s*\(/g, 'Class.forName'],
    [/\.\s*getDeclaredMethods?\s*\(/g, 'getDeclaredMethod'],
    [/\.\s*getDeclaredFields?\s*\(/g, 'getDeclaredField'],
    [/\.\s*getDeclaredConstructors?\s*\(/g, 'getDeclaredConstructor'],
    [/\bServiceLoader\s*\.\s*load\w*\s*\(/g, 'ServiceLoader'],
    [/\bProxy\s*\.\s*newProxyInstance\s*\(/g, 'Proxy.newProxyInstance']
  ];
  for (const [re, name] of reflect) {
    while ((m = re.exec(code))) add(scopeAt(scopes, m.index), 'java', 'dynamic', name, m.index);
  }
}

// ---------------------------------------------------------------------------
// Python (Django / FastAPI / Flask)
// ---------------------------------------------------------------------------

function pythonFacts(code, ctx) {
  const { add } = ctx;
  const scopes = pythonScopes(code);
  let m;

  // --- Django models ------------------------------------------------------
  const modelRe = /^class[ \t]+(\w+)[ \t]*\(([^)]*)\)[ \t]*:/gm;
  while ((m = modelRe.exec(code))) {
    if (/\bmodels\s*\.\s*Model\b/.test(m[2]) || (/\bModel\b/.test(m[2]) && /django/.test(code))) {
      add(m[1], 'django', 'model', m[1], m.index);
    } else if (/\bdb\s*\.\s*Model\b/.test(m[2])) {
      add(m[1], 'flask', 'model', m[1], m.index);
    }
  }

  // --- Django urlpatterns -------------------------------------------------
  // Handler is a dotted view reference, or include('app.urls'); both are
  // names a call graph never sees being "called".
  if (/\burlpatterns\b|django\.urls/.test(code)) {
    const urlRe = /(?<![\w.])(path|re_path|url)\s*\(\s*[rub]?(['"])((?:\\.|(?!\2)[^\\\n])*)\2\s*,\s*([A-Za-z_][\w.]*)/g;
    while ((m = urlRe.exec(code))) {
      let handler = m[4];
      if (handler === 'include') {
        const inc = /^\s*\(\s*(?:\(\s*)?(?:(['"])([^'"]+)\1|([A-Za-z_][\w.]*))/.exec(code.slice(urlRe.lastIndex, urlRe.lastIndex + 200));
        handler = inc ? inc[2] || inc[3] : null;
      }
      handler = handler && handler.replace(/\.as_view$/, '');
      add(scopeAt(scopes, m.index), 'django', 'route', { method: 'ANY', path: m[3], handler }, m.index);
    }
  }

  // --- FastAPI / Flask decorators ----------------------------------------
  const routeRe = /@([A-Za-z_]\w*)\.(get|post|put|delete|patch|options|head|route|api_route|websocket)[ \t]*\(/g;
  while ((m = routeRe.exec(code))) {
    // `@mock.patch("x")` has the same shape as `@router.patch("/x")`; an
    // app/router-like receiver name is what tells them apart.
    if (!/(?:app|router|api|bp|blueprint)$/i.test(m[1])) continue;
    const open = routeRe.lastIndex - 1;
    const close = matchBalanced(code, open, '(', ')');
    if (close < 0) continue;
    const args = code.slice(open + 1, close);
    const verb = m[2];
    const pathMatch = /^\s*(?:(?:path|rule)\s*=\s*)?(['"])((?:\\.|(?!\1).)*)\1/s.exec(args);
    let method = verb === 'websocket' ? 'WS' : verb.toUpperCase();
    if (verb === 'route' || verb === 'api_route') {
      const ms = /\bmethods\s*=\s*[[(]([^\])]*)[\])]/.exec(args);
      const list = ms ? (ms[1].match(/['"](\w+)['"]/g) || []).map((s) => s.slice(1, -1).toUpperCase()) : [];
      method = list.length ? list.join(',') : 'GET';
    }
    const after = skipAnnotations(code, close + 1, '@');
    const fn = /^(?:async\s+)?def\s+(\w+)/.exec(code.slice(after, after + 200));
    const framework = /\bflask\b/i.test(code) ? 'flask' : /fastapi/i.test(code) ? 'fastapi' : verb === 'route' ? 'flask' : 'fastapi';
    add(fn ? fn[1] : scopeAt(scopes, m.index), framework, 'route', { method, path: pathMatch ? pathMatch[2] : null }, m.index);
  }

  // --- FastAPI dependency injection --------------------------------------
  const depRe = /(?<![\w.])Depends\s*\(\s*([A-Za-z_][\w.]*)/g;
  while ((m = depRe.exec(code))) add(scopeAt(scopes, m.index), 'fastapi', 'injects', lastSegment(m[1]), m.index);

  // --- dynamic hints ------------------------------------------------------
  const dyn = [
    [/(?<![\w.])getattr\s*\(/g, 'getattr'],
    [/\bimportlib\s*\.\s*import_module\s*\(/g, 'importlib.import_module'],
    [/(?<![\w.])__import__\s*\(/g, '__import__'],
    // `model.eval()` (torch etc.) is a method call, not the builtin.
    [/(?<![\w.])eval\s*\(/g, 'eval'],
    [/(?<![\w.])exec\s*\(/g, 'exec']
  ];
  for (const [re, name] of dyn) {
    while ((m = re.exec(code))) add(scopeAt(scopes, m.index), 'python', 'dynamic', name, m.index);
  }
}

// ---------------------------------------------------------------------------
// PHP (Laravel / Symfony)
// ---------------------------------------------------------------------------

const PHP_SCALARS = new Set([
  'int', 'string', 'bool', 'boolean', 'float', 'double', 'array', 'mixed', 'callable', 'iterable', 'object', 'self',
  'static', 'null', 'void', 'false', 'true', 'parent', 'never'
]);

function phpFacts(code, ctx) {
  const { add } = ctx;
  const scopes = braceScopes(code);
  let m;

  // `use Foo\Bar as Baz;` - an injected `Baz` is really `Bar`.
  const aliases = new Map();
  const useRe = /^[ \t]*use\s+([\w\\]+)(?:\s+as\s+(\w+))?\s*;/gm;
  while ((m = useRe.exec(code))) aliases.set(m[2] || lastSegment(m[1]), lastSegment(m[1]));

  // --- Laravel routes -----------------------------------------------------
  const routeRe = /\bRoute\s*::\s*(get|post|put|patch|delete|options|any|match|resource|apiResource|view|redirect)\s*\(/g;
  while ((m = routeRe.exec(code))) {
    const open = routeRe.lastIndex - 1;
    const close = matchBalanced(code, open, '(', ')');
    if (close < 0) continue;
    let args = code.slice(open + 1, close);
    let method = m[1].toUpperCase();
    if (m[1] === 'match') {
      const verbs = /^\s*\[([^\]]*)\]\s*,?/.exec(args);
      if (verbs) {
        method = (verbs[1].match(/['"](\w+)['"]/g) || []).map((s) => s.slice(1, -1).toUpperCase()).join(',') || 'MATCH';
        args = args.slice(verbs[0].length);
      }
    } else if (m[1] === 'resource' || m[1] === 'apiResource') {
      method = 'RESOURCE';
    }
    const p = /(['"])((?:\\.|(?!\1).)*)\1/s.exec(args);
    const ctl = /([A-Z][\w\\]*)::class\s*,\s*['"](\w+)['"]/.exec(args) || /['"]([\w\\]+)@(\w+)['"]/.exec(args) || /([A-Z][\w\\]*)::class/.exec(args);
    add(scopeAt(scopes, m.index), 'laravel', 'route', {
      method,
      path: p ? p[2] : null,
      controller: ctl ? lastSegment(ctl[1]) : null,
      action: ctl ? ctl[2] : null
    }, m.index);
  }

  // --- Symfony #[Route(...)] ---------------------------------------------
  const attrRe = /#\[\s*Route\s*\(/g;
  const basePaths = new Map();
  while ((m = attrRe.exec(code))) {
    const open = attrRe.lastIndex - 1;
    const close = matchBalanced(code, open, '(', ')');
    if (close < 0) continue;
    const args = code.slice(open + 1, close);
    const p = /^\s*(?:path\s*:\s*)?(['"])((?:\\.|(?!\1).)*)\1/s.exec(args) || /\bpath\s*:\s*(['"])((?:\\.|(?!\1).)*)\1/s.exec(args);
    const ms = /\bmethods\s*:\s*\[([^\]]*)\]/.exec(args);
    const method = ms ? (ms[1].match(/['"](\w+)['"]/g) || []).map((s) => s.slice(1, -1).toUpperCase()).join(',') || 'ANY' : 'ANY';
    const sub = p ? p[2] : '';

    const closeAttr = code.indexOf(']', close);
    const after = skipAnnotations(code, closeAttr < 0 ? close + 1 : closeAttr + 1, '#[');
    const tail = code.slice(after, after + 300);
    const cls = /^(?:(?:abstract|final|readonly)\s+)*class\s+(\w+)/.exec(tail);
    if (cls) {
      basePaths.set(cls[1], sub);
      add(cls[1], 'symfony', 'route', { method, path: joinPath('', sub) }, m.index);
      continue;
    }
    const fn = /^(?:(?:public|protected|private|static|final|abstract)\s+)*function\s+(\w+)/.exec(tail);
    const owner = scopeAt(scopes, m.index, 'class');
    add(fn ? fn[1] : owner, 'symfony', 'route', { method, path: joinPath(basePaths.get(owner) || '', sub) }, m.index);
  }

  // --- constructor injection ---------------------------------------------
  const ctorRe = /\bfunction\s+__construct\s*\(/g;
  while ((m = ctorRe.exec(code))) {
    const open = ctorRe.lastIndex - 1;
    const close = matchBalanced(code, open, '(', ')');
    if (close < 0) continue;
    const owner = scopeAt(scopes, m.index, 'class');
    for (const raw of splitTopLevel(code.slice(open + 1, close))) {
      const p = raw.replace(/#\[[^\]]*\]/g, ' ').trim();
      const t = /^(?:(?:public|protected|private|readonly)\s+)*\??([A-Za-z_\\][\w\\|]*)\s+&?(?:\.\.\.)?\$\w+/.exec(p);
      if (!t) continue;
      for (const alt of t[1].split('|')) {
        const short = lastSegment(alt);
        if (!short || PHP_SCALARS.has(short.toLowerCase())) continue;
        add(owner, 'laravel', 'injects', aliases.get(short) || short, m.index);
      }
    }
  }
  // Service-locator form: app(Foo::class) / resolve(Foo::class).
  const locRe = /(?<![\w$>:])(?:app|resolve)\s*\(\s*([A-Z][\w\\]*)::class/g;
  while ((m = locRe.exec(code))) {
    const short = lastSegment(m[1]);
    add(scopeAt(scopes, m.index), 'laravel', 'injects', aliases.get(short) || short, m.index);
  }

  // --- dynamic hints ------------------------------------------------------
  const dyn = [
    [/(?<![\w$>:])eval\s*\(/g, 'eval'],
    [/(?<![\w$>:])call_user_func(?:_array)?\s*\(/g, 'call_user_func'],
    [/\bnew\s+\$\w+/g, 'new $variable'],
    [/\$\$\w+/g, '$$variable'],
    [/\bnew\s+\\?Reflection(?:Class|Method|Object)\s*\(/g, 'Reflection']
  ];
  for (const [re, name] of dyn) {
    while ((m = re.exec(code))) add(scopeAt(scopes, m.index), 'php', 'dynamic', name, m.index);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const JS_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);

/**
 * Framework facts for one file. `ext` is the walker's extension (with its
 * dot); `relPath` is only used to infer one when it is missing. Never
 * throws: on any failure it returns the facts collected so far.
 */
function extractFrameworkFacts(relPath, ext, source) {
  let ctx = null;
  try {
    if (typeof source !== 'string' || !source || source.length > MAX_SOURCE_CHARS) return [];
    let e = String(ext || '').toLowerCase();
    if (!e && relPath) e = path.extname(String(relPath)).toLowerCase();
    if (e && !e.startsWith('.')) e = `.${e}`;

    ctx = makeCollector(source);
    if (e === '.html' || e === '.htm') {
      htmlFacts(blankComments(source, 'html'), ctx);
    } else if (JS_EXTENSIONS.has(e)) {
      const code = blankComments(source, 'c');
      if (e === '.ts') angularFacts(code, ctx, source);
      jsDynamicFacts(code, ctx);
    } else if (e === '.java') {
      javaFacts(blankComments(source, 'c'), ctx);
    } else if (e === '.py') {
      pythonFacts(blankComments(source, 'py'), ctx);
    } else if (e === '.php') {
      phpFacts(blankComments(source, 'php'), ctx);
    }
    return ctx.facts;
  } catch (_) {
    return ctx ? ctx.facts : [];
  }
}

module.exports = { extractFrameworkFacts, MAX_SOURCE_CHARS };
