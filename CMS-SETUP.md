# NikolaSEO Content Studio — user guide

The Content Studio is at **https://nikolaseo.com/admin/**. Sign in with your CMS account; there are no GitHub tokens to paste any more. (First-time deployment steps: [cms/docs/DEPLOY.md](cms/docs/DEPLOY.md).)

## Signing in

Sign in with your email and password, then enter the 6-digit code from your authenticator app (Google Authenticator or similar).

The first time, the CMS walks you through setup:
1. Scan the QR code with the app.
2. Enter the code the app shows.
3. Save the 10 recovery codes. Each one works once if you lose your phone.

**Account** lets you:
- move 2FA to a new phone
- generate new recovery codes
- see how many recovery codes are left

## Pages

- **Pages** lists every page with its status: Published, Draft, Scheduled, Private, Password or Trash. A yellow **Unpublished changes** badge means a saved draft exists for a live page.
- **Edit** opens the editor. Article pages have fields for the eyebrow, headline, standfirst and byline date. The body uses a WordPress-style visual editor that looks like the real site.
- **Save draft** (Ctrl/⌘+S) stores your changes in the CMS only; the live page does not change. Drafts autosave every 30 seconds.
- **Preview** shows the page with your unpublished changes.
- **Publish** / **Update live page** commits the page and an updated `sitemap.xml`. GitHub Pages updates the site in about a minute.
- **Schedule** publishes at a set time. A scheduled update to a live page keeps the current version online until then.
- **Visibility**:
  - *Public*: anyone can see the page.
  - *Private*: only signed-in users can see it.
  - *Password protected*: visitors must enter the page password.

  Private and password pages are served by the CMS and removed from the public repository. Versions that were public before remain in git history.
- **URL**: change the slug. For live pages, tick “Create a 301 redirect” so old links keep working.
- **Revisions**: view, compare and restore any earlier version. A restored version comes back as a draft; nothing goes live until you publish.
- **Duplicate**, **Unpublish**, **Move to trash** (restorable) and **Delete permanently** are in the Pages list and the editor.
- Interactive tool areas on SEO tool pages show as locked “preserved” blocks. Edit the text around them; the tools keep working.
- If someone else saves the page while you have it open, saving tells you instead of overwriting their work. The same happens if the file was changed directly on GitHub.
- Pages committed straight to GitHub (for example by the writer agent) show up in **Pages** on their own within about 5 minutes. Changes to existing pages made on GitHub become the new live version; a page with an unpublished CMS draft keeps the draft, and publishing it is refused until you reload, so neither side is overwritten. **Sync from repository** does the same thing immediately.

## Links

Select text, then click the link button:
- Choose one of your pages, or a section of it, from **Link list**, or type any URL.
- Set **Open link in** (same tab or new tab).
- Set **Rel** (nofollow, sponsored, ugc…).

Click inside a link to edit or remove it.

## SEO tab

- SEO title and meta description, with a Google-style preview and a pixel-width check.
- Canonical URL, index/follow, extra robots directives, sitemap inclusion and breadcrumb schema.
- Open Graph and X/Twitter title, description and image.
- JSON-LD schema with validation and an Article template.
- Redirects that point to this page.

## Media

Upload images and documents (drag and drop, up to 10 MB). JPEG/PNG can be converted to WebP automatically. Each file can have a title, alt text, caption and collection.

**Replace** keeps the same URL, so every page using the file updates. **Delete** warns you if any page still uses the file.

## Redirects

- **Add redirect**:
  - Codes: 301, 302, 303, 307 or 308.
  - Match types: exact, wildcard (`/blog/*` → `/studies/*`) or regex (`^/old/(\d+)$` → `/new/$1`).
  - Query string: pass through, ignore, or must match exactly.
  - Options for case and trailing slash.
  - **Test before saving** shows exactly what the live site will do.
- The list shows hits, last hit and diagnostics: loops, chains, conflicts, duplicates, invalid rules, unknown targets, and rules that hide a live page. You can filter, sort and apply bulk actions.
- **Import CSV**: download the template, upload your file and review the preview. You can fix rows inline or exclude them, then import. Conflicts with existing rules are only overwritten if you type OVERWRITE. A backup is taken first.
- **Export** all redirects or only the current filter. **Backups** lets you restore any automatic backup.
- **Verify live** requests the selected URLs from the live site and compares the status code and Location header.

## Navigation

Edit the header menu:
- reorder items (↑ ↓)
- nest items into dropdowns (→ ←)
- add pages or external links
- choose whether a link opens in a new tab

**Save** first, check the **Preview**, then **Publish to site**, which updates the header on every page in one commit.

## Users

Administrators add users and send them a one-time link to set their password.

| Role | Can do |
|---|---|
| Administrator | Everything |
| Editor | All content; redirects only if granted |
| Author | Own pages |
| Contributor | Drafts of own pages only |
| Subscriber | View private pages |

Individual permissions can be granted or removed per user. A forgotten password is handled with **Users → Reset link**.
