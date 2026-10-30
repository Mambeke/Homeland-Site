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
  // Staff access (email-based for now; the owner's email is seeded below).
  // This table is where "the owner adds staff" will live later.
  `CREATE TABLE IF NOT EXISTS staff_users (
    email TEXT PRIMARY KEY,
    name TEXT,
    created INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS staff_sessions (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL
  )`,
];

async function ensureSchema(env) {
  if (schemaReady) return;
  for (const raw of SCHEMA) {
    const sql = raw.replace(/\s+/g, ' ').trim();
    await env.DB.exec(sql);
  }
  try {
    await env.DB.exec('ALTER TABLE listings ADD COLUMN province TEXT');
  } catch (e) {
    /* column already exists */
  }
  try {
    await env.DB.exec('ALTER TABLE listings ADD COLUMN ptype TEXT');
  } catch (e) {
    /* column already exists */
  }
  // Seed the owner so they always have staff access (idempotent).
  try {
    await env.DB.prepare('INSERT OR IGNORE INTO staff_users (email, name, created) VALUES (?, ?, ?)')
      .bind('brandonmambeke@gmail.com', 'Owner', Date.now()).run();
  } catch (e) { /* already seeded */ }
  try {
    await env.DB.prepare('DELETE FROM staff_sessions WHERE expires < ?').bind(Date.now()).run();
  } catch (e) { /* best effort */ }
  schemaReady = true;
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  });
}

// fine property type -> coarse category (keeps home-page category cards working)
const PT2CAT = {
  'Houses': 'Houses',
  'Townhouses & Complexes': 'Houses',
  'Flats & Apartments': 'Houses',
  'Garden Flats': 'Houses',
  'Land': 'Urban Stands',
  'Stands & Residential Land': 'Urban Stands',
  'Commercial & Industrial Land': 'Commercial & Other',
  'Farms & Agricultural Land': 'Rural Stands',
  'Rural Stands': 'Rural Stands',
  'Commercial Property': 'Commercial & Other',
  'Warehouses & Factories': 'Commercial & Other',
  'Shops & Retail Property': 'Commercial & Other',
  'Offices': 'Commercial & Other',
  'Hotels & Lodges': 'Hotels',
  'Mines': 'Mines',
};

function rowToListing(r, photos) {
  let amenities = [], specs = {};
  try { amenities = JSON.parse(r.amenities || '[]'); } catch (e) {}
  try { specs = JSON.parse(r.specs || '{}'); } catch (e) {}
  return {
    id: r.id, ref: r.ref || '', title: r.title, loc: r.loc, province: r.province || '', price: r.price,
    kind: r.kind, cat: r.cat, ptype: r.ptype || '', beds: r.beds ?? null, baths: r.baths ?? null,
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

// Is this staff session token valid (exists, not expired, email still a staff member)?
async function staffTokenValid(env, token) {
  if (!token) return false;
  const s = await env.DB.prepare('SELECT * FROM staff_sessions WHERE token = ?').bind(token).first();
  if (!s) return false;
  if (Date.now() > s.expires) {
    await env.DB.prepare('DELETE FROM staff_sessions WHERE token = ?').bind(token).run();
    return false;
  }
  const u = await env.DB.prepare('SELECT 1 FROM staff_users WHERE lower(email) = lower(?)').bind(s.email).first();
  return !!u;
}

async function authOk(request, env) {
  const key = request.headers.get('x-admin-key') || '';
  if (key === env.ADMIN_PASS) return true;
  // Staff session token (issued by /api/staff/login)
  const token = request.headers.get('x-staff-token') || '';
  if (token) {
    if (await staffTokenValid(env, token)) return true;
    // A supplied-but-invalid token counts as a failed attempt for rate-limiting.
    const ip = request.headers.get('cf-access-ip') || request.headers.get('x-real-ip') || 'unknown';
    const now = Date.now();
    const rec = (fails.get(ip) || { n: 0, t: now });
    if (now - rec.t > 10 * 60 * 1000) { rec.n = 0; rec.t = now; }
    rec.n += 1;
    fails.set(ip, rec);
    if (rec.n > 10) return 'blocked';
    return false;
  }
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
  const ptype = f('ptype');
  const cat = (ptype && PT2CAT[ptype]) || f('cat') || 'Houses';
  const status = ['available', 'hidden', 'sold'].includes(f('status')) ? f('status') : 'available';
  const now = Date.now();
  const files = fd.getAll('photo').filter((x) => x && typeof x === 'object' && x.name);

  const beds = f('beds') ? parseFloat(f('beds')) : null;
  const baths = f('baths') ? parseFloat(f('baths')) : null;
  const amenitiesJson = JSON.stringify(f('amenities') ? f('amenities').split(',').map((s) => s.trim()).filter(Boolean) : []);
  let specsJson = '{}';
  if (f('specs')) { try { specsJson = JSON.stringify(JSON.parse(f('specs'))); } catch (e) {} }

  let id = f('id');
  const prov = f('province');
  if (id) {
    const existing = await env.DB.prepare('SELECT id FROM listings WHERE id = ?').bind(id).first();
    if (!existing) return json({ error: 'listing not found' }, 404);
    await env.DB.prepare(
      `UPDATE listings SET ref=?, title=?, loc=?, province=?, price=?, kind=?, cat=?, ptype=?, beds=?, baths=?, size=?, desc=?, note=?, amenities=?, specs=?, status=?, verified=?, updated_at=? WHERE id=?`
    )
      .bind(f('ref'), title, loc, prov, price, kind, cat, ptype, beds, baths, f('size'), f('desc'), f('note'),
        amenitiesJson, specsJson, status, f('verified') || '', now, id)
      .run();
  } else {
    id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO listings (id, ref, title, loc, province, price, kind, cat, ptype, beds, baths, size, desc, note, amenities, specs, status, verified, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(id, f('ref'), title, loc, prov, price, kind, cat, ptype,
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

  /* ---- staff (email sign-in for now; email-code flow plugs in later) ---- */
  if (p === '/api/staff/login' && method === 'POST') {
    let email = '';
    try { email = String((await request.json()).email || '').trim(); } catch (e) { /* fall through */ }
    email = email.toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: false, error: 'Enter a valid email address.' }, 400);
    const u = await env.DB.prepare('SELECT * FROM staff_users WHERE lower(email) = lower(?)').bind(email).first();
    if (!u) return json({ ok: false, error: 'That email does not have staff access.' }, 401);
    const token = crypto.randomUUID();
    const now = Date.now();
    const expires = now + 30 * 24 * 60 * 60 * 1000; // 30 days
    await env.DB.prepare('INSERT INTO staff_sessions (token, email, created, expires) VALUES (?, ?, ?, ?)')
      .bind(token, u.email, now, expires).run();
    return json({ ok: true, token, email: u.email, name: u.name || '' });
  }
  if (p === '/api/staff/logout' && method === 'POST') {
    let token = '';
    try { token = String((await request.json()).token || ''); } catch (e) { /* fall through */ }
    if (token) await env.DB.prepare('DELETE FROM staff_sessions WHERE token = ?').bind(token).run();
    return json({ ok: true });
  }
  if (p === '/api/staff/me' && method === 'GET') {
    const token = request.headers.get('x-staff-token') || '';
    if (await staffTokenValid(env, token)) {
      const s = await env.DB.prepare('SELECT email FROM staff_sessions WHERE token = ?').bind(token).first();
      const u = await env.DB.prepare('SELECT * FROM staff_users WHERE lower(email) = lower(?)').bind(s.email).first();
      return json({ ok: true, email: u.email, name: u.name || '' });
    }
    return json({ ok: false, error: 'not signed in' }, 401);
  }

  /* ---- admin ---- */
  if (p.startsWith('/api/admin/')) {
    const auth = await authOk(request, env);
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
      const res = await env.ASSETS.fetch(request);
      if (url.pathname === '/' || url.pathname.endsWith('.html')) {
        const fresh = new Response(res.body, res);
        fresh.headers.set('Cache-Control', 'no-cache');
        return fresh;
      }
      return res;
    } catch (err) {
      console.error(err);
      return new Response(JSON.stringify({ error: 'server error: ' + ((err && err.message) || String(err)) }),
        { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  },
};
