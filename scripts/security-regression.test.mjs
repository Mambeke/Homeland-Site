import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { escapeHTML, escapeAttr, safeImageURL } = require('../public/security.js');
const workerSource = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');
const workerUrl = `data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`;
const { default: worker } = await import(workerUrl);

function fakeD1() {
  const users = new Map([
    ['brandonmambeke@gmail.com', { email: 'brandonmambeke@gmail.com', name: 'Owner', created: 1, role: 'admin' }],
  ]);
  const sessions = new Map();
  const challenges = new Map();
  const rateLimits = new Map();
  const photos = new Map();
  const listings = new Map();
  const mutations = [];
  const execs = [];
  return {
    users, sessions, challenges, rateLimits, photos, listings, mutations, execs,
    async exec(sql) { execs.push(sql); return { success: true }; },
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async run() {
          mutations.push(sql);
          if (sql.startsWith('INSERT OR IGNORE INTO staff_users')) {
            const [email, name, created, role] = args;
            if (!users.has(String(email).toLowerCase())) users.set(String(email).toLowerCase(), { email, name, created, role });
          } else if (sql.startsWith('UPDATE staff_users SET role = ?')) {
            const [role, email] = args;
            const row = users.get(String(email).toLowerCase());
            if (row) row.role = role;
          } else if (sql.startsWith('INSERT INTO staff_users')) {
            const [email, name, created, role] = args;
            users.set(String(email).toLowerCase(), { email, name, created, role });
          } else if (sql.startsWith('DELETE FROM staff_sessions WHERE lower(email) = lower(?)')) {
            const email = String(args[0]).toLowerCase();
            for (const [token, session] of sessions) if (session.email.toLowerCase() === email) sessions.delete(token);
          } else if (sql.startsWith('DELETE FROM staff_users WHERE lower(email) = lower(?)')) {
            const email = String(args[0]).toLowerCase();
            if (email !== String(args[1]).toLowerCase()) users.delete(email);
          } else if (sql.startsWith('UPDATE listings SET status = ?, updated_at = ? WHERE id = ?')) {
            const [status, updated_at, id] = args;
            const row = listings.get(id);
            if (row) { row.status = status; row.updated_at = updated_at; }
          } else if (sql.startsWith('UPDATE listings SET ref=')) {
            const [ref, title, loc, province, price, kind, cat, ptype, beds, baths, size, desc, note, amenities, specs, status, verified, updated_at, id] = args;
            const row = listings.get(id);
            if (row) Object.assign(row, { ref, title, loc, province, price, kind, cat, ptype, beds, baths, size, desc, note, amenities, specs, status, verified, updated_at });
          } else if (sql === 'DELETE FROM photos WHERE listing_id = ?') {
            for (const [photoId, photo] of photos) if (photo.listing_id === args[0]) photos.delete(photoId);
          } else if (sql === 'DELETE FROM listings WHERE id = ?') {
            listings.delete(args[0]);
          } else if (sql.startsWith('INSERT INTO listings')) {
            const [id, ref, title, loc, province, price, kind, cat, ptype, beds, baths, size, desc, note, amenities, specs, status, verified, created_at, updated_at] = args;
            listings.set(id, { id, ref, title, loc, province, price, kind, cat, ptype, beds, baths, size, desc, note, amenities, specs, status, verified, created_at, updated_at });
          } else if (sql.startsWith('INSERT INTO photos')) {
            const [id, listing_id, url, mime, data, pos] = args;
            photos.set(id, { id, listing_id, url, mime, data, pos });
          } else if (sql.startsWith('INSERT INTO staff_login_challenges')) {
            const [email, challenge_id, code_hash, created, expires, last_sent] = args;
            challenges.set(email, { email, challenge_id, code_hash, created, expires, last_sent, attempts: 0 });
          } else if (sql.startsWith('INSERT INTO staff_sessions')) {
            const [token, email, created, expires] = args;
            sessions.set(token, { token, email, created, expires });
          } else if (sql.startsWith('DELETE FROM staff_sessions WHERE token = ?')) {
            sessions.delete(args[0]);
          } else if (sql.startsWith('DELETE FROM staff_sessions WHERE expires < ?')) {
            for (const [token, session] of sessions) if (session.expires < args[0]) sessions.delete(token);
          } else if (sql.startsWith('DELETE FROM staff_login_challenges WHERE expires < ?')) {
            for (const [email, challenge] of challenges) if (challenge.expires < args[0]) challenges.delete(email);
          } else if (sql.startsWith('DELETE FROM staff_login_challenges WHERE email = ? AND challenge_id = ?')) {
            const [email, challengeId] = args;
            if (challenges.get(email)?.challenge_id === challengeId) challenges.delete(email);
          } else if (sql.startsWith('DELETE FROM staff_otp_rate_limits WHERE window_start < ?')) {
            for (const [key, row] of rateLimits) if (row.window_start < args[0]) rateLimits.delete(key);
          }
          return { success: true, meta: { changes: 1 } };
        },
        async first() {
          if (sql.startsWith('INSERT INTO staff_otp_rate_limits')) {
            const [rateKey, windowStart] = args;
            const key = `${rateKey}:${windowStart}`;
            const row = rateLimits.get(key) || { rate_key: rateKey, window_start: windowStart, count: 0 };
            row.count += 1;
            rateLimits.set(key, row);
            return { count: row.count };
          }
          if (sql.startsWith('UPDATE staff_login_challenges SET attempts')) {
            const [email, challengeId, now, maxAttempts] = args;
            const row = challenges.get(email);
            if (!row || row.challenge_id !== challengeId || row.expires <= now || row.attempts >= maxAttempts) return null;
            row.attempts += 1;
            return { attempts: row.attempts };
          }
          if (sql.startsWith('DELETE FROM staff_login_challenges') && sql.includes('RETURNING email')) {
            const [email, challengeId, codeHash, now] = args;
            const row = challenges.get(email);
            if (!row || row.challenge_id !== challengeId || row.code_hash !== codeHash || row.expires <= now) return null;
            challenges.delete(email);
            return { email };
          }
          if (sql.includes('FROM staff_users WHERE lower(email) = lower(?)')) {
            return users.get(String(args[0] || '').toLowerCase()) || null;
          }
          if (sql.startsWith('SELECT * FROM staff_sessions WHERE token = ?')) return sessions.get(args[0]) || null;
          if (sql.startsWith('SELECT email FROM staff_sessions WHERE token = ?')) {
            const row = sessions.get(args[0]);
            return row ? { email: row.email } : null;
          }
          if (sql.startsWith('SELECT * FROM staff_login_challenges WHERE email = ?')) return challenges.get(args[0]) || null;
          if (sql.startsWith('SELECT mime, data FROM photos WHERE id = ?')) return photos.get(args[0]) || null;
          if (sql.startsWith('SELECT id FROM listings WHERE id = ?')) return listings.has(args[0]) ? { id: args[0] } : null;
          if (sql.startsWith('SELECT COUNT(*) AS c FROM staff_users WHERE lower(email) <> lower(?)')) {
            return { c: [...users.keys()].filter((email) => email !== String(args[0]).toLowerCase()).length };
          }
          if (sql.startsWith('SELECT COUNT(*) AS c FROM listings')) return { c: listings.size };
          if (sql.startsWith('SELECT COUNT(*) AS c FROM photos WHERE listing_id = ?')) return { c: [...photos.values()].filter((photo) => photo.listing_id === args[0]).length };
          if (sql.startsWith('SELECT COUNT(*) AS c FROM photos')) return { c: photos.size };
          return null;
        },
        async all() {
          if (sql.startsWith('SELECT email, name, created FROM staff_users WHERE lower(email) <> lower(?)')) {
            const owner = String(args[0]).toLowerCase();
            return { results: [...users.values()].filter((user) => user.email.toLowerCase() !== owner).map(({ email, name, created }) => ({ email, name, created })) };
          }
          if (sql.startsWith('SELECT * FROM listings WHERE id = ?')) return { results: listings.has(args[0]) ? [listings.get(args[0])] : [] };
          if (sql.startsWith('SELECT id, listing_id, url, mime FROM photos WHERE listing_id IN')) {
            const ids = new Set(args);
            return { results: [...photos.values()].filter((photo) => ids.has(photo.listing_id)).map(({ id, listing_id, url, mime }) => ({ id, listing_id, url, mime })) };
          }
          if (sql.startsWith('SELECT * FROM listings')) return { results: [...listings.values()] };
          return { results: [] };
        },
      };
    },
  };
}

function makeRequest(path, { method = 'GET', body, headers = {} } = {}) {
  return new Request(`https://homeland.test${path}`, { method, body, headers });
}

function authHeaders(ip = '198.51.100.1') {
  return {
    origin: 'https://homeland.test',
    'content-type': 'application/json',
    'cf-connecting-ip': ip,
  };
}

async function invoke(env, path, options = {}) {
  const waitUntilJobs = [];
  const response = await worker.fetch(makeRequest(path, options), env, {
    waitUntil(promise) { waitUntilJobs.push(promise); },
  });
  await Promise.all(waitUntilJobs);
  return response;
}

function testEnv(db = fakeD1()) {
  return {
    DB: db,
    RESEND_API_KEY: 're_test_key_not_real',
    STAFF_AUTH_FROM: 'Homeland Staff <staff-auth@example.test>',
    STAFF_OTP_SECRET: 'test-only-secret-with-at-least-32-characters',
  };
}

function otpRequest(email, ip) {
  return {
    method: 'POST',
    body: JSON.stringify({ email }),
    headers: authHeaders(ip),
  };
}

function otpVerify(email, code, ip) {
  return {
    method: 'POST',
    body: JSON.stringify({ email, code }),
    headers: authHeaders(ip),
  };
}

function codeFromEmail(email) {
  const match = email.text.match(/\b(\d{6})\b/);
  assert.ok(match, 'email includes a six-digit code');
  return match[1];
}

test('HTML encoding and image URL validation reject common injection payloads', () => {
  assert.equal(escapeHTML(`<img src=x onerror='alert(1)'>&`), '&lt;img src=x onerror=&#39;alert(1)&#39;&gt;&amp;');
  assert.equal(escapeAttr('" autofocus onfocus="alert(1)'), '&quot; autofocus onfocus=&quot;alert(1)');
  assert.equal(safeImageURL('/api/media/550e8400-e29b-41d4-a716-446655440000'), '/api/media/550e8400-e29b-41d4-a716-446655440000');
  assert.equal(safeImageURL('javascript:alert(1)'), '');
  assert.equal(safeImageURL('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(safeImageURL('//attacker.example/p.png'), '');
});

test('media serving and upload validation block active-content image payloads', async () => {
  const db = fakeD1();
  db.photos.set('photo-raster', { mime: 'image/png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) });
  db.photos.set('photo-active', { mime: 'image/svg+xml', data: new TextEncoder().encode('<svg><script>alert(1)</script></svg>') });
  const env = { DB: db, ADMIN_PASS: 'media-test-automation-key' };

  const raster = await invoke(env, '/api/media/photo-raster');
  assert.ok(db.execs.some((sql) => sql.includes('CREATE TRIGGER IF NOT EXISTS staff_editor_limit')));
  assert.ok(db.execs.some((sql) => sql.startsWith('ALTER TABLE staff_users ADD COLUMN role')));
  assert.equal(raster.status, 200);
  assert.equal(raster.headers.get('content-type'), 'image/png');
  assert.equal(raster.headers.get('x-content-type-options'), 'nosniff');

  const active = await invoke(env, '/api/media/photo-active');
  assert.equal(active.status, 200);
  assert.equal(active.headers.get('content-type'), 'application/octet-stream');
  assert.match(active.headers.get('content-disposition'), /attachment/);
  assert.equal(active.headers.get('x-content-type-options'), 'nosniff');

  const form = new FormData();
  form.append('title', 'XSS regression fixture');
  form.append('loc', 'Harare');
  form.append('price', '1');
  form.append('photo', new Blob(['<svg onload="alert(1)"></svg>'], { type: 'image/png' }), 'misleading.png');
  const rejected = await invoke(env, '/api/admin/listings', {
    method: 'POST', body: form, headers: { 'x-admin-key': env.ADMIN_PASS },
  });
  assert.equal(rejected.status, 400);
  assert.ok(!db.mutations.some((sql) => sql.startsWith('INSERT INTO listings')));

  const validForm = new FormData();
  validForm.append('title', 'Raster regression fixture');
  validForm.append('loc', 'Harare');
  validForm.append('price', '1');
  validForm.append('photo', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00])], { type: 'image/png' }), 'safe.png');
  const accepted = await invoke(env, '/api/admin/listings', {
    method: 'POST', body: validForm, headers: { 'x-admin-key': env.ADMIN_PASS },
  });
  assert.equal(accepted.status, 201);
  const listing = (await accepted.json()).listing;
  assert.equal(listing.photos[0].mime, 'image/png');
  const savedPhoto = await invoke(env, listing.photos[0].url);
  assert.equal(savedPhoto.status, 200);
  assert.equal(savedPhoto.headers.get('content-type'), 'image/png');
});

test('OTP is sent only to allowlisted inboxes and unknown addresses get the same public response', async (t) => {
  const db = fakeD1();
  const env = testEnv(db);
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(options.headers.Authorization, `Bearer ${env.RESEND_API_KEY}`);
    const message = JSON.parse(options.body);
    sent.push(message);
    return new Response(JSON.stringify({ id: `mail-${sent.length}` }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const blockedOrigin = await invoke(env, '/api/staff/login', {
    method: 'POST', body: JSON.stringify({ email: 'brandonmambeke@gmail.com' }),
    headers: { 'content-type': 'application/json', origin: 'https://attacker.example', 'cf-connecting-ip': '198.51.100.99' },
  });
  assert.equal(blockedOrigin.status, 403);
  assert.equal(sent.length, 0);

  const allowed = await invoke(env, '/api/staff/login', otpRequest('brandonmambeke@gmail.com', '198.51.100.1'));
  const allowedBody = await allowed.json();
  assert.equal(allowed.status, 202);
  assert.equal(allowedBody.ok, true);
  assert.match(allowedBody.message, /If this email has staff access/);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['brandonmambeke@gmail.com']);
  assert.equal(sent[0].from, env.STAFF_AUTH_FROM);
  assert.match(sent[0].text, /expires in 10 minutes/);
  const code = codeFromEmail(sent[0]);
  const challenge = db.challenges.get('brandonmambeke@gmail.com');
  assert.ok(challenge);
  assert.equal(challenge.code_hash.length, 64);
  assert.notEqual(challenge.code_hash, code);
  assert.equal(db.sessions.size, 0);

  const unknown = await invoke(env, '/api/staff/login', otpRequest('not-staff@example.test', '198.51.100.2'));
  assert.equal(unknown.status, allowed.status);
  assert.deepEqual(await unknown.json(), allowedBody);
  assert.equal(sent.length, 1);
  assert.equal(db.challenges.size, 1);
});

test('OTP verification is one-time, creates a secure session, enforces CSRF, and logout revokes it', async (t) => {
  const db = fakeD1();
  const env = testEnv(db);
  let sent;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails');
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: 'mail-1' }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const codeRequest = await invoke(env, '/api/staff/login', otpRequest('brandonmambeke@gmail.com', '198.51.100.10'));
  assert.equal(codeRequest.status, 202);
  const code = codeFromEmail(sent);
  const crossOrigin = await invoke(env, '/api/staff/verify', {
    method: 'POST', body: JSON.stringify({ email: 'brandonmambeke@gmail.com', code }),
    headers: { 'content-type': 'application/json', origin: 'https://attacker.example', 'cf-connecting-ip': '198.51.100.11' },
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(db.challenges.size, 1);

  const verified = await invoke(env, '/api/staff/verify', otpVerify('BRANDONMAMBEKE@gmail.com', code, '198.51.100.12'));
  assert.equal(verified.status, 200);
  const verifyBody = await verified.json();
  assert.deepEqual(Object.keys(verifyBody).sort(), ['email', 'name', 'ok', 'role']);
  assert.equal(verifyBody.role, 'admin');
  const setCookie = verified.headers.get('set-cookie');
  assert.match(setCookie, /__Host-hp_staff_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Max-Age=43200/);
  const cookiePair = setCookie.split(';')[0];
  assert.equal(db.sessions.size, 1);
  assert.equal(db.challenges.size, 0);

  const me = await invoke(env, '/api/staff/me', { headers: { cookie: cookiePair } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).email, 'brandonmambeke@gmail.com');
  const adminListings = await invoke(env, '/api/admin/listings', { headers: { cookie: cookiePair } });
  assert.equal(adminListings.status, 200);
  assert.deepEqual(await adminListings.json(), []);

  const replay = await invoke(env, '/api/staff/verify', otpVerify('brandonmambeke@gmail.com', code, '198.51.100.13'));
  assert.equal(replay.status, 401);
  assert.deepEqual(await replay.json(), { ok: false, error: 'Invalid or expired verification code.' });

  const csrfWrite = await invoke(env, '/api/admin/listings', {
    method: 'POST', body: new URLSearchParams(),
    headers: { cookie: cookiePair, origin: 'https://attacker.example', 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(csrfWrite.status, 403);

  const logout = await invoke(env, '/api/staff/logout', {
    method: 'POST', headers: { cookie: cookiePair, origin: 'https://homeland.test' },
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(db.sessions.size, 0);
  const afterLogout = await invoke(env, '/api/staff/me', { headers: { cookie: cookiePair } });
  assert.equal(afterLogout.status, 401);
});

test('OTP cooldown, attempt caps, and persistent rate limits are enforced', async (t) => {
  const db = fakeD1();
  const env = testEnv(db);
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ id: `mail-${sent.length}` }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await invoke(env, '/api/staff/login', otpRequest('brandonmambeke@gmail.com', '198.51.100.20'));
  const code = codeFromEmail(sent[0]);
  const firstChallenge = db.challenges.get('brandonmambeke@gmail.com').challenge_id;
  await invoke(env, '/api/staff/login', otpRequest('brandonmambeke@gmail.com', '198.51.100.21'));
  assert.equal(sent.length, 1, 'resend cooldown suppresses extra email');
  assert.equal(db.challenges.get('brandonmambeke@gmail.com').challenge_id, firstChallenge);

  for (let i = 0; i < 5; i++) {
    const wrong = await invoke(env, '/api/staff/verify', otpVerify('brandonmambeke@gmail.com', '000000', `198.51.100.${30 + i}`));
    assert.equal(wrong.status, 401);
  }
  assert.equal(db.challenges.get('brandonmambeke@gmail.com').attempts, 5);
  const rightAfterLimit = await invoke(env, '/api/staff/verify', otpVerify('brandonmambeke@gmail.com', code, '198.51.100.40'));
  assert.equal(rightAfterLimit.status, 401);
  assert.equal(db.sessions.size, 0);

  const limitedDb = fakeD1();
  const limitedEnv = testEnv(limitedDb);
  for (let i = 0; i < 10; i++) {
    const response = await invoke(limitedEnv, '/api/staff/login', otpRequest(`unknown${i}@example.test`, '203.0.113.77'));
    assert.equal(response.status, 202);
  }
  const limited = await invoke(limitedEnv, '/api/staff/login', otpRequest('other@example.test', '203.0.113.77'));
  assert.equal(limited.status, 429);
});

test('expired codes and failed email delivery never create an authenticated session', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  globalThis.fetch = async () => new Response('{"error":"sender not verified"}', { status: 403 });
  console.error = () => {};
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  });

  const failedDeliveryDb = fakeD1();
  const failedDeliveryEnv = testEnv(failedDeliveryDb);
  const failedDelivery = await invoke(failedDeliveryEnv, '/api/staff/login', otpRequest('brandonmambeke@gmail.com', '192.0.2.70'));
  assert.equal(failedDelivery.status, 202, 'public response stays generic');
  assert.equal(failedDeliveryDb.challenges.size, 0, 'undelivered code challenge is removed');
  assert.equal(failedDeliveryDb.sessions.size, 0);

  globalThis.fetch = async () => new Response('{"id":"mail-expiry"}', { status: 200 });
  const expiredDb = fakeD1();
  const expiredEnv = testEnv(expiredDb);
  const sent = await invoke(expiredEnv, '/api/staff/login', otpRequest('brandonmambeke@gmail.com', '192.0.2.71'));
  assert.equal(sent.status, 202);
  const challenge = expiredDb.challenges.get('brandonmambeke@gmail.com');
  const code = '123456'; // The expired challenge is rejected regardless of the submitted value.
  challenge.expires = Date.now() - 1;
  const rejected = await invoke(expiredEnv, '/api/staff/verify', otpVerify('brandonmambeke@gmail.com', code, '192.0.2.72'));
  assert.equal(rejected.status, 401);
  assert.equal(expiredDb.sessions.size, 0);
});

test('Brandon is the sole admin; up to three editors can change only listing availability', async (t) => {
  const db = fakeD1();
  const env = testEnv(db);
  env.ADMIN_PASS = 'owner-automation-key';
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ id: `mail-${sent.length}` }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const ownerCodeRequest = await invoke(env, '/api/staff/login', otpRequest('brandonmambeke@gmail.com', '203.0.113.49'));
  assert.equal(ownerCodeRequest.status, 202);
  const ownerVerify = await invoke(env, '/api/staff/verify', otpVerify('brandonmambeke@gmail.com', codeFromEmail(sent[0]), '203.0.113.50'));
  assert.equal(ownerVerify.status, 200);
  assert.equal((await ownerVerify.json()).role, 'admin');
  const ownerCookie = ownerVerify.headers.get('set-cookie').split(';')[0];
  const ownerHeaders = { cookie: ownerCookie, origin: 'https://homeland.test', 'content-type': 'application/json' };

  const automationCannotManageStaff = await invoke(env, '/api/admin/staff', {
    method: 'POST', body: JSON.stringify({ email: 'machine-added@example.test' }),
    headers: { 'x-admin-key': env.ADMIN_PASS, 'content-type': 'application/json' },
  });
  assert.equal(automationCannotManageStaff.status, 403, 'only Brandon’s verified mailbox can manage assistant access');

  for (let i = 1; i <= 3; i++) {
    const added = await invoke(env, '/api/admin/staff', {
      method: 'POST', body: JSON.stringify({ email: `assistant${i}@example.test`, name: `Assistant ${i}`, role: 'admin' }),
      headers: ownerHeaders,
    });
    assert.equal(added.status, 201);
    assert.equal(db.users.get(`assistant${i}@example.test`).role, 'editor', 'client cannot choose a role');
  }
  const fourth = await invoke(env, '/api/admin/staff', {
    method: 'POST', body: JSON.stringify({ email: 'assistant4@example.test' }), headers: ownerHeaders,
  });
  assert.equal(fourth.status, 409);
  const staffList = await invoke(env, '/api/admin/staff', { headers: { cookie: ownerCookie } });
  assert.equal((await staffList.json()).editors.length, 3);

  const ownerWriteHeaders = { cookie: ownerCookie, origin: 'https://homeland.test' };
  const createForm = new FormData();
  createForm.append('title', 'Owner-created home');
  createForm.append('loc', 'Harare');
  createForm.append('price', '125000');
  const ownerCreate = await invoke(env, '/api/admin/listings', { method: 'POST', body: createForm, headers: ownerWriteHeaders });
  assert.equal(ownerCreate.status, 201);
  const ownerListing = (await ownerCreate.json()).listing;
  assert.equal(ownerListing.title, 'Owner-created home');
  assert.equal(ownerListing.price, 125000);

  const updateForm = new FormData();
  updateForm.append('id', ownerListing.id);
  updateForm.append('title', 'Owner-edited home');
  updateForm.append('loc', 'Harare');
  updateForm.append('price', '130000');
  updateForm.append('desc', 'Owner may update listing details.');
  const ownerUpdate = await invoke(env, '/api/admin/listings', { method: 'PUT', body: updateForm, headers: ownerWriteHeaders });
  assert.equal(ownerUpdate.status, 201);
  assert.equal(db.listings.get(ownerListing.id).title, 'Owner-edited home');
  assert.equal(db.listings.get(ownerListing.id).price, 130000);

  const ownerDelete = await invoke(env, `/api/admin/listings/${ownerListing.id}`, { method: 'DELETE', headers: ownerWriteHeaders });
  assert.equal(ownerDelete.status, 200);
  assert.equal(db.listings.has(ownerListing.id), false);

  const listingId = 'property-001';
  db.listings.set(listingId, {
    id: listingId, ref: 'HPG-1', title: 'Owner-listed home', loc: 'Harare', province: 'Harare', price: 100000,
    kind: 'sale', cat: 'Houses', ptype: 'Houses', beds: 3, baths: 2, size: '300 m²', desc: '', note: '',
    amenities: '[]', specs: '{}', status: 'hidden', verified: '', created_at: 1, updated_at: 1,
  });
  db.photos.set('photo-editor-protected', {
    id: 'photo-editor-protected', listing_id: listingId, url: '/api/media/photo-editor-protected', mime: 'image/png',
    data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), pos: 0,
  });

  const requested = await invoke(env, '/api/staff/login', otpRequest('assistant1@example.test', '203.0.113.51')); 
  assert.equal(requested.status, 202);
  assert.deepEqual(sent[1].to, ['assistant1@example.test']);
  const verified = await invoke(env, '/api/staff/verify', otpVerify('assistant1@example.test', codeFromEmail(sent[1]), '203.0.113.52'));
  assert.equal(verified.status, 200);
  const editorLogin = await verified.json();
  assert.equal(editorLogin.role, 'editor');
  const editorCookie = verified.headers.get('set-cookie').split(';')[0];
  const me = await invoke(env, '/api/staff/me', { headers: { cookie: editorCookie } });
  assert.equal((await me.json()).role, 'editor');

  const visibleListings = await invoke(env, '/api/admin/listings', { headers: { cookie: editorCookie } });
  assert.equal(visibleListings.status, 200);
  const editorRows = await visibleListings.json();
  assert.equal(editorRows.length, 1);
  assert.deepEqual(Object.keys(editorRows[0]).sort(), ['id', 'kind', 'loc', 'ref', 'status', 'title']);
  const patched = await invoke(env, `/api/admin/listings/${listingId}/status`, {
    method: 'PATCH', body: JSON.stringify({ status: 'available', title: 'forged title', price: 1 }),
    headers: { cookie: editorCookie, origin: 'https://homeland.test', 'content-type': 'application/json' },
  });
  assert.equal(patched.status, 200);
  assert.equal(db.listings.get(listingId).status, 'available');
  assert.equal(db.listings.get(listingId).title, 'Owner-listed home');
  assert.equal(db.listings.get(listingId).price, 100000);
  assert.equal(db.photos.has('photo-editor-protected'), true, 'status changes leave listing photos untouched');

  for (const status of ['sold', 'hidden']) {
    const result = await invoke(env, `/api/admin/listings/${listingId}/status`, {
      method: 'PATCH', body: JSON.stringify({ status, desc: 'forged description', photos: [] }),
      headers: { cookie: editorCookie, origin: 'https://homeland.test', 'content-type': 'application/json' },
    });
    assert.equal(result.status, 200);
    assert.equal(db.listings.get(listingId).status, status);
    assert.equal(db.listings.get(listingId).desc, '');
    assert.equal(db.photos.has('photo-editor-protected'), true);
  }

  const editForm = new FormData();
  editForm.append('id', listingId);
  editForm.append('title', 'Forged editor title');
  editForm.append('price', '1');
  editForm.append('_clear_photos', '1');
  editForm.append('photo', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])], { type: 'image/png' }), 'forged.png');
  const mutationsBeforeForbiddenPut = db.mutations.length;
  const forbiddenPut = await invoke(env, '/api/admin/listings', {
    method: 'PUT', body: editForm,
    headers: { cookie: editorCookie, origin: 'https://homeland.test' },
  });
  assert.equal(forbiddenPut.status, 403);
  assert.equal(db.mutations.length, mutationsBeforeForbiddenPut, 'editor PUT does not perform any database writes');
  assert.equal(db.listings.get(listingId).title, 'Owner-listed home');
  assert.equal(db.listings.get(listingId).price, 100000);
  assert.equal(db.photos.has('photo-editor-protected'), true, 'editor cannot clear or replace photos');

  const invalidStatus = await invoke(env, `/api/admin/listings/${listingId}/status`, {
    method: 'PATCH', body: JSON.stringify({ status: 'delete' }),
    headers: { cookie: editorCookie, origin: 'https://homeland.test', 'content-type': 'application/json' },
  });
  assert.equal(invalidStatus.status, 400);
  const crossOrigin = await invoke(env, `/api/admin/listings/${listingId}/status`, {
    method: 'PATCH', body: JSON.stringify({ status: 'sold' }),
    headers: { cookie: editorCookie, origin: 'https://attacker.example', 'content-type': 'application/json' },
  });
  assert.equal(crossOrigin.status, 403);

  const forbiddenPost = await invoke(env, '/api/admin/listings', {
    method: 'POST', body: '{}', headers: { cookie: editorCookie, origin: 'https://homeland.test', 'content-type': 'application/json' },
  });
  assert.equal(forbiddenPost.status, 403);
  const forbiddenDelete = await invoke(env, `/api/admin/listings/${listingId}`, {
    method: 'DELETE', headers: { cookie: editorCookie, origin: 'https://homeland.test' },
  });
  assert.equal(forbiddenDelete.status, 403);
  const forbiddenStaffRead = await invoke(env, '/api/admin/staff', { headers: { cookie: editorCookie } });
  assert.equal(forbiddenStaffRead.status, 403);
  const forbiddenStats = await invoke(env, '/api/admin/stats', { headers: { cookie: editorCookie } });
  assert.equal(forbiddenStats.status, 403);
  const forbiddenStaffAdd = await invoke(env, '/api/admin/staff', {
    method: 'POST', body: JSON.stringify({ email: 'extra@example.test' }),
    headers: { cookie: editorCookie, origin: 'https://homeland.test', 'content-type': 'application/json' },
  });
  assert.equal(forbiddenStaffAdd.status, 403);

  const removed = await invoke(env, '/api/admin/staff/assistant1%40example.test', {
    method: 'DELETE', headers: { cookie: ownerCookie, origin: 'https://homeland.test' },
  });
  assert.equal(removed.status, 200);
  assert.equal(db.users.has('assistant1@example.test'), false);
  const revoked = await invoke(env, '/api/staff/me', { headers: { cookie: editorCookie } });
  assert.equal(revoked.status, 401);
  const ownerRemoval = await invoke(env, '/api/admin/staff/brandonmambeke%40gmail.com', {
    method: 'DELETE', headers: { cookie: ownerCookie, origin: 'https://homeland.test' },
  });
  assert.equal(ownerRemoval.status, 400);
  const replacementEditor = await invoke(env, '/api/admin/staff', {
    method: 'POST', body: JSON.stringify({ email: 'assistant4@example.test' }), headers: ownerHeaders,
  });
  assert.equal(replacementEditor.status, 201);
  assert.equal(db.users.get('assistant4@example.test').role, 'editor');
});

test('missing mail configuration fails closed; legacy browser tokens do not authenticate', async () => {
  const db = fakeD1();
  const env = testEnv(db);
  delete env.RESEND_API_KEY;
  const notConfigured = await invoke(env, '/api/staff/login', otpRequest('brandonmambeke@gmail.com', '198.51.100.60'));
  assert.equal(notConfigured.status, 503);
  assert.equal(db.challenges.size, 0);

  const legacy = await invoke(testEnv(db), '/api/staff/me', {
    headers: { 'x-staff-token': 'f'.repeat(36) },
  });
  assert.equal(legacy.status, 401);
});

test('admin API key remains server-side automation only; staff UI has no password or bearer token', async () => {
  const env = { DB: fakeD1(), ADMIN_PASS: 'automation-test-secret' };
  const response = await invoke(env, '/api/admin/listings', { headers: { 'x-admin-key': env.ADMIN_PASS } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);

  const admin = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
  const home = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const marketplace = await readFile(new URL('../public/marketplace.html', import.meta.url), 'utf8');
  for (const html of [admin, home, marketplace]) assert.match(html, /<script src="\/security\.js"><\/script>/);
  assert.doesNotMatch(admin, /password|sessionStorage|X-Staff-Token|hp_staff_token/i);
  assert.match(admin, /autocomplete="one-time-code"/);
  assert.match(admin, /id="email"[^>]*\brequired/);
  assert.match(admin, /method: 'PATCH'/);
  assert.match(admin, /\/status'/);
  assert.match(admin, /#addBtn'\)\.hidden = !isAdmin/);
  assert.match(admin, /if \(signedInRole !== 'admin'\) return;/);
  assert.match(admin, /fetch\('\/api\/staff\/verify'/);
  assert.match(home, /<h3>\$\{escapeHTML\(l\.title\)\}<\/h3>/);
  assert.match(marketplace, /<h3>\$\{escapeHTML\(l\.title\)\}<\/h3>/);
  assert.match(admin, /\$\{escapeHTML\(l\.title\)\}/);
});
