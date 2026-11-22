# Deploying the NikolaSEO CMS (v2)

**Status: prepared, NOT deployed.** Nothing below has been run against production. Every step needs the owner's go-ahead.

## What changes in production

| | Today | After deploy |
|---|---|---|
| Public pages | GitHub Pages serves `main` | Unchanged: still GitHub Pages from `main`, same URLs and files |
| In front of the site | Cloudflare DNS | Cloudflare Worker `nikolaseo-cms` on the route `nikolaseo.com/*` |
| Redirects | none possible | Real 301/302/303/307/308 responses from the Worker |
| CMS | `/admin/` + pasted GitHub token | `/admin/` + CMS accounts. The Worker publishes with a server-side token |
| Drafts, revisions, users, redirects, menus | none | Cloudflare D1 database `nikolaseo-cms` |

If the Worker fails, it lets requests through to GitHub Pages unchanged ("fails open"), so the public site keeps working even if the CMS breaks.

## Prerequisites (owner)

1. **Cloudflare plan: Workers Paid ($5/month) recommended.** The free plan allows 10 ms of CPU per request. Redirects and page delivery stay well under that (about 0.01 ms per match; 6 ms to load 5,000 rules every 15 s). CMS operations can go over it: composing a large page plus its SEO tags takes about 11 ms, and diagnosing or importing thousands of redirects takes more. On the free plan those operations can fail with error 1102.
2. DNS record for `nikolaseo.com` must be **Proxied** (orange cloud). SSL/TLS mode: **Full** (not Flexible). Full (strict) only works if GitHub Pages keeps a valid certificate behind the proxy.
3. A GitHub **fine-grained token**: resource owner `nikdjurkovic-beepbeep`, repository `portfolio` only, permission **Contents: Read and write**, expiry 1 year. Calendar the renewal.
4. Node 20+ and `npx wrangler login` on the machine that deploys.

## Steps

All commands run from `cms/worker/`.

```bash
cd cms && npm install && cd worker

# 1. Database
npx wrangler d1 create nikolaseo-cms          # copy the database_id into wrangler.toml
npx wrangler d1 migrations apply nikolaseo-cms --remote

# 2. Secrets (prompts for values; never commit them)
npx wrangler secret put GITHUB_TOKEN          # the fine-grained token
npx wrangler secret put SESSION_SECRET        # e.g. `openssl rand -base64 48`
npx wrangler secret put SETUP_TOKEN           # one-time, e.g. `openssl rand -hex 16`
npx wrangler secret put MFA_KEY               # e.g. `openssl rand -base64 48`; store a copy in your password manager

# 3. Worker + route + cron
npx wrangler deploy
```

4. In Cloudflare → Workers → `nikolaseo-cms` → Settings → Triggers, confirm the route `nikolaseo.com/*`. If the plan has a request-limit option, set it to **Fail open**.
5. **Merge the `cms-v2` branch into `main`** (this publishes the new `/admin/`). Wait for "pages build and deployment" to finish.
6. Open `https://nikolaseo.com/admin/`. It shows the **first-time setup** screen. Enter the SETUP_TOKEN, your name, email and a password (12+ characters). After you sign in, the CMS asks you to **set up two-factor authentication**: scan the QR code with Google Authenticator, enter the 6-digit code, and save the 10 recovery codes. Two-factor authentication is required for everyone with CMS access by default. You can change that in Settings.
7. On the Dashboard, click **Import pages from the repository**. This also imports the current header as the primary menu. Then go to **Media → Sync from repository**.
8. Remove the setup token: `npx wrangler secret delete SETUP_TOKEN`.
9. Verify against the live site:
   ```bash
   node cms/scripts/verify-deploy.mjs https://nikolaseo.com
   ```
   After you create redirects, export them in **Redirects → Export → All** and run the script again with the CSV. It checks the real status code and `Location` header of every exact redirect. In the CMS you can also select redirects and use **Verify live**, which goes through the existing HTTP Status Checker Worker.

## Order matters

Deploy the Worker (steps 1–4) **before** merging the branch. Until the merge, the old `/admin/` keeps working, because it talks to GitHub directly. After the merge, the new admin needs the Worker API.

## Rollback

- **Fast (seconds):** Cloudflare → Workers → `nikolaseo-cms` → Triggers → delete the route. The site is served directly by GitHub Pages again. Redirects and private pages stop working.
- **Admin UI:** revert the merge commit on `main`. The old token-based editor comes back.
- **Data:** D1 Time Travel can restore the database to any minute in the retention window (`npx wrangler d1 time-travel restore nikolaseo-cms --timestamp=…`). The CMS also offers JSON backups (Settings) and redirect backups (Redirects → Backups).

## Operating notes

- Redirect changes go live within ~15 s, which is how often each edge instance reloads its rules.
- Publishing commits to `main`. GitHub Pages usually updates within about 1 minute.
- The scheduler runs every 5 minutes (cron). The Settings screen shows when it last ran.
- Private and password-protected pages are never written to the public repository. **Anything ever committed publicly stays in git history.** Making a page private hides it from the site, but its earlier public versions remain in history.
- Media files live in the public repository, so they are public even when the page that uses them is private.
- Password reset links are generated by an administrator (Users → Reset link). The CMS does not send email. Self-service email reset would need an email service. A reset link changes the password only; two-factor authentication stays on.

## Two-factor authentication

- **How it works:** the CMS uses standard time-based 6-digit codes (TOTP, RFC 6238). They work with Google Authenticator, Microsoft Authenticator, 1Password, Authy and similar apps.
- **Policy** (Settings → Require two-factor authentication for): nobody, administrators, everyone with CMS access (default), or all accounts. A required user without 2FA can do nothing until they set it up.
- **Storage:**
  - Authenticator secrets are encrypted in D1 with `MFA_KEY` (AES-GCM, bound to the user id).
  - Recovery codes are stored only as hashes.
  - A code can't be used twice. A sign-in attempt allows 5 wrong codes, and failures count toward the 15-minute account lock.
- **Lost phone, user still has recovery codes:** they sign in with a recovery code, then use **Account → Move to a new phone**.
- **Lost phone and recovery codes:** an administrator uses **Users → Reset 2FA** for that user. The user sets 2FA up again at their next sign-in.
- **Sole administrator fully locked out:** run this from the deploy machine, then sign in and set 2FA up again:
  ```bash
  npx wrangler d1 execute nikolaseo-cms --remote --command "UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL, recovery_codes = '[]' WHERE email = 'you@example.com'"
  ```
- **If `MFA_KEY` is missing:** 2FA can't be set up or enforced, and the dashboard shows a warning. **If `MFA_KEY` is changed:** existing authenticators stop working, and every user needs a Reset 2FA.
