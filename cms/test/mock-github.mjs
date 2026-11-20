// Test double for the GitHub API + GitHub Pages origin + live HTTP checker.
// - :8789  GitHub git-data API (refs, commits, trees, blobs) backed by an in-memory repo
// - :8788  "GitHub Pages": serves files from the current head commit (so publishes go live)
// - :8790  live checker: POST /check {url} -> first redirect hop, like the production checker Worker
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.argv[2] || path.resolve('..');
const blobs = new Map();   // sha -> Buffer
const trees = new Map();   // sha -> Map(path -> blobSha)
const commits = new Map(); // sha -> { tree, parent, message }
let head;
const log = [];

const sha = buf => crypto.createHash('sha1').update(buf).digest('hex');
function putBlob(buf) { const s = sha(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])); blobs.set(s, buf); return s; }
function putTree(map) { const s = sha(Buffer.from(JSON.stringify([...map].sort()))); trees.set(s, new Map(map)); return s; }

function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'cms'].includes(e.name)) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel)); else out.push(rel);
  }
  return out;
}
const initial = new Map();
for (const f of walk(ROOT)) initial.set(f, putBlob(fs.readFileSync(path.join(ROOT, f))));
const t0 = putTree(initial);
head = sha(Buffer.from(`commit0${t0}`));
commits.set(head, { tree: t0, parent: null, message: 'initial' });

const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
const body = req => new Promise(r => { let d = ''; req.on('data', c => (d += c)); req.on('end', () => r(d ? JSON.parse(d) : {})); });

http.createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer test-token') return send(res, 401, { message: 'Bad credentials' });
  const u = new URL(req.url, 'http://x');
  const p = u.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
  let m;
  if (req.method === 'GET' && p === '/git/ref/heads/main') return send(res, 200, { object: { sha: head } });
  if (req.method === 'GET' && (m = p.match(/^\/git\/commits\/(\w+)$/))) { const c = commits.get(m[1]); return c ? send(res, 200, { sha: m[1], tree: { sha: c.tree } }) : send(res, 404, {}); }
  if (req.method === 'GET' && (m = p.match(/^\/git\/trees\/(\w+)$/))) {
    const t = trees.get(m[1]); if (!t) return send(res, 404, {});
    return send(res, 200, { sha: m[1], truncated: false, tree: [...t].map(([path, s]) => ({ path, type: 'blob', sha: s, size: blobs.get(s).length })) });
  }
  if (req.method === 'GET' && (m = p.match(/^\/git\/blobs\/(\w+)$/))) { const b = blobs.get(m[1]); return b ? send(res, 200, { sha: m[1], content: b.toString('base64'), encoding: 'base64' }) : send(res, 404, {}); }
  if (req.method === 'POST' && p === '/git/blobs') { const b = await body(req); return send(res, 201, { sha: putBlob(Buffer.from(b.content, b.encoding === 'base64' ? 'base64' : 'utf8')) }); }
  if (req.method === 'POST' && p === '/git/trees') {
    const b = await body(req); const base = new Map(trees.get(b.base_tree));
    for (const e of b.tree) { if (e.sha === null) base.delete(e.path); else { if (!blobs.has(e.sha)) return send(res, 422, { message: 'bad sha' }); base.set(e.path, e.sha); } }
    return send(res, 201, { sha: putTree(base) });
  }
  if (req.method === 'POST' && p === '/git/commits') { const b = await body(req); const s = sha(Buffer.from(JSON.stringify(b) + Math.random())); commits.set(s, { tree: b.tree, parent: b.parents[0], message: b.message }); return send(res, 201, { sha: s }); }
  if (req.method === 'PATCH' && p === '/git/refs/heads/main') {
    const b = await body(req); const c = commits.get(b.sha);
    if (!c || c.parent !== head) return send(res, 422, { message: 'Update is not a fast forward' });
    head = b.sha; log.push(c.message); return send(res, 200, { object: { sha: head } });
  }
  // test helpers
  if (req.method === 'GET' && p === '/_log') return send(res, 200, { log, head });
  if (req.method === 'POST' && p === '/_external-commit') { // simulate someone committing directly to main
    const b = await body(req); const t = new Map(trees.get(commits.get(head).tree));
    t.set(b.path, putBlob(Buffer.from(b.text))); const ts = putTree(t); const s = sha(Buffer.from(`ext${Math.random()}`));
    commits.set(s, { tree: ts, parent: head, message: 'external' }); head = s; return send(res, 200, { head });
  }
  send(res, 404, { message: `mock: ${req.method} ${p}` });
}).listen(8789);

const TYPES = { html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml', png: 'image/png', xml: 'application/xml', txt: 'text/plain', pdf: 'application/pdf', webp: 'image/webp', jpg: 'image/jpeg', json: 'application/json' };
http.createServer((req, res) => {
  const t = trees.get(commits.get(head).tree);
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname).slice(1);
  if (p === '' || p.endsWith('/')) p += 'index.html';
  let s = t.get(p);
  if (!s && t.get(`${p}/index.html`)) { res.writeHead(301, { Location: `/${p}/` }); return res.end(); }
  if (!s) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<h1>404 (mock pages)</h1>'); }
  res.writeHead(200, { 'Content-Type': TYPES[p.split('.').pop()] || 'application/octet-stream', 'X-Origin': 'mock-pages', 'X-Got-Cookie': req.headers.cookie ? 'yes' : 'no' });
  res.end(req.method === 'HEAD' ? undefined : blobs.get(s));
}).listen(8788);

http.createServer(async (req, res) => {
  const b = await body(req);
  try {
    const target = new URL(b.url); target.protocol = 'http:'; target.host = 'localhost:8787';
    const r = await fetch(target, { redirect: 'manual', headers: { Host: 'nikolaseo.com' } });
    const loc = r.headers.get('location');
    const live = loc ? loc.replace('http://localhost:8787', 'https://nikolaseo.com') : null;
    send(res, 200, { input: b.url, chain: loc ? [{ status: r.status, from: b.url, to: live }] : [], finalStatus: r.status, finalDetails: { status: r.status, url: b.url } });
  } catch (e) { send(res, 500, { error: e.message }); }
}).listen(8790);

console.log('mock github :8789, pages :8788, checker :8790; files', initial.size);
