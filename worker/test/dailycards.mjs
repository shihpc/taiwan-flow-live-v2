// LINE 圖卡資料組裝層（Phase B1）離線單元測試（無需 token/網路）
// 執行：cd worker && node test/dailycards.mjs
// 守的規格：docs/line-cards-spec.md 第 9.3 節驗收條件。
// fixture 皆從 2026-07-24 真實 data/ 檔抄縮減版（每源 3~5 筆），baseline 用 Phase A 後 schema。
import { buildDailyCards, fxRegime, FX_CARD_BUILDERS,
  cardBubble, buildCardCarousels, cardsFallbackText,
  FX_ACTIVE_CARDS, FX_FORBIDDEN, FX_LONGFORM_CARD, FX_NEUTRALIZE, fxNeutralize,
  assertCardAllowed } from "../src/index.js";

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; } else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}

// ---- fixtures（縮減自真檔）----
// totals：21 個交易日、taiex 緩升（末日 > 20MA → bull）；含一筆 null（實檔 2026-06-30 為 null 的同款情境）
function mkTotals({ bear = false, days = 22 } = {}) {
  const dates = [], rows = {};
  for (let i = 0; i < days; i++) {
    const d = `2026-06-${String(i + 1).padStart(2, "0")}`;
    dates.push(d);
    const taiex = i === 3 ? null : (bear ? 46000 - i * 100 : 44000 + i * 100);
    rows[d] = {
      tse: { f_net_k: -60950489, t_net_k: 4763491, d_net_k: -11151495, turnover_k: 827129512 },
      otc: { f_net_k: -6252746, t_net_k: 1088025, d_net_k: -1234567, turnover_k: 60240000 },
      taiex,
    };
  }
  return { dates, rows };
}
const FIX = () => ({
  dateStr: "2026-07-24",
  baseline: {  // Phase A 後 schema：stocks [a5,it,fi,y1,y2,ints,nl,its,nh,a20]、subs_y [y1,y2,C,R]
    date: "2026-07-24", tot5: 1109333144542,
    stocks: {
      "3231": [5e9, 2, 3, 1, 0, 12.3, 0, 0, 0, 4e9],    // 土洋同買＋追高警示
      "2454": [9e9, 2, 2, 1, 1, 8.0, 0, 0, 0, 7e9],     // 土洋同買＋追高警示
      "2330": [5e10, 0, 1, 0, 0, 3.2, 0, 0, 1, 4.5e10], // 突破新高
      "3481": [8e8, 0, 0, 0, 0, -1.0, 1, 0, 0, 1e9],    // 跌破新低
      "6669": [6e9, 1, 0, -1, 0, -12.5, 0, 2, 0, 5e9],  // 退出＋法人賣
      "9997": [3e7, 2, 2, 1, 0, 89.4, 0, 0, 1, 2.5e7],  // 冷門股：全訊號命中但當日額<1億，必須被流動性過濾擋下
    },
    subs_y: { "運算設備": [1, 0, 2.1, 0.034], "晶圓製造": [1, 1, 1.8, 0.021], "金屬零件": [-1, 0, null, null] },
  },
  flowsDaily: {  // taiwan-flows data/daily/*.json 同款 cols（張/千元/%）
    date: "2026-07-24",
    cols: ["code", "close", "chg_pct", "vol", "amt", "t_net", "t_amt", "f_net", "f_amt", "d_net", "d_amt",
      "t_inv", "f_shares", "f_pct", "f_buy", "f_sell", "t_buy", "t_sell", "d_buy", "d_sell"],
    rows: [
      ["3231", 179, 3.17, 32435, 12000000, 100, 500000, 32435, 5805883, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      ["2454", 1300, 1.2, 5000, 9000000, 50, 300000, 3000, 3290026, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      ["2330", 2340, -2.9, 60000, 140000000, 0, 0, -190, -446500, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      ["3481", 49.5, -3.0, 20000, 990000, 0, 0, -100, -49500, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      ["6669", 3950, -1.5, 3000, 11850000, -50, -197500, -200, -790000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      ["9997", 30, 5.0, 100, 30000, 10, 300, 50, 1500, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ],
  },
  totals: mkTotals(),
  daysummary: {
    date: "2026-07-24",
    index: { tse: { val: 43654.84, chgP: -1195.97, chg: -2.66, amt_yi: 7780.1 },
      otc: { val: 377.63, chgP: -14.48, chg: -3.69, amt_yi: 1862 } },
    breadth: { up: 612, down: 1483 },
    tone: "大盤 -1196.0 點（-2.66%）；廣度 漲612／跌1483；全日成交佔比最高 晶圓製造（19.1%），貢獻最強 電信服務業（+7.6 點）。",
    stocks_top5: [{ c: "6669", n: "緯穎", pts: 15.29 }, { c: "3231", n: "緯創", pts: 5.54 }],
    stocks_bot3: [{ c: "2330", n: "台積電", pts: -451.39 }, { c: "2308", n: "台達電", pts: -78.1 }],
    subs_top5: [{ n: "電信服務業", pts: 7.64, amt_yi: 55.6, share_pct: 0.7, n_stk: 4 },
      { n: "貨櫃航運", pts: 5.13, amt_yi: 46.7, share_pct: 0.6, n_stk: 5 }],
    subs_bot3: [{ n: "晶圓製造", pts: -544.89, amt_yi: 1483.9, share_pct: 19.1, n_stk: 15 }],
    subs_stocks: {   // 2026-08-16 新欄（ov-6 改版）：每業貢獻絕對值前 3 檔
      "電信服務業": [{ c: "2412", n: "中華電", pts: 5.1 }, { c: "3045", n: "台灣大", pts: 1.8 },
        { c: "4904", n: "遠傳", pts: 0.7 }],
      "晶圓製造": [{ c: "2330", n: "台積電", pts: -451.39 }, { c: "2303", n: "聯電", pts: -12.2 },
        { c: "6770", n: "力積電", pts: -3.1 }],
    },
    chain_top5: [{ n: "電信網路", pts: 8.1, amt_yi: 60.2, share_pct: 0.8, n_stk: 6 }],   // Phase A 補欄
    chain_bot3: [{ n: "半導體", pts: -600.4, amt_yi: 2100.5, share_pct: 27.0, n_stk: 40 }],
    subs_all: [{ n: "電信服務業", pts: 7.64, amt_yi: 55.6, share_pct: 0.7, n_stk: 4 },
      { n: "貨櫃航運", pts: 5.13, amt_yi: 46.7, share_pct: 0.6, n_stk: 5 },
      { n: "晶圓製造", pts: -544.89, amt_yi: 1483.9, share_pct: 19.1, n_stk: 15 }],
    share_top: { n: "晶圓製造", pts: -544.89, amt_yi: 1483.9, share_pct: 19.1, n_stk: 15 },
    pts_top: { n: "電信服務業", pts: 7.64, amt_yi: 55.6, share_pct: 0.7, n_stk: 4 },
  },
  vix: { price: 26800, contract: "202608", vix: 38.2 },
  flowsLatest: {
    date: "2026-07-24",
    pages: {
      foreign: {
        buy_by_amt: [{ code: "3231", name: "緯創", net_amt_k: 5805883 }, { code: "6488", name: "環球晶", net_amt_k: 3290026 }],
        sell_by_amt: [{ code: "2330", name: "台積電", net_amt_k: -30160000 }],
        futures_card: { date: "2026-07-24", oi_net_lots: -76260, oi_net_amount_k: -668364,
          vs_prev_month_lots: 6803, prev_month_end: "2026-06-30" },
      },
      trust: {
        buy_by_amt: [{ code: "2454", name: "聯發科", net_amt_k: 1500000 }],
        sell_by_amt: [{ code: "2303", name: "聯電", net_amt_k: -800000 }],
      },
      etf: { stats: {
        all: { count: 343, mktcap_k: 10804111003, turnover_k: 69314575, f_amt_k: -7104642, t_amt_k: 146183, d_amt_k: -13071112 },
        nonbond: { count: 227, mktcap_k: 7920273917, turnover_k: 64565945, f_amt_k: -7404677, t_amt_k: 119372, d_amt_k: -12793246 },
        bond: { count: 116, mktcap_k: 2883837086, turnover_k: 4748630, f_amt_k: 300035, t_amt_k: 26811, d_amt_k: -277866 },
      } },
    },
  },
  foreignHistory: {
    latest_date: "2026-07-24",
    daily: {
      "2026-07-18": { tse: { net_k: 5000000 }, otc: { net_k: 100000 } },   // 週六前（上週五）
      "2026-07-21": { tse: { net_k: 17343993 }, otc: { net_k: -6258028 } },
      "2026-07-22": { tse: { net_k: 17343993 }, otc: { net_k: -6258028 } },
      "2026-07-23": { tse: { net_k: 6957913 }, otc: { net_k: -5264683 } },
      "2026-07-24": { tse: { net_k: -60950489 }, otc: { net_k: -6252746 } },
    },
  },
  lastweek: { week: "2026-07-13", generated_at: "2026-07-20T12:32:31+08:00",
    stocks: { "2330": 6e11, "3231": 9e10, "2454": 4.5e10 }, tot: { twse: 5.5e12, tpex: 1.16e12 } },
  aetfLatest: { run_date: "2026-07-24", etfs: {} },   // 組裝層目前不消費，佔位驗容錯
  aetfDiff: {
    primary_date: "2026/07/24",
    etfs: {
      "00400A": { name: "主動國泰動能高息", aum: null, twse_aum_yi: 261.89, est_flow: 0, n_buy: 0, n_sell: 0 },
      "00401A": { name: "主動摩根台灣鑫收", aum: 2702280029, twse_aum_yi: 27.0, est_flow: 0, n_buy: 1, n_sell: 1 },
      "00405A": { name: "主動統一台股增長", aum: null, twse_aum_yi: 380.5, est_flow: 0, n_buy: 1, n_sell: 1 },
    },
    stocks: [
      { c: "6669", n: "緯穎", zh: 140, val: 802200000, rzh: 140, rval: 802200000 },
      { c: "2330", n: "台積電", zh: -190, val: -446500000, rzh: -190, rval: -446500000 },
      { c: "8210", n: "勤誠", zh: -50, val: -54000000, rzh: -50, rval: -54000000 },
    ],
  },
  postmkt: {
    date: "2026-07-24",
    blocktrade: { date: "2026-07-24", rows: [
      { c: "3665", n: "貿聯-KY", type: "配對交易", price: 2320, vol: 252000, money: 584640000 },
      { c: "2330", n: "台積電", type: "配對交易", price: 2353.48, vol: 70500, money: 165920340 },
    ] },
    lending: { date: "2026-07-24", rows: [
      { c: "3481", n: "群創", plat_total: 959956, sbl_short_bal: 798919, margin_bal: 120000 },
      { c: "2330", n: "台積電", plat_total: 500000, sbl_short_bal: 300000, margin_bal: 30000 },
      { c: "2454", n: "聯發科", plat_total: 200000, sbl_short_bal: 900000, margin_bal: 250000 },
    ] },
  },
  mktbal: {
    latest_date: "2026-07-24",
    daily: [
      { date: "2026-07-23", margin_shares: 9349915, margin_money: 582626351000, sbl_short_shares: 30114887000, sbl_short_value: 3675432234940 },
      { date: "2026-07-24", margin_shares: 9354810, margin_money: 577059537000, sbl_short_shares: 29678608000, sbl_short_value: 3546326606150 },
    ],
  },
  morning: {
    date: "2026-07-24",
    chips: {
      inst: { date: "2026-07-23", foreign: 69.6, trust: 73.7, dealer: 42.0 },
      it3: [{ c: "2454", n: "聯發科" }, { c: "1303", n: "南亞" }],
      it3_sell: [{ c: "2303", n: "聯電" }],
      aetf: ["多檔同買：貿聯-KY、南亞塑膠", "次產業最大加碼：電池管理系統 10.4億"],
      aetf_date: "2026/07/23",
    },
  },
  summaryPm: {   // postmkt data/summary/20260724-pm.json 縮減版（AI 長文；刻意留禁用字驗中性化）
    date: "2026-07-24", slot: "pm",
    synthesis: { text: [
      "## 綜合研判",
      "大盤收 43654.84 點、下跌 1195.97 點（-2.66%），成交 7780 億元，廣度漲 612 跌 1483。",
      "外資賣超 609.5 億元、投信買超 47.6 億元；資金自晶圓製造流出，轉進電信服務業與貨櫃航運。",
      "次產業中運算設備買盤最強，連兩日出現土洋同買；晶圓製造則由借券賣壓主導。",
      "後續觀察：外資台指期未平倉淨空 76,260 口、較上月底增加，短線震盪風險仍在。",
    ].join("\n") },
  },
  us: {
    date: "2026-07-23",
    brief: "7/23美股大跌，費半-0.5%，台積ADR-1.3%(溢價+12%)，電子開盤中性，特斯拉-14.5%領跌。",
    groups: [
      { g: "指數", rows: [{ s: "^GSPC", n: "S&P 500", c: 7408.3, chg: -1.21, d: "2026-07-23" },
        { s: "^IXIC", n: "那斯達克", c: 25137.69, chg: -2.15, d: "2026-07-23" }] },
      { g: "台股ADR", rows: [{ s: "TSM", n: "台積電ADR", c: 415.58, chg: -1.34, d: "2026-07-23" }] },
    ],
  },
});

const ALL_IDS = FX_CARD_BUILDERS.map(([id]) => id);
const B_IDS = ["v2-rank-1", "flows-foreign-1", "flows-trust-1", "pm-aetf-2", "pm-aetf-4",
  "pm-aetf-5", "pm-lending-3", "pm-lending-4", "pm-lending-6"];
const SIG_IDS = ["sig-sub-surge", "sig-dual-buy", "sig-new-high", "sig-new-low", "sig-exit-sell", "sig-surge-warn"];

// ---- 1. 完整 fixture → 35 張全產出 ----
{
  const { cards, skipped } = buildDailyCards(FIX());
  chk("builder 表共 35 張", FX_CARD_BUILDERS.length === 35, `${FX_CARD_BUILDERS.length}`);
  chk("完整 fixture 35 張全產出", cards.length === 35, `cards=${cards.length} skipped=${JSON.stringify(skipped)}`);
  chk("skipped 空", skipped.length === 0, JSON.stringify(skipped));
  chk("id 集合與 builder 表一致", JSON.stringify(cards.map((c) => c.id)) === JSON.stringify(ALL_IDS));
  chk("每張卡 sub 帶資料日", cards.every((c) => /資料日/.test(c.sub || "")),
    cards.filter((c) => !/資料日/.test(c.sub || "")).map((c) => c.id).join(","));
  chk("每張卡有 rows 或 paras", cards.every((c) => (c.rows || []).length || (c.paras || []).length));
  // C 類不在組裝表內
  chk("C 類 5 張不在表內", !ALL_IDS.some((id) =>
    ["flows-sync-1", "flows-sync-2", "flows-oppose-1", "flows-oppose-2", "pm-aetf-1"].includes(id)));
  chk("第二期圖表卡不在表內", !ALL_IDS.includes("v2-ov-9") && !ALL_IDS.includes("v2-ov-10"));
}
// ---- 2. 排序正確性抽查 ----
{
  const { cards } = buildDailyCards(FIX());
  const by = (id) => cards.find((c) => c.id === id);
  const c1 = by("sig-sub-surge");
  chk("卡1 依 R 降序", c1.rows[0].m === "運算設備" && c1.rows[1].m === "晶圓製造",
    JSON.stringify(c1.rows.map((r) => r.m)));
  const c2 = by("sig-dual-buy");
  chk("卡2 依 f_amt 降序（3231 5805883k > 2454 3290026k）",
    c2.rows[0].l === "3231" && c2.rows[1].l === "2454", JSON.stringify(c2.rows));
  chk("卡2 名稱由跨源 join 取得", c2.rows[0].m === "緯創");
  const c3 = by("sig-new-high");
  chk("卡3 只收 nh==1", c3.rows.length === 1 && c3.rows[0].l === "2330");
  chk("卡3 note 標母體無正超額", /超額為負|41\.7/.test(c3.foot || c3.note || ""));
  const c4 = by("sig-new-low");
  chk("卡4 note 標未排除跌停", /未排除跌停/.test(c4.note));
  const c5 = by("sig-exit-sell");
  chk("卡5 note 標不排序", /不排序/.test(c5.note) && /順序不含強弱/.test(c5.note));
  const c6 = by("sig-surge-warn");
  chk("卡6 S 值降序（2454 S=9e9/7e9? no：amt*1000/a5→2454 1.0x < 3231 2.4x）",
    c6.rows[0].l === "3231", JSON.stringify(c6.rows));
  chk("卡6 note 標不代表強弱", /不代表強弱/.test(c6.note));
  const g = by("v2-global-1");
  chk("global-1 VIX 值帶入", JSON.stringify(g.rows).includes("38.2"));
  const r1 = by("v2-rank-1");
  chk("rank-1 依佔比降序（2330 最大）", r1.rows[0].l === "2330", JSON.stringify(r1.rows[0]));
  chk("rank-1 括號帶上週佔比", /上週/.test(r1.rows[0].r));
  const l4 = by("pm-lending-4");
  chk("lending-4 依 sbl_short_bal 降序（2454 900000 居首）", l4.rows[0].l === "2454");
  const ff = by("flows-ff-1");
  chk("ff-1 近5日新→舊＋本週累計（本週=07-21..24 共4日）",
    ff.rows[0].m === "07-24" && /本週累計（4日）/.test(ff.rows[ff.rows.length - 1].m), JSON.stringify(ff.rows.map((r) => r.m)));
}
// ---- 2b. 2026-08-16 改版卡：v2-dash-1 三合一看板／ov-6 個股小字／aetf-5 排行形 ----
{
  const { cards } = buildDailyCards(FIX());
  const by = (id) => cards.find((c) => c.id === id);
  // ① v2-dash-1：三源齊 → 9 列（加權/櫃買/成交值/漲跌家數/外資/投信/自營/期指OI/較上月底）
  const dash = by("v2-dash-1");
  chk("dash-1 三源齊 → 9 列", dash && dash.rows.length === 9,
    dash && JSON.stringify(dash.rows.map((r) => r.m)));
  chk("dash-1 列序＝加權→櫃買→成交值→漲跌家數→法人→期指",
    dash && dash.rows.map((r) => r.m).join("|")
      === "加權|櫃買|成交值|漲跌家數|外資|投信|自營|台指期外資淨未平倉|較上月底（2026-06-30）",
    dash && dash.rows.map((r) => r.m).join("|"));
  chk("dash-1 成交值＝上市＋櫃買成交金額（億）",
    dash && dash.rows[2].r === "上市7780.1億｜櫃買1862.0億", dash && dash.rows[2].r);
  chk("dash-1 法人淨額沿 hdr-1 口徑（外資 tse+otc 合計 -672.0 億）",
    dash && dash.rows[4].r === "-672.0億" && dash.rows[4].c === "down", dash && JSON.stringify(dash.rows[4]));
  chk("dash-1 期指沿 hdr-2 口徑（-76260口／較上月底+6803口）",
    dash && dash.rows[7].r === "-76260口" && dash.rows[8].r === "+6803口",
    dash && JSON.stringify(dash.rows.slice(7)));
  chk("dash-1 標題＝今日總結、sub 帶資料日", dash && dash.title === "今日總結" && /資料日 2026-07-24/.test(dash.sub));
  // ② ov-6：每列附該業貢獻絕對值前 3 檔（r2 小字）；無 subs_stocks 的業別不帶 r2
  const ov6 = by("v2-ov-6");
  chk("ov-6 首列帶個股小字（電信服務業前3檔）",
    ov6 && ov6.rows[0].r2 === "中華電+5.1、台灣大+1.8、遠傳+0.7", ov6 && ov6.rows[0].r2);
  chk("ov-6 晶圓製造列帶負貢獻個股", ov6 && ov6.rows[2].r2 === "台積電-451.4、聯電-12.2、力積電-3.1",
    ov6 && ov6.rows[2].r2);
  chk("ov-6 subs_stocks 無該業（貨櫃航運）→ 該列無 r2", ov6 && ov6.rows[1].r2 === undefined,
    ov6 && JSON.stringify(ov6.rows[1]));
  // ③ aetf-5：paras → rows 排行形（加碼前5＋減碼前5，{l,m,r,r2,c}）
  const a5 = by("pm-aetf-5");
  chk("aetf-5 改 rows 形（無 paras）", a5 && (a5.rows || []).length === 3 && !(a5.paras || []).length,
    a5 && JSON.stringify(a5));
  chk("aetf-5 首列＝加碼金額最大（6669 +8.0億／+140張）",
    a5 && a5.rows[0].l === "6669" && a5.rows[0].r === "+8.0億" && a5.rows[0].r2 === "+140張"
      && a5.rows[0].c === "up", a5 && JSON.stringify(a5.rows[0]));
  chk("aetf-5 減碼組依 val 升序（2330 在 8210 前）且 c=down",
    a5 && a5.rows[1].l === "2330" && a5.rows[2].l === "8210" && a5.rows[1].c === "down",
    a5 && JSON.stringify(a5.rows.slice(1)));
}
// ---- 2c. v2-dash-1 部分降級：某源缺→省該組列；三源全缺才 skip ----
{
  const dashOf = (fx) => {
    const { cards, skipped } = buildDailyCards(fx);
    return { card: cards.find((c) => c.id === "v2-dash-1"), skipped };
  };
  const noDs = FIX(); noDs.daysummary = null;
  const a = dashOf(noDs);
  chk("缺 daysummary → dash 照發、無加權/成交值列（5 列）", a.card && a.card.rows.length === 5
    && !a.card.rows.some((r) => r.m === "加權" || r.m === "成交值"),
    a.card && JSON.stringify(a.card.rows.map((r) => r.m)));
  chk("缺 daysummary → sub 退 totals 末日", a.card && /資料日 2026-06-22/.test(a.card.sub), a.card && a.card.sub);
  const noTot = FIX(); noTot.totals = null;
  const b = dashOf(noTot);
  chk("缺 totals → dash 照發、無法人列（6 列）", b.card && b.card.rows.length === 6
    && !b.card.rows.some((r) => r.m === "外資"), b.card && JSON.stringify(b.card.rows.map((r) => r.m)));
  const noFl = FIX(); noFl.flowsLatest = null;
  const c = dashOf(noFl);
  chk("缺 flowsLatest → dash 照發、無期指列（7 列）", c.card && c.card.rows.length === 7
    && !c.card.rows.some((r) => /台指期/.test(r.m)), c.card && JSON.stringify(c.card.rows.map((r) => r.m)));
  const none = FIX(); none.daysummary = null; none.totals = null; none.flowsLatest = null;
  const d = dashOf(none);
  chk("三源全缺 → dash skip（理由標三源全缺）", !d.card
    && /三源全缺/.test((d.skipped.find((s) => s.id === "v2-dash-1") || {}).reason || ""),
    JSON.stringify(d.skipped.find((s) => s.id === "v2-dash-1")));
}
// ---- 2d. ov-6 對舊資料（無 subs_stocks 欄）優雅降級：退回現行純次產業列 ----
{
  const fx = FIX(); delete fx.daysummary.subs_stocks;
  const { cards } = buildDailyCards(fx);
  const ov6 = cards.find((c) => c.id === "v2-ov-6");
  chk("無 subs_stocks 欄 → ov-6 照發、全列無 r2", ov6 && ov6.rows.length === 3
    && ov6.rows.every((r) => r.r2 === undefined), ov6 && JSON.stringify(ov6.rows));
}
// ---- 3. B 類 9 張 note 標排序欄位 ----
{
  const { cards } = buildDailyCards(FIX());
  for (const id of B_IDS) {
    const c = cards.find((x) => x.id === id);
    chk(`B 類 ${id} note 標排序依據`, c && /依.+(降序|排序|分組)/.test(c.note || ""), c && c.note);
  }
}
// ---- 4. regime 閘門：空頭只抑制卡 1/2，卡 3-6 不變 ----
{
  chk("fxRegime bull", fxRegime(mkTotals()).regime === "bull");
  chk("fxRegime bear", fxRegime(mkTotals({ bear: true })).regime === "bear");
  chk("fxRegime 不足20筆 → bull＋未判定", (() => { const r = fxRegime(mkTotals({ days: 10 }));
    return r.regime === "bull" && r.undetermined === true; })());
  const fx = FIX(); fx.totals = mkTotals({ bear: true });
  const { cards, skipped } = buildDailyCards(fx);
  const sk = Object.fromEntries(skipped.map((s) => [s.id, s.reason]));
  chk("空頭：卡1 skipped reason=regime-bear", sk["sig-sub-surge"] === "regime-bear");
  chk("空頭：卡2 skipped reason=regime-bear", sk["sig-dual-buy"] === "regime-bear");
  chk("空頭：卡3-6 照常產出", ["sig-new-high", "sig-new-low", "sig-exit-sell", "sig-surge-warn"]
    .every((id) => cards.some((c) => c.id === id)));
  chk("空頭：其餘 33 張不受影響", cards.length === 33, `${cards.length}`);
  // regime 未判定 → 卡1/2 照發並在 note 標註
  const fx2 = FIX(); fx2.totals = mkTotals({ days: 10 });
  const r2 = buildDailyCards(fx2);
  const c1 = r2.cards.find((c) => c.id === "sig-sub-surge");
  chk("regime 未判定：卡1 照發＋note 標註", c1 && /regime 未判定/.test(c1.note));
}
// ---- 5. 逐源缺失 → 對應卡 skipped、其他不受影響 ----
{
  const DEP = {   // 來源鍵 → 預期受影響卡
    // 2026-08-07 收緊：長文卡的日期守門要求 dataDate 必須存在（沒有可信資料日就
    // 無從核對摘要是不是當日的），故缺 baseline 時它也一起 skip
    baseline: [...SIG_IDS, "pm-summary-1"].sort(),
    flowsDaily: ["sig-dual-buy", "sig-surge-warn", "v2-rank-1"],
    daysummary: ["v2-global-1", "v2-ov-1", "v2-ov-5", "v2-ov-6", "v2-ov-7", "v2-ov-8",
      "v2-ov-14", "v2-chain-1", "news-morning-3"],
    flowsLatest: ["flows-hdr-2", "flows-etf-1", "flows-foreign-1", "flows-trust-1"],
    foreignHistory: ["flows-ff-1"],
    postmkt: ["pm-block-1", "pm-lending-3", "pm-lending-4", "pm-lending-6"],
    mktbal: ["pm-mktbal-1", "pm-mktbal-2"],
    morning: ["news-morning-2"],
    us: ["news-morning-4"],
    aetfDiff: ["pm-aetf-2", "pm-aetf-4", "pm-aetf-5"],
    summaryPm: ["pm-summary-1"],
  };
  for (const [src, ids] of Object.entries(DEP)) {
    const fx = FIX(); fx[src] = null;
    const { cards, skipped } = buildDailyCards(fx);
    const skIds = skipped.map((s) => s.id).sort();
    chk(`缺 ${src} → 只有對應卡 skipped`, JSON.stringify(skIds) === JSON.stringify([...ids].sort()),
      `skipped=${JSON.stringify(skIds)}`);
    chk(`缺 ${src} → 其餘 ${35 - ids.length} 張照常`, cards.length === 35 - ids.length, `${cards.length}`);
  }
  // totals 缺：flows-hdr-1 skipped，卡1/2 因 regime 未判定仍照發
  { const fx = FIX(); fx.totals = null;
    const { cards, skipped } = buildDailyCards(fx);
    chk("缺 totals → 只有 flows-hdr-1 skipped（卡1/2 視為未判定照發）",
      skipped.length === 1 && skipped[0].id === "flows-hdr-1" && cards.length === 34,
      JSON.stringify(skipped)); }
  // vix 缺：v2-global-1 照發、VIX 欄顯「—」
  { const fx = FIX(); fx.vix = null;
    const { cards, skipped } = buildDailyCards(fx);
    const g = cards.find((c) => c.id === "v2-global-1");
    chk("缺 vix → global-1 照發且顯「—」", skipped.length === 0 && g &&
      g.rows.some((r) => r.m === "VIX" && r.r === "—")); }
  // lastweek 缺：rank-1 照發（降級：無上週括號）
  { const fx = FIX(); fx.lastweek = null;
    const { cards, skipped } = buildDailyCards(fx);
    const r = cards.find((c) => c.id === "v2-rank-1");
    chk("缺 lastweek → rank-1 照發、無上週括號", skipped.length === 0 && r && !/上週 /.test(r.rows[0].r)); }
  // 全空 src：35 張全 skipped、不炸
  { const { cards, skipped } = buildDailyCards({});
    chk("全空 src → 0 卡、35 skipped、不拋例外", cards.length === 0 && skipped.length === 35,
      `cards=${cards.length} skipped=${skipped.length}`); }
  // 舊 schema baseline（Phase A 前，8 欄）→ 卡3/4 skipped 並說明缺欄
  { const fx = FIX();
    for (const k of Object.keys(fx.baseline.stocks)) fx.baseline.stocks[k] = fx.baseline.stocks[k].slice(0, 8);
    for (const k of Object.keys(fx.baseline.subs_y)) fx.baseline.subs_y[k] = fx.baseline.subs_y[k].slice(0, 2);
    const { cards, skipped } = buildDailyCards(fx);
    const sk = Object.fromEntries(skipped.map((s) => [s.id, s.reason]));
    chk("舊 schema：卡3/4 skipped＋缺欄理由", /nh/.test(sk["sig-new-high"] || "") && /a20/.test(sk["sig-new-low"] || ""));
    chk("舊 schema：卡1 照發（R 全缺顯 R —）", cards.find((c) => c.id === "sig-sub-surge").rows[0].r === "R —"); }
}
// ---- 6. 產物能過渲染層（cardBubble／buildCardCarousels／cardsFallbackText）----
{
  const { cards } = buildDailyCards(FIX());
  let bubbleErr = null;
  for (const c of cards) { try { cardBubble(c); } catch (e) { bubbleErr = `${c.id}: ${e.message}`; break; } }
  chk("35 張逐卡過 cardBubble（含誠實原則守門）", bubbleErr === null, bubbleErr);
  let msgs = null, carErr = null;
  try { msgs = buildCardCarousels(cards, "股市雷達 2026-07-24 盤後圖卡"); } catch (e) { carErr = e.message; }
  chk("buildCardCarousels 整包不炸", carErr === null, carErr);
  chk("35 bubble（無免責卡，2026-08-16 移除）→ 3 carousel ≤5 message", msgs && msgs.length === 3, msgs && `${msgs.length}`);
  chk("每 carousel ≤12 bubble", msgs && msgs.every((m) => m.contents.contents.length <= 12));
  let fb = null, fbErr = null;
  try { fb = cardsFallbackText(cards, "2026-07-24"); } catch (e) { fbErr = e.message; }
  chk("純文字降級版可產出", fbErr === null && typeof fb === "string" && fb.length > 100, fbErr);
  // 上游 tone 含「貢獻最強」→ 組裝層已中性化，卡面不含禁用字
  const ov5 = cards.find((c) => c.id === "v2-ov-5");
  chk("tone 禁用字已中性化（最強→最大）", /貢獻最大/.test(ov5.paras[0]) && !/最強/.test(ov5.paras[0]));
}
// ---- 7. 純函式：同輸入兩次呼叫 byte-identical、不改動輸入 ----
{
  const fx = FIX();
  const snap = JSON.stringify(fx);
  const a = JSON.stringify(buildDailyCards(fx));
  const b = JSON.stringify(buildDailyCards(fx));
  chk("同輸入兩次輸出 byte-identical", a === b);
  chk("不竄改輸入物件", JSON.stringify(fx) === snap);
}

// ---- 7b. 流動性過濾：卡面鏡像回測母體（2026-07-29 首晚實推抓到的缺漏）----
// 冷門股 9997 全訊號命中（y1=1、it/fi≥2、nh=1、ints=89.4）但當日額 3 千萬 <1 億，
// 回測母體（LIQ=1e8）根本不含它——修正前它會以灌爆的 ints 佔據卡 3 榜首。
{
  const out = buildDailyCards(FIX());
  const byId = Object.fromEntries(out.cards.map((c) => [c.id, c]));
  for (const id of ["sig-new-high", "sig-dual-buy", "sig-surge-warn"]) {
    const card = byId[id];
    chk(`${id} 不含冷門股 9997`, card && !card.rows.some((r) => r.l === "9997"),
      card && card.rows.map((r) => r.l).join(","));
  }
  chk("卡3 流動股 2330 仍在", byId["sig-new-high"].rows.some((r) => r.l === "2330"));
  // flows 缺時退 a5 近似：卡3 仍擋 9997（a5=3e7）、留 2330（a5=5e10）
  const fx2 = FIX(); fx2.flowsDaily = null;
  const out2 = buildDailyCards(fx2);
  const nh2 = out2.cards.find((c) => c.id === "sig-new-high");
  chk("flows 缺→a5 後備仍擋 9997、留 2330",
    nh2 && !nh2.rows.some((r) => r.l === "9997") && nh2.rows.some((r) => r.l === "2330"),
    nh2 && nh2.rows.map((r) => r.l).join(","));
}

// ---- 8. 形狀壞的源不得全滅（B1 驗收 A2 缺口的回歸測試）----
// 「非 null 但形狀歪」：rows=42、buy_by_amt={}、dates=42——修正前這三種都會讓
// 共用 ctx 建構（fxNameMap/fxRegime）拋例外、35 張全滅。
{
  for (const [label, mut] of [
    ["lending.rows=42", (f) => { f.postmkt.lending.rows = 42; }],
    ["buy_by_amt={}", (f) => { f.flowsLatest.pages.foreign.buy_by_amt = {}; }],
    ["totals.dates=42", (f) => { f.totals.dates = 42; }],
  ]) {
    const fx = FIX(); mut(fx);
    let out = null, err = null;
    try { out = buildDailyCards(fx); } catch (e) { err = e.message; }
    chk(`${label} 不拋例外`, err === null, err);
    chk(`${label} 仍產出多數卡（>20 張）`, out && out.cards.length > 20,
      out && `cards=${out.cards.length}`);
  }
  // totals.dates 壞 → regime 降級為未判定（視為 bull 不抑制），卡 1 note 帶標註
  const fx = FIX(); fx.totals.dates = 42;
  const out = buildDailyCards(fx);
  const c1 = out.cards.find((c) => c.id === "sig-sub-surge");
  chk("totals 壞 → regime 降級未判定、卡1 照發且帶標註",
    c1 && /regime 未判定/.test([c1.note, c1.foot].join("")), c1 && (c1.note || c1.foot));
}

// ---- 9. 盤後分析摘要長文卡 pm-summary-1（2026-08-07 新增；走獨立 Image message）----
// 這張不進 Flex carousel：全文約 2000 字，Flex hero 塞不下（見 src FX_LONGFORM_CARD 註）。
{
  const { cards, skipped } = buildDailyCards(FIX());
  const lf = cards.find((c) => c.id === FX_LONGFORM_CARD);
  chk("完整 fixture → 長文卡有產出", !!lf, JSON.stringify(skipped));
  chk("長文卡 kind=longform", lf && lf.kind === "longform", lf && lf.kind);
  chk("長文卡 paras 非空（逐行拆）", lf && (lf.paras || []).length >= 4, lf && `${lf.paras.length}`);
  chk("長文卡 sub 含「AI 生成」＋資料日", lf && /AI 生成/.test(lf.sub) && /資料日 2026-07-24/.test(lf.sub),
    lf && lf.sub);
  chk("長文卡保留 markdown 段標", lf && lf.paras.some((p) => p.startsWith("## ")), lf && lf.paras[0]);
  chk("長文卡 note 標明與其餘卡不同（含推測性內容）", lf && /推測性內容/.test(lf.note) && /非投資建議/.test(lf.note),
    lf && lf.note);
  chk("長文卡帶 disclaimer（AI 生成、未經回測）", lf && /AI/.test(lf.disclaimer) && /未經回測/.test(lf.disclaimer),
    lf && lf.disclaimer);
  // 中性化：fixture 刻意寫「買盤最強」，卡面必須已換成「買盤最大」且過得了誠實原則守門
  const parasStr = lf ? JSON.stringify(lf.paras) : "";
  chk("長文卡禁用字已中性化（最強→最大）",
    !parasStr.includes("最強") && parasStr.includes("買盤最大"), parasStr.slice(0, 160));
  chk("長文卡卡面零禁用字", !FX_FORBIDDEN.some((w) =>
    JSON.stringify([lf && lf.title, lf && lf.sub, lf && lf.paras, lf && lf.note]).includes(w)),
    FX_FORBIDDEN.filter((w) => parasStr.includes(w)).join(","));
  let lfErr = null;
  try { assertCardAllowed(lf); } catch (e) { lfErr = e.message; }
  chk("長文卡過 assertCardAllowed 不拋錯", lfErr === null, lfErr);
  // 一旦被誤加進 FX_ACTIVE_CARDS，2000 字長文就會變成 carousel bubble（版面爆掉）
  chk("pm-summary-1 不在 FX_ACTIVE_CARDS", !FX_ACTIVE_CARDS.has(FX_LONGFORM_CARD),
    [...FX_ACTIVE_CARDS].join(","));
  chk("FX_LONGFORM_CARD 常數＝pm-summary-1", FX_LONGFORM_CARD === "pm-summary-1");
  chk("長文卡在 builder 表內（第 35 項）",
    FX_CARD_BUILDERS.length === 35 && FX_CARD_BUILDERS[34][0] === FX_LONGFORM_CARD,
    FX_CARD_BUILDERS[FX_CARD_BUILDERS.length - 1][0]);
}
{
  // 日期守門：摘要日 ≠ 資料日（baseline.date）→ skip，不得把昨日分析標成今日
  const fx = FIX(); fx.summaryPm = { ...fx.summaryPm, date: "2026-07-23" };
  const { cards, skipped } = buildDailyCards(fx);
  const sk = Object.fromEntries(skipped.map((s) => [s.id, s.reason]));
  chk("摘要日≠資料日 → skip、理由含「日期不符」", /日期不符/.test(sk[FX_LONGFORM_CARD] || ""),
    sk[FX_LONGFORM_CARD]);
  chk("摘要日≠資料日 → 只影響長文卡，其餘 34 張照常", cards.length === 34 && skipped.length === 1,
    `cards=${cards.length} skipped=${JSON.stringify(skipped)}`);
}
{
  // 內容未就緒的各種形狀 → 一律 skip，不得產出空卡
  for (const [label, sp] of [
    ["synthesis 缺", { date: "2026-07-24", slot: "pm" }],
    ["synthesis.text 缺", { date: "2026-07-24", slot: "pm", synthesis: {} }],
    ["text 空字串", { date: "2026-07-24", slot: "pm", synthesis: { text: "" } }],
    ["text 全空白行", { date: "2026-07-24", slot: "pm", synthesis: { text: "  \n \n\t" } }],
    ["summaryPm 無 date", { slot: "pm", synthesis: { text: "有內容但沒日期" } }],
  ]) {
    const fx = FIX(); fx.summaryPm = sp;
    const out = buildDailyCards(fx);
    const r = (out.skipped.find((x) => x.id === FX_LONGFORM_CARD) || {}).reason;
    chk(`${label} → 長文卡 skip`, typeof r === "string" && r.length > 0
      && !out.cards.some((c) => c.id === FX_LONGFORM_CARD), JSON.stringify(r));
    chk(`${label} → 其餘 34 張不連坐`, out.cards.length === 34, `${out.cards.length}`);
  }
  // 缺 baseline ＝ 沒有可信資料日，無從核對摘要是不是當日的 → 一律 skip（2026-08-07 收緊，
  // 與 buildCardsData「baseline 缺 → date:null → Python 拒渲染」同一套保守立場）。
  const fx = FIX(); fx.baseline = null;
  const out = buildDailyCards(fx);
  const r = (out.skipped.find((x) => x.id === FX_LONGFORM_CARD) || {}).reason || "";
  chk("缺 baseline → 長文卡也 skip（無可信資料日）",
    !out.cards.some((c) => c.id === FX_LONGFORM_CARD) && r.includes("日期不符"),
    JSON.stringify(r));
  chk("缺 baseline → skip 理由標明 data=null", r.includes("data=null"), JSON.stringify(r));
}
{
  // fxNeutralize 直接單元測試：逐條對照生效、不誤傷乾淨字串、換完不殘留
  const bad = [];
  for (const [w, rep] of Object.entries(FX_NEUTRALIZE)) {
    const got = fxNeutralize(`前綴${w}後綴`);
    if (got !== `前綴${rep}後綴`) bad.push(`${w}→${got}`);
  }
  chk("FX_NEUTRALIZE 逐條對照皆生效", bad.length === 0, bad.join(" | "));
  const dirty = FX_FORBIDDEN.join("／");
  chk("整串禁用字換完零殘留", !FX_FORBIDDEN.some((w) => fxNeutralize(dirty).includes(w)),
    FX_FORBIDDEN.filter((w) => fxNeutralize(dirty).includes(w)).join(","));
  chk("中性詞本身不是禁用字", !Object.values(FX_NEUTRALIZE).some((v) =>
    FX_FORBIDDEN.some((w) => v.includes(w))));
  // 現況不變式：FX_FORBIDDEN 每個字都有對照。若日後刻意新增「不給對照、直接整張剔除」的
  // 禁用字，這條要一起改（發送層 assertCardAllowed 是最後防線，見 cardsend.mjs ⑭c）。
  chk("FX_NEUTRALIZE 1:1 覆蓋 FX_FORBIDDEN", FX_FORBIDDEN.every((w) => w in FX_NEUTRALIZE),
    FX_FORBIDDEN.filter((w) => !(w in FX_NEUTRALIZE)).join(","));
  const clean = "外資賣超 609.5 億元，成交比重 19.1%，廣度漲 612 跌 1483。";
  chk("不含禁用字的字串原樣返回", fxNeutralize(clean) === clean, fxNeutralize(clean));
  chk("含「關注度」等中性詞不被誤傷",
    fxNeutralize("外資關注度上升，投信買超集中") === "外資關注度上升，投信買超集中");
  chk("多處命中一次換完", fxNeutralize("最強與最弱同時出現，且看多看空並陳")
    === "最大與最小同時出現，且偏多解讀偏空解讀並陳", fxNeutralize("最強與最弱同時出現，且看多看空並陳"));
  chk("空值容錯", fxNeutralize(null) === "" && fxNeutralize(undefined) === "" && fxNeutralize("") === "");
}

console.log(`dailycards: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
