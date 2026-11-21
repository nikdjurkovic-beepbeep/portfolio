// NikolaSEO edge Worker: CMS API + live redirects + private/password pages,
// in front of the GitHub Pages origin.
import * as R from '../../../admin/js/shared/redirects.js';
import * as H from './html.js';
import * as A from './auth.js';
import { GitHub } from './github.js';
import * as M from './mfa.js';

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };
const nowIso = () => new Date().toISOString();
const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN'
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers } });
}

/* ================================================================ Entry ==== */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/cms-api/')) {
      try { return await api(request, env, ctx, url); } catch (e) { return apiError(e, env, ctx, request); }
    }
    try {
      return await edge(request, env, ctx, url);
    } catch (e) {
      // Fail open: the public site must keep working even if the CMS layer has a problem.
      console.error('edge error', e?.stack || e);
      return origin(request, env);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env).catch(e => log(env, null, 'cron.error', 'scheduler', { message: e.message }, 'error')));
  }
};

async function apiError(e, env, ctx, request) {
  if (e instanceof HttpError || (e.status && e.status < 500)) {
    return json({ error: e.message, ...(e.extra || {}), ...(e.code ? { code: e.code } : {}) }, e.status || 400);
  }
  const id = A.randomToken(6);
  console.error(`error ${id}`, e?.stack || e);
  ctx.waitUntil(log(env, null, 'api.error', new URL(request.url).pathname, { id, message: String(e?.message || e).slice(0, 300) }, 'error').catch(() => {}));
  return json({ error: e.status === 502 || e.status === 503 ? e.message : `Unexpected server error (ref ${id}). Nothing was changed if the operation did not complete.`, ref: id }, e.status && e.status >= 500 ? e.status : 500);
}

/* ================================================================= Edge ==== */

let EDGE = { at: 0, rv: null, cv: null, compiled: R.compile([]), protectedPages: new Map() };

const protKey = pathname => {
  let p = pathname.replace(/\/index\.html$/i, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p;
};

async function edgeState(env) {
  if (Date.now() - EDGE.at < 15000 && EDGE.rv !== null) return EDGE;
  const rows = (await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('redirects_version','content_version')").all()).results;
  const v = Object.fromEntries(rows.map(r => [r.key, r.value]));
  if (v.redirects_version !== EDGE.rv) {
    const rules = (await env.DB.prepare('SELECT id, source, target, code, match, query, ignore_case, ignore_slash, active, position FROM redirects WHERE active = 1').all()).results;
    EDGE.compiled = R.compile(rules, { trusted: true });
    EDGE.rv = v.redirects_version;
  }
  if (v.content_version !== EDGE.cv) {
    const pages = (await env.DB.prepare("SELECT id, url, visibility FROM pages WHERE status = 'published' AND visibility != 'public'").all()).results;
    EDGE.protectedPages = new Map(pages.map(p => [protKey(p.url), p]));
    EDGE.cv = v.content_version;
  }
  EDGE.at = Date.now();
  return EDGE;
}

function invalidateEdge() { EDGE.at = 0; }

async function bump(env, key) {
  await env.DB.prepare('UPDATE settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = ?').bind(key).run();
  invalidateEdge();
}

async function edge(request, env, ctx, url) {
  const state = await edgeState(env);
  const hit = R.match(state.compiled, url.toString());
  if (hit) {
    ctx.waitUntil(env.DB.prepare('UPDATE redirects SET hits = hits + 1, last_hit = ? WHERE id = ?').bind(sqlNow(), hit.rule.id).run().catch(() => {}));
    const permanent = hit.code === 301 || hit.code === 308;
    return new Response(null, {
      status: hit.code,
      headers: { Location: hit.location, 'Cache-Control': permanent ? 'public, max-age=3600' : 'no-store', 'X-Redirect-By': 'NikolaSEO CMS' }
    });
  }
  const prot = state.protectedPages.get(protKey(url.pathname));
  if (prot) return serveProtected(request, env, url, prot);
  const res = await origin(request, env);
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
    const r = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v);
    r.headers.set('X-Frame-Options', 'DENY');
    r.headers.set('X-Robots-Tag', 'noindex, nofollow');
    r.headers.set('Cache-Control', 'no-cache');
    return r;
  }
  return res;
}

/** Forward to GitHub Pages without CMS cookies. */
async function origin(request, env) {
  const headers = new Headers(request.headers);
  headers.delete('Cookie');
  if (env.ORIGIN_URL) {
    const u = new URL(request.url);
    const target = new URL(u.pathname + u.search, env.ORIGIN_URL);
    return fetch(target.toString(), { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body, redirect: 'manual' });
  }
  return fetch(new Request(request, { headers }));
}

const PROTECTED_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive', ...SECURITY_HEADERS };

async function serveProtected(request, env, url, ref) {
  const page = await env.DB.prepare("SELECT id, url, title, visibility, password_hash, published_html FROM pages WHERE id = ? AND status = 'published'").bind(ref.id).first();
  if (!page) return origin(request, env);
  if (page.visibility === 'private') {
    const session = await A.getSession(env, request);
    if (!session || await mustEnrollMfa(env, session.user)) return Response.redirect(`${url.origin}/admin/?next=${encodeURIComponent(url.pathname)}#login`, 302);
    if (!session.caps.has('private.read')) return new Response(simplePage('Private page', '<p>Your account does not have access to private pages.</p>'), { status: 403, headers: PROTECTED_HEADERS });
    return new Response(page.published_html, { status: 200, headers: PROTECTED_HEADERS });
  }
  // Password-protected
  const cookieKey = `cms_pp_${page.id}`;
  const expected = await A.hmac(env.SESSION_SECRET || 'dev-secret', `${page.id}:${page.password_hash}`);
  if (request.method === 'POST') {
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    if (await A.rateLimited(env, `pp:${page.id}:${ip}`, 10, 900)) {
      return new Response(passwordForm(page, 'Too many attempts. Try again in 15 minutes.'), { status: 429, headers: PROTECTED_HEADERS });
    }
    const form = await request.formData().catch(() => null);
    const pw = String(form?.get('password') || '');
    if (pw && await A.verifyPassword(pw, page.password_hash)) {
      const secure = env.DEV_INSECURE_COOKIES === '1' ? '' : '; Secure';
      return new Response(null, { status: 303, headers: { Location: url.pathname, 'Set-Cookie': `${cookieKey}=${expected}; Path=${page.url}; HttpOnly; SameSite=Lax; Max-Age=43200${secure}`, 'Cache-Control': 'no-store' } });
    }
    await A.rateHit(env, `pp:${page.id}:${ip}`, 900);
    return new Response(passwordForm(page, 'That password is not correct.'), { status: 401, headers: PROTECTED_HEADERS });
  }
  const cookies = A.parseCookies(request.headers.get('Cookie') || '');
  if (cookies[cookieKey] && cookies[cookieKey] === expected) return new Response(page.published_html, { status: 200, headers: PROTECTED_HEADERS });
  return new Response(passwordForm(page), { status: 401, headers: PROTECTED_HEADERS });
}

function simplePage(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${H.escapeText(title)} | NikolaSEO</title><link rel="stylesheet" href="/site.css"><style>.pp{max-width:420px;margin:12vh auto;padding:28px;border:1px solid var(--line,#26374b);border-radius:16px;background:#111d30}.pp input{width:100%;padding:12px;border-radius:10px;border:1px solid #26374b;background:#0b1220;color:#ecf2fa;font:inherit;margin:8px 0 14px}.pp .err{color:#ff9b9b;font-size:14px}</style></head><body><main class="wrap"><div class="pp">${body}</div></main></body></html>`;
}

function passwordForm(page, error = '') {
  return simplePage('Protected page', `<div class="eyebrow">Protected page</div><h1 style="font-size:28px;margin:10px 0 6px">${H.escapeText(page.title || 'Protected page')}</h1><p>This page is password protected. Enter the password to view it.</p>${error ? `<p class="err" role="alert">${H.escapeText(error)}</p>` : ''}<form method="post"><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" required autofocus><button class="btn" type="submit">View page</button></form>`);
}

/* ================================================================== API ==== */

const routes = [];
const route = (method, pattern, cap, handler, opts = {}) => routes.push({ method, re: new RegExp(`^/cms-api${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), cap, handler, ...opts });

async function api(request, env, ctx, url) {
  if (!env.DB) fail(503, 'Database binding missing.');
  const r = routes.find(x => x.method === request.method && x.re.test(url.pathname));
  if (!r) {
    if (routes.some(x => x.re.test(url.pathname))) fail(405, 'Method not allowed.');
    fail(404, 'Unknown API endpoint.');
  }
  const params = url.pathname.match(r.re).groups || {};
  let session = null;
  if (!r.public) {
    session = await A.getSession(env, request);
    if (!session) fail(401, 'Sign in to continue.');
    if (!['GET', 'HEAD'].includes(request.method)) {
      const o = request.headers.get('Origin');
      if (o && o !== url.origin) fail(403, 'Cross-site request blocked.');
      if (request.headers.get('X-CSRF-Token') !== session.csrf) fail(403, 'Security token missing or expired. Reload the page.');
    }
    if (!r.mfaExempt && await mustEnrollMfa(env, session.user)) fail(403, 'Set up two-factor authentication to continue.', { code: 'mfa_enrollment_required' });
    if (r.cap && !(Array.isArray(r.cap) ? r.cap.some(c => session.caps.has(c)) : session.caps.has(r.cap))) fail(403, 'Your role does not allow this action.');
  }
  let body = null;
  const ct = request.headers.get('Content-Type') || '';
  if (!['GET', 'HEAD', 'DELETE'].includes(request.method) || ct.includes('json')) {
    if (ct.includes('application/json')) {
      const text = await request.text();
      if (text.length > 8 * 1024 * 1024) fail(413, 'Request too large.');
      try { body = text ? JSON.parse(text) : {}; } catch { fail(400, 'Invalid JSON body.'); }
    } else if (ct.includes('multipart/form-data')) body = await request.formData();
  }
  const c = { request, env, ctx, url, params, session, user: session?.user, caps: session?.caps, body: body || {}, ip: request.headers.get('CF-Connecting-IP') || 'local' };
  return r.handler(c);
}

async function log(env, userId, action, target, detail = null, level = 'info', ip = null) {
  await env.DB.prepare('INSERT INTO audit_log (user_id, action, target, detail, level, ip) VALUES (?,?,?,?,?,?)')
    .bind(userId, action, target ?? null, detail ? JSON.stringify(detail).slice(0, 4000) : null, level, ip).run();
}
const audit = (c, action, target, detail) => c.ctx.waitUntil(log(c.env, c.user?.id ?? null, action, target, detail, 'info', c.ip).catch(() => {}));

const str = (v, max = 500) => (v === undefined || v === null ? '' : String(v)).trim().slice(0, max);
const intId = v => { const n = Number(v); if (!Number.isInteger(n) || n < 1) fail(400, 'Invalid id.'); return n; };

/* ----------------------------------------------------------- Auth ---- */

route('GET', '/setup', null, async c => {
  const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  return json({ needsSetup: n.n === 0, setupEnabled: Boolean(c.env.SETUP_TOKEN) });
}, { public: true });

route('POST', '/setup', null, async c => {
  const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  if (n.n > 0) fail(409, 'Setup has already been completed.');
  if (!c.env.SETUP_TOKEN || c.body.setupToken !== c.env.SETUP_TOKEN) fail(403, 'Invalid setup token.');
  const email = str(c.body.email, 200).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(422, 'Enter a valid email address.');
  const problems = A.passwordProblems(c.body.password);
  if (problems.length) fail(422, problems.join(' '));
  await c.env.DB.prepare('INSERT INTO users (email, name, role, pw_hash) VALUES (?,?,?,?)').bind(email, str(c.body.name, 100) || email, 'administrator', await A.hashPassword(c.body.password)).run();
  await log(c.env, null, 'setup.admin_created', email, null, 'info', c.ip);
  return json({ ok: true });
}, { public: true });

route('POST', '/auth/login', null, async c => {
  const email = str(c.body.email, 200).toLowerCase();
  const password = String(c.body.password || '');
  if (await A.rateLimited(c.env, `login-ip:${c.ip}`, 30, 900) || await A.rateLimited(c.env, `login:${email}`, 8, 900)) fail(429, 'Too many failed sign-in attempts. Wait 15 minutes and try again.');
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  const valid = user && user.active && await A.verifyPassword(password, user.pw_hash);
  if (!valid) {
    if (!user) await A.hashPassword(password); // equalise timing
    await A.rateHit(c.env, `login-ip:${c.ip}`, 900);
    await A.rateHit(c.env, `login:${email}`, 900);
    await log(c.env, user?.id ?? null, 'auth.login_failed', email, null, 'warning', c.ip);
    fail(401, 'Email or password is incorrect.');
  }
  if (user.totp_enabled) {
    // Password is right; the session is only created after the second factor.
    const token = A.randomToken(32);
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM login_challenges WHERE expires_at < ? OR user_id = ?').bind(nowIso(), user.id),
      c.env.DB.prepare('INSERT INTO login_challenges (id_hash, user_id, expires_at, ip) VALUES (?,?,?,?)').bind(await A.sha256(token), user.id, new Date(Date.now() + CHALLENGE_MS).toISOString(), c.ip)
    ]);
    await log(c.env, user.id, 'auth.password_ok_awaiting_2fa', email, null, 'info', c.ip);
    return json({ twoFactorRequired: true, challenge: token, expiresIn: CHALLENGE_MS / 1000 });
  }
  return finishLogin(c, user, 'password');
}, { public: true });

const CHALLENGE_MS = 5 * 60e3;
const CHALLENGE_ATTEMPTS = 5;

async function finishLogin(c, user, method, extra = {}) {
  await A.clearRateLimit(c.env, `login:${user.email}`);
  const s = await A.createSession(c.env, user, c.request);
  await log(c.env, user.id, 'auth.login', user.email, { method }, 'info', c.ip);
  const fresh = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
  return json({ user: publicUser(fresh), caps: [...A.capsFor(fresh)], csrf: s.csrf, mfa: await mfaStatus(c.env, fresh), ...extra }, 200, { 'Set-Cookie': A.sessionCookie(c.env, s.token, s.maxAge) });
}

/* ---------- two-factor authentication ---------- */

const MFA_POLICIES = ['none', 'administrators', 'staff', 'all'];

async function mfaPolicy(env) {
  const v = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'require_2fa'").first())?.value;
  return MFA_POLICIES.includes(v) ? v : 'staff';
}

function mfaRequiredFor(policy, role) {
  if (policy === 'all') return true;
  if (policy === 'staff') return role !== 'subscriber';
  if (policy === 'administrators') return role === 'administrator';
  return false;
}

/** A signed-in user who must use 2FA but has not set it up may only reach the enrolment endpoints. */
async function mustEnrollMfa(env, user) {
  if (!user || user.totp_enabled || !env.MFA_KEY) return false; // without a server key 2FA cannot be enforced (dashboard warns)
  return mfaRequiredFor(await mfaPolicy(env), user.role);
}

async function mfaStatus(env, user) {
  const policy = await mfaPolicy(env);
  return {
    enabled: Boolean(user.totp_enabled),
    enabledAt: user.totp_enabled_at || null,
    required: mfaRequiredFor(policy, user.role),
    mustEnroll: await mustEnrollMfa(env, user),
    configured: Boolean(env.MFA_KEY),
    policy,
    // Session users never carry the code hashes, so count them in the database.
    recoveryCodesRemaining: user.totp_enabled ? (await env.DB.prepare('SELECT json_array_length(recovery_codes) AS n FROM users WHERE id = ?').bind(user.id).first())?.n ?? 0 : 0
  };
}

/**
 * Check a TOTP code or a recovery code for `user` (full DB row). Consumes recovery codes and
 * records the TOTP step so a code can never be used twice. Returns 'totp' | 'recovery' | null.
 */
async function checkSecondFactor(env, user, { code, recoveryCode }) {
  if (recoveryCode) {
    const hash = await M.hashRecovery(recoveryCode);
    const codes = safeJson(user.recovery_codes, []);
    if (!codes.includes(hash)) return null;
    const left = codes.filter(h => h !== hash);
    const res = await env.DB.prepare('UPDATE users SET recovery_codes = ? WHERE id = ? AND recovery_codes = ?').bind(JSON.stringify(left), user.id, user.recovery_codes).run();
    return res.meta.changes === 1 ? 'recovery' : null;
  }
  const secret = await M.decryptSecret(env, user.totp_secret, user.id);
  const step = await M.verifyTotp(secret, code, { lastStep: user.totp_last_step ?? null });
  if (step === null) return null;
  const res = await env.DB.prepare('UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)').bind(step, user.id, step).run();
  return res.meta.changes === 1 ? 'totp' : null; // lost a race with the same code = replay
}

route('POST', '/auth/login/2fa', null, async c => {
  const ch = await c.env.DB.prepare('SELECT * FROM login_challenges WHERE id_hash = ?').bind(await A.sha256(String(c.body.challenge || ''))).first();
  const expired = () => fail(401, 'Your sign-in timed out. Enter your email and password again.', { code: 'challenge_expired' });
  if (!ch || new Date(ch.expires_at) < new Date()) expired();
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(ch.user_id).first();
  if (!user || !user.active || !user.totp_enabled) { await c.env.DB.prepare('DELETE FROM login_challenges WHERE id_hash = ?').bind(ch.id_hash).run(); expired(); }
  if (await A.rateLimited(c.env, `login:${user.email}`, 8, 900)) fail(429, 'Too many failed sign-in attempts. Wait 15 minutes and try again.');
  const method = await checkSecondFactor(c.env, user, { code: c.body.code, recoveryCode: c.body.recoveryCode });
  if (!method) {
    const attempts = ch.attempts + 1;
    if (attempts >= CHALLENGE_ATTEMPTS) await c.env.DB.prepare('DELETE FROM login_challenges WHERE id_hash = ?').bind(ch.id_hash).run();
    else await c.env.DB.prepare('UPDATE login_challenges SET attempts = ? WHERE id_hash = ?').bind(attempts, ch.id_hash).run();
    await A.rateHit(c.env, `login:${user.email}`, 900);
    await A.rateHit(c.env, `login-ip:${c.ip}`, 900);
    await log(c.env, user.id, 'auth.2fa_failed', user.email, { recovery: Boolean(c.body.recoveryCode) }, 'warning', c.ip);
    if (attempts >= CHALLENGE_ATTEMPTS) expired();
    fail(401, c.body.recoveryCode ? 'That recovery code is not valid or was already used.' : 'That code is not correct. Codes change every 30 seconds — make sure your phone\'s clock is set automatically.', { code: 'bad_code', attemptsLeft: CHALLENGE_ATTEMPTS - attempts });
  }
  await c.env.DB.prepare('DELETE FROM login_challenges WHERE id_hash = ?').bind(ch.id_hash).run();
  return finishLogin(c, user, method === 'recovery' ? '2fa-recovery-code' : '2fa-totp');
}, { public: true });

route('POST', '/auth/2fa/setup', null, async c => {
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(c.user.id).first();
  if (user.totp_enabled) {
    // Moving to a new phone: prove possession of the current factor first.
    if (!(await A.verifyPassword(String(c.body.password || ''), user.pw_hash))) fail(403, 'Current password is incorrect.');
    if (!(await checkSecondFactor(c.env, user, c.body))) fail(403, 'Enter a current code from your authenticator app (or a recovery code).');
  }
  const secret = M.newSecret();
  await c.env.DB.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').bind(await M.encryptSecret(c.env, secret, user.id), user.id).run();
  return json({ secret, uri: M.otpauthUri(secret, user.email), issuer: M.ISSUER, account: user.email });
}, { mfaExempt: true });

route('POST', '/auth/2fa/enable', null, async c => {
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(c.user.id).first();
  if (!user.totp_pending) fail(409, 'Start the setup again.');
  const secret = await M.decryptSecret(c.env, user.totp_pending, user.id);
  const step = await M.verifyTotp(secret, c.body.code);
  if (step === null) fail(422, 'That code is not correct. Scan the QR code again or check that your phone\'s clock is set automatically.', { code: 'bad_code' });
  const codes = M.newRecoveryCodes();
  const hashes = await Promise.all(codes.map(M.hashRecovery));
  await c.env.DB.prepare("UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled = 1, totp_last_step = ?, totp_enabled_at = datetime('now'), recovery_codes = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(step, JSON.stringify(hashes), user.id).run();
  await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').bind(user.id, c.session.idHash).run();
  audit(c, user.totp_enabled ? 'auth.2fa_moved_device' : 'auth.2fa_enabled', user.email);
  return json({ ok: true, recoveryCodes: codes });
}, { mfaExempt: true });

route('POST', '/auth/2fa/recovery-codes', null, async c => {
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(c.user.id).first();
  if (!user.totp_enabled) fail(409, 'Two-factor authentication is not enabled.');
  if (!(await checkSecondFactor(c.env, user, { code: c.body.code }))) fail(403, 'Enter a current code from your authenticator app.');
  const codes = M.newRecoveryCodes();
  await c.env.DB.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?').bind(JSON.stringify(await Promise.all(codes.map(M.hashRecovery))), user.id).run();
  audit(c, 'auth.2fa_recovery_regenerated', user.email);
  return json({ recoveryCodes: codes });
});

route('POST', '/auth/2fa/disable', null, async c => {
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(c.user.id).first();
  if (!user.totp_enabled) fail(409, 'Two-factor authentication is not enabled.');
  if (mfaRequiredFor(await mfaPolicy(c.env), user.role)) fail(409, 'Your role must use two-factor authentication. To switch phones, use “Move to a new phone” instead.');
  if (!(await A.verifyPassword(String(c.body.password || ''), user.pw_hash))) fail(403, 'Current password is incorrect.');
  if (!(await checkSecondFactor(c.env, user, c.body))) fail(403, 'Enter a current code from your authenticator app (or a recovery code).');
  await c.env.DB.prepare("UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL, totp_enabled_at = NULL, recovery_codes = '[]' WHERE id = ?").bind(user.id).run();
  audit(c, 'auth.2fa_disabled', user.email);
  return json({ ok: true });
});

route('POST', '/auth/logout', null, async c => {
  await c.env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(c.session.idHash).run();
  return json({ ok: true }, 200, { 'Set-Cookie': A.sessionCookie(c.env, '', 0) });
}, { mfaExempt: true });

route('POST', '/auth/logout-all', null, async c => {
  await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(c.user.id).run();
  audit(c, 'auth.logout_all', c.user.email);
  return json({ ok: true }, 200, { 'Set-Cookie': A.sessionCookie(c.env, '', 0) });
}, { mfaExempt: true });

route('GET', '/auth/me', null, async c => json({ user: publicUser(c.user), caps: [...c.caps], csrf: c.session.csrf, mfa: await mfaStatus(c.env, c.user) }), { mfaExempt: true });

route('GET', '/auth/sessions', null, async c => {
  const rows = (await c.env.DB.prepare('SELECT created_at, last_seen, expires_at, ip, ua, id_hash = ? AS current FROM sessions WHERE user_id = ? ORDER BY last_seen DESC').bind(c.session.idHash, c.user.id).all()).results;
  return json({ sessions: rows });
});

route('POST', '/auth/password', null, async c => {
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(c.user.id).first();
  if (!(await A.verifyPassword(String(c.body.current || ''), user.pw_hash))) fail(403, 'Current password is incorrect.');
  const problems = A.passwordProblems(c.body.next);
  if (problems.length) fail(422, problems.join(' '));
  await c.env.DB.prepare("UPDATE users SET pw_hash = ?, updated_at = datetime('now') WHERE id = ?").bind(await A.hashPassword(c.body.next), user.id).run();
  await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').bind(user.id, c.session.idHash).run();
  audit(c, 'auth.password_changed', user.email);
  return json({ ok: true });
});

route('POST', '/auth/reset', null, async c => {
  if (!(await A.rateLimit(c.env, `reset:${c.ip}`, 10, 900))) fail(429, 'Too many attempts.');
  const hash = await A.sha256(String(c.body.token || ''));
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE reset_hash = ? AND active = 1').bind(hash).first();
  if (!user || !user.reset_expires || new Date(user.reset_expires) < new Date()) fail(400, 'This reset link is invalid or has expired. Ask an administrator for a new one.');
  const problems = A.passwordProblems(c.body.password);
  if (problems.length) fail(422, problems.join(' '));
  await c.env.DB.prepare("UPDATE users SET pw_hash = ?, reset_hash = NULL, reset_expires = NULL, updated_at = datetime('now') WHERE id = ?").bind(await A.hashPassword(c.body.password), user.id).run();
  await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();
  await log(c.env, user.id, 'auth.password_reset', user.email, null, 'info', c.ip);
  return json({ ok: true });
}, { public: true });

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, active: Boolean(u.active), caps: safeJson(u.caps, {}), created_at: u.created_at, last_login: u.last_login, twoFactor: Boolean(u.totp_enabled) };
}
function safeJson(text, fallback) { try { return JSON.parse(text); } catch { return fallback; } }

/* ---------------------------------------------------------- Users ---- */

route('GET', '/users', 'users.manage', async c => {
  const rows = (await c.env.DB.prepare('SELECT * FROM users ORDER BY id').all()).results;
  return json({ users: rows.map(publicUser), roles: A.ROLES, caps: A.ALL_CAPS });
});

function validCaps(caps) {
  const grant = (caps?.grant || []).filter(x => A.ALL_CAPS.includes(x));
  const revoke = (caps?.revoke || []).filter(x => A.ALL_CAPS.includes(x));
  return JSON.stringify({ grant, revoke });
}

route('POST', '/users', 'users.manage', async c => {
  const email = str(c.body.email, 200).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(422, 'Enter a valid email address.');
  if (!A.ROLES.includes(c.body.role)) fail(422, 'Choose a valid role.');
  let password = c.body.password;
  if (password) { const p = A.passwordProblems(password); if (p.length) fail(422, p.join(' ')); } else password = A.randomToken(24);
  const exists = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (exists) fail(409, 'A user with that email already exists.');
  const res = await c.env.DB.prepare('INSERT INTO users (email, name, role, caps, pw_hash) VALUES (?,?,?,?,?)').bind(email, str(c.body.name, 100), c.body.role, validCaps(c.body.caps), await A.hashPassword(password)).run();
  const id = res.meta.last_row_id;
  audit(c, 'user.created', email, { role: c.body.role });
  const link = c.body.password ? null : await makeResetLink(c, id, 72);
  return json({ user: publicUser(await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first()), setupLink: link }, 201);
});

async function adminCount(env, excludeId) {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'administrator' AND active = 1 AND id != ?").bind(excludeId).first()).n;
}

route('PATCH', '/users/:id', 'users.manage', async c => {
  const id = intId(c.params.id);
  const u = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!u) fail(404, 'User not found.');
  const role = c.body.role ?? u.role;
  if (!A.ROLES.includes(role)) fail(422, 'Choose a valid role.');
  const active = c.body.active === undefined ? u.active : (c.body.active ? 1 : 0);
  if (u.role === 'administrator' && (role !== 'administrator' || !active) && await adminCount(c.env, id) === 0) fail(409, 'At least one active administrator is required.');
  const caps = c.body.caps === undefined ? u.caps : validCaps(c.body.caps);
  await c.env.DB.prepare("UPDATE users SET name = ?, role = ?, active = ?, caps = ?, updated_at = datetime('now') WHERE id = ?").bind(c.body.name !== undefined ? str(c.body.name, 100) : u.name, role, active, caps, id).run();
  if (!active || role !== u.role) await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
  audit(c, 'user.updated', u.email, { role, active });
  return json({ user: publicUser(await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first()) });
});

route('DELETE', '/users/:id', 'users.manage', async c => {
  const id = intId(c.params.id);
  if (id === c.user.id) fail(409, 'You cannot delete your own account.');
  const u = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!u) fail(404, 'User not found.');
  if (u.role === 'administrator' && await adminCount(c.env, id) === 0) fail(409, 'At least one active administrator is required.');
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  audit(c, 'user.deleted', u.email);
  return json({ ok: true });
});

async function makeResetLink(c, id, hours = 1) {
  const token = A.randomToken(32);
  await c.env.DB.prepare('UPDATE users SET reset_hash = ?, reset_expires = ? WHERE id = ?').bind(await A.sha256(token), new Date(Date.now() + hours * 3600e3).toISOString(), id).run();
  return `${c.url.origin}/admin/#reset=${token}`;
}

route('POST', '/users/:id/reset-2fa', 'users.manage', async c => {
  const id = intId(c.params.id);
  if (id === c.user.id) fail(409, 'Manage your own two-factor settings from your Account page.');
  const u = await c.env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(id).first();
  if (!u) fail(404, 'User not found.');
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL, totp_enabled_at = NULL, recovery_codes = '[]' WHERE id = ?").bind(id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM login_challenges WHERE user_id = ?').bind(id)
  ]);
  await log(c.env, c.user.id, 'user.2fa_reset', u.email, null, 'warning', c.ip);
  return json({ ok: true, note: 'Two-factor authentication was removed and the user was signed out. If 2FA is required for their role, they will set it up again at their next sign-in.' });
});

route('POST', '/users/:id/reset-link', 'users.manage', async c => {
  const id = intId(c.params.id);
  const u = await c.env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(id).first();
  if (!u) fail(404, 'User not found.');
  const link = await makeResetLink(c, id, 24);
  audit(c, 'user.reset_link', u.email);
  return json({ url: link, expiresInHours: 24 });
});

/* ------------------------------------------------------------ Pages ---- */

const PAGE_LIST_COLS = 'p.id, p.path, p.url, p.title, p.template, p.status, p.visibility, p.parent_id, p.menu_order, p.author_id, p.modified_by, p.scheduled_at, p.published_at, p.updated_at, p.created_at, p.version, p.sitemap, p.draft_html IS NOT NULL AS has_draft, p.lock_user, p.lock_until, u.name AS author_name, m.name AS modified_name';

route('GET', '/pages', 'pages.read', async c => {
  const rows = (await c.env.DB.prepare(`SELECT ${PAGE_LIST_COLS} FROM pages p LEFT JOIN users u ON u.id = p.author_id LEFT JOIN users m ON m.id = p.modified_by ORDER BY p.status = 'trash', p.url`).all()).results;
  const counts = (await c.env.DB.prepare('SELECT COUNT(*) AS n FROM pages').first()).n;
  return json({ pages: rows.map(p => ({ ...p, has_draft: Boolean(p.has_draft), state: pageState(p) })), total: counts });
});

function pageState(p) {
  if (p.status === 'trash') return 'trash';
  if (p.status === 'scheduled') return 'scheduled';
  if (p.status === 'draft') return 'draft';
  return p.visibility === 'public' ? 'published' : p.visibility; // private | password
}

function canEdit(c, p) { return c.caps.has('pages.edit_any') || (c.caps.has('pages.edit_own') && p.author_id === c.user.id); }
function canPublish(c, p) { return c.caps.has('pages.publish_any') || (c.caps.has('pages.publish_own') && p.author_id === c.user.id); }
function canDelete(c, p) { return c.caps.has('pages.delete_any') || (c.caps.has('pages.delete_own') && p.author_id === c.user.id); }

async function getPage(c, id, need = 'read') {
  const p = await c.env.DB.prepare('SELECT * FROM pages WHERE id = ?').bind(intId(id)).first();
  if (!p) fail(404, 'Page not found.');
  if (need === 'edit' && !canEdit(c, p)) fail(403, 'You can only edit pages assigned to you.');
  if (need === 'publish' && !canPublish(c, p)) fail(403, 'Your role cannot publish this page.');
  if (need === 'delete' && !canDelete(c, p)) fail(403, 'Your role cannot delete this page.');
  return p;
}

const EXCLUDE_PAGE = p => p.startsWith('admin/') || p.startsWith('cms/') || p.startsWith('.') || /^google[^/]*\.html$/i.test(p) || p.startsWith('assets/');

route('POST', '/pages/sync', 'pages.edit_any', async c => {
  const gh = new GitHub(c.env);
  const { files } = await gh.tree();
  const htmlPaths = [...files.keys()].filter(p => /\.html?$/i.test(p) && !EXCLUDE_PAGE(p));
  const existing = new Map((await c.env.DB.prepare('SELECT id, path, status, visibility, live_sha FROM pages').all()).results.map(p => [p.path, p]));
  const added = [], updated = [], missing = [];
  for (const path of htmlPaths) {
    const sha = files.get(path).sha;
    const row = existing.get(path);
    if (row && row.live_sha === sha) continue;
    const text = await gh.blobText(sha);
    const doc = H.parse(text);
    const title = (doc.querySelector('main h1, h1')?.textContent || doc.querySelector('title')?.textContent || path).trim().replace(/\s+/g, ' ').slice(0, 200);
    const seo = H.readSeo(text, path);
    const template = H.detectTemplate(doc, path);
    if (!row) {
      const parsed = H.readSeo(text, path);
      await c.env.DB.prepare(`INSERT INTO pages (path, url, title, template, status, visibility, author_id, modified_by, live_sha, published_html, seo, sitemap, breadcrumbs, published_at)
        VALUES (?,?,?,?, 'published', 'public', ?, ?, ?, ?, ?, ?, ?, ?)`).bind(path, H.urlForPath(path), title, template, c.user.id, c.user.id, sha, text, JSON.stringify(parsed), parsed.index ? 1 : 0, parsed.breadcrumbs ? 1 : 0, doc.querySelector('meta[property="article:published_time"]')?.getAttribute('content') || sqlNow()).run();
      const id = (await c.env.DB.prepare('SELECT id FROM pages WHERE path = ?').bind(path).first()).id;
      await c.env.DB.prepare("INSERT INTO revisions (page_id, kind, title, html, seo, user_id, page_version) VALUES (?, 'import', ?, ?, ?, ?, 1)").bind(id, title, text, JSON.stringify(parsed), c.user.id).run();
      added.push(path);
    } else {
      // File changed outside the CMS (e.g. a direct commit). Record it as the new live version.
      await c.env.DB.prepare("UPDATE pages SET live_sha = ?, published_html = ?, title = ?, template = ?, seo = ?, status = CASE WHEN status = 'trash' THEN status ELSE 'published' END, visibility = 'public', updated_at = datetime('now') WHERE id = ?").bind(sha, text, title, template, JSON.stringify(seo), row.id).run();
      await c.env.DB.prepare("INSERT INTO revisions (page_id, kind, title, html, seo, user_id) VALUES (?, 'import', ?, ?, ?, ?)").bind(row.id, title, text, JSON.stringify(seo), c.user.id).run();
      updated.push(path);
    }
  }
  for (const [path, row] of existing) {
    if (row.status === 'published' && row.visibility === 'public' && !files.has(path)) {
      await c.env.DB.prepare("UPDATE pages SET status = 'draft', live_sha = NULL, draft_html = COALESCE(draft_html, published_html), updated_at = datetime('now') WHERE id = ?").bind(row.id).run();
      missing.push(path);
    }
  }
  if (added.length || updated.length || missing.length) await bump(c.env, 'content_version');
  audit(c, 'pages.sync', null, { added: added.length, updated: updated.length, missing });
  return json({ added, updated, missing });
});

route('GET', '/pages/link-targets', 'pages.read', async c => {
  const rows = (await c.env.DB.prepare("SELECT id, url, title, path, visibility, status, COALESCE(draft_html, published_html) AS html FROM pages WHERE status != 'trash' ORDER BY url").all()).results;
  return json({
    targets: rows.map(r => {
      let sections = [];
      try {
        const doc = H.parse(r.html || '');
        const root = doc.querySelector('article.article') || doc.querySelector('main') || doc.body;
        sections = [...root.querySelectorAll('h1[id],h2[id],h3[id],section[id]')].map(el => ({ id: el.getAttribute('id'), label: el.textContent.trim().replace(/\s+/g, ' ').slice(0, 90) || el.getAttribute('id') }));
      } catch { /* ignore */ }
      return { id: r.id, url: r.url, title: r.title, published: r.status === 'published', visibility: r.visibility, sections };
    })
  });
});

async function liveHtml(c, p) {
  if (p.status === 'published' && p.visibility === 'public' && p.live_sha) {
    try {
      const gh = new GitHub(c.env);
      const { files } = await gh.tree();
      const entry = files.get(p.path);
      if (entry) return { html: entry.sha === p.live_sha && p.published_html ? p.published_html : await gh.blobText(entry.sha), sha: entry.sha, external: entry.sha !== p.live_sha };
    } catch (e) { if (!p.published_html) throw e; }
  }
  return { html: p.published_html || '', sha: p.live_sha, external: false };
}

async function pageTerms(env, id) {
  return (await env.DB.prepare('SELECT t.* FROM terms t JOIN page_terms pt ON pt.term_id = t.id WHERE pt.page_id = ?').bind(id).all()).results;
}

route('GET', '/pages/:id', 'pages.read', async c => {
  const p = await getPage(c, c.params.id);
  const live = p.draft_html ? null : await liveHtml(c, p);
  const source = p.draft_html || live.html;
  const regions = source ? H.extractEditable(source, p.path) : { template: p.template, body: '', hero: {} };
  const seo = { ...H.readSeo(source || '', p.path), ...safeJson(p.seo, {}), sitemap: Boolean(p.sitemap), breadcrumbs: Boolean(p.breadcrumbs) };
  const lockedBy = p.lock_user && p.lock_user !== c.user.id && p.lock_until && new Date(p.lock_until) > new Date()
    ? await c.env.DB.prepare('SELECT id, name, email FROM users WHERE id = ?').bind(p.lock_user).first() : null;
  const { draft_html, published_html, password_hash, ...meta } = p;
  const headDoc = H.parse(source || '');
  const assets = {
    styles: [...headDoc.querySelectorAll('head style')].map(s => s.textContent).join('\n'),
    stylesheets: [...headDoc.querySelectorAll('head link[rel="stylesheet"]')].map(l => new URL(l.getAttribute('href'), `${H.SITE}${p.url}`).pathname)
  };
  return json({
    assets,
    page: { ...meta, state: pageState(p), has_draft: Boolean(draft_html), has_password: Boolean(password_hash), externalChange: Boolean(live?.external) },
    regions, seo, terms: await pageTerms(c.env, p.id), lockedBy,
    permissions: { edit: canEdit(c, p), publish: canPublish(c, p), delete: canDelete(c, p), unfiltered: c.caps.has('unfiltered_html'), privateVisibility: c.caps.has('pages.private'), seoAdvanced: c.caps.has('seo.advanced') }
  });
});

async function breadcrumbTrail(env, p) {
  const trail = [];
  let cur = p; const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    trail.unshift({ name: cur.title, url: cur.url });
    cur = cur.parent_id ? await env.DB.prepare('SELECT id, title, url, parent_id FROM pages WHERE id = ?').bind(cur.parent_id).first() : null;
  }
  if (p.url !== '/') trail.unshift({ name: 'Home', url: '/' });
  return trail;
}

function cleanSeo(input = {}, c, existing = {}) {
  const s = {};
  const take = (k, max) => { if (input[k] !== undefined) s[k] = str(input[k], max); };
  take('title', 200); take('description', 400); take('canonical', 600); take('robotsExtra', 200);
  take('ogTitle', 200); take('ogDescription', 400); take('ogImage', 600); take('ogImageAlt', 300); take('ogType', 40);
  take('twitterCard', 40); take('twitterTitle', 200); take('twitterDescription', 400); take('twitterImage', 600);
  if (input.index !== undefined) s.index = Boolean(input.index);
  if (input.follow !== undefined) s.follow = Boolean(input.follow);
  if (input.schema !== undefined) {
    if (!c.caps.has('seo.advanced')) { if (str(input.schema, 50000) !== str(existing.schema, 50000)) fail(403, 'Your role cannot edit schema markup.'); }
    else s.schema = str(input.schema, 50000);
  }
  if (!c.caps.has('seo.advanced')) {
    for (const k of ['canonical', 'robotsExtra']) if (s[k] !== undefined && s[k] !== (existing[k] || '')) fail(403, `Your role cannot change ${k === 'canonical' ? 'the canonical URL' : 'robots directives'}.`);
    if ((s.index !== undefined && s.index !== (existing.index ?? true)) || (s.follow !== undefined && s.follow !== (existing.follow ?? true))) fail(403, 'Your role cannot change index/follow settings.');
  }
  const problems = H.validateSeo({ ...s, sitemap: false });
  if (problems.length) fail(422, problems.join(' '));
  return s;
}

async function termsMeta(env, id) {
  const terms = await pageTerms(env, id);
  return { categories: terms.filter(t => t.taxonomy === 'category').map(t => t.name), tags: terms.filter(t => t.taxonomy === 'tag').map(t => t.name) };
}

function applyTermsMeta(html, terms) {
  const doc = H.parse(html);
  doc.head.querySelectorAll('meta[property="article:section"], meta[property="article:tag"]').forEach(el => el.remove());
  if (doc.head.querySelector('meta[property="og:type"]')?.getAttribute('content') === 'article') {
    if (terms.categories[0]) H.appendHead(doc, `<meta property="article:section" content="${H.escapeAttr(terms.categories[0])}">`);
    for (const t of terms.tags) H.appendHead(doc, `<meta property="article:tag" content="${H.escapeAttr(t)}">`);
  }
  return H.serialize(doc);
}

route('PUT', '/pages/:id/draft', ['pages.edit_own', 'pages.edit_any'], async c => {
  const p = await getPage(c, c.params.id, 'edit');
  if (p.status === 'trash') fail(409, 'Restore this page from the trash before editing it.');
  const b = c.body;
  if (Number(b.base_version) !== p.version) {
    const who = p.modified_by ? await c.env.DB.prepare('SELECT name, email FROM users WHERE id = ?').bind(p.modified_by).first() : null;
    fail(409, `This page was changed by ${who?.name || who?.email || 'someone else'} at ${p.updated_at} UTC after you opened it. Reload to see their version; your text is kept in the editor so you can copy it.`, { code: 'version_conflict', version: p.version });
  }
  if (p.lock_user && p.lock_user !== c.user.id && p.lock_until && new Date(p.lock_until) > new Date() && !b.takeover) {
    fail(423, 'Another user is editing this page right now.', { code: 'locked' });
  }
  let base_sha = p.base_sha;
  let base = p.draft_html;
  if (!base) { const live = await liveHtml(c, p); base = live.html; base_sha = live.sha || null; }
  if (!base) fail(409, 'The page source could not be loaded.');
  const existingSeo = { ...H.readSeo(base, p.path), ...safeJson(p.seo, {}) };
  const seoIn = cleanSeo(b.seo || {}, c, existingSeo);
  const seo = { ...existingSeo, ...seoIn };
  const sitemap = b.sitemap === undefined ? p.sitemap : (b.sitemap && seo.index !== false ? 1 : 0);
  const breadcrumbs = b.breadcrumbs === undefined ? p.breadcrumbs : (b.breadcrumbs ? 1 : 0);
  const parentId = b.parent_id === undefined ? p.parent_id : (b.parent_id ? intId(b.parent_id) : null);
  if (parentId) {
    if (parentId === p.id) fail(422, 'A page cannot be its own parent.');
    let cur = parentId; const seen = new Set();
    while (cur) { if (seen.has(cur) || cur === p.id) fail(422, 'That parent would create a loop in the page hierarchy.'); seen.add(cur); cur = (await c.env.DB.prepare('SELECT parent_id FROM pages WHERE id = ?').bind(cur).first())?.parent_id; }
  }
  let body = typeof b.body === 'string' ? b.body : undefined;
  if (body !== undefined && body.length > 2_000_000) fail(413, 'Page content is too large.');
  if (body !== undefined && !c.caps.has('unfiltered_html')) body = H.sanitizeFragment(body);
  const hero = b.hero && typeof b.hero === 'object' ? Object.fromEntries(['eyebrow', 'headline', 'lead', 'date'].filter(k => b.hero[k] !== undefined).map(k => [k, str(b.hero[k], 600)])) : undefined;
  let html = H.composeEditable(base, p.path, { body, hero }, { allowRemoveProtected: Boolean(b.allowRemoveProtected) && c.caps.has('unfiltered_html') });
  html = H.applySeo(html, p.path, { ...seo, breadcrumbs: Boolean(breadcrumbs) }, { trail: await breadcrumbTrail(c.env, { ...p, parent_id: parentId }) });
  const title = str(b.title, 200) || (hero?.headline) || p.title;
  const kind = b.autosave ? 'autosave' : 'draft';
  const version = p.version + 1;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE pages SET draft_html = ?, base_sha = ?, seo = ?, sitemap = ?, breadcrumbs = ?, parent_id = ?, menu_order = ?, title = ?, version = ?, modified_by = ?, lock_user = ?, lock_until = ?, updated_at = datetime('now') WHERE id = ? AND version = ?")
      .bind(html, base_sha, JSON.stringify(seo), sitemap, breadcrumbs, parentId, Number.isInteger(b.menu_order) ? b.menu_order : p.menu_order, title, version, c.user.id, c.user.id, new Date(Date.now() + 90e3).toISOString(), p.id, p.version),
    ...(kind === 'autosave' ? [c.env.DB.prepare("DELETE FROM revisions WHERE page_id = ? AND kind = 'autosave' AND user_id = ?").bind(p.id, c.user.id)] : []),
    c.env.DB.prepare('INSERT INTO revisions (page_id, kind, title, html, seo, user_id, page_version) VALUES (?,?,?,?,?,?,?)').bind(p.id, kind, title, html, JSON.stringify(seo), c.user.id, version)
  ]);
  if (Array.isArray(b.terms)) await setTerms(c, p.id, b.terms);
  if (kind !== 'autosave') audit(c, 'page.draft_saved', p.url, { version });
  return json({ ok: true, version, savedAt: nowIso(), kind });
});

async function setTerms(c, pageId, ids) {
  const clean = [...new Set(ids.map(Number).filter(Number.isInteger))].slice(0, 50);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM page_terms WHERE page_id = ?').bind(pageId),
    ...clean.map(t => c.env.DB.prepare('INSERT OR IGNORE INTO page_terms (page_id, term_id) SELECT ?, id FROM terms WHERE id = ?').bind(pageId, t))
  ]);
}

route('POST', '/pages/:id/lock', ['pages.edit_own', 'pages.edit_any'], async c => {
  const p = await getPage(c, c.params.id, 'edit');
  if (p.lock_user && p.lock_user !== c.user.id && p.lock_until && new Date(p.lock_until) > new Date() && !c.body.takeover) {
    const who = await c.env.DB.prepare('SELECT name, email FROM users WHERE id = ?').bind(p.lock_user).first();
    return json({ locked: true, by: who, version: p.version });
  }
  await c.env.DB.prepare('UPDATE pages SET lock_user = ?, lock_until = ? WHERE id = ?').bind(c.user.id, new Date(Date.now() + 90e3).toISOString(), p.id).run();
  return json({ locked: false, version: p.version });
});

route('DELETE', '/pages/:id/lock', ['pages.edit_own', 'pages.edit_any'], async c => {
  await c.env.DB.prepare('UPDATE pages SET lock_user = NULL, lock_until = NULL WHERE id = ? AND lock_user = ?').bind(intId(c.params.id), c.user.id).run();
  return json({ ok: true });
});

route('POST', '/pages/:id/discard-draft', ['pages.edit_own', 'pages.edit_any'], async c => {
  const p = await getPage(c, c.params.id, 'edit');
  if (p.status !== 'published' && p.status !== 'scheduled') fail(409, 'This page has never been published, so its draft is the page itself. Move it to the trash instead.');
  await c.env.DB.prepare("UPDATE pages SET draft_html = NULL, base_sha = NULL, version = version + 1, status = 'published', scheduled_at = NULL, modified_by = ?, updated_at = datetime('now') WHERE id = ?").bind(c.user.id, p.id).run();
  audit(c, 'page.draft_discarded', p.url);
  return json({ ok: true });
});

/* ---------- Publishing ---------- */

async function primaryMenuItems(env) {
  const m = await env.DB.prepare("SELECT published_items FROM menus WHERE location = 'primary'").first();
  return m?.published_items ? safeJson(m.published_items, null) : null;
}

async function finalHtml(c, p, html) {
  const seo = safeJson(p.seo, {});
  let out = H.applySeo(html, p.path, { ...seo, breadcrumbs: Boolean(p.breadcrumbs) }, { trail: await breadcrumbTrail(c.env, p) });
  out = applyTermsMeta(out, await termsMeta(c.env, p.id));
  const nav = await primaryMenuItems(c.env);
  if (nav) out = H.applyNav(out, p.path, nav);
  return out;
}

async function sitemapText(env, overrides = new Map()) {
  const rows = (await env.DB.prepare("SELECT id, url, status, visibility, sitemap, seo, published_at, updated_at FROM pages").all()).results;
  const entries = [];
  for (const r0 of rows) {
    const r = { ...r0, ...(overrides.get(r0.id) || {}) };
    if (r.status !== 'published' || r.visibility !== 'public' || !r.sitemap) continue;
    const seo = safeJson(r.seo, {});
    if (seo.index === false) continue;
    if (seo.canonical && seo.canonical !== `${H.SITE}${r.url}`) continue; // canonicalised elsewhere
    entries.push({ loc: `${H.SITE}${r.url}`, lastmod: String(r.updated_at || r.published_at || '').slice(0, 10) });
  }
  entries.sort((a, b) => (a.loc === `${H.SITE}/` ? -1 : b.loc === `${H.SITE}/` ? 1 : a.loc.localeCompare(b.loc)));
  return H.renderSitemap(entries);
}

async function publishPage(c, p, { force = false, userId } = {}) {
  const gh = new GitHub(c.env);
  const live = p.draft_html ? null : await liveHtml(c, p);
  let source = p.draft_html || live?.html;
  if (!source) fail(409, 'Nothing to publish.');
  const html = await finalHtml(c, p, source);
  const today = sqlNow();
  const after = { status: 'published', updated_at: today, published_at: p.published_at || today };
  let liveSha = p.live_sha;
  if (p.visibility === 'public') {
    const expect = force ? undefined : (p.draft_html ? (p.base_sha ?? null) : (live?.sha ?? null));
    const changes = [{ path: p.path, text: html, expectSha: expect }];
    changes.push({ path: 'sitemap.xml', text: await sitemapText(c.env, new Map([[p.id, after]])) });
    const result = await gh.commit(changes, `Publish ${p.url}: ${p.title}`.slice(0, 120), { author: c.user ? { name: c.user.name, email: c.user.email } : undefined });
    liveSha = result.files[p.path];
  } else {
    // Private / password pages never live in the public repository.
    const { files } = await gh.tree();
    if (files.has(p.path)) {
      await gh.commit([{ path: p.path, delete: true }, { path: 'sitemap.xml', text: await sitemapText(c.env, new Map([[p.id, { ...after, visibility: p.visibility }]])) }], `Remove ${p.url} from public site (${p.visibility})`);
    }
    liveSha = null;
  }
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE pages SET status = 'published', draft_html = NULL, base_sha = NULL, published_html = ?, live_sha = ?, published_at = COALESCE(published_at, ?), scheduled_at = NULL, version = version + 1, modified_by = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(html, liveSha, today, userId ?? c.user?.id ?? null, p.id),
    c.env.DB.prepare("INSERT INTO revisions (page_id, kind, title, html, seo, user_id, page_version) VALUES (?, 'publish', ?, ?, ?, ?, ?)").bind(p.id, p.title, html, p.seo, userId ?? c.user?.id ?? null, p.version + 1)
  ]);
  await bump(c.env, 'content_version');
  return { url: p.url, visibility: p.visibility };
}

route('POST', '/pages/:id/publish', ['pages.publish_own', 'pages.publish_any'], async c => {
  const p = await getPage(c, c.params.id, 'publish');
  if (p.status === 'trash') fail(409, 'Restore this page from the trash first.');
  if (c.body.base_version !== undefined && Number(c.body.base_version) !== p.version) fail(409, 'The page changed since you opened it. Reload before publishing.', { code: 'version_conflict' });
  if (p.visibility === 'password' && !p.password_hash) fail(422, 'Set a password before publishing a password-protected page.');
  const out = await publishPage(c, p, { force: Boolean(c.body.force) && c.caps.has('pages.publish_any') });
  audit(c, 'page.published', p.url, out);
  return json({ ok: true, ...out });
});

route('POST', '/pages/:id/schedule', ['pages.publish_own', 'pages.publish_any'], async c => {
  const p = await getPage(c, c.params.id, 'publish');
  const at = new Date(c.body.at);
  if (Number.isNaN(at.getTime())) fail(422, 'Choose a valid date and time.');
  if (at.getTime() < Date.now() + 60e3) fail(422, 'Choose a time at least one minute in the future.');
  if (!p.draft_html && p.status === 'published') fail(409, 'There are no unpublished changes to schedule.');
  if (p.visibility === 'password' && !p.password_hash) fail(422, 'Set a password first.');
  // A scheduled update to an already-live page keeps the live version online until the scheduled time.
  const newStatus = p.status === 'published' ? 'published' : 'scheduled';
  await c.env.DB.prepare("UPDATE pages SET status = ?, scheduled_at = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?").bind(newStatus, at.toISOString(), p.id).run();
  audit(c, 'page.scheduled', p.url, { at: at.toISOString() });
  return json({ ok: true, scheduled_at: at.toISOString() });
});

route('POST', '/pages/:id/unschedule', ['pages.publish_own', 'pages.publish_any'], async c => {
  const p = await getPage(c, c.params.id, 'publish');
  await c.env.DB.prepare("UPDATE pages SET status = CASE WHEN status = 'scheduled' THEN 'draft' ELSE status END, scheduled_at = NULL, version = version + 1, updated_at = datetime('now') WHERE id = ?").bind(p.id).run();
  audit(c, 'page.unscheduled', p.url);
  return json({ ok: true });
});

async function runScheduled(env) {
  const due = (await env.DB.prepare("SELECT * FROM pages WHERE scheduled_at IS NOT NULL AND scheduled_at <= ? AND status IN ('scheduled','published')").bind(nowIso()).all()).results;
  const c = { env, ctx: { waitUntil: () => {} }, user: null, caps: new Set(A.ALL_CAPS) };
  for (const p of due) {
    try {
      const out = await publishPage(c, p, { userId: p.modified_by });
      await log(env, p.modified_by, 'page.published_scheduled', p.url, out);
    } catch (e) {
      await env.DB.prepare('UPDATE pages SET scheduled_at = NULL WHERE id = ?').bind(p.id).run();
      await log(env, p.modified_by, 'page.schedule_failed', p.url, { message: e.message }, 'error');
    }
  }
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('cron_last_run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(nowIso()).run();
  return due.length;
}

route('POST', '/pages/:id/unpublish', ['pages.publish_own', 'pages.publish_any'], async c => {
  const p = await getPage(c, c.params.id, 'publish');
  if (p.status !== 'published') fail(409, 'This page is not published.');
  await unpublish(c, p);
  audit(c, 'page.unpublished', p.url);
  return json({ ok: true });
});

async function unpublish(c, p, statusAfter = 'draft') {
  const live = p.draft_html ? null : await liveHtml(c, p);
  const draft = p.draft_html || live?.html || p.published_html;
  if (p.visibility === 'public') {
    const gh = new GitHub(c.env);
    const { files } = await gh.tree();
    const changes = [{ path: 'sitemap.xml', text: await sitemapText(c.env, new Map([[p.id, { status: statusAfter }]])) }];
    if (files.has(p.path)) changes.unshift({ path: p.path, delete: true });
    await gh.commit(changes, `Unpublish ${p.url}`);
  }
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE pages SET status = ?, trashed_from = CASE WHEN ? = 'trash' THEN status ELSE trashed_from END, draft_html = ?, live_sha = NULL, base_sha = NULL, scheduled_at = NULL, version = version + 1, modified_by = ?, updated_at = datetime('now') WHERE id = ?").bind(statusAfter, statusAfter, draft, c.user.id, p.id),
    c.env.DB.prepare("INSERT INTO revisions (page_id, kind, title, html, seo, user_id) VALUES (?, 'unpublish', ?, ?, ?, ?)").bind(p.id, p.title, draft, p.seo, c.user.id)
  ]);
  await bump(c.env, 'content_version');
}

route('POST', '/pages/:id/visibility', ['pages.publish_own', 'pages.publish_any'], async c => {
  const p = await getPage(c, c.params.id, 'publish');
  const vis = c.body.visibility;
  if (!['public', 'private', 'password'].includes(vis)) fail(422, 'Choose public, private or password.');
  if (vis !== 'public' && !c.caps.has('pages.private')) fail(403, 'Your role cannot make pages private.');
  if (p.url === '/' && vis !== 'public') fail(422, 'The homepage must stay public.');
  let pwHash = p.password_hash;
  if (vis === 'password') {
    if (c.body.password) {
      if (String(c.body.password).length < 6) fail(422, 'Use a page password of at least 6 characters.');
      pwHash = await A.hashPassword(String(c.body.password));
    } else if (!pwHash) fail(422, 'Enter a password for this page.');
  }
  if (vis !== 'password') pwHash = null;
  await c.env.DB.prepare("UPDATE pages SET visibility = ?, password_hash = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?").bind(vis, pwHash, p.id).run();
  const updated = await c.env.DB.prepare('SELECT * FROM pages WHERE id = ?').bind(p.id).first();
  if (p.status === 'published' && (p.visibility !== vis)) {
    // Move between the public repository and the Worker immediately, using the live content (not the draft).
    const live = await liveHtml(c, p);
    await publishPage(c, { ...updated, draft_html: null, published_html: live.html || p.published_html, live_sha: p.live_sha }, { force: false });
    // Keep any unpublished draft the user had.
    if (p.draft_html) await c.env.DB.prepare('UPDATE pages SET draft_html = ?, base_sha = ? WHERE id = ?').bind(p.draft_html, p.base_sha, p.id).run();
  }
  await bump(c.env, 'content_version');
  audit(c, 'page.visibility', p.url, { from: p.visibility, to: vis });
  return json({ ok: true, visibility: vis, warning: p.visibility === 'public' && vis !== 'public' && p.status === 'published' ? 'The page was removed from the public repository and is now served only to authorised visitors. Earlier public versions remain in the public git history.' : null });
});

route('POST', '/pages', 'pages.create', async c => {
  const title = str(c.body.title, 200);
  if (!title) fail(422, 'Enter a title.');
  const slug = H.slugify(c.body.slug || title);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) fail(422, 'Use lowercase letters, numbers and hyphens for the slug.');
  let parentPath = '';
  let parentId = null;
  if (c.body.parent_id) {
    const parent = await c.env.DB.prepare('SELECT id, path FROM pages WHERE id = ?').bind(intId(c.body.parent_id)).first();
    if (!parent) fail(422, 'Parent page not found.');
    if (!/\/index\.html$/.test(parent.path)) fail(422, 'Only folder-style pages (/name/) can have child pages nested under their URL.');
    parentPath = parent.path; parentId = parent.id;
  }
  const template = c.body.template === 'basic' ? 'basic' : 'article';
  const tpl = await c.env.DB.prepare("SELECT COALESCE(published_html, draft_html) AS html FROM pages WHERE template = 'article' AND status != 'trash' AND (published_html IS NOT NULL OR draft_html IS NOT NULL) ORDER BY (path = 'seo-vs-geo-case-study/index.html') DESC, id LIMIT 1").first();
  if (!tpl?.html) fail(409, 'No article template is available. Run "Sync from repository" first.');
  let { path, html } = H.newArticleHtml(tpl.html, { slug, title, description: str(c.body.description, 400), parentPath });
  if (template === 'basic') {
    const doc = H.parse(html);
    doc.querySelector('.article-layout')?.replaceWith(Object.assign(doc.createElement('div'), { className: 'page-body' }));
    const body = doc.querySelector('.page-body');
    if (body) { body.innerHTML = '<article class="article"><p></p></article>'; }
    doc.querySelector('.hero .meta')?.remove();
    html = H.serialize(doc);
  }
  const url = H.urlForPath(path);
  const clash = await c.env.DB.prepare('SELECT id FROM pages WHERE path = ? OR url = ?').bind(path, url).first();
  if (clash) fail(409, 'That URL is already used by another page.');
  const redirectClash = R.match(R.compile((await c.env.DB.prepare('SELECT * FROM redirects WHERE active = 1').all()).results), `${H.SITE}${url}`);
  const seo = H.readSeo(html, path);
  const res = await c.env.DB.prepare("INSERT INTO pages (path, url, title, template, status, visibility, parent_id, author_id, modified_by, draft_html, seo, sitemap) VALUES (?,?,?,?, 'draft', 'public', ?, ?, ?, ?, ?, 1)")
    .bind(path, url, title, 'article', parentId, c.user.id, c.user.id, html, JSON.stringify(seo)).run();
  audit(c, 'page.created', url);
  return json({ id: res.meta.last_row_id, url, warning: redirectClash ? `An active redirect (${redirectClash.rule.source}) currently sends this URL elsewhere. Visitors will be redirected until you change that rule.` : null }, 201);
});

route('POST', '/pages/:id/duplicate', 'pages.create', async c => {
  const p = await getPage(c, c.params.id);
  const src = p.draft_html || (await liveHtml(c, p)).html;
  const isDir = /\/index\.html$/.test(p.path);
  let n = 1, path, url;
  do {
    const suffix = n === 1 ? '-copy' : `-copy-${n}`;
    path = isDir ? p.path.replace(/\/index\.html$/, `${suffix}/index.html`) : p.path.replace(/(\.html?)$/i, `${suffix}$1`);
    url = H.urlForPath(path); n++;
  } while (await c.env.DB.prepare('SELECT id FROM pages WHERE path = ?').bind(path).first());
  let html = src.split(`${H.SITE}${p.url}`).join(`${H.SITE}${url}`);
  if (isDir) {
    // Same depth: relative assets inside the original folder must point back to it.
    const folder = p.path.replace(/index\.html$/, '');
    const doc = H.parse(html);
    doc.querySelectorAll('[src],[srcset],[href]').forEach(el => {
      for (const a of ['src', 'href']) { const v = el.getAttribute(a); if (v && !/^(https?:|\/|#|\.\.|mailto:|data:)/i.test(v)) el.setAttribute(a, `../${folder}${v}`); }
      const ss = el.getAttribute('srcset'); if (ss) el.setAttribute('srcset', ss.split(',').map(part => { const t = part.trim(); return /^(https?:|\/|\.\.)/.test(t) ? t : `../${folder}${t}`; }).join(', '));
    });
    html = H.serialize(doc);
  }
  const res = await c.env.DB.prepare("INSERT INTO pages (path, url, title, template, status, visibility, parent_id, author_id, modified_by, draft_html, seo, sitemap, breadcrumbs) VALUES (?,?,?,?, 'draft', 'public', ?, ?, ?, ?, ?, ?, ?)")
    .bind(path, url, `${p.title} (copy)`, p.template, p.parent_id, c.user.id, c.user.id, html, JSON.stringify({ ...safeJson(p.seo, {}), canonical: '' }), p.sitemap, p.breadcrumbs).run();
  audit(c, 'page.duplicated', p.url, { to: url });
  return json({ id: res.meta.last_row_id, url }, 201);
});

route('POST', '/pages/:id/trash', ['pages.delete_own', 'pages.delete_any'], async c => {
  const p = await getPage(c, c.params.id, 'delete');
  if (p.url === '/') fail(422, 'The homepage cannot be deleted.');
  if (p.status === 'published') {
    if (!canPublish(c, p)) fail(403, 'Your role cannot take this page offline.');
    await unpublish(c, p, 'trash');
  } else {
    await c.env.DB.prepare("UPDATE pages SET trashed_from = status, status = 'trash', scheduled_at = NULL, version = version + 1, updated_at = datetime('now') WHERE id = ?").bind(p.id).run();
  }
  audit(c, 'page.trashed', p.url);
  return json({ ok: true });
});

route('POST', '/pages/:id/restore', ['pages.delete_own', 'pages.delete_any'], async c => {
  const p = await getPage(c, c.params.id, 'delete');
  if (p.status !== 'trash') fail(409, 'This page is not in the trash.');
  await c.env.DB.prepare("UPDATE pages SET status = 'draft', version = version + 1, updated_at = datetime('now') WHERE id = ?").bind(p.id).run();
  audit(c, 'page.restored', p.url);
  return json({ ok: true, note: 'Restored as a draft. Publish it to put it back online.' });
});

route('DELETE', '/pages/:id', ['pages.delete_own', 'pages.delete_any'], async c => {
  const p = await getPage(c, c.params.id, 'delete');
  if (p.status !== 'trash') fail(409, 'Move the page to the trash first.');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE pages SET parent_id = NULL WHERE parent_id = ?').bind(p.id),
    c.env.DB.prepare('DELETE FROM pages WHERE id = ?').bind(p.id)
  ]);
  audit(c, 'page.deleted_permanently', p.url);
  return json({ ok: true });
});

route('POST', '/pages/:id/slug', ['pages.edit_any', 'pages.publish_any', 'pages.edit_own'], async c => {
  const p = await getPage(c, c.params.id, 'edit');
  if (p.url === '/') fail(422, 'The homepage URL cannot change.');
  const slug = H.slugify(c.body.slug || '');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) fail(422, 'Use lowercase letters, numbers and hyphens.');
  const isDir = /\/index\.html$/.test(p.path);
  const parentDir = isDir ? p.path.replace(/[^/]+\/index\.html$/, '') : p.path.replace(/[^/]+$/, '');
  const ext = isDir ? '' : (p.path.match(/\.html?$/i)?.[0] || '.html');
  const newPath = isDir ? `${parentDir}${slug}/index.html` : `${parentDir}${slug}${ext}`;
  if (newPath === p.path) return json({ ok: true, url: p.url });
  const newUrl = H.urlForPath(newPath);
  if (await c.env.DB.prepare('SELECT id FROM pages WHERE path = ? OR url = ?').bind(newPath, newUrl).first()) fail(409, 'Another page already uses that URL.');
  if (c.body.createRedirect && !c.caps.has('redirects.manage')) fail(403, 'Your role cannot create redirects. Ask an administrator.');
  const oldDir = isDir ? p.path.replace(/index\.html$/, '') : null;
  const newDir = isDir ? newPath.replace(/index\.html$/, '') : null;
  const rewrite = h => (h ? h.split(`${H.SITE}${p.url}`).join(`${H.SITE}${newUrl}`) : h);
  const children = isDir ? (await c.env.DB.prepare('SELECT * FROM pages WHERE path LIKE ? AND id != ?').bind(`${oldDir}%`, p.id).all()).results : [];
  if (p.status === 'published' && p.visibility === 'public') {
    if (!canPublish(c, p)) fail(403, 'Changing the URL of a live page requires publish permission.');
    const gh = new GitHub(c.env);
    const { files } = await gh.tree();
    const changes = [];
    const moved = isDir ? [...files.keys()].filter(f => f.startsWith(oldDir)) : [p.path];
    for (const f of moved) {
      const target = isDir ? newDir + f.slice(oldDir.length) : newPath;
      if (/\.html?$/i.test(f)) changes.push({ path: target, text: rewrite(await gh.blobText(files.get(f).sha)) });
      else changes.push({ path: target, sha: files.get(f).sha });
      changes.push({ path: f, delete: true, expectSha: files.get(f).sha });
    }
    await c.env.DB.prepare("UPDATE pages SET path = ?, url = ?, published_html = ?, draft_html = ?, seo = ?, updated_at = datetime('now'), version = version + 1 WHERE id = ?")
      .bind(newPath, newUrl, rewrite(p.published_html), rewrite(p.draft_html), rewrite(p.seo), p.id).run();
    for (const ch of children) {
      const cp = newDir + ch.path.slice(oldDir.length);
      await c.env.DB.prepare('UPDATE pages SET path = ?, url = ? WHERE id = ?').bind(cp, H.urlForPath(cp), ch.id).run();
    }
    changes.push({ path: 'sitemap.xml', text: await sitemapText(c.env) });
    const res = await gh.commit(changes, `Move ${p.url} to ${newUrl}`);
    await c.env.DB.prepare('UPDATE pages SET live_sha = ? WHERE id = ?').bind(res.files[newPath] || null, p.id).run();
    for (const ch of children) {
      const cp = newDir + ch.path.slice(oldDir.length);
      if (res.files[cp]) await c.env.DB.prepare('UPDATE pages SET live_sha = ? WHERE id = ?').bind(res.files[cp], ch.id).run();
    }
  } else {
    await c.env.DB.prepare("UPDATE pages SET path = ?, url = ?, published_html = ?, draft_html = ?, seo = ?, updated_at = datetime('now'), version = version + 1 WHERE id = ?")
      .bind(newPath, newUrl, rewrite(p.published_html), rewrite(p.draft_html), rewrite(p.seo), p.id).run();
  }
  let redirect = null;
  if (c.body.createRedirect && p.status === 'published') {
    redirect = await insertRedirect(c, { source: p.url, target: newUrl, code: 301, notes: `URL change of page #${p.id}` });
  }
  // Keep the primary menu pointing at the new URL.
  const menus = (await c.env.DB.prepare('SELECT * FROM menus').all()).results;
  let menuNeedsPublish = false;
  for (const m of menus) {
    const fix = items => items.map(it => ({ ...it, url: it.url === p.url ? newUrl : it.url, children: fix(it.children || []) }));
    const items = JSON.stringify(fix(safeJson(m.items, [])));
    if (items !== m.items) { await c.env.DB.prepare('UPDATE menus SET items = ? WHERE id = ?').bind(items, m.id).run(); if (m.location === 'primary') menuNeedsPublish = true; }
  }
  await bump(c.env, 'content_version');
  audit(c, 'page.url_changed', p.url, { to: newUrl, redirect: redirect?.id });
  return json({ ok: true, url: newUrl, redirect, menuNeedsPublish });
});

route('GET', '/pages/:id/preview', 'pages.read', async c => {
  const p = await getPage(c, c.params.id);
  let html = p.draft_html || (await liveHtml(c, p)).html;
  if (c.url.searchParams.get('rev')) {
    const rev = await c.env.DB.prepare('SELECT html FROM revisions WHERE id = ? AND page_id = ?').bind(intId(c.url.searchParams.get('rev')), p.id).first();
    if (!rev) fail(404, 'Revision not found.');
    html = rev.html;
  } else if (p.draft_html) html = await finalHtml(c, p, html);
  const base = `${c.url.origin}${p.url.endsWith('/') ? p.url : p.url.replace(/[^/]*$/, '')}`;
  html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${base}"><meta name="robots" content="noindex,nofollow">`);
  html = html.replace(/<body([^>]*)>/i, '<body$1><div style="position:fixed;z-index:99;bottom:14px;right:14px;background:#f5c84c;color:#111;font:600 12px system-ui;padding:6px 10px;border-radius:8px;box-shadow:0 2px 8px #0006">Preview — not published</div>');
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "frame-ancestors 'self'" } });
});

/* ---------- Revisions ---------- */

route('GET', '/pages/:id/revisions', 'revisions.read', async c => {
  const p = await getPage(c, c.params.id);
  const rows = (await c.env.DB.prepare('SELECT r.id, r.kind, r.title, r.page_version, r.created_at, LENGTH(r.html) AS size, u.name AS user_name FROM revisions r LEFT JOIN users u ON u.id = r.user_id WHERE r.page_id = ? ORDER BY r.id DESC LIMIT 200').bind(p.id).all()).results;
  return json({ revisions: rows });
});

route('GET', '/revisions/:rid', 'revisions.read', async c => {
  const rev = await c.env.DB.prepare('SELECT * FROM revisions WHERE id = ?').bind(intId(c.params.rid)).first();
  if (!rev) fail(404, 'Revision not found.');
  const p = await getPage(c, rev.page_id);
  const regions = H.extractEditable(rev.html, p.path);
  return json({ revision: { id: rev.id, kind: rev.kind, created_at: rev.created_at, title: rev.title }, text: H.parse(rev.html).querySelector('article.article, main')?.textContent.replace(/\s+/g, ' ').trim() || '', regions });
});

route('POST', '/revisions/:rid/restore', ['pages.edit_own', 'pages.edit_any'], async c => {
  const rev = await c.env.DB.prepare('SELECT * FROM revisions WHERE id = ?').bind(intId(c.params.rid)).first();
  if (!rev) fail(404, 'Revision not found.');
  const p = await getPage(c, rev.page_id, 'edit');
  const live = await liveHtml(c, p);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE pages SET draft_html = ?, base_sha = ?, seo = ?, title = ?, version = version + 1, modified_by = ?, updated_at = datetime('now') WHERE id = ?").bind(rev.html, live.sha || null, rev.seo, rev.title || p.title, c.user.id, p.id),
    c.env.DB.prepare("INSERT INTO revisions (page_id, kind, title, html, seo, user_id, page_version) VALUES (?, 'restore', ?, ?, ?, ?, ?)").bind(p.id, rev.title, rev.html, rev.seo, c.user.id, p.version + 1)
  ]);
  audit(c, 'page.revision_restored', p.url, { revision: rev.id });
  return json({ ok: true, note: 'The revision was restored as a draft. Review it, then publish.' });
});

/* ------------------------------------------------------------- Terms ---- */

route('GET', '/terms', 'pages.read', async c => json({ terms: (await c.env.DB.prepare('SELECT t.*, (SELECT COUNT(*) FROM page_terms pt WHERE pt.term_id = t.id) AS count FROM terms t ORDER BY taxonomy, name').all()).results }));
route('POST', '/terms', 'terms.manage', async c => {
  const taxonomy = c.body.taxonomy === 'tag' ? 'tag' : 'category';
  const name = str(c.body.name, 80);
  if (!name) fail(422, 'Enter a name.');
  const slug = H.slugify(c.body.slug || name);
  try {
    const r = await c.env.DB.prepare('INSERT INTO terms (taxonomy, name, slug) VALUES (?,?,?)').bind(taxonomy, name, slug).run();
    return json({ id: r.meta.last_row_id }, 201);
  } catch { fail(409, `A ${taxonomy} with that slug already exists.`); }
});
route('PATCH', '/terms/:id', 'terms.manage', async c => {
  const name = str(c.body.name, 80); if (!name) fail(422, 'Enter a name.');
  await c.env.DB.prepare('UPDATE terms SET name = ?, slug = ? WHERE id = ?').bind(name, H.slugify(c.body.slug || name), intId(c.params.id)).run();
  return json({ ok: true });
});
route('DELETE', '/terms/:id', 'terms.manage', async c => {
  await c.env.DB.prepare('DELETE FROM terms WHERE id = ?').bind(intId(c.params.id)).run();
  return json({ ok: true });
});

/* ------------------------------------------------------------- Menus ---- */

function cleanMenuItems(items, depth = 0) {
  if (!Array.isArray(items)) fail(422, 'Menu items must be a list.');
  if (depth > 1 && items.length) fail(422, 'The site header supports one level of dropdowns.');
  return items.slice(0, 40).map(it => {
    const label = str(it.label, 80);
    if (!label) fail(422, 'Every menu item needs a label.');
    const url = str(it.url, 600);
    const children = cleanMenuItems(it.children || [], depth + 1);
    if (!url && !children.length) fail(422, `"${label}" needs a link or child items.`);
    if (url && !/^(\/|https?:\/\/|mailto:|tel:)/i.test(url)) fail(422, `"${label}" link must start with /, https:// or mailto:.`);
    return { label, url, newTab: Boolean(it.newTab), children };
  });
}

route('GET', '/menus', 'pages.read', async c => json({ menus: (await c.env.DB.prepare('SELECT * FROM menus ORDER BY id').all()).results.map(m => ({ ...m, items: safeJson(m.items, []), published_items: safeJson(m.published_items, null), unpublished: m.items !== m.published_items })) }));

route('POST', '/menus', 'menus.manage', async c => {
  const name = str(c.body.name, 80) || 'Menu';
  const items = JSON.stringify(cleanMenuItems(c.body.items || []));
  const location = c.body.location === 'primary' ? 'primary' : null;
  if (location && await c.env.DB.prepare("SELECT id FROM menus WHERE location = 'primary'").first()) fail(409, 'Another menu is already the primary site menu.');
  const r = await c.env.DB.prepare('INSERT INTO menus (name, location, items) VALUES (?,?,?)').bind(name, location, items).run();
  audit(c, 'menu.created', name);
  return json({ id: r.meta.last_row_id }, 201);
});

route('POST', '/menus/import-from-site', 'menus.manage', async c => {
  const home = await c.env.DB.prepare("SELECT published_html FROM pages WHERE path = 'index.html'").first();
  if (!home?.published_html) fail(409, 'Sync pages from the repository first.');
  const items = JSON.stringify(H.readMenuFromHtml(home.published_html));
  const existing = await c.env.DB.prepare("SELECT id FROM menus WHERE location = 'primary'").first();
  if (existing) await c.env.DB.prepare("UPDATE menus SET items = ?, published_items = ?, updated_at = datetime('now') WHERE id = ?").bind(items, items, existing.id).run();
  else await c.env.DB.prepare("INSERT INTO menus (name, location, items, published_items) VALUES ('Main navigation', 'primary', ?, ?)").bind(items, items).run();
  audit(c, 'menu.imported', 'primary');
  return json({ ok: true, items: JSON.parse(items) });
});

route('PUT', '/menus/:id', 'menus.manage', async c => {
  const id = intId(c.params.id);
  const m = await c.env.DB.prepare('SELECT * FROM menus WHERE id = ?').bind(id).first();
  if (!m) fail(404, 'Menu not found.');
  const items = c.body.items !== undefined ? JSON.stringify(cleanMenuItems(c.body.items)) : m.items;
  let location = c.body.location === undefined ? m.location : (c.body.location === 'primary' ? 'primary' : null);
  if (location === 'primary' && m.location !== 'primary' && await c.env.DB.prepare("SELECT id FROM menus WHERE location = 'primary'").first()) fail(409, 'Another menu is already the primary site menu.');
  await c.env.DB.prepare("UPDATE menus SET name = ?, location = ?, items = ?, updated_at = datetime('now') WHERE id = ?").bind(str(c.body.name, 80) || m.name, location, items, id).run();
  audit(c, 'menu.saved', m.name);
  return json({ ok: true });
});

route('DELETE', '/menus/:id', 'menus.manage', async c => {
  const m = await c.env.DB.prepare('SELECT * FROM menus WHERE id = ?').bind(intId(c.params.id)).first();
  if (!m) fail(404, 'Menu not found.');
  if (m.location === 'primary') fail(409, 'The primary menu is the live site header. Assign another menu as primary before deleting it.');
  await c.env.DB.prepare('DELETE FROM menus WHERE id = ?').bind(m.id).run();
  audit(c, 'menu.deleted', m.name);
  return json({ ok: true });
});

route('GET', '/menus/:id/preview', 'pages.read', async c => {
  const m = await c.env.DB.prepare('SELECT * FROM menus WHERE id = ?').bind(intId(c.params.id)).first();
  if (!m) fail(404, 'Menu not found.');
  const path = c.url.searchParams.get('path') || 'index.html';
  const p = await c.env.DB.prepare('SELECT * FROM pages WHERE path = ?').bind(path).first();
  if (!p) fail(404, 'Page not found.');
  let html = H.applyNav(p.draft_html || p.published_html, p.path, safeJson(m.items, []));
  const base = `${c.url.origin}${p.url.endsWith('/') ? p.url : p.url.replace(/[^/]*$/, '')}`;
  html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${base}">`);
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
});

route('POST', '/menus/:id/publish', 'menus.manage', async c => {
  const m = await c.env.DB.prepare('SELECT * FROM menus WHERE id = ?').bind(intId(c.params.id)).first();
  if (!m) fail(404, 'Menu not found.');
  if (m.location !== 'primary') fail(409, 'Only the primary menu is shown on the site. Make this menu primary first.');
  const items = safeJson(m.items, []);
  const known = new Set((await c.env.DB.prepare("SELECT url FROM pages WHERE status = 'published'").all()).results.map(r => r.url));
  const broken = [];
  const walk = list => list.forEach(it => { if (it.url?.startsWith('/') && !known.has(it.url.split('#')[0])) broken.push(`${it.label} → ${it.url}`); walk(it.children || []); });
  walk(items);
  if (broken.length && !c.body.allowBroken) fail(422, `These menu links do not point to published pages: ${broken.join('; ')}`, { code: 'broken_links', broken });
  const gh = new GitHub(c.env);
  const { files } = await gh.tree();
  const pages = (await c.env.DB.prepare("SELECT * FROM pages WHERE status != 'trash'").all()).results;
  const changes = [];
  for (const p of pages) {
    if (p.status === 'published' && p.visibility === 'public' && files.has(p.path)) {
      const text = await gh.blobText(files.get(p.path).sha);
      const next = H.applyNav(text, p.path, items);
      if (next !== text) changes.push({ path: p.path, text: next, expectSha: files.get(p.path).sha, id: p.id });
    }
  }
  const res = changes.length ? await gh.commit(changes.map(({ id, ...ch }) => ch), 'Update site navigation') : { files: {} };
  const stmts = [];
  for (const ch of changes) stmts.push(c.env.DB.prepare('UPDATE pages SET live_sha = ?, published_html = ? WHERE id = ?').bind(res.files[ch.path], ch.text, ch.id));
  for (const p of pages) {
    if (p.visibility !== 'public' && p.published_html) stmts.push(c.env.DB.prepare('UPDATE pages SET published_html = ? WHERE id = ?').bind(H.applyNav(p.published_html, p.path, items), p.id));
    if (p.draft_html) stmts.push(c.env.DB.prepare('UPDATE pages SET draft_html = ?, base_sha = CASE WHEN base_sha IS NOT NULL THEN ? ELSE base_sha END WHERE id = ?').bind(H.applyNav(p.draft_html, p.path, items), res.files[p.path] || p.base_sha, p.id));
  }
  stmts.push(c.env.DB.prepare("UPDATE menus SET published_items = items, updated_at = datetime('now') WHERE id = ?").bind(m.id));
  await c.env.DB.batch(stmts);
  audit(c, 'menu.published', m.name, { files: changes.length });
  return json({ ok: true, filesUpdated: changes.length, broken });
});

/* ------------------------------------------------------------- Media ---- */

const MEDIA_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};
const MAX_UPLOAD = 10 * 1024 * 1024;
const MEDIA_EXCLUDE = p => p.startsWith('admin/') || p.startsWith('cms/') || p === 'favicon.svg' || p.startsWith('.');

function sniff(bytes, ext) {
  const h = [...bytes.slice(0, 16)];
  const ascii = String.fromCharCode(...h);
  if (ext === 'png') return h[0] === 0x89 && ascii.slice(1, 4) === 'PNG';
  if (ext === 'jpg' || ext === 'jpeg') return h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff;
  if (ext === 'gif') return ascii.startsWith('GIF8');
  if (ext === 'webp') return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP';
  if (ext === 'avif') return ascii.slice(4, 8) === 'ftyp' && /avi[fs]|mif1/.test(String.fromCharCode(...bytes.slice(8, 32)));
  if (ext === 'pdf') return ascii.startsWith('%PDF');
  if (['docx', 'xlsx', 'pptx'].includes(ext)) return h[0] === 0x50 && h[1] === 0x4b;
  if (ext === 'svg' || ext === 'txt' || ext === 'csv') {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return false; }
    return !bytes.slice(0, 2048).includes(0);
  }
  return false;
}

function svgProblems(text) {
  const t = text.toLowerCase();
  const problems = [];
  if (!/<svg[\s>]/.test(t)) problems.push('not an SVG document');
  if (/<script|<foreignobject|<iframe|<embed|<object/.test(t)) problems.push('contains scripts or embedded documents');
  if (/\son[a-z]+\s*=/.test(t)) problems.push('contains event handlers');
  if (/(href|src)\s*=\s*["']?\s*(javascript:|data:text\/html)/.test(t)) problems.push('contains script links');
  if (/<!entity|<!doctype[^>]*\[/.test(t)) problems.push('contains XML entities');
  if (/(href|src)\s*=\s*["']\s*https?:/.test(t)) problems.push('loads external resources');
  return problems;
}

function safeName(name) {
  const base = String(name || 'file').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const ext = (base.match(/\.([a-z0-9]+)$/)?.[1] || '');
  const stem = base.replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'file';
  return { stem, ext };
}

async function readUpload(c, file) {
  if (!file || typeof file.arrayBuffer !== 'function') fail(422, 'Choose a file to upload.');
  if (file.size > MAX_UPLOAD) fail(413, 'Files can be at most 10 MB.');
  const { stem, ext } = safeName(file.name);
  if (!MEDIA_TYPES[ext]) fail(415, `.${ext || '?'} files are not allowed. Allowed: ${Object.keys(MEDIA_TYPES).join(', ')}.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!sniff(bytes, ext)) fail(415, `The file content does not match the .${ext} extension.`);
  if (ext === 'svg') {
    if (!c.caps.has('unfiltered_html')) fail(403, 'Your role cannot upload SVG files.');
    const problems = svgProblems(new TextDecoder().decode(bytes));
    if (problems.length) fail(415, `SVG rejected for safety: ${problems.join(', ')}.`);
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { stem, ext, mime: MEDIA_TYPES[ext], size: bytes.length, base64: btoa(bin) };
}

route('GET', '/media', 'media.read', async c => {
  const rows = (await c.env.DB.prepare('SELECT * FROM media ORDER BY created_at DESC, path').all()).results;
  return json({ media: rows, collections: [...new Set(rows.map(r => r.collection).filter(Boolean))].sort() });
});

route('POST', '/media/sync', 'media.upload', async c => {
  const gh = new GitHub(c.env);
  const { files } = await gh.tree();
  const existing = new Map((await c.env.DB.prepare('SELECT path, sha FROM media').all()).results.map(r => [r.path, r.sha]));
  const stmts = [];
  let added = 0, removed = 0;
  for (const [path, f] of files) {
    if (MEDIA_EXCLUDE(path)) continue;
    const ext = path.split('.').pop().toLowerCase();
    if (!MEDIA_TYPES[ext] || /\.html?$/.test(path)) continue;
    if (!existing.has(path)) { stmts.push(c.env.DB.prepare('INSERT INTO media (path, sha, mime, size, collection) VALUES (?,?,?,?,?)').bind(path, f.sha, MEDIA_TYPES[ext], f.size, path.includes('/') ? path.split('/')[0] : '')); added++; }
    else if (existing.get(path) !== f.sha) stmts.push(c.env.DB.prepare("UPDATE media SET sha = ?, size = ?, updated_at = datetime('now') WHERE path = ?").bind(f.sha, f.size, path));
  }
  for (const path of existing.keys()) if (!files.has(path)) { stmts.push(c.env.DB.prepare('DELETE FROM media WHERE path = ?').bind(path)); removed++; }
  if (stmts.length) await c.env.DB.batch(stmts);
  return json({ added, removed });
});

route('POST', '/media', 'media.upload', async c => {
  const form = c.body;
  if (!(form instanceof FormData)) fail(415, 'Upload with multipart/form-data.');
  const file = form.get('file');
  const up = await readUpload(c, file);
  const folder = str(form.get('folder') || '', 60).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  const dir = `assets/uploads/${folder ? `${folder}/` : ''}`;
  const gh = new GitHub(c.env);
  const { files } = await gh.tree();
  let path = `${dir}${up.stem}.${up.ext}`; let n = 2;
  while (files.has(path)) path = `${dir}${up.stem}-${n++}.${up.ext}`;
  const res = await gh.commit([{ path, base64: up.base64, expectSha: null }], `Upload ${path}`, { author: { name: c.user.name, email: c.user.email } });
  const dim = k => { const v = Number(form.get(k)); return Number.isInteger(v) && v > 0 && v < 100000 ? v : null; };
  await c.env.DB.prepare('INSERT OR REPLACE INTO media (path, sha, mime, size, width, height, title, alt, caption, collection, uploaded_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .bind(path, res.files[path], up.mime, up.size, dim('width'), dim('height'), str(form.get('title'), 200), str(form.get('alt'), 300), str(form.get('caption'), 500), str(form.get('collection') || folder, 60), c.user.id).run();
  audit(c, 'media.uploaded', path, { size: up.size });
  return json({ path, url: `/${path}` }, 201);
});

route('POST', '/media/replace', 'media.edit', async c => {
  const form = c.body;
  if (!(form instanceof FormData)) fail(415, 'Upload with multipart/form-data.');
  const path = str(form.get('path'), 400);
  const row = await c.env.DB.prepare('SELECT * FROM media WHERE path = ?').bind(path).first();
  if (!row) fail(404, 'Media item not found.');
  const up = await readUpload(c, form.get('file'));
  const oldExt = path.split('.').pop().toLowerCase();
  const family = e => (/^(png|jpe?g|gif|webp|avif|svg)$/.test(e) ? 'image' : e);
  if (family(oldExt) !== family(up.ext)) fail(422, 'The replacement must be the same kind of file.');
  if (oldExt !== up.ext && !(['jpg', 'jpeg'].includes(oldExt) && ['jpg', 'jpeg'].includes(up.ext))) fail(422, `Upload a .${oldExt} file so the URL stays the same and existing links keep working.`);
  const gh = new GitHub(c.env);
  const res = await gh.commit([{ path, base64: up.base64, expectSha: row.sha }], `Replace ${path}`, { author: { name: c.user.name, email: c.user.email } });
  const dim = k => { const v = Number(form.get(k)); return Number.isInteger(v) && v > 0 ? v : null; };
  await c.env.DB.prepare("UPDATE media SET sha = ?, size = ?, width = COALESCE(?, width), height = COALESCE(?, height), updated_at = datetime('now') WHERE path = ?").bind(res.files[path], up.size, dim('width'), dim('height'), path).run();
  audit(c, 'media.replaced', path);
  return json({ ok: true, note: 'Replaced in place: every page using this file now shows the new version (browsers may cache the old one briefly).' });
});

route('PATCH', '/media', 'media.edit', async c => {
  const path = str(c.body.path, 400);
  const row = await c.env.DB.prepare('SELECT path FROM media WHERE path = ?').bind(path).first();
  if (!row) fail(404, 'Media item not found.');
  const dim = v => (Number.isInteger(v) && v > 0 ? v : null);
  await c.env.DB.prepare("UPDATE media SET title = ?, alt = ?, caption = ?, collection = ?, width = COALESCE(?, width), height = COALESCE(?, height), updated_at = datetime('now') WHERE path = ?")
    .bind(str(c.body.title, 200), str(c.body.alt, 300), str(c.body.caption, 500), str(c.body.collection, 60), dim(c.body.width), dim(c.body.height), path).run();
  return json({ ok: true });
});

async function mediaUsage(c, path) {
  const gh = new GitHub(c.env);
  const { files } = await gh.tree();
  const name = path.split('/').pop();
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  const usedIn = [];
  const check = (pagePath, html) => {
    if (!html) return false;
    if (html.includes(path) || html.includes(encodeURI(path))) return true;
    const pageDir = pagePath.slice(0, pagePath.lastIndexOf('/') + 1);
    return pageDir === dir && new RegExp(`["'\\s,(]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'\\s,)]`).test(html);
  };
  for (const [p, f] of files) if (/\.html?$/i.test(p) && !p.startsWith('admin/') && check(p, await gh.blobText(f.sha))) usedIn.push({ path: p, where: 'live site' });
  for (const p of (await c.env.DB.prepare("SELECT path, url, draft_html, published_html, visibility FROM pages WHERE status != 'trash'").all()).results) {
    if (check(p.path, p.draft_html)) usedIn.push({ path: p.path, where: 'unpublished draft' });
    else if (p.visibility !== 'public' && check(p.path, p.published_html)) usedIn.push({ path: p.path, where: `${p.visibility} page` });
  }
  const og = await c.env.DB.prepare('SELECT path FROM pages WHERE seo LIKE ?').bind(`%${name}%`).all();
  for (const r of og.results) if (!usedIn.some(u => u.path === r.path)) usedIn.push({ path: r.path, where: 'SEO image' });
  return usedIn;
}

route('GET', '/media/usage', 'media.read', async c => json({ usedIn: await mediaUsage(c, str(c.url.searchParams.get('path'), 400)) }));

route('DELETE', '/media', 'media.delete', async c => {
  const path = str(c.url.searchParams.get('path'), 400);
  const row = await c.env.DB.prepare('SELECT * FROM media WHERE path = ?').bind(path).first();
  if (!row) fail(404, 'Media item not found.');
  const usedIn = await mediaUsage(c, path);
  if (usedIn.length && c.url.searchParams.get('force') !== '1') fail(409, `This file is used on ${usedIn.length} page(s). Deleting it would break them.`, { code: 'in_use', usedIn });
  const gh = new GitHub(c.env);
  await gh.commit([{ path, delete: true, expectSha: row.sha }], `Delete ${path}`);
  await c.env.DB.prepare('DELETE FROM media WHERE path = ?').bind(path).run();
  audit(c, 'media.deleted', path, { forced: usedIn.length > 0 });
  return json({ ok: true });
});

/* ---------------------------------------------------------- Redirects ---- */

const REDIRECT_COLS = ['source', 'target', 'code', 'match', 'query', 'ignore_case', 'ignore_slash', 'active', 'position', 'notes'];

function ruleRowToJs(r) { return { ...r, ignore_case: Boolean(r.ignore_case), ignore_slash: Boolean(r.ignore_slash), active: Boolean(r.active) }; }

async function allRedirects(env) {
  return (await env.DB.prepare('SELECT * FROM redirects ORDER BY position, id').all()).results.map(ruleRowToJs);
}

async function knownPaths(env) {
  const rows = (await env.DB.prepare("SELECT url FROM pages WHERE status = 'published'").all()).results;
  const set = new Set();
  for (const r of rows) { set.add(R.normPath(r.url)); set.add(R.normPath(r.url, { ignore_slash: true })); if (r.url === '/') set.add('/index.html'); }
  for (const m of (await env.DB.prepare('SELECT path FROM media').all()).results) set.add(`/${m.path}`);
  ['/sitemap.xml', '/robots.txt', '/Nikola_Djurkovic_CV.pdf', '/site.css', '/favicon.svg'].forEach(p => set.add(p));
  return set;
}

async function defaultQueryMode(env) {
  return (await env.DB.prepare("SELECT value FROM settings WHERE key = 'redirect_default_query'").first())?.value || R.DEFAULTS.query;
}

async function insertRedirect(c, input) {
  const v = R.validateRule({ query: await defaultQueryMode(c.env), ...input });
  if (v.errors.length) fail(422, v.errors.join(' '));
  const r = v.rule;
  const res = await c.env.DB.prepare('INSERT INTO redirects (source, source_key, target, code, match, query, ignore_case, ignore_slash, active, position, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(r.source, R.sourceKey(r), r.target, r.code, r.match, r.query, r.ignore_case ? 1 : 0, r.ignore_slash ? 1 : 0, r.active ? 1 : 0, r.position, r.notes, c.user?.id ?? null).run();
  await bump(c.env, 'redirects_version');
  return { id: res.meta.last_row_id, ...r };
}

function filterRedirects(rows, q) {
  const s = (q.get('q') || '').toLowerCase();
  let out = rows.filter(r => (!s || r.source.toLowerCase().includes(s) || r.target.toLowerCase().includes(s) || r.notes.toLowerCase().includes(s))
    && (!q.get('status') || (q.get('status') === 'active' ? r.active : !r.active))
    && (!q.get('code') || String(r.code) === q.get('code'))
    && (!q.get('match') || r.match === q.get('match')));
  const sort = ['source', 'target', 'code', 'hits', 'last_hit', 'position', 'created_at', 'updated_at', 'id'].includes(q.get('sort')) ? q.get('sort') : 'position';
  const dir = q.get('dir') === 'desc' ? -1 : 1;
  out = out.sort((a, b) => ((a[sort] ?? '') > (b[sort] ?? '') ? 1 : (a[sort] ?? '') < (b[sort] ?? '') ? -1 : a.id - b.id) * dir);
  return out;
}

route('GET', '/redirects', 'redirects.read', async c => {
  const all = await allRedirects(c.env);
  const issues = R.diagnose(all, { knownPaths: await knownPaths(c.env) });
  let rows = filterRedirects(all, c.url.searchParams);
  const issueFilter = c.url.searchParams.get('issue');
  if (issueFilter) rows = rows.filter(r => (issues.get(r.id) || []).some(i => (issueFilter === 'any' ? i.level !== 'info' : i.type === issueFilter)));
  const per = Math.min(500, Math.max(10, Number(c.url.searchParams.get('per')) || 50));
  const page = Math.max(1, Number(c.url.searchParams.get('page')) || 1);
  const summary = {};
  for (const list of issues.values()) for (const i of list) summary[i.type] = (summary[i.type] || 0) + 1;
  return json({
    total: all.length, filtered: rows.length, page, per,
    redirects: rows.slice((page - 1) * per, page * per).map(r => ({ ...r, issues: issues.get(r.id) || [] })),
    summary, defaults: { ...R.DEFAULTS, query: await defaultQueryMode(c.env) }
  });
});

route('POST', '/redirects', 'redirects.manage', async c => {
  const rule = Object.fromEntries(REDIRECT_COLS.filter(k => c.body[k] !== undefined).map(k => [k, c.body[k]]));
  const all = await allRedirects(c.env);
  const key = R.sourceKey({ query: await defaultQueryMode(c.env), ...rule });
  const dup = all.find(r => R.sourceKey(r) === key);
  if (dup && !c.body.allowDuplicate) fail(409, `A rule for this source already exists (#${dup.id} → ${dup.target}). Edit that rule instead.`, { code: 'duplicate', existing: dup.id });
  const created = await insertRedirect(c, rule);
  const issues = R.diagnose([...all, created], { knownPaths: await knownPaths(c.env) }).get(created.id) || [];
  audit(c, 'redirect.created', created.source, { target: created.target, code: created.code });
  return json({ redirect: created, issues }, 201);
});

route('PUT', '/redirects/:id', 'redirects.manage', async c => {
  const id = intId(c.params.id);
  const row = await c.env.DB.prepare('SELECT * FROM redirects WHERE id = ?').bind(id).first();
  if (!row) fail(404, 'Redirect not found.');
  const merged = { ...ruleRowToJs(row), ...Object.fromEntries(REDIRECT_COLS.filter(k => c.body[k] !== undefined).map(k => [k, c.body[k]])) };
  const v = R.validateRule(merged);
  if (v.errors.length) fail(422, v.errors.join(' '));
  const r = v.rule;
  await c.env.DB.prepare("UPDATE redirects SET source = ?, source_key = ?, target = ?, code = ?, match = ?, query = ?, ignore_case = ?, ignore_slash = ?, active = ?, position = ?, notes = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(r.source, R.sourceKey(r), r.target, r.code, r.match, r.query, r.ignore_case ? 1 : 0, r.ignore_slash ? 1 : 0, r.active ? 1 : 0, r.position, r.notes, id).run();
  await bump(c.env, 'redirects_version');
  const all = await allRedirects(c.env);
  audit(c, 'redirect.updated', r.source, { id });
  return json({ redirect: { id, ...r }, issues: R.diagnose(all, { knownPaths: await knownPaths(c.env) }).get(id) || [] });
});

route('DELETE', '/redirects/:id', 'redirects.manage', async c => {
  const id = intId(c.params.id);
  const row = await c.env.DB.prepare('SELECT source FROM redirects WHERE id = ?').bind(id).first();
  if (!row) fail(404, 'Redirect not found.');
  await c.env.DB.prepare('DELETE FROM redirects WHERE id = ?').bind(id).run();
  await bump(c.env, 'redirects_version');
  audit(c, 'redirect.deleted', row.source, { id });
  return json({ ok: true });
});

async function backupRedirects(c, reason) {
  const all = await allRedirects(c.env);
  await c.env.DB.prepare('INSERT INTO redirect_backups (reason, count, data, user_id) VALUES (?,?,?,?)').bind(reason, all.length, JSON.stringify(all), c.user?.id ?? null).run();
  // Keep the 50 most recent backups.
  await c.env.DB.prepare('DELETE FROM redirect_backups WHERE id NOT IN (SELECT id FROM redirect_backups ORDER BY id DESC LIMIT 50)').run();
}

route('POST', '/redirects/bulk', 'redirects.manage', async c => {
  const ids = [...new Set((c.body.ids || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) fail(422, 'Select at least one redirect.');
  if (ids.length > 5000) fail(422, 'Select at most 5,000 redirects at a time.');
  const action = c.body.action;
  const marks = ids.map(() => '?').join(',');
  await backupRedirects(c, `Before bulk ${action} (${ids.length})`);
  let sql;
  const binds = [...ids];
  if (action === 'activate') sql = `UPDATE redirects SET active = 1, updated_at = datetime('now') WHERE id IN (${marks})`;
  else if (action === 'deactivate') sql = `UPDATE redirects SET active = 0, updated_at = datetime('now') WHERE id IN (${marks})`;
  else if (action === 'delete') sql = `DELETE FROM redirects WHERE id IN (${marks})`;
  else if (action === 'reset_hits') sql = `UPDATE redirects SET hits = 0, last_hit = NULL WHERE id IN (${marks})`;
  else if (action === 'set_code') {
    const code = Number(c.body.code);
    if (!R.CODES.includes(code)) fail(422, 'Choose a valid redirect type.');
    sql = `UPDATE redirects SET code = ?, updated_at = datetime('now') WHERE id IN (${marks})`; binds.unshift(code);
  } else fail(422, 'Unknown bulk action.');
  // D1 limits bound parameters per statement; chunk.
  const chunk = 90;
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk);
    const s = sql.replace(`IN (${marks})`, `IN (${part.map(() => '?').join(',')})`);
    await c.env.DB.prepare(s).bind(...(action === 'set_code' ? [binds[0], ...part] : part)).run();
  }
  await bump(c.env, 'redirects_version');
  audit(c, 'redirect.bulk', action, { count: ids.length });
  return json({ ok: true, count: ids.length });
});

route('POST', '/redirects/test', 'redirects.read', async c => {
  let input = str(c.body.url, 2000);
  if (!input) fail(422, 'Enter a URL or path to test.');
  if (input.startsWith('/')) input = `${H.SITE}${input}`;
  let u; try { u = new URL(input); } catch { fail(422, 'Enter a valid URL or a path starting with "/".'); }
  if (!R.SITE_HOSTS.includes(u.hostname)) fail(422, `Test URLs on ${H.SITE}.`);
  const all = await allRedirects(c.env);
  const candidate = c.body.rule ? R.coerceRule({ id: c.body.rule.id ?? -1, ...c.body.rule }) : null;
  const rules = candidate ? [...all.filter(r => r.id !== candidate.id), candidate] : all;
  const t = R.trace(rules.filter(r => r.active), u.toString());
  const known = await knownPaths(c.env);
  const final = new URL(t.final);
  const finalKnown = !R.SITE_HOSTS.includes(final.hostname) ? null : known.has(R.normPath(final.pathname)) || known.has(R.normPath(final.pathname, { ignore_slash: true }));
  const inactive = all.filter(r => !r.active && R.match(R.compile([{ ...r, active: true }]), u.toString())).map(r => ({ id: r.id, source: r.source }));
  return json({ ...t, finalIsKnownPage: finalKnown, inactiveMatches: inactive });
});

route('GET', '/redirects/export', 'redirects.read', async c => {
  const all = await allRedirects(c.env);
  const rows = c.url.searchParams.get('scope') === 'filtered' ? filterRedirects(all, c.url.searchParams) : all;
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(R.toCsv(rows), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="nikolaseo-redirects-${stamp}.csv"`, 'Cache-Control': 'no-store' } });
});

route('GET', '/redirects/template', 'redirects.read', async () => new Response(R.csvTemplate(), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="redirects-template.csv"' } }));

/** Classify each import row against itself and the database. Pure, used by preview and commit. */
async function classifyImport(c, rows) {
  const qDefault = await defaultQueryMode(c.env);
  const existing = await allRedirects(c.env);
  const byKey = new Map(existing.map(r => [R.sourceKey(r), r]));
  const seen = new Map();
  const known = await knownPaths(c.env);
  const out = rows.slice(0, 20000).map((raw, i) => {
    const row = { query: qDefault, ...raw, _row: raw._row ?? i + 2 };
    const v = R.validateRule(row);
    const errors = [...(raw._parseErrors || []), ...v.errors];
    const key = errors.length ? null : R.sourceKey(v.rule);
    let status = errors.length ? 'invalid' : 'valid';
    let existingId = null;
    const notes = [...v.warnings];
    if (!errors.length) {
      if (seen.has(key)) {
        const first = seen.get(key);
        status = first.target === v.rule.target ? 'duplicate_in_file' : 'conflict_in_file';
        notes.push(`Same source as row ${first._row}.`);
      } else {
        seen.set(key, { _row: row._row, target: v.rule.target });
        const ex = byKey.get(key);
        if (ex) {
          existingId = ex.id;
          const same = ex.target === v.rule.target && ex.code === v.rule.code && ex.active === v.rule.active && ex.query === v.rule.query;
          status = same ? 'duplicate' : 'conflict';
          notes.push(same ? `Identical to existing rule #${ex.id}.` : `Existing rule #${ex.id} sends this source to ${ex.target} (${ex.code}).`);
        }
      }
    }
    return { row: row._row, status, errors, notes, existingId, rule: errors.length ? { source: raw.source, target: raw.target, code: raw.code } : v.rule };
  });
  // Whole-set diagnostics (loops / chains) on the would-be result: existing + valid new rows.
  const candidate = [...existing.filter(e => !out.some(o => o.existingId === e.id && o.status === 'conflict')), ...out.filter(o => o.status === 'valid' || o.status === 'conflict').map(o => ({ ...o.rule, _row: o.row, id: `row:${o.row}` }))];
  const diag = R.diagnose(candidate, { knownPaths: known });
  for (const o of out) {
    const d = (diag.get(`row:${o.row}`) || []).filter(i => ['loop', 'chain', 'target', 'conflict'].includes(i.type));
    for (const i of d) { (i.level === 'error' ? o.errors : o.notes).push(i.message); if (i.type === 'loop' && o.status === 'valid') o.status = 'invalid'; }
  }
  const counts = { total: out.length, valid: 0, invalid: 0, duplicate: 0, conflict: 0, attention: 0 };
  for (const o of out) {
    if (o.status === 'valid') counts.valid++;
    else if (o.status === 'invalid') counts.invalid++;
    else if (o.status.startsWith('duplicate')) counts.duplicate++;
    else counts.conflict++;
    if (o.status !== 'valid' || o.notes.length) counts.attention++;
  }
  return { rows: out, counts, truncated: rows.length > 20000 };
}

route('POST', '/redirects/import/preview', 'redirects.manage', async c => {
  if (!Array.isArray(c.body.rows)) fail(422, 'No rows to import.');
  return json(await classifyImport(c, c.body.rows));
});

route('POST', '/redirects/import/commit', 'redirects.manage', async c => {
  if (!Array.isArray(c.body.rows)) fail(422, 'No rows to import.');
  const overwrite = c.body.overwriteConflicts === true;
  if (overwrite && c.body.confirmOverwrite !== 'OVERWRITE') fail(422, 'Type OVERWRITE to confirm replacing existing rules.');
  const plan = await classifyImport(c, c.body.rows);
  await backupRedirects(c, `Before CSV import (${plan.counts.total} rows)`);
  const imported = [], skipped = [], failed = [], updated = [];
  const stmts = [];
  for (const o of plan.rows) {
    if (o.status === 'invalid') { failed.push({ row: o.row, errors: o.errors }); continue; }
    if (o.status === 'duplicate' || o.status === 'duplicate_in_file') { skipped.push({ row: o.row, reason: o.notes[0] || 'Duplicate' }); continue; }
    if (o.status === 'conflict_in_file') { skipped.push({ row: o.row, reason: `Conflicts with an earlier row in the file. ${o.notes[0] || ''}`.trim() }); continue; }
    const r = o.rule;
    if (o.status === 'conflict') {
      if (!overwrite) { skipped.push({ row: o.row, reason: `Conflict: ${o.notes[0] || 'existing rule'}. Not overwritten.` }); continue; }
      stmts.push(c.env.DB.prepare("UPDATE redirects SET source = ?, source_key = ?, target = ?, code = ?, match = ?, query = ?, ignore_case = ?, ignore_slash = ?, active = ?, position = ?, notes = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(r.source, R.sourceKey(r), r.target, r.code, r.match, r.query, r.ignore_case ? 1 : 0, r.ignore_slash ? 1 : 0, r.active ? 1 : 0, r.position, r.notes, o.existingId));
      updated.push({ row: o.row, id: o.existingId });
      continue;
    }
    stmts.push(c.env.DB.prepare('INSERT INTO redirects (source, source_key, target, code, match, query, ignore_case, ignore_slash, active, position, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(r.source, R.sourceKey(r), r.target, r.code, r.match, r.query, r.ignore_case ? 1 : 0, r.ignore_slash ? 1 : 0, r.active ? 1 : 0, r.position, r.notes, c.user.id));
    imported.push({ row: o.row });
  }
  for (let i = 0; i < stmts.length; i += 200) await c.env.DB.batch(stmts.slice(i, i + 200));
  await bump(c.env, 'redirects_version');
  audit(c, 'redirect.import', null, { imported: imported.length, updated: updated.length, skipped: skipped.length, failed: failed.length });
  return json({ imported: imported.length, updated: updated.length, skipped, failed, counts: plan.counts });
});

route('GET', '/redirects/backups', 'redirects.manage', async c => json({ backups: (await c.env.DB.prepare('SELECT b.id, b.reason, b.count, b.created_at, u.name AS user_name FROM redirect_backups b LEFT JOIN users u ON u.id = b.user_id ORDER BY b.id DESC').all()).results }));

route('POST', '/redirects/backups', 'redirects.manage', async c => { await backupRedirects(c, str(c.body.reason, 100) || 'Manual backup'); return json({ ok: true }); });

route('GET', '/redirects/backups/:id/csv', 'redirects.manage', async c => {
  const b = await c.env.DB.prepare('SELECT * FROM redirect_backups WHERE id = ?').bind(intId(c.params.id)).first();
  if (!b) fail(404, 'Backup not found.');
  return new Response(R.toCsv(JSON.parse(b.data)), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="redirects-backup-${b.id}.csv"` } });
});

route('POST', '/redirects/backups/:id/restore', 'redirects.manage', async c => {
  const b = await c.env.DB.prepare('SELECT * FROM redirect_backups WHERE id = ?').bind(intId(c.params.id)).first();
  if (!b) fail(404, 'Backup not found.');
  if (c.body.confirm !== 'RESTORE') fail(422, 'Type RESTORE to replace all current redirects with this backup.');
  await backupRedirects(c, `Before restoring backup #${b.id}`);
  const rules = JSON.parse(b.data);
  const stmts = [c.env.DB.prepare('DELETE FROM redirects')];
  for (const r of rules) {
    stmts.push(c.env.DB.prepare('INSERT INTO redirects (id, source, source_key, target, code, match, query, ignore_case, ignore_slash, active, position, notes, hits, last_hit, created_at, updated_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(r.id, r.source, R.sourceKey(r), r.target, r.code, r.match, r.query, r.ignore_case ? 1 : 0, r.ignore_slash ? 1 : 0, r.active ? 1 : 0, r.position, r.notes || '', r.hits || 0, r.last_hit || null, r.created_at || sqlNow(), r.updated_at || sqlNow(), r.created_by ?? null));
  }
  for (let i = 0; i < stmts.length; i += 200) await c.env.DB.batch(stmts.slice(i, i + 200));
  await bump(c.env, 'redirects_version');
  audit(c, 'redirect.restore', `backup ${b.id}`, { count: rules.length });
  return json({ ok: true, count: rules.length });
});

route('POST', '/redirects/verify-live', 'redirects.read', async c => {
  const checker = (c.env.LIVE_CHECKER_URL || '').replace(/\/$/, '');
  if (!checker) fail(503, 'Live verification is not configured (LIVE_CHECKER_URL).');
  const ids = (c.body.ids || []).map(Number).filter(Number.isInteger).slice(0, 25);
  const rows = ids.length ? (await allRedirects(c.env)).filter(r => ids.includes(r.id)) : [];
  const urls = rows.length ? rows.filter(r => r.match === 'exact').map(r => ({ id: r.id, url: new URL(R.splitSource(r.source).path + (R.splitSource(r.source).query ? `?${R.splitSource(r.source).query}` : ''), H.SITE).toString() })) : (c.body.urls || []).slice(0, 25).map(u => ({ url: u }));
  const compiled = R.compile(await allRedirects(c.env));
  const results = [];
  for (const item of urls) {
    const expected = R.match(compiled, item.url);
    let live = null, error = null;
    try {
      const res = await fetch(`${checker}/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: item.url }) });
      live = await res.json();
      if (!res.ok) error = live.error || `Checker returned ${res.status}`;
    } catch (e) { error = e.message; }
    const first = live?.chain?.[0];
    const liveCode = first ? Number(first.status) : (live?.finalStatus ?? null);
    const liveLocation = first?.to ?? null;
    const pass = !error && (expected ? liveCode === expected.code && liveLocation === expected.location : !first);
    results.push({ id: item.id ?? null, url: item.url, expected: expected ? { code: expected.code, location: expected.location } : null, live: { code: liveCode, location: liveLocation, final: live?.finalDetails?.url ?? null, finalStatus: live?.finalStatus ?? null }, pass, error });
  }
  audit(c, 'redirect.verify_live', null, { checked: results.length, failed: results.filter(r => !r.pass).length });
  return json({ results });
});

/* --------------------------------------------------- Settings / system ---- */

const SETTING_KEYS = ['redirect_default_query', 'default_og_image', 'site_name', 'require_2fa'];

route('GET', '/settings', 'pages.read', async c => {
  const rows = (await c.env.DB.prepare('SELECT key, value FROM settings').all()).results;
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return json({
    settings: Object.fromEntries(SETTING_KEYS.map(k => [k, s[k] ?? ''])),
    system: {
      githubConfigured: Boolean(c.env.GITHUB_TOKEN && c.env.GITHUB_REPO), repo: c.env.GITHUB_REPO, branch: c.env.GITHUB_BRANCH || 'main',
      liveChecker: Boolean(c.env.LIVE_CHECKER_URL), mfaConfigured: Boolean(c.env.MFA_KEY), cronLastRun: s.cron_last_run || null, schemaVersion: s.schema_version,
      counts: {
        pages: (await c.env.DB.prepare('SELECT COUNT(*) n FROM pages').first()).n,
        redirects: (await c.env.DB.prepare('SELECT COUNT(*) n FROM redirects').first()).n,
        users: (await c.env.DB.prepare('SELECT COUNT(*) n FROM users').first()).n,
        media: (await c.env.DB.prepare('SELECT COUNT(*) n FROM media').first()).n
      }
    }
  });
});

route('PUT', '/settings', 'settings.manage', async c => {
  const stmts = [];
  for (const k of SETTING_KEYS) {
    if (c.body[k] === undefined) continue;
    let v = str(c.body[k], 600);
    if (k === 'redirect_default_query' && !R.QUERY_MODES.includes(v)) fail(422, 'Invalid default query handling.');
    if (k === 'require_2fa' && !MFA_POLICIES.includes(v)) fail(422, 'Invalid two-factor policy.');
    stmts.push(c.env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, v));
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  audit(c, 'settings.updated', null, c.body);
  return json({ ok: true });
});

route('POST', '/sitemap/regenerate', 'pages.publish_any', async c => {
  const gh = new GitHub(c.env);
  const text = await sitemapText(c.env);
  const current = await gh.readText('sitemap.xml');
  if (current?.text === text) return json({ ok: true, changed: false });
  await gh.commit([{ path: 'sitemap.xml', text }], 'Regenerate sitemap.xml');
  audit(c, 'sitemap.regenerated');
  return json({ ok: true, changed: true });
});

route('GET', '/sitemap/preview', 'pages.read', async c => new Response(await sitemapText(c.env), { headers: { 'Content-Type': 'application/xml; charset=utf-8' } }));

route('GET', '/audit', 'audit.read', async c => {
  const level = c.url.searchParams.get('level');
  const rows = (await c.env.DB.prepare(`SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${level ? 'WHERE a.level = ?' : ''} ORDER BY a.id DESC LIMIT 300`).bind(...(level ? [level] : [])).all()).results;
  return json({ entries: rows });
});

const BACKUP_TABLES = ['pages', 'revisions', 'terms', 'page_terms', 'redirects', 'media', 'menus', 'settings'];

route('GET', '/backup', 'backups.manage', async c => {
  const data = { format: 'nikolaseo-cms-backup', version: 1, created_at: nowIso(), tables: {} };
  for (const t of BACKUP_TABLES) data.tables[t] = (await c.env.DB.prepare(`SELECT * FROM ${t}`).all()).results;
  data.tables.users = (await c.env.DB.prepare('SELECT id, email, name, role, caps, active, created_at FROM users').all()).results;
  audit(c, 'backup.downloaded');
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="nikolaseo-cms-backup-${data.created_at.slice(0, 10)}.json"`, 'Cache-Control': 'no-store' } });
});

route('POST', '/backup/restore', 'backups.manage', async c => {
  const data = c.body;
  if (data?.format !== 'nikolaseo-cms-backup') fail(422, 'This is not a NikolaSEO CMS backup file.');
  const parts = (c.body.parts || ['redirects', 'menus', 'terms', 'settings']).filter(p => ['redirects', 'menus', 'terms', 'settings', 'media'].includes(p));
  if (c.body.confirm !== 'RESTORE') fail(422, 'Type RESTORE to confirm.');
  if (parts.includes('redirects')) await backupRedirects(c, 'Before full backup restore');
  const restored = {};
  for (const t of parts) {
    const rows = data.tables?.[t] || [];
    if (!Array.isArray(rows)) fail(422, `Backup table ${t} is malformed.`);
    // Only real columns of the table are accepted; never trust names from the uploaded file.
    const allowed = new Set((await c.env.DB.prepare(`PRAGMA table_info(${t})`).all()).results.map(x => x.name));
    const stmts = [c.env.DB.prepare(`DELETE FROM ${t}`)];
    for (const r of rows) {
      const cols = Object.keys(r || {}).filter(k => allowed.has(k));
      if (!cols.length) continue;
      stmts.push(c.env.DB.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...cols.map(k => r[k])));
    }
    for (let i = 0; i < stmts.length; i += 200) await c.env.DB.batch(stmts.slice(i, i + 200));
    restored[t] = rows.length;
  }
  await bump(c.env, 'redirects_version'); await bump(c.env, 'content_version');
  audit(c, 'backup.restored', null, restored);
  return json({ ok: true, restored });
});

export { runScheduled as _runScheduled, HttpError };
