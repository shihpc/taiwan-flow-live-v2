// 排程備援離線單元測試（無需 token、不打真實網路——fetch 全用 mock）
// 執行：cd worker && node test/backup.mjs
import worker, { backupPipelines, backupPipelineForCron, BACKUP_CRONS, bkfiredKey,
  productFresh, runBackup, parseBkState, bkGate, bkStateValue, alertedKey,
  BK_RECHECK_MS, BK_MAX_ATTEMPTS, HEALTH_CRONS, jobstatKey,
  prevMonthOf, inDayWindow, REV_DAY_WINDOW, dispatchRoleForCron, HOLIDAYS_URL, resetHolidayMemo } from "../src/index.js";
import { readFile } from "node:fs/promises";

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; } else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}

const ENV = { DATA_BASE: "https://raw.githubusercontent.com/shihpc/taiwan-flow-live-v2/main/data" };
const pipes = backupPipelines(ENV);
const byName = Object.fromEntries(pipes.map((p) => [p.name, p]));

// ---- 設定表：八條班（2026-11-13 加 revenue；原七條）、repo、workflow 檔、產物 URL、日期欄、模式、交易日守門 ----
{
  chk("八條班齊全", pipes.length === 8 && ["daysummary","aetf","baseline","us","intraday","diag","mktbal","revenue"].every((n) => byName[n]));
  chk("daysummary 設定", byName.daysummary.wf === "daysummary.yml" && byName.daysummary.field === "date" &&
    byName.daysummary.url.endsWith("/daysummary/latest.json") && byName.daysummary.repo === "taiwan-flow-live-v2");
  chk("aetf 用 run_date 欄", byName.aetf.field === "run_date" && byName.aetf.wf === "aetf.yml");
  chk("baseline 用 date 欄", byName.baseline.field === "date" && byName.baseline.url.endsWith("/baseline.json"));
  // 2026-08-13：us 由 genToday 改 usDate——genToday 被 us.yml 每輪重寫的 generated_at 污染，
  // recheck 永遠判新鮮不補發；改判「資料日 ≥ 最近預期美股交易日」
  chk("us usDate＋date 欄＋非TW守門", byName.us.mode === "usDate" && byName.us.field === "date" && byName.us.tw === false);
  chk("intraday {date} 佔位＋tw 守門", byName.intraday.url.endsWith("/intraday/{date}.json") &&
    byName.intraday.wf === "intraday.yml" && byName.intraday.tw === true);
  chk("diag 跨 repo postmkt＋dep=postmkt.json", byName.diag.repo === "postmkt" && byName.diag.wf === "diag.yml" &&
    byName.diag.url === "https://raw.githubusercontent.com/shihpc/postmkt/main/data/diag/diag.json" &&
    byName.diag.dep?.url.endsWith("/data/postmkt.json") && byName.diag.dep?.field === "date");
  chk("mktbal 跨 repo＋latest_date 欄＋dep=diag.json", byName.mktbal.repo === "postmkt" && byName.mktbal.wf === "mktbal.yml" &&
    byName.mktbal.field === "latest_date" &&
    byName.mktbal.url === "https://raw.githubusercontent.com/shihpc/postmkt/main/data/market_balance_history.json" &&
    byName.mktbal.dep?.url.endsWith("/data/diag/diag.json") && byName.mktbal.dep?.field === "date");
  chk("TW 班皆 tw:true", ["daysummary","aetf","baseline","intraday","diag","mktbal"].every((n) => byName[n].tw === true));
}

// ---- event.cron → pipeline 對應（2026-07-22 主排程化：單體班五條；diag/mktbal 併入晚場協調班無專屬 cron）
//      2026-07-25：每班再加一條 recheck cron → 共十條；2026-11-13 加 revenue 主觸發一條（無 recheck）→ 十一條 ----
{
  chk("BACKUP_CRONS 十一條（五班 × 主觸發＋recheck，＋revenue 主觸發）", Object.keys(BACKUP_CRONS).length === 11, String(Object.keys(BACKUP_CRONS).length));
  for (const n of ["daysummary", "intraday", "aetf", "baseline", "us"]) {
    const crons = Object.entries(BACKUP_CRONS).filter(([, v]) => v === n).map(([k]) => k);
    chk(`${n} 恰兩條 cron（主＋recheck）`, crons.length === 2, crons.join(" | "));
  }
  chk("recheck cron 命中 daysummary（台北 14:05）", backupPipelineForCron("5 6 * * 2-6", ENV)?.name === "daysummary");
  chk("recheck cron 命中 intraday（台北 15:10）", backupPipelineForCron("10 7 * * 2-6", ENV)?.name === "intraday");
  chk("recheck cron 命中 aetf（台北 19:00）", backupPipelineForCron("0 11 * * 2-6", ENV)?.name === "aetf");
  chk("recheck cron 命中 baseline（台北 20:55）", backupPipelineForCron("55 12 * * 2-6", ENV)?.name === "baseline");
  chk("recheck cron 命中 us（台北 05:35，dow *）", backupPipelineForCron("35 21 * * *", ENV)?.name === "us");
  // cron 字串不得與既有任何一條重複（重複＝覆蓋掉別班的路由）
  const all = ["* 1-5 * * 2-6", "*/5 9-14 * * 2-6", "7,47 0-14,22-23 * * *", "*/5 13-15 * * 2-6",
    "50,55 22 * * *", "*/5 23 * * *", "*/10 0 * * *", ...Object.keys(BACKUP_CRONS), ...Object.keys(HEALTH_CRONS)];
  chk("全部 cron 字串互不重複（含健檢班共 20 條；2026-11-13 加 revenue，原 19）", new Set(all).size === all.length && all.length === 20, String(all.length));
  chk("cron 命中 daysummary（主觸發 13:35）", backupPipelineForCron("35 5 * * 2-6", ENV)?.name === "daysummary");
  chk("cron 命中 intraday（備援 14:40）", backupPipelineForCron("40 6 * * 2-6", ENV)?.name === "intraday");
  chk("cron 命中 aetf（主觸發 18:35）", backupPipelineForCron("35 10 * * 2-6", ENV)?.name === "aetf");
  chk("cron 命中 baseline（主觸發 20:05）", backupPipelineForCron("5 12 * * 2-6", ENV)?.name === "baseline");
  chk("cron 命中 us（dow *，跨日界改由程式守門）", backupPipelineForCron("5 21 * * *", ENV)?.name === "us");
  chk("舊 diag 備援 cron 已除役 → null", backupPipelineForCron("35 14 * * 2-6", ENV) === null);
  chk("舊 mktbal 備援 cron 已除役 → null", backupPipelineForCron("45 14 * * 2-6", ENV) === null);
  chk("既有 frame cron → null（不誤判備援）", backupPipelineForCron("* 1-5 * * 2-6", ENV) === null);
  chk("既有哨兵 cron → null", backupPipelineForCron("*/5 9-14 * * 2-6", ENV) === null);
  chk("既有新聞/晨報 cron → null", backupPipelineForCron("7,47 0-14,22-23 * * *", ENV) === null);
  chk("未知 cron → null", backupPipelineForCron("0 0 * * *", ENV) === null);
}

// ---- bkfiredKey 格式 ----
{
  chk("bkfiredKey 格式", bkfiredKey("2026-07-20", "aetf") === "bkfired:20260720:aetf", bkfiredKey("2026-07-20", "aetf"));
}

// ---- productFresh：新鮮度純函式 ----
{
  const today = "2026-07-20";
  chk("date 欄=今日 → fresh", productFresh({ date: "2026-07-20" }, byName.daysummary, today) === true);
  chk("date 欄=昨日 → 非fresh", productFresh({ date: "2026-07-17" }, byName.daysummary, today) === false);
  chk("run_date 欄=今日 → fresh", productFresh({ run_date: "2026-07-20T20:29:46+08:00" }, byName.aetf, today) === true);
  chk("latest_date 欄=今日 → fresh", productFresh({ latest_date: "2026-07-20" }, byName.mktbal, today) === true);
  chk("obj null → 非fresh", productFresh(null, byName.baseline, today) === false);
  chk("欄位缺 → 非fresh", productFresh({}, byName.baseline, today) === false);
  // genToday（news 等用；us 已於 2026-08-13 改 usDate）：generated_at 帶 +08:00，取台北日比對
  const genPipe = { mode: "genToday", field: "generated_at" };
  chk("genToday generated_at=今日(+08:00) → fresh",
    productFresh({ generated_at: "2026-07-20T05:49:58.483735+08:00", date: "2026-07-17" }, genPipe, today) === true);
  chk("genToday generated_at=昨日 → 非fresh",
    productFresh({ generated_at: "2026-07-19T05:49:58+08:00", date: "2026-07-17" }, genPipe, today) === false);
  chk("genToday 跨日 UTC 正規化（07-19T23:30Z=台北07-20 07:30）→ fresh",
    productFresh({ generated_at: "2026-07-19T23:30:00Z" }, genPipe, today) === true);
  chk("genToday generated_at 缺 → 非fresh", productFresh({ date: "2026-07-20" }, genPipe, today) === false);
  // usDate（2026-08-13）：資料日判準——date ≥ 最近預期美股交易日。generated_at 完全不看
  // （us.yml 每輪重寫它，靠它判會被污染成永遠新鮮）。today=2026-07-20 週一 → 預期=上週五 07-17
  chk("usDate 週一 date=上週五 → fresh（generated_at 舊也無妨）",
    productFresh({ date: "2026-07-17", generated_at: "2026-07-18T05:00:00+08:00" }, byName.us, today) === true);
  chk("usDate 週一 date=上週四 → 非fresh（generated_at 今日也救不了）",
    productFresh({ date: "2026-07-16", generated_at: "2026-07-20T05:49:58+08:00" }, byName.us, today) === false);
  chk("usDate 週二 date=昨日 → fresh",
    productFresh({ date: "2026-07-20" }, byName.us, "2026-07-21") === true);
  chk("usDate 週二 date=上週五 → 非fresh",
    productFresh({ date: "2026-07-17" }, byName.us, "2026-07-21") === false);
  chk("usDate 週六 date=週五 → fresh", productFresh({ date: "2026-07-24" }, byName.us, "2026-07-25") === true);
  chk("usDate 週日 date=週五 → fresh", productFresh({ date: "2026-07-24" }, byName.us, "2026-07-26") === true);
  chk("usDate date 缺 → 非fresh", productFresh({ generated_at: "2026-07-20T05:00:00+08:00" }, byName.us, today) === false);
  // 美國國定假日（設計已知誤差）：假日次晨 date 停在前一交易日 → 誤判 stale（觸發補跑/告警
  // 但拿不到新資料、無害）。例：07-03(五) 美國獨立日補假休市，台北週六 07-04 預期=07-03
  chk("usDate 美國假日次晨 → 誤判非fresh（已知可接受）",
    productFresh({ date: "2026-07-02" }, byName.us, "2026-07-04") === false);
}

// ---- runBackup：整合決策（mock env / mock fetch，不打真實網路）----
function fakeKV(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    _m: m,
    async get(k, type) { const v = m.get(k); if (v === undefined) return null; return type === "json" ? (typeof v === "string" ? JSON.parse(v) : v) : v; },
    async put(k, v) { m.set(k, v); },
  };
}
// mock fetch：/dispatches → status；其餘視為產物 URL → 回 productObj（null 代表 404）
const mkFetch = (productObj, dispatchStatus = 204, spy) => async (u, init) => {
  if (String(u).includes("/dispatches")) { if (spy) spy.push(String(u)); return { status: dispatchStatus }; }
  return { ok: productObj != null, status: productObj ? 200 : 404, json: async () => productObj };
};
const TP = { date: "2026-07-20", dow: 1 };   // 2026-07-20 = 週一（台北 dow 1）
const TRADING_KV = () => fakeKV({ "series:2026-07-20": [{ t: "09:00", amt: 100 }] });
const NOW = Date.UTC(2026, 6, 20, 12, 0, 0);   // 固定時鐘（opts.nowMs 注入），冷卻期判定可重現

// 1) GH_DISPATCH_TOKEN 未設 → 靜默跳過（不打任何網路）
{
  const spy = [];
  const out = await runBackup({ FLOW_KV: TRADING_KV() }, TP, byName.aetf, mkFetch({ run_date: "2026-07-17" }, 204, spy));
  chk("無 token → skipped no-token", out.skipped === "no-token");
  chk("無 token → 不打 dispatch", spy.length === 0);
}
// 2) 非交易日（無當日 series）TW 班 → 不補發
{
  const spy = [];
  const out = await runBackup({ GH_DISPATCH_TOKEN: "T", FLOW_KV: fakeKV() }, TP, byName.baseline, mkFetch({ date: "2026-07-17" }, 204, spy));
  chk("非交易日 → skipped non-trading-day", out.skipped === "non-trading-day");
  chk("非交易日 → 不打 dispatch", spy.length === 0);
}
// 3) 冪等：今日已發過且仍在冷卻期內 → 不再發
{
  const spy = [];
  const kv = fakeKV({ "series:2026-07-20": [{ t: "09:00" }],
    "bkfired:20260720:baseline": bkStateValue("fired", 1, NOW - 5 * 60e3) });
  const out = await runBackup({ GH_DISPATCH_TOKEN: "T", FLOW_KV: kv }, TP, byName.baseline,
    mkFetch({ date: "2026-07-17" }, 204, spy), { nowMs: NOW });
  chk("冷卻期內 → skipped already-fired", out.skipped === "already-fired", JSON.stringify(out));
  chk("冷卻期內 → 不打 dispatch", spy.length === 0);
}
// 4) 產物已今日 → fresh、不補發、KV 不記
{
  const spy = [];
  const kv = TRADING_KV();
  const out = await runBackup({ GH_DISPATCH_TOKEN: "T", FLOW_KV: kv }, TP, byName.baseline, mkFetch({ date: "2026-07-20" }, 204, spy));
  chk("產物今日 → fresh:true", out.fresh === true);
  chk("產物今日 → 不打 dispatch", spy.length === 0);
  chk("產物今日 → KV 不記 bkfired", kv._m.get("bkfired:20260720:baseline") === undefined);
}
// 5) 產物非今日（交易日、未補過）→ 補發 + KV 記
{
  const spy = [];
  const kv = TRADING_KV();
  const out = await runBackup({ GH_DISPATCH_TOKEN: "T", FLOW_KV: kv }, TP, byName.baseline, mkFetch({ date: "2026-07-17" }, 204, spy));
  chk("產物非今日 → fired:true", out.fired === true);
  chk("補發打對 workflow URL", spy.length === 1 && spy[0].includes("/shihpc/taiwan-flow-live-v2/actions/workflows/baseline.yml/dispatches"), spy[0]);
  const st5 = parseBkState(kv._m.get("bkfired:20260720:baseline"));
  chk("補發後 KV 記 fired 狀態＋次數 1＋時戳", st5.s === "fired" && st5.n === 1 && st5.ts > 0, JSON.stringify(st5));
  chk("首發不告警（第 2 次才告警）", out.attempt === 1 && kv._m.get(alertedKey("2026-07-20", "bk-recheck-baseline")) === undefined);
}
// 5b) 跨 repo：diag 產物非今日 → 補發打 postmkt
{
  const spy = [];
  const out = await runBackup({ GH_DISPATCH_TOKEN: "T", FLOW_KV: TRADING_KV() }, TP, byName.diag, mkFetch({ date: "2026-07-17" }, 204, spy));
  chk("diag 跨 repo 補發打 postmkt/diag.yml",
    out.fired === true && spy[0].includes("/shihpc/postmkt/actions/workflows/diag.yml/dispatches"), spy[0]);
}
// 6) us（tw:false）：不看 series；資料日未達預期（週一預期=上週五 07-17、產物停在 07-16）
//    → 補發（即使無 series 也不被守門擋）。generated_at 今日也救不了——usDate 只看資料日
{
  const spy = [];
  const out = await runBackup({ GH_DISPATCH_TOKEN: "T", FLOW_KV: fakeKV() }, TP, byName.us,
    mkFetch({ generated_at: "2026-07-20T05:49:58+08:00", date: "2026-07-16" }, 204, spy));
  chk("us 無 series 仍不被守門擋（tw:false）", out.fired === true);
  chk("us 補發打 us.yml", spy.length === 1 && spy[0].includes("/us.yml/dispatches"), spy[0]);
}
// 6a2) us 週末守門：台北 dow=6（週六晨）→ 不補發（cron dow * 由 runBackup 台北 dow 擋週末）
{
  const spy = [];
  const out = await runBackup({ GH_DISPATCH_TOKEN: "T", FLOW_KV: fakeKV() }, { date: "2026-07-25", dow: 6 }, byName.us,
    mkFetch({ generated_at: "2026-07-24T05:49:58+08:00", date: "2026-07-17" }, 204, spy));
  chk("us 週末（台北 dow6）→ skipped non-trading-day", out.skipped === "non-trading-day");
  chk("us 週末 → 不打 dispatch", spy.length === 0);
}
// 6b) us 資料日已達預期（週一預期=上週五 07-17）→ fresh（即使 generated_at 是舊的）
{
  const spy = [];
  const out = await runBackup({ GH_DISPATCH_TOKEN: "T", FLOW_KV: fakeKV() }, TP, byName.us,
    mkFetch({ generated_at: "2026-07-18T07:49:58+08:00", date: "2026-07-17" }, 204, spy));
  chk("us 資料日達預期 → fresh:true", out.fresh === true && spy.length === 0);
}
// 6c) us recheck 於入庫窗前（05:35）：即使 stale 也靜默延後——FinMind 入庫窗 07:30-08:30，
//     此時補發＋告警必然是噪音，交給 us-catchup／晨間健檢（2026-08-14 降噪修法）
{
  const spy = [];
  const kv = fakeKV({ "bkfired:20260720:us": bkStateValue("fired", 1, NOW - 30 * 60e3) });
  const out = await runBackup({ GH_DISPATCH_TOKEN: "T", FLOW_KV: kv }, { ...TP, hour: 5, minute: 35 }, byName.us,
    mkFetch({ generated_at: "2026-07-20T05:10:00+08:00", date: "2026-07-16" }, 204, spy), { nowMs: NOW });
  chk("us recheck 入庫窗前 → 靜默延後、不 dispatch 不告警",
    out.deferred === "before-us-ingest-window" && spy.length === 0, JSON.stringify(out));
}
// 6c2) us recheck 於入庫窗後（07:05，例如 recheck cron 被 GH 延遲推進窗內）→ 照常補發第 2 次
{
  const spy = [];
  const kv = fakeKV({ "bkfired:20260720:us": bkStateValue("fired", 1, NOW - 30 * 60e3) });
  const out = await runBackup({ GH_DISPATCH_TOKEN: "T", FLOW_KV: kv }, { ...TP, hour: 7, minute: 5 }, byName.us,
    mkFetch({ generated_at: "2026-07-20T05:10:00+08:00", date: "2026-07-16" }, 204, spy), { nowMs: NOW });
  chk("us recheck 入庫窗內 → 補發第 2 次",
    out.fired === true && out.attempt === 2, JSON.stringify(out));
}
// 6c3) us recheck、tp 缺 hour/minute（防呆）→ 保守放行走原路徑
{
  const spy = [];
  const kv = fakeKV({ "bkfired:20260720:us": bkStateValue("fired", 1, NOW - 30 * 60e3) });
  const out = await runBackup({ GH_DISPATCH_TOKEN: "T", FLOW_KV: kv }, TP, byName.us,
    mkFetch({ generated_at: "2026-07-20T05:10:00+08:00", date: "2026-07-16" }, 204, spy), { nowMs: NOW });
  chk("us recheck 缺時間欄位 → 保守放行補發",
    out.fired === true && out.attempt === 2, JSON.stringify(out));
}
// 7) dry 模式：非今日但只回決策、不真的 dispatch、KV 不記
{
  const spy = [];
  const kv = TRADING_KV();
  const out = await runBackup({ GH_DISPATCH_TOKEN: "T", FLOW_KV: kv }, TP, byName.aetf, mkFetch({ run_date: "2026-07-17" }, 204, spy), { dry: true });
  chk("dry → wouldDispatch 不真的發", out.wouldDispatch === true && out.fired === undefined);
  chk("dry → 不打 dispatch", spy.length === 0);
  chk("dry → KV 不記", kv._m.get("bkfired:20260720:aetf") === undefined);
}
// 8) 產物抓取失敗（404）視為非今日 → 補發（漏發時線上根本沒檔的情境）
{
  const spy = [];
  const out = await runBackup({ GH_DISPATCH_TOKEN: "T", FLOW_KV: TRADING_KV() }, TP, byName.aetf, mkFetch(null, 204, spy));
  chk("產物抓不到 → 補發", out.fired === true && spy.length === 1);
}
// 9) dispatch 兩次都失敗 → 回 error、KV 不記（不誤標已補發，保留重試機會）
{
  const spy = [];
  const kv = TRADING_KV();
  const out = await runBackup({ GH_DISPATCH_TOKEN: "T", FLOW_KV: kv }, TP, byName.baseline, mkFetch({ date: "2026-07-17" }, 401, spy), { sleepFn: async () => {} });
  chk("dispatch 失敗 → 回 error", !!out.error);
  chk("dispatch 失敗 → KV 不記 bkfired（保留重試）", kv._m.get("bkfired:20260720:baseline") === undefined);
}

// 10) intraday {date} 佔位：產物 URL 以今日代入；當日檔 404 → 補發
{
  const spy = [], prodUrls = [];
  const f = async (u, init) => {
    if (String(u).includes("/dispatches")) { spy.push(String(u)); return { status: 204 }; }
    prodUrls.push(String(u));
    return { ok: false, status: 404, json: async () => null };
  };
  const out = await runBackup({ GH_DISPATCH_TOKEN: "T", FLOW_KV: TRADING_KV() }, TP, byName.intraday, f);
  chk("intraday URL 代入今日", prodUrls[0]?.includes("/intraday/2026-07-20.json"), prodUrls[0]);
  chk("intraday 當日檔 404 → 補發 intraday.yml", out.fired === true && spy[0].includes("/intraday.yml/dispatches"), spy[0]);
}

// ---- 2026-07-25：冪等狀態升級（dispatch 成功 ≠ job 成功）＋ recheck 補發 ＋ 排程告警 ----
// mock fetch 二代：另收告警 webhook（host hook.test）以驗「失敗有人知道」
const ALERT_URL = "https://hook.test/notify";
const mkFetch2 = (productObj, dispatchStatus, spy, alerts) => async (u, init) => {
  const s = String(u);
  if (s.includes("/dispatches")) { spy.push(s); return { status: dispatchStatus }; }
  if (s.startsWith("https://hook.test/")) { alerts.push(JSON.parse(init.body).content); return { ok: true, status: 200 }; }
  return { ok: productObj != null, status: productObj ? 200 : 404, json: async () => productObj };
};
const ALERT_ENV = (kv) => ({ GH_DISPATCH_TOKEN: "T", FLOW_KV: kv, ALERT_WEBHOOK: ALERT_URL });

// 11) parseBkState：新舊格式相容（部署當日 KV 裡還是舊字串）
{
  chk("parseBkState null → null", parseBkState(null) === null);
  const legacy = parseBkState("fired");
  chk("舊字串 fired → ts=0/n=1（視為冷卻已過，可 recheck）", legacy.s === "fired" && legacy.ts === 0 && legacy.n === 1);
  chk("舊字串 produced → s=produced", parseBkState("produced").s === "produced");
  const j = parseBkState(bkStateValue("fired", 2, 12345));
  chk("新 JSON 格式往返", j.s === "fired" && j.n === 2 && j.ts === 12345);
  chk("壞 JSON → 當舊字串處理不炸", parseBkState("{壞").s === "{壞");
}

// 12) bkGate：閘門純函式
{
  chk("無狀態 → go（第1次）", (() => { const g = bkGate(null, NOW); return g.act === "go" && g.n === 1; })());
  chk("produced → 永遠不再發", bkGate({ s: "produced", ts: NOW, n: 1 }, NOW).why === "already-produced");
  chk("冷卻期內 → already-fired", bkGate({ s: "fired", ts: NOW - 60e3, n: 1 }, NOW).why === "already-fired");
  chk("冷卻期過 → recheck（第2次）", (() => {
    const g = bkGate({ s: "fired", ts: NOW - BK_RECHECK_MS - 1, n: 1 }, NOW);
    return g.act === "recheck" && g.n === 2;
  })());
  chk("已達次數上限 → max-attempts", bkGate({ s: "fired", ts: 0, n: BK_MAX_ATTEMPTS }, NOW).why === "max-attempts");
  chk("舊字串狀態（ts=0）冷卻視為已過 → recheck", bkGate(parseBkState("fired"), NOW).act === "recheck");
}

// 13) recheck 核心情境：首發後產物仍非今日 → 補發第 2 次 ＋ 告警
{
  const spy = [], alerts = [];
  const kv = fakeKV({ "series:2026-07-20": [{ t: "09:00" }],
    "bkfired:20260720:baseline": bkStateValue("fired", 1, NOW - 30 * 60e3) });
  const out = await runBackup(ALERT_ENV(kv), TP, byName.baseline,
    mkFetch2({ date: "2026-07-17" }, 204, spy, alerts), { nowMs: NOW });
  chk("recheck 產物仍舊 → 補發第 2 次", out.fired === true && out.attempt === 2, JSON.stringify(out));
  chk("recheck 補發打對 workflow", spy.length === 1 && spy[0].includes("/baseline.yml/dispatches"));
  chk("recheck KV 記 n=2", parseBkState(kv._m.get("bkfired:20260720:baseline")).n === 2);
  chk("recheck 發出告警", alerts.length === 1 && alerts[0].includes("baseline") && alerts[0].includes("第 2 次"), alerts[0]);
  chk("告警每日每 tag 至多一則（KV 記號）", kv._m.get(alertedKey("2026-07-20", "bk-recheck-baseline")) === "1");
}

// 14) recheck 發現產物已落地 → 標 produced、不重發（首發那輪其實成功了）
{
  const spy = [], alerts = [];
  const kv = fakeKV({ "series:2026-07-20": [{ t: "09:00" }],
    "bkfired:20260720:baseline": bkStateValue("fired", 1, NOW - 30 * 60e3) });
  const out = await runBackup(ALERT_ENV(kv), TP, byName.baseline,
    mkFetch2({ date: "2026-07-20" }, 204, spy, alerts), { nowMs: NOW });
  chk("recheck 產物今日 → fresh、不重發", out.fresh === true && spy.length === 0);
  chk("recheck 落地 → KV 改標 produced", parseBkState(kv._m.get("bkfired:20260720:baseline")).s === "produced");
  chk("recheck 落地 → 不告警", alerts.length === 0);
}

// 15) 已補發到上限 → 不再發（留給 GH 兜底 cron，不無限重試）
{
  const spy = [], alerts = [];
  const kv = fakeKV({ "series:2026-07-20": [{ t: "09:00" }],
    "bkfired:20260720:baseline": bkStateValue("fired", BK_MAX_ATTEMPTS, NOW - 60 * 60e3) });
  const out = await runBackup(ALERT_ENV(kv), TP, byName.baseline,
    mkFetch2({ date: "2026-07-17" }, 204, spy, alerts), { nowMs: NOW });
  chk("達上限 → skipped max-attempts", out.skipped === "max-attempts", JSON.stringify(out));
  chk("達上限 → 不打 dispatch", spy.length === 0);
}

// 16) produced → 當日短路（連產物都不抓）
{
  const spy = [], prod = [];
  const kv = fakeKV({ "series:2026-07-20": [{ t: "09:00" }],
    "bkfired:20260720:baseline": bkStateValue("produced", 1, NOW - 60e3) });
  const f = async (u, init) => {
    if (String(u).includes("/dispatches")) { spy.push(String(u)); return { status: 204 }; }
    prod.push(String(u)); return { ok: true, status: 200, json: async () => ({ date: "2026-07-17" }) };
  };
  const out = await runBackup(ALERT_ENV(kv), TP, byName.baseline, f, { nowMs: NOW });
  chk("produced → skipped already-produced", out.skipped === "already-produced");
  chk("produced → 不抓產物也不 dispatch", prod.length === 0 && spy.length === 0);
}

// 17) dispatch 兩次都失敗 → 告警；同日再撞同一故障不重複轟炸
{
  const spy = [], alerts = [];
  const kv = TRADING_KV();
  const env2 = ALERT_ENV(kv);
  const opts = { nowMs: NOW, sleepFn: async () => {} };
  const out = await runBackup(env2, TP, byName.baseline, mkFetch2({ date: "2026-07-17" }, 401, spy, alerts), opts);
  chk("dispatch 失敗 → 回 error", !!out.error);
  chk("dispatch 失敗 → 發告警", alerts.length === 1 && alerts[0].includes("dispatch 失敗"), alerts[0]);
  chk("dispatch 失敗 → KV 不記 bkfired（保留重試）", kv._m.get("bkfired:20260720:baseline") === undefined);
  // 第二輪同故障（recheck cron 或下一次喚醒）：仍重試 dispatch，但告警不再重發
  await runBackup(env2, TP, byName.baseline, mkFetch2({ date: "2026-07-17" }, 401, spy, alerts), opts);
  chk("同日同 tag 告警去重", alerts.length === 1, `alerts=${alerts.length}`);
}

// 18) 通道未設 → 告警靜默（不打任何外部請求），排程主體照常
{
  const spy = [], alerts = [];
  const kv = TRADING_KV();
  const out = await runBackup({ GH_DISPATCH_TOKEN: "T", FLOW_KV: kv }, TP, byName.baseline,
    mkFetch2({ date: "2026-07-17" }, 401, spy, alerts), { nowMs: NOW, sleepFn: async () => {} });
  chk("無告警通道 → 不打 webhook", alerts.length === 0);
  chk("無告警通道 → 排程決策照常回 error", !!out.error);
}

// 19) jobstat：只記狀態轉換（fired/landed/fresh/error），不記輪詢 skip 噪音
{
  const spy = [], alerts = [], kv = TRADING_KV();
  const f = (prod) => mkFetch2(prod, 204, spy, alerts);
  await runBackup(ALERT_ENV(kv), TP, byName.baseline, f({ date: "2026-07-17" }), { nowMs: NOW });
  let ev = JSON.parse(kv._m.get(jobstatKey("2026-07-20")));
  chk("fired 記一筆 fired#1", ev.length === 1 && ev[0].n === "baseline" && ev[0].r === "fired#1", JSON.stringify(ev));
  await runBackup(ALERT_ENV(kv), TP, byName.baseline, f({ date: "2026-07-17" }), { nowMs: NOW + 60e3 });
  ev = JSON.parse(kv._m.get(jobstatKey("2026-07-20")));
  chk("冷卻期 skip → 不寫 jobstat", ev.length === 1, JSON.stringify(ev));
  await runBackup(ALERT_ENV(kv), TP, byName.baseline, f({ date: "2026-07-20" }), { nowMs: NOW + 40 * 60e3 });
  ev = JSON.parse(kv._m.get(jobstatKey("2026-07-20")));
  chk("recheck 確認落地 → 記 landed", ev.length === 2 && ev[1].r === "landed", JSON.stringify(ev));
}

// ==== 2026-11-13：月營收 revenue（規格 docs/revenue-trigger.md §2、§4.1）====
const REV = byName.revenue;
const REV_URL = "https://raw.githubusercontent.com/shihpc/postmkt/main/data/revenue/index.json";
// 20) 設定與 cron 路由
{
  chk("revenue 設定：postmkt/revenue.yml＋index.json latest＋revMonth＋tw:false＋anyDay＋窗 11–16",
    REV.repo === "postmkt" && REV.wf === "revenue.yml" && REV.url === REV_URL && REV.field === "latest" &&
    REV.mode === "revMonth" && REV.tw === false && REV.anyDay === true &&
    REV.dayWindow === REV_DAY_WINDOW && REV_DAY_WINDOW.from === 11 && REV_DAY_WINDOW.to === 16, JSON.stringify(REV));
  chk("anyDay 只有 revenue 帶（us 等既有班未帶）", pipes.filter((p) => p.anyDay).map((p) => p.name).join() === "revenue");
  chk("dayWindow 只有 revenue 帶", pipes.filter((p) => p.dayWindow).map((p) => p.name).join() === "revenue");
  const crons = Object.entries(BACKUP_CRONS).filter(([, v]) => v === "revenue").map(([k]) => k);
  chk("revenue 恰一條 cron（無 recheck）", crons.length === 1 && crons[0] === "13 23 10-15 * *", crons.join(" | "));
  const r = dispatchRoleForCron("13 23 10-15 * *");
  chk("dispatchRoleForCron(13 23 10-15 * *) → {kind:backup, name:revenue}",
    r && r.kind === "backup" && r.name === "revenue" && Object.keys(r).length === 2, JSON.stringify(r));
  chk("backupPipelineForCron 命中 revenue", backupPipelineForCron("13 23 10-15 * *", ENV)?.name === "revenue");
}
// 21) 純函式：prevMonthOf／inDayWindow
{
  chk("prevMonthOf 11 月 → 10 月", prevMonthOf("2026-11-13") === "2026-10");
  chk("prevMonthOf 1 月跨年 → 前一年 12 月", prevMonthOf("2027-01-11") === "2026-12", prevMonthOf("2027-01-11"));
  chk("prevMonthOf 12 月 → 11 月", prevMonthOf("2026-12-16") === "2026-11");
  chk("prevMonthOf 10 月 → 09 月（補零）", prevMonthOf("2026-10-11") === "2026-09");
  chk("prevMonthOf 格式不合 → null", prevMonthOf("2026-11") === null && prevMonthOf("") === null &&
    prevMonthOf(null) === null && prevMonthOf("2026-13-01") === null && prevMonthOf("2026-00-01") === null);
  const W = REV_DAY_WINDOW;
  chk("窗：10 日外、11 日內、16 日內、17 日外",
    !inDayWindow("2026-11-10", W) && inDayWindow("2026-11-11", W) && inDayWindow("2026-11-16", W) && !inDayWindow("2026-11-17", W));
  chk("窗：1 日／31 日外", !inDayWindow("2026-12-01", W) && !inDayWindow("2026-12-31", W));
  chk("窗：格式不合 → false", !inDayWindow("2026-11", W) && !inDayWindow(null, W) && !inDayWindow("2026-11-13", null));
}
// 22) productFresh revMonth
{
  chk("revMonth 上一月 → fresh", productFresh({ latest: "2026-10" }, REV, "2026-11-13") === true);
  chk("revMonth 當月（理論上不會有，但 ≥ 上一月）→ fresh", productFresh({ latest: "2026-11" }, REV, "2026-11-13") === true);
  chk("revMonth 更早（前兩月）→ 非fresh", productFresh({ latest: "2026-09" }, REV, "2026-11-13") === false);
  chk("revMonth 1 月：前一年 12 月 → fresh", productFresh({ latest: "2026-12" }, REV, "2027-01-12") === true);
  chk("revMonth 1 月：前一年 11 月 → 非fresh", productFresh({ latest: "2026-11" }, REV, "2027-01-12") === false);
  chk("revMonth latest 缺 → 非fresh", productFresh({ months: ["2026-10"] }, REV, "2026-11-13") === false);
  chk("revMonth latest 非字串 → 非fresh", productFresh({ latest: 202610 }, REV, "2026-11-13") === false &&
    productFresh({ latest: ["2026-10"] }, REV, "2026-11-13") === false && productFresh({ latest: null }, REV, "2026-11-13") === false);
  chk("revMonth 格式不合 → 非fresh", productFresh({ latest: "2026-10-31" }, REV, "2026-11-13") === false &&
    productFresh({ latest: "2026/10" }, REV, "2026-11-13") === false && productFresh({ latest: "2026-1" }, REV, "2026-11-13") === false &&
    productFresh({ latest: " 2026-10" }, REV, "2026-11-13") === false);
  chk("revMonth obj null → 非fresh", productFresh(null, REV, "2026-11-13") === false);
}
// 23) runBackup(revenue)
// KV spy：記錄每次 get/put
function spyKV(init = {}) {
  const kv = fakeKV(init); const ops = [];
  return { ops, _m: kv._m,
    async get(k, t) { ops.push(`get ${k}`); return kv.get(k, t); },
    async put(k, v, o) { ops.push(`put ${k}`); return kv.put(k, v, o); } };
}
const revFetch = (prod, spy, prodCalls) => async (u, init) => {
  const s = String(u);
  if (s.includes("/dispatches")) { spy.push(s); return { status: 204 }; }
  prodCalls.push(s);
  return { ok: prod != null, status: prod ? 200 : 404, json: async () => prod };
};
const dowOf = (d) => new Date(d + "T00:00:00Z").getUTCDay();
const TPr = (date, hour = 7, minute = 13) => ({ date, dow: dowOf(date), hour, minute });
const REV_ENV = (kv) => ({ GH_DISPATCH_TOKEN: "T", FLOW_KV: kv });
{
  // 窗外：10 日、17 日 → out-of-window、零 fetch、零 KV、零 dispatch
  for (const d of ["2026-11-10", "2026-11-17"]) {
    const spy = [], prod = [], kv = spyKV();
    const out = await runBackup(REV_ENV(kv), TPr(d), REV, revFetch({ latest: "2026-09" }, spy, prod), { nowMs: NOW });
    chk(`revenue ${d} → out-of-window`, out.skipped === "out-of-window" && out.name === "revenue", JSON.stringify(out));
    chk(`revenue ${d} → 零 fetch／零 KV／零 dispatch`, prod.length === 0 && spy.length === 0 && kv.ops.length === 0,
      `${prod} | ${kv.ops} | ${spy}`);
  }
  // dry 窗外也一樣（/backup?name=revenue 在窗外回 out-of-window）
  {
    const spy = [], prod = [], kv = spyKV();
    const out = await runBackup(REV_ENV(kv), TPr("2026-11-20"), REV, revFetch({ latest: "2026-09" }, spy, prod), { dry: true });
    chk("revenue dry 窗外 → out-of-window、零副作用", out.skipped === "out-of-window" && prod.length + spy.length + kv.ops.length === 0);
  }
  // 窗內 11 日、16 日 → 進入判定（產物過期 → dispatch）
  for (const d of ["2026-11-11", "2026-11-16"]) {
    const spy = [], prod = [], kv = spyKV();
    const out = await runBackup(REV_ENV(kv), TPr(d), REV, revFetch({ latest: "2026-09" }, spy, prod), { nowMs: NOW });
    chk(`revenue ${d}（窗內）產物過期 → 恰 dispatch 一次 postmkt/revenue.yml`,
      out.fired === true && out.attempt === 1 && spy.length === 1 &&
      spy[0] === "https://api.github.com/repos/shihpc/postmkt/actions/workflows/revenue.yml/dispatches", `${JSON.stringify(out)} ${spy}`);
    chk(`revenue ${d} 產物 URL＝postmkt data/revenue/index.json（帶破快取）`, prod.length === 1 && prod[0].startsWith(REV_URL + "?_="), prod[0]);
    const st = parseBkState(kv._m.get(bkfiredKey(d, "revenue")));
    chk(`revenue ${d} 寫 bkfired:${d.replaceAll("-", "")}:revenue（fired, n=1）`, st && st.s === "fired" && st.n === 1, JSON.stringify(st));
    chk(`revenue ${d} 不讀 series（不看交易日）`, !kv.ops.some((o) => o.includes("series:")), kv.ops.join(","));
  }
  // 週六（11-14）、週日（11-15）照樣進入判定（產物過期 → dispatch）——us 的週末守門不套用
  for (const d of ["2026-11-14", "2026-11-15"]) {
    const spy = [], prod = [], kv = spyKV();
    const tp = TPr(d);
    const out = await runBackup(REV_ENV(kv), tp, REV, revFetch({ latest: "2026-09" }, spy, prod), { nowMs: NOW });
    chk(`revenue ${d}（dow ${tp.dow}）週末照樣判定 → dispatch`, (tp.dow === 6 || tp.dow === 0) && out.fired === true && spy.length === 1,
      JSON.stringify(out));
  }
  // 產物新鮮（latest＝上個月）→ 不 dispatch；週末亦同
  for (const d of ["2026-11-13", "2026-11-14"]) {
    const spy = [], prod = [], kv = spyKV();
    const out = await runBackup(REV_ENV(kv), TPr(d), REV, revFetch({ latest: "2026-10" }, spy, prod), { nowMs: NOW });
    chk(`revenue ${d} 產物新鮮 → fresh、不 dispatch、不寫 bkfired`,
      out.fresh === true && out.productDate === "2026-10" && spy.length === 0 && kv._m.get(bkfiredKey(d, "revenue")) === undefined,
      JSON.stringify(out));
  }
  // 1 月跨年：2027-01-12 產物 2026-12 → fresh；2026-11 → dispatch
  {
    const spy = [], prod = [];
    const a = await runBackup(REV_ENV(spyKV()), TPr("2027-01-12"), REV, revFetch({ latest: "2026-12" }, spy, prod), { nowMs: NOW });
    const b = await runBackup(REV_ENV(spyKV()), TPr("2027-01-12"), REV, revFetch({ latest: "2026-11" }, spy, prod), { nowMs: NOW });
    chk("revenue 1 月跨年：上年 12 月 fresh、上年 11 月 dispatch", a.fresh === true && b.fired === true && spy.length === 1,
      `${JSON.stringify(a)} ${JSON.stringify(b)}`);
  }
  // 產物 404 → 不新鮮 → dispatch
  {
    const spy = [], prod = [];
    const out = await runBackup(REV_ENV(spyKV()), TPr("2026-11-12"), REV, revFetch(null, spy, prod), { nowMs: NOW });
    chk("revenue 產物 404 → dispatch", out.fired === true && spy.length === 1, JSON.stringify(out));
  }
  // 同日第二次呼叫 → already-fired 短路（不抓產物、不 dispatch）
  {
    const spy = [], prod = [], kv = spyKV();
    const f = revFetch({ latest: "2026-09" }, spy, prod);
    await runBackup(REV_ENV(kv), TPr("2026-11-13"), REV, f, { nowMs: NOW });
    const n0 = prod.length;
    const out2 = await runBackup(REV_ENV(kv), TPr("2026-11-13"), REV, f, { nowMs: NOW + 60e3 });
    chk("revenue 同日第二次 → already-fired、不抓產物、不再 dispatch",
      out2.skipped === "already-fired" && spy.length === 1 && prod.length === n0, `${JSON.stringify(out2)} spy=${spy.length}`);
  }
  // dry：只回決策，不 dispatch、不寫 bkfired
  {
    const spy = [], prod = [], kv = spyKV();
    const out = await runBackup(REV_ENV(kv), TPr("2026-11-13"), REV, revFetch({ latest: "2026-09" }, spy, prod), { dry: true });
    chk("revenue dry 過期 → wouldDispatch、零 dispatch、零 KV 寫入",
      out.wouldDispatch === true && out.fired === undefined && out.productDate === "2026-09" && spy.length === 0 &&
      !kv.ops.some((o) => o.startsWith("put ")), `${JSON.stringify(out)} ${kv.ops}`);
    const spy2 = [], kv2 = spyKV();
    const out2 = await runBackup(REV_ENV(kv2), TPr("2026-11-13"), REV, revFetch({ latest: "2026-10" }, spy2, []), { dry: true });
    chk("revenue dry 新鮮 → fresh:true、productDate 2026-10、零寫入",
      out2.fresh === true && out2.productDate === "2026-10" && spy2.length === 0 && !kv2.ops.some((o) => o.startsWith("put ")),
      `${JSON.stringify(out2)} ${kv2.ops}`);
  }
  // 無 token → no-token（沿用既有守門）
  {
    const spy = [], prod = [];
    const out = await runBackup({ FLOW_KV: spyKV() }, TPr("2026-11-13"), REV, revFetch({ latest: "2026-09" }, spy, prod));
    chk("revenue 無 token → no-token、零 fetch", out.skipped === "no-token" && spy.length + prod.length === 0);
  }
}
// 24) us 週末守門不變（anyDay 未帶）：週日（dow 0）同樣 skipped
{
  const spy = [];
  const out = await runBackup({ GH_DISPATCH_TOKEN: "T", FLOW_KV: fakeKV() }, { date: "2026-07-26", dow: 0 }, byName.us,
    mkFetch({ date: "2026-07-17" }, 204, spy));
  chk("us 週日（台北 dow0）→ skipped non-trading-day（未受 anyDay 影響）", out.skipped === "non-trading-day" && spy.length === 0);
}
// 25) scheduled handler：revenue cron 在國定假日照樣呼叫 runBackup（不讀行事曆、照 dispatch）
//     2026-02-16（週一）為 data/twse_holidays.json 所列休市日（農曆春節），且在 11–16 日窗內。
//     對照組：同日 daysummary（tw:true）主觸發被休市守門擋下——證明該日確實被判為國定假日。
{
  const REAL_CAL = await readFile(new URL("../../data/twse_holidays.json", import.meta.url), "utf8");
  const origFetch = globalThis.fetch, origLog = console.log;
  const runSched = async (cron, atTpe, prodObj) => {
    resetHolidayMemo();
    const calls = [], kv = spyKV(), waits = [];
    globalThis.fetch = async (input) => {
      const u = typeof input === "string" ? input : input.url;
      calls.push(u);
      if (u.startsWith(HOLIDAYS_URL)) return new Response(REAL_CAL, { status: 200 });
      if (u.includes("/dispatches")) return new Response(null, { status: 204 });
      if (u.startsWith(REV_URL)) return Response.json(prodObj);
      return new Response("nf", { status: 404 });
    };
    console.log = () => {};
    try {
      await worker.scheduled({ cron, scheduledTime: Date.parse(`${atTpe}:00+08:00`) },
        { FLOW_KV: kv, GH_DISPATCH_TOKEN: "gh-test", DATA_BASE: ENV.DATA_BASE }, { waitUntil: (p) => waits.push(p) });
      await Promise.allSettled(waits);
    } finally { globalThis.fetch = origFetch; console.log = origLog; }
    return { calls, kv };
  };
  const r = await runSched("13 23 10-15 * *", "2026-02-16T07:13", { latest: "2025-12" });
  chk("scheduled revenue 國定假日（02-16）→ 照 dispatch postmkt/revenue.yml",
    r.calls.filter((u) => u.includes("/dispatches")).length === 1 &&
    r.calls.some((u) => u === "https://api.github.com/repos/shihpc/postmkt/actions/workflows/revenue.yml/dispatches"), r.calls.join(","));
  chk("scheduled revenue 國定假日 → 不讀行事曆（tw:false 不問休市）", !r.calls.some((u) => u.startsWith(HOLIDAYS_URL)), r.calls.join(","));
  chk("scheduled revenue → 寫 bkfired:20260216:revenue", r.kv.ops.includes("put bkfired:20260216:revenue"), r.kv.ops.join(","));
  const f = await runSched("13 23 10-15 * *", "2026-02-16T07:13", { latest: "2026-01" });
  chk("scheduled revenue 國定假日、產物新鮮 → 不 dispatch", !f.calls.some((u) => u.includes("/dispatches")) &&
    f.calls.some((u) => u.startsWith(REV_URL)), f.calls.join(","));
  const w = await runSched("13 23 10-15 * *", "2026-02-10T07:13", { latest: "2025-12" });
  chk("scheduled revenue 窗外（02-10）→ 零 fetch、零 KV", w.calls.length === 0 && w.kv.ops.length === 0, `${w.calls} ${w.kv.ops}`);
  const c = await runSched("35 5 * * 2-6", "2026-02-16T13:35", null);
  chk("對照：同日 daysummary（tw:true）被休市守門擋（讀了行事曆、零 dispatch、零 KV）",
    c.calls.some((u) => u.startsWith(HOLIDAYS_URL)) && !c.calls.some((u) => u.includes("/dispatches")) && c.kv.ops.length === 0,
    `${c.calls} ${c.kv.ops}`);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} 通過 / ${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
