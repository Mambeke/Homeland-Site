# Homeland Property Group — Website

Source for the live site: **https://homeland.brandonmambeke.workers.dev/**

Built as a single **Cloudflare Worker** that serves the static site and a small JSON API over a **D1** (SQLite) database on Cloudflare. The staff sign-in email path currently targets Resend; no mail-provider credentials are configured.

## File map

| Path | Purpose |
|---|---|
| `wrangler.jsonc` | Worker config: name, D1 binding, static assets from `./public` |
| `src/worker.js` | The Worker — serves pages, `/api/*` endpoints, email-code staff auth, and server-side `ADMIN_PASS` automation auth (secret, never in this repo) |
| `public/index.html` | The entire public site (HTML + CSS + JS in one file) |
| `public/admin.html` | Email-code staff UI for owner and assistant editors (served at `/admin`) |
| `public/hero.webp` | Hero image |
| `public/logo.png` / `logo-white.png` | Brand logos (light / dark backgrounds) |
| `public/favicon.png` | Favicon |

## Data layer

- Listings, details and photos (stored as BLOBs) live in the **D1 database `homeland`** — not in this repo.
- Public endpoints (no auth):
  - `GET /api/listings` — available listings as JSON (powers the market grids)
  - `GET /api/media/:id` — listing photos
- The sole human admin is `brandonmambeke@gmail.com`. That owner account can add or revoke up to three assistant/editor accounts from the staff UI. Editors can change a listing's availability only (`available`, `hidden`, or `sold`); they cannot add, edit, or delete listings or change prices, details, or photos. These limits are enforced by the Worker, not just by hidden UI controls.
- Staff authenticate allowlisted accounts by a six-digit email one-time code sent through Resend. Codes expire after 10 minutes, are single-use, allow at most five verification attempts, and are stored as keyed HMAC digests. Successful sign-in receives a 12-hour `HttpOnly`, `Secure`, `SameSite=Strict` cookie; browser JavaScript never receives the session token.
- Configure Worker secrets `RESEND_API_KEY` and `STAFF_OTP_SECRET` (generate the latter as a random value of at least 32 characters), plus the `STAFF_AUTH_FROM` Worker variable set to an address on a verified Resend sending domain. Never commit or paste secret values into chat. The code endpoint returns a generic response for allowlisted and unknown emails; D1-backed hourly limits are applied by hashed IP/email identifiers.
- `ADMIN_PASS` is retained only for non-browser automation through the `X-Admin-Key` header. It is no longer a staff sign-in password. Keep it out of the repository.
- Photo uploads are signature-checked and limited to JPEG, PNG, WebP, GIF, AVIF, and HEIF/HEIC; unknown or active media types are served as downloads rather than inline content.
- Add Cloudflare edge rate limiting as defense in depth. D1-backed app limits persist across Worker isolates but are not a substitute for edge controls against large distributed abuse.

## Deploying

```bash
npm i -g wrangler   # or use npx wrangler
wrangler deploy
```

Requires a Cloudflare API token with **Workers: Edit** + **D1: Edit** and the account ID. Deploy target: Worker `homeland`. Do not deploy without explicit approval.

The site reads its data at runtime, so **adding/removing listings through `/admin` does not require a redeploy** — only code/design changes do.
