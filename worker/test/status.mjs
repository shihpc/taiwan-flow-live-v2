// /status 全系統資料健康端點離線單元測試（2026-08-11）
// 無需 token、不打真實網路——fetch 全用 mock。執行：cd worker && node test/status.mjs
import { addDaysISO, lastExpectedTradingDate, prevExpectedTradingDate, gradeMarket,
  gradeNews, gradeBrief, isoTaipei, extractHeadFields, buildStatus,
  STATUS_DUE_HOUR, backtestRefClock, gradeBacktest, extractTailDate } from "../src/index.js";

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; } else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}

// 2026-08-11 = 週二；2026-08-08 = 週六；2026-08-09 = 週日；2026-08-07 = 週五
const TUE = { date: "2026-08-11", dow: 2, hour: 12, minute: 0 };
const MON = { date: "2026-08-10", dow: 1, hour: 12, minute: 0 };
const SAT = { date: "2026-08-08", dow: 6, hour: 12, minute: 0 };
const SUN = { date: "2026-08-09", dow: 0, hour: 12, minute: 0 };

// ---- 日期工具 ----
{
  chk("addDaysISO 退 1 天", addDaysISO("2026-08-11", -1) === "2026-08-10");
  chk("addDaysISO 跨月", addDaysISO("2026-08-01", -1) === "2026-07-31");
  chk("最近預期交易日：平日＝今天", lastExpectedTradingDate(TUE) === "2026-08-11");
  chk("最近預期交易日：週六退到週五", lastExpectedTradingDate(SAT) === "2026-08-07");
  chk("最近預期交易日：週日退到週五", lastExpectedTradingDate(SUN) === "2026-08-07");
  chk("前一交易日：週二→週一", prevExpectedTradingDate("2026-08-11") === "2026-08-10");
  chk("前一交易日：週一跳過週末→週五", prevExpectedTradingDate("2026-08-10") === "2026-08-07");
}

// ---- 市場資料類判級（live/flows/postmkt）----
{
  chk("市場：資料日＝今天(平日) → green", gradeMarket("2026-08-11", TUE) === "green");
  chk("市場：落後 1 交易日 → yellow", gradeMarket("2026-08-10", TUE) === "yellow");
  chk("市場：落後 2 交易日 → red", gradeMarket("2026-08-07", TUE) === "red");
  chk("市場：週末看上週五 → green", gradeMarket("2026-08-07", SAT) === "green");
  chk("市場：週日資料落後至週四 → yellow", gradeMarket("2026-08-06", SUN) === "yellow");
  chk("市場：週一資料仍是上週四 → red", gradeMarket("2026-08-06", MON) === "red");
  chk("市場：無日期 → red", gradeMarket(null, TUE) === "red");
}

// ---- news 判級（generated_at 距今時數）----
{
  const now = Date.parse("2026-08-11T12:00:00+08:00");
  chk("news：2 小時內 → green", gradeNews("2026-08-11T10:30:00+08:00", now) === "green");
  chk("news：3 小時整（邊界）→ green", gradeNews("2026-08-11T09:00:00+08:00", now) === "green");
  chk("news：10 小時 → yellow", gradeNews("2026-08-11T02:00:00+08:00", now) === "yellow");
  chk("news：24 小時整（邊界）→ yellow", gradeNews("2026-08-10T12:00:00+08:00", now) === "yellow");
  chk("news：25 小時 → red", gradeNews("2026-08-10T11:00:00+08:00", now) === "red");
  chk("news：無法解析 → red", gradeNews(null, now) === "red" && gradeNews("bogus", now) === "red");
}

// ---- brief 判級 ----
{
  chk("brief：date＝今天(平日) → green", gradeBrief("2026-08-11", TUE) === "green");
  chk("brief：date＝昨天(平日) → yellow", gradeBrief("2026-08-10", TUE) === "yellow");
  chk("brief：更舊 → red", gradeBrief("2026-08-07", TUE) === "red");
  chk("brief：週六看週五版 → yellow", gradeBrief("2026-08-07", SAT) === "yellow");
  chk("brief：週日仍是週五版 → yellow", gradeBrief("2026-08-07", SUN) === "yellow");
  chk("brief：週末但版太舊 → red", gradeBrief("2026-08-06", SAT) === "red");
  chk("brief：無日期 → red", gradeBrief(null, TUE) === "red");
}

// ---- 時間感知判級（2026-09-07）：dueHour 前預期資料日退成前一交易日 ----
// 三個時點取各站前端現行判準：live 9（liveDataDate 的 09:00 分水嶺）、flows 20
// （lastDueTradingDay／後端 PUBLISH_DEADLINE_HOUR）、postmkt 22.5（pmStatus 的 hm < "22:30"）。
{
  const tue = (h, m = 0) => ({ date: "2026-08-11", dow: 2, hour: h, minute: m });
  chk("STATUS_DUE_HOUR 三值＝各站前端現行值",
    STATUS_DUE_HOUR.live === 9 && STATUS_DUE_HOUR.flows === 20 && STATUS_DUE_HOUR.postmkt === 22.5,
    JSON.stringify(STATUS_DUE_HOUR));
  // 預期交易日本身
  chk("預期日：平日 dueHour 前退成前一交易日",
    lastExpectedTradingDate(tue(12), 20) === "2026-08-10");
  chk("預期日：平日 dueHour 後＝今日",
    lastExpectedTradingDate(tue(20), 20) === "2026-08-11");
  chk("預期日：dueHour 小數 22.5 —— 22:29 未到、22:30 到",
    lastExpectedTradingDate(tue(22, 29), 22.5) === "2026-08-10"
    && lastExpectedTradingDate(tue(22, 30), 22.5) === "2026-08-11");
  chk("預期日：週一 dueHour 前跳過週末退到週五",
    lastExpectedTradingDate({ date: "2026-08-10", dow: 1, hour: 3, minute: 0 }, 20) === "2026-08-07");
  chk("預期日：dueHour 省略＝舊行為（平日一律今日）", lastExpectedTradingDate(tue(0)) === "2026-08-11");
  chk("預期日：週末不受 dueHour 影響（仍回上週五）",
    lastExpectedTradingDate(SAT, 22.5) === "2026-08-07" && lastExpectedTradingDate(SUN, 20) === "2026-08-07");

  // flows：平日 20:00 前後
  chk("flows 19:59 資料停在昨日 → green（管線還沒跑）",
    gradeMarket("2026-08-10", tue(19, 59), STATUS_DUE_HOUR.flows) === "green");
  chk("flows 20:00 後資料仍停在昨日 → yellow",
    gradeMarket("2026-08-10", tue(20, 0), STATUS_DUE_HOUR.flows) === "yellow");
  // live：平日 09:00 前後
  chk("live 08:59 資料停在昨日 → green（盤前）",
    gradeMarket("2026-08-10", tue(8, 59), STATUS_DUE_HOUR.live) === "green");
  chk("live 09:00 後資料仍停在昨日 → yellow",
    gradeMarket("2026-08-10", tue(9, 0), STATUS_DUE_HOUR.live) === "yellow");
  // postmkt：平日 22:30 前後
  chk("postmkt 22:29 資料停在昨日 → green",
    gradeMarket("2026-08-10", tue(22, 29), STATUS_DUE_HOUR.postmkt) === "green");
  chk("postmkt 22:30 後資料仍停在昨日 → yellow",
    gradeMarket("2026-08-10", tue(22, 30), STATUS_DUE_HOUR.postmkt) === "yellow");
  // 時間感知只把整個階梯往前挪一格，不是把警報關掉：dueHour 前的預期日＝前一交易日，
  // 相對它落後 1 格仍 yellow、落後 2 格仍 red。
  chk("postmkt dueHour 前：相對預期日(08-10)落後 1 格 → yellow",
    gradeMarket("2026-08-07", tue(12), STATUS_DUE_HOUR.postmkt) === "yellow");
  chk("postmkt dueHour 前：相對預期日(08-10)落後 2 格 → red",
    gradeMarket("2026-08-06", tue(12), STATUS_DUE_HOUR.postmkt) === "red");
  chk("flows dueHour 前：落後 2 格 → red",
    gradeMarket("2026-08-06", tue(12), STATUS_DUE_HOUR.flows) === "red");
  chk("無日期 → red（不受 dueHour 影響）", gradeMarket(null, tue(3), STATUS_DUE_HOUR.postmkt) === "red");

  // 週末：dueHour 不改變週末口徑
  chk("週六：資料＝週五 → green（postmkt due）", gradeMarket("2026-08-07", SAT, STATUS_DUE_HOUR.postmkt) === "green");
  chk("週日：資料＝週四 → yellow（flows due）", gradeMarket("2026-08-06", SUN, STATUS_DUE_HOUR.flows) === "yellow");

  // 國定假日不處理的已知誤報方向：假日當天過了 dueHour 仍會判落後（黃／紅），不會判綠。
  // 以「假設 2026-08-11 為國定假日、全站資料正確停在 08-10」重演。
  chk("國定假日：dueHour 前仍 green（誤報被時間感知延後）",
    gradeMarket("2026-08-10", tue(21), STATUS_DUE_HOUR.postmkt) === "green");
  chk("國定假日：過 dueHour 後誤報 yellow（已知可接受誤差，方向為偏保守）",
    gradeMarket("2026-08-10", tue(23), STATUS_DUE_HOUR.postmkt) === "yellow");
}

// ---- 重現 2026-09-07 的實測情境（本次修正的動機）----
// 2026-09-07（週一）台北 18:12 打線上 /status 得 postmkt data_date=2026-09-04（＝週五、上一交易日），
// level=yellow；但 postmkt 站自己的頂列同時顯示「正常」（pmStatus：上一交易日且 hm < "22:30"）。
// 舊版（不看時間）→ yellow＝假警報；新版（dueHour=22.5）→ green；同日 23:00 仍停在上一交易日
// → 照樣 yellow（消假警報不等於永遠不報）。
{
  const MON_1812 = { date: "2026-09-07", dow: 1, hour: 18, minute: 12 };   // 2026-09-07 週一 18:12
  const MON_2300 = { date: "2026-09-07", dow: 1, hour: 23, minute: 0 };    // 同日 23:00
  chk("重現：舊版判級（不看時間）→ yellow（假警報）",
    gradeMarket("2026-09-04", MON_1812) === "yellow");
  chk("重現：新版判級（postmkt due 22.5）→ green",
    gradeMarket("2026-09-04", MON_1812, STATUS_DUE_HOUR.postmkt) === "green");
  chk("該黃的還是黃：23:00 仍停在上一交易日 → yellow",
    gradeMarket("2026-09-04", MON_2300, STATUS_DUE_HOUR.postmkt) === "yellow");
  chk("該紅的還是紅：23:00 落後 2 交易日 → red",
    gradeMarket("2026-09-03", MON_2300, STATUS_DUE_HOUR.postmkt) === "red");
}

// ---- backtest 判級（對齊 taiwan-backtest/index.html 的 ledgerStatus）----
// 參考時鐘＝台北時鐘 −12h；門檻 09:07（台北 21:07 主班）／19:07（台北隔日 07:07＝主班 +10h）。
// 19:07 於 2026-09-07 由 13:07（主班 +4h）放寬（門檻值不變）；其依據的統計已於 2026-09-08 重算
// 更正——09-07 那組「120 筆／中位數 3h02m／>10h 為 0 筆」整組是錯的（漏抽 daysummary.yml）。
// 更正後：四支 workflow 187 筆 event:schedule run，中位數 2h01m／p90 4h44m／最大 12h23m、
// >4h 12.8%、>10h 2 筆(1.1%)；紅線的理由是代理推估（N=151，推測非直接觀測）誤報率約 2%
// 換取距硬期限 4h53m 的補救餘裕，**不是**「>10h 從沒發生過」。詳見 gradeBacktest 上方註解。
// 三站門檻須同步。
{
  const tp = (date, dow, hour, minute = 0) => ({ date, dow, hour, minute });
  // 曆日對照（實查）：2026-09-07 週一、09-08 週二、09-09 週三、09-11 週五、09-12 週六
  chk("參考時鐘：台北 21:07 → 參考日＝當日 09:07",
    JSON.stringify(backtestRefClock(tp("2026-09-08", 2, 21, 7))) === JSON.stringify({ day: "2026-09-08", hm: "09:07" }));
  chk("參考時鐘：台北隔日 01:07 → 參考日退一天、hm=13:07",
    JSON.stringify(backtestRefClock(tp("2026-09-09", 3, 1, 7))) === JSON.stringify({ day: "2026-09-08", hm: "13:07" }));
  chk("參考時鐘：台北 12:00 → 同日 00:00",
    JSON.stringify(backtestRefClock(tp("2026-09-08", 2, 12, 0))) === JSON.stringify({ day: "2026-09-08", hm: "00:00" }));

  // 正常：班次尚未排定（台北 21:07 前），帳冊停在上一交易日
  chk("backtest 台北 18:00、帳冊＝上一交易日 → green",
    gradeBacktest("2026-09-07", tp("2026-09-08", 2, 18, 0)) === "green");
  chk("backtest 帳冊已記到參考交易日 → green（不論時點）",
    gradeBacktest("2026-09-08", tp("2026-09-08", 2, 23, 0)) === "green"
    && gradeBacktest("2026-09-08", tp("2026-09-09", 3, 2, 0)) === "green");
  // 落後：台北 21:07~隔日 07:07 之間＝等待
  chk("backtest 台北 21:07（門檻整點）→ yellow",
    gradeBacktest("2026-09-07", tp("2026-09-08", 2, 21, 7)) === "yellow");
  chk("backtest 台北 21:06（門檻前一分）→ green",
    gradeBacktest("2026-09-07", tp("2026-09-08", 2, 21, 6)) === "green");
  chk("backtest 台北 23:30（兩班之間）→ yellow",
    gradeBacktest("2026-09-07", tp("2026-09-08", 2, 23, 30)) === "yellow");
  chk("backtest 台北隔日 07:07（主班+10h 用盡）→ red",
    gradeBacktest("2026-09-07", tp("2026-09-09", 3, 7, 7)) === "red");
  chk("backtest 台北隔日 07:06（緩衝內）→ yellow",
    gradeBacktest("2026-09-07", tp("2026-09-09", 3, 7, 6)) === "yellow");
  // 2026-09-07 放寬的那一段：舊門檻（台北隔日 01:07~07:06）原本 red，現在一律 yellow
  chk("backtest 舊門檻區間（台北隔日 01:07／03:00／07:06）→ 全部 yellow",
    [[1, 7], [3, 0], [7, 6]].every(([h, m]) =>
      gradeBacktest("2026-09-07", tp("2026-09-09", 3, h, m)) === "yellow"));
  // 2026-09-07 的實際誤報情境：台北 09-08 01:36、帳冊停在 09-04（09-07 那班延遲到 02:13 才落地）
  chk("backtest 2026-09-07 誤報情境 → yellow（舊門檻為 red）",
    gradeBacktest("2026-09-04", tp("2026-09-08", 2, 1, 36)) === "yellow");
  // 落後一個交易日以上：任何時點都 red
  chk("backtest 落後 2 交易日 → red（即使班次尚未排定）",
    gradeBacktest("2026-09-04", tp("2026-09-08", 2, 18, 0)) === "red");
  // 週末（參考日為週末）
  chk("backtest 週六參考日、帳冊＝週五 → green（休市定格）",
    gradeBacktest("2026-09-11", tp("2026-09-12", 6, 18, 0)) === "green");
  chk("backtest 週六參考日、帳冊早於週五 → red",
    gradeBacktest("2026-09-10", tp("2026-09-12", 6, 18, 0)) === "red");
  // 抓不到／格式壞
  chk("backtest 無日期／格式不合 → red",
    gradeBacktest(null, tp("2026-09-08", 2, 18, 0)) === "red"
    && gradeBacktest("", tp("2026-09-08", 2, 18, 0)) === "red"
    && gradeBacktest("2026/09/07", tp("2026-09-08", 2, 18, 0)) === "red");
  // 國定假日不處理的已知誤報方向
  chk("backtest 國定假日：過 19:07 門檻誤報 red（方向偏保守，與各站同立場）",
    gradeBacktest("2026-09-07", tp("2026-09-09", 3, 9, 0)) === "red");
}

// ---- extractTailDate（CSV 檔尾）----
{
  const csv = "date,sox_date,sox_ret,bucket,action,entry_time,entry_px,exit_px,how,pnl_sim,cum_pnl\n"
    + "2026-09-03,2026-09-02,0.00114,小漲0~1%,多0845,08:45,46500.0,46151.2,stop,-350.8,-350.8\n"
    + "2026-09-04,2026-09-03,-0.0102,小跌0~1%,空0845,08:45,46000.0,46200.0,close,-200.0,-550.8\n";
  chk("檔尾取最後一列 date", extractTailDate(csv) === "2026-09-04");
  chk("尾段從半列切起：半列不誤判", extractTailDate("500.0,46151.2,stop,-350.8,-350.8\n2026-09-04,2026-09-03,-0.0102,x\n") === "2026-09-04");
  chk("只有表頭（無資料列）→ null", extractTailDate("date,sox_date,cum_pnl\n") === null);
  chk("空字串／null → null", extractTailDate("") === null && extractTailDate(null) === null);
  chk("CRLF 也解得出", extractTailDate("a,b\r\n2026-09-04,1\r\n") === "2026-09-04");
}

// ---- isoTaipei / extractHeadFields ----
{
  chk("isoTaipei 轉 +08:00", isoTaipei(Date.parse("2026-08-11T04:00:00Z")) === "2026-08-11T12:00:00+08:00");
  const h = extractHeadFields('{"date":"2026-08-11","generated_at":"2026-08-11T21:01:04+08:00","margin":{');
  chk("extractHeadFields 撈出 date/generated_at", h.date === "2026-08-11" && h.generated_at === "2026-08-11T21:01:04+08:00");
  const h2 = extractHeadFields("not json at all");
  chk("extractHeadFields 撈不到回 null", h2.date === null && h2.generated_at === null);
}

// ---- buildStatus 整合（mock fetch＋mock KV）----
function fakeKV(init = {}) {
  const m = new Map(Object.entries(init));
  return { async get(k, type) { const v = m.get(k); if (v === undefined) return null; return type === "json" ? (typeof v === "string" ? JSON.parse(v) : v) : v; } };
}
const NOW = Date.parse("2026-08-11T22:00:00+08:00");
// mock fetch：五來源全鮮。postmkt 模擬 Range 回 206 檔頭。
const okFetch = async (u, init) => {
  const s = String(u);
  if (s.includes("/taiwan-flows/")) return { ok: true, status: 200, json: async () => ({ date: "2026-08-11", status: "ok", checked_at: "2026-08-11T21:30:00+08:00" }) };
  if (s.endsWith("/news.json")) return { ok: true, status: 200, json: async () => ({ generated_at: "2026-08-11T21:52:00+08:00", trading_days: ["2026-08-10", "2026-08-11"], total_news: 42 }) };
  if (s.endsWith("/daily-brief-card.json")) return { ok: true, status: 200, json: async () => ({ schema: 1, date: "2026-08-11", edition: 3, generated_at: "2026-08-11T07:30:00+08:00" }) };
  if (s.endsWith("/postmkt.json")) {
    // 驗證有帶 Range 檔頭（大檔不整包抓）
    if (!init || !init.headers || !init.headers.Range) return { ok: false, status: 500, text: async () => "" };
    return { ok: true, status: 206, text: async () => '{"date":"2026-08-11","generated_at":"2026-08-11T21:01:04+08:00","margin":{' };
  }
  if (s.endsWith("/ledger.csv")) {
    // 驗證帶的是**後綴** Range（bytes=-N，只取檔尾），不是整包也不是檔頭
    const rg = init && init.headers && init.headers.Range;
    if (!/^bytes=-\d+$/.test(String(rg || ""))) return { ok: false, status: 500, text: async () => "" };
    return { ok: true, status: 206, text: async () =>
      "0.0,46151.2,stop,-350.8,-350.8\n2026-08-11,2026-08-10,0.00114,小漲0~1%,多0845,08:45,46500.0,46151.2,stop,-12.5,-363.3\n" };
  }
  return { ok: false, status: 404, json: async () => null, text: async () => "" };
};
{
  const kv = fakeKV({ "fi:2026-08-11": ["09:01", "09:02", "13:30"] });
  const out = await buildStatus({ FLOW_KV: kv }, TUE, okFetch, NOW);
  chk("schema:1＋generated_at＋status:ok", out.schema === 1 && out.status === "ok" && /\+08:00$/.test(out.generated_at));
  chk("六站齊全且順序 live/flows/news/brief/postmkt/backtest（既有五站順序不動，backtest 附加在後）",
    out.sites.map((s) => s.id).join(",") === "live,flows,news,brief,postmkt,backtest",
    out.sites.map((s) => s.id).join(","));
  chk("每站欄位齊全（id/name/data_date/updated_at/level/note）",
    out.sites.every((s) => ["id", "name", "data_date", "updated_at", "level", "note"].every((k) => k in s)));
  chk("全鮮 → 六站 green", out.sites.every((s) => s.level === "green"),
    out.sites.map((s) => `${s.id}:${s.level}`).join(" "));
  const bt = out.sites[5];
  chk("backtest：資料日＝帳冊最後一列、updated_at 為 null（帳冊無產出時刻欄，不臆造）",
    bt.id === "backtest" && bt.data_date === "2026-08-11" && bt.updated_at === null,
    JSON.stringify(bt));
  const live = out.sites[0];
  chk("live 用 KV frame 索引（資料日＝今天、updated_at＝最後格）",
    live.data_date === "2026-08-11" && live.updated_at === "2026-08-11T13:30:00+08:00");
  chk("brief 判 date 而非 generated_at", out.sites[3].data_date === "2026-08-11");
}
{
  // 今日無 frame → 回退前一交易日 → yellow
  const kv = fakeKV({ "fi:2026-08-10": ["13:30"] });
  const out = await buildStatus({ FLOW_KV: kv }, TUE, okFetch, NOW);
  chk("live 今日無 frame 回退昨日 → yellow", out.sites[0].level === "yellow" && out.sites[0].data_date === "2026-08-10");
  const out2 = await buildStatus({ FLOW_KV: fakeKV() }, TUE, okFetch, NOW);
  chk("live 近兩交易日皆無 frame → red＋date null", out2.sites[0].level === "red" && out2.sites[0].data_date === null);
}
{
  // 單來源失敗不垮全體：flows 拋錯、postmkt 回 404，其餘照常
  const badFetch = async (u, init) => {
    const s = String(u);
    if (s.includes("/taiwan-flows/")) throw new Error("network boom");
    if (s.endsWith("/postmkt.json")) return { ok: false, status: 404, text: async () => "" };
    return okFetch(u, init);
  };
  const kv = fakeKV({ "fi:2026-08-11": ["09:01"] });
  const out = await buildStatus({ FLOW_KV: kv }, TUE, badFetch, NOW);
  chk("flows 失敗 → 該站 red＋note 說明＋日期 null",
    out.sites[1].level === "red" && out.sites[1].note.includes("boom") && out.sites[1].data_date === null);
  chk("postmkt 404 → 該站 red", out.sites[4].level === "red" && out.sites[4].note.includes("404"));
  chk("其餘站不受拖累（live/news/brief 仍 green）",
    out.sites[0].level === "green" && out.sites[2].level === "green" && out.sites[3].level === "green");
  chk("端點整體仍成功回應（schema/status 不變）", out.schema === 1 && out.status === "ok");
}
{
  // KV 缺失（env.FLOW_KV 未綁）也只是 live red，不拋例外
  const out = await buildStatus({}, TUE, okFetch, NOW);
  chk("無 KV → live red、其餘照常", out.sites[0].level === "red" && out.sites[1].level === "green");
}
{
  // 週末：fi 索引 TTL 已拉到 5 天（f frame 仍 2 天）——只要週五索引還在，
  // 即使 f: frame 本體已過期，statusSiteLive 仍以索引回報週五資料日 → green
  const SAT_NOW = Date.parse("2026-08-08T15:00:00+08:00");
  const kv = fakeKV({ "fi:2026-08-07": ["09:01", "13:30"] });   // 只有索引、無任何 f: 鍵
  const out = await buildStatus({ FLOW_KV: kv }, SAT, okFetch, SAT_NOW);
  chk("週六：週五 fi 索引在（frame 已蒸發）→ live green＋資料日=週五",
    out.sites[0].level === "green" && out.sites[0].data_date === "2026-08-07",
    `${out.sites[0].level} ${out.sites[0].data_date}`);
}

{
  // backtest 單站失敗（帳冊抓不到）→ 只染紅該站，端點與其餘五站不受影響
  const noLedger = async (u, init) => {
    if (String(u).endsWith("/ledger.csv")) return { ok: false, status: 404, text: async () => "" };
    return okFetch(u, init);
  };
  const kv = fakeKV({ "fi:2026-08-11": ["09:01"] });
  const out = await buildStatus({ FLOW_KV: kv }, TUE, noLedger, NOW);
  chk("backtest 404 → 該站 red＋note 說明", out.sites[5].level === "red" && out.sites[5].note.includes("404"));
  chk("backtest 失敗不垮端點：其餘五站照常 green＋schema 不變",
    out.schema === 1 && out.status === "ok" && out.sites.slice(0, 5).every((x) => x.level === "green"));
  // 帳冊抓得到但無可解析的日期列（空檔／欄位壞掉）→ red，仍不垮端點
  const emptyLedger = async (u, init) => {
    if (String(u).endsWith("/ledger.csv")) return { ok: true, status: 206, text: async () => "date,sox_date,cum_pnl\n" };
    return okFetch(u, init);
  };
  const out2 = await buildStatus({ FLOW_KV: kv }, TUE, emptyLedger, NOW);
  chk("backtest 帳冊無資料列 → red＋data_date null", out2.sites[5].level === "red" && out2.sites[5].data_date === null);
}
{
  // fetchStatusTail 的 200 回退：CDN 忽略後綴 Range 回整檔時，串流只保留尾端，不整包留在記憶體
  const chunks = ["date,a,b\n", "2026-08-09,1,2\n", "2026-08-10,3,4\n", "2026-08-11,5,6\n"];
  const streamFetch = async (u, init) => {
    if (!String(u).endsWith("/ledger.csv")) return okFetch(u, init);
    let i = 0;
    return { ok: true, status: 200,   // 注意：非 206，走 reader 分支
      body: { getReader: () => ({
        async read() { return i < chunks.length ? { value: new TextEncoder().encode(chunks[i++]), done: false } : { value: undefined, done: true }; },
        cancel: async () => {} }) },
      text: async () => { throw new Error("200 全檔不該走 r.text()"); } };
  };
  const kv = fakeKV({ "fi:2026-08-11": ["09:01"] });
  const out = await buildStatus({ FLOW_KV: kv }, TUE, streamFetch, NOW);
  chk("backtest：CDN 回 200 全檔時走串流尾端回退，仍取到最後一列",
    out.sites[5].data_date === "2026-08-11" && out.sites[5].level === "green",
    JSON.stringify(out.sites[5]));
}
{
  // ---- 端到端重現：2026-09-07（週一）18:12，postmkt/flows 都停在上一交易日 09-04（週五）----
  // 這是本次修正的動機情境。舊版六站有兩顆假黃燈；新版全綠。data_date 欄位語意不變。
  const MON = { date: "2026-09-07", dow: 1, hour: 18, minute: 12 };
  const MON_NOW = Date.parse("2026-09-07T18:12:00+08:00");
  const eodFetch = async (u, init) => {
    const s2 = String(u);
    if (s2.includes("/taiwan-flows/")) return { ok: true, status: 200, json: async () => ({ date: "2026-09-04", status: "ok", checked_at: "2026-09-04T23:40:00+08:00" }) };
    if (s2.endsWith("/news.json")) return { ok: true, status: 200, json: async () => ({ generated_at: "2026-09-07T17:07:00+08:00", trading_days: ["2026-09-04"], total_news: 20 }) };
    if (s2.endsWith("/daily-brief-card.json")) return { ok: true, status: 200, json: async () => ({ date: "2026-09-07", edition: 30, generated_at: "2026-09-07T07:30:00+08:00" }) };
    if (s2.endsWith("/postmkt.json")) return { ok: true, status: 206, text: async () => '{"date":"2026-09-04","generated_at":"2026-09-04T22:05:00+08:00","margin":{' };
    if (s2.endsWith("/ledger.csv")) return { ok: true, status: 206, text: async () => "date,a\n2026-09-04,1\n" };
    return { ok: false, status: 404, json: async () => null, text: async () => "" };
  };
  // live 是盤中站，週一 18:12 本來就該有當日 frame（09:00 分水嶺已過）——給今日 frame，
  // 它的 green 是真的綠，不是被時間感知放水的（下方另有 live 盤前／盤後兩種時鐘的對照）。
  const kv = fakeKV({ "fi:2026-09-07": ["09:01", "13:30"] });
  const out = await buildStatus({ FLOW_KV: kv }, MON, eodFetch, MON_NOW);
  const byId = Object.fromEntries(out.sites.map((x) => [x.id, x]));
  chk("端到端：六站全 green（假黃燈消失）", out.sites.every((x) => x.level === "green"),
    out.sites.map((x) => `${x.id}:${x.level}`).join(" "));
  chk("端到端：data_date 語意不動（postmkt 仍回報 2026-09-04）", byId.postmkt.data_date === "2026-09-04");
  chk("端到端：舊版同一份資料會判 yellow（證明差別來自時間感知，不是資料變了）",
    gradeMarket(byId.postmkt.data_date, MON) === "yellow" && gradeMarket(byId.flows.data_date, MON) === "yellow");
  // 同一份資料到 23:00 仍未更新 → postmkt/flows/live 該黃的黃（不是永遠不報）
  const MON23 = { date: "2026-09-07", dow: 1, hour: 23, minute: 0 };
  const out23 = await buildStatus({ FLOW_KV: kv }, MON23, eodFetch, Date.parse("2026-09-07T23:00:00+08:00"));
  const b23 = Object.fromEntries(out23.sites.map((x) => [x.id, x]));
  chk("端到端 23:00：postmkt/flows 轉 yellow（該報的照報）",
    b23.postmkt.level === "yellow" && b23.flows.level === "yellow",
    out23.sites.map((x) => `${x.id}:${x.level}`).join(" "));
  chk("端到端 23:00：backtest 轉 yellow（台北 21:07~隔日 01:07 等待窗）", b23.backtest.level === "yellow");
  chk("端到端 23:00：live 有今日 frame → 仍 green（不被鄰站拖累）", b23.live.level === "green");
  // live 的 dueHour=9：同樣「只有上一交易日 frame」，盤前 08:00 是 green、盤後 09:30 是 yellow
  const kvFri = fakeKV({ "fi:2026-09-04": ["09:01", "13:30"] });
  const pre = await buildStatus({ FLOW_KV: kvFri }, { date: "2026-09-07", dow: 1, hour: 8, minute: 0 }, eodFetch, MON_NOW);
  const post = await buildStatus({ FLOW_KV: kvFri }, { date: "2026-09-07", dow: 1, hour: 9, minute: 30 }, eodFetch, MON_NOW);
  chk("live 盤前 08:00 只有上一交易日 frame → green", pre.sites[0].level === "green" && pre.sites[0].data_date === "2026-09-04");
  chk("live 開盤後 09:30 仍只有上一交易日 frame → yellow", post.sites[0].level === "yellow");
}
{
  // ---- /status 完整回應形狀（schema:1 契約；入口站與 harness 看門狗共用資料面）----
  const kv = fakeKV({ "fi:2026-08-11": ["09:01", "13:30"] });
  const out = await buildStatus({ FLOW_KV: kv }, TUE, okFetch, NOW);
  chk("頂層鍵恰為 schema/generated_at/status/sites",
    Object.keys(out).sort().join(",") === "generated_at,schema,sites,status", Object.keys(out).join(","));
  chk("sites 為長度 6 的陣列", Array.isArray(out.sites) && out.sites.length === 6);
  chk("每站鍵恰為 id/name/data_date/updated_at/level/note（無新增欄位）",
    out.sites.every((x) => Object.keys(x).sort().join(",") === "data_date,id,level,name,note,updated_at"),
    JSON.stringify(Object.keys(out.sites[5])));
  chk("level 值域仍只有 green/yellow/red",
    out.sites.every((x) => ["green", "yellow", "red"].includes(x.level)));
  chk("六站 id/name 對照", out.sites.map((x) => `${x.id}=${x.name}`).join(",") ===
    "live=即時類股動態,flows=盤後法人動態,news=新聞晨報,brief=每日晨報,postmkt=盤後分析,backtest=策略回測",
    out.sites.map((x) => `${x.id}=${x.name}`).join(","));
  chk("JSON 可序列化且無 undefined", JSON.parse(JSON.stringify(out)).sites.length === 6);
}

console.log(`status.mjs: ${pass} pass, ${fail} fail`);
if (fail) process.exit(1);
