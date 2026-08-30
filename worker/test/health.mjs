// 日終/晨間健檢＋排程狀態軌跡 jobstat 離線單元測試（2026-07-25 P1）
// 無需 token、不打真實網路——fetch 全用 mock。執行：cd worker && node test/health.mjs
import { healthTargets, healthVerdict, healthUrl, runHealthCheck, HEALTH_CRONS,
  dispatchRoleForCron, recordJob, jobstatKey, hhmm, JOBSTAT_MAX, alertedKey,
  firstSaturdayISO, lowFreqDue } from "../src/index.js";

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; } else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}

const ENV_BASE = { DATA_BASE: "https://raw.githubusercontent.com/shihpc/taiwan-flow-live-v2/main/data" };
const TP = { date: "2026-07-20", dow: 1, hour: 23, minute: 50 };   // 台北週一 23:50（日終健檢時點）
const T = healthTargets(ENV_BASE);
const ALL = [...T.eve, ...T.morn];

function fakeKV(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    _m: m, _puts: [],
    async get(k, type) { const v = m.get(k); if (v === undefined) return null; return type === "json" ? (typeof v === "string" ? JSON.parse(v) : v) : v; },
    async put(k, v, o) { m.set(k, v); this._puts.push({ k, o }); },
  };
}
const TRADING_KV = () => fakeKV({ "series:2026-07-20": [{ t: "09:00", amt: 100 }] });
const ALERT_URL = "https://hook.test/notify";
const ALERT_ENV = (kv) => ({ ...ENV_BASE, FLOW_KV: kv, ALERT_WEBHOOK: ALERT_URL });
// mock fetch：freshNames 內的項目回「今日」，其餘回昨日（exists 模式回 404＝無檔）
// day＝這輪健檢的台北日（預設 TP.date；低頻班案例會傳非週一的日子）
const mkFetch = (freshNames, alerts = [], day = TP.date) => async (u, init) => {
  const s = String(u);
  if (s.startsWith("https://hook.test/")) { alerts.push(JSON.parse(init.body).content); return { ok: true, status: 200 }; }
  const t = ALL.find((x) => s.startsWith(healthUrl(x, day)));
  if (!t) return { ok: false, status: 404, json: async () => null };
  const fresh = freshNames.includes(t.name);
  if (t.mode === "exists")
    return fresh ? { ok: true, status: 200, json: async () => ({ ok: 1 }) } : { ok: false, status: 404, json: async () => null };
  // lowfreq（2026-08-30 C5）：lastweek 當日產出；meta 取本月第一個週六（TP 週一 07-20 → 07-04）
  if (t.mode === "lowfreq") {
    const v = t.name === "meta"
      ? (fresh ? `${firstSaturdayISO(day)}T08:10:00+08:00` : "2026-06-06T08:10:00+08:00")
      : (fresh ? `${day}T09:05:00+08:00` : "2026-07-13T09:05:00+08:00");
    return { ok: true, status: 200, json: async () => ({ [t.field]: v }) };
  }
  // usDate（us 專用，2026-08-13）：TP=週一 → 預期美股交易日=上週五 07-17；stale 給 07-16
  const val = t.mode === "usDate" ? (fresh ? "2026-07-17" : "2026-07-16")
    : fresh
      ? (t.mode === "genToday" ? "2026-07-20T21:00:00+08:00" : "2026-07-20")
      : (t.mode === "genToday" ? "2026-07-17T21:00:00+08:00" : "2026-07-17");
  return { ok: true, status: 200, json: async () => ({ [t.field]: val }) };
};

// ---- 檢查表 ----
{
  chk("eve 十二項（十日常＋lastweek/meta 兩低頻）", T.eve.length === 12, String(T.eve.length));
  chk("兩低頻班掛 eve（非 morn）且 mode=lowfreq",
    ["lastweek", "meta"].every((n) => T.eve.find((t) => t.name === n)?.mode === "lowfreq") &&
    !T.morn.some((t) => t.mode === "lowfreq"));
  chk("morn 三項（morning/us/summary-am）", T.morn.length === 3 && T.morn.map((t) => t.name).join(",") === "morning,us,summary-am");
  chk("eve 涵蓋哨兵事件驅動類（recheck 管不到的）",
    ["flows", "postmkt", "news"].every((n) => T.eve.some((t) => t.name === n)));
  chk("summary 兩場用 exists 模式（當日檔存在即可）",
    T.eve.find((t) => t.name === "summary-pm").mode === "exists" && T.morn.find((t) => t.name === "summary-am").mode === "exists");
  chk("跨 repo URL 正確（flows/postmkt/news 各自 raw）",
    T.eve.find((t) => t.name === "flows").url.includes("/shihpc/taiwan-flows/") &&
    T.eve.find((t) => t.name === "postmkt").url.includes("/shihpc/postmkt/") &&
    T.eve.find((t) => t.name === "news").url.includes("/shihpc/taiwan-stock-news/"));
}

// ---- URL 佔位代入 ----
{
  const intra = T.eve.find((t) => t.name === "intraday");
  const sumpm = T.eve.find((t) => t.name === "summary-pm");
  chk("{date} 代入 YYYY-MM-DD", healthUrl(intra, "2026-07-20").endsWith("/intraday/2026-07-20.json"), healthUrl(intra, "2026-07-20"));
  chk("{ymd} 代入 YYYYMMDD", healthUrl(sumpm, "2026-07-20").endsWith("/summary/20260720-pm.json"), healthUrl(sumpm, "2026-07-20"));
}

// ---- healthVerdict 三模式 ----
{
  const today = "2026-07-20";
  const byName = Object.fromEntries(ALL.map((t) => [t.name, t]));
  chk("date 今日 → ok", healthVerdict(byName.baseline, { date: today }, today).ok === true);
  chk("date 昨日 → 不 ok 且帶產物日期", (() => {
    const v = healthVerdict(byName.baseline, { date: "2026-07-17" }, today);
    return v.ok === false && v.at === "2026-07-17";
  })());
  chk("mktbal 用 latest_date 欄", healthVerdict(byName.mktbal, { latest_date: today }, today).ok === true);
  chk("genToday 台北日今日 → ok", healthVerdict(byName.news, { generated_at: "2026-07-20T21:07:00+08:00" }, today).ok === true);
  chk("genToday 跨日 UTC 正規化", healthVerdict(byName.news, { generated_at: "2026-07-19T23:30:00Z" }, today).ok === true);
  // us（2026-08-13 改 usDate）：週一預期=上週五 07-17，看資料日不看 generated_at
  chk("usDate 資料日=預期（週一→上週五）→ ok",
    healthVerdict(byName.us, { date: "2026-07-17", generated_at: "2026-07-18T07:00:00+08:00" }, today).ok === true);
  chk("usDate 資料日落後（generated_at 今日也不算）→ 不 ok", (() => {
    const v = healthVerdict(byName.us, { date: "2026-07-16", generated_at: "2026-07-20T05:10:00+08:00" }, today);
    return v.ok === false && v.at === "2026-07-16";
  })());
  chk("exists 有檔 → ok", healthVerdict(byName["summary-pm"], { any: 1 }, today).ok === true);
  chk("exists 無檔 → 不 ok、at=null", (() => {
    const v = healthVerdict(byName["summary-pm"], null, today);
    return v.ok === false && v.at === null;
  })());
  chk("抓不到檔 → 不 ok、at=null", healthVerdict(byName.baseline, null, today).at === null);
}

// ---- 低頻班：firstSaturdayISO / lowFreqDue（2026-08-30 C5）----
{
  chk("firstSaturdayISO：1 號即週六（2026-08）", firstSaturdayISO("2026-08-15") === "2026-08-01", firstSaturdayISO("2026-08-15"));
  chk("firstSaturdayISO：月中查同月（2026-09）", firstSaturdayISO("2026-09-10") === "2026-09-05", firstSaturdayISO("2026-09-10"));
  chk("firstSaturdayISO：1 號為週日 → 第 7 天（2026-11）", firstSaturdayISO("2026-11-03") === "2026-11-07", firstSaturdayISO("2026-11-03"));

  chk("lastweek：台北週一 → 到期、基準日＝當日", lowFreqDue("lastweek", "2026-07-20") === "2026-07-20");
  chk("lastweek：週二 → 不檢查（不會天天告警）", lowFreqDue("lastweek", "2026-07-21") === null);
  chk("lastweek：週日 → 不檢查", lowFreqDue("lastweek", "2026-07-19") === null);
  chk("meta：第一個週六已過的週一 → 到期、基準日＝該週六", lowFreqDue("meta", "2026-07-20") === "2026-07-04", String(lowFreqDue("meta", "2026-07-20")));
  chk("meta：本月第一個週六尚未到的週一 → 不檢查（2026-11-02 < 11-07）", lowFreqDue("meta", "2026-11-02") === null);
  chk("meta：第一個週六後的第一個週一 → 到期", lowFreqDue("meta", "2026-11-09") === "2026-11-07", String(lowFreqDue("meta", "2026-11-09")));
  chk("meta：週三 → 不檢查", lowFreqDue("meta", "2026-07-22") === null);
  chk("未知名稱 → null", lowFreqDue("nosuch", "2026-07-20") === null);
}

// ---- healthVerdict lowfreq 模式 ----
{
  const byName = Object.fromEntries(ALL.map((t) => [t.name, t]));
  const lw = byName.lastweek, meta = byName.meta;
  chk("lowfreq：週一當日產出（含 GH cron 延遲 10:19）→ ok",
    healthVerdict(lw, { generated_at: "2026-07-20T10:19:32+08:00" }, "2026-07-20").ok === true);
  chk("lowfreq：停在上週 → 不 ok 且帶產物時間", (() => {
    const v = healthVerdict(lw, { generated_at: "2026-07-13T09:05:00+08:00" }, "2026-07-20");
    return v.ok === false && v.at === "2026-07-13T09:05:00";
  })());
  chk("lowfreq：非檢查日 → ok 且標 not-due（不告警）", (() => {
    const v = healthVerdict(lw, { generated_at: "2026-07-13T09:05:00+08:00" }, "2026-07-21");
    return v.ok === true && v.skipped === "not-due";
  })());
  chk("lowfreq：抓不到檔且今天到期 → 不 ok",
    healthVerdict(lw, null, "2026-07-20").ok === false);
  chk("lowfreq：抓不到檔但今天不到期 → 仍 ok",
    healthVerdict(lw, null, "2026-07-21").ok === true);
  chk("meta：generated_at 正好是本月第一個週六 → ok",
    healthVerdict(meta, { generated_at: "2026-07-04T08:10:00+08:00" }, "2026-07-20").ok === true);
  chk("meta：generated_at 停在上個月 → 不 ok",
    healthVerdict(meta, { generated_at: "2026-06-06T08:10:00+08:00" }, "2026-07-20").ok === false);
  chk("meta：時間字串壞掉 → 不 ok（不當成落地）",
    healthVerdict(meta, { generated_at: "not-a-date" }, "2026-07-20").ok === false);
}

// ---- cron 路由 ----
{
  chk("HEALTH_CRONS 兩條", Object.keys(HEALTH_CRONS).length === 2);
  chk("台北 23:50 → eve", dispatchRoleForCron("50 15 * * 2-6")?.kind === "health" && dispatchRoleForCron("50 15 * * 2-6").slot === "eve");
  chk("台北 09:30 → morn", dispatchRoleForCron("30 1 * * 2-6")?.slot === "morn");
  chk("健檢 cron 不與備援班撞", dispatchRoleForCron("50 15 * * 2-6").name === undefined);
  chk("既有晚場班 cron 仍回 evening", dispatchRoleForCron("*/5 13-15 * * 2-6")?.kind === "evening");
  chk("既有 recheck cron 仍回 backup", dispatchRoleForCron("55 12 * * 2-6")?.kind === "backup");
  chk("未知 cron → null", dispatchRoleForCron("0 0 * * *") === null);
}

// ---- runHealthCheck ----
// 1) 無當日 series（休市 or frame 班故障）→ **照樣盤點照樣告警**，只在文字標註
//    （看門狗不能拿可能自己壞掉的訊號當守門——2026-07-24 就是這樣整天靜默）
{
  const alerts = [];
  const out = await runHealthCheck(ALERT_ENV(fakeKV()), TP, "eve", mkFetch([], alerts));
  chk("無 series → 不跳過、照樣盤點", out.skipped === undefined && out.checked === 12, JSON.stringify(out.skipped));
  chk("無 series → noSeries 旗標", out.noSeries === true);
  chk("無 series → 照樣告警且標註可能休市/故障", alerts.length === 1 && alerts[0].includes("無盤中 series"), alerts[0]);
}
// 1b) 有 series 時不加註記
{
  const alerts = [], kv = TRADING_KV();
  const out = await runHealthCheck(ALERT_ENV(kv), TP, "eve", mkFetch([], alerts));
  chk("有 series → noSeries=false、告警不加註記", out.noSeries === false && !alerts[0].includes("無盤中 series"), alerts[0]);
}
// 2) 全部落地 → 不告警、jobstat 記 all-ok
{
  const alerts = [], kv = TRADING_KV();
  const names = T.eve.map((t) => t.name);
  const out = await runHealthCheck(ALERT_ENV(kv), TP, "eve", mkFetch(names, alerts));
  chk("全綠 → missing 空", out.missing.length === 0 && out.checked === 12, JSON.stringify(out.missing));
  chk("全綠 → 不告警", alerts.length === 0);
  const ev = JSON.parse(kv._m.get(jobstatKey("2026-07-20")));
  chk("全綠 → jobstat 記 all-ok＋時分", ev.length === 1 && ev[0].r === "all-ok" && ev[0].t === "23:50" && ev[0].n === "health-eve", JSON.stringify(ev));
}
// 3) 缺件 → 告警一則，列出缺什麼；jobstat 記 missing 數
{
  const alerts = [], kv = TRADING_KV();
  const names = T.eve.map((t) => t.name).filter((n) => n !== "aetf" && n !== "summary-pm");
  const out = await runHealthCheck(ALERT_ENV(kv), TP, "eve", mkFetch(names, alerts));
  chk("缺兩件 → missing 兩項", out.missing.length === 2, JSON.stringify(out.missing));
  chk("缺件 → 發一則告警", alerts.length === 1, String(alerts.length));
  chk("告警內容含缺件名與產物日期", alerts[0].includes("aetf(2026-07-17)") && alerts[0].includes("summary-pm(無檔)") && alerts[0].includes("2/12"), alerts[0]);
  chk("告警走每日去重鍵", kv._m.get(alertedKey("2026-07-20", "health-eve")) === "1");
  const ev = JSON.parse(kv._m.get(jobstatKey("2026-07-20")));
  chk("jobstat 記 missing:2＋缺件清單", ev[0].r === "missing:2" && ev[0].x.includes("aetf"), JSON.stringify(ev));
}
// 4) dry → 只回結果，不告警、不記 jobstat
{
  const alerts = [], kv = TRADING_KV();
  const out = await runHealthCheck(ALERT_ENV(kv), TP, "eve", mkFetch([], alerts), { dry: true });
  chk("dry → 仍回完整盤點", out.checked === 12 && out.missing.length === 12);
  chk("dry → 不告警", alerts.length === 0);
  chk("dry → 不寫 jobstat", kv._m.get(jobstatKey("2026-07-20")) === undefined);
}
// 4b) 低頻班：台北週二的 eve 班只查 10 項（lastweek/meta 連抓都不抓、不入告警）
{
  const alerts = [], kv = fakeKV(), TUE = { date: "2026-07-21", dow: 2, hour: 23, minute: 50 };
  const out = await runHealthCheck(ALERT_ENV(kv), TUE, "eve", mkFetch([], alerts, TUE.date));
  chk("週二 eve → 只查 10 項", out.checked === 10, String(out.checked));
  chk("週二 eve → 缺件清單不含低頻班", !out.missing.some((m) => m.includes("lastweek") || m.includes("meta")), JSON.stringify(out.missing));
  chk("週二 eve → 告警文字不提低頻班", alerts.length === 1 && !alerts[0].includes("lastweek") && !alerts[0].includes("meta"), alerts[0]);
}
// 4c) 低頻班：台北週一 eve 查 12 項，只有低頻班沒落地時也叫得出來
{
  const alerts = [], kv = TRADING_KV();
  const names = T.eve.map((t) => t.name).filter((n) => n !== "lastweek" && n !== "meta");
  const out = await runHealthCheck(ALERT_ENV(kv), TP, "eve", mkFetch(names, alerts));
  chk("週一 eve → 查 12 項、缺的正是兩低頻班", out.checked === 12 && out.missing.length === 2 &&
    out.missing.join(",").includes("lastweek") && out.missing.join(",").includes("meta"), JSON.stringify(out.missing));
  chk("週一 eve → 低頻班缺件會告警", alerts.length === 1 && alerts[0].includes("2/12"), alerts[0]);
}
// 4d) 低頻班全落地 → 週一 eve 全綠不告警
{
  const alerts = [], kv = TRADING_KV();
  const out = await runHealthCheck(ALERT_ENV(kv), TP, "eve", mkFetch(T.eve.map((t) => t.name), alerts));
  chk("週一 eve 全綠（含兩低頻）→ 不告警", alerts.length === 0 && out.missing.length === 0, JSON.stringify(out.missing));
}
// 5) morn slot 只查三項
{
  const alerts = [], kv = TRADING_KV();
  const out = await runHealthCheck(ALERT_ENV(kv), { ...TP, hour: 9, minute: 30 }, "morn", mkFetch(["morning"], alerts));
  chk("morn 查三項", out.checked === 3);
  chk("morn 缺 us/summary-am → 告警", alerts.length === 1 && alerts[0].includes("晨間健檢") && alerts[0].includes("2/3"), alerts[0]);
}
// 6) 同日重複健檢 → 告警去重（不重複轟炸）
{
  const alerts = [], kv = TRADING_KV();
  const env = ALERT_ENV(kv);
  await runHealthCheck(env, TP, "eve", mkFetch([], alerts));
  await runHealthCheck(env, TP, "eve", mkFetch([], alerts));
  chk("同日同 slot 告警只發一次", alerts.length === 1, String(alerts.length));
}

// ---- recordJob / jobstat ----
{
  chk("hhmm 補零", hhmm({ hour: 9, minute: 5 }) === "09:05" && hhmm({ hour: 23, minute: 50 }) === "23:50");
  chk("jobstatKey 格式", jobstatKey("2026-07-20") === "jobstat:20260720");
}
{
  const kv = TRADING_KV();
  await recordJob({ FLOW_KV: kv }, TP, "baseline", "fired#1", "2026-07-17");
  await recordJob({ FLOW_KV: kv }, { ...TP, hour: 20, minute: 55 }, "baseline", "landed", "2026-07-20");
  const ev = JSON.parse(kv._m.get(jobstatKey("2026-07-20")));
  chk("依序 append 兩筆", ev.length === 2 && ev[0].r === "fired#1" && ev[1].r === "landed");
  chk("extra 存進 x 欄", ev[0].x === "2026-07-17" && ev[1].t === "20:55");
  chk("TTL 3 天", kv._puts.at(-1).o?.expirationTtl === 259200, JSON.stringify(kv._puts.at(-1).o));
}
{
  // 上限裁切：超過 JOBSTAT_MAX 丟最舊
  const seed = Array.from({ length: JOBSTAT_MAX }, (_, i) => ({ t: "09:00", n: `x${i}`, r: "fired" }));
  const kv = fakeKV({ [jobstatKey("2026-07-20")]: JSON.stringify(seed) });
  await recordJob({ FLOW_KV: kv }, TP, "new", "fired");
  const ev = JSON.parse(kv._m.get(jobstatKey("2026-07-20")));
  chk("陣列上限裁切", ev.length === JOBSTAT_MAX && ev.at(-1).n === "new" && ev[0].n === "x1", `${ev.length}/${ev[0].n}`);
}
{
  // 無 KV binding / KV 爆炸 → 回 false，不丟例外（絕不拖垮排程主體）
  chk("無 KV → false", (await recordJob({}, TP, "a", "b")) === false);
  const boom = { get: async () => { throw new Error("KV down"); }, put: async () => {} };
  chk("KV 異常 → 吞錯回 false", (await recordJob({ FLOW_KV: boom }, TP, "a", "b")) === false);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} 通過 / ${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
