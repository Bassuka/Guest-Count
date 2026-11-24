import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../netlify/functions/api.mjs";

process.env.ADMIN_PIN = "admin-pin-1";
process.env.STAFF_PIN = "staff-pin-1";

// In-memory stand-in for Netlify Blobs, with a little latency so races are real.
function mem() {
  const m = new Map();
  const lag = () => new Promise((r) => setTimeout(r, Math.random() * 6));
  return {
    async get(k) { await lag(); return m.has(k) ? JSON.parse(m.get(k)) : null; },
    async put(k, v, o = {}) {
      await lag();
      if (o.onlyIfNew && m.has(k)) return false;
      m.set(k, JSON.stringify(v));
      return true;
    },
    async del(k) { await lag(); m.delete(k); },
    async keys() { await lag(); return [...m.keys()]; },
  };
}
const fresh = () => {
  const stores = { entries: mem(), batches: mem(), meta: mem() };
  const h = createHandler(async () => stores);
  const call = (method, path, pin, body) =>
    h(new Request("https://x.test" + path, { method, headers: { "x-pin": pin ?? "", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }))
      .then(async (r) => ({ status: r.status, data: await r.json() }));
  return { call, stores };
};
const A = "admin-pin-1", S = "staff-pin-1";
const codeOf = async (call) => (await call("GET", "/api/state", A)).data.code;

test("wrong pin is refused and roles are enforced", async () => {
  const { call } = fresh();
  assert.equal((await call("GET", "/api/state", "nope")).status, 401);
  assert.equal((await call("GET", "/api/me", S)).data.role, "staff");
  assert.equal((await call("POST", "/api/settings", S, { event: "x" })).status, 403);
  assert.equal((await call("POST", "/api/reset", S, {})).status, 403);
  assert.equal((await call("POST", "/api/code", S, {})).status, 403);
  assert.equal((await call("GET", "/api/state", A)).status, 200);
});

test("the entry code is created once, shown to admin only, and well formed", async () => {
  const { call } = fresh();
  const a = (await call("GET", "/api/state", A)).data;
  assert.match(a.code, /^ENTRY-[A-Z2-9]{12}$/);
  assert.equal((await call("GET", "/api/state", S)).data.code, undefined);
  assert.equal((await call("GET", "/api/state", A)).data.code, a.code);
});

test("every scan of the same code counts, with no flags", async () => {
  const { call } = fresh();
  const code = await codeOf(call);
  let last;
  for (let i = 1; i <= 5; i++) {
    last = (await call("POST", "/api/enter", S, { code, n: 1, rid: "scan" + i + "abcdef" })).data;
    assert.equal(last.result, "ok");
    assert.equal(last.total, i);
  }
  assert.equal((await call("GET", "/api/state", S)).data.total, 5);
});

test("group size adds that many people at once, one undo removes the whole group", async () => {
  const { call } = fresh();
  const code = await codeOf(call);
  await call("POST", "/api/enter", S, { code, n: 1, rid: "aaaaaa11" });
  const g = (await call("POST", "/api/enter", S, { code: code.toLowerCase(), n: 4, rid: "family0001" })).data;
  assert.equal(g.added, 4);
  assert.equal(g.total, 5);
  const u = (await call("POST", "/api/undo", S, { batch: g.batch })).data;
  assert.equal(u.removed, 4);
  assert.equal(u.total, 1);
});

test("a retried request is not counted twice", async () => {
  const { call } = fresh();
  const code = await codeOf(call);
  const first = (await call("POST", "/api/enter", S, { code, n: 3, rid: "retry000001" })).data;
  const again = (await call("POST", "/api/enter", S, { code, n: 3, rid: "retry000001" })).data;
  assert.equal(first.total, 3);
  assert.equal(again.total, 3);
  assert.equal(again.replay, true);
});

test("a request that stopped halfway is completed by its retry without double counting", async () => {
  const { call, stores } = fresh();
  const code = await codeOf(call);
  // simulate a crash after the marker and two of three entries were written
  await stores.batches.put("partial0001", { n: 3, ts: 1700000000000, via: "s", done: false });
  await stores.entries.put("1700000000000-s-partial0001-0", { v: 1 });
  await stores.entries.put("1700000000000-s-partial0001-1", { v: 1 });
  const r = (await call("POST", "/api/enter", S, { code, n: 3, rid: "partial0001" })).data;
  assert.equal(r.total, 3);
  assert.equal(r.added, 3);
  assert.equal((await call("POST", "/api/enter", S, { code, n: 3, rid: "partial0001" })).data.total, 3);
});

test("wrong, malformed and old codes are refused and count nothing", async () => {
  const { call } = fresh();
  const code = await codeOf(call);
  assert.equal((await call("POST", "/api/enter", S, { code: "hello", n: 1 })).data.result, "invalid");
  assert.equal((await call("POST", "/api/enter", S, { code: "ENTRY-AAAAAAAAAAAA", n: 1 })).data.result, "invalid");
  assert.equal((await call("POST", "/api/enter", S, { n: 1 })).data.result, "invalid");
  assert.equal((await call("GET", "/api/state", S)).data.total, 0);
  const next = (await call("POST", "/api/code", A, {})).data.code;
  assert.notEqual(next, code);
  assert.equal((await call("POST", "/api/enter", S, { code, n: 1 })).data.result, "invalid");
  assert.equal((await call("POST", "/api/enter", S, { code: next, n: 1 })).data.result, "ok");
});

test("a code inside a longer scanned string still counts", async () => {
  const { call } = fresh();
  const code = await codeOf(call);
  assert.equal((await call("POST", "/api/enter", S, { code: ` ${code}\r\n`, n: 1 })).data.result, "ok");
});

test("manual add needs no code and is labelled manual in the log", async () => {
  const { call } = fresh();
  await call("GET", "/api/state", A);
  const r = (await call("POST", "/api/enter", S, { via: "manual", n: 2 })).data;
  assert.equal(r.total, 2);
  const log = (await call("GET", "/api/log", S)).data;
  assert.equal(log.batches[0].via, "manual");
  assert.equal(log.batches[0].n, 2);
});

test("group size is clamped to 1..50 and junk is treated as 1", async () => {
  const { call } = fresh();
  const code = await codeOf(call);
  assert.equal((await call("POST", "/api/enter", S, { code, n: 9999 })).data.added, 50);
  assert.equal((await call("POST", "/api/enter", S, { code, n: -3 })).data.added, 1);
  assert.equal((await call("POST", "/api/enter", S, { code, n: "x" })).data.added, 1);
});

test("many scans at the same moment from several phones all count", async () => {
  const { call } = fresh();
  const code = await codeOf(call);
  const sizes = Array.from({ length: 30 }, (_, i) => (i % 4) + 1);
  const results = await Promise.all(sizes.map((n, i) => call("POST", "/api/enter", S, { code, n, rid: "par" + String(i).padStart(4, "0") + "xyz" })));
  assert.ok(results.every((r) => r.data.result === "ok"));
  const want = sizes.reduce((a, b) => a + b, 0);
  assert.equal((await call("GET", "/api/state", S)).data.total, want);
});

test("settings, recent list, log and reset", async () => {
  const { call } = fresh();
  const code = await codeOf(call);
  assert.equal((await call("POST", "/api/settings", A, { event: "Selam & Dawit, Dinner", expected: "150" })).status, 200);
  for (let i = 0; i < 15; i++) await call("POST", "/api/enter", S, { code, n: 1, rid: "log" + String(i).padStart(4, "0") + "abc" });
  const st = (await call("GET", "/api/state", S)).data;
  assert.equal(st.event, "Selam & Dawit, Dinner");
  assert.equal(st.expected, 150);
  assert.equal(st.total, 15);
  assert.equal(st.recent.length, 12);
  assert.ok(st.recent[0].at >= st.recent[11].at);
  assert.equal((await call("GET", "/api/log", S)).data.batches.length, 15);
  assert.equal((await call("POST", "/api/reset", A, {})).status, 200);
  assert.equal((await call("GET", "/api/state", S)).data.total, 0);
  // the code survives a reset, so images already sent keep working
  assert.equal((await call("POST", "/api/enter", S, { code, n: 1 })).data.result, "ok");
});

test("missing ADMIN_PIN is reported, not silently open", async () => {
  const saved = process.env.ADMIN_PIN;
  delete process.env.ADMIN_PIN;
  const { call } = fresh();
  const r = await call("GET", "/api/me", "");
  assert.equal(r.status, 500);
  assert.match(r.data.error, /ADMIN_PIN/);
  process.env.ADMIN_PIN = saved;
});
