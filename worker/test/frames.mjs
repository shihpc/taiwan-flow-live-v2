// frame 落格斷檔修復（2026-07-18）離線單元測試：牆鐘 key / 重試 / stale 標記 / err 可見化 /
// computeFlow stale 降級 / replay src_ts。執行：cd worker && node test/frames.mjs
import { readFile } from "node:fs/promises";
import { storeFrame, recordFrameErr, computeFlow, replayFrame } from "../src/index.js";

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; } else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}

// mock FLOW_KV：純記憶體 Map，另記 put 呼叫
function mockKV(init) {
  const store = new Map(Object.entries(init || {}));
  const puts = [];
  return {
    store, puts,
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value, opts) { store.set(key, value); puts.push({ key, value, opts }); },
  };
}
// 台北時間 → scheduledTime（epoch ms）：台北 = UTC+8
const tpeMs = (iso) => new Date(`${iso}+08:00`).getTime();
// 停滯快照 rows（FinMind 時戳固定不動）
const rows = (ts) => [
  { stock_id: "001", date: ts, close: 23000.5, change_price: 12.3, total_amount: 0 },
  { stock_id: "2330", date: ts, close: 1150, total_amount: 123456789 },
  { stock_id: "2317", date: ts, close: 210.5, total_amount: 23456789 },
];

// ---- 1. key 由 scheduledTime 決定：FinMind ts 停滯、兩次喚醒 → 兩個不同 key ----
{
  const env = { FLOW_KV: mockKV() };
  const STUCK = "2026-07-20 09:04:30";   // 上游時戳停滯
  const snapFn = async () => rows(STUCK);
  const o1 = await storeFrame(env, tpeMs("2026-07-20T09:05:00"), { snapFn });
  const o2 = await storeFrame(env, tpeMs("2026-07-20T09:10:00"), { snapFn });
  chk("兩次喚醒 → 兩個不同 key", o1.key === "f:2026-07-20:09:05" && o2.key === "f:2026-07-20:09:10",
    `${o1.key} / ${o2.key}`);
  const f1 = await env.FLOW_KV.get("f:2026-07-20:09:05", "json");
  const f2 = await env.FLOW_KV.get("f:2026-07-20:09:10", "json");
  chk("兩格皆落地（不再同 key 覆寫塌縮）", !!f1 && !!f2);
  chk("value 內存 src_ts (_ts)", f1._ts === STUCK && f2._ts === STUCK, `${f1._ts}`);
  chk("差 1 分未標 stale", !f1._stale && o1.stale === false, JSON.stringify(o1));
  chk("差 6 分（>3）標 stale", f2._stale === 1 && o2.stale === true, JSON.stringify(o2));
  chk("stocks 計數不含 meta 鍵", o1.stocks === 2, String(o1.stocks));
  const fi = await env.FLOW_KV.get("fi:2026-07-20", "json");
  chk("fi 索引兩筆（照舊維護）", fi && fi.length === 2 && fi[0] === "09:05" && fi[1] === "09:10",
    JSON.stringify(fi));
  const se = await env.FLOW_KV.get("series:2026-07-20", "json");
  chk("series 兩點（牆鐘分鐘）", se && se.length === 2 && se[1].t === "09:10", JSON.stringify(se));
  chk("frame TTL 2 天", env.FLOW_KV.puts[0].opts.expirationTtl === 172800);
}

// ---- 1b. 跨日停滯（07-17 整天壞掉型：FinMind 還在吐前一日時戳）→ 照存、標 stale ----
{
  const env = { FLOW_KV: mockKV() };
  const o = await storeFrame(env, tpeMs("2026-07-21T09:03:00"),
    { snapFn: async () => rows("2026-07-20 13:30:00") });
  chk("跨日停滯照存於今日牆鐘 key", o.key === "f:2026-07-21:09:03", o.key);
  chk("跨日停滯標 stale", o.stale === true);
}

// ---- 1c. 收盤後守門：>13:35 跳過（牆鐘 key 不長盤後假格）；force=1 略過 ----
{
  const env = { FLOW_KV: mockKV() };
  const snapFn = async () => rows("2026-07-20 13:30:00");
  const o = await storeFrame(env, tpeMs("2026-07-20T13:40:00"), { snapFn });
  chk("13:40 → skipped、零 KV 寫入", o.skipped === true && env.FLOW_KV.puts.length === 0,
    JSON.stringify(o));
  const o2 = await storeFrame(env, tpeMs("2026-07-20T13:40:00"), { snapFn, force: true });
  chk("force=1 → 照存", o2.key === "f:2026-07-20:13:40" && env.FLOW_KV.puts.length > 0, JSON.stringify(o2));
  const o3 = await storeFrame(env, tpeMs("2026-07-20T13:35:00"), { snapFn });
  chk("13:35 邊界 → 照存（收盤末筆不丟）", o3.key === "f:2026-07-20:13:35", JSON.stringify(o3));
}

// ---- 2. finSnapshot 失敗重試一次：第一次 throw 第二次成功 → 有寫入 ----
{
  const env = { FLOW_KV: mockKV() };
  let calls = 0;
  const snapFn = async () => { calls++; if (calls === 1) throw new Error("HTTP 502"); return rows("2026-07-20 09:59:50"); };
  const o = await storeFrame(env, tpeMs("2026-07-20T10:00:00"), { snapFn, retryMs: 1 });
  chk("重試後成功寫入", o.key === "f:2026-07-20:10:00" && calls === 2, `calls=${calls}`);
  // 兩次都失敗 → throw（由 scheduled 端記 err），且無 frame 寫入
  const env2 = { FLOW_KV: mockKV() };
  let threw = null;
  try { await storeFrame(env2, tpeMs("2026-07-20T10:01:00"), { snapFn: async () => { throw new Error("HTTP 503"); }, retryMs: 1 }); }
  catch (e) { threw = e.message; }
  chk("兩次皆敗 → throw、零寫入", threw === "HTTP 503" && env2.FLOW_KV.puts.length === 0, String(threw));
}

// ---- 3. err:<date> 僅錯誤內容變化時寫（省 KV write）----
{
  const env = { FLOW_KV: mockKV() };
  const d = "2026-07-20";
  const w1 = await recordFrameErr(env, d, new Error("snapshot HTTP 502"));
  const n1 = env.FLOW_KV.puts.length;
  const w2 = await recordFrameErr(env, d, new Error("snapshot HTTP 502"));   // 同錯誤
  const n2 = env.FLOW_KV.puts.length;
  const w3 = await recordFrameErr(env, d, new Error("snapshot 無資料"));       // 錯誤變化
  const n3 = env.FLOW_KV.puts.length;
  chk("首次錯誤 → 寫", w1 === true && n1 === 1, `w1=${w1} n1=${n1}`);
  chk("同錯誤重複 → 不寫", w2 === false && n2 === 1, `w2=${w2} n2=${n2}`);
  chk("錯誤變化 → 再寫、count 累加", w3 === true && n3 === 2, `w3=${w3} n3=${n3}`);
  const rec = await env.FLOW_KV.get(`err:${d}`, "json");
  chk("err 內容：last/count/at", rec.last === "snapshot 無資料" && rec.count === 2 && !!rec.at,
    JSON.stringify(rec));
  chk("err TTL 2 天", env.FLOW_KV.puts[1].opts.expirationTtl === 172800);
}

// ---- 4a. computeFlow stale 防護：窗口 frame _ts 與當前快照時戳相同 → 走既有降級（flow=null）----
{
  const baseline = { stocks: { "2330": [5e9, 0, 0, 0, 0, 0, 0] }, tot5: 1e11, date: "2026-07-17" };
  const items = [{ code: "2330", amt: 150e6, close: 1010 }];
  const mkFrames = () => ({ 10: { name: "f:2026-07-20:09:50", data: { _ts: "2026-07-20 09:50:00", "2330": [100e6, 1000] } } });
  const fresh = computeFlow({}, items, baseline, mkFrames(), "2026-07-20 10:00:00");
  chk("時戳不同（正常盤中）→ flow 有值", !!fresh.flow && fresh.per["2330"][0] === 50e6,
    JSON.stringify(fresh.flow && fresh.flow.wins));
  const stale = computeFlow({}, items, baseline, mkFrames(), "2026-07-20 09:50:00");   // 停滯：同 _ts
  chk("_ts 相同（上游停滯）→ 窗口剔除走既有降級 flow=null", stale.flow === null,
    JSON.stringify(stale.flow));
  const noTs = computeFlow({}, items, baseline, mkFrames());   // 未帶 nowTs（相容舊呼叫）
  chk("未帶 nowTs → 行為照舊", !!noTs.flow);
}

// ---- 4b. computeFlow：停滯造成 Δ=0（牆鐘 key 下相鄰格內容相同）→ 不產生假訊號 ----
{
  const baseline = { stocks: { "2330": [5e9, 0, 0, 0, 0, 0, 0] }, tot5: 1e11, date: "2026-07-17" };
  // frame 的累計額與現值相同（上游停滯、無 _ts 的舊格式 frame）→ Δ=0 → mktD=0 → cx=null
  const items = [{ code: "2330", amt: 100e6, close: 1000 }];
  const frames = { 10: { name: "f:2026-07-20:09:50", data: { "2330": [100e6, 1000] } } };
  const out = computeFlow({}, items, baseline, frames, "2026-07-20 10:00:00");
  chk("Δ=0 → c10=null、無假集中度", out.per["2330"][1] === null, JSON.stringify(out.per));
  chk("Δ=0 → subs 空、mkt d10_yi=0", out.flow.subs.length === 0 && out.flow.mkt.d10_yi === 0,
    JSON.stringify(out.flow.mkt));
}

// ---- 4c. replayFrame：回傳附 src_ts/stale，stocks 不含 meta 鍵；舊格式相容 ----
{
  const D = "2026-07-20";
  const kv = mockKV({
    [`f:${D}:10:00`]: JSON.stringify({ "2330": [123, 1150], _ts: "2026-07-20 09:55:00", _stale: 1 }),
    [`f:${D}:11:00`]: JSON.stringify({ "2330": [456, 1160] }),   // 舊格式（無 meta）
  });
  const a = await replayFrame({ FLOW_KV: kv }, D, "10:00");
  chk("replay 附 src_ts", a.src_ts === "2026-07-20 09:55:00", JSON.stringify(a));
  chk("replay 附 stale=1", a.stale === 1);
  chk("stocks 不含 meta 鍵", !("_ts" in a.stocks) && !("_stale" in a.stocks) && a.stocks["2330"][0] === 123);
  const b = await replayFrame({ FLOW_KV: kv }, D, "11:00");
  chk("舊格式 frame 相容（無 src_ts 欄）", b.t === "11:00" && !("src_ts" in b) && !("stale" in b),
    JSON.stringify(b));
}

// ---- 5. 靜態檢查：無 .list( 新增；scheduled 入口有帶 scheduledTime 且錯誤有記 err ----
{
  const src = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  chk("src 無 .list( 呼叫", !src.includes(".list("));
  chk("scheduled 帶 event.scheduledTime 進 storeFrame", src.includes("storeFrame(env, event.scheduledTime)"));
  chk("scheduled 失敗記 recordFrameErr", src.includes("recordFrameErr(env, tp.date, e)"));
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} 通過 / ${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
