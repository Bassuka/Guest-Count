// Door Count API, one Netlify Function that serves /api/*.
// One shared entry code is printed as a QR on the invitation picture. Every scan
// (or manual add) records people entering, so the same code can be used again and
// again for a family. Storage: Netlify Blobs.
//   entries : one tiny blob per person who entered, so parallel scans never overwrite each other
//   batches : one marker per scan, so a retried request is never counted twice
//   meta    : settings (event name, expected guests, the entry code)
// Access: ADMIN_PIN does everything. STAFF_PIN (optional) can only count, undo and read.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const config = { path: "/api/*" };

const ALPH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_RE = /ENTRY-[A-Z2-9]{12}/;
const MAX_GROUP = 50;
const RECENT = 12;
const LOG_LIMIT = 1000;

/* ---------- storage adapter ---------- */

function adaptBlobs(store) {
  return {
    async get(key) {
      const v = await store.get(key, { type: "json" });
      return v === undefined ? null : v;
    },
    async put(key, value, opts = {}) {
      if (opts.onlyIfNew) {
        const r = await store.setJSON(key, value, { onlyIfNew: true });
        if (r && typeof r.modified === "boolean") return r.modified;
        return null;
      }
      await store.setJSON(key, value);
      return true;
    },
    async del(key) {
      await store.delete(key);
    },
    async keys() {
      const res = await store.list();
      return (res.blobs || []).map((b) => b.key);
    },
  };
}

async function netlifyStores() {
  const { getStore } = await import("@netlify/blobs");
  const open = (name) => adaptBlobs(getStore({ name, consistency: "strong" }));
  return { entries: open("door-entries"), batches: open("door-batches"), meta: open("door-meta") };
}

/* ---------- helpers ---------- */

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const sha = (s) => createHash("sha256").update(String(s)).digest();
const same = (a, b) => timingSafeEqual(sha(a), sha(b));
const rand = (n) => {
  const b = randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += ALPH[b[i] % 32];
  return s;
};
const makeCode = () => `ENTRY-${rand(12)}`;
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pmap(items, fn, size = 40) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

function roleFor(req) {
  const admin = process.env.ADMIN_PIN;
  if (!admin) return { error: "ADMIN_PIN is not set. Add it under Site configuration, Environment variables, then redeploy." };
  const pin = req.headers.get("x-pin") || "";
  if (same(pin, admin)) return { role: "admin" };
  const staff = process.env.STAFF_PIN;
  if (staff && same(pin, staff)) return { role: "staff" };
  return { role: null };
}

// Entry key: <time 13 digits>-<via>-<batch id>-<index>. Everything the log needs is in the key.
const entryKey = (ts, via, rid, i) => `${String(ts).padStart(13, "0")}-${via}-${rid}-${i}`;
function parseKey(k) {
  const p = k.split("-");
  if (p.length !== 4) return null;
  return { ts: Number(p[0]), via: p[1], rid: p[2] };
}
function groupBatches(keys) {
  const map = new Map();
  for (const k of keys) {
    const e = parseKey(k);
    if (!e) continue;
    const g = map.get(e.rid);
    if (g) g.n++;
    else map.set(e.rid, { batch: e.rid, at: e.ts, via: e.via === "m" ? "manual" : "scan", n: 1 });
  }
  return [...map.values()].sort((a, b) => b.at - a.at);
}

async function ensureSettings(stores) {
  let s = await stores.meta.get("settings");
  if (!s) {
    await stores.meta.put("settings", { code: makeCode(), event: "", expected: 0, createdAt: Date.now() }, { onlyIfNew: true });
    s = await stores.meta.get("settings");
  }
  return s;
}

/* ---------- handlers ---------- */

async function state(stores, admin) {
  const [s, keys] = await Promise.all([ensureSettings(stores), stores.entries.keys()]);
  const out = { event: s.event || "", expected: s.expected || 0, total: keys.length, recent: groupBatches(keys).slice(0, RECENT) };
  if (admin) out.code = s.code;
  return out;
}

async function enter(stores, body) {
  const via = body.via === "manual" ? "m" : "s";
  const n = Math.min(MAX_GROUP, Math.max(1, parseInt(body.n, 10) || 1));
  let rid = String(body.rid || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 24);
  if (rid.length < 6) rid = rand(10);

  const s = await ensureSettings(stores);
  if (via === "s") {
    const m = CODE_RE.exec(String(body.code || "").toUpperCase());
    if (!m) return { result: "invalid", reason: "format" };
    if (!same(m[0], s.code)) return { result: "invalid", reason: "wrong" };
  }

  // The batch marker is written first and fixes the time and size. A retry of a request
  // that already finished counts nothing, and a retry of one that stopped halfway rewrites
  // the same entry keys, so nobody is counted twice.
  let marker = await stores.batches.get(rid);
  if (marker && marker.done) {
    const total = (await stores.entries.keys()).length;
    return { result: "ok", added: marker.n, total, batch: rid, replay: true };
  }
  if (!marker) {
    marker = { n, ts: Date.now(), via, done: false };
    await stores.batches.put(rid, marker);
  }
  await pmap(Array.from({ length: marker.n }, (_, i) => i), (i) => stores.entries.put(entryKey(marker.ts, marker.via, rid, i), { v: 1 }));
  await stores.batches.put(rid, { ...marker, done: true });
  const total = (await stores.entries.keys()).length;
  return { result: "ok", added: marker.n, total, batch: rid };
}

async function undo(stores, body) {
  const rid = String(body.batch || "").replace(/[^A-Za-z0-9]/g, "");
  if (rid.length < 6) return { removed: 0, total: (await stores.entries.keys()).length };
  const keys = (await stores.entries.keys()).filter((k) => (parseKey(k) || {}).rid === rid);
  await pmap(keys, (k) => stores.entries.del(k));
  return { removed: keys.length, total: (await stores.entries.keys()).length };
}

async function log(stores) {
  const keys = await stores.entries.keys();
  const batches = groupBatches(keys);
  return { total: keys.length, batches: batches.slice(0, LOG_LIMIT), truncated: batches.length > LOG_LIMIT };
}

async function saveSettings(stores, body) {
  const s = await ensureSettings(stores);
  const next = {
    ...s,
    event: clean(body.event, 80),
    expected: Math.min(100000, Math.max(0, parseInt(body.expected, 10) || 0)),
  };
  await stores.meta.put("settings", next);
  return { event: next.event, expected: next.expected };
}

async function newCode(stores) {
  const s = await ensureSettings(stores);
  const code = makeCode();
  await stores.meta.put("settings", { ...s, code });
  return { code };
}

async function resetAll(stores) {
  const [e, b] = await Promise.all([stores.entries.keys(), stores.batches.keys()]);
  await pmap(e, (k) => stores.entries.del(k));
  await pmap(b, (k) => stores.batches.del(k));
  return { ok: true };
}

/* ---------- router ---------- */

export function createHandler(getStores) {
  return async function handler(req) {
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "").split("/").filter(Boolean);
    const method = req.method.toUpperCase();

    const auth = roleFor(req);
    if (auth.error) return json(500, { error: auth.error });
    if (!auth.role) {
      await sleep(500);
      return json(401, { error: "Wrong PIN." });
    }
    const admin = auth.role === "admin";

    let body = {};
    if (method === "POST") {
      try {
        body = await req.json();
      } catch {
        return json(400, { error: "Request body must be JSON." });
      }
    }

    try {
      const stores = await getStores();
      const route = parts[0];

      if (route === "me" && method === "GET") return json(200, { role: auth.role });
      if (route === "state" && method === "GET") return json(200, await state(stores, admin));
      if (route === "log" && method === "GET") return json(200, await log(stores));
      if (route === "enter" && method === "POST") return json(200, await enter(stores, body));
      if (route === "undo" && method === "POST") return json(200, await undo(stores, body));

      if (!admin) return json(403, { error: "This needs the admin PIN." });

      if (route === "settings" && method === "POST") return json(200, await saveSettings(stores, body));
      if (route === "code" && method === "POST") return json(200, await newCode(stores));
      if (route === "reset" && method === "POST") return json(200, await resetAll(stores));
      return json(404, { error: "Unknown route." });
    } catch (err) {
      console.error("api error", err);
      return json(500, { error: "The server could not complete that request." });
    }
  };
}

let cached;
export default createHandler(async () => (cached ||= await netlifyStores()));
