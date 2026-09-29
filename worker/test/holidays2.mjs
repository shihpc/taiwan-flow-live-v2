// 休市日比照週末：排程角色（docs/holiday-calendar.md §5a，2026-09-29 批次二）離線測試。
// 執行：cd worker && node test/holidays2.mjs
//
// 做法：直接打 `export default` 的 scheduled(event, env, ctx)——與生產同一個入口——
// 以 globalThis.fetch stub（記錄每個 URL）＋KV mock（記錄每次 get/put）＋ctx（收 waitUntil）重演。
// 行事曆用 repo 真實 data/twse_holidays.json（2026-09-25 中秋、09-28 教師節皆在 closed）。
//
// 「與改動前相同」的證據＝**對跑**：把 HEAD~ 的 worker/src/index.js（本批改動前）以 git show 取出，
// 同一組 stub 各跑一次，比對 fetch URL 集合與 KV 操作集合（去掉行事曆那一次 fetch 與破快取參數）。
// 取不到舊版（非 git 環境）時對跑段落整段略過並印 WARN，其餘斷言照跑。
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import worker, {
  HOLIDAYS_URL, FRAME_CRON, TICK_CRON, ICHING_CRON, resetHolidayMemo, holidayCalCached, holidayToday,
  HOLIDAY_MEMO_OK_MS, HOLIDAY_MEMO_FAIL_MS, runHealthCheck, HEALTH_NON_TW,
} from "../src/index.js";

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) pass++; else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}
const REAL_CAL = await readFile(new URL("../../data/twse_holidays.json", import.meta.url), "utf8");
const DATA_BASE = "https://raw.githubusercontent.com/shihpc/taiwan-flow-live-v2/main/data";

// ---- 舊版模組（改動前）：以「本批第一個改動前」的 commit 為準 ----
let OLD = null;
try {
  const base = process.env.HOLIDAYS2_BASE || "94c5773";
  const src = execFileSync("git", ["show", `${base}:worker/src/index.js`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (src.includes("export function holidayToday")) throw new Error("base 已含本批改動");
  const dir = await mkdtemp(join(tmpdir(), "hol2-"));
  const p = join(dir, "index_old.mjs");
  await writeFile(p, src);
  OLD = (await import(p)).default;
} catch (e) {
  console.log(`WARN 取不到改動前的 worker（${e && e.message}），對跑段落略過`);
}

// ---- stub ----
function mockKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  const ops = [];
  return {
    ops,
    async get(k, type) { ops.push(`get ${k}`); const v = m.get(k); if (v == null) return null; return type === "json" ? JSON.parse(v) : v; },
    async put(k, v) { ops.push(`put ${k}`); m.set(k, String(v)); },
    async delete(k) { ops.push(`del ${k}`); m.delete(k); },
  };
}
// cal: "ok" | "404" | "bad" | "throw"
function makeFetch(calMode, dateISO, calls, products = {}) {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push(url);
    if (url.startsWith(HOLIDAYS_URL)) {
      if (calMode === "throw") throw new TypeError("network down");
      if (calMode === "404") return new Response("nf", { status: 404 });
      if (calMode === "bad") return new Response("{not json", { status: 200 });
      return new Response(REAL_CAL, { status: 200 });
    }
    if (url.includes("taiwan_stock_tick_snapshot")) {
      const ts = `${dateISO} 10:00:00`;
      return Response.json({ status: 200, data: [
        { stock_id: "001", date: ts, close: 20000, change_price: 10 },
        { stock_id: "2330", date: ts, total_amount: 1e9, close: 1000 },
      ] });
    }
    if (url.includes("api.finmindtrade.com")) return Response.json({ status: 200, data: [] });
    if (url.includes("api.github.com")) return new Response(null, { status: 204 });
    if (url.includes("api.line.me") || url.includes("hooks.example")) return new Response("ok", { status: 200 });
    for (const k of Object.keys(products)) if (url.includes(k)) return Response.json(products[k]);
    return new Response("nf", { status: 404 });
  };
}
const ENV = (kv) => ({ FLOW_KV: kv, FINMIND_TOKEN: "tok-test", GH_DISPATCH_TOKEN: "gh-test",
  ALERT_WEBHOOK: "https://hooks.example/x", LINE_TOKEN: "lt", LINE_USER_ID: "U1", DATA_BASE });
const tpeMs = (s) => Date.parse(`${s}:00+08:00`);   // "2026-09-25T10:00"
const norm = (u) => u.replace(/([?&])(_|d)=\d+/g, "$1$2=*");
const origFetch = globalThis.fetch;
const origLog = console.log, origErr = console.error;

async function run(mod, { cron, at, cal = "ok", seed = {}, products = {} }) {
  if (mod === worker) resetHolidayMemo();
  const calls = [];
  const kv = mockKV(seed);
  const date = at.slice(0, 10);
  globalThis.fetch = makeFetch(cal, date, calls, products);
  const logs = [];
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => logs.push(a.join(" "));
  const waits = [];
  try {
    await mod.scheduled({ cron, scheduledTime: tpeMs(at) }, ENV(kv), { waitUntil: (p) => waits.push(p) });
    await Promise.allSettled(waits);
  } finally {
    globalThis.fetch = origFetch; console.log = origLog; console.error = origErr;
  }
  const fetches = calls.filter((u) => !u.startsWith(HOLIDAYS_URL)).map(norm);
  return { calls, fetches, kv: kv.ops, logs, calFetches: calls.filter((u) => u.startsWith(HOLIDAYS_URL)).length };
}
const isFin = (u) => u.includes("api.finmindtrade.com");
const isDispatch = (u) => u.includes("api.github.com") && u.includes("/dispatches");
const isAlert = (u) => u.includes("hooks.example") || u.includes("api.line.me");
const puts = (r) => r.kv.filter((o) => o.startsWith("put "));
const sortJ = (a) => JSON.stringify([...a].sort());

// ---- 角色表（cron 字串與 wrangler.toml 一致；時刻為台北） ----
const ROLES = [
  { id: "frame",            cron: FRAME_CRON,              hm: "10:00", tw: true },
  { id: "frame+flowLast",   cron: FRAME_CRON,              hm: "13:30", tw: true },
  { id: "sentinel",         cron: "*/5 9-14 * * 2-6",      hm: "18:00", tw: true },
  { id: "ticksample",       cron: TICK_CRON,               hm: "10:05", tw: true },
  { id: "backup-daysummary",cron: "35 5 * * 2-6",          hm: "13:35", tw: true },
  { id: "backup-intraday",  cron: "40 6 * * 2-6",          hm: "14:40", tw: true },
  { id: "backup-aetf",      cron: "35 10 * * 2-6",         hm: "18:35", tw: true },
  { id: "backup-baseline",  cron: "5 12 * * 2-6",          hm: "20:05", tw: true },
  { id: "recheck-aetf",     cron: "0 11 * * 2-6",          hm: "19:00", tw: true },
  { id: "evening-2130",     cron: "*/5 13-15 * * 2-6",     hm: "21:30", tw: true },
  { id: "evening-2230",     cron: "*/5 13-15 * * 2-6",     hm: "22:30", tw: true },
  { id: "health-eve",       cron: "50 15 * * 2-6",         hm: "23:50", tw: "health" },
  { id: "health-morn",      cron: "30 1 * * 2-6",          hm: "09:30", tw: "health" },
  { id: "summary-am-0650",  cron: "50,55 22 * * *",        hm: "06:50", tw: true },
  { id: "summary-am-0700",  cron: "*/5 23 * * *",          hm: "07:00", tw: "am+us" },
  { id: "summary-am-0810",  cron: "*/10 0 * * *",          hm: "08:10", tw: true },
  { id: "summary-am-0820",  cron: "*/10 0 * * *",          hm: "08:20", tw: true },
  { id: "morning-0647",     cron: "7,47 0-14,22-23 * * *", hm: "06:47", tw: true },
  { id: "backup-us",        cron: "5 21 * * *",            hm: "05:05", tw: false },
  { id: "recheck-us",       cron: "35 21 * * *",           hm: "05:35", tw: false },
  { id: "news",             cron: "7,47 0-14,22-23 * * *", hm: "10:07", tw: false },
  { id: "iching",           cron: ICHING_CRON,             hm: "22:30", tw: false },
];
// 各場景 seed：series 存在（讓 TW 班在「沒有休市守門」時確實會往下走，差異才看得出來）
const seedFor = (d) => ({ [`series:${d}`]: JSON.stringify([{ t: "09:00", amt: 1, idx: 1, chg: 0 }]) });
// us.json：讓 us 班有東西可看（stale＝會補發；這裡給 stale 讓「us 照跑」看得出 dispatch）
const PRODUCTS = {};

// ---- A. 國定假日（09-25 週五、09-28 週一）：TW 角色零副作用 ----
for (const d of ["2026-09-25", "2026-09-28"]) {
  for (const R of ROLES) {
    const r = await run(worker, { cron: R.cron, at: `${d}T${R.hm}`, seed: seedFor(d), products: PRODUCTS });
    const tag = `${d} ${R.id}`;
    if (R.tw === true) {
      chk(`${tag}：不打 FinMind`, !r.fetches.some(isFin), r.fetches.join(","));
      chk(`${tag}：不 dispatch`, !r.fetches.some(isDispatch), r.fetches.join(","));
      chk(`${tag}：不告警／不推 LINE`, !r.fetches.some(isAlert), r.fetches.join(","));
      chk(`${tag}：不碰 KV（不寫 frame／series／fi／sentinel／bkfired／jobstat）`, r.kv.length === 0, r.kv.join(","));
      chk(`${tag}：除行事曆外零對外請求`, r.fetches.length === 0, r.fetches.join(","));
      chk(`${tag}：行事曆恰讀 1 次`, r.calFetches === 1, String(r.calFetches));
    } else if (R.tw === "health") {
      const prods = r.fetches.filter((u) => u.includes("raw.githubusercontent.com"));
      const allowed = prods.every((u) => /\/us\.json|\/lastweek\.json|\/classify\.json/.test(u));
      chk(`${tag}：只抓美股／低頻班產物`, allowed, prods.join(","));
      chk(`${tag}：不打 FinMind、不 dispatch`, !r.fetches.some(isFin) && !r.fetches.some(isDispatch));
      chk(`${tag}：不讀 series`, !r.kv.some((o) => o.includes("series:")), r.kv.join(","));
      if (R.id === "health-eve" && d === "2026-09-25")
        chk(`${tag}：週五假日 eve 一項不剩 → 零副作用`, r.fetches.length === 0 && r.kv.length === 0, r.fetches.join(",") + "|" + r.kv.join(","));
      if (R.id === "health-eve" && d === "2026-09-28")
        chk(`${tag}：週一假日 eve 仍檢查 lastweek／meta（低頻班不依台股交易日）`,
          prods.some((u) => u.includes("lastweek.json")) && prods.some((u) => u.includes("classify.json")), prods.join(","));
      if (R.id === "health-morn")
        chk(`${tag}：morn 只剩 us`, prods.length === 1 && prods[0].includes("/us.json"), prods.join(","));
    } else if (R.tw === "am+us") {
      chk(`${tag}：am summary 不 dispatch（只允許 us.yml）`,
        r.fetches.filter(isDispatch).every((u) => u.includes("/us.yml/")), r.fetches.join(","));
      // us 晨間補跑照跑：週五（09-25）us.json stale → dispatch us.yml；週一（09-28）既有 dow 守門本來就不跑
      const wantUs = d === "2026-09-25";
      chk(`${tag}：us 晨間補跑照跑（週五 dispatch／週一依既有守門不跑）`,
        r.fetches.some((u) => u.includes("/us.yml/dispatches")) === wantUs, r.fetches.join(","));
      if (OLD) {
        const o = await run(OLD, { cron: R.cron, at: `${d}T${R.hm}`, seed: seedFor(d), products: PRODUCTS });
        const usOnly = (a) => a.filter((u) => u.includes("us.yml") || u.includes("/us.json"));
        chk(`${tag}：us 部分與改動前相同`, sortJ(usOnly(r.fetches)) === sortJ(usOnly(o.fetches)), `${r.fetches}\n    vs ${o.fetches}`);
      }
      chk(`${tag}：不讀 series／sumfired`, !r.kv.some((o) => o.includes("series:") || o.includes("sumfired:")), r.kv.join(","));
    } else {
      // 非台股交易日類（us／news／iching）：台股休市照跑，且與改動前逐項相同
      chk(`${tag}：照跑（有 dispatch）`, r.fetches.some(isDispatch), r.fetches.join(","));
      chk(`${tag}：不讀行事曆`, r.calFetches === 0, String(r.calFetches));
      if (OLD) {
        const o = await run(OLD, { cron: R.cron, at: `${d}T${R.hm}`, seed: seedFor(d), products: PRODUCTS });
        chk(`${tag}：與改動前相同（fetch）`, sortJ(r.fetches) === sortJ(o.fetches), `${r.fetches}\n    vs ${o.fetches}`);
        chk(`${tag}：與改動前相同（KV）`, sortJ(r.kv) === sortJ(o.kv), `${r.kv}\n    vs ${o.kv}`);
      }
    }
  }
}

// ---- B. 對跑：09-29 平日（行事曆正常）／09-25 行事曆 404／壞檔／拋錯（fail-open）＝改動前逐項相同 ----
const cases = [["2026-09-29", "ok"], ["2026-09-25", "404"], ["2026-09-25", "bad"], ["2026-09-25", "throw"], ["2026-09-28", "throw"]];
for (const [d, cal] of cases) {
  for (const R of ROLES) {
    const r = await run(worker, { cron: R.cron, at: `${d}T${R.hm}`, cal, seed: seedFor(d), products: PRODUCTS });
    const tag = `${d} cal=${cal} ${R.id}`;
    if (OLD) {
      const o = await run(OLD, { cron: R.cron, at: `${d}T${R.hm}`, cal, seed: seedFor(d), products: PRODUCTS });
      chk(`${tag}：fetch 與改動前相同`, sortJ(r.fetches) === sortJ(o.fetches), `\n    new ${r.fetches}\n    old ${o.fetches}`);
      chk(`${tag}：KV 操作與改動前相同`, sortJ(r.kv) === sortJ(o.kv), `\n    new ${r.kv}\n    old ${o.kv}`);
    }
  }
}
// 09-29 正向確認：frame 真的寫了、哨兵真的探測了
{
  const d = "2026-09-29";
  const f = await run(worker, { cron: FRAME_CRON, at: `${d}T10:00`, seed: seedFor(d) });
  chk("09-29 frame：寫 f:2026-09-29:10:00", f.kv.includes("put f:2026-09-29:10:00"), f.kv.join(","));
  chk("09-29 frame：寫 fi:2026-09-29", f.kv.includes("put fi:2026-09-29"), f.kv.join(","));
  chk("09-29 frame：寫 series:2026-09-29", f.kv.includes("put series:2026-09-29"), f.kv.join(","));
  const s = await run(worker, { cron: "*/5 9-14 * * 2-6", at: `${d}T18:00` });
  chk("09-29 sentinel：探測 FinMind", s.fetches.filter(isFin).length === 4, s.fetches.join(","));
  const f404 = await run(worker, { cron: FRAME_CRON, at: "2026-09-25T10:00", cal: "404" });
  chk("fail-open：行事曆 404 時 09-25 frame 照寫（＝改動前）", f404.kv.includes("put f:2026-09-25:10:00"), f404.kv.join(","));
  chk("fail-open：log 註明未載入", f404.logs.some((l) => l.includes("holiday-cal 未載入")), f404.logs.join("|"));
}

// ---- C. 09-26 週六：只有 dow * 的 cron 會醒；行為與改動前相同、連行事曆都不讀 ----
for (const R of ROLES.filter((x) => x.cron.trim().split(/\s+/)[4] === "*")) {
  const d = "2026-09-26";
  const r = await run(worker, { cron: R.cron, at: `${d}T${R.hm}`, seed: {}, products: PRODUCTS });
  chk(`${d} ${R.id}：週末不讀行事曆`, r.calFetches === 0, String(r.calFetches));
  if (R.tw === true || R.tw === "am+us") {
    chk(`${d} ${R.id}：週末不 dispatch 台股班`, !r.fetches.some((u) => isDispatch(u) && !u.includes("/us.yml/") && !u.includes("build-news")), r.fetches.join(","));
  }
  if (OLD) {
    const o = await run(OLD, { cron: R.cron, at: `${d}T${R.hm}`, seed: {}, products: PRODUCTS });
    chk(`${d} ${R.id}：與改動前相同`, sortJ(r.fetches) === sortJ(o.fetches) && sortJ(r.kv) === sortJ(o.kv),
      `\n    new ${r.fetches} ${r.kv}\n    old ${o.fetches} ${o.kv}`);
  }
}

// ---- D. 記憶化：同 isolate 30 分內只讀一次；失敗 5 分內不重打；並發共用 in-flight ----
{
  resetHolidayMemo();
  let n = 0;
  const f = async () => { n++; return new Response(REAL_CAL, { status: 200 }); };
  const t0 = Date.parse("2026-09-25T02:00:00Z");
  const tp = { date: "2026-09-25", dow: 5, hour: 10, minute: 0 };
  const a = await holidayToday(tp, f, t0);
  const b = await holidayToday(tp, f, t0 + 60e3);
  chk("memo：09-25 判假日", a.holiday === true && b.holiday === true);
  chk("memo：1 分鐘後不再 fetch", n === 1, String(n));
  await holidayToday(tp, f, t0 + HOLIDAY_MEMO_OK_MS + 1);
  chk("memo：過 30 分重抓", n === 2, String(n));
  resetHolidayMemo();
  let m = 0;
  const bad = async () => { m++; return new Response("x", { status: 500 }); };
  const c = await holidayToday(tp, bad, t0);
  await holidayToday(tp, bad, t0 + HOLIDAY_MEMO_FAIL_MS - 1);
  chk("memo 失敗：fail-open holiday=false 且帶 err", c.holiday === false && /HTTP 500/.test(c.err), JSON.stringify(c));
  chk("memo 失敗：5 分內不重打", m === 1, String(m));
  await holidayToday(tp, bad, t0 + HOLIDAY_MEMO_FAIL_MS + 1);
  chk("memo 失敗：過 5 分重打", m === 2, String(m));
  resetHolidayMemo();
  let k = 0;
  const slow = async () => { k++; await new Promise((r) => setTimeout(r, 20)); return new Response(REAL_CAL, { status: 200 }); };
  const [x, y] = await Promise.all([holidayCalCached(slow, t0), holidayCalCached(slow, t0)]);
  chk("in-flight：並發兩次只 fetch 一次", k === 1 && x.cal && y.cal, String(k));
  resetHolidayMemo();
  let w = 0;
  const cnt = async () => { w++; return new Response(REAL_CAL, { status: 200 }); };
  const sat = await holidayToday({ date: "2026-09-26", dow: 6, hour: 10, minute: 0 }, cnt, t0);
  chk("週末：holiday=false 且不讀行事曆", sat.holiday === false && w === 0, `${JSON.stringify(sat)} n=${w}`);
  const tue = await holidayToday({ date: "2026-09-29", dow: 2, hour: 10, minute: 0 }, cnt, t0);
  chk("09-29：holiday=false", tue.holiday === false && w === 1);
  resetHolidayMemo();
  // 年度未涵蓋 → false
  const y27 = async () => new Response(JSON.stringify({ schema: 1, years: [2027], closed: ["2026-09-25"] }), { status: 200 });
  chk("年度未涵蓋 → fail-open false", (await holidayToday(tp, y27, t0)).holiday === false);
  resetHolidayMemo();
}
// 生產路徑的連續每分鐘 frame：同一 isolate 只讀一次行事曆
{
  resetHolidayMemo();
  const calls = [];
  globalThis.fetch = makeFetch("ok", "2026-09-25", calls);
  console.log = () => {};
  try {
    for (const hm of ["10:00", "10:01", "10:02", "10:03"]) {
      const waits = [];
      await worker.scheduled({ cron: FRAME_CRON, scheduledTime: tpeMs(`2026-09-25T${hm}`) },
        ENV(mockKV()), { waitUntil: (p) => waits.push(p) });
      await Promise.allSettled(waits);
    }
  } finally { globalThis.fetch = origFetch; console.log = origLog; }
  chk("每分鐘 frame：4 分鐘只讀 1 次行事曆（isolate 記憶化）", calls.filter((u) => u.startsWith(HOLIDAYS_URL)).length === 1, String(calls.length));
  resetHolidayMemo();
}

// ---- E. runHealthCheck 直呼：省略 opts.marketClosed ＝ 舊行為（既有測試不改即證）；帶上只剩非台股項 ----
{
  chk("HEALTH_NON_TW 恰為 us／lastweek／meta", [...HEALTH_NON_TW].sort().join(",") === "lastweek,meta,us");
  const kv = mockKV();
  const calls = [];
  const f = makeFetch("ok", "2026-09-25", calls);
  const out = await runHealthCheck(ENV(kv), { date: "2026-09-25", dow: 5, hour: 23, minute: 50 }, "eve", f, { marketClosed: true, dry: true });
  chk("health eve 週五假日 marketClosed → skipped、零請求", out.skipped === "market-closed" && calls.length === 0 && kv.ops.length === 0, JSON.stringify(out));
}

console.log(`holidays2: ${pass} passed, ${fail} failed${OLD ? "" : "（對跑略過）"}`);
if (fail) process.exit(1);
