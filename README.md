# Homeland Property Group — Website

Source for the live site: **https://homeland.brandonmambeke.workers.dev/**

Built as a single **Cloudflare Worker** that serves the static site and a small JSON API over a **D1** (SQLite) database on Cloudflare. No third-party services.

## File map

| Path | Purpose |
|---|---|
| `wrangler.jsonc` | Worker config: name, D1 binding, static assets from `./public` |
| `src/worker.js` | The Worker — serves pages, `/api/*` endpoints, admin auth (password is a Cloudflare **secret**, never in this repo) |
| `public/index.html` | The entire public site (HTML + CSS + JS in one file) |
| `public/admin.html` | Password-protected listings admin (served at `/admin`) |
| `public/hero.webp` | Hero image |
| `public/logo.png` / `logo-white.png` | Brand logos (light / dark backgrounds) |
| `public/favicon.png` | Favicon |

## Data layer

- Listings, details and photos (stored as BLOBs) live in the **D1 database `homeland`** — not in this repo.
- Public endpoints (no auth):
  - `GET /api/listings` — available listings as JSON (powers the market grids)
  - `GET /api/media/:id` — listing photos
- Admin endpoints require the `X-Admin-Key` header (checked server-side against the `ADMIN_PASS` secret).

## Deploying

```bash
npm i -g wrangler   # or use npx wrangler
wrangler deploy
```

Requires a Cloudflare API token with **Workers: Edit** + **D1: Edit** and the account ID. Deploy target: Worker `homeland` → `https://homeland.brandonmambeke.workers.dev`.

The site reads its data at runtime, so **adding/removing listings through `/admin` does not require a redeploy** — only code/design changes do.
