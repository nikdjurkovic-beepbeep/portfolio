NIKOLASEO.COM — GITHUB PAGES DOMAIN MIGRATION

This package contains the complete static website for https://nikolaseo.com/.
GitHub Pages remains the host. The package contains 7 standalone SEO tools.

FILES INCLUDED
- CNAME (nikolaseo.com)
- index.html
- site.css
- favicon.svg
- Nikola_Djurkovic_CV.pdf
- redirect-mapping-validator.html
- robots-txt-generator.html
- seo-regex-tester.html
- hreflang-validator.html
- xml-sitemap-analyzer.html
- schema-markup-generator.html
- serp-preview.html
- sitemap.xml
- robots.txt

GITHUB UPLOAD
1. Extract this ZIP on your computer.
2. Open the repository: https://github.com/nikdjurkovic-beepbeep/portfolio
3. Choose Add file > Upload files.
4. Upload all 14 website files to the repository ROOT (not a subfolder).
5. Allow index.html and other existing files to be replaced when prompted.
6. Commit the changes to the main branch.
7. Do not delete the Google Search Console HTML verification file if you previously uploaded one. It is deliberately not included because the exact Google-generated filename was not provided.

DOMAIN / DNS
- The CNAME file declares nikolaseo.com for GitHub Pages.
- In repository Settings > Pages, set Custom domain to nikolaseo.com.
- At GoDaddy, configure the four GitHub Pages A records for host @:
  185.199.108.153
  185.199.109.153
  185.199.110.153
  185.199.111.153
- Configure www as a CNAME to nikdjurkovic-beepbeep.github.io.
- Keep the GitHub domain-verification TXT record and other unrelated TXT/MX records.
- Enable Enforce HTTPS in GitHub Pages after DNS and certificate provisioning complete.

SEO CONFIGURATION
- Each HTML page has a self-referencing canonical URL on https://nikolaseo.com/.
- sitemap.xml lists the homepage and all seven SEO tool pages.
- robots.txt allows crawling and references https://nikolaseo.com/sitemap.xml.
- No noindex directive is included.

IMPORTANT
The CNAME file is included in this package. The Google Search Console verification HTML file is not; retain your existing copy in the repository root. Upload the ZIP's contents, not the ZIP file itself. Keep all files at the repository root.
