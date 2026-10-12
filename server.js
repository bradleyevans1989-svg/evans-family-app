// Evans Family app server: serves the app and keeps the family's shared data in Postgres.
// Without DATABASE_URL it falls back to a local JSON file, which is handy for trying it on a laptop.
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const MEMBERS = { brad: true, elle: true, ruby: false, ari: false, lola: false }; // id -> is a parent
const DEFAULT_PIN = { parent: "1234", kid: "0000" };
const COLLS = new Set(["events", "jobs", "ledger", "messages", "meals", "prep", "movies", "rewards", "games", "settings"]);
const SESSION_DAYS = 180;
const MAX_BODY = 300 * 1024;

// ---------- storage ----------
function deepMerge(a, b) {
  const o = { ...(a || {}) };
  for (const k of Object.keys(b)) {
    const v = b[k];
    o[k] = v && typeof v === "object" && !Array.isArray(v) && o[k] && typeof o[k] === "object" && !Array.isArray(o[k]) ? deepMerge(o[k], v) : v;
  }
  return o;
}

function hashPin(member, pin) {
  return crypto.createHash("sha256").update(`evans:${member}:${pin}`).digest("hex");
}

function pgStore(url) {
  const { Pool } = require("pg");
  // Render's internal database URL needs no SSL; its external URL (*.render.com) does.
  const pool = new Pool({ connectionString: url, ssl: /\.render\.com/.test(url) ? { rejectUnauthorized: false } : false, max: 5 });
  const q = (sql, args) => pool.query(sql, args);
  return {
    async init() {
      // Everything lives in its own "family" schema so it never touches other apps sharing this database.
      await q(`CREATE SCHEMA IF NOT EXISTS family`);
      await q(`CREATE TABLE IF NOT EXISTS family.docs (coll text NOT NULL, id text NOT NULL, data jsonb NOT NULL, updated bigint NOT NULL, PRIMARY KEY (coll, id))`);
      await q(`CREATE TABLE IF NOT EXISTS family.meta (k text PRIMARY KEY, v bigint NOT NULL)`);
      await q(`INSERT INTO family.meta (k, v) VALUES ('version', 1) ON CONFLICT DO NOTHING`);
      await q(`CREATE TABLE IF NOT EXISTS family.pins (member text PRIMARY KEY, hash text NOT NULL)`);
      await q(`CREATE TABLE IF NOT EXISTS family.sessions (token text PRIMARY KEY, member text NOT NULL, expires bigint NOT NULL)`);
    },
    async version() { return Number((await q(`SELECT v FROM family.meta WHERE k='version'`)).rows[0].v); },
    async all() { return (await q(`SELECT coll, id, data FROM family.docs`)).rows; },
    async write(op, coll, id, data) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        if (op === "delete") await c.query(`DELETE FROM family.docs WHERE coll=$1 AND id=$2`, [coll, id]);
        else {
          let body = data;
          if (op === "update") {
            const cur = await c.query(`SELECT data FROM family.docs WHERE coll=$1 AND id=$2 FOR UPDATE`, [coll, id]);
            if (!cur.rows.length) { await c.query("ROLLBACK"); return false; }
            body = deepMerge(cur.rows[0].data, data);
          }
          await c.query(`INSERT INTO family.docs (coll, id, data, updated) VALUES ($1,$2,$3,$4) ON CONFLICT (coll, id) DO UPDATE SET data=EXCLUDED.data, updated=EXCLUDED.updated`, [coll, id, body, Date.now()]);
        }
        await c.query(`UPDATE family.meta SET v = v + 1 WHERE k='version'`);
        await c.query("COMMIT");
        return true;
      } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
    },
    async getPin(member) { const r = await q(`SELECT hash FROM family.pins WHERE member=$1`, [member]); return r.rows[0] ? r.rows[0].hash : null; },
    async setPin(member, hash) { await q(`INSERT INTO family.pins (member, hash) VALUES ($1,$2) ON CONFLICT (member) DO UPDATE SET hash=EXCLUDED.hash`, [member, hash]); },
    async customPins() { return (await q(`SELECT member FROM family.pins`)).rows.map(r => r.member); },
    async addSession(token, member, expires) { await q(`INSERT INTO family.sessions (token, member, expires) VALUES ($1,$2,$3)`, [token, member, expires]); },
    async getSession(token) { const r = await q(`SELECT member, expires FROM family.sessions WHERE token=$1`, [token]); return r.rows[0] || null; },
    async dropSessions(member) { await q(`DELETE FROM family.sessions WHERE member=$1`, [member]); },
  };
}

function fileStore(file) {
  let db = { version: 1, docs: {}, pins: {}, sessions: {} };
  try { db = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const save = () => fs.writeFileSync(file, JSON.stringify(db));
  const key = (c, i) => `${c}/${i}`;
  return {
    async init() {},
    async version() { return db.version; },
    async all() { return Object.entries(db.docs).map(([k, data]) => { const i = k.indexOf("/"); return { coll: k.slice(0, i), id: k.slice(i + 1), data }; }); },
    async write(op, coll, id, data) {
      const k = key(coll, id);
      if (op === "delete") delete db.docs[k];
      else if (op === "update") { if (!db.docs[k]) return false; db.docs[k] = deepMerge(db.docs[k], data); }
      else db.docs[k] = data;
      db.version++; save(); return true;
    },
    async getPin(m) { return db.pins[m] || null; },
    async setPin(m, h) { db.pins[m] = h; save(); },
    async customPins() { return Object.keys(db.pins); },
    async addSession(t, m, e) { db.sessions[t] = { member: m, expires: e }; save(); },
    async getSession(t) { return db.sessions[t] || null; },
    async dropSessions(m) { for (const t of Object.keys(db.sessions)) if (db.sessions[t].member === m) delete db.sessions[t]; save(); },
  };
}

// On Render the disk is wiped on every deploy, so refuse to run without a real database.
if (process.env.RENDER && !process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Add the database's Internal Database URL in the Render dashboard (Environment tab).");
  process.exit(1);
}
const store = process.env.DATABASE_URL ? pgStore(process.env.DATABASE_URL) : fileStore(path.join(__dirname, "local-data.json"));

// ---------- PIN attempts: 5 wrong tries locks that person for 10 minutes ----------
const attempts = new Map();
function locked(member) { const a = attempts.get(member); return a && a.until > Date.now(); }
function failed(member) {
  const a = attempts.get(member) || { n: 0, until: 0 };
  a.n++; if (a.n >= 5) { a.until = Date.now() + 10 * 60 * 1000; a.n = 0; }
  attempts.set(member, a);
}

async function checkPin(member, pin) {
  const stored = await store.getPin(member);
  const want = stored || hashPin(member, MEMBERS[member] ? DEFAULT_PIN.parent : DEFAULT_PIN.kid);
  const got = hashPin(member, String(pin || ""));
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

// ---------- http helpers ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".jpg": "image/jpeg", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json" };
function send(res, code, body, headers = {}) {
  const isObj = typeof body === "object" && !Buffer.isBuffer(body);
  res.writeHead(code, { "Content-Type": isObj ? "application/json" : "text/plain", "Cache-Control": "no-store", ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error("too big"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(Object.assign(new Error("bad json"), { status: 400 })); } });
    req.on("error", reject);
  });
}
async function auth(req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return null;
  const s = await store.getSession(token);
  if (!s || s.expires < Date.now() || !(s.member in MEMBERS)) return null;
  return s.member;
}
const validSeg = s => typeof s === "string" && /^[A-Za-z0-9_\-.~:@+]{1,120}$/.test(s);

// ---------- routes ----------
async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/pins") return send(res, 200, { custom: await store.customPins() });
  if (req.method === "POST" && url.pathname === "/api/login") {
    const { member, pin } = await readBody(req);
    if (!(member in MEMBERS)) return send(res, 400, { error: "Unknown person" });
    if (locked(member)) return send(res, 429, { error: "Too many wrong tries. Wait 10 minutes and try again." });
    if (!(await checkPin(member, pin))) { failed(member); return send(res, 401, { error: "That PIN isn't right" }); }
    attempts.delete(member);
    const token = crypto.randomBytes(32).toString("hex");
    await store.addSession(token, member, Date.now() + SESSION_DAYS * 864e5);
    return send(res, 200, { token, member });
  }
  const me = await auth(req);
  if (!me) return send(res, 401, { error: "Please log in" });
  if (req.method === "GET" && url.pathname === "/api/sync") {
    const v = await store.version();
    if (String(v) === url.searchParams.get("v")) return send(res, 200, { v });
    return send(res, 200, { v, docs: await store.all() });
  }
  if (req.method === "POST" && url.pathname === "/api/write") {
    const { op, coll, id, data } = await readBody(req);
    if (!["set", "update", "delete"].includes(op) || !COLLS.has(coll) || !validSeg(id)) return send(res, 400, { error: "Bad write" });
    if (op !== "delete" && (!data || typeof data !== "object" || Array.isArray(data))) return send(res, 400, { error: "Bad data" });
    const ok = await store.write(op, coll, id, data);
    if (!ok) return send(res, 404, { error: "Not found" });
    return send(res, 200, { ok: true, v: await store.version() });
  }
  if (req.method === "POST" && url.pathname === "/api/pin") {
    const { member, pin } = await readBody(req);
    if (!(member in MEMBERS) || !/^\d{4}$/.test(String(pin))) return send(res, 400, { error: "Use 4 numbers" });
    if (member !== me && !MEMBERS[me]) return send(res, 403, { error: "Only Mum or Dad can change someone else's PIN" });
    await store.setPin(member, hashPin(member, String(pin)));
    if (member !== me) await store.dropSessions(member); // log them out everywhere after a reset
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: "Not found" });
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) return send(res, 403, "Forbidden");
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, "Not found");
    const ext = path.extname(file);
    res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream", "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=86400", "X-Content-Type-Options": "nosniff" });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/healthz") return send(res, 200, "ok");
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : "Something went wrong" });
  }
});

store.init().then(() => server.listen(PORT, () => console.log(`Evans Family app on :${PORT} (${process.env.DATABASE_URL ? "postgres" : "local file"})`)))
  .catch(e => { console.error("Could not start", e); process.exit(1); });
