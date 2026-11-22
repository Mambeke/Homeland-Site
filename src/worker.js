/* Homeland Property Group — site worker
 * Serves the static site + a small JSON API over D1.
 * Public:  GET /api/listings, GET /api/media/:id
 * Admin:   allowlisted email OTP, short-lived HttpOnly cookie session or X-Admin-Key */

let schemaReady = false;
const OWNER_EMAIL = 'brandonmambeke@gmail.com';

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
  // The owner is the sole admin; every other allowlisted account is an editor.
  `CREATE TABLE IF NOT EXISTS staff_users (
    email TEXT PRIMARY KEY,
    name TEXT,
    created INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'editor'
  )`,
  `CREATE TRIGGER IF NOT EXISTS staff_editor_limit
    BEFORE INSERT ON staff_users
    WHEN lower(NEW.email) <> 'brandonmambeke@gmail.com'
      AND (SELECT COUNT(*) FROM staff_users WHERE lower(email) <> 'brandonmambeke@gmail.com') >= 3
    BEGIN SELECT RAISE(ABORT, 'maximum of three assistant editors'); END`,
  `CREATE TABLE IF NOT EXISTS staff_sessions (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS staff_login_challenges (
    email TEXT PRIMARY KEY,
    challenge_id TEXT NOT NULL UNIQUE,
    code_hash TEXT NOT NULL,
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL,
    last_sent INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS staff_otp_rate_limits (
    rate_key TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (rate_key, window_start)
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
  try {
    await env.DB.exec("ALTER TABLE staff_users ADD COLUMN role TEXT NOT NULL DEFAULT 'editor'");
  } catch (e) {
    /* role column already exists */
  }
  // Seed and promote only the owner account; every other identity is always treated as an editor.
  try {
    await env.DB.prepare('INSERT OR IGNORE INTO staff_users (email, name, created, role) VALUES (?, ?, ?, ?)')
      .bind(OWNER_EMAIL, 'Owner', Date.now(), 'admin').run();
    await env.DB.prepare('UPDATE staff_users SET role = ? WHERE lower(email) = lower(?)')
      .bind('admin', OWNER_EMAIL).run();
  } catch (e) { /* best effort; requests still fail closed if the owner row is absent */ }
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

const SAFE_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif']);

// Verify binary signatures instead of trusting a client-provided MIME; SVG/HTML are not inline photos.
function sniffSafeImageMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes.length >= 12
      && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
      && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp') {
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (['mif1', 'msf1'].includes(brand)) return 'image/heif';
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'].includes(brand)) return 'image/heic';
  }
  const header = String.fromCharCode(...bytes.slice(0, 6));
  if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif';
  return '';
}

/* ---------- admin auth ---------- */
const STAFF_COOKIE = '__Host-hp_staff_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 30 * 1000;
const OTP_RATE_WINDOW_MS = 60 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_IP_REQUEST_LIMIT = 10;
const OTP_EMAIL_REQUEST_LIMIT = 5;
const OTP_IP_VERIFY_LIMIT = 30;
const OTP_EMAIL_VERIFY_LIMIT = 15;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_FAIL_LIMIT = 10;
const adminFailures = new Map();

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

function failureCount(map, ip) {
  const record = map.get(ip);
  if (!record) return 0;
  if (Date.now() - record.startedAt >= FAIL_WINDOW_MS) {
    map.delete(ip);
    return 0;
  }
  return record.count;
}

function noteFailure(map, ip) {
  const now = Date.now();
  let record = map.get(ip);
  if (!record || now - record.startedAt >= FAIL_WINDOW_MS) record = { startedAt: now, count: 0 };
  record.count += 1;
  map.set(ip, record);
  // Bound isolate-local bookkeeping if requests come from many different addresses.
  if (map.size > 1024) {
    for (const [key, item] of map) {
      if (now - item.startedAt >= FAIL_WINDOW_MS) map.delete(key);
    }
    while (map.size > 2048) map.delete(map.keys().next().value);
  }
  return record.count;
}

function clearFailures(map, ip) {
  map.delete(ip);
}

async function constantTimeEqual(a, b) {
  const enc = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b))),
  ]);
  const x = new Uint8Array(left), y = new Uint8Array(right);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function staffOtpConfigured(env) {
  return typeof env.RESEND_API_KEY === 'string' && env.RESEND_API_KEY.length > 0
    && typeof env.STAFF_AUTH_FROM === 'string' && env.STAFF_AUTH_FROM.trim().length > 0
    && env.STAFF_AUTH_FROM.length <= 254
    && !env.STAFF_AUTH_FROM.includes(String.fromCharCode(10))
    && !env.STAFF_AUTH_FROM.includes(String.fromCharCode(13))
    && typeof env.STAFF_OTP_SECRET === 'string' && env.STAFF_OTP_SECRET.length >= 32;
}

async function privateHmac(env, value) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(env.STAFF_OTP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(String(value)));
  return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function otpCodeHash(env, email, challengeId, code) {
  return privateHmac(env, JSON.stringify(['staff-otp', email, challengeId, code]));
}

async function otpRateAllowed(env, scope, identity, limit, now = Date.now()) {
  const key = `${scope}:${await privateHmac(env, JSON.stringify(['rate', scope, identity]))}`;
  const windowStart = Math.floor(now / OTP_RATE_WINDOW_MS) * OTP_RATE_WINDOW_MS;
  const row = await env.DB.prepare(
    'INSERT INTO staff_otp_rate_limits (rate_key, window_start, count) VALUES (?, ?, 1) ON CONFLICT (rate_key, window_start) DO UPDATE SET count = count + 1 RETURNING count',
  ).bind(key, windowStart).first();
  return Number(row?.count || 0) <= limit;
}

async function sendStaffOtp(env, email, code) {
  const text = `Your Homeland Property Group staff sign-in code is ${code}. It expires in 10 minutes. If you did not request it, ignore this email. Do not share this code with anyone.`;
  const html = `<p>Your Homeland Property Group staff sign-in code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>This code expires in 10 minutes. If you did not request it, ignore this email. Do not share this code with anyone.</p>`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.STAFF_AUTH_FROM,
      to: [email],
      subject: 'Your Homeland staff sign-in code',
      text,
      html,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) console.error(`Staff OTP email provider returned HTTP ${response.status}`);
  return response.ok;
}

function staffCookieToken(request) {
  const prefix = STAFF_COOKIE + '=';
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const cookie = part.trim();
    if (!cookie.startsWith(prefix)) continue;
    const token = cookie.slice(prefix.length);
    return /^[a-f0-9-]{36}$/i.test(token) ? token : '';
  }
  return '';
}

function staffCookie(token, maxAge = Math.floor(SESSION_TTL_MS / 1000)) {
  return `${STAFF_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch (e) {
    return false;
  }
}

function normalizedEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function staffRoleFor(user) {
  // Never trust a role field alone: Brandon's account is the sole human admin.
  return normalizedEmail(user?.email) === OWNER_EMAIL ? 'admin' : 'editor';
}

function isOwnerAccountSession(auth) {
  return auth?.role === 'admin' && normalizedEmail(auth.email) === OWNER_EMAIL && auth.automation !== true;
}

async function staffSessionUser(env, token) {
  if (!token) return null;
  const session = await env.DB.prepare('SELECT * FROM staff_sessions WHERE token = ?').bind(token).first();
  if (!session) return null;
  if (Date.now() > session.expires) {
    await env.DB.prepare('DELETE FROM staff_sessions WHERE token = ?').bind(token).run();
    return null;
  }
  const user = await env.DB.prepare('SELECT email, name, role FROM staff_users WHERE lower(email) = lower(?)')
    .bind(session.email).first();
  if (!user) return null;
  return { email: user.email, name: user.name || '', role: staffRoleFor(user) };
}

async function authOk(request, env) {
  const key = request.headers.get('x-admin-key') || '';
  if (key && env.ADMIN_PASS && await constantTimeEqual(key, env.ADMIN_PASS)) {
    return { email: OWNER_EMAIL, name: 'Owner', role: 'admin', automation: true };
  }

  const token = staffCookieToken(request);
  const user = await staffSessionUser(env, token);
  if (user) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !sameOrigin(request)) return 'csrf';
    clearFailures(adminFailures, clientIp(request));
    return user;
  }

  const ip = clientIp(request);
  if (failureCount(adminFailures, ip) >= ADMIN_FAIL_LIMIT) return 'blocked';
  noteFailure(adminFailures, ip);
  return failureCount(adminFailures, ip) >= ADMIN_FAIL_LIMIT ? 'blocked' : false;
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
  const fileMimes = new Map();
  for (const file of files) {
    if (typeof file.slice !== 'function') return json({ error: 'Uploaded photos must be valid supported image files.' }, 400);
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const mime = sniffSafeImageMime(head);
    if (!mime) {
      return json({ error: 'Uploaded photos must be valid JPEG, PNG, WebP, GIF, AVIF, or HEIF images.' }, 400);
    }
    fileMimes.set(file, mime);
  }

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
      const mime = fileMimes.get(file);
      await env.DB.prepare('INSERT INTO photos (id, listing_id, url, mime, data, pos) VALUES (?,?,?,?,?,?)')
        .bind(pid, id, `/api/media/${pid}`, mime, buf, pos++).run();
    }
  }

  const rows = await env.DB.prepare('SELECT * FROM listings WHERE id = ?').bind(id).all();
  const byId = await photosFor(env, [id]);
  return json({ ok: true, listing: rowToListing(rows.results[0], byId[id] || []) }, 201);
}

const OTP_SENT_RESPONSE = {
  ok: true,
  message: 'If this email has staff access, a verification code has been sent.',
};
const OTP_INVALID_RESPONSE = { ok: false, error: 'Invalid or expired verification code.' };

async function readStaffAuthBody(request) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 4096) return { error: 'too_large' };
  const body = await request.text();
  if (body.length > 4096) return { error: 'too_large' };
  try { return { value: JSON.parse(body) }; } catch (e) { return { error: 'invalid' }; }
}

async function requestStaffOtp(request, env, ctx) {
  if (!sameOrigin(request)) return json({ ok: false, error: 'Sign-in request rejected.' }, 403);
  if (!staffOtpConfigured(env)) return json({ ok: false, error: 'Staff email sign-in is not configured.' }, 503);
  const parsed = await readStaffAuthBody(request);
  if (parsed.error === 'too_large') return json({ ok: false, error: 'Request too large.' }, 413);
  if (parsed.error) return json({ ok: false, error: 'Invalid request.' }, 400);

  const email = typeof parsed.value?.email === 'string' ? parsed.value.email.trim().toLowerCase() : '';
  const emailValid = email.length <= 320 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  const now = Date.now();
  await env.DB.prepare('DELETE FROM staff_otp_rate_limits WHERE window_start < ?')
    .bind(now - 2 * OTP_RATE_WINDOW_MS).run();
  await env.DB.prepare('DELETE FROM staff_login_challenges WHERE expires < ?').bind(now).run();

  const ipAllowed = await otpRateAllowed(env, 'request-ip', clientIp(request), OTP_IP_REQUEST_LIMIT, now);
  if (!ipAllowed) return json({ ok: false, error: 'Too many requests. Please try again later.' }, 429);

  const user = emailValid
    ? await env.DB.prepare('SELECT * FROM staff_users WHERE lower(email) = lower(?)').bind(email).first()
    : null;
  if (!user) return json(OTP_SENT_RESPONSE, 202);

  const canonicalEmail = String(user.email).trim().toLowerCase();
  const emailAllowed = await otpRateAllowed(env, 'request-email', canonicalEmail, OTP_EMAIL_REQUEST_LIMIT, now);
  if (!emailAllowed) return json(OTP_SENT_RESPONSE, 202);

  const prior = await env.DB.prepare('SELECT * FROM staff_login_challenges WHERE email = ?').bind(canonicalEmail).first();
  if (prior && now - prior.last_sent < OTP_RESEND_COOLDOWN_MS) return json(OTP_SENT_RESPONSE, 202);

  const challengeId = crypto.randomUUID();
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  const codeHash = await otpCodeHash(env, canonicalEmail, challengeId, code);
  const expires = now + OTP_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO staff_login_challenges (email, challenge_id, code_hash, created, expires, last_sent, attempts)
     VALUES (?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(email) DO UPDATE SET challenge_id=excluded.challenge_id, code_hash=excluded.code_hash,
       created=excluded.created, expires=excluded.expires, last_sent=excluded.last_sent, attempts=0`,
  ).bind(canonicalEmail, challengeId, codeHash, now, expires, now).run();

  const delivery = sendStaffOtp(env, canonicalEmail, code)
    .then(async (sent) => {
      if (!sent) {
        await env.DB.prepare('DELETE FROM staff_login_challenges WHERE email = ? AND challenge_id = ?')
          .bind(canonicalEmail, challengeId).run();
      }
    })
    .catch(async () => {
      console.error('Staff OTP email delivery failed.');
      await env.DB.prepare('DELETE FROM staff_login_challenges WHERE email = ? AND challenge_id = ?')
        .bind(canonicalEmail, challengeId).run();
    });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(delivery);
  else await delivery;
  return json(OTP_SENT_RESPONSE, 202);
}

async function verifyStaffOtp(request, env) {
  if (!sameOrigin(request)) return json({ ok: false, error: 'Sign-in request rejected.' }, 403);
  if (!staffOtpConfigured(env)) return json({ ok: false, error: 'Staff email sign-in is not configured.' }, 503);
  const parsed = await readStaffAuthBody(request);
  if (parsed.error === 'too_large') return json({ ok: false, error: 'Request too large.' }, 413);
  if (parsed.error) return json(OTP_INVALID_RESPONSE, 401);

  const email = typeof parsed.value?.email === 'string' ? parsed.value.email.trim().toLowerCase() : '';
  const code = typeof parsed.value?.code === 'string' ? parsed.value.code : '';
  const emailValid = email.length <= 320 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  const codeValid = /^\d{6}$/.test(code);
  const now = Date.now();
  await env.DB.prepare('DELETE FROM staff_otp_rate_limits WHERE window_start < ?')
    .bind(now - 2 * OTP_RATE_WINDOW_MS).run();
  if (!await otpRateAllowed(env, 'verify-ip', clientIp(request), OTP_IP_VERIFY_LIMIT, now)) {
    return json({ ok: false, error: 'Too many attempts. Please request another code later.' }, 429);
  }

  const user = emailValid
    ? await env.DB.prepare('SELECT * FROM staff_users WHERE lower(email) = lower(?)').bind(email).first()
    : null;
  if (!user) {
    await otpCodeHash(env, email, '00000000-0000-0000-0000-000000000000', codeValid ? code : '');
    return json(OTP_INVALID_RESPONSE, 401);
  }

  const canonicalEmail = String(user.email).trim().toLowerCase();
  if (!await otpRateAllowed(env, 'verify-email', canonicalEmail, OTP_EMAIL_VERIFY_LIMIT, now)) {
    return json({ ok: false, error: 'Too many attempts. Please request another code later.' }, 429);
  }
  const challenge = await env.DB.prepare('SELECT * FROM staff_login_challenges WHERE email = ?')
    .bind(canonicalEmail).first();
  if (!challenge || challenge.expires <= now || challenge.attempts >= OTP_MAX_ATTEMPTS) {
    await otpCodeHash(env, canonicalEmail, challenge?.challenge_id || '00000000-0000-0000-0000-000000000000', codeValid ? code : '');
    return json(OTP_INVALID_RESPONSE, 401);
  }

  const attempt = await env.DB.prepare(
    `UPDATE staff_login_challenges SET attempts = attempts + 1
     WHERE email = ? AND challenge_id = ? AND expires > ? AND attempts < ? RETURNING attempts`,
  ).bind(canonicalEmail, challenge.challenge_id, now, OTP_MAX_ATTEMPTS).first();
  if (!attempt) return json(OTP_INVALID_RESPONSE, 401);

  const candidateHash = await otpCodeHash(env, canonicalEmail, challenge.challenge_id, code);
  if (!codeValid || !await constantTimeEqual(candidateHash, challenge.code_hash)) {
    return json(OTP_INVALID_RESPONSE, 401);
  }

  const consumed = await env.DB.prepare(
    'DELETE FROM staff_login_challenges WHERE email = ? AND challenge_id = ? AND code_hash = ? AND expires > ? RETURNING email',
  ).bind(canonicalEmail, challenge.challenge_id, challenge.code_hash, now).first();
  if (!consumed) return json(OTP_INVALID_RESPONSE, 401);

  const token = crypto.randomUUID();
  const expires = now + SESSION_TTL_MS;
  await env.DB.prepare('INSERT INTO staff_sessions (token, email, created, expires) VALUES (?, ?, ?, ?)')
    .bind(token, user.email, now, expires).run();
  return json(
    { ok: true, email: user.email, name: user.name || '', role: staffRoleFor(user) },
    200,
    { 'Set-Cookie': staffCookie(token) },
  );
}

async function getAssistantEditors(env) {
  const rows = await env.DB.prepare(
    'SELECT email, name, created FROM staff_users WHERE lower(email) <> lower(?) ORDER BY created, email',
  ).bind(OWNER_EMAIL).all();
  return rows.results.map((row) => ({ email: row.email, name: row.name || '', created: row.created, role: 'editor' }));
}

async function addAssistantEditor(request, env) {
  const parsed = await readStaffAuthBody(request);
  if (parsed.error === 'too_large') return json({ error: 'Request too large.' }, 413);
  if (parsed.error) return json({ error: 'Invalid request.' }, 400);
  const email = normalizedEmail(parsed.value?.email);
  const name = typeof parsed.value?.name === 'string' ? parsed.value.name.trim() : '';
  if (!email || email.length > 320 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: 'Enter a valid assistant email.' }, 400);
  }
  if (name.length > 100) return json({ error: 'Name must be 100 characters or fewer.' }, 400);
  if (email === OWNER_EMAIL) return json({ error: 'The owner account cannot be added as an editor.' }, 409);

  const existing = await env.DB.prepare('SELECT email FROM staff_users WHERE lower(email) = lower(?)').bind(email).first();
  if (existing) return json({ error: 'This email already has staff access.' }, 409);
  const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM staff_users WHERE lower(email) <> lower(?)')
    .bind(OWNER_EMAIL).first();
  if (Number(count?.c || 0) >= 3) return json({ error: 'The maximum of three assistant editors has been reached.' }, 409);

  try {
    await env.DB.prepare('INSERT INTO staff_users (email, name, created, role) VALUES (?, ?, ?, ?)')
      .bind(email, name, Date.now(), 'editor').run();
  } catch (error) {
    const message = String(error?.message || error);
    if (/maximum of three assistant editors|UNIQUE constraint/i.test(message)) {
      return json({ error: 'The maximum of three assistant editors has been reached.' }, 409);
    }
    throw error;
  }
  return json({ ok: true, editor: { email, name, role: 'editor' } }, 201);
}

async function removeAssistantEditor(emailValue, env) {
  const email = normalizedEmail(emailValue);
  if (!email || email === OWNER_EMAIL) return json({ error: 'The owner account cannot be removed.' }, 400);
  const user = await env.DB.prepare('SELECT email FROM staff_users WHERE lower(email) = lower(?)').bind(email).first();
  if (!user) return json({ error: 'Assistant editor not found.' }, 404);
  await env.DB.prepare('DELETE FROM staff_sessions WHERE lower(email) = lower(?)').bind(email).run();
  await env.DB.prepare('DELETE FROM staff_users WHERE lower(email) = lower(?) AND lower(email) <> lower(?)')
    .bind(email, OWNER_EMAIL).run();
  return json({ ok: true });
}

async function updateListingAvailability(request, env, listingId) {
  const parsed = await readStaffAuthBody(request);
  if (parsed.error === 'too_large') return json({ error: 'Request too large.' }, 413);
  if (parsed.error) return json({ error: 'Invalid request.' }, 400);
  const status = parsed.value?.status;
  if (!['available', 'hidden', 'sold'].includes(status)) {
    return json({ error: 'Status must be available, hidden, or sold.' }, 400);
  }
  const listing = await env.DB.prepare('SELECT id FROM listings WHERE id = ?').bind(listingId).first();
  if (!listing) return json({ error: 'Listing not found.' }, 404);
  await env.DB.prepare('UPDATE listings SET status = ?, updated_at = ? WHERE id = ?')
    .bind(status, Date.now(), listingId).run();
  return json({ ok: true, id: listingId, status });
}

/* ---------- API router ---------- */
async function handleApi(request, env, url, ctx) {
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
    const storedMime = row.mime || 'image/webp';
    const safeMime = SAFE_IMAGE_MIMES.has(storedMime) ? storedMime : '';
    const headers = {
      'Content-Type': safeMime || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=31536000, immutable',
    };
    if (!safeMime) headers['Content-Disposition'] = 'attachment; filename="listing-photo.bin"';
    return new Response(bytes, { headers });
  }

  /* ---- staff sign-in: email one-time code ---- */
  if (p === '/api/staff/login' && method === 'POST') {
    return requestStaffOtp(request, env, ctx);
  }
  if (p === '/api/staff/verify' && method === 'POST') {
    return verifyStaffOtp(request, env);
  }
  if (p === '/api/staff/logout' && method === 'POST') {
    if (!sameOrigin(request)) return json({ ok: false, error: 'Sign-out request rejected.' }, 403);
    const token = staffCookieToken(request);
    if (token) await env.DB.prepare('DELETE FROM staff_sessions WHERE token = ?').bind(token).run();
    return json({ ok: true }, 200, { 'Set-Cookie': staffCookie('', 0) });
  }
  if (p === '/api/staff/me' && method === 'GET') {
    const user = await staffSessionUser(env, staffCookieToken(request));
    if (user) return json({ ok: true, ...user });
    return json({ ok: false, error: 'not signed in' }, 401);
  }
  /* ---- admin ---- */
  if (p.startsWith('/api/admin/')) {
    const auth = await authOk(request, env);
    if (auth === 'blocked') return json({ error: 'too many attempts, try again later' }, 429);
    if (auth === 'csrf') return json({ error: 'cross-origin request blocked' }, 403);
    if (!auth) return json({ error: 'unauthorized' }, 401);

    if (p === '/api/admin/staff' && method === 'GET') {
      if (!isOwnerAccountSession(auth)) return json({ error: 'owner account required' }, 403);
      const editors = await getAssistantEditors(env);
      return json({ editors, maxEditors: 3 });
    }
    if (p === '/api/admin/staff' && method === 'POST') {
      if (!isOwnerAccountSession(auth)) return json({ error: 'owner account required' }, 403);
      return addAssistantEditor(request, env);
    }
    const removeEditor = p.match(/^\/api\/admin\/staff\/([^/]+)$/);
    if (removeEditor && method === 'DELETE') {
      if (!isOwnerAccountSession(auth)) return json({ error: 'owner account required' }, 403);
      let email;
      try { email = decodeURIComponent(removeEditor[1]); } catch (e) { return json({ error: 'Invalid email.' }, 400); }
      return removeAssistantEditor(email, env);
    }

    if (p === '/api/admin/listings' && method === 'GET') {
      const listings = await listListings(env, { all: true });
      if (auth.role === 'admin') return json(listings);
      // Editors need enough context to identify a listing, not its price, photos, or full details.
      return json(listings.map(({ id, ref, title, loc, kind, status }) => ({ id, ref, title, loc, kind, status })));
    }

    const statusUpdate = p.match(/^\/api\/admin\/listings\/([A-Za-z0-9-]+)\/status$/);
    if (statusUpdate && method === 'PATCH') {
      return updateListingAvailability(request, env, statusUpdate[1]);
    }

    if (p === '/api/admin/listings' && (method === 'POST' || method === 'PUT')) {
      if (auth.role !== 'admin') return json({ error: 'editor accounts may only update listing availability' }, 403);
      return saveListing(request, env);
    }

    const del = p.match(/^\/api\/admin\/listings\/([A-Za-z0-9-]+)$/);
    if (del && method === 'DELETE') {
      if (auth.role !== 'admin') return json({ error: 'editor accounts may only update listing availability' }, 403);
      await env.DB.prepare('DELETE FROM photos WHERE listing_id = ?').bind(del[1]).run();
      await env.DB.prepare('DELETE FROM listings WHERE id = ?').bind(del[1]).run();
      return json({ ok: true });
    }

    if (p === '/api/admin/stats' && method === 'GET') {
      if (auth.role !== 'admin') return json({ error: 'admin access required' }, 403);
      const l = await env.DB.prepare('SELECT COUNT(*) AS c FROM listings').first();
      const ph = await env.DB.prepare('SELECT COUNT(*) AS c FROM photos').first();
      return json({ listings: l.c, photos: ph.c });
    }
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url, ctx);
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
