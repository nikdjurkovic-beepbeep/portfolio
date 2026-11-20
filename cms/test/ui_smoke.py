# Browser E2E for the Content Studio (run after the API suites seeded the local stack).
import re, sys, os, time, json
from playwright.sync_api import sync_playwright, expect

W = 'http://localhost:8787'
OUT = '/tmp/ui'
os.makedirs(OUT, exist_ok=True)
errors = []
results = []

def check(name, cond):
    results.append((name, bool(cond)))
    print(('PASS ' if cond else 'FAIL ') + name, flush=True)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, bypass_csp=True)  # Playwright's wait_for_function needs eval; mobile context below runs with the real CSP
    pg = ctx.new_page()
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
    pg.on('response', lambda r: errors.append(f'HTTP {r.status} {r.url}') if r.status == 404 else None)

    pg.goto(f'{W}/admin/')
    pg.wait_for_selector('#loginForm')
    pg.screenshot(path=f'{OUT}/01-login.png')
    pg.fill('#email', 'admin@nikolaseo.com'); pg.fill('#password', 'wrong-password-123')
    pg.click('#loginForm button')
    pg.wait_for_selector('.form-error:not([hidden])')
    check('wrong password shows error', 'incorrect' in pg.inner_text('.form-error'))
    pg.fill('#password', 'correct horse battery staple'); pg.click('#loginForm button')
    pg.wait_for_selector('.stat-grid')
    pg.screenshot(path=f'{OUT}/02-dashboard.png', full_page=True)
    check('dashboard loads', 'Content at a glance' in pg.inner_text('.workspace'))

    # Pages list
    pg.goto(f'{W}/admin/#/pages'); pg.wait_for_selector('#rows tr')
    check('pages list shows site pages', pg.locator('#rows tr').count() >= 14)
    pg.screenshot(path=f'{OUT}/03-pages.png', full_page=True)

    # Editor
    pg.click('#rows a:has-text("SEO Myths")')
    pg.wait_for_function('window.tinymce && tinymce.activeEditor && tinymce.activeEditor.initialized', timeout=30000)
    time.sleep(1)
    check('fresh editor is not dirty', 'Unsaved' not in pg.inner_text('#saveState'))
    pg.screenshot(path=f'{OUT}/04-editor.png')
    ed_html = pg.evaluate('tinymce.activeEditor.getContent()')
    check('editor loaded article body', 'Why SEO myths survive' in ed_html)
    check('hero headline field', pg.input_value('#heroHeadline').startswith('10 SEO Myths'))
    check('link list has site pages', pg.evaluate("tinymce.activeEditor.options.get('link_list').length") >= 10)
    check('editor canvas uses site styles', pg.evaluate("getComputedStyle(tinymce.activeEditor.getBody()).backgroundColor") in ('rgb(11, 18, 32)',))
    # open the link dialog via UI to verify it renders with rel/target/link list
    pg.evaluate("""() => { const ed = tinymce.activeEditor; const p = ed.getBody().querySelector('p'); const r = ed.dom.createRng(); r.setStart(p.firstChild, 0); r.setEnd(p.firstChild, 6); ed.selection.setRng(r); ed.execCommand('mceLink'); }""")
    pg.wait_for_selector('.tox-dialog')
    dlg = pg.inner_text('.tox-dialog')
    check('link dialog has link list, target and rel', 'Link list' in dlg and 'Open link in' in dlg and 'Rel' in dlg)
    print(repr(dlg))
    pg.screenshot(path=f'{OUT}/05-link-dialog.png')
    pg.keyboard.press('Escape')
    # make an edit + insert an internal link programmatically, then save draft
    pg.evaluate("""() => { const ed = tinymce.activeEditor; ed.focus(); ed.selection.select(ed.getBody().querySelector('h2'), false); ed.selection.collapse(false); ed.insertContent('<p>UI edit marker <a href="/crawl-budget/#why">crawl budget</a></p>'); }""")
    pg.fill('#heroLead', pg.input_value('#heroLead') + ' (UI)')
    check('dirty state shown', 'Unsaved' in pg.inner_text('#saveState'))
    pg.click('#saveBtn')
    pg.wait_for_selector('.toast:has-text("Draft saved")')
    check('draft saved via UI', True)
    # SEO tab
    pg.click('[data-ptab="seo"]')
    pg.fill('#seoTitle', 'A much longer SEO title that will certainly exceed the pixel width Google shows in results pages today')
    check('SERP counter warns when too long', 'truncated' in pg.inner_text('#titleCount'))
    pg.fill('#seoTitle', '10 SEO Myths That Won’t Die | NikolaSEO')
    pg.fill('#seoSchema', '{ "bad": ')
    pg.click('#schemaValidate')
    check('schema validation flags bad JSON', 'Block 1' in pg.inner_text('#schemaMsg'))
    pg.click('#schemaFormat') if False else None
    pg.evaluate("document.querySelector('#seoSchema').value = ''")
    pg.screenshot(path=f'{OUT}/06-seo-panel.png')
    pg.click('[data-ptab="publish"]')
    pg.screenshot(path=f'{OUT}/07-publish-panel.png')
    # Publish
    pg.click('#publishBtn')
    pg.wait_for_selector('.modal [data-ok]'); pg.click('.modal [data-ok]')
    pg.wait_for_selector('.toast:has-text("Published")', timeout=30000)
    time.sleep(1.5)
    pg.wait_for_function('window.tinymce && tinymce.activeEditor && tinymce.activeEditor.initialized', timeout=30000)
    live = pg.request.get(f'{W}/seo-myths/').text()
    check('published content is live', 'UI edit marker' in live and '(UI)' in live)
    # revisions
    pg.wait_for_selector('#revBtn'); pg.click('#revBtn'); pg.wait_for_selector('.modal .data-table tr')
    check('revisions listed', pg.locator('.modal tbody tr').count() >= 3)
    pg.click('.modal [data-compare]'); pg.wait_for_selector('#diffBox h3')
    pg.screenshot(path=f'{OUT}/08-revisions.png')
    pg.click('.modal [data-close]')

    # Redirects
    pg.goto(f'{W}/admin/#/redirects'); pg.wait_for_selector('#rrows tr')
    pg.screenshot(path=f'{OUT}/09-redirects.png', full_page=False)
    check('redirect list rendered', pg.locator('#rrows tr').count() >= 10)
    pg.click('#addBtn'); pg.wait_for_selector('#fSource')
    pg.fill('#fSource', '/ui-old'); pg.fill('#fTarget', '/ui-old')
    check('self redirect flagged live in form', 'self-redirect' in pg.inner_text('#fVal'))
    pg.fill('#fTarget', '/seo-myths/'); pg.select_option('#fCode', '308')
    pg.fill('#fTest', '/ui-old?x=1'); pg.click('#fTestBtn'); pg.wait_for_selector('#fTestOut .trace')
    check('pre-save test shows 308 hop', '308' in pg.inner_text('#fTestOut'))
    pg.screenshot(path=f'{OUT}/10-redirect-form.png')
    pg.click('#fSave'); pg.wait_for_selector('.toast:has-text("Redirect created")')
    r = pg.request.get(f'{W}/ui-old?x=1', max_redirects=0)
    check('UI-created redirect is live (308 + Location)', r.status == 308 and r.headers['location'].endswith('/seo-myths/?x=1'))
    pg.fill('#testUrl', '/loop-a'); pg.click('#testForm button'); pg.wait_for_selector('#testOut .trace-final')
    check('tester reports loop', 'loop' in pg.inner_text('#testOut').lower())
    # CSV import wizard
    csv = 'source,target,code\n/ui-a/,/seo-myths/,301\n/ui-b/,/nope target,301\n/ui-old,/crawl-budget/,301\n'
    open('/tmp/ui.csv', 'w').write(csv)
    pg.click('#importBtn'); pg.wait_for_selector('#csvFile', state='attached')
    pg.set_input_files('#csvFile', '/tmp/ui.csv')
    pg.wait_for_selector('#commitBtn')
    txt = pg.inner_text('#step2')
    check('import preview counts', re.search(r'Valid \(new\)\s*1', txt, re.I) and re.search(r'Invalid\s*1', txt, re.I) and re.search(r'Conflicts\s*1', txt, re.I))
    pg.screenshot(path=f'{OUT}/11-import-preview.png')
    # fix the invalid row inline and re-validate
    pg.fill('input.cell[data-row="3"][data-k="target"]', '/crawl-budget/')
    pg.dispatch_event('input.cell[data-row="3"][data-k="target"]', 'change')
    pg.click('#revalidate'); pg.wait_for_selector('#commitBtn')
    check('inline fix makes row valid', re.search(r'Valid \(new\)\s*2', pg.inner_text('#step2'), re.I))
    pg.click('#commitBtn'); pg.wait_for_selector('#doneBtn')
    check('import summary shown', 'import complete' in pg.inner_text('#step2').lower())
    pg.screenshot(path=f'{OUT}/12-import-summary.png')
    pg.click('#doneBtn')
    check('imported redirect live', pg.request.get(f'{W}/ui-b/', max_redirects=0).status == 301)

    # Media
    pg.goto(f'{W}/admin/#/media'); pg.wait_for_selector('#grid')
    import base64
    open('/tmp/ui.png', 'wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='))
    pg.set_input_files('#fileIn', '/tmp/ui.png')
    pg.wait_for_selector('.toast:has-text("uploaded")', timeout=30000)
    pg.wait_for_selector('.modal #mdAlt')
    pg.fill('#mdAlt', 'UI uploaded pixel'); pg.click('.modal [data-save]')
    pg.wait_for_selector('.toast:has-text("Details saved")')
    pg.screenshot(path=f'{OUT}/13-media.png', full_page=True)
    check('media grid shows items', pg.locator('.media-card').count() >= 3)

    # Navigation
    pg.goto(f'{W}/admin/#/menus'); pg.wait_for_selector('#tree li')
    time.sleep(1.5)
    pg.screenshot(path=f'{OUT}/14-navigation.png', full_page=True)
    check('menu tree rendered', pg.locator('#tree .menu-item').count() >= 10)

    # Users, settings, activity
    for view, marker in [('users', 'Roles'), ('settings', 'System'), ('activity', 'Activity log'), ('terms', 'Categories'), ('account', 'Change password')]:
        pg.goto(f'{W}/admin/#/{view}'); pg.wait_for_selector('.page-heading')
        time.sleep(0.4)
        check(f'{view} view renders', marker in pg.inner_text('.workspace'))
    pg.goto(f'{W}/admin/#/users'); pg.wait_for_selector('.page-heading'); pg.screenshot(path=f'{OUT}/15-users.png', full_page=True)

    # New page flow
    pg.goto(f'{W}/admin/#/pages'); pg.wait_for_selector('#newPage'); pg.click('#newPage')
    pg.fill('#npTitle', 'UI Created Study'); pg.click('#npGo')
    pg.wait_for_function('window.tinymce && tinymce.activeEditor && tinymce.activeEditor.initialized', timeout=30000)
    check('new page opens in editor', 'ui-created-study' in pg.url or pg.locator('#slugIn').input_value() == 'ui-created-study')

    # Mobile layout
    m = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    mp = m.new_page()
    mp.on('pageerror', lambda e: errors.append(f'mobile pageerror: {e}'))
    mp.goto(f'{W}/admin/'); mp.wait_for_selector('#loginForm')
    mp.fill('#email', 'admin@nikolaseo.com'); mp.fill('#password', 'correct horse battery staple'); mp.click('#loginForm button')
    mp.wait_for_selector('.stat-grid')
    mp.goto(f'{W}/admin/#/redirects'); mp.wait_for_selector('#rrows tr')
    mp.screenshot(path=f'{OUT}/16-mobile-redirects.png')
    mp.click('#mobileMenu'); time.sleep(0.3); mp.screenshot(path=f'{OUT}/17-mobile-menu.png')
    check('mobile sidebar opens', 'open' in mp.get_attribute('#sidebar', 'class'))
    mp.goto(f'{W}/admin/#/pages'); mp.wait_for_selector('#rows a'); mp.click('#rows a >> nth=1')
    mp.wait_for_selector('.tox-edit-area iframe', timeout=30000)
    time.sleep(1); mp.screenshot(path=f'{OUT}/18-mobile-editor.png')
    check('no horizontal overflow on mobile editor', mp.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'))

    real_errors = [e for e in errors if 'favicon' not in e and '401' not in e and 'TUNNEL' not in e]
    check('no 404s for page assets inside the editor', not [e for e in errors if e.startswith('HTTP 404')])
    print('console errors:', json.dumps(real_errors[:15], indent=1))
    check('no JS errors', not [e for e in real_errors if 'pageerror' in e])
    b.close()

failed = [n for n, ok in results if not ok]
print(f'\n{len(results) - len(failed)} passed, {len(failed)} failed', failed)
sys.exit(1 if failed else 0)
