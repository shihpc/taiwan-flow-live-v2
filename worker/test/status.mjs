// /status 全系統資料健康端點離線單元測試（2026-08-11）
// 無需 token、不打真實網路——fetch 全用 mock。執行：cd worker && node test/status.mjs
import { addDaysISO, lastExpectedTradingDate, lastExpectedDailyDate, dueReached,
  prevExpectedTradingDate, gradeMarket,
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

// ---- brief 判級（dueHour 省略＝舊的「不看時間、一律期待今日」行為，保留給回歸比對）----
{
  chk("brief：date＝今天(平日) → green", gradeBrief("2026-08-11", TUE) === "green");
  chk("brief：date＝昨天(平日) → yellow", gradeBrief("2026-08-10", TUE) === "yellow");
  chk("brief：更舊 → red", gradeBrief("2026-08-07", TUE) === "red");
  chk("brief：無日期 → red", gradeBrief(null, TUE) === "red");
  // 週末：晨報**每日出刊**（實證＝taiwan-stock-news 的 daily-brief-card.json commit 歷史，
  // 2026-08-11~09-08 共 29 期期號連號、含每個週六日），所以週末與平日同一把尺，
  // 不再有「週末最多 yellow」的舊分支（那分支預設週末不出刊，與實證不符）。
  chk("brief：週六 12:00 看週五版（落後 1 天）→ yellow", gradeBrief("2026-08-07", SAT) === "yellow");
  chk("brief：週日 12:00 仍是週五版（落後 2 天，已漏兩期）→ red",
    gradeBrief("2026-08-07", SUN) === "red");
  chk("brief：週六看當日版 → green", gradeBrief("2026-08-08", SAT) === "green");
  chk("brief：週末但版太舊 → red", gradeBrief("2026-08-06", SAT) === "red");
}

// ---- brief 時間感知判級（2026-09-08）：晨報台北 07:30 產製，dueHour=8 ----
// 舊版平日一律期待「今日」，於是每天 00:00~07:30 必然 yellow（線上實打：台北 2026-09-09 00:29
// 打 /status 得 brief data_date=2026-09-08、level=yellow），與 postmkt 那顆假黃同型。
// 8 這個值取 claude-harness/tools/freshness_watchdog.py 的 DAILY_CUTOFF = time(8, 0)
// （judge_brief／daily_target：08:00 後 date 應＝今日），不另創口徑。
{
  const DUE = STATUS_DUE_HOUR.brief;
  const tue = (h, m = 0) => ({ date: "2026-08-11", dow: 2, hour: h, minute: m });
  const sun = (h, m = 0) => ({ date: "2026-08-09", dow: 0, hour: h, minute: m });
  chk("STATUS_DUE_HOUR.brief === 8（＝看門狗 DAILY_CUTOFF）", DUE === 8, JSON.stringify(STATUS_DUE_HOUR));
  chk("dueReached：8 點前未到、8 點整已到",
    dueReached(tue(7, 59), 8) === false && dueReached(tue(8, 0), 8) === true);
  // 預期日曆日本身：日曆日不跳週末（與 lastExpectedTradingDate 的差別）
  chk("預期日曆日：平日 08:00 前＝昨日、08:00 後＝今日",
    lastExpectedDailyDate(tue(7, 59), 8) === "2026-08-10"
    && lastExpectedDailyDate(tue(8, 0), 8) === "2026-08-11");
  chk("預期日曆日：週日 08:00 前退到週六（不跳成週五）",
    lastExpectedDailyDate(sun(6), 8) === "2026-08-08" && lastExpectedDailyDate(sun(9), 8) === "2026-08-09");
  chk("預期日曆日：dueHour 省略＝一律今日", lastExpectedDailyDate(tue(0)) === "2026-08-11");
  // ① 00:00~08:00 之間、brief 為前一日 → green（晨報還沒產，舊版是假黃）
  chk("brief 00:29 停在昨日 → green（07:30 還沒產，舊版此處假黃）",
    gradeBrief("2026-08-10", tue(0, 29), DUE) === "green");
  chk("brief 07:59 停在昨日 → green（邊界內）",
    gradeBrief("2026-08-10", tue(7, 59), DUE) === "green");
  // ② 08:00 之後仍為前一日 → yellow
  chk("brief 08:00 仍停在昨日 → yellow（該產而未產）",
    gradeBrief("2026-08-10", tue(8, 0), DUE) === "yellow");
  chk("brief 12:00 仍停在昨日 → yellow", gradeBrief("2026-08-10", tue(12), DUE) === "yellow");
  chk("brief 08:00 後有今日版 → green", gradeBrief("2026-08-11", tue(8, 0), DUE) === "green");
  // ③ 落後兩日 → red
  chk("brief 08:00 後落後兩日 → red", gradeBrief("2026-08-09", tue(8, 0), DUE) === "red");
  chk("brief 07:00 落後兩日（相對昨日仍落後一日以上）→ red",
    gradeBrief("2026-08-08", tue(7), DUE) === "red");
  chk("brief：無日期 → red（dueHour 不影響）", gradeBrief(null, tue(3), DUE) === "red");
  // ④ dueHour 省略＝舊行為（平日：今日 green／昨日 yellow／更舊 red）
  chk("brief：dueHour 省略＝舊行為（平日凌晨仍期待今日）",
    gradeBrief("2026-08-10", tue(0, 29)) === "yellow"
    && gradeBrief("2026-08-11", tue(0, 29)) === "green"
    && gradeBrief("2026-08-09", tue(0, 29)) === "red");
  // ⑤ 週末：同一把尺（每日出刊），dueHour 也一樣生效
  chk("brief 週日 06:00 停在週六 → green（今日份 07:30 才產）",
    gradeBrief("2026-08-08", sun(6), DUE) === "green");
  chk("brief 週日 09:00 停在週六 → yellow", gradeBrief("2026-08-08", sun(9), DUE) === "yellow");
  chk("brief 週日 09:00 停在週五 → red（落後兩期；舊版寬待成 yellow，與看門狗 judge_brief 判 STALE 不一致）",
    gradeBrief("2026-08-07", sun(9), DUE) === "red");
  chk("brief 週日 09:00 有當日版 → green", gradeBrief("2026-08-09", sun(9), DUE) === "green");
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
  if (s.endsWith("/taiwan-stock-iching/main/data/web/latest.json")) {
    // 第七站 iching（2026-09-26）：latest.json 約 1.36MB，必須帶 Range 只取檔頭（比照 postmkt：未帶 Range 回 500）。
    // 檔頭形狀＝線上 2026-09-26 curl 實查（sort_keys、**頂層無 generated_at**、有一個容易看錯的 generated_from）。
    // 兩個陷阱刻意放進 fixture：①generated_from 的日期**與 date 不同**（撈錯欄位就會露餡）；
    // ②date 之後、2KB 內放一個**非頂層**的 "generated_at"（market 底下）——extractHeadFields 的 regex 不分層級、
    // 會撈到它，所以 buildStatus 必須寫死 updated_at: null，不能用 h.generated_at。
    if (!init || !init.headers || !init.headers.Range) return { ok: false, status: 500, text: async () => "" };
    return { ok: true, status: 206, text: async () =>
      '{"calibrated":true,"data_version":"fm-20260911-01","date":"2026-08-11","generated_from":"data/scores/2026-08-10.json","market":{"generated_at":"2026-08-11T00:00:00+08:00","close":' };
  }
  return { ok: false, status: 404, json: async () => null, text: async () => "" };
};
// 改動前（bdcd486，六站版）同一 fixture 的 sites 輸出，逐位釘住：第七站附加後前六站不得有任何位元變化。
// 三組分別對應下方 okFetch/TUE、eodFetch/週一 18:12、eodFetch/週一 23:00 三個整合案例。
// 取 iching 站：找不到時記一筆乾淨的 fail 並回空物件（後續斷言照常 fail，不會 TypeError 崩掉整支測試）
const ichingOf = (out, ctx = "") => {
  const x = out && Array.isArray(out.sites) ? out.sites.find((y) => y && y.id === "iching") : undefined;
  if (!x) chk(`iching 站存在於 sites ${ctx}`, false, out && out.sites ? out.sites.map((y) => y.id).join(",") : String(out));
  return x || {};
};
const SIX_BEFORE_OK = '[{"id":"live","name":"即時類股動態","data_date":"2026-08-11","updated_at":"2026-08-11T13:30:00+08:00","level":"green","note":"2026-08-11 共 3 格 frame"},{"id":"flows","name":"盤後法人動態","data_date":"2026-08-11","updated_at":"2026-08-11T21:30:00+08:00","level":"green","note":"健檢 ok"},{"id":"news","name":"新聞晨報","data_date":"2026-08-11","updated_at":"2026-08-11T21:52:00+08:00","level":"green","note":"42 則新聞"},{"id":"brief","name":"每日晨報","data_date":"2026-08-11","updated_at":"2026-08-11T07:30:00+08:00","level":"green","note":"第 3 版"},{"id":"postmkt","name":"盤後分析","data_date":"2026-08-11","updated_at":"2026-08-11T21:01:04+08:00","level":"green","note":""},{"id":"backtest","name":"策略回測","data_date":"2026-08-11","updated_at":null,"level":"green","note":"walkforward 帳冊"}]';
const SIX_BEFORE_EOD_1812 = '[{"id":"live","name":"即時類股動態","data_date":"2026-09-07","updated_at":"2026-09-07T13:30:00+08:00","level":"green","note":"2026-09-07 共 2 格 frame"},{"id":"flows","name":"盤後法人動態","data_date":"2026-09-04","updated_at":"2026-09-04T23:40:00+08:00","level":"green","note":"健檢 ok"},{"id":"news","name":"新聞晨報","data_date":"2026-09-04","updated_at":"2026-09-07T17:07:00+08:00","level":"green","note":"20 則新聞"},{"id":"brief","name":"每日晨報","data_date":"2026-09-07","updated_at":"2026-09-07T07:30:00+08:00","level":"green","note":"第 30 版"},{"id":"postmkt","name":"盤後分析","data_date":"2026-09-04","updated_at":"2026-09-04T22:05:00+08:00","level":"green","note":""},{"id":"backtest","name":"策略回測","data_date":"2026-09-04","updated_at":null,"level":"green","note":"walkforward 帳冊"}]';
const SIX_BEFORE_EOD_2300 = '[{"id":"live","name":"即時類股動態","data_date":"2026-09-07","updated_at":"2026-09-07T13:30:00+08:00","level":"green","note":"2026-09-07 共 2 格 frame"},{"id":"flows","name":"盤後法人動態","data_date":"2026-09-04","updated_at":"2026-09-04T23:40:00+08:00","level":"yellow","note":"健檢 ok"},{"id":"news","name":"新聞晨報","data_date":"2026-09-04","updated_at":"2026-09-07T17:07:00+08:00","level":"yellow","note":"20 則新聞"},{"id":"brief","name":"每日晨報","data_date":"2026-09-07","updated_at":"2026-09-07T07:30:00+08:00","level":"green","note":"第 30 版"},{"id":"postmkt","name":"盤後分析","data_date":"2026-09-04","updated_at":"2026-09-04T22:05:00+08:00","level":"yellow","note":""},{"id":"backtest","name":"策略回測","data_date":"2026-09-04","updated_at":null,"level":"yellow","note":"walkforward 帳冊"}]';
{
  const kv = fakeKV({ "fi:2026-08-11": ["09:01", "09:02", "13:30"] });
  const out = await buildStatus({ FLOW_KV: kv }, TUE, okFetch, NOW);
  chk("schema:1＋generated_at＋status:ok", out.schema === 1 && out.status === "ok" && /\+08:00$/.test(out.generated_at));
  chk("七站齊全且順序 live/flows/news/brief/postmkt/backtest/iching（既有六站順序不動，iching 附加在後）",
    out.sites.map((s) => s.id).join(",") === "live,flows,news,brief,postmkt,backtest,iching",
    out.sites.map((s) => s.id).join(","));
  chk("前六站輸出與改動前（六站版）逐位相同", JSON.stringify(out.sites.slice(0, 6)) === SIX_BEFORE_OK,
    JSON.stringify(out.sites.slice(0, 6)));
  chk("每站欄位齊全（id/name/data_date/updated_at/level/note）",
    out.sites.every((s) => ["id", "name", "data_date", "updated_at", "level", "note"].every((k) => k in s)));
  chk("全鮮 → 七站 green", out.sites.every((s) => s.level === "green"),
    out.sites.map((s) => `${s.id}:${s.level}`).join(" "));
  const bt = out.sites[5];
  chk("backtest：資料日＝帳冊最後一列、updated_at 為 null（帳冊無產出時刻欄，不臆造）",
    bt.id === "backtest" && bt.data_date === "2026-08-11" && bt.updated_at === null,
    JSON.stringify(bt));
  const live = out.sites[0];
  chk("live 用 KV frame 索引（資料日＝今天、updated_at＝最後格）",
    live.data_date === "2026-08-11" && live.updated_at === "2026-08-11T13:30:00+08:00");
  chk("brief 判 date 而非 generated_at", out.sites[3].data_date === "2026-08-11");
  const ic = out.sites[6] || {};
  chk("iching：index 6、資料日取檔頭 date、updated_at 固定 null、note 空字串",
    ic.id === "iching" && ic.name === "股市易經" && ic.data_date === "2026-08-11" && ic.updated_at === null && ic.note === "",
    JSON.stringify(ic));
  chk("iching：data_date 取頂層 date（2026-08-11），不是 generated_from 的 2026-08-10",
    ic.data_date === "2026-08-11" && ic.data_date !== "2026-08-10", JSON.stringify(ic));
  chk("iching：檔頭 2KB 內有非頂層 generated_at 時 updated_at 仍 null（寫死、不用 h.generated_at）",
    ic.updated_at === null && extractHeadFields('"date":"x","market":{"generated_at":"2026-08-11T00:00:00+08:00"').generated_at !== null,
    JSON.stringify(ic));
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
  chk("其餘站不受拖累（live/news/brief/backtest/iching 仍 green）",
    [0, 2, 3, 5, 6].every((i) => (out.sites[i] || {}).level === "green"), out.sites.map((x) => `${x.id}:${x.level}`).join(" "));
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
  // backtest 單站失敗（帳冊抓不到）→ 只染紅該站，端點與其餘六站不受影響
  const noLedger = async (u, init) => {
    if (String(u).endsWith("/ledger.csv")) return { ok: false, status: 404, text: async () => "" };
    return okFetch(u, init);
  };
  const kv = fakeKV({ "fi:2026-08-11": ["09:01"] });
  const out = await buildStatus({ FLOW_KV: kv }, TUE, noLedger, NOW);
  chk("backtest 404 → 該站 red＋note 說明", out.sites[5].level === "red" && out.sites[5].note.includes("404"));
  chk("backtest 失敗不垮端點：其餘六站照常 green＋schema 不變",
    out.schema === 1 && out.status === "ok" && out.sites.filter((x) => x.id !== "backtest").every((x) => x.level === "green"));
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
    if (s2.endsWith("/taiwan-stock-iching/main/data/web/latest.json")) return { ok: true, status: 206, text: async () =>
      '{"calibrated":true,"data_version":"fm-20260911-01","date":"2026-09-04","generated_from":"data/scores/2026-09-03.json","market":{"generated_at":"2026-09-04T00:00:00+08:00","close":' };
    return { ok: false, status: 404, json: async () => null, text: async () => "" };
  };
  // live 是盤中站，週一 18:12 本來就該有當日 frame（09:00 分水嶺已過）——給今日 frame，
  // 它的 green 是真的綠，不是被時間感知放水的（下方另有 live 盤前／盤後兩種時鐘的對照）。
  const kv = fakeKV({ "fi:2026-09-07": ["09:01", "13:30"] });
  const out = await buildStatus({ FLOW_KV: kv }, MON, eodFetch, MON_NOW);
  const byId = Object.fromEntries(out.sites.map((x) => [x.id, x]));
  chk("端到端：七站全 green（假黃燈消失）", out.sites.every((x) => x.level === "green"),
    out.sites.map((x) => `${x.id}:${x.level}`).join(" "));
  chk("端到端：前六站輸出與改動前逐位相同（週一 18:12）", JSON.stringify(out.sites.slice(0, 6)) === SIX_BEFORE_EOD_1812,
    JSON.stringify(out.sites.slice(0, 6)));
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
  chk("端到端 23:00：iching 停在上一交易日 → 仍 green（dueHour 23:45 未到）、updated_at null",
    ichingOf(out23, "(23:00)").level === "green" && ichingOf(out23, "(23:00)").updated_at === null);
  chk("端到端：前六站輸出與改動前逐位相同（週一 23:00，含三顆 yellow）", JSON.stringify(out23.sites.slice(0, 6)) === SIX_BEFORE_EOD_2300,
    JSON.stringify(out23.sites.slice(0, 6)));
  // live 的 dueHour=9：同樣「只有上一交易日 frame」，盤前 08:00 是 green、盤後 09:30 是 yellow
  const kvFri = fakeKV({ "fi:2026-09-04": ["09:01", "13:30"] });
  const pre = await buildStatus({ FLOW_KV: kvFri }, { date: "2026-09-07", dow: 1, hour: 8, minute: 0 }, eodFetch, MON_NOW);
  const post = await buildStatus({ FLOW_KV: kvFri }, { date: "2026-09-07", dow: 1, hour: 9, minute: 30 }, eodFetch, MON_NOW);
  chk("live 盤前 08:00 只有上一交易日 frame → green", pre.sites[0].level === "green" && pre.sites[0].data_date === "2026-09-04");
  chk("live 開盤後 09:30 仍只有上一交易日 frame → yellow", post.sites[0].level === "yellow");
  // brief 的 dueHour=8 接線（比照上方 live 的同型測試）：同一份「晨報 date 停在昨日」的資料，
  // 台北 07:00（07:30 產製前）是 green，09:00（過了 dueHour）轉 yellow。
  // 這組是 buildStatus 層級的端到端案例——上面三組整合 fixture 的 brief.date 都等於 tp.date，
  // 不論 due 給不給都是 green，擋不住「buildStatus 漏傳 d.due 給 gradeBrief」這種接線退化。
  const staleBriefFetch = async (u, init) => {
    if (String(u).endsWith("/daily-brief-card.json")) {
      return { ok: true, status: 200, json: async () => ({ date: "2026-09-06", edition: 29, generated_at: "2026-09-06T07:30:00+08:00" }) };
    }
    return eodFetch(u, init);
  };
  const briefPre = await buildStatus({ FLOW_KV: kv }, { date: "2026-09-07", dow: 1, hour: 7, minute: 0 }, staleBriefFetch, MON_NOW);
  const briefPost = await buildStatus({ FLOW_KV: kv }, { date: "2026-09-07", dow: 1, hour: 9, minute: 0 }, staleBriefFetch, MON_NOW);
  const bPre = Object.fromEntries(briefPre.sites.map((x) => [x.id, x]));
  const bPost = Object.fromEntries(briefPost.sites.map((x) => [x.id, x]));
  chk("brief 產製前 07:00 date 停在昨日 → green（dueHour=8 已接線）",
    bPre.brief.level === "green" && bPre.brief.data_date === "2026-09-06",
    JSON.stringify(bPre.brief));
  chk("brief 過 dueHour 09:00 date 仍停在昨日 → yellow（該報的照報）",
    bPost.brief.level === "yellow" && bPost.brief.data_date === "2026-09-06",
    JSON.stringify(bPost.brief));
}
{
  // ---- /status 完整回應形狀（schema:1 契約；入口站與 harness 看門狗共用資料面）----
  const kv = fakeKV({ "fi:2026-08-11": ["09:01", "13:30"] });
  const out = await buildStatus({ FLOW_KV: kv }, TUE, okFetch, NOW);
  chk("頂層鍵恰為 schema/generated_at/status/sites",
    Object.keys(out).sort().join(",") === "generated_at,schema,sites,status", Object.keys(out).join(","));
  chk("sites 為長度 7 的陣列", Array.isArray(out.sites) && out.sites.length === 7);
  chk("每站鍵恰為 id/name/data_date/updated_at/level/note（無新增欄位）",
    out.sites.every((x) => Object.keys(x).sort().join(",") === "data_date,id,level,name,note,updated_at"),
    JSON.stringify(Object.keys(out.sites[5])));
  chk("level 值域仍只有 green/yellow/red",
    out.sites.every((x) => ["green", "yellow", "red"].includes(x.level)));
  chk("七站 id/name 對照", out.sites.map((x) => `${x.id}=${x.name}`).join(",") ===
    "live=即時類股動態,flows=盤後法人動態,news=新聞晨報,brief=每日晨報,postmkt=盤後分析,backtest=策略回測,iching=股市易經",
    out.sites.map((x) => `${x.id}=${x.name}`).join(","));
  chk("JSON 可序列化且無 undefined", JSON.parse(JSON.stringify(out)).sites.length === 7);
}

// ---- 第七站 iching（2026-09-26）：dueHour=23.75（台北 23:45，使用者裁定）----
// 依據＝實際 commit 時刻（該站前端無新鮮度判級可對齊）：主班 Worker 22:30 dispatch、實測 commit
// 台北 22:32～22:59；補叫班 23:30 → 實測 23:34 落地；加 raw CDN max-age=300 ＋ /status cf 快取 5 分，
// 最壞約 23:44 才看得到 → 取 23.75 讓補叫班日也無假黃。走 gradeMarket 的交易日階梯（每日班只在交易日產出）。
{
  const DUE = STATUS_DUE_HOUR.iching;
  chk("STATUS_DUE_HOUR.iching === 23.75（23:45）且 < 24（≥24 會讓 dueReached 永不成立、缺料判不出來）",
    DUE === 23.75 && DUE < 24, JSON.stringify(STATUS_DUE_HOUR));
  chk("STATUS_DUE_HOUR 既有四值不動", STATUS_DUE_HOUR.live === 9 && STATUS_DUE_HOUR.flows === 20
    && STATUS_DUE_HOUR.postmkt === 22.5 && STATUS_DUE_HOUR.brief === 8);
  chk("STATUS_DUE_HOUR 鍵恰為 live/flows/postmkt/brief/iching",
    Object.keys(STATUS_DUE_HOUR).join(",") === "live,flows,postmkt,brief,iching");
  const tue = (h, m = 0) => ({ date: "2026-08-11", dow: 2, hour: h, minute: m });
  chk("dueReached：23:44 未到、23:45 到、23:59 到",
    dueReached(tue(23, 44), DUE) === false && dueReached(tue(23, 45), DUE) === true && dueReached(tue(23, 59), DUE) === true);
  // 純函式層：資料日＝前一交易日
  chk("iching 平日 23:44 停在前一交易日 → green", gradeMarket("2026-08-10", tue(23, 44), DUE) === "green");
  chk("iching 平日 23:45 仍停在前一交易日 → yellow", gradeMarket("2026-08-10", tue(23, 45), DUE) === "yellow");
  chk("iching 平日 23:45 有今日 → green", gradeMarket("2026-08-11", tue(23, 45), DUE) === "green");
  chk("iching 平日 00:00（隔日凌晨）停在前一交易日 → green（下一個 dueHour 還沒到）",
    gradeMarket("2026-08-10", { date: "2026-08-11", dow: 2, hour: 0, minute: 0 }, DUE) === "green");
  // 階梯整段前移一格（同 postmkt 那組）：dueHour 前預期日＝前一交易日 08-10，08-07 相對它只落後 1 格 → yellow；
  // 過了 23:45 預期日＝08-11，08-07 落後 2 格 → red；08-06 在 dueHour 前就已落後 2 格 → red。
  chk("iching 落後 2 交易日：dueHour 前 yellow、dueHour 後 red；落後 3 交易日一律 red",
    gradeMarket("2026-08-07", tue(12), DUE) === "yellow" && gradeMarket("2026-08-07", tue(23, 50), DUE) === "red"
    && gradeMarket("2026-08-06", tue(12), DUE) === "red");
  chk("iching 週六／週日看週五 → green；停在週四 → yellow",
    gradeMarket("2026-08-07", SAT, DUE) === "green" && gradeMarket("2026-08-07", SUN, DUE) === "green"
    && gradeMarket("2026-08-06", SAT, DUE) === "yellow");
  chk("iching 無日期 → red", gradeMarket(null, tue(12), DUE) === "red");

  // 端到端（buildStatus 層）：證明 defs 的 grade:"market" else 分支確實把 d.due 傳進 gradeMarket
  // ——若漏傳（dueHour 退回 0＝一律期待今日），23:44 那組會變 yellow。
  // 資料日 2026-09-04（週五）＝前一交易日；台北 2026-09-07（週一）23:44 / 23:45、隔日 09-08 23:45。
  const icFetch = (date) => async (u, init) => {
    if (String(u).endsWith("/taiwan-stock-iching/main/data/web/latest.json")) {
      if (!init || !init.headers || !init.headers.Range) return { ok: false, status: 500, text: async () => "" };
      return { ok: true, status: 206, text: async () =>
        `{"calibrated":true,"data_version":"fm-20260911-01","date":"${date}","generated_from":"data/scores/2000-01-01.json","market":{"generated_at":"${date}T00:00:00+08:00","close":` };
    }
    return okFetch(u, init);
  };
  const kv = fakeKV({ "fi:2026-09-07": ["09:01", "13:30"] });
  const at = (date, dow, h, m) => ({ date, dow, hour: h, minute: m });
  const ms = (tp) => Date.parse(`${tp.date}T${String(tp.hour).padStart(2, "0")}:${String(tp.minute).padStart(2, "0")}:00+08:00`);
  const g = async (tp, fetchFn) => ichingOf(await buildStatus({ FLOW_KV: kv }, tp, fetchFn, ms(tp)), `(${tp.date} ${tp.hour}:${tp.minute})`);
  const f0904 = icFetch("2026-09-04");
  const a = await g(at("2026-09-07", 1, 23, 44), f0904);
  chk("端到端 iching 週一 23:44 資料日＝前一交易日 → green（dueHour 已由 d.due 接線）",
    a.level === "green" && a.data_date === "2026-09-04" && a.updated_at === null, JSON.stringify(a));
  const b = await g(at("2026-09-07", 1, 23, 45), f0904);
  chk("端到端 iching 週一 23:45 仍停在前一交易日 → yellow", b.level === "yellow" && b.data_date === "2026-09-04" && b.updated_at === null, JSON.stringify(b));
  const c = await g(at("2026-09-08", 2, 23, 45), f0904);
  chk("端到端 iching 隔日（週二）23:45 仍停在 09-04 → red（落後 2 交易日）", c.level === "red", JSON.stringify(c));
  const d = await g(at("2026-09-07", 1, 23, 45), icFetch("2026-09-07"));
  chk("端到端 iching 週一 23:45 有今日 → green（data_date 取 date、非 generated_from 的 2000-01-01；updated_at null）",
    d.level === "green" && d.data_date === "2026-09-07" && d.updated_at === null, JSON.stringify(d));
  // 週末：看週五（2026-09-12 週六／09-13 週日）
  const w1 = await g(at("2026-09-12", 6, 12, 0), icFetch("2026-09-11"));
  const w2 = await g(at("2026-09-13", 0, 23, 50), icFetch("2026-09-11"));
  const w3 = await g(at("2026-09-12", 6, 12, 0), icFetch("2026-09-10"));
  chk("端到端 iching 週六／週日資料＝週五 → green；停在週四 → yellow",
    w1.level === "green" && w2.level === "green" && w3.level === "yellow", `${w1.level} ${w2.level} ${w3.level}`);
  // 來源 404／500 → 只染紅 iching，其餘六站不受影響（allSettled）
  for (const st of [404, 500]) {
    const bad = async (u, init) => String(u).endsWith("/taiwan-stock-iching/main/data/web/latest.json")
      ? { ok: false, status: st, text: async () => "" } : okFetch(u, init);
    const kvT = fakeKV({ "fi:2026-08-11": ["09:01"] });
    const o = await buildStatus({ FLOW_KV: kvT }, TUE, bad, NOW);
    const oi = ichingOf(o, `(${st})`);
    chk(`iching 來源 ${st} → 該站 red＋note 帶狀態碼＋日期 null`,
      oi.level === "red" && String(oi.note).includes(String(st)) && oi.data_date === null, JSON.stringify(oi));
    chk(`iching 來源 ${st} 時仍在 index 6`, o.sites[6] === oi);
    chk(`iching 來源 ${st} 不垮端點：前六站照常 green、schema 不變`,
      o.schema === 1 && o.status === "ok" && o.sites.slice(0, 6).every((x) => x.level === "green"));
  }
  // 抓得到但檔頭撈不到頂層 date（形狀壞掉）→ red、data_date null、updated_at null。
  // fixture 仍帶 generated_from 與非頂層 generated_at：兩者都不得被拿來補 data_date／updated_at。
  const noDate = async (u, init) => String(u).endsWith("/taiwan-stock-iching/main/data/web/latest.json")
    ? { ok: true, status: 206, text: async () => '{"calibrated":true,"generated_from":"data/scores/2026-08-11.json","market":{"generated_at":"2026-08-11T00:00:00+08:00","close":' } : okFetch(u, init);
  const o2 = await buildStatus({ FLOW_KV: fakeKV({ "fi:2026-08-11": ["09:01"] }) }, TUE, noDate, NOW);
  const o2i = ichingOf(o2, "(no date)");
  chk("iching 檔頭無頂層 date → red＋data_date null＋updated_at null（不拿 generated_from／巢狀 generated_at 補）",
    o2i.level === "red" && o2i.data_date === null && o2i.updated_at === null, JSON.stringify(o2i));
  // 必須帶 Range（1.36MB 大檔不整包抓）：okFetch 的 iching 分支對未帶 Range 回 500，上方整合案例全鮮即為證；
  // 這裡再直接看請求標頭，讓「拿掉 Range」這種退化在兩處都會紅。
  const seen = [];
  const spy = async (u, init) => { if (String(u).endsWith("/taiwan-stock-iching/main/data/web/latest.json")) seen.push(init && init.headers && init.headers.Range); return okFetch(u, init); };
  await buildStatus({ FLOW_KV: fakeKV() }, TUE, spy, NOW);
  chk("iching 請求帶檔頭 Range（bytes=0-N）", seen.length === 1 && /^bytes=0-\d+$/.test(String(seen[0])), JSON.stringify(seen));
}

console.log(`status.mjs: ${pass} pass, ${fail} fail`);
if (fail) process.exit(1);
