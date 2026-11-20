import json, subprocess, sys
from playwright.sync_api import sync_playwright
regions = json.load(open('/tmp/regions.json'))
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8099', '-d', '/home/claude/portfolio'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
import time; time.sleep(1)
out = {}
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    pg = b.new_page(); errs=[]; pg.on('console', lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.goto('http://localhost:8099/cms/test/roundtrip.html'); pg.wait_for_function('window.ready')
    pg.evaluate('window.ready')
    for path, r in regions.items():
        out[path] = pg.evaluate('h => window.roundtrip(h)', r['body'])
    print('console errors:', errs[:5])
    b.close()
srv.terminate()
json.dump(out, open('/tmp/roundtrip_out.json','w'))
