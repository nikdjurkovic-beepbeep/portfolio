// HTML page model for NikolaSEO.com.
// The site is hand-written static HTML with no build step. Every public page is a
// complete HTML file in the repository. The CMS edits named regions of those files
// and rewrites managed <head> tags, navigation and the sitemap, leaving everything
// else byte-for-byte where possible.
import { parseHTML } from 'linkedom';

export const SITE = 'https://nikolaseo.com';

const PROTECT_SELECTOR = [
  'script', 'noscript', 'style', 'iframe', 'canvas', 'form', 'template', 'object', 'embed',
  '.tool-shell', '[data-cms-protect]'
].join(',');
const CONTROL_SELECTOR = 'input,textarea,select,button,output,meter,progress';

export function parse(html) {
  const { document } = parseHTML(html);
  return document;
}

export function serialize(doc) {
  const html = doc.documentElement.outerHTML;
  return `<!doctype html>\n${html}\n`;
}

/** Repository path -> public URL path ("seo-myths/index.html" -> "/seo-myths/"). */
export function urlForPath(path) {
  if (path === 'index.html') return '/';
  if (/\/index\.html$/i.test(path)) return `/${path.replace(/index\.html$/i, '')}`;
  return `/${path}`;
}

/** Public URL path -> repository path. */
export function pathForUrl(url) {
  let clean = url.split('#')[0].split('?')[0];
  if (!clean.startsWith('/')) clean = `/${clean}`;
  if (clean === '/') return 'index.html';
  if (clean.endsWith('/')) return `${clean.slice(1)}index.html`;
  return clean.slice(1);
}

export function depthPrefix(path) {
  const depth = path.split('/').length - 1;
  return '../'.repeat(depth);
}

export function detectTemplate(doc, path) {
  if (path === 'index.html') return 'home';
  if (doc.querySelector('article.article')) return 'article';
  if (doc.querySelector('.tool-shell') || doc.querySelector(`main ${CONTROL_SELECTOR}`)) return 'tool';
  return 'basic';
}

export function editableRoot(doc, template) {
  if (template === 'article') return doc.querySelector('article.article');
  return doc.querySelector('main > .wrap') || doc.querySelector('main') || doc.body;
}

/**
 * Returns the outermost elements that must not pass through the rich-text editor:
 * scripts, interactive tool UIs and anything holding form controls.
 */
function protectedBlocks(root) {
  const found = new Set();
  root.querySelectorAll(PROTECT_SELECTOR).forEach(el => found.add(el));
  root.querySelectorAll(CONTROL_SELECTOR).forEach(control => {
    // Protect the smallest block that is a direct child of a section/region and contains the control.
    let el = control;
    while (el.parentElement && el.parentElement !== root && !/^(SECTION|ARTICLE)$/.test(el.parentElement.tagName)) el = el.parentElement;
    found.add(el);
  });
  // Keep only outermost.
  return [...found].filter(el => ![...found].some(other => other !== el && other.contains(el)));
}

function hashString(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

function placeholderLabel(el) {
  if (el.matches('script')) return 'Script (preserved)';
  if (el.matches('style')) return 'Style block (preserved)';
  if (el.matches('.tool-shell')) return `Interactive tool: ${(el.querySelector('h3,h2')?.textContent || 'tool UI').trim()} (preserved)`;
  return 'Interactive block (preserved)';
}

/** Extract the editable regions of a page. Protected blocks become non-editable placeholders. */
export function extractEditable(html, path) {
  const doc = parse(html);
  const template = detectTemplate(doc, path);
  const root = editableRoot(doc, template);
  if (!root) throw new Error('This page has no editable content area.');
  const blocks = protectedBlocks(root);
  blocks.forEach((el, index) => {
    const holder = doc.createElement('div');
    holder.innerHTML = `<div class="mceNonEditable cms-protected" data-cms-block="${index}:${hashString(el.outerHTML)}" contenteditable="false">⚙ ${escapeText(placeholderLabel(el))}</div>`;
    el.replaceWith(holder.firstChild);
  });
  const hero = {};
  if (template === 'article') {
    const heroEl = doc.querySelector('section.hero');
    hero.eyebrow = heroEl?.querySelector('.eyebrow')?.textContent.trim() || '';
    hero.headline = heroEl?.querySelector('h1')?.textContent.trim() || '';
    hero.lead = heroEl?.querySelector('.lead')?.textContent.trim() || '';
    hero.date = heroEl?.querySelector('.meta time')?.getAttribute('datetime') || '';
  }
  return { template, body: root.innerHTML, hero, protectedCount: blocks.length };
}

/**
 * Put edited regions back into the current page HTML.
 * `currentHtml` is the latest version of the file so protected blocks are taken from it.
 */
export function composeEditable(currentHtml, path, { body, hero }, { allowRemoveProtected = false } = {}) {
  const doc = parse(currentHtml);
  const template = detectTemplate(doc, path);
  const root = editableRoot(doc, template);
  if (!root) throw new Error('This page has no editable content area.');
  const originals = protectedBlocks(root).map(el => el.outerHTML);
  if (typeof body === 'string') {
    root.innerHTML = body;
    const seen = new Set();
    root.querySelectorAll('[data-cms-block]').forEach(ph => {
      const [index, hash] = String(ph.getAttribute('data-cms-block')).split(':');
      const original = originals[Number(index)];
      if (original === undefined || hashString(original) !== hash) {
        throw Object.assign(new Error('A preserved block changed on the server since this page was opened. Reload the page and apply your edits again.'), { status: 409 });
      }
      seen.add(Number(index));
      const holder = doc.createElement('div');
      holder.innerHTML = original;
      ph.replaceWith(...holder.childNodes);
    });
    if (seen.size !== originals.length && !allowRemoveProtected) {
      throw Object.assign(new Error(`${originals.length - seen.size} interactive/script block(s) were removed in the editor. Confirm removal to continue.`), { status: 422, code: 'protected_removed' });
    }
    // Strip editor artefacts.
    root.querySelectorAll('[data-mce-style],[data-mce-src],[data-mce-href],[data-mce-selected],[data-mce-bogus]').forEach(el => {
      ['data-mce-style', 'data-mce-src', 'data-mce-href', 'data-mce-selected'].forEach(a => el.removeAttribute(a));
      if (el.getAttribute('data-mce-bogus')) el.remove();
    });
    root.querySelectorAll('.mceNonEditable').forEach(el => el.classList.remove('mceNonEditable'));
  }
  if (template === 'article' && typeof body === 'string') updateToc(doc, root);
  if (template === 'article' && hero) {
    const heroEl = doc.querySelector('section.hero');
    if (heroEl) {
      const set = (sel, value) => { const el = heroEl.querySelector(sel); if (el && typeof value === 'string') el.textContent = value; };
      set('.eyebrow', hero.eyebrow);
      set('h1', hero.headline);
      set('.lead', hero.lead);
      const time = heroEl.querySelector('.meta time');
      if (time && hero.date && /^\d{4}-\d{2}-\d{2}$/.test(hero.date)) {
        time.setAttribute('datetime', hero.date);
        time.textContent = new Date(`${hero.date}T12:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
      }
    }
  }
  return serialize(doc);
}

export function slugify(value) {
  return String(value).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
}

/** Rebuild article table(s) of contents from H2 headings, assigning stable ids. */
export function updateToc(doc, article) {
  const navs = [...doc.querySelectorAll('.toc nav, .mobile-toc nav')];
  const used = new Set();
  const records = [...article.querySelectorAll('h2')].map(h => {
    let id = h.getAttribute('id') || slugify(h.textContent);
    const base = id; let n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    h.setAttribute('id', id);
    return { id, label: h.textContent.trim().replace(/\s+/g, ' ') };
  });
  navs.forEach(nav => {
    nav.innerHTML = records.map(r => `<a href="#${escapeAttr(r.id)}">${escapeText(r.label)}</a>`).join('');
  });
}

export function escapeText(v = '') { return String(v).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]); }
export function escapeAttr(v = '') { return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

/* ------------------------------------------------------------------ SEO ---- */

export function readSeo(html, path) {
  const doc = parse(html);
  const meta = (sel, attr = 'content') => doc.querySelector(sel)?.getAttribute(attr) || '';
  const robots = meta('meta[name="robots"]').toLowerCase();
  const jsonld = [...doc.querySelectorAll('script[type="application/ld+json"]')].filter(s => !s.hasAttribute('data-cms-breadcrumbs')).map(s => s.textContent.trim());
  return {
    title: doc.querySelector('title')?.textContent.trim() || '',
    description: meta('meta[name="description"]'),
    canonical: meta('link[rel="canonical"]', 'href') || `${SITE}${urlForPath(path)}`,
    index: !/noindex/.test(robots),
    follow: !/nofollow/.test(robots),
    robotsExtra: robots.split(',').map(s => s.trim()).filter(s => s && !/^(no)?(index|follow)$/.test(s)).join(', '),
    ogTitle: meta('meta[property="og:title"]'),
    ogDescription: meta('meta[property="og:description"]'),
    ogImage: meta('meta[property="og:image"]'),
    ogImageAlt: meta('meta[property="og:image:alt"]'),
    ogType: meta('meta[property="og:type"]'),
    twitterCard: meta('meta[name="twitter:card"]'),
    twitterTitle: meta('meta[name="twitter:title"]'),
    twitterDescription: meta('meta[name="twitter:description"]'),
    twitterImage: meta('meta[name="twitter:image"]'),
    schema: jsonld.join('\n'),
    breadcrumbs: Boolean(doc.querySelector('script[data-cms-breadcrumbs]')),
    sitemap: true
  };
}

/** Append markup to <head> keeping attribute order readable (name before content). */
export function appendHead(doc, markup) {
  const holder = doc.createElement('template');
  holder.innerHTML = markup;
  const nodes = [...(holder.content ? holder.content.childNodes : holder.childNodes)];
  nodes.forEach(n => doc.head.appendChild(n));
}

function upsertMeta(doc, key, attr, value) {
  const all = [...doc.head.querySelectorAll(`meta[${attr}="${key}"]`)];
  all.slice(1).forEach(el => el.remove()); // never leave duplicates
  if (!value) { all[0]?.remove(); return; }
  if (all[0]) { all[0].setAttribute('content', value); return; }
  appendHead(doc, `<meta ${attr}="${escapeAttr(key)}" content="${escapeAttr(value)}">`);
}

/**
 * Apply page-level SEO settings to the document head.
 * Guarantees: exactly one <title>, one description, one canonical, at most one robots meta.
 */
export function applySeo(html, path, seo, ctx = {}) {
  const doc = parse(html);
  const head = doc.head;
  if (seo.title !== undefined) {
    const titles = [...head.querySelectorAll('title')];
    titles.slice(1).forEach(t => t.remove());
    let t = titles[0];
    if (!t) appendHead(doc, `<title>${escapeText(seo.title)}</title>`);
    else t.textContent = seo.title;
  }
  if (seo.description !== undefined) upsertMeta(doc, 'description', 'name', seo.description);

  const canonicals = [...head.querySelectorAll('link[rel="canonical"]')];
  canonicals.slice(1).forEach(el => el.remove());
  const canonical = seo.canonical || `${SITE}${urlForPath(path)}`;
  let link = canonicals[0];
  if (!link) appendHead(doc, `<link rel="canonical" href="${escapeAttr(canonical)}">`);
  else link.setAttribute('href', canonical);

  const robots = [seo.index === false ? 'noindex' : null, seo.follow === false ? 'nofollow' : null, ...(seo.robotsExtra || '').split(',').map(s => s.trim()).filter(Boolean)].filter(Boolean);
  upsertMeta(doc, 'robots', 'name', robots.join(', ')); // removed entirely when index,follow with no extras

  const ogUrl = canonical;
  const hasOg = seo.ogTitle || seo.ogDescription || seo.ogImage || head.querySelector('meta[property^="og:"]');
  if (hasOg) {
    upsertMeta(doc, 'og:title', 'property', seo.ogTitle || seo.title);
    upsertMeta(doc, 'og:description', 'property', seo.ogDescription || seo.description);
    upsertMeta(doc, 'og:url', 'property', ogUrl);
    upsertMeta(doc, 'og:site_name', 'property', 'NikolaSEO');
    if (seo.ogType !== undefined) upsertMeta(doc, 'og:type', 'property', seo.ogType || 'website');
    if (seo.ogImage !== undefined) {
      const changed = (head.querySelector('meta[property="og:image"]')?.getAttribute('content') || '') !== seo.ogImage;
      upsertMeta(doc, 'og:image', 'property', seo.ogImage);
      if (changed || !seo.ogImage) { upsertMeta(doc, 'og:image:width', 'property', ''); upsertMeta(doc, 'og:image:height', 'property', ''); }
    }
    if (seo.ogImageAlt !== undefined) upsertMeta(doc, 'og:image:alt', 'property', seo.ogImageAlt);
  }
  if (seo.twitterCard !== undefined) upsertMeta(doc, 'twitter:card', 'name', seo.twitterCard);
  if (seo.twitterTitle !== undefined) upsertMeta(doc, 'twitter:title', 'name', seo.twitterTitle);
  if (seo.twitterDescription !== undefined) upsertMeta(doc, 'twitter:description', 'name', seo.twitterDescription);
  if (seo.twitterImage !== undefined) upsertMeta(doc, 'twitter:image', 'name', seo.twitterImage);

  if (seo.schema !== undefined) {
    head.querySelectorAll('script[type="application/ld+json"]:not([data-cms-breadcrumbs])').forEach(s => s.remove());
    for (const block of splitJsonLd(seo.schema)) appendHead(doc, `<script type="application/ld+json">${block.replace(/<\//g, '<\\/')}</script>`);
  }
  head.querySelectorAll('script[data-cms-breadcrumbs]').forEach(s => s.remove());
  if (seo.breadcrumbs && ctx.trail?.length) {
    appendHead(doc, `<script type="application/ld+json" data-cms-breadcrumbs>${JSON.stringify({
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: ctx.trail.map((item, i) => ({ '@type': 'ListItem', position: i + 1, name: item.name, item: `${SITE}${item.url}` }))
    }).replace(/</g, '\\u003c')}</script>`);
  }
  return serialize(doc);
}

/** Validate JSON-LD text. Accepts one JSON value, or several separated by blank lines. */
export function splitJsonLd(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  const chunks = [];
  try { JSON.parse(trimmed); return [trimmed]; } catch { /* try blocks */ }
  for (const part of trimmed.split(/\n\s*\n/)) {
    const p = part.trim();
    if (!p) continue;
    try { JSON.parse(p); } catch (e) { throw Object.assign(new Error(`Schema markup is not valid JSON: ${e.message}`), { status: 422 }); }
    chunks.push(p);
  }
  return chunks;
}

export function validateSeo(seo) {
  const problems = [];
  if (seo.canonical) {
    try { const u = new URL(seo.canonical); if (!/^https?:$/.test(u.protocol)) problems.push('Canonical URL must be http(s).'); } catch { problems.push('Canonical URL is not a valid absolute URL.'); }
  }
  for (const key of ['ogImage', 'twitterImage']) {
    if (seo[key]) { try { new URL(seo[key], SITE); } catch { problems.push(`${key} is not a valid URL.`); } }
  }
  if (seo.schema) splitJsonLd(seo.schema);
  if (seo.twitterCard && !['summary', 'summary_large_image', 'app', 'player'].includes(seo.twitterCard)) problems.push('Twitter card type is not valid.');
  if (seo.index === false && seo.sitemap) problems.push('A noindex page cannot be in the sitemap. Sitemap inclusion was turned off.');
  return problems;
}

/* ----------------------------------------------------------- Navigation ---- */

/**
 * Menu items: [{ label, url, external, newTab, children: [...] }]. Top-level items with
 * children render as the site's <details class="nav-dropdown"> component.
 */
export function readMenuFromHtml(html) {
  const doc = parse(html);
  const nav = doc.querySelector('header nav[aria-label="Main navigation"]');
  if (!nav) return [];
  const toUrl = href => {
    if (/^(https?:|mailto:)/i.test(href)) return href;
    const u = new URL(href, `${SITE}/`);
    let p = u.pathname;
    if (p === '/index.html') p = '/';
    return p + u.hash;
  };
  const items = [];
  for (const node of nav.children) {
    if (node.tagName === 'A') items.push({ label: node.textContent.trim(), url: toUrl(node.getAttribute('href')), newTab: node.getAttribute('target') === '_blank', children: [] });
    if (node.tagName === 'DETAILS') {
      items.push({
        label: node.querySelector('summary')?.textContent.trim() || 'Menu', url: '', newTab: false,
        children: [...node.querySelectorAll('.dropdown-panel > a')].map(a => ({ label: a.textContent.trim(), url: toUrl(a.getAttribute('href')), newTab: a.getAttribute('target') === '_blank', children: [] }))
      });
    }
  }
  return items;
}

function relHref(url, path) {
  if (/^(https?:|mailto:|tel:)/i.test(url)) return url;
  const prefix = depthPrefix(path);
  const [p, hash = ''] = url.split('#');
  let target = p.replace(/^\//, '');
  if (target === '' && hash) target = 'index.html'; // site convention: index.html#section
  const out = `${prefix}${target}${hash ? `#${hash}` : ''}`;
  return out || './';
}

export function renderNav(items, path) {
  const current = urlForPath(path);
  const link = item => {
    const href = relHref(item.url, path);
    const isCurrent = !/^[a-z]+:/i.test(item.url) && item.url.split('#')[0] === current && !item.url.includes('#');
    const attrs = [`href="${escapeAttr(href)}"`];
    if (isCurrent) attrs.push('aria-current="page"');
    if (item.newTab) attrs.push('target="_blank" rel="noopener"');
    return `<a ${attrs.join(' ')}>${escapeText(item.label)}</a>`;
  };
  const parts = items.map(item => {
    if (item.children?.length) {
      const active = item.children.some(c => !/^[a-z]+:/i.test(c.url) && c.url.split('#')[0] === current && !c.url.includes('#'));
      return `<details class="nav-dropdown" name="main-nav"><summary${active ? ' class="active"' : ''}>${escapeText(item.label)}</summary><div class="dropdown-panel">${item.children.map(link).join('')}</div></details>`;
    }
    return link(item);
  });
  return parts.join('');
}

export function applyNav(html, path, items) {
  const doc = parse(html);
  const nav = doc.querySelector('header nav[aria-label="Main navigation"]');
  if (!nav) return html;
  nav.innerHTML = renderNav(items, path);
  return serialize(doc);
}

/* -------------------------------------------------------------- Sitemap ---- */

export function renderSitemap(entries) {
  const rows = entries.map(e => `  <url><loc>${escapeText(e.loc)}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ''}</url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows}\n</urlset>\n`;
}

/* ----------------------------------------------------------- Sanitizing ---- */

const DROP_TAGS = new Set(['SCRIPT', 'OBJECT', 'EMBED', 'APPLET', 'BASE', 'META', 'LINK', 'FRAME', 'FRAMESET', 'STYLE']);
const EMBED_HOSTS = /^https:\/\/(www\.)?(youtube\.com|youtube-nocookie\.com|player\.vimeo\.com|open\.spotify\.com|codepen\.io|www\.google\.com\/maps|docs\.google\.com|datawrapper\.dwcdn\.net|flo\.uri\.sh)\//i;

/**
 * Sanitize editor HTML for users without the unfiltered_html capability.
 * Protected placeholders are kept; the server re-inserts their original markup.
 */
export function sanitizeFragment(html) {
  const doc = parse(`<!doctype html><html><body><div id="x">${html}</div></body></html>`);
  const root = doc.getElementById('x');
  const walk = el => {
    for (const child of [...el.children]) {
      if (DROP_TAGS.has(child.tagName)) { child.remove(); continue; }
      if (child.tagName === 'IFRAME' && !EMBED_HOSTS.test(child.getAttribute('src') || '')) { child.remove(); continue; }
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim().toLowerCase().replace(/[\s\u0000-\u001f]/g, '');
        if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction') child.removeAttribute(attr.name);
        else if (['href', 'src', 'xlink:href', 'action', 'poster', 'data'].includes(name) && /^(javascript|vbscript|data:text\/html)/.test(value)) child.removeAttribute(attr.name);
        else if (name === 'style' && /expression\(|url\(\s*['"]?javascript/i.test(attr.value)) child.removeAttribute(attr.name);
      }
      walk(child);
    }
  };
  walk(root);
  return root.innerHTML;
}

/** New page HTML built from the site's article template with empty content. */
export function newArticleHtml(templateHtml, { slug, title, description, parentPath }) {
  const doc = parse(templateHtml);
  const path = `${parentPath ? parentPath.replace(/index\.html$/, '') : ''}${slug}/index.html`;
  doc.querySelector('title').textContent = `${title} | NikolaSEO`;
  const head = doc.head;
  head.querySelectorAll('script[type="application/ld+json"], meta[property^="og:"], meta[name^="twitter:"], meta[property^="article:"]').forEach(el => el.remove());
  const desc = head.querySelector('meta[name="description"]');
  if (desc) desc.setAttribute('content', description || '');
  head.querySelector('link[rel="canonical"]')?.setAttribute('href', `${SITE}${urlForPath(path)}`);
  const hero = doc.querySelector('section.hero');
  if (hero) {
    const h1 = hero.querySelector('h1'); if (h1) h1.textContent = title;
    const lead = hero.querySelector('.lead'); if (lead) lead.textContent = description || '';
    const eyebrow = hero.querySelector('.eyebrow'); if (eyebrow) eyebrow.textContent = 'SEO Studies';
    const time = hero.querySelector('.meta time');
    if (time) { const d = new Date().toISOString().slice(0, 10); time.setAttribute('datetime', d); }
  }
  const article = doc.querySelector('article.article');
  if (article) article.innerHTML = '<h2 id="overview">Overview</h2><p></p>';
  // Fix relative asset depth if nesting differs from the template (template is one level deep).
  let out = serialize(doc);
  const extra = path.split('/').length - 2;
  if (extra > 0) out = out.replace(/(href|src)="\.\.\//g, `$1="${'../'.repeat(extra + 1)}`);
  if (article) {
    const d2 = parse(out); updateToc(d2, d2.querySelector('article.article')); out = serialize(d2);
  }
  return { path, html: out };
}
