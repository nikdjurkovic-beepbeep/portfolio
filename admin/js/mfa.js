// Two-factor authentication UI: authenticator setup (QR), recovery codes, account panel.
import { esc, api, toast, toastError, modal, confirmDialog, download, copyText, action, fmtDate } from './core.js';
import qrcode from '../vendor/qrcode/qrcode.js';

const groups = s => s.replace(/(.{4})/g, '$1 ').trim();

function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true, alt: 'QR code for your authenticator app', title: '' });
}

export function recoveryCodesHtml(codes) {
  return `<div class="recovery-codes" aria-label="Recovery codes">${codes.map(c => `<code>${esc(c)}</code>`).join('')}</div>`;
}

function recoveryActions(root, codes, email) {
  const text = `NikolaSEO Content Studio — recovery codes for ${email}\nGenerated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC\nEach code works once. Keep them somewhere safe (password manager or printed).\n\n${codes.join('\n')}\n`;
  root.querySelector('[data-rc-copy]').onclick = () => copyText(codes.join('\n'));
  root.querySelector('[data-rc-download]').onclick = () => download('nikolaseo-recovery-codes.txt', text, 'text/plain');
  root.querySelector('[data-rc-print]').onclick = () => {
    const w = window.open('', '_blank', 'width=480,height=640');
    if (!w) return toast('Allow pop-ups to print, or download the codes instead.', 'error');
    w.document.write(`<pre style="font:16px/1.7 monospace;padding:24px">${esc(text)}</pre>`); w.document.close(); w.print();
  };
}

/**
 * Setup flow rendered into `root`. Steps: QR + key → confirm code → recovery codes.
 * `verify` = { password, code } when moving an existing 2FA to a new phone.
 */
export async function enrollmentFlow(root, { email, verify = null, onDone }) {
  root.innerHTML = '<p class="muted">Preparing…</p>';
  let setup;
  try { setup = await api('POST', '/auth/2fa/setup', verify || {}); } catch (e) { root.innerHTML = `<div class="notice error">${esc(e.message)}</div>`; return; }
  root.innerHTML = `<ol class="mfa-steps">
    <li><b>Install an authenticator app</b> on your phone — Google Authenticator, Microsoft Authenticator, 1Password, Authy or similar.</li>
    <li><b>Scan this QR code</b> with the app (tap <b>+</b> → <b>Scan a QR code</b>).
      <div class="qr-box">${qrSvg(setup.uri)}</div>
      <details class="advanced"><summary>Can't scan? Enter the key manually</summary>
        <dl class="kv compact"><dt>Account</dt><dd>${esc(setup.account)}</dd><dt>Key</dt><dd><code class="secret">${esc(groups(setup.secret))}</code> <button type="button" class="button quiet small" data-copy-key>Copy</button></dd><dt>Type</dt><dd>Time-based, 6 digits, 30 seconds</dd></dl>
      </details></li>
    <li><b>Enter the 6-digit code</b> the app shows for <b>${esc(setup.issuer)}</b>:
      <form class="inline-form mfa-confirm" data-confirm><input class="otp-input" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" placeholder="123 456" aria-label="6-digit code" required><button class="button primary">Turn on</button></form>
      <div class="form-error" role="alert" hidden></div></li>
  </ol>`;
  root.querySelector('[data-copy-key]').onclick = () => copyText(setup.secret);
  const form = root.querySelector('[data-confirm]');
  const input = form.querySelector('input');
  input.focus();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const r = await api('POST', '/auth/2fa/enable', { code: input.value.replace(/\s/g, '') });
      root.innerHTML = `<div class="notice ok-notice"><b>Two-factor authentication is on.</b> From now on you'll enter a code from your app after your password.${verify ? ' The old phone no longer works.' : ''} Other devices were signed out.</div>
        <h3>Save your recovery codes</h3>
        <p>If you lose your phone, each of these codes lets you sign in <b>once</b>. They are shown only now.</p>
        ${recoveryCodesHtml(r.recoveryCodes)}
        <div class="btn-row"><button type="button" class="button secondary small" data-rc-copy>Copy</button><button type="button" class="button secondary small" data-rc-download>Download .txt</button><button type="button" class="button secondary small" data-rc-print>Print</button></div>
        <label class="check"><input type="checkbox" data-saved> I have saved my recovery codes somewhere safe</label>
        <button class="button primary" data-done disabled>Continue</button>`;
      recoveryActions(root, r.recoveryCodes, email);
      root.querySelector('[data-saved]').onchange = ev => { root.querySelector('[data-done]').disabled = !ev.target.checked; };
      root.querySelector('[data-done]').onclick = () => onDone?.();
    } catch (err) {
      const box = root.querySelector('.form-error'); box.hidden = false; box.textContent = err.message;
      input.select();
    } finally { btn.disabled = false; }
  });
}

/** Full-screen setup when the policy requires 2FA and the account has none yet. */
export function forcedEnrollment(root, { email, onDone, onSignOut }) {
  root.innerHTML = `<section class="login-screen"><div class="login-card wide-card">
    <a class="brand" href="/"><span class="brand-mark">ND<span>.</span></span><span class="brand-copy">NIKOLASEO <small>CONTENT STUDIO</small></span></a>
    <div class="login-kicker">SECURE YOUR ACCOUNT</div><h1>Set up two-factor authentication</h1>
    <p class="login-intro">Two-factor authentication is required for your account. It takes about a minute.</p>
    <div id="enrollRoot"></div>
    <p class="hint"><button class="button quiet small" id="enrollSignOut">Sign out</button></p>
  </div></section>`;
  root.querySelector('#enrollSignOut').onclick = onSignOut;
  enrollmentFlow(root.querySelector('#enrollRoot'), { email, onDone });
}

/** Account page panel. */
export function accountPanel(container, { me, onChange }) {
  const m = me.mfa;
  container.innerHTML = `<h2>Two-factor authentication</h2>
    ${!m.configured ? '<div class="notice warn">Not available yet: the server has no MFA_KEY secret. An administrator must add it (see the deploy guide).</div>' : ''}
    ${m.enabled
      ? `<p><span class="pill ok-pill">On</span> since ${fmtDate(m.enabledAt, false)} · authenticator app</p>
         <p class="muted">${m.recoveryCodesRemaining} of 10 recovery codes unused.${m.recoveryCodesRemaining <= 3 ? ' <b class="warn-text">Generate new ones soon.</b>' : ''}</p>
         <div class="btn-col"><button class="button secondary small" data-move>Move to a new phone…</button><button class="button secondary small" data-regen>New recovery codes…</button>${m.required ? '<small class="hint">Required for your role, so it cannot be turned off.</small>' : '<button class="button quiet small danger-text" data-disable>Turn off…</button>'}</div>`
      : `<p><span class="pill">Off</span> ${m.required ? '<b class="warn-text">Required for your role.</b>' : ''}</p><p class="muted">Protect your account with a 6-digit code from Google Authenticator or another authenticator app, in addition to your password.</p>
         <button class="button primary" data-enable ${m.configured ? '' : 'disabled'}>Set up two-factor authentication</button>`}`;
  const proof = (title, extra = '') => modal(title, `${extra}<div class="field"><label for="pfPw">Current password</label><input id="pfPw" type="password" autocomplete="current-password"></div>
    <div class="field"><label for="pfCode">Code from your authenticator app</label><input id="pfCode" class="otp-input" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123 456"><small class="hint">Lost the phone? <button type="button" class="link-btn" data-use-rc>Use a recovery code</button></small></div>`,
    { actions: '<button class="button quiet" data-cancel>Cancel</button><button class="button primary" data-go>Continue</button>' });
  const proofBody = m2 => {
    const v = m2.$('#pfCode').value.trim();
    return m2.$('#pfCode').dataset.mode === 'recovery' ? { password: m2.$('#pfPw')?.value, recoveryCode: v } : { password: m2.$('#pfPw')?.value, code: v.replace(/\s/g, '') };
  };
  const bindRc = m2 => m2.$('[data-use-rc]')?.addEventListener('click', () => { const i = m2.$('#pfCode'); i.dataset.mode = 'recovery'; i.removeAttribute('inputmode'); i.maxLength = 20; i.placeholder = 'abcde-fghjk'; i.previousElementSibling.textContent = 'Recovery code'; i.focus(); });

  container.querySelector('[data-enable]')?.addEventListener('click', () => {
    const d = modal('Set up two-factor authentication', '<div id="enrollModal"></div>', { wide: true });
    enrollmentFlow(d.$('#enrollModal'), { email: me.user.email, onDone: () => { d.close(); onChange(); } });
  });
  container.querySelector('[data-move]')?.addEventListener('click', () => {
    const p = proof('Move to a new phone', '<p class="muted">Confirm it\'s you, then scan a new QR code with the new phone. The old phone stops working once the new one is confirmed.</p>');
    bindRc(p);
    p.$('[data-cancel]').onclick = () => p.close();
    p.$('[data-go]').onclick = () => {
      const body = proofBody(p);
      p.close();
      const d = modal('Move to a new phone', '<div id="enrollModal"></div>', { wide: true });
      enrollmentFlow(d.$('#enrollModal'), { email: me.user.email, verify: body, onDone: () => { d.close(); onChange(); } });
    };
  });
  container.querySelector('[data-regen]')?.addEventListener('click', () => {
    const p = modal('New recovery codes', '<p class="muted">Your old recovery codes stop working.</p><div class="field"><label for="pfCode">Code from your authenticator app</label><input id="pfCode" class="otp-input" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123 456"></div>',
      { actions: '<button class="button quiet" data-cancel>Cancel</button><button class="button primary" data-go>Generate</button>' });
    p.$('[data-cancel]').onclick = () => p.close();
    p.$('[data-go]').onclick = action(p.$('[data-go]'), async () => {
      const r = await api('POST', '/auth/2fa/recovery-codes', { code: p.$('#pfCode').value.replace(/\s/g, '') });
      p.$('.modal-body').innerHTML = `<p>Save these now — they are shown only once.</p>${recoveryCodesHtml(r.recoveryCodes)}<div class="btn-row"><button type="button" class="button secondary small" data-rc-copy>Copy</button><button type="button" class="button secondary small" data-rc-download>Download .txt</button><button type="button" class="button secondary small" data-rc-print>Print</button></div>`;
      recoveryActions(p.el, r.recoveryCodes, me.user.email);
      p.$('.modal-actions').innerHTML = '<button class="button primary" data-close-done>Done</button>';
      p.$('[data-close-done]').onclick = () => { p.close(); onChange(); };
    }, 'Checking…');
  });
  container.querySelector('[data-disable]')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Turn off two-factor authentication?', 'Your account will be protected by your password only.', { danger: true, confirmLabel: 'Continue' }))) return;
    const p = proof('Turn off two-factor authentication');
    bindRc(p);
    p.$('[data-cancel]').onclick = () => p.close();
    p.$('[data-go]').onclick = action(p.$('[data-go]'), async () => { await api('POST', '/auth/2fa/disable', proofBody(p)); p.close(); toast('Two-factor authentication turned off.'); onChange(); }, 'Checking…');
  });
}

export { toastError };
