# CMS functionality matrix

Updated 2026-11-22 · branch `cms-v2` · **deployed: no** (nothing below is live yet).

Status key:
- **Tested** = tested and verified locally: real Worker runtime (`wrangler dev` / workerd) with a local D1 database, a mock GitHub API, and a mock GitHub Pages origin that serves whatever was committed, plus headless Chrome for the UI.
- **Implemented** = code done, not separately tested.
- **Blocked** = needs something outside the code.
- After deploy, run `cms/scripts/verify-deploy.mjs` against the live site to turn "Tested" into "Deployed + verified".

Test suites:
- `test/redirects.test.mjs`: 16
- `test/mfa.test.mjs`: 6 (RFC 6238 vectors)
- `test/compare.mjs`: editor round-trip on 15 pages
- `test/api.test.mjs`: 13
- `test/api2.test.mjs`: 14
- `test/api3.test.mjs`: 9 (2FA)
- `test/ui_smoke.py`: 36 browser checks
- `test/ui_2fa.py`: 16 browser checks
- `scripts/verify-deploy.mjs`: 2,024 HTTP checks locally

## Priority 1 — Core CMS

| Feature | Status | Evidence / notes |
|---|---|---|
| Accounts, login, logout, logout everywhere | Tested | api #1–2, ui |
| Sessions: HttpOnly, SameSite=Strict, `__Host-` cookie, 12 h sliding | Tested | api #2 |
| CSRF protection (token header + Origin check) | Tested | api #2 |
| Login rate limit (failures only, per IP and per account) | Tested | api #13 |
| Password change, admin-issued reset link (single use, revokes sessions) | Tested | api #12 |
| Two-factor login: email + password + 6-digit authenticator code (Google Authenticator / any TOTP app) | Tested | mfa unit (RFC 6238 vectors), api3 #4, ui_2fa |
| 2FA setup with QR code + manual key; QR decodes to a valid `otpauth://` URI | Tested | ui_2fa, QR decoded from screenshot |
| 10 one-time recovery codes (hashed), copy/download/print, regenerate | Tested | api3 #5–6, ui_2fa |
| Replay protection, 5 tries per sign-in challenge, shared account lock | Tested | api3 #4, #7 |
| 2FA policy (none / admins / staff / all) enforced server-side | Tested | api3 #1, #8 |
| Move to a new phone (password + current code) | Tested | api3 #6 |
| Admin "Reset 2FA" for a lost device; can't reset own | Tested | api3 #8 |
| Secrets encrypted at rest (AES-GCM, `MFA_KEY`), never in API responses or backups | Tested | mfa unit, api3 #3 |
| Password reset does not bypass 2FA | Tested | api3 #9 |
| Self-service email password reset | Blocked | needs an email provider |
| Roles: administrator, editor, author, contributor, subscriber | Tested | api #12 |
| Per-user grant/revoke capabilities | Tested | api #12 (editor granted `redirects.manage`) |
| Server-side permission enforcement | Tested | api #12 (403s on API, not just hidden buttons) |
| Page list with states, hierarchy, search, filters | Tested | ui |
| Create page (article / basic layout, optional parent) | Tested | api #8, ui |
| Edit page (TinyMCE) without changing other markup | Tested | round-trip on all 15 pages: 0 diffs (hand-written TOC labels kept) |
| Interactive tool UIs and scripts preserved as locked blocks | Tested | api #11 |
| Save draft (never touches the live site) | Tested | api #4 |
| Autosave (30 s) | Implemented | same endpoint as drafts |
| Preview of unpublished draft (auth only, noindex) | Tested | api #4 |
| Publish / update (commit + sitemap) | Tested | api #6, ui |
| Unpublish | Tested | api #8 (trash path) |
| Schedule / cancel schedule (cron every 5 min) | Tested | api #8 (cron fired) |
| Private pages (edge-enforced, removed from repo) | Tested | api #9 |
| Password-protected pages (HMAC cookie, rotates with password) | Tested | api #9 |
| Duplicate | Tested | api #8 |
| Delete: trash, restore, permanent delete | Tested | api #8 |
| Slug / URL change (moves folder + assets, optional 301) | Tested | api #8 |
| Parent/child pages and hierarchy | Implemented | parent saved with draft; feeds breadcrumbs |
| Conflict detection: version check + GitHub sha check | Tested | api #5 |
| Edit locks with takeover | Implemented | heartbeat every 60 s |
| Status and last-modified display | Tested | ui |

## Rich text editor (TinyMCE 8, self-hosted, GPL)

| Feature | Status | Notes |
|---|---|---|
| H1–H6, paragraph, bold, italic, strikethrough, lists, blockquote, code block, HR, tables, undo/redo | Implemented | standard TinyMCE plugins |
| Insert/edit/remove link; internal page and section picker; external links; target; rel (nofollow/sponsored/ugc) | Tested | ui (dialog fields), api #6 (rel/target published) |
| Anchors | Implemented | anchor plugin; section list in the link picker |
| Images from the media library (alt, caption, size, alignment) | Implemented | picker plus the image dialog |
| Embeds (YouTube/Vimeo etc.) | Implemented | iframes from allow-listed hosts kept for users without `unfiltered_html` |
| HTML source view | Implemented | code plugin; server sanitizes for lower roles |
| Paste keeps formatting | Implemented | TinyMCE paste |
| Editor canvas uses the site's CSS | Tested | ui |
| XSS sanitization for non-trusted roles | Tested | api #12 |

## Priority 2 — SEO and site management

| Feature | Status | Notes |
|---|---|---|
| SEO title, meta description (with pixel-width counters and SERP preview) | Tested | ui, api #6 |
| Canonical (exactly one in output) | Tested | api #6 |
| Robots index/follow and extra directives (one meta, omitted when index,follow) | Tested | api #7 |
| Open Graph title/description/image/alt/type | Tested | api #7 |
| X/Twitter card, title, description, image | Tested | api #7 |
| JSON-LD schema (validated) and Article template | Tested | api #7, ui |
| Breadcrumb schema from page hierarchy | Tested | api #7 |
| Sitemap inclusion; auto-excludes noindex and canonicalised pages | Tested | api #6–7 |
| Sitemap regeneration and preview | Implemented | Pages → Sitemap |
| Categories and tags (as `article:section` / `article:tag`) | Tested | api2 #12 |
| Navigation: create, edit, delete, reorder, nest, labels, internal/external, new tab | Tested | api2 #11, ui |
| Navigation preview on any page | Tested | api2 #11 |
| Navigation publish to all pages (correct relative links, aria-current) | Tested | api2 #11 (unchanged menu = identical markup) |
| Media: upload with type and content sniffing, SVG safety, 10 MB limit | Tested | api2 #10 |
| Media: browse, search, filter, collections | Tested | ui |
| Media: alt/title/caption editing; dimensions | Tested | api2 #10, ui |
| Media: replace in place (same URL); refuses type change | Tested | api2 #10 |
| Media: delete blocked when used (live pages, drafts, private pages, SEO images) | Tested | api2 #10 |
| Media: optimisation (JPEG/PNG → WebP, max width) | Implemented | runs in the browser at upload |
| AVIF, WebP, PDF, DOCX/XLSX/PPTX, CSV, TXT | Implemented | sniffed per type |

## Redirects (Redirection-plugin parity)

| Acceptance criterion | Status | Evidence |
|---|---|---|
| 1. Create through the CMS | Tested | api2 #2, ui |
| 2. Edit, disable, delete | Tested | api2 #3 |
| 3. Import thousands via CSV | Tested | 2,000-row import: preview ~0.2 s, commit ~0.2 s (local) |
| 4. Review validation errors before importing; fix inline; exclude rows | Tested | api2 #5, ui |
| 5. Export to CSV (all / filtered / template); re-import keeps every setting | Tested | api2 #6 |
| 6. Detect loops and conflicting rules | Tested | unit, api2 #4 |
| 7. Identify chains | Tested | unit, api2 #4 |
| 8. Test before deploy (tester + unsaved-rule test) | Tested | api2 #4, ui |
| 9. Verify on the live website | Tested locally | Verify live (via the HTTP checker Worker) + `verify-deploy.mjs` |
| 10. Correct status codes and Location headers | Tested locally | all of 301/302/303/307/308; 2,003 redirects checked over HTTP |
| Exact / wildcard / regex | Tested | unit, api2 #2 |
| Query: pass / ignore / exact (any order) | Tested | unit, api2 #2 |
| Case and trailing-slash options; position ordering | Tested | unit |
| Cross-domain and absolute targets | Tested | api2 #2 |
| Hit counts and last hit | Tested | api2 #3 |
| Search, filter, sort, paginate, bulk (activate/deactivate/delete/type/reset hits) | Tested | api2 #7, ui |
| Self-redirect, duplicate, invalid URL/type, reserved paths, shadowing a live page | Tested | unit, api2 #4 |
| Automatic backup before bulk changes and imports; restore; CSV per backup | Tested | api2 #5–6 |
| No silent overwrite (typed OVERWRITE confirmation) | Tested | api2 #5 |
| Survives deployments | By design | rules live in D1, independent of GitHub Pages deploys |

## Priority 3 — Advanced

| Feature | Status | Notes |
|---|---|---|
| Revision history, preview, word diff, restore as draft | Tested | api #10, ui |
| JSON backup / partial restore | Tested | api2 #13 (no password hashes in export) |
| D1 Time Travel point-in-time recovery | Implemented | Cloudflare feature, documented |
| Activity / error log | Tested | api2 #13 |
| Error responses with reference id, no sensitive data | Implemented | |
| Security headers on admin (CSP, XFO DENY, nosniff, noindex) | Tested | verify-deploy |
| CMS cookies never forwarded to GitHub Pages | Tested | api #3 |
| Site fails open if the CMS layer errors | Implemented | edge catches errors and passes the request through to the origin |

## Not applicable

Comments, e-commerce, plugin marketplace, multisite, feeds/archives: no current requirement.

## Known limitations

- Media is stored in the public repository, so files used on private pages are publicly reachable by URL.
- Pages that were public stay in public git history after being made private.
- Parent/child changes don't move URLs (URLs only change through the slug control).
- The site header supports one dropdown level (same as the current design).
- Private pages are visible to every signed-in account with `private.read` (all roles by default); there are no per-page access lists yet.
