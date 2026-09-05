// /livediag 唯讀時戳診斷 離線單元測試（2026-09-05）
// 無需 token、不打真實網路——fetch / caches / KV 全用 mock。
// 執行：cd worker && node test/livediag.mjs
import { readFileSync } from "node:fs";
import worker, { tsDiag, diagThrottle, aggregate, DIAG_OPEN_HM, DIAG_CLOSE_HM } from "../src/index.js";

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; } else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- 素材：兩檔有分類個股 + 一檔未分類 + 兩列指數 ----
const CL = { 2330: { e: "半導體", c: ["晶圓代工"], t: "twse", sh: 1000 },
             2317: { e: "電子", c: [], t: "twse", sh: 500 } };
const row = (code, date, extra = {}) => ({ stock_id: code, date, close: 100, total_amount: 1e6,
  total_volume: 10, change_rate: 1, change_price: 1, buy_volume: 5, sell_volume: 5, ...extra });

// ---- 情境 A：盤中（所有列都在正規盤內）----
{
  const rows = [
    row("2330", "2026-09-04 13:29:58.100000"),
    row("2317", "2026-09-04 13:12:51.000000"),
    row("6680", "2026-09-04 13:20:00.000000"),          // 未分類 → 不計入
    row("001", "2026-09-04 13:30:00.000000"),
    row("101", "2026-09-04 13:29:00.000000"),
  ];
  const d = tsDiag(CL, rows);
  chk("A schema=1", d.schema === 1);
  chk("A 時窗預設 09:00–13:30", d.window.open === "09:00" && d.window.close === "13:30"
    && DIAG_OPEN_HM === "09:00" && DIAG_CLOSE_HM === "13:30");
  chk("A ts_current = max(有分類個股 date)", d.ts_current === "2026-09-04 13:29:58.100000", d.ts_current);
  chk("A ts_regular 與 ts_current 相同（全在正規盤內）", d.ts_regular === d.ts_current);
  chk("A ts_index 逐列吐出 001/101", d.ts_index.twse === "2026-09-04 13:30:00.000000"
    && d.ts_index.tpex === "2026-09-04 13:29:00.000000");
  chk("A 指數列不進 classified 計數", d.classified.n === 2, JSON.stringify(d.classified));
  chk("A regular=2 late=0 pre_open=0",
    d.classified.regular === 2 && d.classified.late === 0 && d.classified.pre_open === 0);
  chk("A 未分類列另計", d.unclassified === 1);
  chk("A rows_total = 全部列數", d.rows_total === 5);
  chk("A dates 去重", eq(d.dates, ["2026-09-04"]));
}

// ---- 情境 B（分水嶺・部分保留）：收盤後，部分列仍是正規盤時戳 ----
// → 候選一（≤13:30 過濾取 max）拿得到 13:29，可行
{
  const rows = [
    row("2330", "2026-09-04 15:00:00.000000"),          // 盤後零股定盤把 max 推上去
    row("2317", "2026-09-04 13:29:30.000000"),          // 保留正規盤真實時戳
    row("001", "2026-09-04 13:30:00.000000"),
  ];
  const d = tsDiag(CL, rows);
  chk("B ts_current 被盤後列推到 15:00", d.ts_current === "2026-09-04 15:00:00.000000");
  chk("B ts_regular 過濾後得正規盤 max", d.ts_regular === "2026-09-04 13:29:30.000000", d.ts_regular);
  chk("B ts_le_close 同值（無盤前列時兩門檻一致）", d.ts_le_close === d.ts_regular);
  chk("B classified.regular>0＝候選一可行", d.classified.regular === 1 && d.classified.late === 1);
  chk("B latest 樣本以 date 由新到舊", d.latest[0].code === "2330" && d.latest[1].code === "2317");
}

// ---- 情境 C（分水嶺・全部改寫）：非交易日，所有列都被改寫成盤前殘留時戳（08:30）----
// → 單邊門檻 ≤13:30 濾不掉 08:30（這正是要加下界的理由）；加了 09:00 下界後
//   ts_regular 為 null，即「ts 只能回 null」的那一支
{
  const rows = [
    row("2330", "2026-08-29 08:30:00.000000"),
    row("2317", "2026-08-29 08:30:00.000000"),
    row("001", "2026-08-29 08:30:00.000000"),
  ];
  const d = tsDiag(CL, rows);
  chk("C ts_current = 殘留時戳", d.ts_current === "2026-08-29 08:30:00.000000");
  chk("C ts_le_close 濾不掉 08:30（單邊門檻不夠用）", d.ts_le_close === "2026-08-29 08:30:00.000000");
  chk("C ts_regular = null（09:00 下界濾掉盤前殘留）", d.ts_regular === null, String(d.ts_regular));
  chk("C 全數落在 pre_open", d.classified.pre_open === 2 && d.classified.regular === 0
    && d.classified.late === 0);
}

// ---- 情境 C2：盤前殘留與正規盤列並存（分水嶺的「部分保留」形狀）----
{
  const rows = [
    row("2330", "2026-08-29 08:30:00.000000"),          // 盤前殘留
    row("2317", "2026-08-28 13:29:45.000000"),          // 前一盤真實時戳
  ];
  const d = tsDiag(CL, rows);
  chk("C2 ts_current 被 08-29 殘留列拉走（日期不是資料日）", d.ts_current === "2026-08-29 08:30:00.000000");
  chk("C2 ts_regular 取回 08-28 正規盤 max", d.ts_regular === "2026-08-28 13:29:45.000000", d.ts_regular);
  chk("C2 pre_open=1 regular=1", d.classified.pre_open === 1 && d.classified.regular === 1);
  chk("C2 dates 兩天並存＝殘留跨日的直接證據", eq(d.dates, ["2026-08-28", "2026-08-29"]));
}

// ---- 情境 D：跨日 + 分桶直方圖 ----
{
  const rows = [
    row("2330", "2026-09-04 13:29:58.100000"),
    row("2317", "2026-09-04 13:29:58.900000"),          // 同一 HH:MM 桶 → 併桶
    row("2330", "2026-09-03 09:05:00.000000"),
    row("2317", "2026-09-03 09:05:10.000000"),
    row("2330", "2026-09-04 14:30:00.000000"),
    row("2317", ""),                                     // 無 date
  ];
  const d = tsDiag(CL, rows);
  chk("D 分桶鍵＝YYYY-MM-DD HH:MM（保留日期部分才能跨日區分）",
    eq(d.hist, [{ t: "2026-09-03 09:05", n: 2 }, { t: "2026-09-04 13:29", n: 2 }, { t: "2026-09-04 14:30", n: 1 }]),
    JSON.stringify(d.hist));
  chk("D hist 依時間升序", d.hist.every((h, i, a) => i === 0 || a[i - 1].t <= h.t));
  chk("D 無 date 的列進 no_date、不進 hist", d.classified.no_date === 1);
  chk("D dates 去重排序", eq(d.dates, ["2026-09-03", "2026-09-04"]));
  chk("D 不吐原始列，只吐 ≤8 筆 latest 樣本", d.latest.length <= 8 && !("rows" in d));
}

// ---- 情境 E：自訂時窗 ----
{
  const rows = [row("2330", "2026-09-04 12:00:00.000000"), row("2317", "2026-09-04 13:00:00.000000")];
  chk("E close=12:30 只留 12:00 那列", tsDiag(CL, rows, { close: "12:30" }).ts_regular === "2026-09-04 12:00:00.000000");
  chk("E open=12:30 只留 13:00 那列", tsDiag(CL, rows, { open: "12:30" }).ts_regular === "2026-09-04 13:00:00.000000");
  chk("E 時窗回寫進輸出", eq(tsDiag(CL, rows, { open: "10:00", close: "12:30" }).window,
    { open: "10:00", close: "12:30" }));
}

// ---- 節流 ----
{
  const st = { date: "", used: 0, last: 0 };
  const a = diagThrottle(1_000_000, "2026-09-05", st, 30000, 3);
  chk("節流 首次放行", a.ok === true && a.used === 1);
  chk("節流 間隔不足擋下", diagThrottle(1_010_000, "2026-09-05", st, 30000, 3).reason === "too_frequent");
  chk("節流 retry_after_s 有值", diagThrottle(1_010_000, "2026-09-05", st, 30000, 3).retry_after_s === 20);
  chk("節流 間隔足夠放行", diagThrottle(1_040_000, "2026-09-05", st, 30000, 3).ok === true);
  chk("節流 第三次放行", diagThrottle(1_080_000, "2026-09-05", st, 30000, 3).ok === true);
  const cap = diagThrottle(1_200_000, "2026-09-05", st, 30000, 3);
  chk("節流 到日上限擋下", cap.ok === false && cap.reason === "daily_cap" && cap.cap === 3);
  const next = diagThrottle(1_300_000, "2026-09-06", st, 30000, 3);
  chk("節流 跨台北日重置", next.ok === true && next.used === 1);
}

// ---- tsDiag 不變更輸入、不影響 aggregate ----
{
  const rows = [row("2330", "2026-09-04 15:00:00.000000"), row("2317", "2026-09-04 13:29:30.000000"),
    row("001", "2026-09-04 13:30:00.000000", { total_amount: 5e8 })];
  const before = JSON.stringify(rows);
  const a1 = aggregate(CL, rows, {}, null);
  tsDiag(CL, rows);
  const a2 = aggregate(CL, rows, {}, null);
  chk("tsDiag 不 mutate rows", JSON.stringify(rows) === before);
  delete a1.generated_at; delete a2.generated_at;
  chk("tsDiag 前後 aggregate 輸出一致", eq(a1, a2));
  chk("aggregate 頂層欄位集合未變（/live 契約）",
    eq(Object.keys(a1).sort(), ["chain", "chain_coverage", "exchange", "generated_at", "index",
      "market", "stock_cols", "stocks", "ts"].filter((k) => k !== "generated_at").sort()),
    JSON.stringify(Object.keys(a1).sort()));
}

// ---- 路由整合：/livediag 與 /live 互不污染（mock fetch / caches / KV）----
{
  const SNAP = [
    { stock_id: "2330", date: "2026-09-04 15:00:00.000000", close: 100, total_amount: 1e6,
      total_volume: 10, change_rate: 1, change_price: 1, buy_volume: 5, sell_volume: 5 },
    { stock_id: "2317", date: "2026-09-04 13:29:30.000000", close: 50, total_amount: 2e6,
      total_volume: 20, change_rate: -1, change_price: -1, buy_volume: 7, sell_volume: 8 },
    { stock_id: "001", date: "2026-09-04 13:30:00.000000", close: 20000, total_amount: 5e11,
      total_volume: 1e6, change_rate: 0.5, change_price: 100 },
  ];
  const hits = [];
  const origFetch = globalThis.fetch, origCaches = globalThis.caches;
  globalThis.fetch = async (u) => {
    const s = String(u && u.url ? u.url : u);
    hits.push(s.split("?")[0]);
    if (s.includes("taiwan_stock_tick_snapshot")) return new Response(JSON.stringify({ status: 200, data: SNAP }));
    if (s.includes("classify.json")) return new Response(JSON.stringify({ map: CL }));
    if (s.includes("lastweek.json")) return new Response(JSON.stringify({ stocks: {}, tot: {} }));
    if (s.includes("baseline.json")) return new Response(JSON.stringify({ stocks: {} }));
    return new Response(JSON.stringify({ data: [] }));
  };
  const store = new Map();
  globalThis.caches = { default: {
    match: async (k) => store.get(String(k.url)) || null,
    put: async (k, v) => { store.set(String(k.url), v); },
  } };
  const env = { FINMIND_TOKEN: "x", DATA_BASE: "https://example.invalid/data", LIVE_TTL: 15,
    FLOW_KV: { get: async () => null, put: async () => {} } };
  const ctx = { waitUntil: () => {} };
  const call = async (p) => (await worker.fetch(new Request(`https://w.invalid${p}`), env, ctx)).json();

  const live1 = await call("/live");
  const diag = await call("/livediag");
  store.clear();                                   // 清快取，讓第二次 /live 真的重建
  const live2 = await call("/live");

  chk("路由 /livediag 回診斷形狀", diag.schema === 1 && Array.isArray(diag.hist), JSON.stringify(diag).slice(0, 120));
  chk("路由 /livediag 給得出兩個候選", diag.ts_regular === "2026-09-04 13:29:30.000000"
    && diag.ts_index.twse === "2026-09-04 13:30:00.000000");
  chk("路由 /live 不含任何診斷欄位",
    !["schema", "hist", "ts_regular", "ts_le_close", "ts_index", "ts_current", "classified",
      "latest", "window", "rows_total", "unclassified", "dates"]
      .some((k) => k in live1), Object.keys(live1).join(","));
  chk("路由 /live 的 ts 仍是原口徑 max(date)", live1.ts === "2026-09-04 15:00:00.000000", live1.ts);
  const norm = (o) => { const c = { ...o }; delete c.generated_at; return JSON.stringify(c); };
  chk("路由 打過 /livediag 後 /live 回傳零改動", norm(live1) === norm(live2));
  chk("路由 /livediag 沒污染 /live 的 cf 快取 key", ![...store.keys()].some((k) => k.includes("livediag")),
    [...store.keys()].join(","));
  chk("路由 /livediag 打的是未快取即時快照", hits.filter((h) => h.includes("tick_snapshot")).length >= 2);
  chk("路由 /livediag 不寫 KV", true);   // env.FLOW_KV.put 未被呼叫（下方以 spy 驗）

  globalThis.fetch = origFetch;
  globalThis.caches = origCaches;
}

// ---- /livediag 唯讀（不寫 KV）----
{
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const s = String(u);
    if (s.includes("taiwan_stock_tick_snapshot")) return new Response(JSON.stringify({ status: 200, data: [] }));
    return new Response(JSON.stringify({ map: {} }));
  };
  let puts = 0;
  const env = { FINMIND_TOKEN: "x", DATA_BASE: "https://example.invalid/data",
    FLOW_KV: { get: async () => null, put: async () => { puts += 1; } } };
  await worker.fetch(new Request("https://w.invalid/livediag"), env, { waitUntil: () => {} });
  chk("唯讀 /livediag 全程零 KV put", puts === 0);
  globalThis.fetch = origFetch;
}

// ---- 根路徑 endpoints 清單刻意不列 /livediag（低頻＋不張揚）----
{
  const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf-8");
  const line = src.split("\n").find((l) => l.includes('service: "taiwan-flow-v2"'));
  chk("根路徑 endpoints 不含 /livediag", !!line && !line.includes("/livediag"));
}

console.log(`livediag: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
