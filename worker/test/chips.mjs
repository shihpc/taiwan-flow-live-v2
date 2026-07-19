// 個股追蹤籌碼面：純函式離線單元測試（無需 token，mock FinMind／mock KV）
// 執行：cd worker && node test/chips.mjs
import { chipStreak, buildInst, buildMargin, buildSBL, buildDayTrade, buildForeignHold, buildBigHolder, chipsFor, chipsBatch } from "../src/index.js";

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

// ---- chipStreak：連續同號天數（正買負賣，0 中止）----
{
  chk("chipStreak 連買3日=+3", chipStreak([-1, 5, 8, 3]) === 3, String(chipStreak([-1, 5, 8, 3])));
  chk("chipStreak 連賣2日=-2", chipStreak([9, -4, -2]) === -2, String(chipStreak([9, -4, -2])));
  chk("chipStreak 最近=0 → 0", chipStreak([5, 5, 0]) === 0);
  chk("chipStreak 空陣列 → 0", chipStreak([]) === 0);
}

// ---- buildInst：三大法人歸併（外資含 Foreign_Dealer_Self）、淨買賣張、sum5、streak ----
{
  const rows = [
    { date: "2026-07-16", name: "Foreign_Investor", buy: 3000000, sell: 1000000 },   // +2000 張
    { date: "2026-07-16", name: "Foreign_Dealer_Self", buy: 0, sell: 0 },
    { date: "2026-07-16", name: "Investment_Trust", buy: 500000, sell: 100000 },       // +400 張
    { date: "2026-07-16", name: "Dealer_self", buy: 200000, sell: 100000 },            // 自營 +100
    { date: "2026-07-16", name: "Dealer_Hedging", buy: 300000, sell: 100000 },         // 自營 +200 → 合 +300
    { date: "2026-07-17", name: "Foreign_Investor", buy: 1000000, sell: 5000000 },     // -4000 張
    { date: "2026-07-17", name: "Investment_Trust", buy: 100000, sell: 100000 },       // 0
    { date: "2026-07-17", name: "Dealer_self", buy: 100000, sell: 50000 },             // +50
    { date: "2026-07-17", name: "Dealer_Hedging", buy: 0, sell: 0 },
  ];
  const inst = buildInst(rows);
  chk("buildInst 外資末日淨=-4000張", inst.foreign[inst.foreign.length - 1].v === -4000, String(inst.foreign.at(-1).v));
  chk("buildInst 自營合併 Dealer_self+Hedging=+300", inst.dealer[0].v === 300, String(inst.dealer[0].v));
  chk("buildInst sum5 外資=2000+(-4000)=-2000", inst.sum5.foreign === -2000, String(inst.sum5.foreign));
  chk("buildInst 外資 streak（買後賣，末日賣）=-1", inst.streak.foreign === -1, String(inst.streak.foreign));
  chk("buildInst 升冪含日期", inst.foreign[0].d === "2026-07-16" && inst.foreign[1].d === "2026-07-17");
  chk("buildInst 無資料 → null", buildInst([]) === null);
}

// ---- buildMargin：融資餘額/增減/券資比/序列 ----
{
  const rows = [
    { date: "2026-07-16", MarginPurchaseTodayBalance: 32918, MarginPurchaseYesterdayBalance: 33293, ShortSaleTodayBalance: 38, ShortSaleYesterdayBalance: 19 },
    { date: "2026-07-17", MarginPurchaseTodayBalance: 33373, MarginPurchaseYesterdayBalance: 32918, ShortSaleTodayBalance: 64, ShortSaleYesterdayBalance: 38 },
  ];
  const m = buildMargin(rows);
  chk("buildMargin 融資餘額=33373張", m.bal === 33373, String(m.bal));
  chk("buildMargin 融資增減=+455張", m.chg === 455, String(m.chg));
  chk("buildMargin 融券餘額=64、增減=+26", m.short_bal === 64 && m.short_chg === 26, `${m.short_bal}/${m.short_chg}`);
  chk("buildMargin 券資比=64/33373*100=0.19%", m.credit_ratio === 0.19, String(m.credit_ratio));
  chk("buildMargin 序列末=33373", m.series.at(-1).v === 33373 && m.series.length === 2);
  chk("buildMargin 無資料 → null", buildMargin([]) === null);
}

// ---- buildSBL：借券餘額（股→張）＋增減 ----
{
  const rows = [
    { date: "2026-07-16", SBLShortSalesCurrentDayBalance: 11974514, SBLShortSalesPreviousDayBalance: 11977514 },
    { date: "2026-07-17", SBLShortSalesCurrentDayBalance: 12349514, SBLShortSalesPreviousDayBalance: 11974514 },
  ];
  const s = buildSBL(rows);
  chk("buildSBL 餘額=12350張（12349514/1000四捨五入）", s.bal === 12350, String(s.bal));
  chk("buildSBL 增減=+375張", s.chg === 375, String(s.chg));
  chk("buildSBL 無資料 → null", buildSBL([]) === null);
}

// ---- buildDayTrade：當沖量÷成交量（末日對齊 price）----
{
  const dt = [{ date: "2026-07-16", Volume: 6394000 }, { date: "2026-07-17", Volume: 11455000 }];
  const price = [{ date: "2026-07-16", Trading_Volume: 30538604 }, { date: "2026-07-17", Trading_Volume: 97362670 }];
  const d = buildDayTrade(dt, price);
  chk("buildDayTrade 當沖比 11455000/97362670=11.77%", d.ratio === 11.77, String(d.ratio));
  chk("buildDayTrade 對齊末日", d.date === "2026-07-17");
  chk("buildDayTrade 缺 price 該日 → ratio null", buildDayTrade(dt, []).ratio === null);
}

// ---- buildForeignHold：外資持股率＋區間 pp 變化 ----
{
  const rows = [
    { date: "2026-07-13", ForeignInvestmentSharesRatio: 69.58 },
    { date: "2026-07-17", ForeignInvestmentSharesRatio: 69.34 },
  ];
  const f = buildForeignHold(rows);
  chk("buildForeignHold 末日持股率=69.34", f.ratio === 69.34, String(f.ratio));
  chk("buildForeignHold 區間變化=-0.24pp", f.chg === -0.24, String(f.chg));
  chk("buildForeignHold 無資料 → null", buildForeignHold([]) === null);
}

// ---- buildBigHolder：>1000張級距持股比＋週變化；空 → null（降級）----
{
  const rows = [
    { date: "2026-07-09", HoldingSharesLevel: "more than 1,000,001", percent: 85.01 },
    { date: "2026-07-09", HoldingSharesLevel: "total", percent: 100.0 },
    { date: "2026-07-17", HoldingSharesLevel: "more than 1,000,001", percent: 84.91 },
    { date: "2026-07-17", HoldingSharesLevel: "total", percent: 100.0 },
  ];
  const b = buildBigHolder(rows);
  chk("buildBigHolder 末週千張持股比=84.91", b.ratio === 84.91, String(b.ratio));
  chk("buildBigHolder 週變化=-0.10pp", b.wchg === -0.1, String(b.wchg));
  chk("buildBigHolder 資料週日期=末週", b.date === "2026-07-17");
  chk("buildBigHolder 付費層取不到（null/空）→ null", buildBigHolder(null) === null && buildBigHolder([]) === null);
}

// ---- 抽核：真值 2330（2026-07-17，對 FinMind 原值手算一致）----
{
  const inst = buildInst([
    { date: "2026-07-17", name: "Foreign_Investor", buy: 17479318, sell: 61663282 },
    { date: "2026-07-17", name: "Foreign_Dealer_Self", buy: 0, sell: 0 },
  ]);
  chk("2330 07-17 外資買賣超=-44184張", inst.foreign[0].v === -44184, String(inst.foreign[0].v));
  const m = buildMargin([{ date: "2026-07-17", MarginPurchaseTodayBalance: 33373, MarginPurchaseYesterdayBalance: 32918, ShortSaleTodayBalance: 81, ShortSaleYesterdayBalance: 38 }]);
  chk("2330 07-17 融資增減=+455張、券資比=81/33373=0.24%", m.chg === 455 && m.credit_ratio === 0.24, `${m.chg}/${m.credit_ratio}`);
}

// ---- chipsFor：KV 命中不重抓 ----
{
  const env = { FLOW_KV: mockKV(), FINMIND_TOKEN: "x" };
  await env.FLOW_KV.put("chips:2330:2026-07-19", JSON.stringify({ id: "2330", cached: true }));
  const throwFetch = async () => { throw new Error("不應被呼叫"); };
  const out = await chipsFor(env, "2330", "2026-07-19", throwFetch);
  chk("KV 命中直接回快取、不打 FinMind", out.cached === true);
}

// ---- chipsFor：miss 打 FinMind、千張大戶付費取不到降級、寫入快取 ----
{
  const env = { FLOW_KV: mockKV(), FINMIND_TOKEN: "x" };
  const data = {
    TaiwanStockInstitutionalInvestorsBuySell: [{ date: "2026-07-17", name: "Foreign_Investor", buy: 17479318, sell: 61663282 }],
    TaiwanStockMarginPurchaseShortSale: [{ date: "2026-07-17", MarginPurchaseTodayBalance: 33373, MarginPurchaseYesterdayBalance: 32918, ShortSaleTodayBalance: 64, ShortSaleYesterdayBalance: 38 }],
    TaiwanDailyShortSaleBalances: [{ date: "2026-07-17", SBLShortSalesCurrentDayBalance: 12349514, SBLShortSalesPreviousDayBalance: 11974514 }],
    TaiwanStockDayTrading: [{ date: "2026-07-17", Volume: 11455000 }],
    TaiwanStockPrice: [{ date: "2026-07-17", Trading_Volume: 97362670 }],
    TaiwanStockShareholding: [{ date: "2026-07-17", ForeignInvestmentSharesRatio: 69.34 }],
  };
  const mockFetch = async (u) => {
    const ds = decodeURIComponent(u).match(/dataset=([A-Za-z]+)/)[1];
    if (ds === "TaiwanStockHoldingSharesPer") throw new Error("402 付費層");   // 模擬付費層取不到
    return { ok: true, json: async () => ({ status: 200, data: data[ds] || [] }) };
  };
  const out = await chipsFor(env, "2330", "2026-07-19", mockFetch);
  chk("miss 後三大法人正確", out.inst.foreign[0].v === -44184, String(out.inst && out.inst.foreign[0].v));
  chk("miss 後融資/券資比正確", out.margin.chg === 455 && out.margin.credit_ratio === 0.19);
  chk("miss 後借券/當沖/外資持股正確", out.sbl.chg === 375 && out.daytrade.ratio === 11.77 && out.foreign_hold.ratio === 69.34);
  chk("千張大戶付費取不到 → big null＋big_note", out.big === null && !!out.big_note, JSON.stringify(out.big_note));
  chk("miss 後寫入 KV 快取", env.FLOW_KV.store.has("chips:2330:2026-07-19"));
}

// ---- chipsBatch：某股 FinMind 全失敗回 {error}／查無回 {error} 不整批倒 ----
{
  const env = { FLOW_KV: mockKV(), FINMIND_TOKEN: "x" };
  const good = { TaiwanStockMarginPurchaseShortSale: [{ date: "2026-07-17", MarginPurchaseTodayBalance: 100, MarginPurchaseYesterdayBalance: 90, ShortSaleTodayBalance: 5, ShortSaleYesterdayBalance: 4 }] };
  const mockFetch = async (u) => {
    if (u.includes("data_id=9999")) throw new Error("boom");        // 每個 dataset 皆失敗
    if (u.includes("data_id=8888")) return { ok: true, json: async () => ({ status: 200, data: [] }) };  // 查無資料
    const ds = decodeURIComponent(u).match(/dataset=([A-Za-z]+)/)[1];
    return { ok: true, json: async () => ({ status: 200, data: good[ds] || [] }) };
  };
  const batch = await chipsBatch(env, ["2330", "9999", "8888"], "2026-07-19", mockFetch);
  const ok = batch.find((x) => x.id === "2330"), bad = batch.find((x) => x.id === "9999"), empty = batch.find((x) => x.id === "8888");
  chk("批次好股正常回資料", ok && ok.margin && !ok.error);
  chk("批次全失敗股回 {id,error}", bad && bad.error && bad.id === "9999", JSON.stringify(bad));
  chk("批次查無資料股回 {id,error}（全欄 null）", empty && empty.error === "查無籌碼資料", JSON.stringify(empty));
  chk("批次長度=3（不因單股失敗而少）", batch.length === 3);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} 通過 / ${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
