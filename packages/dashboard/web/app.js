'use strict';
/*
 * DevSarathi dashboard (MASTER 18). Read-only: it only GETs /api/*. No framework, no build step, no external requests.
 * Everything is built with textContent (never innerHTML) because branch names, reasons and notices come from the repo.
 * Charts are hand-written SVG; each has a text alternative and a data table.
 */
(function () {
  // The token arrives once in ?token=. Keep it in memory and strip it from the address bar and history.
  var params = new URLSearchParams(location.search);
  var token = params.get('token') || '';
  if (params.has('token')) {
    params.delete('token');
    var q = params.toString();
    history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
  }

  var SVGNS = 'http://www.w3.org/2000/svg';
  var app = document.getElementById('app');
  var state = { repos: [], id: null };

  // ---- tiny DOM helpers ---------------------------------------------------------------------------------------------
  function el(tag, attrs, kids) { return build(document.createElement(tag), attrs, kids); }
  function sv(tag, attrs, kids) { return build(document.createElementNS(SVGNS, tag), attrs, kids); }
  function build(node, attrs, kids) {
    if (attrs) for (var k in attrs) { if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) node.setAttribute(k, attrs[k] === true ? '' : String(attrs[k])); }
    (Array.isArray(kids) ? kids : kids === undefined ? [] : [kids]).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    });
    return node;
  }
  function get(o) { for (var i = 1; i < arguments.length && o !== null && o !== undefined; i++) o = o[arguments[i]]; return o === undefined ? null : o; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function pct(r) { return isNum(r) ? Math.round(r * 100) + '%' : '—'; }
  function fmt(n) { return isNum(n) ? n.toLocaleString() : '—'; }
  function dur(ms) { return !isNum(ms) ? '—' : ms < 1000 ? ms + ' ms' : ms < 60000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms / 60000) + ' min'; }
  function sum(obj) { var t = 0; for (var k in (obj || {})) if (isNum(obj[k])) t += obj[k]; return t; }

  function rel(iso) {
    var t = Date.parse(iso); if (isNaN(t)) return null;
    var d = (Date.now() - t) / 1000, fut = d < 0; d = Math.abs(d);
    var u = [['second', 60], ['minute', 60], ['hour', 24], ['day', 30], ['month', 12], ['year', 1e9]], v = d, name = 'second';
    for (var i = 0; i < u.length; i++) { name = u[i][0]; if (v < u[i][1] || i === u.length - 1) break; v = v / u[i][1]; }
    v = Math.floor(v);
    if (name === 'second' && v < 45) return fut ? 'in a moment' : 'just now';
    var s = v + ' ' + name + (v === 1 ? '' : 's');
    return fut ? 'in ' + s : s + ' ago';
  }
  function abs(iso) { var t = Date.parse(iso); return isNaN(t) ? null : new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
  function timeEl(iso) {
    var a = abs(iso); if (!a) return el('span', null, 'unknown time');
    return el('time', { datetime: iso, title: a }, rel(iso) + ' (' + a + ')');
  }

  function badge(kind, text) { return el('span', { class: 'badge ' + kind }, text); }
  function empty(text) { return el('p', { class: 'empty' }, text); }
  function tile(k, v, note, warn) { return el('div', { class: 'tile' + (warn ? ' warn' : '') }, [el('div', { class: 'k' }, k), el('div', { class: 'v' }, v), note ? el('div', { class: 'n' }, note) : null]); }
  function card(id, title, subtitle, kids) {
    return el('section', { class: 'card', id: id, 'aria-labelledby': id + '-h' }, [
      el('header', null, [el('h2', { id: id + '-h' }, title), subtitle ? el('span', { class: 'sub' }, subtitle) : null])
    ].concat(kids));
  }
  function table(caption, heads, rows, numCols) {
    numCols = numCols || [];
    return el('div', { class: 'table-wrap' }, el('table', null, [
      el('caption', null, caption),
      el('thead', null, el('tr', null, heads.map(function (h, i) { return el('th', { scope: 'col', class: numCols.indexOf(i) >= 0 ? 'n' : null }, h); }))),
      el('tbody', null, rows.map(function (r) {
        return el('tr', null, r.map(function (c, i) {
          var cls = numCols.indexOf(i) >= 0 ? 'n' : null;
          if (c && c.warn) { cls = (cls ? cls + ' ' : '') + 'warncell'; c = c.text; }
          return el('td', { class: cls }, c);
        }));
      }))
    ]));
  }

  // ---- SVG charts ----------------------------------------------------------------------------------------------------
  var uid = 0;
  /** Horizontal bars as label | bar | value rows. `cls` picks the series colour; warn rows also change the text colour. */
  function barRows(rows, max) {
    max = max || Math.max.apply(null, rows.map(function (r) { return r.value; }).concat([1]));
    return el('div', { class: 'rows' }, rows.map(function (r) {
      var w = Math.max(r.value > 0 ? 1.5 : 0, Math.min(100, (r.value / max) * 100));
      return el('div', { class: 'row' + (r.warn ? ' warn' : '') }, [
        el('span', { class: 'lbl' }, r.label),
        sv('svg', { viewBox: '0 0 100 10', preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' }, [
          sv('rect', { class: 'track', x: 0, y: 0, width: 100, height: 10, rx: 2 }),
          sv('rect', { class: r.cls || 's1', x: 0, y: 0, width: w, height: 10, rx: 2 })
        ]),
        el('span', { class: 'val' }, r.text !== undefined ? r.text : fmt(r.value))
      ]);
    }));
  }

  /**
   * Column chart. points: [{label, values:[...], cls?}]. Stacked when there are several series. The SVG is a picture
   * (role=img + description); the same numbers are available in the table below it.
   */
  function columnChart(o) {
    var id = 'ch' + (++uid), n = o.points.length;
    var max = Math.max.apply(null, o.points.map(function (p) { return sum(p.values); }).concat([1]));
    var H = 56, bars = [];
    o.points.forEach(function (p, i) {
      var y = H;
      p.values.forEach(function (v, si) {
        if (!(v > 0)) return;
        var h = Math.max(2, (v / max) * H); y -= h;
        bars.push(sv('rect', { class: p.cls || o.classes[si] || 's1', x: i * 10 + 1.5, y: y, width: 7, height: h }, sv('title', null, p.label + ': ' + (p.text || p.values.join(' / ')))));
      });
    });
    var svg = sv('svg', { class: 'chart' + (o.short ? ' short' : ''), viewBox: '0 0 ' + Math.max(n, 1) * 10 + ' ' + (H + 2), preserveAspectRatio: 'none', role: 'img', 'aria-labelledby': id + 't ' + id + 'd' }, [
      sv('title', { id: id + 't' }, o.title), sv('desc', { id: id + 'd' }, o.desc),
      sv('line', { class: 'axis', x1: 0, y1: H + 1, x2: n * 10, y2: H + 1 })
    ].concat(bars));
    return el('div', null, [
      svg,
      el('div', { class: 'axis-labels', 'aria-hidden': 'true' }, [el('span', null, o.points[0].label), el('span', null, o.points[n - 1].label)]),
      o.legend ? el('div', { class: 'legend' }, o.legend.map(function (l) { return el('span', null, [el('i', { class: l[0] }), l[1]]); })) : null,
      el('details', null, [el('summary', null, 'Show chart data as a table'), table(o.title, o.columns, o.points.map(function (p) { return [p.label].concat(o.rowOf ? o.rowOf(p) : p.values); }), o.columns.map(function (_, i) { return i; }).slice(1))])
    ]);
  }

  /** Contribution-style strip for the last 15 weeks, Sunday-first rows. Dates are UTC day strings, matching metrics. */
  function heatStrip(daily, activeDays) {
    var WEEKS = 15, C = 12, byDay = {};
    daily.forEach(function (d) { byDay[d.date] = (d.commands || 0) + (d.prompts || 0); });
    activeDays.forEach(function (d) { if (!(d in byDay)) byDay[d] = 1; });
    var today = new Date(); today = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    var start = today - ((WEEKS - 1) * 7 + new Date(today).getUTCDay()) * 86400000;
    var maxv = Math.max.apply(null, Object.keys(byDay).map(function (k) { return byDay[k]; }).concat([1]));
    var cells = [], active = 0, id = 'ch' + (++uid);
    for (var i = 0; i < WEEKS * 7; i++) {
      var t = start + i * 86400000; if (t > today) break;
      var key = new Date(t).toISOString().slice(0, 10), v = byDay[key] || 0;
      if (v) active++;
      var lvl = !v ? 0 : Math.min(4, 1 + Math.floor((v / maxv) * 3.999));
      cells.push(sv('rect', { class: 'l' + lvl, x: Math.floor(i / 7) * C, y: (i % 7) * C, width: C - 2, height: C - 2, rx: 2 }, sv('title', null, key + ': ' + (v ? v + ' actions' : 'no activity'))));
    }
    return el('div', null, [
      sv('svg', { class: 'heat', viewBox: '0 0 ' + WEEKS * C + ' ' + 7 * C, role: 'img', 'aria-labelledby': id + 't' }, [sv('title', { id: id + 't' }, 'Activity over the last ' + WEEKS + ' weeks: ' + active + ' active days. Darker squares are busier days.')].concat(cells)),
      el('p', { class: 'note' }, 'Last ' + WEEKS + ' weeks, one square per day (columns are weeks). Darker means more actions. ' + active + ' active day' + (active === 1 ? '' : 's') + ' in this window.')
    ]);
  }

  // ---- sections --------------------------------------------------------------------------------------------------------
  function buildBanner(s) {
    var b = s.build, th = get(s, 'config', 'coverageThreshold');
    if (!b || !b.builtAt) {
      return el('section', { class: 'card build unknown', id: 'build', 'aria-labelledby': 'build-h' }, [
        el('h2', { id: 'build-h' }, 'Graph: not built yet'),
        empty('No graph build record found. Run "devsarathi graph build" in the repo (terminal or chat); this page never runs commands.')
      ]);
    }
    var failed = b.status === 'failed', nonBase = b.baseline === false, unknown = b.baseline === null;
    var cls = 'card build' + (failed ? ' failed' : nonBase ? ' nonbaseline' : unknown ? ' unknown' : '');
    var label = failed ? badge('danger', 'Build FAILED') : nonBase ? badge('warn', 'NOT BASELINE: working-branch graph') : unknown ? badge('mute', 'Baseline status unknown') : badge('ok', 'Baseline graph');
    var baseName = get(s, 'config', 'baselineBranch');
    return el('section', { class: cls, id: 'build', 'aria-labelledby': 'build-h' }, [
      el('div', { class: 'chips' }, [label, b.full === true ? badge('mute', 'full build') : b.full === false ? badge('mute', 'incremental') : null, b.belowThreshold ? badge('warn', 'coverage below ' + pct(th)) : null]),
      el('h2', { id: 'build-h' }, ['Latest graph build ', timeEl(b.builtAt)]),
      el('dl', { class: 'facts' }, [
        el('div', null, [el('dt', null, 'Branch'), el('dd', { class: 'mono', id: 'build-branch' }, b.branch || 'unknown')]),
        el('div', null, [el('dt', null, 'Commit'), el('dd', { class: 'mono', id: 'build-commit', title: b.commit || '' }, b.commit ? b.commit.slice(0, 10) : 'unknown')]),
        el('div', null, [el('dt', null, 'Baseline branch'), el('dd', { class: 'mono' }, baseName || 'unknown')]),
        el('div', null, [el('dt', null, 'Duration'), el('dd', null, dur(b.durationMs))])
      ]),
      nonBase ? el('p', { class: 'warnline', id: 'build-warning' }, 'This graph was built from "' + (b.branch || 'another branch') + '", not the baseline' + (baseName ? ' ("' + baseName + '")' : '') + '. Treat what it shows as your working branch only.') : null,
      failed ? el('p', { class: 'warnline' }, 'The last build failed' + (b.error ? ': ' + b.error : '') + '. The previous graph, if any, is still in use.') : null
    ]);
  }

  function graphSection(s) {
    var g = s.graph, b = s.build, cov = get(b, 'coverage'), th = get(s, 'config', 'coverageThreshold'), m = s.metrics;
    var kids = [];
    if (!g && !cov) return card('graph', 'Graph summary', null, [empty('No graph summary yet. It appears after the first successful graph build.')]);
    var mods = g ? g.modules.length : null;
    kids.push(el('div', { class: 'tiles' }, [
      tile('Modules', mods === null ? '—' : mods >= 40 ? '40+' : String(mods), mods >= 40 ? 'largest 40 shown' : null),
      tile('Files', fmt(g ? g.files : get(cov, 'eligibleFiles'))),
      tile('Symbols', fmt(g ? g.symbols : get(cov, 'symbols'))),
      tile('Coverage', pct(get(cov, 'ratio')), isNum(th) ? 'threshold ' + pct(th) : null, get(b, 'belowThreshold') === true)
    ]));
    if (isNum(get(cov, 'ratio'))) {
      kids.push(el('h3', null, 'Parsed coverage vs threshold'));
      kids.push(barRows([{ label: 'Parsed files', value: cov.ratio * 100, text: pct(cov.ratio) + (isNum(cov.parsedFiles) ? ' (' + fmt(cov.parsedFiles) + ' of ' + fmt(cov.eligibleFiles) + ')' : ''), cls: cov.ratio < (th || 0) ? 'swarn' : 's2' }], 100));
    }
    if (b && state.id) {
      // The 3D view is its own page; its asset tags cannot send a header, so the link carries this session's token.
      kids.push(el('p', { class: 'graph-link' }, el('a', { class: 'btn', href: '/graph/?token=' + encodeURIComponent(token) + '#r=' + encodeURIComponent(state.id), target: '_blank', rel: 'noopener' }, 'Open the 3D graph')));
    }
    var grid = [];
    if (g && Object.keys(g.languages).length) {
      var langs = Object.keys(g.languages).map(function (k) { return { label: k, value: g.languages[k] }; }).sort(function (a, b) { return b.value - a.value; }).slice(0, 8);
      grid.push(el('div', null, [el('h3', null, 'Languages (files by extension)'), barRows(langs)]));
    }
    if (g && g.modules.length) {
      var top = g.modules.slice().sort(function (a, b) { return b.symbols - a.symbols; });
      grid.push(el('div', null, [el('h3', null, 'Largest modules'), table('Modules by symbol count', ['Module', 'Files', 'Symbols'], top.slice(0, 8).map(function (x) { return [el('span', { class: 'mono' }, x.name), fmt(x.files), fmt(x.symbols)]; }), [1, 2])]));
    }
    if (grid.length) kids.push(el('div', { class: 'grid' }, grid));
    var mg = get(m, 'graph');
    if (mg && mg.builds > 0) {
      kids.push(el('h3', null, 'Build history'));
      kids.push(el('div', { class: 'tiles' }, [
        tile('Builds', fmt(mg.builds)), tile('Failed builds', fmt(mg.failures), null, mg.failures > 0),
        tile('Average duration', dur(mg.avgDurationMs)), tile('Below threshold', fmt(mg.belowThreshold), null, mg.belowThreshold > 0)
      ]));
      var hist = (mg.history || []).slice(-40);
      if (hist.length) kids.push(columnChart({
        title: 'Coverage per graph build', desc: 'One column per build, height is parsed-file coverage. Failed builds are shown as warning-coloured stubs.', short: true,
        classes: ['s2'], legend: [['s2', 'Completed build (taller = higher coverage)'], ['swarn', 'Failed build']], columns: ['Built', 'Status', 'Coverage', 'Duration'],
        points: hist.map(function (h) { var ok = h.status === 'completed'; return { label: (abs(h.at) || h.at), values: [ok && isNum(h.coverage) ? h.coverage : 0.08], cls: ok ? 's2' : 'swarn', text: ok ? pct(h.coverage) : 'failed', st: h.status, cov: h.coverage, ms: h.durationMs }; }),
        rowOf: function (p) { return [p.st, pct(p.cov), dur(p.ms)]; }
      }));
    }
    return card('graph', 'Graph summary', 'what the knowledge graph covers', kids);
  }

  function efficiencySection(s) {
    var m = s.metrics; if (!m) return card('efficiency', 'Efficiency: turns per task', null, [empty('No metrics yet. They appear after you use DevSarathi for a while.')]);
    var t = m.turnsPerTask || {}, p = m.prompts || {};
    var base = t.baseline || {}, enh = t.withEnhancer || {};
    var haveBase = isNum(base.avgTurns), haveEnh = isNum(enh.avgTurns);
    var max = Math.max(base.avgTurns || 0, enh.avgTurns || 0, 1);
    function cmpRow(label, row, cls) {
      var ok = isNum(row.avgTurns);
      return el('div', null, [
        el('div', { class: 'name' }, [el('span', null, label), el('b', null, ok ? row.avgTurns + ' turns per task (n = ' + fmt(row.tasks) + ' tasks' + (row.tasks < 5 ? ', small sample' : '') + ')' : 'no data yet (n = ' + fmt(row.tasks || 0) + ')')]),
        sv('svg', { viewBox: '0 0 100 10', preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' }, [sv('rect', { class: 'track', x: 0, y: 0, width: 100, height: 10, rx: 2 }), ok ? sv('rect', { class: cls, x: 0, y: 0, width: Math.max(1, (row.avgTurns / max) * 100), height: 10, rx: 2 }) : null])
      ]);
    }
    var verdict = null;
    if (isNum(t.improvement) && haveBase && haveEnh) {
      var better = t.improvement >= 0;
      verdict = el('p', { class: 'verdict ' + (better ? 'good' : 'bad'), id: 'turns-verdict' }, Math.abs(Math.round(t.improvement * 100)) + '% ' + (better ? 'fewer' : 'MORE') + ' turns per task with the enhancer than at baseline');
    } else verdict = el('p', { class: 'note' }, 'No before/after comparison yet: it needs tasks in both groups.');
    var turns = el('div', null, [
      el('h3', null, 'Turns per task: before vs after'),
      el('div', { class: 'compare', id: 'turns-compare' }, [cmpRow('Before (first ' + (get(m, 'baselineWindow', 'days') || 7) + ' days, enhancer optional)', base, 'sbase'), cmpRow('After (tasks that used the enhancer)', enh, 's2')]),
      verdict,
      el('p', { class: 'note' }, t.note || ''),
      t.definition ? el('details', null, [el('summary', null, 'How a turn and a task are counted'), el('p', { class: 'note' }, t.definition)]) : null
    ]);
    var decided = (p.accepted || 0) + (p.edited || 0) + (p.rejected || 0);
    var acc = el('div', null, [
      el('h3', null, 'Acceptance rate (shown with turns, never alone)'),
      decided ? el('div', null, [
        el('p', { class: 'verdict', id: 'acceptance' }, pct(p.acceptanceRate) + ' accepted as-is'),
        barRows([{ label: 'Accepted', value: p.accepted || 0, cls: 'sok' }, { label: 'Edited', value: p.edited || 0, cls: 's1' }, { label: 'Rejected', value: p.rejected || 0, cls: 'swarn' }]),
        el('p', { class: 'note' }, 'Out of ' + fmt(decided) + ' decided prompts. Acceptance alone can be inflated, so compare it with turns per task.')
      ]) : empty('No accept, edit or reject decisions recorded yet.'),
      el('p', { class: 'note' }, fmt(p.enhanced) + ' prompts enhanced' + (p.needsConfirmation ? ', ' + fmt(p.needsConfirmation) + ' needed confirmation' : '') + '.')
    ]);
    var kids = [el('div', { class: 'grid' }, [turns, acc])];
    var hist = (t.history || []).slice(-40);
    if (hist.length) {
      var names = { baseline: 'Baseline', enhancer: 'With enhancer', other: 'Other' }, cl = { baseline: 'sbase', enhancer: 's2', other: 's1' };
      kids.push(el('h3', null, 'Recent tasks (turns per task, oldest to newest)'));
      kids.push(columnChart({
        title: 'Turns per task, latest ' + hist.length + ' tasks', desc: 'One column per task; height is the number of turns. Colour shows baseline, enhancer or other.', short: true,
        classes: ['s1'], legend: [['sbase', 'Baseline'], ['s2', 'With enhancer'], ['s1', 'Other']], columns: ['Started', 'Turns', 'Group'],
        points: hist.map(function (h) { return { label: abs(h.at) || h.at, values: [h.turns], cls: cl[h.phase] || 's1', text: h.turns + ' turns (' + (names[h.phase] || h.phase) + ')', ph: names[h.phase] || h.phase }; }),
        rowOf: function (p) { return [p.values[0], p.ph]; }
      }));
    }
    return card('efficiency', 'Efficiency: turns per task', 'the strongest proof metric', kids);
  }

  function usageSection(s) {
    var u = get(s, 'metrics', 'usage');
    if (!u) return card('usage', 'Consistency of use', null, [empty('No usage data yet.')]);
    var daily = Array.isArray(u.daily) ? u.daily : [], days = Array.isArray(u.days) ? u.days : [];
    var kids = [el('div', { class: 'tiles' }, [tile('Active days', fmt(u.activeDays), 'days with a manual action'), tile('First activity', s.metrics.since ? (abs(s.metrics.since) || '—') : '—')])];
    if (!daily.length && !days.length) { kids.push(empty('No active days recorded yet.')); return card('usage', 'Consistency of use', null, kids); }
    var grid = [el('div', null, [el('h3', null, 'Activity calendar'), heatStrip(daily, days)])];
    // Fill the gaps between the first and last active day so a pause shows as an empty column, not as nothing.
    var shown = daily.slice(-60), pts = [];
    if (shown.length) {
      var byDate = {}; shown.forEach(function (d) { byDate[d.date] = d; });
      var t0 = Date.parse(shown[0].date), t1 = Date.parse(shown[shown.length - 1].date);
      for (var t = t0; t <= t1 && pts.length < 120; t += 86400000) { var k = new Date(t).toISOString().slice(0, 10), d = byDate[k] || { commands: 0, prompts: 0 }; pts.push({ label: k, values: [d.commands || 0, d.prompts || 0] }); }
      grid.push(el('div', null, [el('h3', null, 'Daily activity'), columnChart({
        title: 'Daily activity', desc: 'One column per day, stacked commands and prompts.', classes: ['s1', 's2'], legend: [['s1', 'Commands'], ['s2', 'Prompts']],
        columns: ['Day', 'Commands', 'Prompts'], points: pts
      })]));
    }
    kids.push(el('div', { class: 'grid' }, grid));
    var cmds = Object.keys(u.commands || {}).map(function (k) { return { label: k, value: u.commands[k] }; }).sort(function (a, b) { return b.value - a.value; }).slice(0, 8);
    if (cmds.length) { kids.push(el('h3', null, 'Tool usage by command')); kids.push(barRows(cmds)); }
    return card('usage', 'Consistency of use', 'how regularly it is used', kids);
  }

  var SEV = ['critical', 'high', 'medium', 'low', 'info'];
  function verdictBadge(v) {
    return v === 'clean' ? badge('ok', 'Clean') : v === 'findings' ? badge('info', 'Findings') : v === 'incomplete' ? badge('warn', 'INCOMPLETE: not a pass') : badge('mute', 'Unknown');
  }
  function runBadge(r) {
    var bad = r.status === 'failed' || r.status === 'timeout';
    return badge(bad ? 'warn' : r.status === 'completed' ? 'ok' : 'mute', (bad ? '⚠ ' : '') + r.agent + ': ' + (r.status === 'timeout' ? 'TIMED OUT' : r.status === 'failed' ? 'FAILED' : r.status));
  }
  function reviewSection(s) {
    var r = get(s, 'metrics', 'review'), list = s.reviews, a = s.audit, kids = [];
    if ((!r || !r.runs) && !list) return card('reviews', 'Review outcomes', null, [empty('No reviews yet. Run a review from the terminal, chat or the extension.')]);
    if (r && r.runs) {
      var total = sum(r.findingsBySeverity);
      kids.push(el('div', { class: 'tiles' }, [
        tile('Reviews run', fmt(r.runs)), tile('Findings raised', fmt(total)),
        tile('Findings acted on', fmt(r.findingsActedOn), total ? 'of ' + fmt(total) + ' raised' : null),
        tile('Red flags at push', fmt(r.redFlagsAtPush), 'across ' + fmt(r.pushReviews) + ' push review' + (r.pushReviews === 1 ? '' : 's'), r.redFlagsAtPush > 0)
      ]));
      var vs = Object.keys(r.byVerdict || {});
      if (vs.length) kids.push(el('div', { class: 'chips', id: 'verdicts' }, vs.map(function (v) { return el('span', null, [verdictBadge(v), ' ' + r.byVerdict[v]]); })));
      var g = [];
      if (total) g.push(el('div', null, [el('h3', null, 'Findings by severity'), barRows(SEV.concat(Object.keys(r.findingsBySeverity).filter(function (k) { return SEV.indexOf(k) < 0; })).filter(function (k) { return k in r.findingsBySeverity; }).map(function (k) { return { label: k, value: r.findingsBySeverity[k], cls: 's-' + k }; }))]));
      var ag = Object.keys(r.findingsByAgent || {}).filter(function (k) { return r.findingsByAgent[k] > 0; });
      if (ag.length) g.push(el('div', null, [el('h3', null, 'Findings by agent'), barRows(ag.map(function (k) { return { label: k, value: r.findingsByAgent[k], cls: 's2' }; }))]));
      if (g.length) kids.push(el('div', { class: 'grid' }, g));
      else kids.push(empty('Reviews ran but raised no findings.'));
    }
    if (list && list.length) {
      kids.push(el('h3', null, 'Recent reviews (latest ' + list.length + ')'));
      kids.push(table('Recent reviews', ['When', 'Branch', 'Range', 'Verdict', 'Findings', 'Agent runs'], list.map(function (x) {
        var fc = sum(x.findingsBySeverity), parts = SEV.filter(function (k) { return x.findingsBySeverity[k]; }).map(function (k) { return x.findingsBySeverity[k] + ' ' + k; });
        return [x.createdAt ? timeEl(x.createdAt) : '—', el('span', { class: 'mono' }, x.branch || '—'), el('span', { class: 'mono' }, x.range || '—'), verdictBadge(x.verdict),
          fc ? fc + ' (' + parts.join(', ') + ')' + (x.redFlags ? ', ' + x.redFlags + ' red flag' + (x.redFlags === 1 ? '' : 's') : '') : 'none',
          el('span', { class: 'runs' }, (x.runs || []).map(runBadge))];
      })));
    }
    if (a) kids.push(el('p', { class: 'note', id: 'audit' }, ['Workspace audit: ', a.status === 'pass' ? badge('ok', 'pass') : a.status === 'fix' ? badge('warn', 'needs fixes') : badge('mute', 'unknown'), ' ' + fmt(a.findings) + ' finding' + (a.findings === 1 ? '' : 's') + ', checked ' + fmt(a.checked.files) + ' files and ' + fmt(a.checked.rules) + ' rules, ', a.at ? timeEl(a.at) : null]));
    return card('reviews', 'Review outcomes', 'verdicts, findings and red flags', kids);
  }

  function agentsSection(s) {
    var ag = get(s, 'metrics', 'agents'), names = ag ? Object.keys(ag) : [];
    if (!names.length) return card('agents', 'Agent run outcomes', null, [empty('No agent runs recorded yet.')]);
    var anyBad = names.some(function (k) { return ag[k].failed || ag[k].timeout; });
    return card('agents', 'Agent run outcomes', 'a run that did not finish is never a pass', [
      anyBad ? el('p', null, badge('warn', '⚠ Some agent runs failed or timed out. Those reviews are incomplete.')) : null,
      table('Agent runs by outcome', ['Agent', 'Completed', 'Failed', 'Timed out', 'Skipped'], names.map(function (k) {
        var a = ag[k]; return [k, fmt(a.completed), a.failed ? { warn: true, text: '⚠ ' + a.failed } : fmt(a.failed), a.timeout ? { warn: true, text: '⚠ ' + a.timeout } : fmt(a.timeout), fmt(a.skipped)];
      }), [1, 2, 3, 4])
    ]);
  }

  function riskBadge(r) { return badge(r === 'high' ? 'danger' : r === 'medium' ? 'warn' : r === 'low' ? 'ok' : 'mute', (r || '?') + ' risk'); }
  function rulesSection(s) {
    var r = get(s, 'metrics', 'rules'), c = s.changelog, pend = s.pendingRules, kids = [];
    if (!r && !c && pend === null) return card('rules', 'Rule change history', null, [empty('No rule changes recorded yet.')]);
    kids.push(el('div', { class: 'tiles' }, [
      r ? tile('Auto-applied', fmt(r.autoApplied)) : null, r ? tile('Approved', fmt(r.approved)) : null, r ? tile('Rejected', fmt(r.rejected)) : null,
      tile('Pending approval', pend === null ? '—' : fmt(pend), pend === null ? 'unknown' : null, pend > 0)
    ]));
    if (c && c.entries.length) {
      kids.push(el('h3', null, 'Changelog (latest ' + c.entries.length + ' of ' + c.total + ')'));
      kids.push(el('ul', { class: 'list', id: 'changelog' }, c.entries.map(function (e) {
        return el('li', null, [el('div', { class: 'meta' }, [riskBadge(e.risk), badge(e.how === 'rejected' ? 'mute' : 'info', e.how), el('span', null, e.op + ' in '), el('span', { class: 'mono' }, e.file), timeEl(e.at)]), el('div', null, e.reason)]);
      })));
    } else kids.push(empty('No rule changes in the changelog yet.'));
    return card('rules', 'Rule change history', 'auto-applied, approved and rejected', kids);
  }

  function selftestSection(s) {
    var st = get(s, 'metrics', 'selftest');
    if (!st || !st.runs || !st.runs.length) return card('selftest', 'Self-test history', null, [empty('No self-test runs yet.')]);
    var runs = st.runs.slice(-12);
    return card('selftest', 'Self-test history', 'pass or fail over time', [
      el('p', null, ['Latest: ', st.lastPassed ? badge('ok', '✓ passed') : badge('warn', '✗ FAILED')]),
      el('div', { class: 'sparkset', id: 'selftest-runs' }, runs.map(function (r) {
        var ok = r.passed === r.total && r.total > 0;
        return badge(ok ? 'ok' : 'warn', (ok ? '✓ ' : '✗ ') + r.passed + '/' + r.total + ' · ' + (abs(r.at) || r.at));
      })),
      runs.some(function (r) { return r.failed && r.failed.length; }) ? el('details', null, [el('summary', null, 'Failed checks'), table('Failed checks per run', ['When', 'Checks'], runs.filter(function (r) { return r.failed && r.failed.length; }).map(function (r) { return [abs(r.at) || r.at, r.failed.join(', ')]; }))]) : null
    ]);
  }

  function noticesSection(s) {
    var n = s.notices, f = s.lastBuildFailure, out = [];
    if (f) out.push(el('section', { class: 'alert', id: 'failure', 'aria-labelledby': 'failure-h' }, [
      el('h2', { id: 'failure-h' }, 'Last graph build failure'),
      el('p', null, [f.at ? timeEl(f.at) : null, f.branch ? ' on ' : null, f.branch ? el('span', { class: 'mono' }, f.branch) : null]),
      el('p', null, f.error || 'No error message was recorded.'),
      el('p', { class: 'note' }, 'The previous graph stays in use. Re-run "devsarathi graph build" in a terminal.')
    ]));
    out.push(card('notices', 'Recent notices', 'newest first', n && n.length ? [el('ul', { class: 'list' }, n.map(function (x) {
      return el('li', null, [el('div', { class: 'meta' }, [badge('mute', x.source || 'devsarathi'), x.at ? timeEl(x.at) : null]), el('div', null, x.message || '')]);
    }))] : [empty('No notices. Nothing has needed your attention.')]));
    return out;
  }

  function headerCard(s) {
    var c = s.config, m = s.metrics;
    return el('section', { class: 'card', id: 'repo', 'aria-labelledby': 'repo-h' }, [
      el('header', null, [el('h1', { id: 'repo-h' }, s.name), el('span', { class: 'sub' }, 'folder: ' + s.dir)]),
      el('div', { class: 'chips' }, [
        c && c.stacks.length ? c.stacks.map(function (k) { return badge('info', k.id + (k.dir && k.dir !== '.' ? ' (' + k.dir + ')' : '')); }) : null,
        c && c.persona && c.persona.name ? badge('mute', 'persona: ' + c.persona.name) : null,
        c && c.disabled ? badge('warn', 'DevSarathi is disabled here') : null,
        c && c.initializedAt ? badge('mute', 'initialised ' + (abs(c.initializedAt) || c.initializedAt)) : null,
        m && m.generatedAt ? badge('mute', 'metrics updated ' + (rel(m.generatedAt) || '?')) : null
      ].reduce(function (a, x) { return a.concat(x || []); }, []))
    ]);
  }

  // ---- load / render -----------------------------------------------------------------------------------------------------
  function api(path) {
    return fetch(path, { headers: { 'x-ds-token': token }, cache: 'no-store' }).then(function (r) {
      if (r.status === 401) throw new Error('This page has no valid session token. Open the link printed by "devsarathi dashboard" again.');
      if (!r.ok) throw new Error('The dashboard server answered ' + r.status + '.');
      return r.json();
    });
  }
  function show(nodes) { app.replaceChildren.apply(app, nodes); app.setAttribute('aria-busy', 'false'); }
  function message(text) { show([el('div', { class: 'alert' }, [el('h2', null, 'Dashboard unavailable'), el('p', null, text)])]); }

  function render(s) {
    if (s.health === 'missing') return show([headerCard(s), empty('This folder no longer exists on disk. Remove it from the registry or restore it.')]);
    if (s.health === 'uninitialized') return show([headerCard(s), empty('DevSarathi is not initialised in this repo. Run "devsarathi init" in a terminal, then Refresh.')]);
    var nodes = [buildBanner(s), headerCard(s), graphSection(s), efficiencySection(s), usageSection(s), reviewSection(s), agentsSection(s), rulesSection(s), selftestSection(s)].concat(noticesSection(s));
    show(nodes);
  }

  function loadRepo(id) {
    state.id = id; app.setAttribute('aria-busy', 'true');
    return api('/api/repos/' + encodeURIComponent(id)).then(render).catch(function (e) { message(e.message); });
  }

  function init() {
    return api('/api/repos').then(function (r) {
      state.repos = r.repos || [];
      var sel = document.getElementById('repo-select'), wrap = document.getElementById('repo-wrap');
      sel.replaceChildren.apply(sel, state.repos.map(function (x) { return el('option', { value: x.id }, x.name + (x.health !== 'ok' ? ' (' + x.health + ')' : '')); }));
      wrap.hidden = state.repos.length < 2;
      if (!state.repos.length) return show([empty('No repositories are registered yet. Run "devsarathi init" inside a repo, then reload this page.')]);
      var first = state.repos.filter(function (x) { return x.focus; })[0] || state.repos[0];
      sel.value = first.id;
      return loadRepo(first.id);
    }).catch(function (e) { message(e.message); });
  }

  document.getElementById('repo-select').addEventListener('change', function (e) { loadRepo(e.target.value); });
  document.getElementById('refresh').addEventListener('click', function () { if (state.id) loadRepo(state.id); else init(); });

  // Theme: follows the OS until the toggle is used; the choice is remembered when storage is available.
  var themeBtn = document.getElementById('theme'), root = document.documentElement;
  function effective() { var t = root.getAttribute('data-theme'); return t || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
  function paintToggle() { var dark = effective() === 'dark'; themeBtn.textContent = dark ? 'Light mode' : 'Dark mode'; themeBtn.setAttribute('aria-pressed', String(dark)); }
  try { var saved = localStorage.getItem('ds-theme'); if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved); } catch (e) { /* storage blocked in some webviews */ }
  themeBtn.addEventListener('click', function () {
    var next = effective() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('ds-theme', next); } catch (e) { /* ignore */ }
    paintToggle();
  });
  paintToggle();

  init();
})();
