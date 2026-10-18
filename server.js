// Family App server: serves the app and keeps each family's shared data in Postgres.
// Every family has one email and password. A phone logs in to its family once, then each person picks their name and PIN.
// New families can only join through an invite link made by a parent in the owner family.
// Without DATABASE_URL it falls back to a local JSON file, which is handy for trying it on a laptop.
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const DEFAULT_PIN = { parent: "1234", kid: "0000" }; // only used by the original family, whose people started without their own PINs
const COLLS = new Set(["events", "jobs", "ledger", "messages", "meals", "prep", "movies", "rewards", "games", "settings"]);
const COLORS = ["blue", "pink", "purple", "teal", "orange", "green", "red", "gold", "slate", "brown"];
const SESSION_DAYS = 180;
const DEVICE_DAYS = 400;
const INVITE_DAYS = 14;
const MAX_MEMBERS = 12;
const MAX_BODY = 300 * 1024;
const MAX_PHOTO = 160 * 1024;

// The family that was here before families could sign up. Its data moves into this family the first time this version starts.
const FIRST_FAMILY = {
  id: "evans", name: "Evans", owner: true, hero: "/img/hero.jpg",
  members: [
    { id: "brad", name: "Brad", label: "Dad", parent: true, color: "blue", photo: "/img/brad.jpg", age: 37 },
    { id: "elle", name: "Elle", label: "Mum", parent: true, color: "pink", photo: "/img/elle.jpg", age: 36 },
    { id: "ruby", name: "Ruby", label: "Ruby", parent: false, color: "purple", photo: "/img/ruby.jpg", age: 16, level: 3 },
    { id: "ari", name: "Ari", label: "Ari", parent: false, color: "teal", photo: "/img/ari.jpg", age: 14, level: 2 },
    { id: "lola", name: "Lola", label: "Lola", parent: false, color: "orange", photo: "/img/lola.jpg", age: 12, level: 1 },
  ],
};

// ---------- helpers ----------
function deepMerge(a, b) {
  const o = { ...(a || {}) };
  for (const k of Object.keys(b)) {
    const v = b[k];
    o[k] = v && typeof v === "object" && !Array.isArray(v) && o[k] && typeof o[k] === "object" && !Array.isArray(o[k]) ? deepMerge(o[k], v) : v;
  }
  return o;
}
// The original family's PINs were hashed as "evans:<person>:<pin>", so using the family id as the prefix keeps them working.
const hashPin = (fam, member, pin) => crypto.createHash("sha256").update(`${fam}:${member}:${pin}`).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("hex");
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function hashPass(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${crypto.scryptSync(pw, salt, 32).toString("hex")}`;
}
function checkPass(pw, stored) {
  const [kind, salt, hash] = String(stored || "").split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  return same(crypto.scryptSync(String(pw), Buffer.from(salt, "hex"), 32).toString("hex"), hash);
}

// ---------- storage ----------
function pgStore(url) {
  const { Pool } = require("pg");
  // Render's internal database URL needs no SSL; its external URL (*.render.com) does.
  const pool = new Pool({ connectionString: url, ssl: /\.render\.com/.test(url) ? { rejectUnauthorized: false } : false, max: 5 });
  const q = (sql, args) => pool.query(sql, args);
  const one = async (sql, args) => (await q(sql, args)).rows[0] || null;
  const famRow = r => r && { id: r.id, name: r.name, email: r.email, pass: r.pass, owner: r.owner, hero: r.hero, mver: Number(r.mver) };
  const memRow = r => ({ id: r.id, name: r.name, label: r.label, parent: r.parent, color: r.color, photo: r.photo, age: r.age, level: r.level, sort: Number(r.sort) });
  async function swapKey(c, table, cols) {
    const pk = (await c.query(`SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'p'`, [`family.${table}`])).rows[0];
    await c.query(`ALTER TABLE family.${table} ${pk ? `DROP CONSTRAINT "${pk.conname}", ` : ""}ADD PRIMARY KEY (${cols})`);
  }
  return {
    async init() {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT pg_advisory_xact_lock(727274)"); // two copies starting at once won't both migrate
        // Everything lives in its own "family" schema so it never touches other apps sharing this database.
        await c.query(`CREATE SCHEMA IF NOT EXISTS family`);
        await c.query(`CREATE TABLE IF NOT EXISTS family.docs (coll text NOT NULL, id text NOT NULL, data jsonb NOT NULL, updated bigint NOT NULL, PRIMARY KEY (coll, id))`);
        await c.query(`CREATE TABLE IF NOT EXISTS family.meta (k text PRIMARY KEY, v bigint NOT NULL)`);
        await c.query(`CREATE TABLE IF NOT EXISTS family.pins (member text PRIMARY KEY, hash text NOT NULL)`);
        await c.query(`CREATE TABLE IF NOT EXISTS family.sessions (token text PRIMARY KEY, member text NOT NULL, expires bigint NOT NULL)`);
        await c.query(`CREATE TABLE IF NOT EXISTS family.config (k text PRIMARY KEY, v text NOT NULL)`);
        await c.query(`CREATE TABLE IF NOT EXISTS family.push (endpoint text PRIMARY KEY, member text NOT NULL, sub jsonb NOT NULL, prefs jsonb NOT NULL, tz text NOT NULL)`);
        await c.query(`CREATE TABLE IF NOT EXISTS family.families (id text PRIMARY KEY, name text NOT NULL, email text UNIQUE, pass text, owner boolean NOT NULL DEFAULT false, hero text, mver bigint NOT NULL DEFAULT 1, created bigint NOT NULL)`);
        await c.query(`CREATE TABLE IF NOT EXISTS family.members (fam text NOT NULL, id text NOT NULL, name text NOT NULL, label text NOT NULL, parent boolean NOT NULL, color text NOT NULL, photo text, age int, level int, sort bigint NOT NULL, PRIMARY KEY (fam, id))`);
        await c.query(`CREATE TABLE IF NOT EXISTS family.devices (token text PRIMARY KEY, fam text NOT NULL, expires bigint NOT NULL)`);
        await c.query(`CREATE TABLE IF NOT EXISTS family.invites (code text PRIMARY KEY, by_fam text NOT NULL, created bigint NOT NULL, expires bigint NOT NULL, used_by text, used_at bigint)`);
        const moved = await c.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'family' AND table_name = 'docs' AND column_name = 'fam'`);
        if (!moved.rows.length) {
          // First start with families: keep a copy of everything, then tag every existing row as the first family's.
          for (const t of ["docs", "meta", "pins", "sessions", "push"]) await c.query(`CREATE TABLE IF NOT EXISTS family.bak_${t} AS TABLE family.${t}`);
          for (const t of ["docs", "pins", "sessions", "push"]) await c.query(`ALTER TABLE family.${t} ADD COLUMN fam text NOT NULL DEFAULT '${FIRST_FAMILY.id}'`);
          await swapKey(c, "docs", "fam, coll, id");
          await swapKey(c, "pins", "fam, member");
          await c.query(`INSERT INTO family.meta (k, v) SELECT 'v:${FIRST_FAMILY.id}', v FROM family.meta WHERE k = 'version' ON CONFLICT DO NOTHING`);
          console.log("Moved the existing family data into family", FIRST_FAMILY.id);
        }
        await c.query(`INSERT INTO family.meta (k, v) VALUES ($1, 1) ON CONFLICT DO NOTHING`, [`v:${FIRST_FAMILY.id}`]);
        const added = await c.query(`INSERT INTO family.families (id, name, owner, hero, created) VALUES ($1,$2,true,$3,$4) ON CONFLICT DO NOTHING`, [FIRST_FAMILY.id, FIRST_FAMILY.name, FIRST_FAMILY.hero, Date.now()]);
        if (added.rowCount) for (const [i, m] of FIRST_FAMILY.members.entries())
          await c.query(`INSERT INTO family.members (fam, id, name, label, parent, color, photo, age, level, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`, [FIRST_FAMILY.id, m.id, m.name, m.label, m.parent, m.color, m.photo, m.age || null, m.level || null, i]);
        await c.query("COMMIT");
      } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
    },
    // families and people
    async getFamily(id) { return famRow(await one(`SELECT * FROM family.families WHERE id=$1`, [id])); },
    async familyByEmail(email) { return famRow(await one(`SELECT * FROM family.families WHERE email=$1`, [email])); },
    async createFamily(f) {
      await q(`INSERT INTO family.families (id, name, email, pass, owner, created) VALUES ($1,$2,$3,$4,false,$5)`, [f.id, f.name, f.email, f.pass, Date.now()]);
      await q(`INSERT INTO family.meta (k, v) VALUES ($1, 1) ON CONFLICT DO NOTHING`, [`v:${f.id}`]);
    },
    async updateFamily(id, patch) {
      const keys = Object.keys(patch).filter(k => ["name", "email", "pass"].includes(k));
      await q(`UPDATE family.families SET ${keys.map((k, i) => `${k}=$${i + 2}, `).join("")}mver = mver + 1 WHERE id=$1`, [id, ...keys.map(k => patch[k])]);
    },
    async members(fam) { return (await q(`SELECT * FROM family.members WHERE fam=$1 ORDER BY sort, id`, [fam])).rows.map(memRow); },
    async saveMember(fam, m) {
      await q(`INSERT INTO family.members (fam, id, name, label, parent, color, photo, age, level, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (fam, id) DO UPDATE SET name=EXCLUDED.name, label=EXCLUDED.label, parent=EXCLUDED.parent, color=EXCLUDED.color, photo=EXCLUDED.photo, age=EXCLUDED.age, level=EXCLUDED.level`,
        [fam, m.id, m.name, m.label, m.parent, m.color, m.photo, m.age, m.level, m.sort]);
      await q(`UPDATE family.families SET mver = mver + 1 WHERE id=$1`, [fam]);
    },
    async dropMember(fam, id) {
      for (const t of ["members", "pins", "sessions", "push"]) await q(`DELETE FROM family.${t} WHERE fam=$1 AND ${t === "members" ? "id" : "member"}=$2`, [fam, id]);
      await q(`UPDATE family.families SET mver = mver + 1 WHERE id=$1`, [fam]);
    },
    async addDevice(token, fam, expires) { await q(`INSERT INTO family.devices (token, fam, expires) VALUES ($1,$2,$3)`, [token, fam, expires]); },
    async getDevice(token) { return one(`SELECT fam, expires FROM family.devices WHERE token=$1`, [token]); },
    async addInvite(code, byFam, expires) { await q(`INSERT INTO family.invites (code, by_fam, created, expires) VALUES ($1,$2,$3,$4)`, [code, byFam, Date.now(), expires]); },
    async getInvite(code) { return one(`SELECT code, by_fam, expires, used_by FROM family.invites WHERE code=$1`, [code]); },
    async useInvite(code, fam) { return (await q(`UPDATE family.invites SET used_by=$2, used_at=$3 WHERE code=$1 AND used_by IS NULL AND expires > $3`, [code, fam, Date.now()])).rowCount === 1; },
    async invites(byFam) {
      return (await q(`SELECT i.code, i.created, i.expires, i.used_at, f.name AS family FROM family.invites i LEFT JOIN family.families f ON f.id = i.used_by WHERE i.by_fam=$1 ORDER BY i.created DESC LIMIT 20`, [byFam]))
        .rows.map(r => ({ code: r.code, created: Number(r.created), expires: Number(r.expires), usedAt: r.used_at && Number(r.used_at), family: r.family }));
    },
    // shared family data
    async get(fam, coll, id) { const r = await one(`SELECT data FROM family.docs WHERE fam=$1 AND coll=$2 AND id=$3`, [fam, coll, id]); return r ? r.data : null; },
    async version(fam) { const r = await one(`SELECT v FROM family.meta WHERE k=$1`, [`v:${fam}`]); return r ? Number(r.v) : 0; },
    async all(fam) { return (await q(`SELECT coll, id, data FROM family.docs WHERE fam=$1`, [fam])).rows; },
    async write(fam, op, coll, id, data) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        if (op === "delete") await c.query(`DELETE FROM family.docs WHERE fam=$1 AND coll=$2 AND id=$3`, [fam, coll, id]);
        else {
          let body = data;
          if (op === "update") {
            const cur = await c.query(`SELECT data FROM family.docs WHERE fam=$1 AND coll=$2 AND id=$3 FOR UPDATE`, [fam, coll, id]);
            if (!cur.rows.length) { await c.query("ROLLBACK"); return false; }
            body = deepMerge(cur.rows[0].data, data);
          }
          await c.query(`INSERT INTO family.docs (fam, coll, id, data, updated) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (fam, coll, id) DO UPDATE SET data=EXCLUDED.data, updated=EXCLUDED.updated`, [fam, coll, id, body, Date.now()]);
        }
        await c.query(`UPDATE family.meta SET v = v + 1 WHERE k=$1`, [`v:${fam}`]);
        await c.query("COMMIT");
        return true;
      } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
    },
    // PINs and logins
    async getPin(fam, member) { const r = await one(`SELECT hash FROM family.pins WHERE fam=$1 AND member=$2`, [fam, member]); return r ? r.hash : null; },
    async setPin(fam, member, hash) { await q(`INSERT INTO family.pins (fam, member, hash) VALUES ($1,$2,$3) ON CONFLICT (fam, member) DO UPDATE SET hash=EXCLUDED.hash`, [fam, member, hash]); },
    async customPins(fam) { return (await q(`SELECT member FROM family.pins WHERE fam=$1`, [fam])).rows.map(r => r.member); },
    async addSession(token, fam, member, expires) { await q(`INSERT INTO family.sessions (token, fam, member, expires) VALUES ($1,$2,$3,$4)`, [token, fam, member, expires]); },
    async getSession(token) { return one(`SELECT fam, member, expires FROM family.sessions WHERE token=$1`, [token]); },
    async dropSessions(fam, member) { await q(`DELETE FROM family.sessions WHERE fam=$1 AND member=$2`, [fam, member]); },
    // settings for the whole app, and push subscriptions
    async getConfig(k) { const r = await one(`SELECT v FROM family.config WHERE k=$1`, [k]); return r ? r.v : null; },
    async setConfig(k, v) { await q(`INSERT INTO family.config (k, v) VALUES ($1,$2) ON CONFLICT (k) DO NOTHING`, [k, v]); },
    async pushSubs() { return (await q(`SELECT endpoint, fam, member, sub, prefs, tz FROM family.push`)).rows; },
    async savePush(p) { await q(`INSERT INTO family.push (endpoint, fam, member, sub, prefs, tz) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (endpoint) DO UPDATE SET fam=EXCLUDED.fam, member=EXCLUDED.member, sub=EXCLUDED.sub, prefs=EXCLUDED.prefs, tz=EXCLUDED.tz`, [p.endpoint, p.fam, p.member, p.sub, p.prefs, p.tz]); },
    async dropPush(endpoint) { await q(`DELETE FROM family.push WHERE endpoint=$1`, [endpoint]); },
  };
}

function fileStore(file) {
  let db = {};
  try { db = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  if (typeof db.version === "number" && !db.versions) { // a file from before families: it all belongs to the first family
    db.versions = { [FIRST_FAMILY.id]: db.version };
    db.docs = Object.fromEntries(Object.entries(db.docs || {}).map(([k, v]) => [`${FIRST_FAMILY.id}/${k}`, v]));
    db.pins = Object.fromEntries(Object.entries(db.pins || {}).map(([k, v]) => [`${FIRST_FAMILY.id}/${k}`, v]));
    for (const s of Object.values(db.sessions || {})) s.fam = FIRST_FAMILY.id;
    for (const p of Object.values(db.push || {})) p.fam = FIRST_FAMILY.id;
    delete db.version;
  }
  for (const k of ["versions", "docs", "pins", "sessions", "config", "push", "families", "members", "devices", "invites"]) db[k] = db[k] || {};
  const save = () => fs.writeFileSync(file, JSON.stringify(db));
  const bump = fam => { if (db.families[fam]) db.families[fam].mver++; };
  return {
    async init() {
      if (!db.families[FIRST_FAMILY.id]) {
        const { members, ...f } = FIRST_FAMILY;
        db.families[f.id] = { ...f, email: null, pass: null, mver: 1 };
        db.members[f.id] = members.map((m, i) => ({ age: null, level: null, ...m, sort: i }));
        db.versions[f.id] = db.versions[f.id] || 1;
        save();
      }
    },
    async getFamily(id) { return db.families[id] || null; },
    async familyByEmail(email) { return Object.values(db.families).find(f => f.email === email) || null; },
    async createFamily(f) { db.families[f.id] = { id: f.id, name: f.name, email: f.email, pass: f.pass, owner: false, hero: null, mver: 1 }; db.members[f.id] = []; db.versions[f.id] = 1; save(); },
    async updateFamily(id, patch) { for (const k of ["name", "email", "pass"]) if (k in patch) db.families[id][k] = patch[k]; bump(id); save(); },
    async members(fam) { return (db.members[fam] || []).slice().sort((a, b) => a.sort - b.sort); },
    async saveMember(fam, m) { const l = db.members[fam] = db.members[fam] || []; const i = l.findIndex(x => x.id === m.id); if (i >= 0) l[i] = { ...m, sort: l[i].sort }; else l.push(m); bump(fam); save(); },
    async dropMember(fam, id) {
      db.members[fam] = (db.members[fam] || []).filter(m => m.id !== id); delete db.pins[`${fam}/${id}`];
      for (const t of Object.keys(db.sessions)) if (db.sessions[t].fam === fam && db.sessions[t].member === id) delete db.sessions[t];
      for (const e of Object.keys(db.push)) if (db.push[e].fam === fam && db.push[e].member === id) delete db.push[e];
      bump(fam); save();
    },
    async addDevice(t, fam, expires) { db.devices[t] = { fam, expires }; save(); },
    async getDevice(t) { return db.devices[t] || null; },
    async addInvite(code, byFam, expires) { db.invites[code] = { code, by_fam: byFam, created: Date.now(), expires, used_by: null, used_at: null }; save(); },
    async getInvite(code) { return db.invites[code] || null; },
    async useInvite(code, fam) { const i = db.invites[code]; if (!i || i.used_by || i.expires <= Date.now()) return false; i.used_by = fam; i.used_at = Date.now(); save(); return true; },
    async invites(byFam) {
      return Object.values(db.invites).filter(i => i.by_fam === byFam).sort((a, b) => b.created - a.created).slice(0, 20)
        .map(i => ({ code: i.code, created: i.created, expires: i.expires, usedAt: i.used_at, family: i.used_by && db.families[i.used_by] ? db.families[i.used_by].name : null }));
    },
    async get(fam, c, i) { return db.docs[`${fam}/${c}/${i}`] || null; },
    async version(fam) { return db.versions[fam] || 0; },
    async all(fam) {
      const pre = `${fam}/`;
      return Object.entries(db.docs).filter(([k]) => k.startsWith(pre)).map(([k, data]) => { const rest = k.slice(pre.length), i = rest.indexOf("/"); return { coll: rest.slice(0, i), id: rest.slice(i + 1), data }; });
    },
    async write(fam, op, coll, id, data) {
      const k = `${fam}/${coll}/${id}`;
      if (op === "delete") delete db.docs[k];
      else if (op === "update") { if (!db.docs[k]) return false; db.docs[k] = deepMerge(db.docs[k], data); }
      else db.docs[k] = data;
      db.versions[fam] = (db.versions[fam] || 0) + 1; save(); return true;
    },
    async getPin(fam, m) { return db.pins[`${fam}/${m}`] || null; },
    async setPin(fam, m, h) { db.pins[`${fam}/${m}`] = h; save(); },
    async customPins(fam) { return Object.keys(db.pins).filter(k => k.startsWith(`${fam}/`)).map(k => k.slice(fam.length + 1)); },
    async addSession(t, fam, member, expires) { db.sessions[t] = { fam, member, expires }; save(); },
    async getSession(t) { return db.sessions[t] || null; },
    async dropSessions(fam, m) { for (const t of Object.keys(db.sessions)) if (db.sessions[t].fam === fam && db.sessions[t].member === m) delete db.sessions[t]; save(); },
    async getConfig(k) { return db.config[k] || null; },
    async setConfig(k, v) { if (!db.config[k]) { db.config[k] = v; save(); } },
    async pushSubs() { return Object.values(db.push); },
    async savePush(p) { db.push[p.endpoint] = p; save(); },
    async dropPush(e) { delete db.push[e]; save(); },
  };
}

// On Render the disk is wiped on every deploy, so refuse to run without a real database.
if (process.env.RENDER && !process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Add the database's Internal Database URL in the Render dashboard (Environment tab).");
  process.exit(1);
}
const store = process.env.DATABASE_URL ? pgStore(process.env.DATABASE_URL) : fileStore(path.join(__dirname, "local-data.json"));

// ---------- families, kept in memory because every request needs them ----------
const famCache = new Map();
async function family(id) {
  let f = famCache.get(id);
  if (!f) {
    const info = await store.getFamily(id);
    if (!info) return null;
    const list = await store.members(id);
    f = { info, list, by: Object.fromEntries(list.map(m => [m.id, m])) };
    famCache.set(id, f);
  }
  return f;
}
const forget = id => famCache.delete(id);
const publicMember = m => ({ id: m.id, name: m.name, label: m.label, parent: !!m.parent, color: m.color, photo: m.photo || "", age: m.age || null, level: m.level || null });

// ---------- wrong tries: 5 locks that PIN or email for 10 minutes ----------
const attempts = new Map();
function locked(key) { const a = attempts.get(key); return a && a.until > Date.now(); }
function failed(key) {
  const a = attempts.get(key) || { n: 0, until: 0 };
  a.n++; if (a.n >= 5) { a.until = Date.now() + 10 * 60 * 1000; a.n = 0; }
  attempts.set(key, a);
}

async function checkPin(fam, m, pin) {
  const stored = await store.getPin(fam, m.id);
  const want = stored || hashPin(fam, m.id, m.parent ? DEFAULT_PIN.parent : DEFAULT_PIN.kid);
  return same(want, hashPin(fam, m.id, String(pin || "")));
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
    req.on("end", () => { try { const v = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; resolve(v && typeof v === "object" ? v : {}); } catch { reject(Object.assign(new Error("bad json"), { status: 400 })); } });
    req.on("error", reject);
  });
}
// A token is either a person's login ({fam, member}) or a phone's family login ({fam, member: null}).
async function auth(req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const s = await store.getSession(token);
  if (s) {
    const f = s.expires > Date.now() && await family(s.fam);
    return f && f.by[s.member] ? { fam: s.fam, member: s.member, f } : null;
  }
  const d = await store.getDevice(token);
  const f = d && d.expires > Date.now() && await family(d.fam);
  return f ? { fam: d.fam, member: null, f } : null;
}
const validSeg = s => typeof s === "string" && /^[A-Za-z0-9_\-.~:@+]{1,120}$/.test(s);
const str = (v, max) => typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "";
const cleanFamilyName = v => str(v, 40).replace(/^the\s+/i, "").replace(/\s+family$/i, "").trim();
const cleanEmail = v => { const e = str(v, 120).toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : ""; };
const ip = req => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
function slug(name, taken) {
  const base = (name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "") || "person").slice(0, 16);
  let id = base, n = 2;
  while (taken.has(id)) id = base + n++;
  return id;
}
const INVITE_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";
const inviteCode = () => Array.from(crypto.randomBytes(10), b => INVITE_CHARS[b % INVITE_CHARS.length]).join("");
async function startDevice(fam) { const t = newToken(); await store.addDevice(t, fam, Date.now() + DEVICE_DAYS * 864e5); return t; }
async function startSession(fam, member) { const t = newToken(); await store.addSession(t, fam, member, Date.now() + SESSION_DAYS * 864e5); return t; }

// Checks a person sent from the family settings screen. Returns the cleaned person or an error message.
function memberFrom(body, cur) {
  const name = str(body.name, 30);
  if (!name) return { error: "Add a name" };
  const label = str(body.label, 20) || name;
  const color = COLORS.includes(body.color) ? body.color : cur ? cur.color : COLORS[0];
  let photo = cur ? cur.photo : null;
  if (body.photo === "" || body.photo === null) photo = null;
  else if (typeof body.photo === "string" && body.photo !== photo) {
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(body.photo) || body.photo.length > MAX_PHOTO) return { error: "That photo didn't work. Try a different one." };
    photo = body.photo;
  }
  const age = Number.isInteger(body.age) && body.age > 0 && body.age < 120 ? body.age : null;
  const level = [1, 2, 3].includes(body.level) ? body.level : null;
  return { name, label, parent: !!body.parent, color, photo, age, level };
}

// ---------- routes ----------
async function api(req, res, url) {
  const p = url.pathname;
  // ---- no login needed ----
  if (req.method === "GET" && p === "/api/invite") {
    const i = await store.getInvite(String(url.searchParams.get("code") || ""));
    if (!i || i.expires < Date.now()) return send(res, 404, { error: "That invite link isn't right, or it's expired. Ask for a new one." });
    if (i.used_by) return send(res, 410, { error: "That invite link has already been used. Ask for a new one." });
    return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && p === "/api/family/login") {
    const b = await readBody(req);
    const email = cleanEmail(b.email), key = "email:" + email, ipKey = "ip:" + ip(req);
    if (locked(key) || locked(ipKey)) return send(res, 429, { error: "Too many wrong tries. Wait 10 minutes and try again." });
    const f = email && await store.familyByEmail(email);
    if (!f || !checkPass(b.password, f.pass)) { failed(key); failed(ipKey); return send(res, 401, { error: "That email or password isn't right" }); }
    attempts.delete(key);
    return send(res, 200, { device: await startDevice(f.id) });
  }
  if (req.method === "POST" && p === "/api/family/signup") {
    const b = await readBody(req);
    const ipKey = "signup:" + ip(req);
    if (locked(ipKey)) return send(res, 429, { error: "Too many tries. Wait 10 minutes and try again." });
    const code = String(b.invite || "");
    const inv = await store.getInvite(code);
    if (!inv || inv.used_by || inv.expires < Date.now()) { failed(ipKey); return send(res, 410, { error: "That invite link has been used or has expired. Ask for a new one." }); }
    const name = cleanFamilyName(b.family), email = cleanEmail(b.email), password = String(b.password || "");
    const you = memberFrom({ ...b.you, parent: true }, null);
    if (!name) return send(res, 400, { error: "Add your family's name" });
    if (!email) return send(res, 400, { error: "That email doesn't look right" });
    if (password.length < 8 || password.length > 200) return send(res, 400, { error: "Use a password with at least 8 characters" });
    if (you.error) return send(res, 400, { error: you.error });
    if (!/^\d{4}$/.test(String(b.pin || ""))) return send(res, 400, { error: "Pick a 4-number PIN for yourself" });
    if (await store.familyByEmail(email)) return send(res, 409, { error: "That email already has a family. Log in instead." });
    const fam = "f" + crypto.randomBytes(6).toString("hex");
    if (!(await store.useInvite(code, fam))) return send(res, 410, { error: "That invite link has just been used. Ask for a new one." });
    await store.createFamily({ id: fam, name, email, pass: hashPass(password) });
    const me = { ...you, id: slug(you.name, new Set()), sort: 0 };
    await store.saveMember(fam, me);
    await store.setPin(fam, me.id, hashPin(fam, me.id, String(b.pin)));
    return send(res, 200, { device: await startDevice(fam), token: await startSession(fam, me.id), member: me.id });
  }

  const who = await auth(req);
  if (!who) return send(res, 401, { error: "Please log in" });
  const { fam, f } = who;
  const me = who.member, meM = me && f.by[me];

  // ---- a phone logged in to the family ----
  if (req.method === "GET" && p === "/api/family") {
    return send(res, 200, {
      family: { id: fam, name: f.info.name, hero: f.info.hero || "", owner: !!f.info.owner, mver: f.info.mver, hasLogin: !!f.info.pass, ...(meM && meM.parent ? { email: f.info.email || "" } : {}) },
      members: f.list.map(publicMember),
      custom: await store.customPins(fam),
    });
  }
  if (req.method === "GET" && p === "/api/pins") return send(res, 200, { custom: await store.customPins(fam) });
  if (req.method === "POST" && p === "/api/login") {
    const { member, pin } = await readBody(req);
    const m = f.by[member];
    if (!m) return send(res, 400, { error: "Unknown person" });
    const key = `pin:${fam}:${member}`;
    if (locked(key)) return send(res, 429, { error: "Too many wrong tries. Wait 10 minutes and try again." });
    if (!(await checkPin(fam, m, pin))) { failed(key); return send(res, 403, { error: "That PIN isn't right" }); }
    attempts.delete(key);
    return send(res, 200, { token: await startSession(fam, member), member });
  }

  // ---- a person logged in ----
  if (!me) return send(res, 401, { error: "Please log in" });
  if (req.method === "POST" && p === "/api/device") return send(res, 200, { device: await startDevice(fam) });
  if (req.method === "GET" && p === "/api/sync") {
    const v = await store.version(fam);
    if (String(v) === url.searchParams.get("v")) return send(res, 200, { v, mv: f.info.mver });
    return send(res, 200, { v, mv: f.info.mver, docs: await store.all(fam) });
  }
  if (req.method === "POST" && p === "/api/write") {
    const { op, coll, id, data } = await readBody(req);
    if (!["set", "update", "delete"].includes(op) || !COLLS.has(coll) || !validSeg(id)) return send(res, 400, { error: "Bad write" });
    if (op !== "delete" && (!data || typeof data !== "object" || Array.isArray(data))) return send(res, 400, { error: "Bad data" });
    const before = await store.get(fam, coll, id);
    const ok = await store.write(fam, op, coll, id, data);
    if (!ok) return send(res, 404, { error: "Not found" });
    const after = op === "delete" ? null : await store.get(fam, coll, id);
    push.onWrite(fam, me, op, coll, before && { id, ...before }, after && { id, ...after }).catch(e => console.error("push", e.message));
    return send(res, 200, { ok: true, v: await store.version(fam) });
  }
  if (req.method === "POST" && p === "/api/pin") {
    const { member, pin } = await readBody(req);
    if (!f.by[member] || !/^\d{4}$/.test(String(pin))) return send(res, 400, { error: "Use 4 numbers" });
    if (member !== me && !meM.parent) return send(res, 403, { error: "Only Mum or Dad can change someone else's PIN" });
    await store.setPin(fam, member, hashPin(fam, member, String(pin)));
    if (member !== me) await store.dropSessions(fam, member); // log them out everywhere after a reset
    return send(res, 200, { ok: true });
  }
  if (p.startsWith("/api/push/")) return push.route(req, res, url, who, readBody, send);

  // ---- parents only ----
  if (!meM.parent) return send(res, 403, { error: "Only Mum or Dad can do that" });
  if (req.method === "POST" && p === "/api/members/save") {
    const b = await readBody(req);
    const cur = b.id ? f.by[b.id] : null;
    if (b.id && !cur) return send(res, 404, { error: "That person isn't in your family" });
    if (!cur && f.list.length >= MAX_MEMBERS) return send(res, 400, { error: `A family can have up to ${MAX_MEMBERS} people` });
    const m = memberFrom(b, cur);
    if (m.error) return send(res, 400, { error: m.error });
    if (cur && cur.parent && !m.parent && !f.list.some(x => x.parent && x.id !== cur.id)) return send(res, 400, { error: "The family needs at least one parent" });
    const pin = b.pin == null || b.pin === "" ? null : String(b.pin);
    if (pin !== null && !/^\d{4}$/.test(pin)) return send(res, 400, { error: "PINs are 4 numbers" });
    if (!cur && !pin) return send(res, 400, { error: "Give them a 4-number PIN to start with" });
    const id = cur ? cur.id : slug(m.name, new Set(f.list.map(x => x.id)));
    await store.saveMember(fam, { ...m, id, sort: cur ? cur.sort : Date.now() });
    if (pin) { await store.setPin(fam, id, hashPin(fam, id, pin)); if (cur && id !== me) await store.dropSessions(fam, id); }
    forget(fam);
    return send(res, 200, { ok: true, id });
  }
  if (req.method === "POST" && p === "/api/members/remove") {
    const { id } = await readBody(req);
    const m = f.by[id];
    if (!m) return send(res, 404, { error: "That person isn't in your family" });
    if (id === me) return send(res, 400, { error: "You can't remove yourself. Ask the other parent to." });
    await store.dropMember(fam, id);
    forget(fam);
    return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && p === "/api/family/update") {
    const b = await readBody(req), patch = {};
    if ("name" in b) { patch.name = cleanFamilyName(b.name); if (!patch.name) return send(res, 400, { error: "Add your family's name" }); }
    if ("email" in b) {
      patch.email = cleanEmail(b.email); if (!patch.email) return send(res, 400, { error: "That email doesn't look right" });
      const other = await store.familyByEmail(patch.email);
      if (other && other.id !== fam) return send(res, 409, { error: "That email is already used by another family" });
    }
    if ("password" in b) {
      const pw = String(b.password || "");
      if (pw.length < 8 || pw.length > 200) return send(res, 400, { error: "Use a password with at least 8 characters" });
      patch.pass = hashPass(pw);
    }
    const email = patch.email || f.info.email;
    if (!email && patch.pass) return send(res, 400, { error: "Add an email to go with the password" });
    if (!patch.pass && !f.info.pass && patch.email) return send(res, 400, { error: "Add a password to go with the email" });
    if (Object.keys(patch).length) { await store.updateFamily(fam, patch); forget(fam); }
    return send(res, 200, { ok: true });
  }
  if (p === "/api/invites" || p === "/api/invites/create") {
    if (!f.info.owner) return send(res, 403, { error: "Invites aren't turned on for your family" });
    if (req.method === "POST" && p === "/api/invites/create") {
      const code = inviteCode();
      await store.addInvite(code, fam, Date.now() + INVITE_DAYS * 864e5);
      return send(res, 200, { code });
    }
    if (req.method === "GET") return send(res, 200, { invites: await store.invites(fam) });
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

const push = require("./push")(store, family);
store.init().then(() => push.init()).then(() => server.listen(PORT, () => console.log(`Family App on :${PORT} (${process.env.DATABASE_URL ? "postgres" : "local file"})`)))
  .catch(e => { console.error("Could not start", e); process.exit(1); });
