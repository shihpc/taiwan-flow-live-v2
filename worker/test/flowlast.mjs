// 案三（2026-07-19）收盤定格 flow:last 離線單元測試：
// 寫入窗口 / payload 產生 / storeFlowLast 守門 / attachFlowLast 附掛規則。
// 執行：cd worker && node test/flowlast.mjs
import {
  inFlowLastWindow, flowLastPayload, storeFlowLast, attachFlowLast,
  FLOW_LAST_KEY, FLOW_LAST_TTL, taipeiParts,
} from "../src/index.js";

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; } else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}

// mock FLOW_KV：純記憶體 Map，另記 put 呼叫（同 frames.mjs 慣例）
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
// 台北時刻 → taipeiParts（同 frames.mjs：台北 = UTC+8）
const tp = (iso) => taipeiParts(new Date(`${iso}+08:00`));

// 合成 live（欄序照 buildLive 追加後的 stock_cols；f30 為最後一欄）
const mkLive = (flow, stocks) => ({
  ts: "2026-07-17 13:30:00",
  stock_cols: ["chg", "amt", "close", "f10", "c10", "c30", "r10", "f30"],
  stocks: stocks || {
    "2330": [1.2, 9e9, 1150, 5e8, 1.1, 1.0, 0.5, 15e8],
    "2317": [-0.5, 2e9, 210, 1e8, 0.9, 0.8, -0.2, 3e8],
    "1101": [0, 5e8, 30, 0, null, null, 0, 0],          // f30=0 → 不收
    "9999": [0, 1e8, 10, null, null, null, null, null], // f30=null → 不收
  },
  flow: flow,
});
const FLOW = { wins: { w1: 10, w2: 30 }, baseline_date: "2026-07-16",
  frames: { 10: "13:20", 30: "13:00" },
  subs: [{ name: "IC設計", n: 12, d_yi: 3.2, c1: 1.5, c2: 1.2, ret: 1.1, y: [1, 0] }],
  mkt: { d10_yi: 120.5, d30_yi: 350.25 } };

// ---- 1. 寫入窗口：平日 13:25–13:40 才 true ----
{
  chk("13:24 窗口外", !inFlowLastWindow(tp("2026-07-17T13:24:00")));
  chk("13:25 窗口內", inFlowLastWindow(tp("2026-07-17T13:25:00")));
  chk("13:30 窗口內", inFlowLastWindow(tp("2026-07-17T13:30:00")));
  chk("13:40 窗口內", inFlowLastWindow(tp("2026-07-17T13:40:00")));
  chk("13:41 窗口外", !inFlowLastWindow(tp("2026-07-17T13:41:00")));
  chk("週六 13:30 窗口外", !inFlowLastWindow(tp("2026-07-18T13:30:00")));
  chk("週日 13:30 窗口外", !inFlowLastWindow(tp("2026-07-19T13:30:00")));
}

// ---- 2. flowLastPayload：非 null flow → payload；flow null / d30 缺 → null ----
{
  const pl = flowLastPayload(mkLive(FLOW));
  chk("payload 有 date/ts", pl && pl.date === "2026-07-17" && pl.ts === "2026-07-17 13:30:00", JSON.stringify(pl && pl.date));
  chk("payload mkt 帶 d10/d30", pl && pl.mkt.d10_yi === 120.5 && pl.mkt.d30_yi === 350.25);
  chk("f30 只收 >0（2 檔）", pl && Object.keys(pl.f30).length === 2 && pl.f30["2330"] === 15e8 && pl.f30["2317"] === 3e8,
    JSON.stringify(pl && pl.f30));
  chk("flow=null → payload null", flowLastPayload(mkLive(null)) === null);
  chk("d30 缺 → payload null", flowLastPayload(mkLive({ mkt: { d10_yi: 1, d30_yi: null } })) === null);
  chk("flow 無 mkt → payload null", flowLastPayload(mkLive({ subs: [] })) === null);
}

// ---- 2b. 案四：payload 擴充欄位（subs/frames/baseline_date/stocks）----
{
  const pl = flowLastPayload(mkLive(FLOW));
  chk("subs 原樣帶出", pl && Array.isArray(pl.subs) && pl.subs.length === 1 && pl.subs[0].name === "IC設計",
    JSON.stringify(pl && pl.subs));
  chk("frames 原樣帶出", pl && pl.frames && pl.frames["10"] === "13:20" && pl.frames["30"] === "13:00",
    JSON.stringify(pl && pl.frames));
  chk("baseline_date 原樣帶出", pl && pl.baseline_date === "2026-07-16");
  chk("stocks 只收 f10>0（2 檔，值為 [f10,c10,c30,r10]）",
    pl && Object.keys(pl.stocks).length === 2
      && JSON.stringify(pl.stocks["2330"]) === JSON.stringify([5e8, 1.1, 1.0, 0.5])
      && JSON.stringify(pl.stocks["2317"]) === JSON.stringify([1e8, 0.9, 0.8, -0.2]),
    JSON.stringify(pl && pl.stocks));
  chk("f10<=0／null 個股被過濾出 stocks（1101/9999 不在內）",
    pl && !("1101" in pl.stocks) && !("9999" in pl.stocks));
  // 既有 f30/mkt 欄位不變（防退化）
  chk("f30 欄位不變（防退化）", pl && Object.keys(pl.f30).length === 2 && pl.f30["2330"] === 15e8);
  chk("mkt 欄位不變（防退化）", pl && pl.mkt.d10_yi === 120.5 && pl.mkt.d30_yi === 350.25);
}

// ---- 2c. KV value 大小量測：真實規模 mock（1500 檔個股 + 500 次產業）序列化後 <1MB ----
{
  const bigStocks = {};
  for (let i = 0; i < 1500; i++) {
    const code = String(1000 + i);
    // f10 全部 >0（最壞情況：全部進 stocks，不被過濾掉）
    bigStocks[code] = [0, 1e8, 100 + i * 0.01, 5e7 + i, 1.2, 1.1, 0.3, 1.5e8 + i];
  }
  const bigSubs = [];
  for (let i = 0; i < 500; i++) {
    bigSubs.push({ name: `次產業${i}測試較長中文名稱示例`, n: 8, d_yi: 1.23, c1: 1.4, c2: 1.1, ret: 0.5, y: [1, -1] });
  }
  const bigLive = mkLive(
    { wins: { w1: 10, w2: 30 }, baseline_date: "2026-07-16", frames: { 10: "13:20", 30: "13:00" },
      subs: bigSubs, mkt: { d10_yi: 500.5, d30_yi: 1200.25 } },
    bigStocks,
  );
  const pl = flowLastPayload(bigLive);
  const bytes = Buffer.byteLength(JSON.stringify(pl), "utf8");
  chk(`KV value <1MB（實測 ${bytes} bytes，1500檔+500次產業）`, bytes < 1024 * 1024, `bytes=${bytes}`);
  chk("大規模 mock 下 stocks 收滿 1500 檔（f10 全>0）", Object.keys(pl.stocks).length === 1500);
  chk("大規模 mock 下 subs 收滿 500 條", pl.subs.length === 500);
}

// ---- 3. storeFlowLast：窗口內＋flow 非 null 才寫；TTL 7 天；窗口外/flow null 不寫 ----
{
  const env = { FLOW_KV: mockKV() };
  const r1 = await storeFlowLast(env, mkLive(FLOW), tp("2026-07-17T13:24:00"));
  chk("窗口外不寫", !r1.stored && env.FLOW_KV.puts.length === 0, JSON.stringify(r1));
  const r2 = await storeFlowLast(env, mkLive(null), tp("2026-07-17T13:30:00"));
  chk("flow null 不寫", !r2.stored && env.FLOW_KV.puts.length === 0, JSON.stringify(r2));
  const r3 = await storeFlowLast(env, mkLive(FLOW), tp("2026-07-17T13:30:00"));
  chk("窗口內＋flow 非 null → 寫入", r3.stored && r3.key === FLOW_LAST_KEY && env.FLOW_KV.puts.length === 1);
  chk("TTL 7 天", env.FLOW_KV.puts[0].opts.expirationTtl === FLOW_LAST_TTL, JSON.stringify(env.FLOW_KV.puts[0].opts));
  const saved = await env.FLOW_KV.get(FLOW_LAST_KEY, "json");
  chk("KV 內容為 payload", saved && saved.date === "2026-07-17" && saved.mkt.d30_yi === 350.25);
  // 覆寫冪等：再寫一次同 key
  await storeFlowLast(env, mkLive(FLOW), tp("2026-07-17T13:31:00"));
  chk("覆寫同一 key（單一 key，無累積）", env.FLOW_KV.puts.length === 2 && env.FLOW_KV.store.size === 1);
  // 無 KV binding：不炸
  const r4 = await storeFlowLast({}, mkLive(FLOW), tp("2026-07-17T13:30:00"));
  chk("無 FLOW_KV 不炸不寫", !r4.stored);
}

// ---- 4. attachFlowLast：flow=null 才附；非 null 不附不讀；KV 無值不附 ----
{
  const payload = JSON.stringify({ date: "2026-07-17", ts: "2026-07-17 13:30:00",
    mkt: { d10_yi: 120.5, d30_yi: 350.25 }, f30: { "2330": 15e8 } });
  // flow=null＋KV 有值 → 附 flow_last
  const env = { FLOW_KV: mockKV({ [FLOW_LAST_KEY]: payload }) };
  const l1 = mkLive(null);
  await attachFlowLast(env, l1);
  chk("flow=null → 附 flow_last", l1.flow_last && l1.flow_last.date === "2026-07-17" && l1.flow_last.mkt.d30_yi === 350.25);
  chk("附掛不動 flow 本體", l1.flow === null);
  // flow 非 null → 不附（也不讀 KV）
  let gets = 0;
  const spyKV = { async get() { gets++; return payload; }, async put() {} };
  const l2 = mkLive(FLOW);
  await attachFlowLast({ FLOW_KV: spyKV }, l2);
  chk("flow 非 null → 不附不讀", l2.flow_last === undefined && gets === 0);
  // KV 尚無 flow:last（首次部署後）→ 不附、不炸
  const l3 = mkLive(null);
  await attachFlowLast({ FLOW_KV: mockKV() }, l3);
  chk("KV 無值 → 不附不炸", l3.flow_last === undefined);
  // KV get 失敗 → 吞錯不影響 live
  const l4 = mkLive(null);
  await attachFlowLast({ FLOW_KV: { async get() { throw new Error("kv down"); } } }, l4);
  chk("KV 讀失敗吞錯", l4.flow_last === undefined);
  // 無 binding
  const l5 = mkLive(null);
  await attachFlowLast({}, l5);
  chk("無 FLOW_KV 不炸", l5.flow_last === undefined);
}

console.log(`flowlast: pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
