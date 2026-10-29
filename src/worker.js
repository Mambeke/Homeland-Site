/* Homeland Property Group — site worker
 * Serves the static site + a small JSON API over D1.
 * Public:  GET /api/listings, GET /api/media/:id
 * Admin:   X-Admin-Key header, password checked server-side */

let schemaReady = false;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY,
    ref TEXT,
    title TEXT NOT NULL,
    loc TEXT NOT NULL,
    price REAL NOT NULL,
    kind TEXT NOT NULL DEFAULT 'sale',
    cat TEXT NOT NULL DEFAULT 'Houses',
    beds REAL,
    baths REAL,
    size TEXT,
    desc TEXT,
    note TEXT,
    amenities TEXT,
    specs TEXT,
    status TEXT NOT NULL DEFAULT 'available',
    verified TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY,
    listing_id TEXT NOT NULL,
    url TEXT NOT NULL,
    mime TEXT,
    data BLOB,
    pos INTEGER NOT NULL DEFAULT 0
  )`,
];

async function ensureSchema(env) {
  if (schemaReady) return;
  for (const raw of SCHEMA) {
    const sql = raw.replace(/\s+/g, ' ').trim();
    await env.DB.exec(sql);
  }
  schemaReady = true;
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  });
}

function rowToListing(r, photos) {
  let amenities = [], specs = {};
  try { amenities = JSON.parse(r.amenities || '[]'); } catch (e) {}
  try { specs = JSON.parse(r.specs || '{}'); } catch (e) {}
  return {
    id: r.id, ref: r.ref || '', title: r.title, loc: r.loc, price: r.price,
    kind: r.kind, cat: r.cat, beds: r.beds ?? null, baths: r.baths ?? null,
    size: r.size || '', desc: r.desc || '', note: r.note || '',
    amenities, specs, status: r.status, verified: r.verified || '',
    photos: photos || [],
  };
}

async function photosFor(env, listingIds) {
  const byId = {};
  if (!listingIds.length) return byId;
  const ph = await env.DB
    .prepare(`SELECT id, listing_id, url, mime FROM photos WHERE listing_id IN (${listingIds.map(() => '?').join(',')}) ORDER BY pos, id`)
    .bind(...listingIds)
    .all();
  for (const p of ph.results) (byId[p.listing_id] ||= []).push({ id: p.id, url: p.url, mime: p.mime });
  return byId;
}

async function listListings(env, { all = false } = {}) {
  const order = 'ORDER BY (ref IS NULL OR ref = \'\'), ref ASC';
  const rows = all
    ? await env.DB.prepare(`SELECT * FROM listings ${order}`).all()
    : await env.DB.prepare(`SELECT * FROM listings WHERE status = 'available' ${order}`).all();
  const byId = await photosFor(env, rows.results.map((r) => r.id));
  return rows.results.map((r) => rowToListing(r, byId[r.id] || []));
}

/* ---------- admin auth (light rate-limit: 10 fails / 10 min / IP) ---------- */
const fails = new Map();
function authOk(request, env) {
  const key = request.headers.get('x-admin-key') || '';
  if (key === env.ADMIN_PASS) return true;
  const ip = request.headers.get('cf-access-ip') || request.headers.get('x-real-ip') || 'unknown';
  const now = Date.now();
  const rec = (fails.get(ip) || { n: 0, t: now });
  if (now - rec.t > 10 * 60 * 1000) { rec.n = 0; rec.t = now; }
  rec.n += 1;
  fails.set(ip, rec);
  if (rec.n > 10) return 'blocked';
  return false;
}

/* ---------- admin: create / update listing (multipart) ---------- */
async function saveListing(request, env) {
  const fd = await request.formData();
  const f = (k) => (fd.get(k) != null ? String(fd.get(k)).trim() : '');
  const title = f('title');
  const loc = f('loc');
  const price = parseFloat(f('price'));
  if (!title || !loc || !isFinite(price)) return json({ error: 'title, loc and a valid price are required' }, 400);

  const kind = f('kind') === 'rent' ? 'rent' : 'sale';
  const cat = f('cat') || 'Houses';
  const status = ['available', 'hidden', 'sold'].includes(f('status')) ? f('status') : 'available';
  const now = Date.now();
  const files = fd.getAll('photo').filter((x) => x && typeof x === 'object' && x.name);

  const beds = f('beds') ? parseFloat(f('beds')) : null;
  const baths = f('baths') ? parseFloat(f('baths')) : null;
  const amenitiesJson = JSON.stringify(f('amenities') ? f('amenities').split(',').map((s) => s.trim()).filter(Boolean) : []);
  let specsJson = '{}';
  if (f('specs')) { try { specsJson = JSON.stringify(JSON.parse(f('specs'))); } catch (e) {} }

  let id = f('id');
  if (id) {
    const existing = await env.DB.prepare('SELECT id FROM listings WHERE id = ?').bind(id).first();
    if (!existing) return json({ error: 'listing not found' }, 404);
    await env.DB.prepare(
      `UPDATE listings SET ref=?, title=?, loc=?, price=?, kind=?, cat=?, beds=?, baths=?, size=?, desc=?, note=?, amenities=?, specs=?, status=?, verified=?, updated_at=? WHERE id=?`
    )
      .bind(f('ref'), title, loc, price, kind, cat, beds, baths, f('size'), f('desc'), f('note'),
        amenitiesJson, specsJson, status, f('verified') || '', now, id)
      .run();
  } else {
    id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO listings (id, ref, title, loc, price, kind, cat, beds, baths, size, desc, note, amenities, specs, status, verified, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(id, f('ref'), title, loc, price, kind, cat,
        f('beds') ? parseFloat(f('beds')) : null, f('baths') ? parseFloat(f('baths')) : null,
        f('size'), f('desc'), f('note'), JSON.stringify(f('amenities') ? f('amenities').split(',').map((s) => s.trim()).filter(Boolean) : []),
        f('specs') || '{}', status, f('verified') || '', now, now)
      .run();
  }

  // photo management
  if (f('_clear_photos') === '1') {
    await env.DB.prepare('DELETE FROM photos WHERE listing_id = ?').bind(id).run();
  }
  const rm = f('_remove_photos');
  if (rm) {
    const ids = rm.split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length) {
      await env.DB.prepare(`DELETE FROM photos WHERE listing_id = ? AND id IN (${ids.map(() => '?').join(',')})`).bind(id, ...ids).run();
    }
  }
  if (files.length) {
    let pos = 0;
    const existing = await env.DB.prepare('SELECT COUNT(*) AS c FROM photos WHERE listing_id = ?').bind(id).first();
    pos = existing ? existing.c : 0;
    for (const file of files) {
      const pid = crypto.randomUUID();
      const buf = new Uint8Array(await file.arrayBuffer());
      const mime = file.type || 'image/webp';
      await env.DB.prepare('INSERT INTO photos (id, listing_id, url, mime, data, pos) VALUES (?,?,?,?,?,?)')
        .bind(pid, id, `/api/media/${pid}`, mime, buf, pos++).run();
    }
  }

  const rows = await env.DB.prepare('SELECT * FROM listings WHERE id = ?').bind(id).all();
  const byId = await photosFor(env, [id]);
  return json({ ok: true, listing: rowToListing(rows.results[0], byId[id] || []) }, 201);
}

/* ---------- API router ---------- */
async function handleApi(request, env, url) {
  await ensureSchema(env);
  const p = url.pathname;
  const method = request.method;

  if (p === '/api/listings' && method === 'GET') {
    return json(await listListings(env));
  }

  const media = p.match(/^\/api\/media\/([A-Za-z0-9-]+)$/);
  if (media && method === 'GET') {
    const row = await env.DB.prepare('SELECT mime, data FROM photos WHERE id = ?').bind(media[1]).first();
    if (!row || !row.data) return new Response('not found', { status: 404 });
    const bytes = new Uint8Array(row.data);
    return new Response(bytes, {
      headers: {
        'Content-Type': row.mime || 'image/webp',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  }

  /* ---- admin ---- */
  if (p.startsWith('/api/admin/')) {
    const auth = authOk(request, env);
    if (auth === 'blocked') return json({ error: 'too many attempts, try again later' }, 429);
    if (!auth) return json({ error: 'unauthorized' }, 401);

    if (p === '/api/admin/listings' && method === 'GET') {
      return json(await listListings(env, { all: true }));
    }

    if (p === '/api/admin/listings' && (method === 'POST' || method === 'PUT')) {
      return saveListing(request, env);
    }

    const del = p.match(/^\/api\/admin\/listings\/([A-Za-z0-9-]+)$/);
    if (del && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM photos WHERE listing_id = ?').bind(del[1]).run();
      await env.DB.prepare('DELETE FROM listings WHERE id = ?').bind(del[1]).run();
      return json({ ok: true });
    }

    if (p === '/api/admin/stats' && method === 'GET') {
      const l = await env.DB.prepare('SELECT COUNT(*) AS c FROM listings').first();
      const ph = await env.DB.prepare('SELECT COUNT(*) AS c FROM photos').first();
      return json({ listings: l.c, photos: ph.c });
    }
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url);
      if (url.pathname === '/admin') {
        const u = new URL(request.url);
        u.pathname = '/admin.html';
        return await env.ASSETS.fetch(new Request(u.toString(), request));
      }
      return await env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return new Response(JSON.stringify({ error: 'server error: ' + ((err && err.message) || String(err)) }),
        { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  },
};
