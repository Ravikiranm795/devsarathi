'use strict';

// Impact analysis over framework facts (see frameworks.js). The call graph
// answers "who calls this"; these answer the questions it cannot - which
// templates render this component, which classes have this one injected,
// which routes expose it, and how much of the repo is reached by name
// strings no static tool can follow (spec MASTER 7.5 / 7.6).

const path = require('path');

// A symbol can be coupled in dozens of places in a big Angular app; the
// caller wants the shape of the blast radius, not an unbounded list.
const MAX_COUPLINGS = 200;

const posix = (p) => String(p || '').replace(/\\/g, '/');
const lastSegment = (s) => String(s || '').split(/[.\\/]/).filter(Boolean).pop() || '';

function parseDetail(detail) {
  if (!detail || detail[0] !== '{') return {};
  try {
    return JSON.parse(detail);
  } catch (_) {
    return {};
  }
}

/**
 * Element names an Angular selector can match in a template. Attribute and
 * class selectors (`[appFoo]`, `.bar`) are not element names, so only the
 * leading tag part of each comma-separated alternative counts.
 */
function elementSelectors(selector) {
  return String(selector || '')
    .split(',')
    .map((s) => /^\s*([a-z][\w-]*)/i.exec(s))
    .filter(Boolean)
    .map((m) => m[1]);
}

/** Components whose template is `htmlPath`, by templateUrl or - failing that - a sibling file name. */
function ownersOfTemplate(components, htmlPath) {
  const dir = path.posix.dirname(htmlPath);
  const stem = path.posix.basename(htmlPath).replace(/\.html?$/i, '');
  const byUrl = [];
  const bySibling = [];
  for (const c of components) {
    const cDir = path.posix.dirname(posix(c.path));
    const url = parseDetail(c.detail).templateUrl;
    if (url && path.posix.normalize(path.posix.join(cDir, url)) === htmlPath) byUrl.push(c);
    else if (cDir === dir && path.posix.basename(posix(c.path)).replace(/\.[^.]+$/, '') === stem) bySibling.push(c);
  }
  return byUrl.length ? byUrl : bySibling;
}

/**
 * Symbols/files coupled to `symbol` ({ id, name, path }) through framework
 * facts: [{ relation, name, path, line, why }].
 *   template-uses  a template that renders this component's selector (or uses
 *                  this pipe) - the .html file and the component that owns it
 *   injected-by    a class/function that has this type injected
 *   route          a route that renders/exposes this symbol
 * Never throws: an unreadable facts table just means no extra couplings.
 */
function frameworkCouplings(store, symbol) {
  try {
    return collectCouplings(store, symbol).slice(0, MAX_COUPLINGS);
  } catch (_) {
    return [];
  }
}

function collectCouplings(store, symbol) {
  const out = [];
  const seen = new Set();
  const push = (relation, name, filePath, line, why) => {
    const key = `${relation}|${name}|${filePath}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ relation, name, path: filePath, line: line == null ? null : line, why });
  };

  const selfPath = posix(symbol.path);
  const own = store.getFactsForFile(symbol.path).filter((f) => f.symbol_name === symbol.name);
  const isSelf = (f) => posix(f.path) === selfPath && f.symbol_name === symbol.name;

  // (a) templates ----------------------------------------------------------
  const components = store.findFacts({ role: 'component', framework: 'angular' });
  const usedBy = (facts, label) => {
    for (const fact of facts) {
      const fp = posix(fact.path);
      if (/\.html?$/i.test(fp)) {
        push('template-uses', path.posix.basename(fp), fp, fact.line, `template uses ${label}`);
        for (const owner of ownersOfTemplate(components, fp)) {
          if (posix(owner.path) === selfPath && owner.symbol_name === symbol.name) continue;
          push('template-uses', owner.symbol_name || path.posix.basename(posix(owner.path)), posix(owner.path), owner.line,
            `its template ${path.posix.basename(fp)} uses ${label}`);
        }
      } else if (fact.symbol_name && !isSelf(fact)) {
        // Inline template: the declaring class owns it directly.
        push('template-uses', fact.symbol_name, fp, fact.line, `inline template uses ${label}`);
      }
    }
  };
  for (const c of own.filter((f) => f.role === 'component')) {
    for (const tag of elementSelectors(parseDetail(c.detail).selector)) {
      usedBy(store.findFacts({ role: 'template-uses', detail: tag }), `<${tag}>`);
    }
  }
  for (const p of own.filter((f) => f.role === 'pipe')) {
    const name = parseDetail(p.detail).name;
    if (name) usedBy(store.findFacts({ role: 'template-pipe', detail: name }), `pipe '${name}'`);
  }

  // (b) injection ----------------------------------------------------------
  // A @Bean method is injected under the type it returns, not its own name.
  const injectedTypes = [symbol.name];
  for (const b of own) if (b.role === 'bean' && b.detail) injectedTypes.push(b.detail);
  for (const type of new Set(injectedTypes)) {
    for (const fact of store.findFacts({ role: 'injects', detail: type })) {
      if (isSelf(fact)) continue;
      const who = fact.symbol_name || path.posix.basename(posix(fact.path));
      push('injected-by', who, posix(fact.path), fact.line, `${who} injects ${type} (${fact.framework})`);
    }
  }

  // (c) routes -------------------------------------------------------------
  // For a class, the routes of its own methods count: a controller is
  // reached through them. Byte-range membership is the same rollup
  // getCallers uses.
  const memberNames = new Set([symbol.name]);
  if (symbol.id != null && typeof store.getClassMembers === 'function') {
    for (const m of store.getClassMembers(symbol.id)) memberNames.add(m.name);
  }
  for (const fact of store.findFacts({ role: 'route' })) {
    const d = parseDetail(fact.detail);
    const fp = posix(fact.path);
    const where = d.path != null ? `${d.method && d.method !== 'ANY' ? `${d.method} ` : ''}${d.path || '/'}` : '(dynamic path)';
    const targets = [d.component, d.loadComponent, d.loadChildren, d.handler, d.controller].filter(Boolean).map(lastSegment);
    if (targets.includes(symbol.name)) {
      const host = fact.symbol_name || path.posix.basename(fp);
      push('route', host, fp, fact.line, `route ${where} -> ${symbol.name}`);
    } else if (fp === selfPath && fact.symbol_name && memberNames.has(fact.symbol_name)) {
      push('route', fact.symbol_name, fp, fact.line, `exposed as ${where}`);
    }
  }

  return out;
}

/**
 * How much of what the call graph shows about `symbol` can be trusted, given
 * code that reaches things by string (reflection, eval, getattr, computed
 * require). Returns { level: 'none' | 'some' | 'high', reasons }.
 *   high  the symbol's own file has dynamic facts, or the symbol's name is an
 *         exact string literal inside a dynamic-flagged file (a likely
 *         dispatch target)
 *   some  nothing specific, but the repo has dynamic facts somewhere
 */
function dynamicRiskFor(store, symbol) {
  try {
    const all = store.findFacts({ role: 'dynamic' });
    if (!all.length) return { level: 'none', reasons: [] };

    const reasons = [];
    let level = 'some';
    const selfPath = posix(symbol.path);

    const ownHints = all.filter((f) => posix(f.path) === selfPath);
    if (ownHints.length) {
      level = 'high';
      const names = [...new Set(ownHints.map((f) => f.detail))].join(', ');
      reasons.push(`own file ${selfPath} has ${ownHints.length} dynamic-dispatch hint(s): ${names}`);
    }

    // A name this short is a substring of too many unrelated literals.
    if (symbol.name && String(symbol.name).length >= 3) {
      const literal = new RegExp(`(['"\`])${String(symbol.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`);
      const chunks = store.db.prepare(
        `SELECT c.code FROM chunks c JOIN symbols s ON s.id = c.symbol_id
         WHERE s.file_id = ? AND instr(c.code, ?) > 0`
      );
      const fileIds = [...new Set(all.filter((f) => posix(f.path) !== selfPath).map((f) => f.file_id))];
      for (const fileId of fileIds) {
        if (chunks.all(fileId, symbol.name).some((r) => literal.test(r.code || ''))) {
          const hit = all.find((f) => f.file_id === fileId);
          level = 'high';
          reasons.push(`'${symbol.name}' appears as a string literal in ${posix(hit.path)}, which uses ${hit.detail}`);
        }
      }
    }

    const files = new Set(all.map((f) => f.file_id)).size;
    reasons.push(`repo has ${all.length} dynamic-dispatch hint(s) in ${files} file(s); call-graph results may miss callers`);
    return { level, reasons };
  } catch (_) {
    return { level: 'none', reasons: [] };
  }
}

module.exports = { frameworkCouplings, dynamicRiskFor };
