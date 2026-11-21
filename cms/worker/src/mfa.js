// Two-factor authentication: RFC 6238 TOTP (Google Authenticator, Microsoft Authenticator,
// 1Password, Authy, …), encrypted secrets, one-time recovery codes.

const enc = new TextEncoder();
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const ISSUER = 'NikolaSEO';
export const PERIOD = 30;
export const DIGITS = 6;

export function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i === -1) throw new Error('Invalid base32 secret.');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export function newSecret() {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20))); // 160-bit, RFC 4226 recommendation
}

/** HOTP value for a counter (RFC 4226), SHA-1 as Google Authenticator expects. */
export async function hotp(secretB32, counter, digits = DIGITS) {
  const key = await crypto.subtle.importKey('raw', base32Decode(secretB32), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8);
  let c = BigInt(counter);
  for (let i = 7; i >= 0; i--) { msg[i] = Number(c & 0xffn); c >>= 8n; }
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const off = mac[mac.length - 1] & 15;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / PERIOD);

/**
 * Check a 6-digit code, allowing one step of clock drift either way.
 * Returns the matched time step, or null. Callers must reject steps <= the last one used (replay).
 */
export async function verifyTotp(secretB32, code, { now = Date.now(), lastStep = null, window = 1 } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const step = currentStep(now);
  for (let d = -window; d <= window; d++) {
    const s = step + d;
    if (lastStep !== null && s <= lastStep) continue;
    if (await hotp(secretB32, s) === c) return s;
  }
  return null;
}

export function otpauthUri(secretB32, account) {
  const label = encodeURIComponent(`${ISSUER}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD}`;
}

/* --------------------------------------------- Secret encryption (AES-GCM) ---- */

async function aesKey(env) {
  if (!env.MFA_KEY || env.MFA_KEY.length < 32) {
    throw Object.assign(new Error('Two-factor authentication is not configured on the server (MFA_KEY secret missing or shorter than 32 characters).'), { status: 503 });
  }
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`nikolaseo-cms-totp:${env.MFA_KEY}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export async function encryptSecret(env, secretB32, userId) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`user:${userId}`) }, await aesKey(env), enc.encode(secretB32));
  return `v1.${b64(iv)}.${b64(ct)}`;
}

export async function decryptSecret(env, stored, userId) {
  const [v, iv, ct] = String(stored || '').split('.');
  if (v !== 'v1' || !iv || !ct) throw new Error('Stored two-factor secret is unreadable.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(`user:${userId}`) }, await aesKey(env), unb64(ct));
  return new TextDecoder().decode(pt);
}

/* --------------------------------------------------------- Recovery codes ---- */

const RC_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o/1/l/i

export function newRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () => {
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    const s = [...bytes].map(b => RC_ALPHABET[b % RC_ALPHABET.length]).join('');
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

export const normaliseRecovery = code => String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export async function hashRecovery(code) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(`rc:${normaliseRecovery(code)}`));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
