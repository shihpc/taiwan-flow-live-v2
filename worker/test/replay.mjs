// 第五期 /replay 單元測試（純 Node，無框架）。執行：cd worker && node test/replay.mjs
import { readFile } from "node:fs/promises";
import { replayFrame } from "../src/index.js";

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; } else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}

// mock FLOW_KV：純記憶體 Map，另計 get 次數（驗證缺格回退 ≤6 次 get）
function mockKV(init) {
  const store = new Map(Object.entries(init || {}));
  let gets = 0;
  return {
    store,
    get count() { return gets; },
    reset() { gets = 0; },
    async get(key, type) {
      gets++;
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value) { store.set(key, value); },
  };
}

const D = "2026-07-17";
const FR = JSON.stringify({ "2330": [123456789, 1150], "2317": [23456789, 210.5] });

{ // 1. 命中：該分鐘 frame 存在 → 直接回傳
  const kv = mockKV({ [`f:${D}:10:00`]: FR });
  const out = await replayFrame({ FLOW_KV: kv }, D, "10:00");
  chk("命中分鐘", out.t === "10:00" && out.date === D && out.stocks["2330"][1] === 1150, JSON.stringify(out).slice(0, 80));
  chk("命中只 1 次 get", kv.count === 1, `gets=${kv.count}`);
}
{ // 2. 缺格回退：10:05 缺，往前至 10:00 命中（邊界：正好第 5 分鐘）
  const kv = mockKV({ [`f:${D}:10:00`]: FR });
  const out = await replayFrame({ FLOW_KV: kv }, D, "10:05");
  chk("缺格回退命中 10:00", out.t === "10:00" && !out.error, JSON.stringify(out).slice(0, 80));
  chk("回退共 6 次 get（≤6）", kv.count === 6, `gets=${kv.count}`);
}
{ // 3. 超過 5 分鐘不回退：10:06 只往前到 10:01 → 明確錯誤物件（不 throw）
  const kv = mockKV({ [`f:${D}:10:00`]: FR });
  const out = await replayFrame({ FLOW_KV: kv }, D, "10:06");
  chk("超過 5 分鐘回錯誤", !!out.error && !out.stocks, JSON.stringify(out).slice(0, 80));
  chk("錯誤情境 get ≤6", kv.count <= 6, `gets=${kv.count}`);
}
{ // 4. 收盤後夾到 13:30：t=13:45 → 命中 f:...:13:30
  const kv = mockKV({ [`f:${D}:13:30`]: FR });
  const out = await replayFrame({ FLOW_KV: kv }, D, "13:45");
  chk("13:45 夾到 13:30", out.t === "13:30" && !out.error, JSON.stringify(out).slice(0, 80));
}
{ // 5. 盤前／格式錯誤 → 明確錯誤 JSON
  const kv = mockKV({});
  chk("盤前 08:30 回錯誤", !!(await replayFrame({ FLOW_KV: kv }, D, "08:30")).error);
  chk("t 格式錯誤回錯誤", !!(await replayFrame({ FLOW_KV: kv }, D, "abc")).error);
  chk("t 缺省回錯誤", !!(await replayFrame({ FLOW_KV: kv }, D)).error);
  chk("09:00 往前不越界（不足 6 get）", await (async () => { kv.reset(); const o = await replayFrame({ FLOW_KV: kv }, D, "09:02"); return !!o.error && kv.count === 3; })(), `gets=${kv.count}`);
}
{ // 6. 無資料日（週末）：任何分鐘都回錯誤、不 throw
  const kv = mockKV({});
  const out = await replayFrame({ FLOW_KV: kv }, "2026-07-19", "10:30");
  chk("無資料日回錯誤 JSON", !!out.error && out.date === "2026-07-19", JSON.stringify(out).slice(0, 80));
}
{ // 7. 靜態檢查：src 無 KV list 呼叫（歷史雷：免費額度 1000 次/日）
  const src = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  chk("src 無 .list( 呼叫", !src.includes(".list("));
  chk("/replay 路由存在", src.includes('url.pathname === "/replay"'));
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} 通過 / ${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
