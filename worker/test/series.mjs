// 即時一覽 tab 第二期：分鐘序列（series:<date> rolling key）離線單元測試（無需 token，mock KV）
// 執行：cd worker && node test/series.mjs
import { appendSeries, seriesTail } from "../src/index.js";

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; } else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}

// mock FLOW_KV：純記憶體 Map，模擬 get(key,"json")/put(key,json,opts)
function mockKV() {
  const store = new Map();
  const puts = [];
  return {
    store, puts,
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value, opts) {
      store.set(key, value);
      puts.push({ key, value, opts });
    },
  };
}

// ---- appendSeries：逐分鐘 append ----
{
  const env = { FLOW_KV: mockKV() };
  const d = "2026-07-20";
  await appendSeries(env, d, "09:00", 123456789, { close: 23000.12, change_price: 12.34 });
  await appendSeries(env, d, "09:01", 234567890, { close: 23005.5, change_price: 17.72 });
  const arr = await env.FLOW_KV.get(`series:${d}`, "json");
  chk("append 兩筆長度=2", arr.length === 2, String(arr.length));
  chk("t 遞增", arr[0].t === "09:00" && arr[1].t === "09:01", JSON.stringify(arr.map((p) => p.t)));
  chk("amt 換算億元(r1)", arr[0].amt === 1.2, String(arr[0].amt));
  chk("idx 取指數收盤", arr[1].idx === 23005.5, String(arr[1].idx));
  chk("chg 取漲跌點", arr[1].chg === 17.72, String(arr[1].chg));
  chk("每分鐘只 1 次 get + 1 次 put", env.FLOW_KV.puts.length === 2, String(env.FLOW_KV.puts.length));
}

// ---- appendSeries：idxRow 缺失（001 快照缺行）→ idx/chg 回 null，不炸 ----
{
  const env = { FLOW_KV: mockKV() };
  await appendSeries(env, "2026-07-20", "09:02", 1000000, null);
  const arr = await env.FLOW_KV.get("series:2026-07-20", "json");
  chk("idxRow 缺失 → idx null", arr[0].idx === null, String(arr[0].idx));
  chk("idxRow 缺失 → chg null", arr[0].chg === null, String(arr[0].chg));
}

// ---- appendSeries：同一分鐘重跑（cron 補跑/收盤後重算）→ 覆寫最後一筆，不重複 append ----
{
  const env = { FLOW_KV: mockKV() };
  const d = "2026-07-20";
  await appendSeries(env, d, "09:00", 1000, { close: 100, change_price: 1 });
  await appendSeries(env, d, "09:00", 2000, { close: 101, change_price: 2 });   // 同分鐘重跑
  const arr = await env.FLOW_KV.get(`series:${d}`, "json");
  chk("同分鐘冪等：長度仍為1", arr.length === 1, String(arr.length));
  chk("同分鐘冪等：值取最新一次", arr[0].idx === 101, String(arr[0].idx));
}

// ---- appendSeries：無 .list( 依賴，只用 get/put（防迴歸：本檔案不得出現 .list( 呼叫）----
{
  const src = await (await import("node:fs/promises")).readFile(
    new URL("../src/index.js", import.meta.url), "utf-8");
  chk("worker 原始碼無 .list( 呼叫", !src.includes(".list("));
}

// ---- seriesTail：/live 回應只取近 60 筆，KV 內全量不受影響 ----
{
  const full = Array.from({ length: 200 }, (_, i) => ({ t: String(i).padStart(4, "0"), amt: i, idx: null, chg: null }));
  const tail = seriesTail(full);
  chk("seriesTail 長度=60", tail.length === 60, String(tail.length));
  chk("seriesTail 取尾端（時間遞增最新60筆）", tail[0].t === "0140" && tail[59].t === "0199",
    `${tail[0].t}..${tail[59].t}`);
  chk("seriesTail 不足60筆時原樣回傳", seriesTail([{ t: "a" }, { t: "b" }]).length === 2);
  chk("seriesTail 空/undefined 不炸", seriesTail(undefined).length === 0 && seriesTail([]).length === 0);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} 通過 / ${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
