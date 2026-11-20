// Redirect manager (Redirection-plugin parity): list, filters, bulk actions, editor
// with pre-save testing, diagnostics, CSV import wizard, export, backups, live verification.
import { can, esc, api, toast, toastError, modal, confirmDialog, fmtAgo, fmtDate, pageHeading, action, download, downloadFromApi, getLinkTargets, debounce } from './core.js';
import * as R from './shared/redirects.js';

const CODE_HELP = {
  301: '301 Moved Permanently — page moved for good (passes SEO signals).',
  302: '302 Found — temporary; the original URL stays indexed.',
  303: '303 See Other — after a form POST, send to a GET page.',
  307: '307 Temporary Redirect — temporary, keeps the request method (POST stays POST).',
  308: '308 Permanent Redirect — permanent, keeps the request method.'
};
const QUERY_HELP = {
  pass: 'Pass through: match ignoring the query string and add the visitor\'s query string to the target (keeps UTM tags).',
  ignore: 'Ignore: match ignoring the query string and drop it.',
  exact: 'Exact: the query string must match the source (any parameter order).'
};
const ISSUE_LABEL = { loop: 'Loop', chain: 'Chain', conflict: 'Conflict', duplicate: 'Duplicate', self: 'Self-redirect', invalid: 'Invalid', target: 'Unknown target', shadow: 'Hides a page', pattern: 'Pattern warning', inactive: 'Inactive' };

export async function renderRedirects(ws) {
  const manage = can('redirects.manage');
  const hp = new URLSearchParams(location.hash.split('?')[1] || '');
  const p = { q: '', status: '', code: '', match: '', issue: hp.get('issue') || '', sort: 'position', dir: 'asc', page: 1, per: 50 };
  const selected = new Set();
  let last = null;

  ws.innerHTML = `${pageHeading('URL MANAGEMENT', 'Redirects', 'Served by the edge Worker in front of the site with real HTTP status codes. Changes are live within ~15 seconds.',
    `${manage ? '<button class="button primary" id="addBtn">＋ Add redirect</button><button class="button secondary" id="importBtn">Import CSV</button>' : ''}
     <div class="menu-wrap"><button class="button secondary" id="exportBtn" aria-haspopup="true">Export ▾</button><div class="menu" id="exportMenu" hidden><button data-export="all">All redirects (CSV)</button><button data-export="filtered">Current filter (CSV)</button><button data-export="template">Blank template (CSV)</button></div></div>
     ${manage ? '<button class="button quiet" id="backupsBtn">Backups</button>' : ''}`)}
    <section class="panel tester"><form id="testForm" class="inline-form"><label for="testUrl" class="label">Test a URL</label><input id="testUrl" placeholder="/old-page/?utm_source=x  or  https://nikolaseo.com/old-page/" autocomplete="off"><button class="button secondary small">Test</button></form><div id="testOut"></div></section>
    <div class="issue-bar" id="issueBar"></div>
    <section class="panel table-panel">
      <div class="panel-heading filters">
        <div class="search-box"><span>⌕</span><input type="search" id="rq" placeholder="Search source, target or notes" aria-label="Search redirects"></div>
        <select id="rs" aria-label="Status"><option value="">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option></select>
        <select id="rc" aria-label="Type"><option value="">All types</option>${R.CODES.map(c => `<option>${c}</option>`).join('')}</select>
        <select id="rm" aria-label="Match"><option value="">All matches</option><option value="exact">Exact</option><option value="wildcard">Wildcard</option><option value="regex">Regex</option></select>
        <select id="ri" aria-label="Issues"><option value="">Any diagnostics</option><option value="any">Has a problem</option>${['loop', 'chain', 'conflict', 'duplicate', 'self', 'invalid', 'target', 'shadow', 'inactive'].map(i => `<option value="${i}" ${p.issue === i ? 'selected' : ''}>${ISSUE_LABEL[i]}</option>`).join('')}</select>
      </div>
      <div class="bulk-bar" id="bulkBar" hidden><b id="selCount"></b>
        ${manage ? '<button class="button quiet small" data-bulk="activate">Activate</button><button class="button quiet small" data-bulk="deactivate">Deactivate</button><select id="bulkCode" aria-label="Set type"><option value="">Set type…</option>' + R.CODES.map(c => `<option>${c}</option>`).join('') + '</select><button class="button quiet small" data-bulk="reset_hits">Reset hits</button><button class="button quiet small danger-text" data-bulk="delete">Delete</button>' : ''}
        <button class="button quiet small" id="verifyBtn">Verify live</button><button class="button quiet small" id="clearSel">Clear</button></div>
      <div class="table-scroll"><table class="data-table redirects"><thead><tr>
        <th class="cb"><input type="checkbox" id="selAll" aria-label="Select all on this page"></th>
        ${[['source', 'Source'], ['target', 'Target'], ['code', 'Type'], ['position', 'Match'], ['hits', 'Hits'], ['last_hit', 'Last hit']].map(([k, l]) => `<th><button class="sort" data-sort="${k}">${l}<span class="arrow"></span></button></th>`).join('')}
        <th>Status</th><th>Diagnostics</th><th></th></tr></thead><tbody id="rrows"></tbody></table></div>
      <div class="pager" id="pager"></div>
    </section>`;
  const $ = s => ws.querySelector(s);

  async function load() {
    const qs = new URLSearchParams(Object.entries(p).filter(([, v]) => v !== '' && v !== null));
    last = await api('GET', `/redirects?${qs}`);
    draw();
  }

  function issueBadges(list) {
    return list.filter(i => i.type !== 'inactive').map(i => `<span class="pill ${i.level === 'error' ? 'bad' : 'warn'}" title="${esc(i.message)}">${esc(ISSUE_LABEL[i.type] || i.type)}</span>`).join(' ');
  }

  function draw() {
    const { redirects, total, filtered, page, per, summary } = last;
    $('#issueBar').innerHTML = Object.keys(summary).filter(k => !['inactive', 'pattern'].includes(k)).length
      ? `Diagnostics: ${Object.entries(summary).filter(([k]) => !['pattern'].includes(k)).map(([k, n]) => `<button class="pill ${['loop', 'conflict', 'invalid', 'self'].includes(k) ? 'bad' : k === 'inactive' ? '' : 'warn'}" data-issue="${k}">${n} ${esc(ISSUE_LABEL[k] || k)}</button>`).join(' ')}`
      : (total ? '<span class="ok">No loops, chains, conflicts or invalid rules.</span>' : '');
    $('#rrows').innerHTML = redirects.length ? redirects.map(r => `<tr class="${r.active ? '' : 'inactive'}">
      <td class="cb"><input type="checkbox" data-sel="${r.id}" ${selected.has(r.id) ? 'checked' : ''} aria-label="Select redirect ${r.id}"></td>
      <td><code class="url">${esc(r.source)}</code>${r.notes ? `<small class="block muted">${esc(r.notes)}</small>` : ''}</td>
      <td><code class="url">${esc(r.target)}</code></td>
      <td><span class="pill code-${r.code}" title="${esc(CODE_HELP[r.code])}">${r.code}</span></td>
      <td><small>${esc(r.match)}${r.match !== 'regex' ? ` · ${esc(r.query)}` : ''}${r.ignore_case ? '' : ' · case'}${r.ignore_slash ? '' : ' · slash'}${r.position ? ` · #${r.position}` : ''}</small></td>
      <td class="num">${r.hits}</td><td><small>${r.last_hit ? fmtAgo(r.last_hit) : '—'}</small></td>
      <td>${manage ? `<label class="switch" title="${r.active ? 'Active — click to disable' : 'Inactive — click to enable'}"><input type="checkbox" data-toggle="${r.id}" ${r.active ? 'checked' : ''}><span></span></label>` : (r.active ? 'Active' : 'Inactive')}</td>
      <td>${issueBadges(r.issues)}</td>
      <td class="row-actions"><button class="button quiet small" data-test="${r.id}">Test</button>${manage ? `<button class="button quiet small" data-edit="${r.id}">Edit</button><button class="button quiet small danger-text" data-del="${r.id}">Delete</button>` : ''}</td></tr>`).join('')
      : `<tr><td colspan="10"><div class="empty">${total ? 'No redirects match these filters.' : 'No redirects yet.'}</div></td></tr>`;
    const pages = Math.max(1, Math.ceil(filtered / per));
    $('#pager').innerHTML = `<span>${filtered} of ${total} redirects</span><span class="spacer"></span>
      <label>Per page <select id="perSel">${[25, 50, 100, 250, 500].map(n => `<option ${n === per ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <button class="button quiet small" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹ Prev</button><span>Page ${page} / ${pages}</span><button class="button quiet small" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next ›</button>`;
    ws.querySelectorAll('.sort').forEach(b => { b.querySelector('.arrow').textContent = b.dataset.sort === p.sort ? (p.dir === 'asc' ? ' ▲' : ' ▼') : ''; });
    $('#selAll').checked = redirects.length > 0 && redirects.every(r => selected.has(r.id));
    updateBulk();
  }

  function updateBulk() { $('#bulkBar').hidden = selected.size === 0; $('#selCount').textContent = `${selected.size} selected`; }

  /* filters */
  $('#rq').oninput = debounce(e => { p.q = e.target.value; p.page = 1; load().catch(toastError); }, 250);
  [['#rs', 'status'], ['#rc', 'code'], ['#rm', 'match'], ['#ri', 'issue']].forEach(([s, k]) => { $(s).onchange = e => { p[k] = e.target.value; p.page = 1; load().catch(toastError); }; });
  ws.addEventListener('click', async e => {
    const b = e.target.closest('button, [data-issue]');
    if (!b) return;
    try {
      if (b.dataset.sort) { p.dir = p.sort === b.dataset.sort && p.dir === 'asc' ? 'desc' : 'asc'; p.sort = b.dataset.sort; await load(); }
      else if (b.dataset.page) { p.page = Number(b.dataset.page); await load(); }
      else if (b.dataset.issue) { p.issue = b.dataset.issue; $('#ri').value = p.issue; p.page = 1; await load(); }
      else if (b.dataset.edit) editDialog(last.redirects.find(r => r.id === Number(b.dataset.edit)), load);
      else if (b.dataset.test) { const r = last.redirects.find(x => x.id === Number(b.dataset.test)); const src = r.match === 'exact' ? r.source : ''; $('#testUrl').value = src || ''; if (src) await runTest(src); else { $('#testUrl').focus(); toast('Enter a URL that this pattern should match.'); } }
      else if (b.dataset.del) {
        const r = last.redirects.find(x => x.id === Number(b.dataset.del));
        if (await confirmDialog('Delete redirect?', `<code>${esc(r.source)}</code> → <code>${esc(r.target)}</code><br>Visitors to the source will no longer be redirected. To keep it for later, deactivate it instead.`, { danger: true, confirmLabel: 'Delete' })) {
          await api('DELETE', `/redirects/${r.id}`); selected.delete(r.id); toast('Redirect deleted.'); await load();
        }
      } else if (b.dataset.bulk) await bulk(b.dataset.bulk);
      else if (b.dataset.export) {
        $('#exportMenu').hidden = true;
        if (b.dataset.export === 'template') download('redirects-template.csv', R.csvTemplate());
        else {
          const qs = new URLSearchParams(Object.entries(p).filter(([k, v]) => v && !['page', 'per'].includes(k)));
          await downloadFromApi(`/redirects/export?scope=${b.dataset.export}&${qs}`, 'redirects.csv');
        }
      }
    } catch (err) { toastError(err); }
  });
  $('#exportBtn').onclick = e => { e.stopPropagation(); $('#exportMenu').hidden = !$('#exportMenu').hidden; };
  ws.addEventListener('click', e => { if (!e.target.closest('.menu-wrap')) $('#exportMenu').hidden = true; });
  ws.addEventListener('change', async e => {
    const t = e.target;
    try {
      if (t.id === 'perSel') { p.per = Number(t.value); p.page = 1; await load(); }
      if (t.dataset.sel) { t.checked ? selected.add(Number(t.dataset.sel)) : selected.delete(Number(t.dataset.sel)); updateBulk(); }
      if (t.id === 'selAll') { last.redirects.forEach(r => (t.checked ? selected.add(r.id) : selected.delete(r.id))); draw(); }
      if (t.dataset.toggle) { await api('PUT', `/redirects/${t.dataset.toggle}`, { active: t.checked }); toast(t.checked ? 'Redirect activated.' : 'Redirect deactivated.'); await load(); }
      if (t.id === 'bulkCode' && t.value) { await bulk('set_code', Number(t.value)); t.value = ''; }
    } catch (err) { toastError(err); if (t.dataset.toggle) t.checked = !t.checked; }
  });
  $('#clearSel').onclick = () => { selected.clear(); draw(); };

  async function bulk(actionName, code) {
    const n = selected.size;
    const words = { activate: 'Activate', deactivate: 'Deactivate', delete: 'Delete', reset_hits: 'Reset hit counts for', set_code: `Set type ${code} on` };
    if (!(await confirmDialog(`${words[actionName]} ${n} redirect(s)?`, `A backup of all redirects is taken first and can be restored from Backups.`, { danger: actionName === 'delete', confirmLabel: words[actionName], typeToConfirm: actionName === 'delete' && n > 20 ? 'DELETE' : '' }))) return;
    await api('POST', '/redirects/bulk', { ids: [...selected], action: actionName, code });
    toast(`Done: ${n} redirect(s).`);
    if (actionName === 'delete') selected.clear();
    await load();
  }

  /* tester */
  async function runTest(url, rule) {
    const out = $('#testOut');
    out.innerHTML = '<span class="muted">Testing…</span>';
    const r = await api('POST', '/redirects/test', { url, rule });
    out.innerHTML = traceHtml(r);
  }
  $('#testForm').addEventListener('submit', e => { e.preventDefault(); if ($('#testUrl').value.trim()) runTest($('#testUrl').value.trim()).catch(err => { $('#testOut').innerHTML = `<span class="bad">${esc(err.message)}</span>`; }); });

  $('#verifyBtn').onclick = e => action(e.target, async () => {
    const ids = [...selected].slice(0, 25);
    if (selected.size > 25) toast('Verifying the first 25 selected redirects.', 'warn');
    const r = await api('POST', '/redirects/verify-live', { ids });
    modal('Live verification', `<p class="muted">Requests were sent to the live site through the HTTP status checker. A pass means the live status code and Location header match what the CMS expects. Wildcard/regex rules are skipped (test them with a concrete URL).</p>
      <div class="table-scroll"><table class="data-table"><thead><tr><th></th><th>URL</th><th>Expected</th><th>Live</th></tr></thead><tbody>
      ${r.results.map(x => `<tr><td>${x.pass ? '<span class="ok">✓ Pass</span>' : '<span class="bad">✗ Fail</span>'}</td><td><code>${esc(x.url)}</code></td><td>${x.expected ? `${x.expected.code} → <code>${esc(x.expected.location)}</code>` : 'no redirect'}</td><td>${x.error ? `<span class="bad">${esc(x.error)}</span>` : `${x.live.code ?? '—'}${x.live.location ? ` → <code>${esc(x.live.location)}</code>` : ''}`}</td></tr>`).join('') || '<tr><td colspan="4">Nothing to verify (only exact-match rules can be checked automatically).</td></tr>'}
      </tbody></table></div>`, { wide: true });
  }, 'Checking…')();

  $('#addBtn')?.addEventListener('click', () => editDialog(null, load));
  $('#importBtn')?.addEventListener('click', () => importWizard(load));
  $('#backupsBtn')?.addEventListener('click', () => backupsDialog(load));

  await load();
}

function traceHtml(r) {
  if (!r.hops.length) {
    return `<div class="trace"><span class="muted">No redirect: the request reaches the site normally.</span> ${r.finalIsKnownPage === false ? '<span class="pill warn">URL is not a known page (likely 404)</span>' : r.finalIsKnownPage ? '<span class="pill ok-pill">Known page</span>' : ''}${r.inactiveMatches?.length ? `<br><small class="warn-text">Inactive rule(s) would match: ${r.inactiveMatches.map(x => `#${x.id} ${esc(x.source)}`).join(', ')}</small>` : ''}</div>`;
  }
  return `<ol class="trace">${r.hops.map(h => `<li><span class="pill code-${h.code}">${h.code}</span> <code>${esc(h.from)}</code> → <code>${esc(h.to)}</code> <small class="muted">rule ${h.ruleId != null && h.ruleId !== -1 ? `#${h.ruleId}` : '(unsaved)'} · ${esc(h.source)}</small></li>`).join('')}</ol>
    <div class="trace-final">${r.loop ? '<span class="pill bad">Redirect loop</span> Browsers will show “too many redirects”.' : `Final URL: <code>${esc(r.final)}</code> ${r.finalIsKnownPage === false ? '<span class="pill warn">not a known page — may 404</span>' : r.finalIsKnownPage ? '<span class="pill ok-pill">known page</span>' : '<span class="muted">(external)</span>'}`}
    ${r.hops.length > 1 && !r.loop ? `<br><span class="warn-text">Chain of ${r.hops.length} redirects — point the first rule straight at the final URL.</span>` : ''}</div>`;
}

async function editDialog(rule, onSaved) {
  const targets = await getLinkTargets().catch(() => []);
  const defaults = (await api('GET', '/redirects?per=10')).defaults;
  const r = rule || { ...defaults, source: '', target: '', position: 0, notes: '' };
  const m = modal(rule ? `Edit redirect #${rule.id}` : 'Add redirect', `<form id="rf" novalidate>
    <div class="field"><label for="fSource">Source URL</label><input id="fSource" value="${esc(r.source)}" placeholder="/old-page/" autocomplete="off" required><small class="hint" id="srcHint">Path on nikolaseo.com. Full https://nikolaseo.com/… URLs are accepted.</small></div>
    <div class="field"><label for="fTarget">Target URL</label><input id="fTarget" list="pageTargets" value="${esc(r.target)}" placeholder="/new-page/ or https://example.com/" autocomplete="off" required><datalist id="pageTargets">${targets.filter(t => t.published).map(t => `<option value="${esc(t.url)}">${esc(t.title)}</option>`).join('')}</datalist><small class="hint">Pick one of your pages or type any path / absolute URL (other domains allowed).</small></div>
    <div class="grid-2">
      <div class="field"><label for="fCode">Redirect type</label><select id="fCode">${R.CODES.map(c => `<option value="${c}" ${Number(r.code) === c ? 'selected' : ''}>${c}</option>`).join('')}</select><small class="hint" id="codeHint"></small></div>
      <div class="field"><label for="fMatch">Match</label><select id="fMatch"><option value="exact">Exact URL</option><option value="wildcard">Wildcard (*)</option><option value="regex">Regular expression</option></select><small class="hint" id="matchHint"></small></div>
    </div>
    <details class="advanced" ${rule && (r.query !== defaults.query || !r.ignore_case || !r.ignore_slash || r.position) ? 'open' : ''}><summary>Advanced: query string, case, slash, priority</summary>
      <div class="field"><label for="fQuery">Query-string handling</label><select id="fQuery">${R.QUERY_MODES.map(q => `<option value="${q}" ${r.query === q ? 'selected' : ''}>${q}</option>`).join('')}</select><small class="hint" id="queryHint"></small></div>
      <label class="check"><input type="checkbox" id="fCase" ${r.ignore_case ? 'checked' : ''}> Ignore case (/Old = /old)</label>
      <label class="check"><input type="checkbox" id="fSlash" ${r.ignore_slash ? 'checked' : ''}> Ignore trailing slash (/old = /old/)</label>
      <div class="field narrow"><label for="fPos">Position (lower runs first)</label><input id="fPos" type="number" value="${Number(r.position) || 0}"></div>
    </details>
    <div class="field"><label for="fNotes">Notes</label><input id="fNotes" value="${esc(r.notes || '')}" maxlength="500"></div>
    <label class="check"><input type="checkbox" id="fActive" ${r.active !== false ? 'checked' : ''}> Active</label>
    <div class="validation" id="fVal" aria-live="polite"></div>
    <div class="panel inset"><div class="inline-form"><label for="fTest" class="label">Test before saving</label><input id="fTest" placeholder="URL to test with this rule"><button type="button" class="button secondary small" id="fTestBtn">Test</button></div><div id="fTestOut"></div></div>
  </form>`, { wide: true, actions: `<button class="button quiet" data-cancel>Cancel</button><button class="button primary" id="fSave">${rule ? 'Save changes' : 'Create redirect'}</button>` });
  m.$('#fMatch').value = r.match;
  const read = () => ({ source: m.$('#fSource').value.trim(), target: m.$('#fTarget').value.trim(), code: Number(m.$('#fCode').value), match: m.$('#fMatch').value, query: m.$('#fQuery').value, ignore_case: m.$('#fCase').checked, ignore_slash: m.$('#fSlash').checked, position: Number(m.$('#fPos').value) || 0, notes: m.$('#fNotes').value, active: m.$('#fActive').checked });
  const validate = () => {
    const x = read();
    m.$('#codeHint').textContent = CODE_HELP[x.code];
    m.$('#queryHint').textContent = QUERY_HELP[x.query];
    m.$('#matchHint').textContent = { exact: 'Matches one URL.', wildcard: 'Use * in the source; reuse it as * or $1 in the target. Example: /blog/* → /studies/*', regex: 'JavaScript regex against the path, e.g. ^/old/(\\d+)$ → /new/$1' }[x.match];
    if (!x.source && !x.target) { m.$('#fVal').innerHTML = ''; return true; }
    const v = R.validateRule(x);
    m.$('#fVal').innerHTML = [...v.errors.map(e => `<div class="bad">✗ ${esc(e)}</div>`), ...v.warnings.map(w => `<div class="warn-text">! ${esc(w)}</div>`)].join('');
    return v.errors.length === 0;
  };
  m.$$('input,select').forEach(el => { el.addEventListener('input', validate); el.addEventListener('change', validate); });
  validate();
  m.$('[data-cancel]').onclick = () => m.close();
  m.$('#fTestBtn').onclick = async () => {
    const url = m.$('#fTest').value.trim() || (read().match === 'exact' ? read().source : '');
    if (!url) return toast('Enter a URL to test.', 'error');
    try { const t = await api('POST', '/redirects/test', { url, rule: { ...read(), id: rule?.id ?? -1, active: true } }); m.$('#fTestOut').innerHTML = traceHtml(t); } catch (e) { m.$('#fTestOut').innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
  };
  m.$('#fSave').onclick = action(m.$('#fSave'), async () => {
    if (!validate()) return toast('Fix the highlighted problems first.', 'error');
    let res;
    try {
      res = rule ? await api('PUT', `/redirects/${rule.id}`, read()) : await api('POST', '/redirects', read());
    } catch (e) {
      if (e.data?.code === 'duplicate') { m.$('#fVal').innerHTML = `<div class="bad">✗ ${esc(e.message)}</div>`; return; }
      throw e;
    }
    const issues = (res.issues || []).filter(i => i.type !== 'inactive');
    if (issues.length) toast(`Saved, but check: ${issues.map(i => i.message).join(' ')}`, issues.some(i => i.level === 'error') ? 'error' : 'warn', 10000);
    else toast(rule ? 'Redirect updated.' : 'Redirect created. It is live within ~15 seconds.');
    m.close(); onSaved();
  }, 'Saving…');
}

/* --------------------------------------------------------- Import ---- */

function importWizard(onDone) {
  let rows = [];
  let plan = null;
  const help = R.CSV_HELP.map(([c, d]) => `<tr><td><code>${c}</code></td><td>${esc(d)}</td></tr>`).join('');
  const m = modal('Import redirects from CSV', `
    <div id="step1">
      <p>Upload a CSV with at least <b>source</b>, <b>target</b> and optionally <b>code</b> columns. Common header names (“Source URL”, “Target URL”, “Redirect type”, “From”, “To”…) are recognised; comma, semicolon and tab delimiters work. Nothing is saved until you review the preview and confirm.</p>
      <p><button class="button quiet small" id="tplBtn" type="button">Download template</button></p>
      <label class="dropzone" id="csvDrop"><input type="file" id="csvFile" accept=".csv,text/csv,.tsv,.txt" hidden><b>Drop a CSV here or click to choose</b><small>Up to 20,000 rows per import</small></label>
      <details class="advanced"><summary>Column definitions</summary><table class="data-table"><tbody>${help}</tbody></table></details>
    </div>
    <div id="step2" hidden></div>`, { wide: true });
  m.$('#tplBtn').onclick = () => download('redirects-template.csv', R.csvTemplate());
  const fileIn = m.$('#csvFile');
  const drop = m.$('#csvDrop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); handle(e.dataTransfer.files[0]); };
  fileIn.onchange = () => handle(fileIn.files[0]);

  async function handle(file) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) return toast('CSV files can be at most 8 MB.', 'error');
    const parsed = R.rowsToRules(R.parseCsv(await file.text()));
    if (parsed.headerErrors.length) return toast(parsed.headerErrors.join(' '), 'error');
    if (!parsed.rules.length) return toast('The file has no data rows.', 'error');
    rows = parsed.rules.map(({ _parseErrors, ...r }) => ({ ...r, _parseErrors }));
    m.$('#step1').hidden = true;
    await preview(file.name);
  }

  async function preview(name = '') {
    const box = m.$('#step2');
    box.hidden = false;
    box.innerHTML = '<p class="muted">Validating…</p>';
    try { plan = await api('POST', '/redirects/import/preview', { rows: rows.filter(r => !r._excluded) }); } catch (e) { box.innerHTML = `<div class="notice error">${esc(e.message)}</div>`; return; }
    const c = plan.counts;
    let tab = c.attention ? 'attention' : 'all';
    const draw = () => {
      const list = plan.rows.filter(r => tab === 'all' || (tab === 'attention' ? r.status !== 'valid' || r.notes.length : tab === 'duplicate' ? r.status.startsWith('duplicate') : tab === 'conflict' ? r.status.startsWith('conflict') : r.status === tab));
      box.innerHTML = `${name ? `<p><b>${esc(name)}</b></p>` : ''}
        <div class="stat-grid small">
          <div class="stat-card"><div class="stat-label">Rows</div><div class="stat-value">${c.total}</div></div>
          <div class="stat-card"><div class="stat-label">Valid (new)</div><div class="stat-value ok">${c.valid}</div></div>
          <div class="stat-card"><div class="stat-label">Invalid</div><div class="stat-value ${c.invalid ? 'bad' : ''}">${c.invalid}</div></div>
          <div class="stat-card"><div class="stat-label">Duplicates</div><div class="stat-value">${c.duplicate}</div></div>
          <div class="stat-card"><div class="stat-label">Conflicts</div><div class="stat-value ${c.conflict ? 'warn-text' : ''}">${c.conflict}</div></div>
          <div class="stat-card"><div class="stat-label">Need attention</div><div class="stat-value">${c.attention}</div></div>
        </div>
        ${plan.truncated ? '<div class="notice warn">Only the first 20,000 rows are processed.</div>' : ''}
        <div class="tabs">${[['attention', 'Needs attention'], ['all', 'All rows'], ['invalid', 'Invalid'], ['duplicate', 'Duplicates'], ['conflict', 'Conflicts'], ['valid', 'Valid']].map(([k, l]) => `<button class="tab${k === tab ? ' active' : ''}" data-itab="${k}">${l}</button>`).join('')}</div>
        <div class="table-scroll import-table"><table class="data-table"><thead><tr><th>Row</th><th>Status</th><th>Source</th><th>Target</th><th>Type</th><th>Messages</th><th></th></tr></thead><tbody>
        ${list.slice(0, 500).map(r => `<tr class="st-${esc(r.status)}"><td>${r.row}</td><td><span class="pill ${r.status === 'valid' ? 'ok-pill' : r.status === 'invalid' ? 'bad' : 'warn'}">${esc(r.status.replace(/_/g, ' '))}</span></td>
          <td><input class="cell" data-row="${r.row}" data-k="source" value="${esc(r.rule.source ?? '')}" aria-label="Source row ${r.row}"></td>
          <td><input class="cell" data-row="${r.row}" data-k="target" value="${esc(r.rule.target ?? '')}" aria-label="Target row ${r.row}"></td>
          <td><input class="cell tiny" data-row="${r.row}" data-k="code" value="${esc(r.rule.code ?? '')}" aria-label="Type row ${r.row}"></td>
          <td><small>${[...r.errors.map(e => `<span class="bad">${esc(e)}</span>`), ...r.notes.map(n => esc(n))].join('<br>')}</small></td>
          <td><button class="button quiet small" data-exclude="${r.row}">Exclude</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty">No rows in this view.</td></tr>'}
        </tbody></table>${list.length > 500 ? `<p class="muted">Showing 500 of ${list.length} rows.</p>` : ''}</div>
        <p class="hint">Fix rows by editing the cells, or exclude them, then press <b>Re-validate</b>. Duplicates are always skipped. Conflicts (same source, different target) are skipped unless you choose to overwrite.</p>
        <div class="btn-row"><button class="button secondary" id="revalidate">Re-validate</button><button class="button quiet" id="errCsv">Download rows needing attention</button></div>
        <div class="panel inset">
          <label class="check"><input type="checkbox" id="overwrite" ${c.conflict ? '' : 'disabled'}> Overwrite the ${c.conflict} existing rule(s) that conflict with this file</label>
          <div class="field" id="owConfirm" hidden><label for="owType">Type <b>OVERWRITE</b> to confirm replacing existing rules</label><input id="owType" autocomplete="off"></div>
          <p class="hint">A backup of all current redirects is taken automatically before importing.</p>
          <button class="button primary" id="commitBtn" ${c.valid + (c.conflict ? 1 : 0) === 0 ? 'disabled' : ''}>Import ${c.valid} new redirect(s)</button>
        </div>`;
      box.querySelectorAll('[data-itab]').forEach(b => (b.onclick = () => { tab = b.dataset.itab; draw(); }));
      box.querySelectorAll('.cell').forEach(inp => (inp.onchange = () => {
        const row = rows.find(x => x._row === Number(inp.dataset.row));
        if (!row) return;
        row[inp.dataset.k] = inp.dataset.k === 'code' ? Number(inp.value) || inp.value : inp.value;
        if (inp.dataset.k === 'code') row._parseErrors = (row._parseErrors || []).filter(e => !/redirect type/i.test(e));
        inp.classList.add('edited');
      }));
      box.querySelectorAll('[data-exclude]').forEach(b => (b.onclick = () => { const row = rows.find(x => x._row === Number(b.dataset.exclude)); if (row) row._excluded = true; b.closest('tr').classList.add('excluded'); b.disabled = true; b.textContent = 'Excluded'; }));
      box.querySelector('#revalidate').onclick = () => preview(name);
      box.querySelector('#errCsv').onclick = () => {
        const bad = plan.rows.filter(r => r.status !== 'valid');
        const lines = ['row,status,source,target,code,messages', ...bad.map(r => [r.row, r.status, r.rule.source, r.rule.target, r.rule.code, [...r.errors, ...r.notes].join(' | ')].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))];
        download('redirect-import-issues.csv', lines.join('\r\n'));
      };
      const ow = box.querySelector('#overwrite');
      ow.onchange = () => { box.querySelector('#owConfirm').hidden = !ow.checked; box.querySelector('#commitBtn').textContent = ow.checked ? `Import ${c.valid} and overwrite ${c.conflict}` : `Import ${c.valid} new redirect(s)`; };
      box.querySelector('#commitBtn').onclick = action(box.querySelector('#commitBtn'), commit, 'Importing…');
    };
    draw();
  }

  async function commit() {
    const box = m.$('#step2');
    const overwrite = box.querySelector('#overwrite').checked;
    if (overwrite && box.querySelector('#owType').value !== 'OVERWRITE') return toast('Type OVERWRITE to confirm.', 'error');
    const res = await api('POST', '/redirects/import/commit', { rows: rows.filter(r => !r._excluded), overwriteConflicts: overwrite, confirmOverwrite: overwrite ? 'OVERWRITE' : undefined });
    box.innerHTML = `<h3>Import complete</h3>
      <div class="stat-grid small"><div class="stat-card"><div class="stat-label">Imported</div><div class="stat-value ok">${res.imported}</div></div><div class="stat-card"><div class="stat-label">Overwritten</div><div class="stat-value">${res.updated}</div></div><div class="stat-card"><div class="stat-label">Skipped</div><div class="stat-value">${res.skipped.length}</div></div><div class="stat-card"><div class="stat-label">Failed</div><div class="stat-value ${res.failed.length ? 'bad' : ''}">${res.failed.length}</div></div></div>
      ${res.failed.length ? `<h4>Failed rows</h4><ul class="plain-list">${res.failed.slice(0, 200).map(f => `<li>Row ${f.row}: <span class="bad">${esc(f.errors.join(' '))}</span></li>`).join('')}</ul>` : ''}
      ${res.skipped.length ? `<h4>Skipped rows</h4><ul class="plain-list">${res.skipped.slice(0, 200).map(s => `<li>Row ${s.row}: ${esc(s.reason)}</li>`).join('')}</ul>` : ''}
      <div class="btn-row"><button class="button quiet" id="sumCsv">Download summary CSV</button><button class="button primary" id="doneBtn">Done</button></div>`;
    box.querySelector('#sumCsv').onclick = () => download('redirect-import-summary.csv', ['row,result,detail', ...res.failed.map(f => `${f.row},failed,"${f.errors.join(' | ').replace(/"/g, '""')}"`), ...res.skipped.map(s => `${s.row},skipped,"${s.reason.replace(/"/g, '""')}"`)].join('\r\n'));
    box.querySelector('#doneBtn').onclick = () => m.close();
    toast(`${res.imported} redirect(s) imported.`);
    onDone();
  }
}

async function backupsDialog(onDone) {
  const { backups } = await api('GET', '/redirects/backups');
  const m = modal('Redirect backups', `<p class="muted">A full copy of the redirect table is saved automatically before every CSV import, bulk action and restore (the last 50 are kept).</p>
    <p><button class="button secondary small" id="mkBackup">Create backup now</button></p>
    <div class="table-scroll"><table class="data-table"><thead><tr><th>When</th><th>Reason</th><th>Rules</th><th>By</th><th></th></tr></thead><tbody>
    ${backups.map(b => `<tr><td>${fmtDate(b.created_at)}</td><td>${esc(b.reason)}</td><td>${b.count}</td><td>${esc(b.user_name || '—')}</td><td class="row-actions"><button class="button quiet small" data-csv="${b.id}">CSV</button><button class="button quiet small danger-text" data-restore="${b.id}" data-count="${b.count}">Restore</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No backups yet.</td></tr>'}
    </tbody></table></div>`, { wide: true });
  m.el.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.id === 'mkBackup') { await api('POST', '/redirects/backups', { reason: 'Manual backup' }); toast('Backup created.'); m.close(); backupsDialog(onDone); }
      if (b.dataset.csv) await downloadFromApi(`/redirects/backups/${b.dataset.csv}/csv`, 'redirects-backup.csv');
      if (b.dataset.restore) {
        const typed = await confirmDialog('Restore this backup?', `All current redirects are replaced by the ${b.dataset.count} rule(s) in this backup. The current set is backed up first.`, { danger: true, confirmLabel: 'Restore', typeToConfirm: 'RESTORE' });
        if (typed !== 'RESTORE') return;
        const r = await api('POST', `/redirects/backups/${b.dataset.restore}/restore`, { confirm: 'RESTORE' });
        toast(`Restored ${r.count} redirect(s).`); m.close(); onDone();
      }
    } catch (err) { toastError(err); }
  });
}
