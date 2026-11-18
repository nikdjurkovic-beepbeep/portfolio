# NikolaSEO Content Studio

The content editor is available at **https://nikolaseo.com/admin/** after the site is published from the `main` branch.

## Connect GitHub

The editor is a static page hosted with the site. It uses GitHub to read and publish website files; it does not use a separate CMS server.

1. Create a **fine-grained personal access token** at <https://github.com/settings/personal-access-tokens/new>.
2. Set the resource owner to `nikdjurkovic-beepbeep` and limit the token to the `portfolio` repository.
3. Grant **Contents: Read and write**. Metadata read access is included by GitHub.
4. Open <https://nikolaseo.com/admin/> and paste the token into the connection field. The editor holds it in memory for that browser tab and does not save it in browser storage or website files.

Use a short expiry and never put the token in a public file, commit, or chat. It can be revoked from GitHub's personal access token settings.

## Edit a page

1. Choose **All pages** to find the homepage, SEO Studies article, or any of the SEO tool pages.
2. Click **Edit**. Click text in the preview to change it, or select text and use the formatting toolbar.
3. Update the browser title or search description in **Page details** if needed. The existing canonical URL is shown as read-only.
4. Choose **Publish changes**. The editor makes a GitHub commit on `main`; GitHub Pages then updates the public site.

The page list is read from the repository each time you connect or refresh it. Newly added HTML pages appear automatically and use the same editor.

## Add a page

1. Choose **All pages → New page** and enter a title, URL slug, and search description.
2. Edit the page in the visual editor.
3. Optionally select **Add to the SEO Studies menu**. If selected, the editor updates the menu on every website page. Otherwise the page stays off the menu.
4. Choose **Publish page**. The editor creates the page at `/<slug>/`, adds its canonical URL, and adds the URL to `sitemap.xml` in the same commit.

## Upload media

Use **Media library** to upload PNG, JPG, WEBP, or GIF images up to 5 MB each. Uploaded files go in `assets/uploads/`. From a page editor, use the image button to choose an existing image or upload one and insert it at the current cursor position.

## Deployment

The site is published from the repository root on the `main` branch through GitHub Pages. Adding `admin/` does not require DNS, CNAME, Search Console, or sitemap changes. The editor is excluded from the sitemap and marked `noindex`.

Keep `CNAME` and `googlec6d6026729dc585e.html` at the repository root. The editor excludes the Search Console verification file from its page list and does not modify it.
