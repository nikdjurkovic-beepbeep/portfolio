// Minimal GitHub client for publishing to the site repository with a server-held token.

export class GitHubError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export class GitHub {
  constructor(env) {
    this.api = (env.GITHUB_API || 'https://api.github.com').replace(/\/$/, '');
    this.repo = env.GITHUB_REPO;
    this.branch = env.GITHUB_BRANCH || 'main';
    this.token = env.GITHUB_TOKEN;
    if (!this.token || !this.repo) throw new GitHubError('Publishing is not configured: GITHUB_TOKEN / GITHUB_REPO missing.', 503);
  }

  async req(path, options = {}) {
    const res = await fetch(`${this.api}${path}`, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'nikolaseo-cms',
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      }
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
    if (!res.ok) {
      // Never include the token or full upstream payloads in errors.
      const msg = res.status === 401 ? 'GitHub rejected the CMS publishing token. An administrator must renew it.'
        : res.status === 403 ? 'GitHub refused the request (token permissions or rate limit).'
          : res.status === 404 ? 'GitHub resource not found.'
            : `GitHub error ${res.status}: ${String(data.message || '').slice(0, 200)}`;
      throw new GitHubError(msg, res.status === 422 || res.status === 409 ? 409 : 502);
    }
    return data;
  }

  async headSha() {
    const ref = await this.req(`/repos/${this.repo}/git/ref/heads/${this.branch}`);
    return ref.object.sha;
  }

  /** Recursive tree of the branch head: Map(path -> { sha, size, type }). */
  async tree(commitSha) {
    const head = commitSha || await this.headSha();
    const commit = await this.req(`/repos/${this.repo}/git/commits/${head}`);
    const tree = await this.req(`/repos/${this.repo}/git/trees/${commit.tree.sha}?recursive=1`);
    if (tree.truncated) throw new GitHubError('Repository tree is too large to read in one request.', 502);
    const map = new Map();
    for (const item of tree.tree) if (item.type === 'blob') map.set(item.path, { sha: item.sha, size: item.size });
    return { head, treeSha: commit.tree.sha, files: map };
  }

  async blobText(sha) {
    const blob = await this.req(`/repos/${this.repo}/git/blobs/${sha}`);
    const bin = atob(blob.content.replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  }

  /** Read a text file at the branch head. Returns { text, sha } or null. */
  async readText(path, files) {
    const map = files || (await this.tree()).files;
    const entry = map.get(path);
    if (!entry) return null;
    return { text: await this.blobText(entry.sha), sha: entry.sha };
  }

  /**
   * Commit several changes atomically.
   * changes: [{ path, text } | { path, base64 } | { path, sha } (reuse blob) | { path, delete: true }],
   * each optionally with expectSha (null = must not exist) for optimistic concurrency.
   */
  async commit(changes, message, { author } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { head, treeSha, files } = await this.tree();
      for (const c of changes) {
        if (c.expectSha === undefined) continue;
        const current = files.get(c.path)?.sha ?? null;
        if (current !== c.expectSha) {
          throw Object.assign(new GitHubError(`${c.path} changed on GitHub since it was loaded (expected ${c.expectSha?.slice(0, 7) ?? 'no file'}, found ${current?.slice(0, 7) ?? 'no file'}). Reload and try again.`, 409), { code: 'stale_file', path: c.path });
        }
      }
      const entries = [];
      for (const c of changes) {
        if (c.delete) { if (files.has(c.path)) entries.push({ path: c.path, mode: '100644', type: 'blob', sha: null }); continue; }
        let sha = c.sha;
        if (!sha) {
          const blob = await this.req(`/repos/${this.repo}/git/blobs`, { method: 'POST', body: JSON.stringify(c.base64 !== undefined ? { content: c.base64, encoding: 'base64' } : { content: c.text, encoding: 'utf-8' }) });
          sha = blob.sha;
        }
        entries.push({ path: c.path, mode: '100644', type: 'blob', sha });
      }
      if (!entries.length) return { sha: head, files: {} };
      const tree = await this.req(`/repos/${this.repo}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: treeSha, tree: entries }) });
      const body = { message, tree: tree.sha, parents: [head] };
      if (author?.email) body.author = { name: author.name || author.email, email: author.email, date: new Date().toISOString() };
      const commit = await this.req(`/repos/${this.repo}/git/commits`, { method: 'POST', body: JSON.stringify(body) });
      try {
        await this.req(`/repos/${this.repo}/git/refs/heads/${this.branch}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
      } catch (e) {
        if (e.status === 409 && attempt === 0) continue; // branch moved; re-check expectations and retry once
        throw e;
      }
      const after = new Map(entries.map(e => [e.path, e.sha]));
      return { sha: commit.sha, files: Object.fromEntries(after) };
    }
    throw new GitHubError('The repository kept changing during publishing. Try again.', 409);
  }
}
