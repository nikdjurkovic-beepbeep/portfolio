// Authentication, sessions, CSRF and role-based capabilities.

export const ROLES = ['administrator', 'editor', 'author', 'contributor', 'subscriber'];

export const ALL_CAPS = [
  'pages.read', 'pages.create', 'pages.edit_own', 'pages.edit_any', 'pages.publish_own', 'pages.publish_any',
  'pages.delete_own', 'pages.delete_any', 'pages.private', 'unfiltered_html', 'revisions.read',
  'media.read', 'media.upload', 'media.edit', 'media.delete',
  'seo.edit', 'seo.advanced', 'menus.manage', 'terms.manage',
  'redirects.read', 'redirects.manage',
  'private.read', 'users.manage', 'settings.manage', 'backups.manage', 'audit.read'
];

const ROLE_CAPS = {
  administrator: ALL_CAPS,
  editor: ['pages.read', 'pages.create', 'pages.edit_own', 'pages.edit_any', 'pages.publish_own', 'pages.publish_any', 'pages.delete_own', 'pages.delete_any',
    'pages.private', 'unfiltered_html', 'revisions.read', 'media.read', 'media.upload', 'media.edit', 'media.delete', 'seo.edit', 'seo.advanced',
    'menus.manage', 'terms.manage', 'redirects.read', 'private.read'],
  author: ['pages.read', 'pages.create', 'pages.edit_own', 'pages.publish_own', 'pages.delete_own', 'revisions.read', 'media.read', 'media.upload', 'seo.edit', 'private.read'],
  contributor: ['pages.read', 'pages.create', 'pages.edit_own', 'revisions.read', 'media.read', 'private.read'],
  subscriber: ['private.read']
};

export function capsFor(user) {
  const base = new Set(ROLE_CAPS[user.role] || []);
  let extra = {};
  try { extra = JSON.parse(user.caps || '{}'); } catch { /* ignore */ }
  (extra.grant || []).filter(c => ALL_CAPS.includes(c)).forEach(c => base.add(c));
  if (user.role !== 'administrator') (extra.revoke || []).forEach(c => base.delete(c));
  return base;
}

const enc = new TextEncoder();
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export function randomToken(bytes = 32) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return b64(a).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const ITERATIONS = 100000; // Workers' PBKDF2 maximum

export async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16)), iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return `pbkdf2$${iterations}$${b64(salt)}$${b64(bits)}`;
}

export async function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('pbkdf2$')) return false;
  const [, iter, salt, hash] = stored.split('$');
  const candidate = await hashPassword(password, unb64(salt), Number(iter));
  const a = enc.encode(candidate), b = enc.encode(stored);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0 && hash.length > 0;
}

export function passwordProblems(pw) {
  const problems = [];
  if (typeof pw !== 'string' || pw.length < 12) problems.push('Use at least 12 characters.');
  if (pw && pw.length > 256) problems.push('Use at most 256 characters.');
  return problems;
}

export async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return b64(sig).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function parseCookies(header = '') {
  const out = {};
  header.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

export function cookieName(env) { return env.DEV_INSECURE_COOKIES === '1' ? 'cms_session' : '__Host-cms_session'; }

export function sessionCookie(env, value, maxAge) {
  const secure = env.DEV_INSECURE_COOKIES === '1' ? '' : '; Secure';
  return `${cookieName(env)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

const SESSION_HOURS = 12;

export async function createSession(env, user, request) {
  const token = randomToken();
  const csrf = randomToken(18);
  const expires = new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString();
  await env.DB.prepare('INSERT INTO sessions (id_hash, user_id, csrf, expires_at, ip, ua) VALUES (?,?,?,?,?,?)')
    .bind(await sha256(token), user.id, csrf, expires, request.headers.get('CF-Connecting-IP') || '', (request.headers.get('User-Agent') || '').slice(0, 200)).run();
  await env.DB.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").bind(user.id).run();
  return { token, csrf, maxAge: SESSION_HOURS * 3600 };
}

/** Resolve the session cookie to a user. Sliding expiry, refreshed at most every 5 minutes. */
export async function getSession(env, request) {
  const token = parseCookies(request.headers.get('Cookie') || '')[cookieName(env)];
  if (!token) return null;
  const idHash = await sha256(token);
  const row = await env.DB.prepare(`SELECT s.id_hash, s.csrf, s.expires_at, s.last_seen, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`).bind(idHash).first();
  if (!row) return null;
  if (!row.active || new Date(row.expires_at) < new Date()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(idHash).run();
    return null;
  }
  if (Date.now() - new Date(`${row.last_seen}Z`).getTime() > 5 * 60e3) {
    const expires = new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString();
    await env.DB.prepare("UPDATE sessions SET last_seen = datetime('now'), expires_at = ? WHERE id_hash = ?").bind(expires, idHash).run();
  }
  const { pw_hash, reset_hash, reset_expires, id_hash, csrf, ...user } = row;
  return { idHash, csrf, user, caps: capsFor(row) };
}

/** Simple fixed-window rate limiter backed by D1. Returns true when the request is allowed. */
export async function rateLimit(env, key, limit, windowSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare('SELECT count, window_start FROM login_attempts WHERE key = ?').bind(key).first();
  if (!row || now - row.window_start > windowSeconds) {
    await env.DB.prepare('INSERT INTO login_attempts (key, count, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start').bind(key, now).run();
    return true;
  }
  if (row.count >= limit) return false;
  await env.DB.prepare('UPDATE login_attempts SET count = count + 1 WHERE key = ?').bind(key).run();
  return true;
}

/** True when `key` has reached `limit` failures inside the window (does not count this request). */
export async function rateLimited(env, key, limit, windowSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare('SELECT count, window_start FROM login_attempts WHERE key = ?').bind(key).first();
  return Boolean(row && now - row.window_start <= windowSeconds && row.count >= limit);
}

/** Record one failure for `key`. */
export async function rateHit(env, key, windowSeconds) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO login_attempts (key, count, window_start) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET count = CASE WHEN ? - window_start > ? THEN 1 ELSE count + 1 END,
    window_start = CASE WHEN ? - window_start > ? THEN excluded.window_start ELSE window_start END`).bind(key, now, now, windowSeconds, now, windowSeconds).run();
}

export async function clearRateLimit(env, key) {
  await env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key).run();
}
