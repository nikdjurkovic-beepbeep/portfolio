// Two-factor authentication end to end (run after api.test.mjs + api2.test.mjs on the same stack).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as M from '../worker/src/mfa.js';

const W = 'http://localhost:8787';
const PW = 'correct horse battery staple';
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Client {
  constructor() { this.cookie = ''; this.csrf = ''; }
  async req(method, path, body) {
    const h = {};
    if (this.cookie) h.Cookie = this.cookie;
    if (this.csrf && method !== 'GET') h['X-CSRF-Token'] = this.csrf;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(W + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const sc = res.headers.get('set-cookie');
    if (sc && sc.startsWith('cms_session=')) this.cookie = sc.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (data?.csrf) this.csrf = data.csrf;
    return { status: res.status, data, setCookie: sc };
  }
}

// Codes must move forward in time (replay protection); pick the next acceptable step.
const last = new Map();
async function code(secret) {
  for (;;) {
    const step = Math.max(M.currentStep() - 1, (last.get(secret) ?? -1) + 1);
    if (step <= M.currentStep() + 1) { last.set(secret, step); return M.hotp(secret, step); }
    await sleep(1000);
  }
}

const admin = new Client();
let adminSecret, adminRecovery, editorId;

test('enforcement: once required, an admin without 2FA can only reach the setup endpoints', async () => {
  assert.equal((await admin.req('POST', '/cms-api/auth/login', { email: 'admin@nikolaseo.com', password: PW })).status, 200);
  let me = await admin.req('GET', '/cms-api/auth/me');
  assert.equal(me.data.mfa.configured, true);
  assert.equal(me.data.mfa.enabled, false);
  assert.equal((await admin.req('PUT', '/cms-api/settings', { require_2fa: 'bogus' })).status, 422);
  assert.equal((await admin.req('PUT', '/cms-api/settings', { require_2fa: 'administrators' })).status, 200);
  const blocked = await admin.req('GET', '/cms-api/pages');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'mfa_enrollment_required');
  me = await admin.req('GET', '/cms-api/auth/me');
  assert.equal(me.data.mfa.mustEnroll, true);
});

test('setup: wrong code refused, right code enables 2FA and returns 10 recovery codes once', async () => {
  assert.equal((await admin.req('POST', '/cms-api/auth/2fa/enable', { code: '123456' })).status, 409, 'needs setup first');
  const s = await admin.req('POST', '/cms-api/auth/2fa/setup', {});
  assert.equal(s.status, 200);
  assert.match(s.data.uri, /^otpauth:\/\/totp\/NikolaSEO%3Aadmin%40nikolaseo\.com\?secret=[A-Z2-7]{32}&issuer=NikolaSEO/);
  adminSecret = s.data.secret;
  const wrong = await admin.req('POST', '/cms-api/auth/2fa/enable', { code: (Number(await M.hotp(adminSecret, M.currentStep())) + 1).toString().padStart(6, '0').slice(-6) });
  assert.equal(wrong.status, 422);
  const ok = await admin.req('POST', '/cms-api/auth/2fa/enable', { code: await code(adminSecret) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  adminRecovery = ok.data.recoveryCodes;
  assert.equal(adminRecovery.length, 10);
  assert.equal((await admin.req('GET', '/cms-api/pages')).status, 200, 'unblocked after enrolment');
  const me = await admin.req('GET', '/cms-api/auth/me');
  assert.equal(me.data.mfa.enabled, true);
  assert.equal(me.data.mfa.recoveryCodesRemaining, 10);
  fs.writeFileSync('/tmp/admin_totp.json', JSON.stringify({ secret: adminSecret, recovery: adminRecovery.slice(5) }));
});

test('secrets never leave the server', async () => {
  const me = JSON.stringify((await admin.req('GET', '/cms-api/auth/me')).data);
  const users = JSON.stringify((await admin.req('GET', '/cms-api/users')).data);
  const backup = (await admin.req('GET', '/cms-api/backup')).data;
  for (const blob of [me, users, JSON.stringify(backup)]) {
    assert.ok(!blob.includes(adminSecret), 'TOTP secret');
    assert.ok(!/totp_secret|recovery_codes|totp_pending/.test(blob), 'secret columns');
  }
});

test('login: password alone gives no session; code completes it; replayed code refused', async () => {
  await admin.req('POST', '/cms-api/auth/logout', {});
  const c = new Client();
  const step1 = await c.req('POST', '/cms-api/auth/login', { email: 'admin@nikolaseo.com', password: PW });
  assert.equal(step1.status, 200);
  assert.equal(step1.data.twoFactorRequired, true);
  assert.equal(step1.setCookie, null, 'no session cookie before the second factor');
  assert.equal((await c.req('GET', '/cms-api/pages')).status, 401);
  const used = await M.hotp(adminSecret, last.get(adminSecret)); // the code consumed at enrolment
  const replay = await c.req('POST', '/cms-api/auth/login/2fa', { challenge: step1.data.challenge, code: used });
  assert.equal(replay.status, 401, 'same code cannot be used twice');
  assert.equal(replay.data.attemptsLeft, 4);
  assert.equal((await c.req('POST', '/cms-api/auth/login/2fa', { challenge: 'forged', code: await code(adminSecret) })).status, 401);
  const ok = await c.req('POST', '/cms-api/auth/login/2fa', { challenge: step1.data.challenge, code: await code(adminSecret) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.match(ok.setCookie, /HttpOnly; SameSite=Strict/);
  assert.equal((await c.req('GET', '/cms-api/pages')).status, 200);
  assert.equal((await c.req('POST', '/cms-api/auth/login/2fa', { challenge: step1.data.challenge, code: await code(adminSecret) })).status, 401, 'challenge is single use');
  Object.assign(admin, c);
});

test('recovery codes work once each', async () => {
  const c = new Client();
  const s1 = await c.req('POST', '/cms-api/auth/login', { email: 'admin@nikolaseo.com', password: PW });
  const ok = await c.req('POST', '/cms-api/auth/login/2fa', { challenge: s1.data.challenge, recoveryCode: adminRecovery[0].toUpperCase() });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.mfa.recoveryCodesRemaining, 9);
  const s2 = await c.req('POST', '/cms-api/auth/login', { email: 'admin@nikolaseo.com', password: PW });
  assert.equal((await c.req('POST', '/cms-api/auth/login/2fa', { challenge: s2.data.challenge, recoveryCode: adminRecovery[0] })).status, 401);
  const audit = await admin.req('GET', '/cms-api/audit');
  assert.ok(audit.data.entries.some(e => e.action === 'auth.login' && /2fa-recovery-code/.test(e.detail || '')));
  assert.ok(audit.data.entries.some(e => e.action === 'auth.2fa_failed'));
});

test('required role cannot turn 2FA off; new recovery codes need a code; moving phones needs password + code', async () => {
  assert.equal((await admin.req('POST', '/cms-api/auth/2fa/disable', { password: PW, code: await code(adminSecret) })).status, 409);
  assert.equal((await admin.req('POST', '/cms-api/auth/2fa/recovery-codes', { code: '000000' })).status, 403);
  const rc = await admin.req('POST', '/cms-api/auth/2fa/recovery-codes', { code: await code(adminSecret) });
  assert.equal(rc.data.recoveryCodes.length, 10);
  adminRecovery = rc.data.recoveryCodes;
  assert.equal((await admin.req('POST', '/cms-api/auth/2fa/setup', {})).status, 403, 'no silent re-enrolment');
  assert.equal((await admin.req('POST', '/cms-api/auth/2fa/setup', { password: 'wrong', code: await code(adminSecret) })).status, 403);
  const mv = await admin.req('POST', '/cms-api/auth/2fa/setup', { password: PW, code: await code(adminSecret) });
  assert.equal(mv.status, 200);
  const newSecret = mv.data.secret;
  assert.equal((await admin.req('POST', '/cms-api/auth/2fa/enable', { code: await code(newSecret) })).status, 200);
  const c = new Client();
  const s = await c.req('POST', '/cms-api/auth/login', { email: 'admin@nikolaseo.com', password: PW });
  assert.equal((await c.req('POST', '/cms-api/auth/login/2fa', { challenge: s.data.challenge, code: await code(adminSecret) })).status, 401, 'old phone stops working');
  assert.equal((await c.req('POST', '/cms-api/auth/login/2fa', { challenge: s.data.challenge, code: await code(newSecret) })).status, 200);
  adminSecret = newSecret;
  Object.assign(admin, c);
  fs.writeFileSync('/tmp/admin_totp.json', JSON.stringify({ secret: adminSecret, lastStep: last.get(adminSecret) }));
});

test('optional role: editor can enable and disable; brute force on the code is cut off', async () => {
  const u = await admin.req('POST', '/cms-api/users', { email: 'mfa-editor@x.com', name: 'MFA Editor', role: 'editor', password: PW });
  editorId = u.data.user.id;
  const ed = new Client();
  assert.equal((await ed.req('POST', '/cms-api/auth/login', { email: 'mfa-editor@x.com', password: PW })).status, 200);
  assert.equal((await ed.req('GET', '/cms-api/pages')).status, 200, 'editors not forced under the "administrators" policy');
  const s = await ed.req('POST', '/cms-api/auth/2fa/setup', {});
  const secret = s.data.secret;
  await ed.req('POST', '/cms-api/auth/2fa/enable', { code: await code(secret) });
  const c = new Client();
  const ch = await c.req('POST', '/cms-api/auth/login', { email: 'mfa-editor@x.com', password: PW });
  let r;
  for (let i = 0; i < 5; i++) r = await c.req('POST', '/cms-api/auth/login/2fa', { challenge: ch.data.challenge, code: '000000' });
  assert.equal(r.status, 401);
  assert.equal(r.data.code, 'challenge_expired', 'challenge destroyed after 5 wrong codes');
  assert.equal((await c.req('POST', '/cms-api/auth/login/2fa', { challenge: ch.data.challenge, code: await code(secret) })).status, 401);
  assert.equal((await ed.req('POST', '/cms-api/auth/2fa/disable', { password: PW, code: '000000' })).status, 403);
  assert.equal((await ed.req('POST', '/cms-api/auth/2fa/disable', { password: PW, code: await code(secret) })).status, 200);
  assert.equal((await ed.req('GET', '/cms-api/auth/me')).data.mfa.enabled, false);
});

test('admin reset of a lost authenticator; cannot reset own; "staff" policy forces editors to enrol', async () => {
  const ed = new Client();
  await ed.req('POST', '/cms-api/auth/login', { email: 'mfa-editor@x.com', password: 'x' }); // failed attempt is fine
  await ed.req('POST', '/cms-api/auth/login', { email: 'mfa-editor@x.com', password: PW });
  const s = await ed.req('POST', '/cms-api/auth/2fa/setup', {});
  await ed.req('POST', '/cms-api/auth/2fa/enable', { code: await code(s.data.secret) });
  const me = (await admin.req('GET', '/cms-api/auth/me')).data.user;
  assert.equal((await admin.req('POST', `/cms-api/users/${me.id}/reset-2fa`, {})).status, 409);
  const reset = await admin.req('POST', `/cms-api/users/${editorId}/reset-2fa`, {});
  assert.equal(reset.status, 200);
  assert.equal((await ed.req('GET', '/cms-api/auth/me')).status, 401, 'editor signed out everywhere');
  assert.equal((await admin.req('GET', '/cms-api/users')).data.users.find(x => x.id === editorId).twoFactor, false);
  assert.equal((await admin.req('PUT', '/cms-api/settings', { require_2fa: 'staff' })).status, 200);
  const ed2 = new Client();
  const l = await ed2.req('POST', '/cms-api/auth/login', { email: 'mfa-editor@x.com', password: PW });
  assert.equal(l.status, 200);
  assert.equal(l.data.mfa.mustEnroll, true);
  assert.equal((await ed2.req('GET', '/cms-api/pages')).data.code, 'mfa_enrollment_required');
});

test('password reset link does not bypass 2FA', async () => {
  const me = (await admin.req('GET', '/cms-api/auth/me')).data.user;
  const link = await admin.req('POST', `/cms-api/users/${me.id}/reset-link`, {});
  const token = link.data.url.split('#reset=')[1];
  const NEWPW = 'another long password 42';
  assert.equal((await new Client().req('POST', '/cms-api/auth/reset', { token, password: NEWPW })).status, 200);
  const c = new Client();
  const l = await c.req('POST', '/cms-api/auth/login', { email: 'admin@nikolaseo.com', password: NEWPW });
  assert.equal(l.data.twoFactorRequired, true);
  // restore the original password for later suites
  const ok = await c.req('POST', '/cms-api/auth/login/2fa', { challenge: l.data.challenge, code: await code(adminSecret) });
  assert.equal(ok.status, 200);
  assert.equal((await c.req('POST', '/cms-api/auth/password', { current: NEWPW, next: PW })).status, 200);
  fs.writeFileSync('/tmp/admin_totp.json', JSON.stringify({ secret: adminSecret, lastStep: last.get(adminSecret) }));
});
