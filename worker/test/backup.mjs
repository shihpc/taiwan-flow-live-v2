// 排程備援離線單元測試（無需 token、不打真實網路——fetch 全用 mock）
// 執行：cd worker && node test/backup.mjs
import { backupPipelines, backupPipelineForCron, BACKUP_CRONS, bkfiredKey,
  productFresh, runBackup } from "../src/index.js";

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; } else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}

const ENV = { DATA_BASE: "https://raw.githubusercontent.com/shihpc/taiwan-flow-live-v2/main/data" };
const pipes = backupPipelines(ENV);
const byName = Object.fromEntries(pipes.map((p) => [p.name, p]));

// ---- 設定表：七條班、repo、workflow 檔、產物 URL、日期欄、模式、交易日守門 ----
{
  chk("七條班齊全", pipes.length === 7 && ["daysummary","aetf","baseline","us","intraday","diag","mktbal"].every((n) => byName[n]));
  chk("daysummary 設定", byName.daysummary.wf === "daysummary.yml" && byName.daysummary.field === "date" &&
    byName.daysummary.url.endsWith("/daysummary/latest.json") && byName.daysummary.repo === "taiwan-flow-live-v2");
  chk("aetf 用 run_date 欄", byName.aetf.field === "run_date" && byName.aetf.wf === "aetf.yml");
  chk("baseline 用 date 欄", byName.baseline.field === "date" && byName.baseline.url.endsWith("/baseline.json"));
  chk("us genToday＋非TW守門", byName.us.mode === "genToday" && byName.us.field === "generated_at" && byName.us.tw === false);
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

// ---- event.cron → pipeline 對應（2026-07-22 主排程化：單體班五條；diag/mktbal 併入晚場協調班無專屬 cron）----
{
  chk("BACKUP_CRONS 五條", Object.keys(BACKUP_CRONS).length === 5);
  chk("cron 命中 daysummary（主觸發 13:35）", backupPipelineForCron("35 5 * * 1-5", ENV)?.name === "daysummary");
  chk("cron 命中 intraday（備援 14:40）", backupPipelineForCron("40 6 * * 1-5", ENV)?.name === "intraday");
  chk("cron 命中 aetf（主觸發 18:35）", backupPipelineForCron("35 10 * * 1-5", ENV)?.name === "aetf");
  chk("cron 命中 baseline（主觸發 20:05）", backupPipelineForCron("5 12 * * 1-5", ENV)?.name === "baseline");
  chk("cron 命中 us（dow *，CF 拒收 0-4）", backupPipelineForCron("5 21 * * *", ENV)?.name === "us");
  chk("舊 diag 備援 cron 已除役 → null", backupPipelineForCron("35 14 * * 1-5", ENV) === null);
  chk("舊 mktbal 備援 cron 已除役 → null", backupPipelineForCron("45 14 * * 1-5", ENV) === null);
  chk("既有 frame cron → null（不誤判備援）", backupPipelineForCron("* 1-5 * * 1-5", ENV) === null);
  chk("既有哨兵 cron → null", backupPipelineForCron("*/5 9-14 * * 1-5", ENV) === null);
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
  // genToday：us generated_at 帶 +08:00，取台北日比對
  chk("genToday generated_at=今日(+08:00) → fresh",
    productFresh({ generated_at: "2026-07-20T05:49:58.483735+08:00", date: "2026-07-17" }, byName.us, today) === true);
  chk("genToday generated_at=昨日 → 非fresh",
    productFresh({ generated_at: "2026-07-19T05:49:58+08:00", date: "2026-07-17" }, byName.us, today) === false);
  chk("genToday 跨日 UTC 正規化（07-19T23:30Z=台北07-20 07:30）→ fresh",
    productFresh({ generated_at: "2026-07-19T23:30:00Z" }, byName.us, today) === true);
  chk("genToday generated_at 缺 → 非fresh", productFresh({ date: "2026-07-20" }, byName.us, today) === false);
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
// 3) 冪等：今日已補發過 → 不再發
{
  const spy = [];
  const kv = fakeKV({ "series:2026-07-20": [{ t: "09:00" }], "bkfired:20260720:baseline": "fired" });
  const out = await runBackup({ GH_DISPATCH_TOKEN: "T", FLOW_KV: kv }, TP, byName.baseline, mkFetch({ date: "2026-07-17" }, 204, spy));
  chk("已補發 → skipped already-fired", out.skipped === "already-fired");
  chk("已補發 → 不打 dispatch", spy.length === 0);
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
  chk("補發後 KV 記 bkfired", kv._m.get("bkfired:20260720:baseline") === "fired");
}
// 5b) 跨 repo：diag 產物非今日 → 補發打 postmkt
{
  const spy = [];
  const out = await runBackup({ GH_DISPATCH_TOKEN: "T", FLOW_KV: TRADING_KV() }, TP, byName.diag, mkFetch({ date: "2026-07-17" }, 204, spy));
  chk("diag 跨 repo 補發打 postmkt/diag.yml",
    out.fired === true && spy[0].includes("/shihpc/postmkt/actions/workflows/diag.yml/dispatches"), spy[0]);
}
// 6) us（tw:false）：不看 series；generated_at 昨日 → 補發（即使無 series 也不被守門擋）
{
  const spy = [];
  const out = await runBackup({ GH_DISPATCH_TOKEN: "T", FLOW_KV: fakeKV() }, TP, byName.us,
    mkFetch({ generated_at: "2026-07-19T05:49:58+08:00", date: "2026-07-17" }, 204, spy));
  chk("us 無 series 仍不被守門擋（tw:false）", out.fired === true);
  chk("us 補發打 us.yml", spy[0].includes("/us.yml/dispatches"), spy[0]);
}
// 6a2) us 週末守門：台北 dow=6（週六晨）→ 不補發（cron dow * 由 runBackup 台北 dow 擋週末）
{
  const spy = [];
  const out = await runBackup({ GH_DISPATCH_TOKEN: "T", FLOW_KV: fakeKV() }, { date: "2026-07-25", dow: 6 }, byName.us,
    mkFetch({ generated_at: "2026-07-24T05:49:58+08:00", date: "2026-07-17" }, 204, spy));
  chk("us 週末（台北 dow6）→ skipped non-trading-day", out.skipped === "non-trading-day");
  chk("us 週末 → 不打 dispatch", spy.length === 0);
}
// 6b) us generated_at 今日 → fresh
{
  const spy = [];
  const out = await runBackup({ GH_DISPATCH_TOKEN: "T", FLOW_KV: fakeKV() }, TP, byName.us,
    mkFetch({ generated_at: "2026-07-20T05:49:58+08:00", date: "2026-07-17" }, 204, spy));
  chk("us 今天已跑 → fresh:true", out.fresh === true && spy.length === 0);
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

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} 通過 / ${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
