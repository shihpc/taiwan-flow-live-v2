// /live stale-while-revalidate in-flight 去重＋量測 離線單元測試（2026-09-06）
// 無需 token、不打網路——buildLive / caches.default / Date.now 全由 serveLive 的 deps 注入 mock。
// 執行：cd worker && node test/swr.mjs
import { serveLive, liveSwrStats, _resetLiveSwr, LIVE_STALE_MS } from "../src/index.js";

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; } else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}

// ---- mock：caches.default（以 URL 為 key，match 每次回 clone，模擬 CF Cache API 每次給新 Response）----
function mockCache() {
  const store = new Map();
  return {
    store,
    async match(req) { const r = store.get(req.url); return r ? r.clone() : undefined; },
    async put(req, resp) { store.set(req.url, resp); },
  };
}
// mock：ctx.waitUntil 收集背景 promise，測試端可 await 全部完成
function mockCtx() { const pending = []; return { pending, waitUntil(p) { pending.push(p); } }; }
// mock：可控時鐘＋可控 buildLive（延遲一個 tick 才 resolve，讓並發請求真的重疊）
const URL_LIVE = new URL("https://worker.example/live");
const tick = () => new Promise((r) => setTimeout(r, 5));
function mkBuild(payload, { fail = false } = {}) {
  const b = { calls: 0 };
  b.fn = async () => { b.calls += 1; await tick(); if (fail) throw new Error("FinMind down"); return payload(); };
  return b;
}
const PAYLOAD_A = { ts: "2026-09-04 13:29:58.100000", stocks: { 2330: [1, 2] }, gen: "A" };
const PAYLOAD_B = { ts: "2026-09-04 13:30:00.000000", stocks: { 2330: [3, 4] }, gen: "B" };

// ---- 情境 1：cache 空（miss）→ 三個併發請求只觸發一次 buildLive，三個都拿到資料 ----
{
  _resetLiveSwr();
  let t = 1_000_000;
  const now = () => t;
  const cache = mockCache(), ctx = mockCtx();
  const b = mkBuild(() => PAYLOAD_A);
  const env = { LIVE_TTL: "15" };
  const deps = { buildLive: b.fn, cache, now };
  const rs = await Promise.all([serveLive(env, ctx, URL_LIVE, deps), serveLive(env, ctx, URL_LIVE, deps), serveLive(env, ctx, URL_LIVE, deps)]);
  chk("miss：三併發只跑一次 buildLive", b.calls === 1, String(b.calls));
  const bodies = await Promise.all(rs.map((r) => r.json()));
  chk("miss：三個回應都拿到完整 payload（各自獨立 body）", bodies.every((j) => j.gen === "A" && j.stocks["2330"]));
  chk("miss：x-swr=miss", rs.every((r) => r.headers.get("x-swr") === "miss"));
  chk("miss：x-gen 為時鐘值", rs.every((r) => r.headers.get("x-gen") === String(t)));
  chk("miss：Cache-Control 沿用 max-age=120", rs[0].headers.get("Cache-Control") === "public, max-age=120");
  chk("miss：快取已寫入且不帶 x-swr", cache.store.has(URL_LIVE.toString()) && !cache.store.get(URL_LIVE.toString()).headers.get("x-swr"));
  const st = liveSwrStats();
  chk("stats：misses=3 rebuilds=1 coalesced=2", st.misses === 3 && st.rebuilds === 1 && st.coalesced === 2, JSON.stringify(st));
  chk("stats：lastGen 記下重建時鐘、inflight 已清空", st.lastGen === t && st.inflight === false);
  chk("stats：帶 isolate 級註記", typeof st.note === "string" && st.note.includes("isolate"));

  // ---- 情境 2：fresh（age < LIVE_TTL）→ 直接回快取，不重建 ----
  t += 5_000;
  const r2 = await serveLive(env, ctx, URL_LIVE, deps);
  chk("fresh：不觸發 buildLive", b.calls === 1, String(b.calls));
  chk("fresh：x-swr=fresh", r2.headers.get("x-swr") === "fresh");
  chk("fresh：x-gen 仍是舊值", r2.headers.get("x-gen") === String(1_000_000));
  chk("fresh：body 為快取內容", (await r2.json()).gen === "A");
  chk("stats：freshHits=1", liveSwrStats().freshHits === 1);
  chk("fresh：無背景工作", ctx.pending.length === 0);

  // ---- 情境 3：stale（LIVE_TTL ≤ age < LIVE_STALE_MS）→ 先回舊資料，三併發只背景重建一次 ----
  t += 25_000;   // age = 30s
  const b2 = mkBuild(() => PAYLOAD_B);
  const deps2 = { buildLive: b2.fn, cache, now };
  const rs3 = await Promise.all([serveLive(env, ctx, URL_LIVE, deps2), serveLive(env, ctx, URL_LIVE, deps2), serveLive(env, ctx, URL_LIVE, deps2)]);
  chk("stale：三個回應都立刻拿到舊 payload", (await Promise.all(rs3.map((r) => r.json()))).every((j) => j.gen === "A"));
  chk("stale：x-swr=stale", rs3.every((r) => r.headers.get("x-swr") === "stale"));
  chk("stale：背景工作交給 waitUntil（3 筆，皆共用 in-flight）", ctx.pending.length === 3, String(ctx.pending.length));
  await Promise.all(ctx.pending);
  chk("stale：三併發只跑一次 buildLive", b2.calls === 1, String(b2.calls));
  const st3 = liveSwrStats();
  chk("stats：staleHits=3 rebuilds=2 coalesced=4", st3.staleHits === 3 && st3.rebuilds === 2 && st3.coalesced === 4, JSON.stringify(st3));
  chk("stats：lastGen 更新為重建時鐘", st3.lastGen === t);
  // 重建完成後下一請求 → fresh 且拿到新 payload
  const r4 = await serveLive(env, ctx, URL_LIVE, deps2);
  chk("stale 後：快取已換新（x-gen 更新、body 為 B）", r4.headers.get("x-gen") === String(t) && (await r4.json()).gen === "B");
  chk("stale 後：x-swr=fresh", r4.headers.get("x-swr") === "fresh");

  // ---- 情境 4：太舊（age ≥ LIVE_STALE_MS）→ 同步重建（miss 路徑）----
  t += LIVE_STALE_MS + 1;
  const b3 = mkBuild(() => PAYLOAD_A);
  const r5 = await serveLive(env, ctx, URL_LIVE, { buildLive: b3.fn, cache, now });
  chk("太舊：走同步重建，x-swr=miss", r5.headers.get("x-swr") === "miss" && b3.calls === 1);
  chk("太舊：x-gen 為新時鐘", r5.headers.get("x-gen") === String(t));
}

// ---- 情境 5：重建失敗 → 回 error、in-flight 清空、下一請求可重試成功 ----
{
  _resetLiveSwr();
  let t = 5_000_000;
  const now = () => t;
  const cache = mockCache(), ctx = mockCtx();
  const env = {};   // LIVE_TTL 未設 → 預設 15s
  const bad = mkBuild(() => PAYLOAD_A, { fail: true });
  const rs = await Promise.all([serveLive(env, ctx, URL_LIVE, { buildLive: bad.fn, cache, now }),
    serveLive(env, ctx, URL_LIVE, { buildLive: bad.fn, cache, now })]);
  chk("失敗：兩併發只跑一次 buildLive", bad.calls === 1, String(bad.calls));
  const errs = await Promise.all(rs.map((r) => r.json()));
  chk("失敗：兩個回應都拿到 error 訊息", errs.every((j) => j.error === "FinMind down"));
  chk("失敗：no-store＋x-swr=miss", rs.every((r) => r.headers.get("Cache-Control") === "no-store" && r.headers.get("x-swr") === "miss"));
  chk("失敗：快取未寫入", cache.store.size === 0);
  const st = liveSwrStats();
  chk("stats：rebuildFails=1、inflight 已清空", st.rebuildFails === 1 && st.inflight === false, JSON.stringify(st));
  // 下一請求（上游恢復）→ 可重試，成功
  const good = mkBuild(() => PAYLOAD_B);
  const r = await serveLive(env, ctx, URL_LIVE, { buildLive: good.fn, cache, now });
  chk("失敗後重試：成功重建", good.calls === 1 && (await r.json()).gen === "B" && r.headers.get("x-swr") === "miss");
  chk("stats：rebuilds=2 rebuildFails=1", liveSwrStats().rebuilds === 2 && liveSwrStats().rebuildFails === 1);

  // stale 區背景重建失敗：仍回舊資料，且 in-flight 清空（下一輪可再試）
  t += 30_000;
  const bad2 = mkBuild(() => PAYLOAD_A, { fail: true });
  const rs2 = await serveLive(env, ctx, URL_LIVE, { buildLive: bad2.fn, cache, now });
  chk("stale 背景失敗：仍回舊資料 x-swr=stale", rs2.headers.get("x-swr") === "stale" && (await rs2.json()).gen === "B");
  await Promise.all(ctx.pending);
  chk("stale 背景失敗：in-flight 清空、rebuildFails=2", liveSwrStats().inflight === false && liveSwrStats().rebuildFails === 2);
  chk("stale 背景失敗：快取仍是舊的 B", cache.store.get(URL_LIVE.toString()).headers.get("x-gen") === String(5_000_000));
}

// ---- 情境 6：LIVE_TTL 由 env 決定（30s 時 age=20s 仍 fresh；未設走 15s）----
{
  _resetLiveSwr();
  let t = 9_000_000;
  const now = () => t;
  const cache = mockCache(), ctx = mockCtx();
  const b = mkBuild(() => PAYLOAD_A);
  await serveLive({ LIVE_TTL: "30" }, ctx, URL_LIVE, { buildLive: b.fn, cache, now });
  t += 20_000;
  const r = await serveLive({ LIVE_TTL: "30" }, ctx, URL_LIVE, { buildLive: b.fn, cache, now });
  chk("LIVE_TTL=30：age 20s → fresh", r.headers.get("x-swr") === "fresh" && b.calls === 1);
  const r2 = await serveLive({}, ctx, URL_LIVE, { buildLive: b.fn, cache, now });
  chk("LIVE_TTL 未設（15s）：同一 age 20s → stale", r2.headers.get("x-swr") === "stale");
  await Promise.all(ctx.pending);
  chk("_resetLiveSwr 歸零", (_resetLiveSwr(), liveSwrStats().rebuilds === 0 && liveSwrStats().lastGen === null));
}

console.log(`${fail ? "FAIL" : "PASS"}  ${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
