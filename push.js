// Push notifications: new messages, calendar reminders, and jobs/points activity.
// Each phone that turns notifications on stores a Web Push subscription here, tied to the person logged in on it.
"use strict";
const webpush = require("web-push");

const LABEL = { brad: "Dad", elle: "Mum", ruby: "Ruby", ari: "Ari", lola: "Lola" };
const KINDS = ["msgs", "cal", "jobs"];
const REMIND_MINUTES = 30;   // reminder this long before an event with a start time
const ALL_DAY_REMINDER = "07:00"; // events with no start time get a morning heads-up
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const dayNum = k => { const [y, m, d] = k.split("-").map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
const niceDate = k => { const d = new Date(dayNum(k) * 864e5); return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
const niceTime = t => { if (!t) return ""; let [h, m] = t.split(":").map(Number); const ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12; return `${h}:${String(m).padStart(2, "0")} ${ap}`; };
const clip = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

// Same repeat rules as the app's calendar.
function occursOn(e, k) {
  if (!e.repeat) return e.date === k;
  if (!e.date || k < e.date || (e.until && k > e.until) || (e.skip || []).includes(k)) return false;
  const diff = dayNum(k) - dayNum(e.date);
  const a = new Date(dayNum(e.date) * 864e5), b = new Date(dayNum(k) * 864e5);
  switch (e.repeat) {
    case "daily": return true;
    case "weekdays": return b.getUTCDay() > 0 && b.getUTCDay() < 6;
    case "weekly": return diff % 7 === 0;
    case "fortnightly": return diff % 14 === 0;
    case "monthly": return b.getUTCDate() === a.getUTCDate();
    case "yearly": return b.getUTCDate() === a.getUTCDate() && b.getUTCMonth() === a.getUTCMonth();
  }
  return false;
}

// Local date (YYYY-MM-DD) and time (HH:MM) of an instant in a time zone.
const fmtCache = new Map();
function localParts(ms, tz) {
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); fmtCache.set(tz, f); }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
const validTz = tz => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return typeof tz === "string" && tz.length < 64; } catch { return false; } };

module.exports = function makePush(store, MEMBERS) {
  const parents = Object.keys(MEMBERS).filter(m => MEMBERS[m]);
  const kids = Object.keys(MEMBERS).filter(m => !MEMBERS[m]);
  let publicKey = "";

  async function init() {
    // VAPID keys are made once and kept in the database, so nothing needs setting up in Render.
    if (!(await store.getConfig("vapid"))) { const k = webpush.generateVAPIDKeys(); await store.setConfig("vapid", JSON.stringify(k)); }
    const k = JSON.parse(await store.getConfig("vapid"));
    webpush.setVapidDetails(process.env.RENDER_EXTERNAL_URL || "https://evans-family-app.onrender.com", k.publicKey, k.privateKey);
    publicKey = k.publicKey;
    let last = Math.floor(Date.now() / 60000);
    setInterval(() => { const now = Math.floor(Date.now() / 60000); const from = last; last = now; reminders(from, now).catch(e => console.error("reminders", e.message)); }, 20000).unref();
  }

  async function deliver(sub, payload) {
    try { await webpush.sendNotification(sub.sub, JSON.stringify(payload), { TTL: 6 * 3600 }); }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await store.dropPush(sub.endpoint); else console.error("push send", e.statusCode || e.message); }
  }

  // Send to everyone in `people` who has this kind of notification turned on.
  async function notify(people, kind, payload) {
    const want = new Set(people);
    if (!want.size) return;
    const subs = (await store.pushSubs()).filter(s => want.has(s.member) && s.prefs && s.prefs[kind]);
    await Promise.all(subs.map(s => deliver(s, payload)));
  }

  async function onWrite(me, op, coll, before, after) {
    const not = list => [...new Set(list)].filter(m => m && m !== me && m in MEMBERS);
    const L = m => LABEL[m] || m;
    if (coll === "messages" && !before && after) {
      const fam = after.to === "family";
      const to = fam ? Object.keys(MEMBERS) : [after.to];
      const thread = fam ? "family" : [after.from, after.to].sort().join("-");
      return notify(not(to), "msgs", { title: fam ? `${L(after.from)} in Family chat` : L(after.from), body: clip(after.text, 160), tag: "chat-" + thread, url: `/?tab=chat&thread=${thread}` });
    }
    if (coll === "jobs" && after) {
      const job = `${after.title} · ${after.pts} points`;
      if (!before) {
        const to = [];
        if (after.assignee && after.assignee !== "anyone") to.push(after.assignee);
        else if (MEMBERS[me]) to.push(...kids);
        if (!MEMBERS[me]) to.push(...parents);
        const title = after.assignee === me ? `${L(me)} added a job` : after.assignee && after.assignee !== "anyone" ? `New job for ${L(after.assignee)}` : "New job up for grabs";
        return notify(not(to), "jobs", { title, body: job, tag: "job-" + after.id, url: "/?tab=jobs" });
      }
      if (before.status !== "pending" && after.status === "pending")
        return notify(not(parents), "jobs", { title: `${L(after.doneBy)} finished a job`, body: `${after.title}. Tap to check it and approve ${after.pts} points.`, tag: "job-" + after.id, url: "/?tab=jobs" });
      if (before.status !== "done" && after.status === "done")
        return notify(not([after.doneBy]), "jobs", { title: `+${after.pts} points!`, body: `${L(after.approvedBy)} approved "${after.title}"`, tag: "job-" + after.id, url: "/?tab=jobs" });
      if (before.status === "pending" && after.status === "open")
        return notify(not([before.doneBy]), "jobs", { title: "Not quite done yet", body: `${L(me)} sent back "${after.title}"`, tag: "job-" + after.id, url: "/?tab=jobs" });
      return;
    }
    if (coll === "ledger" && after) {
      if (!before && after.kind === "bonus")
        return notify(not([after.who]), "jobs", { title: after.pts > 0 ? `${L(me)} gave you ${after.pts} points` : `${L(me)} took off ${-after.pts} points`, body: clip(after.reason, 120), tag: "pts-" + after.id, url: "/?tab=jobs" });
      if (!before && after.kind === "reward")
        return notify(not(parents), "jobs", { title: `${L(after.who)} cashed in a reward`, body: `${clip(after.reason, 80)} · ${-after.pts} points`, tag: "rw-" + after.id, url: "/?tab=jobs&seg=rewards" });
      if (before && before.status === "pending" && after.status === "given")
        return notify(not([after.who]), "jobs", { title: "Reward sorted", body: `${L(after.givenBy || me)} says "${clip(after.reason, 80)}" is yours`, tag: "rw-" + after.id, url: "/?tab=jobs&seg=rewards" });
      return;
    }
    if (coll === "events" && !before && after) {
      const ppl = after.who && after.who.length ? after.who : Object.keys(MEMBERS);
      const when = `${niceDate(after.date)}${after.time ? ", " + niceTime(after.time) : ""}${after.repeat ? " (repeats)" : ""}`;
      return notify(not(ppl), "cal", { title: `${L(me)} added to the calendar`, body: `${clip(after.title, 80)} · ${when}`, tag: "ev-" + after.id, url: `/?tab=cal&day=${after.date}` });
    }
  }

  // Calendar reminders, checked for every minute since the last check so none get skipped.
  const sent = new Set();
  async function reminders(fromMin, toMin) {
    const subs = (await store.pushSubs()).filter(s => s.prefs && s.prefs.cal);
    if (!subs.length) return;
    const events = (await store.all()).filter(r => r.coll === "events").map(r => ({ id: r.id, ...r.data }));
    for (let m = fromMin + 1; m <= toMin; m++) {
      for (const s of subs) {
        const soon = localParts((m + REMIND_MINUTES) * 60000, s.tz);
        const now = localParts(m * 60000, s.tz);
        for (const e of events) {
          const ppl = e.who && e.who.length ? e.who : Object.keys(MEMBERS);
          if (!ppl.includes(s.member)) continue;
          let payload = null, key = "";
          if (e.time && e.time === soon.time && occursOn(e, soon.date)) {
            key = `${s.endpoint}|${e.id}|${soon.date}`;
            payload = { title: `${clip(e.title, 60)} at ${niceTime(e.time)}`, body: `Starts in ${REMIND_MINUTES} minutes${e.notes ? ". " + clip(e.notes, 100) : ""}`, tag: `rem-${e.id}-${soon.date}`, url: `/?tab=cal&day=${soon.date}` };
          } else if (!e.time && now.time === ALL_DAY_REMINDER && occursOn(e, now.date)) {
            key = `${s.endpoint}|${e.id}|${now.date}`;
            payload = { title: `Today: ${clip(e.title, 60)}`, body: e.notes ? clip(e.notes, 120) : "On the family calendar", tag: `rem-${e.id}-${now.date}`, url: `/?tab=cal&day=${now.date}` };
          }
          if (payload && !sent.has(key)) { sent.add(key); await deliver(s, payload); }
        }
      }
    }
    if (sent.size > 5000) sent.clear();
  }

  async function route(req, res, url, me, readBody, send) {
    if (url.pathname === "/api/push/key") return send(res, 200, { key: publicKey });
    if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
    const body = await readBody(req);
    if (url.pathname === "/api/push/subscribe") {
      const sub = body.sub || {};
      if (typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || sub.endpoint.length > 1000 || !sub.keys || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string")
        return send(res, 400, { error: "Bad subscription" });
      const prefs = Object.fromEntries(KINDS.map(k => [k, !body.prefs || body.prefs[k] !== false]));
      await store.savePush({ endpoint: sub.endpoint, member: me, sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, prefs, tz: validTz(body.tz) ? body.tz : "UTC" });
      return send(res, 200, { ok: true, prefs });
    }
    if (url.pathname === "/api/push/status") {
      const s = (await store.pushSubs()).find(x => x.endpoint === body.endpoint && x.member === me);
      return send(res, 200, s ? { on: true, prefs: s.prefs } : { on: false });
    }
    if (url.pathname === "/api/push/unsubscribe") {
      if (typeof body.endpoint === "string") await store.dropPush(body.endpoint);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/push/test") {
      const subs = (await store.pushSubs()).filter(s => s.member === me && (!body.endpoint || s.endpoint === body.endpoint));
      await Promise.all(subs.map(s => deliver(s, { title: "Notifications are on", body: `Nice one ${LABEL[me]}, this phone will now get Family App updates.`, tag: "test", url: "/" })));
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "Not found" });
  }

  return { init, onWrite, route, reminders };
};
