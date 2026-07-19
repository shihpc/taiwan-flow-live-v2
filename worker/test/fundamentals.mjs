// 個股追蹤基本面：純函式離線單元測試（無需 token，mock FinMind／mock KV）
// 執行：cd worker && node test/fundamentals.mjs
import { pctChange, ppChange, buildRevenue, buildFinancials, fundamentalsFor, fundamentalsBatch } from "../src/index.js";

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; } else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}
function mockKV() {
  const store = new Map();
  return {
    store,
    async get(key, type) { const v = store.get(key); if (v === undefined) return null; return type === "json" ? JSON.parse(v) : v; },
    async put(key, value) { store.set(key, value); },
  };
}

// ---- pctChange / ppChange ----
{
  chk("pctChange 相對%", pctChange(250, 200) === 25, String(pctChange(250, 200)));
  chk("pctChange 負分母取絕對值", pctChange(-50, -100) === 50, String(pctChange(-50, -100)));
  chk("pctChange prev=0 → null", pctChange(10, 0) === null);
  chk("pctChange 缺值 → null", pctChange(null, 5) === null && pctChange(5, null) === null);
  chk("ppChange 百分點差", ppChange(66.25, 58.8) === 7.45, String(ppChange(66.25, 58.8)));
  chk("ppChange 缺值 → null", ppChange(null, 5) === null);
}

// ---- buildRevenue：MoM/YoY 以 revenue_year+revenue_month 對月，非 date ----
{
  const rows = [
    { revenue_year: 2025, revenue_month: 6, revenue: 100, create_time: "2025-07-10" },
    { revenue_year: 2026, revenue_month: 5, revenue: 200, create_time: "2026-06-10" },
    { revenue_year: 2026, revenue_month: 6, revenue: 250, create_time: "2026-07-13" },
  ];
  const rev = buildRevenue(rows, 24);
  const jun = rev.find((x) => x.ym === "2026-06");
  chk("buildRevenue ym 由 year+month 推", jun && jun.ym === "2026-06");
  chk("buildRevenue MoM 對上月(200→250)=25", jun.mom === 25, String(jun.mom));
  chk("buildRevenue YoY 對去年同月(100→250)=150", jun.yoy === 150, String(jun.yoy));
  chk("buildRevenue announce=create_time", jun.announce === "2026-07-13", String(jun.announce));
  const may = rev.find((x) => x.ym === "2026-05");
  chk("buildRevenue 無對照月 MoM/YoY=null", may.mom === null && may.yoy === null);
  chk("buildRevenue 升冪排序", rev[rev.length - 1].ym === "2026-06");
}

// ---- buildFinancials：三率 / QoQ / YoY（含真值抽核 2330 2026Q1 比例）----
{
  const rows = [
    // 2025Q1（去年同季）
    { date: "2025-03-31", type: "Revenue", value: 1000 }, { date: "2025-03-31", type: "GrossProfit", value: 500 },
    { date: "2025-03-31", type: "OperatingIncome", value: 400 }, { date: "2025-03-31", type: "IncomeAfterTaxes", value: 300 },
    { date: "2025-03-31", type: "EPS", value: 3 },
    // 2025Q4（上一季）
    { date: "2025-12-31", type: "Revenue", value: 1600 }, { date: "2025-12-31", type: "GrossProfit", value: 960 },
    { date: "2025-12-31", type: "OperatingIncome", value: 640 }, { date: "2025-12-31", type: "IncomeAfterTaxes", value: 480 },
    { date: "2025-12-31", type: "EPS", value: 5 },
    // 2026Q1（本季）
    { date: "2026-03-31", type: "Revenue", value: 2000 }, { date: "2026-03-31", type: "GrossProfit", value: 1200 },
    { date: "2026-03-31", type: "OperatingIncome", value: 900 }, { date: "2026-03-31", type: "IncomeAfterTaxes", value: 700 },
    { date: "2026-03-31", type: "EPS", value: 7 },
  ];
  const fin = buildFinancials(rows, 10);
  const q = fin.find((x) => x.q === "2026Q1");
  chk("buildFinancials 季別由 date 推(2026Q1)", !!q);
  chk("三率 gross=1200/2000=60", q.gross_margin === 60, String(q.gross_margin));
  chk("三率 op=900/2000=45", q.op_margin === 45, String(q.op_margin));
  chk("三率 net=700/2000=35", q.net_margin === 35, String(q.net_margin));
  chk("QoQ eps (7-5)/5=40", q.qoq.eps === 40, String(q.qoq.eps));
  chk("QoQ rev (2000-1600)/1600=25", q.qoq.rev === 25, String(q.qoq.rev));
  chk("QoQ gross_margin pp(60-60)=0", q.qoq.gross_margin === 0, String(q.qoq.gross_margin));
  chk("YoY eps (7-3)/3=133.33", q.yoy.eps === 133.33, String(q.yoy.eps));
  chk("YoY gross_margin pp(60-50)=10", q.yoy.gross_margin === 10, String(q.yoy.gross_margin));
  chk("最舊季無對照 → qoq/yoy null", fin[0].qoq === null && fin[0].yoy === null);
}

// ---- 抽核：真值 2330 2026Q1（buildFinancials 對 FinMind 原值手算一致）----
{
  const rows = [
    { date: "2026-03-31", type: "Revenue", value: 1134103440000 },
    { date: "2026-03-31", type: "GrossProfit", value: 751295421000 },
    { date: "2026-03-31", type: "OperatingIncome", value: 658966142000 },
    { date: "2026-03-31", type: "IncomeAfterTaxes", value: 572801304000 },
    { date: "2026-03-31", type: "EPS", value: 22.08 },
  ];
  const q = buildFinancials(rows)[0];
  chk("2330 2026Q1 毛利率=66.25", q.gross_margin === 66.25, String(q.gross_margin));
  chk("2330 2026Q1 營益率=58.1", q.op_margin === 58.1, String(q.op_margin));
  chk("2330 2026Q1 淨利率=50.51", q.net_margin === 50.51, String(q.net_margin));
  chk("2330 2026Q1 EPS=22.08", q.eps === 22.08, String(q.eps));
}

// ---- fundamentalsFor：KV 快取命中不重抓（mock KV + 會拋錯的 fetch）----
{
  const env = { FLOW_KV: mockKV(), FINMIND_TOKEN: "x" };
  await env.FLOW_KV.put("fund:2330:2026-07-19", JSON.stringify({ id: "2330", cached: true }));
  const throwFetch = async () => { throw new Error("不應被呼叫"); };
  const out = await fundamentalsFor(env, "2330", "2026-07-19", throwFetch);
  chk("KV 命中直接回快取、不打 FinMind", out.cached === true);
}

// ---- fundamentalsFor：miss 打 FinMind、寫入快取 ----
{
  const env = { FLOW_KV: mockKV(), FINMIND_TOKEN: "x" };
  const revData = [{ revenue_year: 2026, revenue_month: 6, revenue: 250, create_time: "2026-07-13" }];
  const finData2 = [{ date: "2026-03-31", type: "Revenue", value: 2000 }, { date: "2026-03-31", type: "EPS", value: 7 }];
  const mockFetch = async (u) => ({ ok: true, json: async () => ({ status: 200, data: u.includes("MonthRevenue") ? revData : finData2 }) });
  const out = await fundamentalsFor(env, "2330", "2026-07-19", mockFetch);
  chk("miss 後回真實結構", out.revenue.length === 1 && out.financials.length === 1);
  chk("miss 後寫入 KV 快取", env.FLOW_KV.store.has("fund:2330:2026-07-19"));
}

// ---- fundamentalsBatch：某股 FinMind 失敗回 {error} 不整批倒（重試後仍失敗）----
{
  const env = { FLOW_KV: mockKV(), FINMIND_TOKEN: "x" };
  const revData = [{ revenue_year: 2026, revenue_month: 6, revenue: 250 }];
  const finData2 = [{ date: "2026-03-31", type: "Revenue", value: 2000 }];
  // 2330 成功、9999 每次 fetch 皆失敗
  const mockFetch = async (u) => {
    if (u.includes("data_id=9999")) throw new Error("boom");
    return { ok: true, json: async () => ({ status: 200, data: u.includes("MonthRevenue") ? revData : finData2 }) };
  };
  const batch = await fundamentalsBatch(env, ["2330", "9999"], "2026-07-19", mockFetch);
  const ok = batch.find((x) => x.id === "2330"), bad = batch.find((x) => x.id === "9999");
  chk("批次好股正常回資料", ok && ok.revenue && !ok.error);
  chk("批次壞股回 {id,error} 不整批倒", bad && bad.error && bad.id === "9999", JSON.stringify(bad));
  chk("批次長度=2（不因單股失敗而少）", batch.length === 2);
}

// ---- 防迴歸：worker 原始碼無 .list( 呼叫 ----
{
  const src = await (await import("node:fs/promises")).readFile(new URL("../src/index.js", import.meta.url), "utf-8");
  chk("worker 原始碼無 .list( 呼叫", !src.includes(".list("));
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} 通過 / ${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
