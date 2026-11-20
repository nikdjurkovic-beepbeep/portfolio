# NikolaSEO.com CMS audit

Audit date: 2026-11-20. Repository: `nikdjurkovic-beepbeep/portfolio` @ `66917cb` on `main`.

## Architecture as found

| Area | What is actually there |
|---|---|
| Hosting | GitHub Pages, "deploy from branch" (`main`, repository root). No GitHub Actions workflow. Jekyll runs on the files (no `.nojekyll`). |
| DNS / CDN | `nikolaseo.com` (CNAME file). DNS is on Cloudflare (confirmed by owner). |
| Repository visibility | **Public.** Everything committed is publicly readable, including history. |
| Frontend | 14 hand-written static HTML pages: homepage, 9 SEO tool pages (`*.html`), 4 SEO Studies articles (`/<slug>/index.html`). Shared `site.css` and `nav.js`. Articles carry their own inline `<style>`. Navigation is duplicated in every file. |
| Backend | None for the site. Two separate Cloudflare Workers on `*.nik-djurkovic.workers.dev` power the HTTP status and AI crawler tools. |
| Database | None. Content storage is the HTML files in the repository. |
| CMS | `/admin/` — one static page (`admin.js`, 1,039 lines). The user pastes a GitHub fine-grained token; the page reads/writes files through the GitHub API and commits directly to `main`. |
| Authentication | GitHub token only. No CMS accounts, no roles. Anyone with a write token is a full administrator. |
| Media | Images committed to `assets/uploads/` through the GitHub API (PNG/JPG/WEBP/GIF, 5 MB). No metadata. |
| SEO | Per page: `<title>`, meta description, canonical, OG/Twitter on articles, Article JSON-LD on 3 articles; static `robots.txt`; hand-maintained `sitemap.xml`. |
| Redirects | **None.** GitHub Pages cannot return 3xx responses (meta refresh / JS only). |

## Functionality audit

### 1. Implemented and working
- Static site delivery on GitHub Pages; custom domain; Search Console verification file.
- CMS: GitHub-token login; lists all HTML pages from the repository.
- CMS: in-place visual editing of the article body / main content, with bold/italic/underline, P/H2/H3, blockquote, lists, undo/redo.
- CMS: internal link picker (page + section anchor), external links (http/https/mailto), unlink.
- CMS: edit `<title>` and meta description.
- CMS: new page from the article template, sitemap entry added, optional SEO Studies menu entry added across all pages in one commit.
- CMS: image upload to repository and insertion into the page.
- Article table of contents rebuilt from H2s on save.

### 2. Partially implemented or unreliable
- **Editor** uses `document.execCommand` (deprecated) on a `contenteditable` iframe. No H1/H4–H6, strikethrough, code blocks, tables, HR, captions, alt editing, image resizing/alignment, embeds or HTML view.
- **Links**: no target/new-tab, no `rel` (nofollow/sponsored/ugc), no way to edit an existing link's attributes other than re-linking.
- **Media**: upload only; no alt/title/caption metadata, folders, replace, delete, dimensions, SVG/AVIF upload, optimisation, or broken-reference checks. Inserted images get the filename as alt text.
- **SEO**: only title + description editable. Canonical read-only; no robots, OG, Twitter, schema, breadcrumbs or sitemap controls.
- **Publishing**: every save is an immediate commit to `main` (= live). No drafts, preview of unpublished changes, or scheduling.
- **Conflict detection**: only GitHub's "ref changed" error at commit time; edits made elsewhere in the same file can be overwritten because the editor writes back the whole document it loaded.
- **Navigation**: can append an item to "SEO Studies" for new pages only; no edit/reorder/delete.
- **Security**: a write token pasted into a web page is the only control. CSP is set; token is kept in memory only.

### 3. Missing
- CMS user accounts, roles, server-side permission checks, sessions, password reset.
- Drafts, autosave, revision history, restore.
- Private and password-protected pages (impossible on GitHub Pages + public repo without an extra layer).
- Scheduling.
- Delete / duplicate / unpublish pages, slug changes, parent/child hierarchy.
- Redirect management of any kind (and server-side redirects themselves).
- Navigation manager, categories/tags, breadcrumbs.
- Backups/export, activity/error log.

### 4. Not applicable to NikolaSEO.com
- Comments, WooCommerce/e-commerce, plugin marketplace, multisite, complex blog archives/feeds (no current requirement).

## Hosting limitations that drive the design

1. **GitHub Pages cannot send 301/302/303/307/308 responses**, set headers, or run code. Redirect parity is impossible on Pages alone.
2. **Public repository**: drafts, private pages or password-protected content committed to the repo are public (and stay in git history forever).
3. **No server-side auth** on Pages, so private/password pages and RBAC need another layer.

## Decision

Add a **Cloudflare Worker on the `nikolaseo.com/*` route with a D1 (SQLite) database** in front of the existing GitHub Pages origin. Owner already uses Cloudflare (DNS + two Workers).

- Public pages stay as static files on GitHub Pages (no change to how the site is served or to URLs).
- The Worker answers redirects with real status codes before the request reaches Pages, serves private and password-protected pages from D1, and hosts the CMS API.
- Drafts, revisions, schedules, users, redirects, menus and media metadata live in D1, never in the public repo.
- Publishing commits to GitHub with a server-held fine-grained token (Worker secret); editors no longer paste tokens.
- Editor: **TinyMCE 8 (self-hosted, GPL)** — the engine behind WordPress's classic editor. Verified that all 14 existing pages round-trip through it without markup changes (interactive tool UIs and scripts are kept out of the editor as preserved blocks).

## Roadmap (priority order)

1. Worker + D1 foundation; auth, sessions, roles, server-side permissions.
2. Page management: list, edit (TinyMCE), drafts, autosave, preview, publish/unpublish, duplicate, delete (trash), slugs, hierarchy, conflict detection, scheduling, private and password visibility.
3. SEO panel (title, description, canonical, robots, OG, Twitter, JSON-LD, breadcrumbs, sitemap) and generated sitemap.
4. Redirect manager: CRUD, 301/302/303/307/308, exact/wildcard/regex, query handling, hits, diagnostics, tester, CSV import/export, backups, live verification.
5. Media library with metadata, folders, replace, delete with reference check, optimisation.
6. Navigation manager, categories/tags, breadcrumbs.
7. Revisions UI, users UI, backups/export, activity log.
