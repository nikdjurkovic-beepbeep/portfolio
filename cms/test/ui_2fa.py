# Browser E2E for two-factor authentication (run after api3.test.mjs).
import base64, hashlib, hmac, json, os, re, struct, sys, time
from playwright.sync_api import sync_playwright

W = 'http://localhost:8787'
OUT = '/tmp/ui'
os.makedirs(OUT, exist_ok=True)
results, errors = [], []
used = {}

def check(name, cond):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name, flush=True)

def hotp(secret, step):
    key = base64.b32decode(secret.replace(' ', '').upper() + '=' * ((8 - len(secret.replace(' ', '')) % 8) % 8))
    mac = hmac.new(key, struct.pack('>Q', step), hashlib.sha1).digest()
    o = mac[-1] & 15
    return str((struct.unpack('>I', mac[o:o + 4])[0] & 0x7fffffff) % 1000000).zfill(6)

def code(secret, last=None):
    # next acceptable code: step must be greater than the last one used
    floor = max(used.get(secret, last if last is not None else -1), last if last is not None else -1)
    while True:
        now = int(time.time() // 30)
        step = max(now - 1, floor + 1)
        if step <= now + 1:
            used[secret] = step
            return hotp(secret, step)
        time.sleep(1)

admin = json.load(open('/tmp/admin_totp.json'))
PW = 'correct horse battery staple'

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 1280, 'height': 860})   # real CSP (no bypass)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' and '401' not in m.text and '403' not in m.text else None)

    # 1. Admin: password then code
    pg.goto(f'{W}/admin/'); pg.wait_for_selector('#loginForm')
    pg.fill('#email', 'admin@nikolaseo.com'); pg.fill('#password', PW); pg.click('#loginForm button')
    pg.wait_for_selector('#codeForm')
    check('password step leads to code step', 'Enter your code' in pg.inner_text('.login-card'))
    pg.screenshot(path=f'{OUT}/20-2fa-code-step.png')
    pg.fill('#otp', '000000'); pg.wait_for_selector('#codeForm .form-error:not([hidden])')
    check('wrong code shows error (auto-submits at 6 digits)', 'not correct' in pg.inner_text('#codeForm .form-error'))
    pg.fill('#otp', code(admin['secret'], admin.get('lastStep')))
    pg.wait_for_selector('.stat-grid')
    check('correct code signs in', 'Content at a glance' in pg.inner_text('.workspace'))
    pg.goto(f'{W}/admin/#/account'); pg.wait_for_selector('#mfaPanel h2')
    time.sleep(0.5)
    txt = pg.inner_text('#mfaPanel')
    check('account shows 2FA on + recovery count', 'On' in txt and 'of 10 recovery codes' in txt)
    pg.screenshot(path=f'{OUT}/21-2fa-account.png', full_page=True)
    pg.goto(f'{W}/admin/#/users'); pg.wait_for_selector('.data-table')
    time.sleep(0.4)
    check('users list shows 2FA column', '2FA' in pg.inner_text('.data-table thead'))
    pg.goto(f'{W}/admin/#/settings'); pg.wait_for_selector('#s2fa')
    check('settings shows 2FA policy = staff', pg.input_value('#s2fa') == 'staff')

    # 2. Editor without 2FA under "staff" policy: forced enrolment
    e = b.new_context(viewport={'width': 1280, 'height': 860}).new_page()
    e.on('pageerror', lambda ex: errors.append(str(ex)))
    e.goto(f'{W}/admin/'); e.wait_for_selector('#loginForm')
    e.fill('#email', 'mfa-editor@x.com'); e.fill('#password', PW); e.click('#loginForm button')
    e.wait_for_selector('.qr-box svg', timeout=20000)
    check('forced enrolment screen with QR code', 'Set up two-factor authentication' in e.inner_text('.login-card'))
    e.screenshot(path=f'{OUT}/22-2fa-forced-setup.png', full_page=True)
    e.click('details.advanced summary')
    secret = e.inner_text('code.secret').replace(' ', '')
    check('manual key shown (32 base32 chars)', re.fullmatch(r'[A-Z2-7]{32}', secret) is not None)
    e.fill('.mfa-confirm input', '111111'); e.click('.mfa-confirm button')
    e.wait_for_selector('.mfa-steps .form-error:not([hidden])')
    check('wrong setup code refused', 'not correct' in e.inner_text('.mfa-steps .form-error'))
    e.fill('.mfa-confirm input', code(secret)); e.click('.mfa-confirm button')
    e.wait_for_selector('.recovery-codes')
    rcodes = [c.strip() for c in e.locator('.recovery-codes code').all_inner_texts()]
    check('10 recovery codes shown', len(rcodes) == 10)
    check('continue disabled until codes saved', e.is_disabled('[data-done]'))
    e.screenshot(path=f'{OUT}/23-2fa-recovery-codes.png', full_page=True)
    e.check('[data-saved]'); e.click('[data-done]')
    e.wait_for_selector('.stat-grid')
    check('after setup, editor reaches the dashboard', 'Content at a glance' in e.inner_text('.workspace'))

    # 3. Editor signs in again with a recovery code
    e.click('#signOut'); e.wait_for_selector('#loginForm')
    e.fill('#email', 'mfa-editor@x.com'); e.fill('#password', PW); e.click('#loginForm button')
    e.wait_for_selector('#codeForm'); e.click('#useRecovery')
    e.fill('#otp', rcodes[0]); e.click('#codeForm button[type=submit]')
    e.wait_for_selector('.stat-grid')
    check('recovery code sign-in works and warns', e.locator('.toast.warn').count() >= 1)

    # 4. Mobile code step
    m = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True).new_page()
    m.goto(f'{W}/admin/'); m.wait_for_selector('#loginForm')
    m.fill('#email', 'admin@nikolaseo.com'); m.fill('#password', PW); m.click('#loginForm button')
    m.wait_for_selector('#codeForm')
    m.screenshot(path=f'{OUT}/24-2fa-mobile-code.png')
    check('mobile code step fits the screen', m.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'))
    check('numeric keypad + one-time-code autofill hints', m.get_attribute('#otp', 'inputmode') == 'numeric' and m.get_attribute('#otp', 'autocomplete') == 'one-time-code')

    # 5. Add a new user from the CMS; the user sets a password through the one-time link
    pg.goto(f'{W}/admin/#/users'); pg.wait_for_selector('#addUser'); pg.click('#addUser')
    pg.fill('#uEmail', 'new-author@x.com'); pg.fill('#uName', 'New Author'); pg.select_option('#uRole', 'author')
    pg.click('.modal #save'); pg.wait_for_selector('.copy-row input')
    link = pg.input_value('.copy-row input')
    check('Add user creates the account and returns a one-time password link', '#reset=' in link)
    pg.screenshot(path=f'{OUT}/25-add-user-link.png')
    pg.click('.modal [data-close]'); pg.wait_for_selector('.data-table'); time.sleep(0.3)
    check('new user listed', 'new-author@x.com' in pg.inner_text('.data-table'))
    n = b.new_context(viewport={'width': 1280, 'height': 860}).new_page()
    n.goto(re.sub(r'^https?://[^/]+', W, link)); n.wait_for_selector('#resetForm')  # dev server reports the production host
    n.fill('#pw1', 'author password 123'); n.fill('#pw2', 'author password 123'); n.click('#resetForm button')
    n.wait_for_selector('#loginForm')
    n.fill('#email', 'new-author@x.com'); n.fill('#password', 'author password 123'); n.click('#loginForm button')
    n.wait_for_selector('.qr-box svg', timeout=20000)
    check('new user sets own password, signs in, and is asked to set up 2FA', True)

    # 6. Change your own password, then sign in with the new one (+ 2FA code)
    NEW_PW = 'a brand new admin password 2026'
    pg.goto(f'{W}/admin/#/account'); pg.wait_for_selector('#pwForm')
    pg.fill('#cur', 'wrong current password'); pg.fill('#nw', NEW_PW); pg.click('#pwForm button')
    pg.wait_for_selector('.toast.error')
    check('wrong current password refused', 'incorrect' in pg.inner_text('.toast.error').lower())
    pg.fill('#cur', PW); pg.fill('#nw', 'short'); pg.click('#pwForm button'); time.sleep(0.5)
    check('too-short new password refused by the form', pg.evaluate("!document.querySelector('#nw').checkValidity()"))
    pg.fill('#nw', NEW_PW); pg.click('#pwForm button')
    pg.wait_for_selector('.toast:has-text("Password changed")')
    check('password changed', True)
    pg.screenshot(path=f'{OUT}/26-account-password-2fa.png', full_page=True)
    pg.click('#signOut'); pg.wait_for_selector('#loginForm')
    pg.fill('#email', 'admin@nikolaseo.com'); pg.fill('#password', PW); pg.click('#loginForm button')
    pg.wait_for_selector('#loginForm .form-error:not([hidden])')
    check('old password no longer works', 'incorrect' in pg.inner_text('#loginForm .form-error'))
    pg.fill('#password', NEW_PW); pg.click('#loginForm button'); pg.wait_for_selector('#codeForm')
    pg.fill('#otp', code(admin['secret'], admin.get('lastStep')))
    pg.wait_for_selector('.stat-grid')
    check('new password + code signs in', True)

    check('no JS errors', not [x for x in errors if 'Failed to load resource' not in x])
    if errors: print('errors:', errors[:8])
    b.close()

failed = [n for n, ok in results if not ok]
print(f'\n{len(results) - len(failed)} passed, {len(failed)} failed', failed)
sys.exit(1 if failed else 0)
