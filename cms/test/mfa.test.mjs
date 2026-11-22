import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../worker/src/mfa.js';

const RFC_SECRET = M.base32Encode(new TextEncoder().encode('12345678901234567890'));
test('base32 round trip + RFC secret', () => {
  assert.equal(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  const s = M.newSecret(); assert.equal(M.base32Encode(M.base32Decode(s)), s); assert.equal(s.length, 32);
});
test('RFC 6238 SHA-1 test vectors (8 digits)', async () => {
  for (const [t, want] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
    assert.equal(await M.hotp(RFC_SECRET, Math.floor(t / 30), 8), want, `T=${t}`);
  }
});
test('verify: window ±1, replay protection, format', async () => {
  const now = 1_700_000_000_000; const step = M.currentStep(now);
  const code = await M.hotp(RFC_SECRET, step);
  assert.equal(await M.verifyTotp(RFC_SECRET, code, { now }), step);
  assert.equal(await M.verifyTotp(RFC_SECRET, await M.hotp(RFC_SECRET, step - 1), { now }), step - 1);
  assert.equal(await M.verifyTotp(RFC_SECRET, await M.hotp(RFC_SECRET, step - 2), { now }), null);
  assert.equal(await M.verifyTotp(RFC_SECRET, code, { now, lastStep: step }), null, 'same code cannot be used twice');
  assert.equal(await M.verifyTotp(RFC_SECRET, '12345', { now }), null);
  assert.equal(await M.verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, { now }), step, 'spaces allowed');
});
test('secret encryption is bound to the user and the key', async () => {
  const env = { MFA_KEY: 'k'.repeat(40) };
  const blob = await M.encryptSecret(env, RFC_SECRET, 7);
  assert.ok(!blob.includes(RFC_SECRET));
  assert.equal(await M.decryptSecret(env, blob, 7), RFC_SECRET);
  await assert.rejects(M.decryptSecret(env, blob, 8));
  await assert.rejects(M.decryptSecret({ MFA_KEY: 'x'.repeat(40) }, blob, 7));
  await assert.rejects(M.encryptSecret({}, RFC_SECRET, 7), /MFA_KEY/);
});
test('recovery codes', async () => {
  const codes = M.newRecoveryCodes();
  assert.equal(new Set(codes).size, 10);
  assert.match(codes[0], /^[a-z2-9]{5}-[a-z2-9]{5}$/);
  assert.equal(await M.hashRecovery(codes[0].toUpperCase().replace('-', ' ')), await M.hashRecovery(codes[0]));
});
test('otpauth URI', () => {
  assert.equal(M.otpauthUri('ABC', 'me@x.com'), 'otpauth://totp/NikolaSEO%3Ame%40x.com?secret=ABC&issuer=NikolaSEO&algorithm=SHA1&digits=6&period=30');
});
