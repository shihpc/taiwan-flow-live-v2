// 個股追蹤基本面：純函式離線單元測試（無需 token，mock FinMind／mock KV）
// 執行：cd worker && node test/fundamentals.mjs
import { pctChange, ppChange, buildRevenue, buildFinancials, buildNews, buildDividend, buildName, buildEvents, assembleNews, fundamentalsFor, fundamentalsBatch } from "../src/index.js";

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

// ---- buildNews：去重（同 link 多來源）＋降冪＋無 title 過濾 ----
{
  const rows = [
    { date: "2026-07-13 10:00:00", link: "http://a", source: "來源A", title: "營收創高" },
    { date: "2026-07-13 09:00:00", link: "http://a", source: "來源A鏡像", title: "營收創高（鏡像）" },  // 同 link → 去重
    { date: "2026-07-12 08:00:00", link: "http://b", source: "來源B", title: "法說會登場" },
    { date: "2026-07-11 08:00:00", link: "", source: "來源C", title: "" },                            // 無 title → 濾除
    { date: "2026-07-10 08:00:00", link: "", source: "來源D", title: "無連結新聞" },                   // 無 link 以 title 去重
  ];
  const n = buildNews(rows, 10);
  chk("buildNews 同 link 去重（5→3）", n.length === 3, String(n.length));
  chk("buildNews 降冪（最新在前）", n[0].link === "http://a" && n[0].date === "2026-07-13");
  chk("buildNews 媒體新聞 event=false 帶 link", n[0].event === false && n[0].link === "http://a");
  chk("buildNews date 截 10 碼", n[0].date.length === 10);
  chk("buildNews limit 生效", buildNews(rows, 1).length === 1);
}

// ---- buildDividend：取公告最新一筆、cash 回 FinMind 原值（抽核 2330 114年第4季）----
{
  const rows = [
    { year: "114年第3季", CashEarningsDistribution: 6.00003573, StockEarningsDistribution: 0, CashExDividendTradingDate: "2026-03-17", AnnouncementDate: "2026-03-02", date: "2026-03-23" },
    { year: "114年第4季", CashEarningsDistribution: 6.00003573, StockEarningsDistribution: 0, CashExDividendTradingDate: "2026-06-11", AnnouncementDate: "2026-05-27", date: "2026-06-17" },
    { year: "114年第2季", CashEarningsDistribution: 5.00001118, StockEarningsDistribution: 0, CashExDividendTradingDate: "2025-12-11", AnnouncementDate: "2025-11-26", date: "2025-12-17" },
  ];
  const dv = buildDividend(rows);
  chk("buildDividend 取公告最新（114年第4季）", dv.year === "114年第4季", dv.year);
  chk("buildDividend cash 回 FinMind 原值", dv.cash === 6.00003573, String(dv.cash));
  chk("buildDividend 除息日", dv.exDate === "2026-06-11", dv.exDate);
  chk("buildDividend 公告日", dv.announce === "2026-05-27", dv.announce);
  chk("buildDividend 無配息資料 → null", buildDividend([{ CashEarningsDistribution: 0, StockEarningsDistribution: 0 }]) === null);
}

// ---- buildName：TaiwanStockInfo 取 stock_name（多產業別列）----
{
  const rows = [
    { stock_id: "2330", stock_name: "台積電", industry_category: "半導體業" },
    { stock_id: "2330", stock_name: "台積電", industry_category: "電子工業" },
  ];
  chk("buildName 取 stock_name", buildName(rows, "2330") === "台積電");
  chk("buildName 無資料 → null", buildName([], "2330") === null);
}

// ---- buildEvents：業績事件生成（股利＋季財報＋月營收，墊底 ≥3）----
{
  const revenue = [
    { ym: "2026-04", rev: 3000e8, yoy: 50, announce: "2026-05-10" },
    { ym: "2026-05", rev: 3200e8, yoy: 55, announce: "2026-06-10" },
    { ym: "2026-06", rev: 4426.8e8, yoy: 67.9, announce: "2026-07-13" },
  ];
  const financials = [{ q: "2026Q1", date: "2026-03-31", eps: 22.08, net_margin: 50.51 }];
  const dividend = { cash: 6.00003573, stock: 0, exDate: "2026-06-11", announce: "2026-05-27", year: "114年第4季" };
  const ev = buildEvents(revenue, financials, dividend);
  chk("buildEvents 產出 ≥3", ev.length >= 3, String(ev.length));
  chk("buildEvents 皆 event=true 無外連", ev.every(e => e.event === true && e.link === null));
  chk("buildEvents 含營收事件（含億與 YoY 與公布日）", ev.some(e => /2026-06 營收 4426\.8 億 YoY \+67\.9%（公布 07\/13）/.test(e.title)), JSON.stringify(ev.map(e => e.title)));
  chk("buildEvents 含季財報事件（EPS 22.08）", ev.some(e => /2026Q1 財報 EPS 22\.08/.test(e.title)));
  chk("buildEvents 含股利事件（現金 6 元 除息 06\/11）", ev.some(e => /現金股利 6 元/.test(e.title) && /除息 06\/11/.test(e.title)), JSON.stringify(ev.map(e => e.title)));
  // 無媒體、無股利、無財報 → 仍以月營收墊底 ≥3
  const evOnlyRev = buildEvents(revenue, [], null);
  chk("buildEvents 僅月營收也墊底 ≥3", evOnlyRev.length >= 3, String(evOnlyRev.length));
}

// ---- assembleNews：合併去重降冪、保證 ≥3、冷門股（無媒體）以業績事件墊底 ----
{
  const revenue = [
    { ym: "2026-05", rev: 320e8, yoy: 55, announce: "2026-06-10" },
    { ym: "2026-06", rev: 442e8, yoy: 67.9, announce: "2026-07-13" },
    { ym: "2026-07", rev: 460e8, yoy: 40, announce: "2026-08-10" },
  ];
  const financials = [{ q: "2026Q1", date: "2026-03-31", eps: 22.08, net_margin: 50.51 }];
  const media = [
    { date: "2026-07-15 09:00:00", link: "http://m1", source: "媒體1", title: "熱門股大漲" },
    { date: "2026-07-14 09:00:00", link: "http://m1", source: "鏡像", title: "熱門股大漲鏡像" },  // 去重
  ];
  const hot = assembleNews(media, revenue, financials, null);
  chk("assembleNews 熱門股 ≥3", hot.length >= 3, String(hot.length));
  chk("assembleNews 含媒體新聞", hot.some(n => n.link === "http://m1" && n.event === false));
  chk("assembleNews 含業績事件", hot.some(n => n.event === true));
  chk("assembleNews 降冪排序", hot.every((n, i) => i === 0 || String(hot[i - 1].date) >= String(n.date)));
  const cold = assembleNews([], revenue, financials, null);   // 冷門股：無媒體
  chk("assembleNews 冷門股（無媒體）仍 ≥3（業績事件墊底）", cold.length >= 3, String(cold.length));
  chk("assembleNews 冷門股全為業績事件（無死路）", cold.every(n => n.event === true));
  // 熱門股：媒體遠超過 cap，業績事件仍必顯（保留名額）
  const manyMedia = Array.from({ length: 30 }, (_, i) => ({ date: `2026-07-${String(19 - (i % 10)).padStart(2, "0")} 09:00:00`, link: `http://big${i}`, source: "媒體", title: `新聞${i}` }));
  const big = assembleNews(manyMedia, revenue, financials, { cash: 6, stock: 0, exDate: "2026-06-11", announce: "2026-05-27", year: "114年第4季" });
  chk("assembleNews 媒體爆量仍含業績事件（保留名額）", big.some(n => n.event === true), String(big.filter(n => n.event).length));
  chk("assembleNews 媒體爆量仍含媒體新聞", big.some(n => n.event === false));
}

// ---- fundamentalsFor：擴充欄位（name/dividend/news）＋既有欄位不退化 ----
{
  const env = { FLOW_KV: mockKV(), FINMIND_TOKEN: "x" };
  const revData = [
    { revenue_year: 2026, revenue_month: 4, revenue: 3000e8, create_time: "2026-05-10" },
    { revenue_year: 2026, revenue_month: 5, revenue: 3200e8, create_time: "2026-06-10" },
    { revenue_year: 2026, revenue_month: 6, revenue: 4426.8e8, create_time: "2026-07-13" },
  ];
  const finData2 = [{ date: "2026-03-31", type: "Revenue", value: 2000 }, { date: "2026-03-31", type: "EPS", value: 22.08 }];
  const newsData = [{ date: "2026-07-13 10:00:00", link: "http://x", source: "媒體", title: "營收創高" }];
  const divData = [{ year: "114年第4季", CashEarningsDistribution: 6.0, StockEarningsDistribution: 0, CashExDividendTradingDate: "2026-06-11", AnnouncementDate: "2026-05-27", date: "2026-06-17" }];
  const infoData = [{ stock_id: "2330", stock_name: "台積電", industry_category: "半導體業" }];
  const mockFetch = async (u) => {
    let data = [];
    if (u.includes("MonthRevenue")) data = revData;
    else if (u.includes("FinancialStatements")) data = finData2;
    else if (u.includes("StockNews")) data = newsData;
    else if (u.includes("Dividend")) data = divData;
    else if (u.includes("StockInfo")) data = infoData;
    return { ok: true, json: async () => ({ status: 200, data }) };
  };
  const out = await fundamentalsFor(env, "2330", "2026-07-19", mockFetch);
  chk("fundamentalsFor name 非空", out.name === "台積電", out.name);
  chk("fundamentalsFor dividend 有值（cash=6）", out.dividend && out.dividend.cash === 6.0, JSON.stringify(out.dividend));
  chk("fundamentalsFor news ≥3（媒體＋業績事件）", out.news.length >= 3, String(out.news.length));
  chk("fundamentalsFor news 含媒體與業績事件", out.news.some(n => n.event === false) && out.news.some(n => n.event === true));
  chk("fundamentalsFor 既有 revenue/financials 不退化", out.revenue.length === 3 && out.financials.length === 1);
}

// ---- fundamentalsFor：新聞/股利/名稱 dataset 失敗時 additive 降級、不阻斷月營收/季財報 ----
{
  const env = { FLOW_KV: mockKV(), FINMIND_TOKEN: "x" };
  const revData = [{ revenue_year: 2026, revenue_month: 6, revenue: 250e8, create_time: "2026-07-13" }];
  const finData2 = [{ date: "2026-03-31", type: "Revenue", value: 2000 }, { date: "2026-03-31", type: "EPS", value: 7 }];
  const mockFetch = async (u) => {
    if (u.includes("StockNews") || u.includes("Dividend") || u.includes("StockInfo")) throw new Error("該表失敗");
    return { ok: true, json: async () => ({ status: 200, data: u.includes("MonthRevenue") ? revData : finData2 }) };
  };
  const out = await fundamentalsFor(env, "2330", "2026-07-19", mockFetch);
  chk("附屬表失敗仍回月營收/季財報", out.revenue.length === 1 && out.financials.length === 1);
  chk("附屬表失敗 name=null、dividend=null", out.name === null && out.dividend === null);
  chk("附屬表失敗 news 仍以業績事件墊底（≥1）", out.news.length >= 1 && out.news.every(n => n.event === true));
}

// ---- fundamentalsFor：KV 快取命中不重抓（mock KV + 會拋錯的 fetch）----
{
  const env = { FLOW_KV: mockKV(), FINMIND_TOKEN: "x" };
  await env.FLOW_KV.put("fund:4:2330:2026-07-19", JSON.stringify({ id: "2330", cached: true }));
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
  chk("miss 後寫入 KV 快取", env.FLOW_KV.store.has("fund:4:2330:2026-07-19"));
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
