# NikolaSEO CMS (v2)

WordPress-style CMS for nikolaseo.com: a static admin app (`/admin/`) plus a Cloudflare Worker with a D1 database (`cms/worker/`) in front of the GitHub Pages site.

- **Audit and decisions:** [docs/AUDIT.md](docs/AUDIT.md)
- **What works and how it was verified:** [docs/FUNCTIONALITY-MATRIX.md](docs/FUNCTIONALITY-MATRIX.md)
- **Deploy runbook (owner approval required):** [docs/DEPLOY.md](docs/DEPLOY.md)
- **Using the CMS:** [../CMS-SETUP.md](../CMS-SETUP.md)

## Layout

```
admin/                     Static admin app (served by GitHub Pages)
  index.html, admin.css
  js/app.js                shell, auth, routing, pages list, users, settings, activity
  js/editor.js             page editor (TinyMCE) + publish/SEO/page panels
  js/redirects-view.js     redirect manager, CSV import wizard, backups
  js/media.js, menus.js    media library/picker, navigation manager
  js/shared/redirects.js   redirect engine shared by the Worker and the UI
  vendor/tinymce/          TinyMCE 8 (GPL-2.0-or-later, self-hosted)
cms/worker/
  src/index.js             edge router (redirects, private pages, pass-through) + CMS API
  src/html.js              page model: editable regions, SEO head, nav, sitemap, sanitizer
  src/auth.js              PBKDF2 passwords, sessions, roles/capabilities, rate limits
  src/mfa.js               TOTP 2FA, encrypted secrets, recovery codes
  src/github.js            git-data API client (atomic multi-file commits, sha checks)
  migrations/              D1 schema
cms/test/                  unit, API, round-trip and browser tests + mocks
cms/scripts/verify-deploy.mjs   live-site verification
```

## Request flow

```
visitor → Cloudflare → Worker
             ├─ /cms-api/*            → CMS API (D1 + GitHub)
             ├─ redirect rule matches → 301/302/303/307/308 + Location
             ├─ private/password page → served from D1 after auth
             └─ everything else       → GitHub Pages (cookies stripped)
```

## Local development and tests

```bash
cd cms && npm install
./test/restart.sh                       # mock GitHub/Pages/checker + wrangler dev + fresh local D1
node --test test/redirects.test.mjs     # redirect engine
node test/extract.mjs $(cd .. && ls *.html */index.html | grep -v -e admin/ -e google) \
  && python3 test/roundtrip.py && node test/compare.mjs   # editor round-trip on every page
node --test test/mfa.test.mjs           # TOTP (RFC 6238 vectors), encryption, recovery codes
node --test --test-concurrency=1 test/api.test.mjs test/api2.test.mjs
python3 test/ui_smoke.py                # headless Chrome (needs Playwright + Chrome)
node --test test/api3.test.mjs          # 2FA end to end (turns enforcement on; run after the above)
python3 test/ui_2fa.py                  # 2FA in the browser
```

Then open http://localhost:8787/admin/. The API tests create `admin@nikolaseo.com` / `correct horse battery staple`.
