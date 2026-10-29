# Homeland Property Group — Technical SEO Audit

**Audit date:** 29 October 2026  
**Repository/branch inspected:** `Mambeke/Homeland-Site`, `main`  
**Live URL supplied:** https://homeland.brandonmambeke.workers.dev/

## Scope and evidence

This audit inspected the repository's raw `public/index.html`, `src/worker.js`, `wrangler.jsonc`, and repository file tree. The live URL and requested routes were also attempted through the available web/network inspection tools, but the environment returned a fetch-disabled error and DNS resolution failure. As a result, **live HTTP statuses, response headers, rendered DOM, browser console, and real D1 listing/media responses could not be independently verified in this run**. Those items are marked unverified rather than inferred from source.

The implementation is a single public HTML document with inline CSS/JS. Listing data is fetched in the browser from `GET /api/listings`; property details are opened using URL fragments (`#ref-or-id`), not separate crawlable URLs.

## Findings ranked by impact

### Critical — Property listings do not have distinct crawlable URLs or server-rendered detail content
**Evidence:** `public/index.html` builds cards as links to `#${encodeURIComponent(l.ref || l.id)}`; `openDetail()` changes the fragment using `history.replaceState`. There is no path-based listing route in `src/worker.js`. Listings and descriptions are fetched client-side from `/api/listings` after the initial HTML response.

**Why it matters:** Search engines have no distinct URL for each property to crawl, index, share or rank. Hash fragments do not represent independent server resources, and content loaded only after JavaScript is less reliably discoverable.

**Recommendation:** Add stable listing URLs (for example, `/property/<slug-or-id>`) and return property-specific HTML/metadata from the Worker, including canonical, title, description, primary image and appropriate structured data. Keep the existing D1 records as the source of truth and preserve the current client-side interaction. This is a larger data-layer change and is not included in this foundational SEO PR.

### High — No canonical link, social metadata or structured data in the original homepage source
**Evidence:** Original `public/index.html` head had a title and description, but no `rel=canonical`, Open Graph/Twitter metadata, or JSON-LD.

**Why it matters:** Canonical signals help consolidate URL variants; social metadata improves link previews; Organization/RealEstateAgent and WebSite structured data help machines disambiguate the business and site identity.

**Fix in this PR:** Add a self-referencing canonical for the currently supplied live URL, Open Graph and Twitter tags, and JSON-LD describing the real-estate business and website. Replace the canonical host if/when a permanent branded domain is connected.

### High — No robots.txt or sitemap.xml in the original repository
**Evidence:** The original `public/` tree contained `index.html`, `admin.html`, images and logos, but no `robots.txt` or `sitemap.xml`.

**Why it matters:** Crawlers had no explicit sitemap discovery signal, and there was no crawl guidance to keep administrative/API routes out of routine crawling.

**Fix in this PR:** Add a robots file disallowing `/admin` and `/api/`, with a sitemap declaration, and add a sitemap listing the current public homepage. The sitemap intentionally does not invent listing URLs; it should be expanded after unique server-rendered listing routes exist.

### Medium — Property photos have empty alt attributes
**Evidence:** Card photos and detail thumbnails used `alt=""`; the main property detail image used the generic `alt="Property photo"`.

**Why it matters:** Descriptive alternatives provide context for non-visual users and crawlers. Empty alternatives intentionally mark an image decorative, which is not appropriate for a property's identifying photograph.

**Fix in this PR:** Add descriptive, escaped alt text to card photos and update the main detail image alt text when a listing is opened. The thumbnails remain navigation controls and can be assessed separately during accessibility QA.

### Medium — The branded canonical host is currently a workers.dev deployment URL
**Evidence:** The supplied live site and current absolute URLs use `homeland.brandonmambeke.workers.dev`.

**Why it matters:** A stable branded domain is easier for customers to recognise and avoids having to migrate canonical, sitemap and social URLs later.

**Recommendation:** When the business's permanent domain is connected and verified, update the canonical, structured data, sitemap, and Open Graph/Twitter URLs together. Do not point canonical signals at a domain that is not live yet.

### Medium — Client-side JavaScript is essential to populate the market
**Evidence:** `public/index.html` starts with “Loading listings…” placeholders, then fetches `/api/listings` and populates the sale/rent grids, filters and detail view through JavaScript.

**Why it matters:** The raw HTML response contains no listing content, and crawlers that do not execute JavaScript will not see the property inventory. Even for JavaScript-capable crawlers, discovering individual properties remains limited by the fragment-only URL design.

**Recommendation:** Prioritise server-rendered or pre-rendered listing pages after stable URLs are designed. Preserve `/api/listings` for the live interactive interface.

### Low — Image loading and page performance need field/lab validation
**Evidence:** The hero image is a CSS background (`/hero.webp`) and listing images lazy-load, but no live network trace, Lighthouse run, PageSpeed Insights results or Core Web Vitals data were available.

**Why it matters:** Large images, third-party font requests and layout shifts can affect real-user experience and search performance.

**Recommendation:** Test mobile and desktop with PageSpeed Insights/Lighthouse after deployment; evaluate hero LCP, explicit image dimensions/aspect ratios, font loading, and real-user INP/CLS/LCP. Do not treat source inspection alone as proof of performance.

## Requested live-route checks — status

| Path | Source-level expectation | Live verification |
|---|---|---|
| `/` | Static asset request to `public/index.html` via `env.ASSETS.fetch` | **Not verified:** network inspection tools could not fetch the hostname |
| `/admin` | Worker rewrites path to `/admin.html`; auth is handled by the admin app/API, not changed by this PR | **Not verified:** status, headers and redirect behavior not inspected live |
| `/api/listings` | Worker queries D1 and returns JSON for available listings, normally `200` | **Not verified:** D1 response/body count and headers could not be fetched |
| `/api/media/<id>` | Worker returns stored bytes for a real media ID, or `404` for missing media | **Not verified:** no live media ID was accessible in this run |
| Unknown path | Falls through to `env.ASSETS.fetch(request)`; final status depends on Cloudflare asset handling/configuration | **Not verified:** actual unknown-path status/headers not observed |

The Worker source sets `Cache-Control: no-store` on JSON responses. Media responses are marked `public, max-age=31536000, immutable`, which is suitable only if media IDs are immutable as implemented. No conclusions are made about actual deployed headers or statuses until the live endpoints can be tested.

## Not implemented in this PR

- Server-rendered property detail routes, property-level metadata/canonical URLs, and property structured data — requires coordinated routing/rendering changes in `src/worker.js` and must be tested against D1 and existing UI.
- Any changes to D1 listing records or `wrangler.jsonc`.
- Any changes to the `/admin` authentication flow.
- Performance claims or live-indexing claims; validate with Search Console, Rich Results Test and PageSpeed Insights.
