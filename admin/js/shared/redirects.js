// Redirect engine shared by the edge Worker (live redirects) and the admin UI
// (tester, diagnostics, CSV import preview). One implementation = the tester
// predicts exactly what the live site does.

export const CODES = [301, 302, 303, 307, 308];
export const MATCH_TYPES = ['exact', 'wildcard', 'regex'];
export const QUERY_MODES = ['exact', 'ignore', 'pass'];
export const SITE_HOSTS = ['nikolaseo.com', 'www.nikolaseo.com'];
export const RESERVED_PREFIXES = ['/admin/', '/cms-api/'];
export const DEFAULTS = { code: 301, match: 'exact', query: 'pass', ignore_case: true, ignore_slash: true, active: true };

const bool = v => v === true || v === 1 || v === '1';

function safeDecode(value) {
  try { return decodeURI(value); } catch { return value; }
}

/** Normalise a URL path for comparison according to rule flags. */
export function normPath(path, { ignore_case, ignore_slash } = {}) {
  let p = safeDecode(path || '/');
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/{2,}/g, '/');
  if (bool(ignore_slash) && p.length > 1) p = p.replace(/\/+$/, '');
  if (bool(ignore_case)) p = p.toLowerCase();
  return p;
}

function sortedQuery(search) {
  const params = new URLSearchParams(search || '');
  return [...params.entries()].sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1])).map(([k, v]) => `${k}=${v}`).join('&');
}

/** Split a rule source into path + query. Accepts absolute URLs on the site's own hosts. */
export function splitSource(source) {
  let s = String(source || '').trim();
  const m = s.match(/^https?:\/\/([^/?#]+)(.*)$/i);
  if (m) s = m[2] || '/';
  const hashless = s.split('#')[0];
  const q = hashless.indexOf('?');
  return q === -1 ? { path: hashless, query: '' } : { path: hashless.slice(0, q), query: hashless.slice(q + 1) };
}

export function coerceRule(input = {}) {
  const r = { ...DEFAULTS, ...input };
  r.source = String(r.source ?? '').trim();
  r.target = String(r.target ?? '').trim();
  r.code = Number(r.code);
  r.match = String(r.match || DEFAULTS.match).toLowerCase();
  r.query = String(r.query || DEFAULTS.query).toLowerCase();
  r.ignore_case = bool(r.ignore_case) || r.ignore_case === 'true';
  r.ignore_slash = bool(r.ignore_slash) || r.ignore_slash === 'true';
  r.active = !(r.active === false || r.active === 0 || r.active === '0' || r.active === 'false');
  r.position = Number.isFinite(Number(r.position)) ? Number(r.position) : 0;
  r.notes = String(r.notes ?? '').slice(0, 500);
  return r;
}

/** Per-rule validation. Returns { errors, warnings }. */
export function validateRule(input) {
  const r = coerceRule(input);
  const errors = [];
  const warnings = [];
  if (!r.source) errors.push('Source URL is required.');
  if (!r.target) errors.push('Target URL is required.');
  if (!CODES.includes(r.code)) errors.push(`Redirect type must be one of ${CODES.join(', ')}.`);
  if (!MATCH_TYPES.includes(r.match)) errors.push(`Match type must be one of ${MATCH_TYPES.join(', ')}.`);
  if (!QUERY_MODES.includes(r.query)) errors.push(`Query handling must be one of ${QUERY_MODES.join(', ')}.`);
  if (r.source.length > 2000 || r.target.length > 2000) errors.push('URLs must be under 2,000 characters.');

  if (r.source) {
    const absolute = r.source.match(/^https?:\/\/([^/?#]+)/i);
    if (absolute && !SITE_HOSTS.includes(absolute[1].toLowerCase())) errors.push(`Source must be on ${SITE_HOSTS[0]}; external sources cannot be redirected by this site.`);
    if (r.match !== 'regex') {
      const { path } = splitSource(r.source);
      if (!path.startsWith('/')) errors.push('Source must start with "/" (or be a full https://nikolaseo.com/… URL).');
      if (/\s/.test(r.source)) errors.push('Source contains spaces. Encode them as %20.');
      if (r.source.includes('#')) errors.push('Source must not contain a #fragment; browsers never send fragments to the server.');
      if (r.match === 'wildcard' && !path.includes('*')) errors.push('Wildcard sources need at least one "*".');
      if (r.match === 'exact' && path.includes('*')) warnings.push('Source contains "*" but match type is exact. Did you mean wildcard?');
      const np = normPath(path, { ignore_case: true });
      if (RESERVED_PREFIXES.some(prefix => np === prefix.slice(0, -1) || np.startsWith(prefix))) errors.push('Source cannot be inside /admin/ or /cms-api/ (reserved for the CMS).');
    } else {
      try {
        new RegExp(r.source);
        if (/(\([^)]*[+*][^)]*\))[+*{]/.test(r.source)) warnings.push('Nested quantifiers can make a regex very slow. Simplify it if possible.');
        if (!r.source.startsWith('^')) warnings.push('Regex is not anchored with "^"; it can match anywhere in the path.');
      } catch (e) { errors.push(`Invalid regular expression: ${e.message}`); }
    }
  }
  if (r.target) {
    if (/^\s*(javascript|data|vbscript):/i.test(r.target)) errors.push('Target must be an http(s) URL or a path.');
    else if (/^https?:\/\//i.test(r.target)) {
      try { new URL(r.target.replace(/\$\d|\*/g, 'x')); } catch { errors.push('Target is not a valid URL.'); }
    } else if (!r.target.startsWith('/')) errors.push('Target must start with "/" or "https://".');
    if (/\s/.test(r.target)) errors.push('Target contains spaces. Encode them as %20.');
  }
  if (!errors.length && r.match === 'exact') {
    const src = splitSource(r.source);
    const tgt = targetLocation(r.target, 'https://nikolaseo.com');
    if (tgt && SITE_HOSTS.includes(tgt.hostname) && normPath(tgt.pathname, r) === normPath(src.path, r) && (r.query !== 'exact' || sortedQuery(tgt.search) === sortedQuery(src.query))) {
      errors.push('Source and target are the same URL (self-redirect).');
    }
  }
  return { errors, warnings, rule: r };
}

function targetLocation(target, origin) {
  try { return new URL(target, origin); } catch { return null; }
}

function wildcardToRegex(path, ignoreSlash) {
  const escaped = path.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('(.*)');
  return ignoreSlash ? `^${escaped.replace(/\/$/, '')}/?$` : `^${escaped}$`;
}

/** Compile active rules into a fast matcher. */
export function compile(rules, { trusted = false } = {}) {
  const exact = new Map(); // normalised path -> [rule]
  const patterns = [];
  const num = v => (typeof v === 'number' ? v : 0);
  const sorted = rules.map(coerceRule).filter(r => r.active).sort((a, b) => a.position - b.position || num(a.id) - num(b.id));
  for (const r of sorted) {
    if (!trusted && validateRule(r).errors.length) continue; // invalid rules never go live (DB rules are validated on write)
    if (r.match === 'exact') {
      const { path, query } = splitSource(r.source);
      const key = `${r.ignore_case ? 'i' : 'c'}${r.ignore_slash ? 's' : 'n'}|${normPath(path, r)}`;
      const entry = { rule: r, query: sortedQuery(query) };
      if (!exact.has(key)) exact.set(key, []);
      exact.get(key).push(entry);
    } else {
      let re;
      try {
        if (r.match === 'regex') re = new RegExp(r.source, r.ignore_case ? 'i' : '');
        else re = new RegExp(wildcardToRegex(splitSource(r.source).path, r.ignore_slash), r.ignore_case ? 'i' : '');
      } catch { continue; }
      patterns.push({ rule: r, re, usesQuery: r.match === 'regex' && /\\\?|\?=|\[\?\]/.test(r.source) });
    }
  }
  return { exact, patterns, count: sorted.length };
}

function appendQuery(location, search) {
  if (!search || search === '?') return location;
  const q = search.startsWith('?') ? search.slice(1) : search;
  const [base, hash] = location.split('#');
  return `${base}${base.includes('?') ? '&' : '?'}${q}${hash !== undefined ? `#${hash}` : ''}`;
}

/**
 * Match a request URL. Returns { rule, code, location } or null.
 * `location` is absolute. Self-redirects are suppressed at runtime as a loop guard.
 */
export function match(compiled, requestUrl) {
  const url = new URL(requestUrl);
  const candidates = [];
  for (const flags of ['is', 'in', 'cs', 'cn']) {
    const key = `${flags}|${normPath(url.pathname, { ignore_case: flags[0] === 'i', ignore_slash: flags[1] === 's' })}`;
    const list = compiled.exact.get(key);
    if (!list) continue;
    const reqQuery = sortedQuery(url.search);
    for (const entry of list) {
      if (entry.rule.query === 'exact' && entry.query !== reqQuery) continue;
      candidates.push({ rule: entry.rule, location: entry.rule.target, captured: false });
    }
  }
  const num = v => (typeof v === 'number' ? v : 0);
  const best = candidates.sort((a, b) => a.rule.position - b.rule.position || num(a.rule.id) - num(b.rule.id))[0];
  let hit = best || null;
  for (const p of compiled.patterns) {
    if (hit && p.rule.position >= hit.rule.position) break;
    const subject = p.usesQuery ? `${safeDecode(url.pathname)}${url.search}` : safeDecode(url.pathname);
    const m = subject.match(p.re);
    if (!m) continue;
    let location = p.rule.target;
    if (p.rule.match === 'wildcard') { let i = 1; location = location.replace(/\*/g, () => `$${i++}`); }
    location = location.replace(/\$(\d+)/g, (_, n) => (m[Number(n)] ?? ''));
    hit = { rule: p.rule, location, captured: true, usesQuery: p.usesQuery };
    break;
  }
  if (!hit) return null;
  let location = hit.location;
  if (hit.rule.query === 'pass' && !hit.usesQuery) location = appendQuery(location, url.search);
  const absolute = targetLocation(location, url.origin);
  if (!absolute || !/^https?:$/.test(absolute.protocol)) return null;
  const finalUrl = absolute.toString();
  if (finalUrl === url.toString()) return null; // never redirect to itself
  return { rule: hit.rule, code: hit.rule.code, location: finalUrl };
}

/** Follow redirects through the rule set (internal hosts only). */
export function trace(rules, startUrl, { maxHops = 10, compiled } = {}) {
  const c = compiled || compile(rules);
  const hops = [];
  const seen = new Set();
  let current;
  try { current = new URL(startUrl, 'https://nikolaseo.com').toString(); } catch { return { hops, final: startUrl, error: 'Invalid URL' }; }
  seen.add(current);
  for (let i = 0; i < maxHops; i++) {
    const u = new URL(current);
    if (!SITE_HOSTS.includes(u.hostname)) break;
    const m = match(c, current);
    if (!m) break;
    hops.push({ from: current, to: m.location, code: m.code, ruleId: m.rule.id ?? null, source: m.rule.source });
    if (seen.has(m.location)) return { hops, final: m.location, loop: true };
    seen.add(m.location);
    current = m.location;
  }
  return { hops, final: current, loop: false, tooLong: hops.length >= maxHops };
}

/**
 * Whole-set diagnostics: duplicates, conflicts, chains, loops, shadowing,
 * invalid rules, inactive rules and targets that are not known pages.
 * Returns Map(ruleKey -> [{ level: 'error'|'warning'|'info', type, message }]).
 */
export function diagnose(rules, { knownPaths = null } = {}) {
  const issues = new Map();
  const add = (r, level, type, message) => {
    const key = r.id ?? r._row;
    if (!issues.has(key)) issues.set(key, []);
    issues.get(key).push({ level, type, message });
  };
  const all = rules.map(r => ({ ...coerceRule(r), id: r.id, _row: r._row }));
  const active = all.filter(r => r.active);
  for (const r of all) {
    const v = validateRule(r);
    v.errors.forEach(e => add(r, 'error', e.includes('self-redirect') ? 'self' : 'invalid', e));
    v.warnings.forEach(w => add(r, 'warning', 'pattern', w));
    if (!r.active) add(r, 'info', 'inactive', 'Inactive: this rule is not live.');
  }
  // Duplicates / conflicts among same-source exact rules.
  const bySource = new Map();
  for (const r of all.filter(x => x.match !== 'regex')) {
    const { path, query } = splitSource(r.source);
    const key = `${r.match}|${normPath(path, { ignore_case: true, ignore_slash: true })}|${r.query === 'exact' ? sortedQuery(query) : '*'}`;
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(r);
  }
  for (const group of bySource.values()) {
    if (group.length < 2) continue;
    const targets = new Set(group.map(g => g.target));
    for (const r of group) {
      const others = group.filter(g => g !== r).map(g => g.id ?? `row ${g._row}`).join(', ');
      if (targets.size === 1) add(r, 'warning', 'duplicate', `Duplicate source (same as ${others}).`);
      else add(r, 'error', 'conflict', `Conflicting rule: same source redirects elsewhere in ${others}.`);
    }
  }
  const compiled = compile(active);
  for (const r of active) {
    if (validateRule(r).errors.length) continue;
    // Shadowing: a pattern rule with lower position catches this exact source first.
    if (r.match === 'exact') {
      const src = new URL(splitSource(r.source).path + (splitSource(r.source).query ? `?${splitSource(r.source).query}` : ''), 'https://nikolaseo.com');
      const winner = match(compiled, src.toString());
      if (winner && winner.rule !== undefined && (winner.rule.id ?? winner.rule._row) !== (r.id ?? r._row) && winner.rule.target !== r.target) {
        add(r, 'error', 'conflict', `Never reached: rule ${winner.rule.id ?? `row ${winner.rule._row}`} (${winner.rule.source}) matches this URL first.`);
      }
      if (knownPaths && (knownPaths.has(normPath(src.pathname)) || knownPaths.has(normPath(src.pathname, { ignore_slash: true })))) {
        add(r, 'warning', 'shadow', 'Source is a live page or file on the site; this redirect hides it.');
      }
      const t = trace(active, src.toString(), { compiled });
      if (t.loop) add(r, 'error', 'loop', `Redirect loop: ${t.hops.map(h => new URL(h.from).pathname).join(' → ')} → ${new URL(t.final).pathname}`);
      else if (t.hops.length > 1) add(r, 'warning', 'chain', `Redirect chain (${t.hops.length} hops). Point this rule straight to ${t.final}.`);
    }
    // Internal target checks.
    if (!/\$\d|\*/.test(r.target)) {
      const tgt = targetLocation(r.target, 'https://nikolaseo.com');
      if (tgt && SITE_HOSTS.includes(tgt.hostname) && knownPaths && !knownPaths.has(normPath(tgt.pathname, { ignore_slash: false }))) {
        const redirectedAway = match(compiled, tgt.toString());
        if (!redirectedAway) add(r, 'warning', 'target', `Target ${tgt.pathname} is not a known page on the site (may 404).`);
      }
    }
  }
  return issues;
}

/* ----------------------------------------------------------------- CSV ---- */

export const CSV_COLUMNS = ['source', 'target', 'code', 'match', 'query', 'ignore_case', 'ignore_trailing_slash', 'active', 'position', 'notes'];
export const CSV_EXPORT_EXTRA = ['hits', 'last_hit', 'id'];

export const CSV_HELP = [
  ['source', 'Required. Path on nikolaseo.com, e.g. /old-page/ or /old?id=5. Full https://nikolaseo.com/… URLs are accepted. For regex: a JavaScript regular expression matched against the path.'],
  ['target', 'Required. Path (/new-page/) or absolute URL (https://example.com/page). Use $1, $2 (regex) or * (wildcard) for captured parts.'],
  ['code', 'Optional. 301 (default), 302, 303, 307 or 308.'],
  ['match', 'Optional. exact (default), wildcard (use * in source) or regex. "regex: true" columns are also accepted.'],
  ['query', 'Optional. pass (default: match ignoring query, pass the visitor\'s query string on), ignore (match ignoring query, drop it), exact (query must match the source query, in any order).'],
  ['ignore_case', 'Optional. true (default) or false.'],
  ['ignore_trailing_slash', 'Optional. true (default) or false.'],
  ['active', 'Optional. true (default) or false.'],
  ['position', 'Optional. Lower numbers are checked first. Default 0.'],
  ['notes', 'Optional. Free text, up to 500 characters.']
];

const HEADER_ALIASES = {
  source: ['source', 'source url', 'source_url', 'from', 'old url', 'old_url', 'url', 'origin'],
  target: ['target', 'target url', 'target_url', 'to', 'destination', 'new url', 'new_url', 'redirect to'],
  code: ['code', 'redirect type', 'redirect_type', 'type', 'status', 'http code', 'status code', 'action_code'],
  match: ['match', 'match type', 'match_type'],
  regex: ['regex', 'is regex', 'is_regex'],
  query: ['query', 'query handling', 'query_handling', 'query string', 'query_string'],
  ignore_case: ['ignore_case', 'ignore case', 'case insensitive'],
  ignore_slash: ['ignore_trailing_slash', 'ignore trailing slash', 'ignore_slash'],
  active: ['active', 'enabled', 'status active', 'state'],
  position: ['position', 'priority', 'order'],
  notes: ['notes', 'note', 'title', 'comment']
};

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false, i = 0;
  const s = String(text).replace(/^﻿/, '');
  const delimiter = (() => {
    const first = s.split(/\r?\n/)[0] || '';
    const counts = [',', ';', '\t'].map(d => [d, first.split(d).length]);
    return counts.sort((a, b) => b[1] - a[1])[0][0];
  })();
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 2; continue; } inQuotes = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === delimiter) { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(cell => cell.trim() !== ''));
}

const truthy = v => /^(1|true|yes|y|on|active|enabled)$/i.test(String(v).trim());
const falsy = v => /^(0|false|no|n|off|inactive|disabled)$/i.test(String(v).trim());

/** Convert parsed CSV rows into rule objects with _row numbers and per-row parse errors. */
export function rowsToRules(rows) {
  if (!rows.length) return { rules: [], headerErrors: ['The file is empty.'] };
  const header = rows[0].map(h => h.trim().toLowerCase());
  const index = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const i = header.findIndex(h => aliases.includes(h));
    if (i !== -1) index[key] = i;
  }
  const headerErrors = [];
  let dataRows = rows.slice(1);
  let firstRow = 2;
  if (index.source === undefined || index.target === undefined) {
    // Headerless 2/3-column file: source,target[,code]
    if (rows[0].length >= 2 && /^(\/|https?:)/i.test(rows[0][0].trim())) {
      index.source = 0; index.target = 1; if (rows[0].length > 2) index.code = 2;
      dataRows = rows; firstRow = 1;
    } else headerErrors.push('Missing required columns. The first row must name a "source" and a "target" column.');
  }
  const rules = dataRows.map((cells, n) => {
    const get = key => (index[key] !== undefined ? String(cells[index[key]] ?? '').trim() : '');
    const parseErrors = [];
    const rule = { _row: n + firstRow, source: get('source'), target: get('target') };
    const code = get('code');
    if (code) { if (/^\d{3}$/.test(code)) rule.code = Number(code); else parseErrors.push(`Invalid redirect type "${code}".`); }
    const m = get('match').toLowerCase();
    if (m) rule.match = m;
    if (index.regex !== undefined && truthy(get('regex'))) rule.match = 'regex';
    const q = get('query').toLowerCase();
    if (q) rule.query = { preserve: 'pass', keep: 'pass', passthrough: 'pass', drop: 'ignore', strip: 'ignore', match: 'exact', exact: 'exact', ignore: 'ignore', pass: 'pass' }[q] || q;
    for (const [key, field] of [['ignore_case', 'ignore_case'], ['ignore_slash', 'ignore_slash'], ['active', 'active']]) {
      const v = get(key);
      if (!v) continue;
      if (truthy(v)) rule[field] = true; else if (falsy(v)) rule[field] = false; else parseErrors.push(`"${key}" must be true or false (got "${v}").`);
    }
    const pos = get('position');
    if (pos) { if (/^-?\d+$/.test(pos)) rule.position = Number(pos); else parseErrors.push(`"position" must be a whole number (got "${pos}").`); }
    const notes = get('notes'); if (notes) rule.notes = notes;
    rule._parseErrors = parseErrors;
    return rule;
  });
  return { rules, headerErrors };
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  // Prevent spreadsheet formula injection on export.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rules, { includeStats = true } = {}) {
  const cols = includeStats ? [...CSV_COLUMNS, ...CSV_EXPORT_EXTRA] : CSV_COLUMNS;
  const lines = [cols.join(',')];
  for (const raw of rules) {
    const r = coerceRule(raw);
    const values = {
      source: r.source, target: r.target, code: r.code, match: r.match, query: r.query,
      ignore_case: r.ignore_case, ignore_trailing_slash: r.ignore_slash, active: r.active, position: r.position, notes: r.notes,
      hits: raw.hits ?? 0, last_hit: raw.last_hit || '', id: raw.id ?? ''
    };
    lines.push(cols.map(c => csvCell(values[c])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function csvTemplate() {
  return toCsv([
    { source: '/old-page/', target: '/new-page/', code: 301, match: 'exact', query: 'pass', ignore_case: true, ignore_slash: true, active: true, position: 0, notes: 'Example: moved page' },
    { source: '/old-campaign?id=5', target: 'https://example.com/landing', code: 302, match: 'exact', query: 'exact', ignore_case: true, ignore_slash: true, active: true, position: 0, notes: 'Example: query-specific temporary redirect' },
    { source: '/blog/*', target: '/seo-studies/*', code: 301, match: 'wildcard', query: 'pass', ignore_case: true, ignore_slash: true, active: false, position: 10, notes: 'Example: wildcard (inactive)' },
    { source: '^/tools/([a-z-]+)\\.php$', target: '/$1.html', code: 308, match: 'regex', query: 'pass', ignore_case: true, ignore_slash: false, active: false, position: 20, notes: 'Example: regex (inactive)' }
  ], { includeStats: false });
}

/** Stable identity used to detect duplicates between an import and the existing database. */
export function sourceKey(r) {
  const c = coerceRule(r);
  if (c.match === 'regex') return `regex|${c.source}`;
  const { path, query } = splitSource(c.source);
  return `${c.match}|${normPath(path, { ignore_case: true, ignore_slash: true })}|${c.query === 'exact' ? sortedQuery(query) : '*'}`;
}
