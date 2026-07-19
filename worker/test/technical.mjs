// 個股追蹤技術面：純函式離線單元測試（無需 token，mock FinMind／mock KV）
// 執行：cd worker && node test/technical.mjs
// 指標對照均為手算／教科書固定序列值（見各區塊註解）。
import {
  sma, ema, kd, macd, rsi, boll, volumeRatio, range52, maArrange,
  buildSeries, buildTechnical, technicalFor, technicalBatch,
} from "../src/index.js";

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; } else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}
const near = (a, b, eps = 0.011) => a != null && Math.abs(a - b) <= eps;
function mockKV() {
  const store = new Map();
  return {
    store,
    async get(key, type) { const v = store.get(key); if (v === undefined) return null; return type === "json" ? JSON.parse(v) : v; },
    async put(key, value) { store.set(key, value); },
  };
}

// ---- sma：末 period 個平均 ----
{
  chk("sma([1..5],3)=4", sma([1, 2, 3, 4, 5], 3) === 4, String(sma([1, 2, 3, 4, 5], 3)));
  chk("sma 不足回 null", sma([1, 2], 3) === null);
}

// ---- ema：線性序列 [1..10] period 5 → 末值=8（手算：種子SMA=3，k=1/3，遞迴至 8）----
{
  const e = ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
  chk("ema([1..10],5) 末值=8", near(e[e.length - 1], 8), String(e[e.length - 1]));
  chk("ema 種子=SMA(前5)=3", near(e[4], 3), String(e[4]));
  chk("ema 常數序列=常數", (() => { const c = ema([7, 7, 7, 7, 7, 7], 3); return near(c[c.length - 1], 7); })());
}

// ---- kd：手算固定序列（n=3, smooth=3, 初值50）→ K≈67.59, D≈60.19 ----
// H:[10,11,12,13,14] L:[8,9,10,11,12] C:[9,10,11,12,13]；三窗 RSV 皆=75；
// K:58.333→63.889→67.593；D:52.778→56.481→60.185（詳見任務驗算）
{
  const H = [10, 11, 12, 13, 14], L = [8, 9, 10, 11, 12], C = [9, 10, 11, 12, 13];
  const v = kd(H, L, C, 3, 3);
  chk("kd 末日 K≈67.59", near(v.k, 67.59, 0.02), String(v.k));
  chk("kd 末日 D≈60.19", near(v.d, 60.19, 0.02), String(v.d));
  chk("kd 常數序列→K=D=50", (() => { const c = kd([5, 5, 5, 5], [5, 5, 5, 5], [5, 5, 5, 5], 3, 3); return c.k === 50 && c.d === 50; })());
  chk("kd 不足 n 回 null", kd([1, 2], [1, 2], [1, 2], 3, 3) === null);
}

// ---- macd：常數序列全為 0（教科書：無趨勢 DIF=MACD=hist=0）；上升趨勢 DIF>0 ----
{
  const flat = Array(40).fill(10);
  const m0 = macd(flat);
  chk("macd 常數序列 dif=macd=hist=0", m0.dif === 0 && m0.macd === 0 && m0.hist === 0, JSON.stringify(m0));
  const up = Array.from({ length: 60 }, (_, i) => 10 + i);   // 單調上升
  const mu = macd(up);
  chk("macd 上升趨勢 DIF>0", mu.dif > 0, JSON.stringify(mu));
  chk("macd 不足回 null", macd(Array(20).fill(1)) === null);
}

// ---- rsi：全漲=100、全跌=0、交替 [10,11,10,11,10,11] period5 → 60（手算 RS=1.5）----
{
  chk("rsi 全漲=100", rsi([1, 2, 3, 4, 5, 6], 5) === 100, String(rsi([1, 2, 3, 4, 5, 6], 5)));
  chk("rsi 全跌=0", rsi([6, 5, 4, 3, 2, 1], 5) === 0, String(rsi([6, 5, 4, 3, 2, 1], 5)));
  chk("rsi 交替序列 period5=60", rsi([10, 11, 10, 11, 10, 11], 5) === 60, String(rsi([10, 11, 10, 11, 10, 11], 5)));
  chk("rsi 常數序列=50", rsi([5, 5, 5, 5, 5, 5], 5) === 50, String(rsi([5, 5, 5, 5, 5, 5], 5)));
  chk("rsi 不足回 null", rsi([1, 2, 3], 5) === null);
}

// ---- boll：末4 [2,4,6,8] period4 mult2 → mid=5, std=√5, %b≈0.84（手算）----
{
  const b = boll([2, 4, 6, 8], 4, 2);
  chk("boll mid=5", b.mid === 5, String(b.mid));
  chk("boll upper≈9.47", near(b.upper, 9.47, 0.01), String(b.upper));
  chk("boll lower≈0.53", near(b.lower, 0.53, 0.01), String(b.lower));
  chk("boll %b≈0.84", near(b.pb, 0.84, 0.01), String(b.pb));
  chk("boll 常數序列 %b=0.5", (() => { const c = boll([5, 5, 5, 5], 4, 2); return c.pb === 0.5; })());
}

// ---- volumeRatio：avg5/avg20 比；爆量需價漲 ----
{
  const vols = [...Array(15).fill(100), ...Array(5).fill(300)];   // 20 筆：avg20=(15*100+5*300)/20=150；avg5=300
  const closes = [...Array(19).fill(10), 11];                      // 末日收漲
  const vr = volumeRatio(vols, closes);
  chk("volumeRatio 比=300/150=2", vr.ratio === 2, String(vr.ratio));
  chk("volumeRatio 爆量（≥2且價漲）", vr.surge === true, JSON.stringify(vr));
  const flat = Array(20).fill(100);
  chk("volumeRatio 常數→比=1 不爆量", (() => { const v = volumeRatio(flat, Array(20).fill(10)); return v.ratio === 1 && !v.surge; })());
  chk("volumeRatio 量縮 shrink", (() => { const v = volumeRatio([...Array(15).fill(100), ...Array(5).fill(30)], Array(20).fill(10)); return v.shrink === true; })());
}

// ---- range52：全序列高低與距離% ----
{
  const H = [10, 12, 15, 11], L = [8, 9, 10, 9], C = [9, 11, 14, 12];
  const r = range52(H, L, C);   // HH=15, LL=8, close=12 → distHigh=(12-15)/15*100=-20；distLow=(12-8)/8*100=50
  chk("range52 high=15 low=8", r.high === 15 && r.low === 8, JSON.stringify(r));
  chk("range52 距高=-20%", r.distHigh === -20, String(r.distHigh));
  chk("range52 距低=50%", r.distLow === 50, String(r.distLow));
}

// ---- maArrange：多空排列中性描述 ----
{
  chk("maArrange 多頭排列", maArrange(10, 9, 8, 7) === "多頭排列");
  chk("maArrange 空頭排列", maArrange(7, 8, 9, 10) === "空頭排列");
  chk("maArrange 糾結", maArrange(9, 10, 8, 7) === "糾結");
  chk("maArrange 缺值→資料不足", maArrange(9, null, 8, 7) === "資料不足");
}

// ---- buildSeries：TaiwanStockPrice 列 → 升冪 OHLCV ----
{
  const rows = [
    { date: "2026-07-17", open: 1, max: 3, min: 0.5, close: 2, Trading_Volume: 100 },
    { date: "2026-07-15", open: 1, max: 2, min: 0.5, close: 1.5, Trading_Volume: 90 },
  ];
  const s = buildSeries(rows);
  chk("buildSeries 升冪排序", s[0].date === "2026-07-15" && s[1].date === "2026-07-17");
  chk("buildSeries 欄位對應 max→h/min→l", s[1].h === 3 && s[1].l === 0.5 && s[1].c === 2 && s[1].v === 100);
}

// ---- buildTechnical：整合 7 項＋中性 state、無買賣字眼、空序列回 {error} ----
{
  chk("buildTechnical 空序列→{error}", !!buildTechnical([]).error);
  // 造 70 筆單調上升序列：足夠 MA60/MACD/布林/52週
  const series = Array.from({ length: 70 }, (_, i) => ({ date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, o: 10 + i, h: 11 + i, l: 9 + i, c: 10 + i, v: 1000 + i }));
  const t = buildTechnical(series);
  chk("buildTechnical 7 項齊備", !!(t.ma && t.kd && t.macd && t.rsi && t.boll && t.volume && t.range52), Object.keys(t).join(","));
  chk("buildTechnical 上升→多頭排列", t.ma.arrange === "多頭排列", t.ma.arrange);
  chk("buildTechnical MA20=近20收盤均", near(t.ma.ma20, (() => { const c = series.map((x) => x.c).slice(-20); return c.reduce((a, b) => a + b, 0) / 20; })(), 0.011), String(t.ma.ma20));
  chk("buildTechnical price=末日收盤", t.price === 79, String(t.price));
  // 誠實原則：state 為中性數學描述。超買/超賣 為教科書中性詞（規格 line 8 明列許可），先剔除，
  // 其餘不得含買賣「行動」字眼（該買/該賣/買進/賣出/進場/出場/建議/訊號）。
  const states = [t.ma.arrange, t.kd.state, t.macd.state, t.rsi.state, t.boll.state, t.volume.state].join(" ");
  const actionable = states.replace(/超買|超賣/g, "");
  chk("誠實原則：state 無買賣/行動字眼（超買/超賣除外）", !/該買|該賣|買進|賣出|建議|訊號|進場|出場|[買賣]/.test(actionable), actionable);
}

// ---- technicalFor：KV 命中不重抓 ----
{
  const env = { FLOW_KV: mockKV(), FINMIND_TOKEN: "x" };
  await env.FLOW_KV.put("tech:2330:2026-07-19", JSON.stringify({ id: "2330", cached: true }));
  const throwFetch = async () => { throw new Error("不應被呼叫"); };
  const out = await technicalFor(env, "2330", "2026-07-19", throwFetch);
  chk("KV 命中直接回快取、不打 FinMind", out.cached === true);
}

// ---- technicalFor：miss 打 FinMind、寫入快取 ----
{
  const env = { FLOW_KV: mockKV(), FINMIND_TOKEN: "x" };
  const priceRows = Array.from({ length: 70 }, (_, i) => ({ date: `2026-05-${String((i % 28) + 1).padStart(2, "0")}`, open: 100 + i, max: 101 + i, min: 99 + i, close: 100 + i, Trading_Volume: 5000 + i }));
  let calls = 0;
  const mockFetch = async (u) => { calls++; const ds = decodeURIComponent(u).match(/dataset=([A-Za-z]+)/)[1]; return { ok: true, json: async () => ({ status: 200, data: ds === "TaiwanStockPrice" ? priceRows : [] }) }; };
  const out = await technicalFor(env, "2330", "2026-07-19", mockFetch);
  chk("miss 後回 7 項", !!(out.ma && out.kd && out.macd && out.rsi && out.boll && out.volume && out.range52), Object.keys(out).join(","));
  chk("miss 後寫入 KV 快取", env.FLOW_KV.store.has("tech:2330:2026-07-19"));
  chk("miss 只打一次 FinMind（單 dataset）", calls === 1, String(calls));
}

// ---- technicalBatch：某股 FinMind 失敗／查無回 {error} 不整批倒 ----
{
  const env = { FLOW_KV: mockKV(), FINMIND_TOKEN: "x" };
  const good = Array.from({ length: 30 }, (_, i) => ({ date: `2026-06-${String((i % 28) + 1).padStart(2, "0")}`, open: 50, max: 51, min: 49, close: 50 + (i % 3), Trading_Volume: 800 }));
  const mockFetch = async (u) => {
    if (u.includes("data_id=9999")) throw new Error("boom");
    if (u.includes("data_id=8888")) return { ok: true, json: async () => ({ status: 200, data: [] }) };
    return { ok: true, json: async () => ({ status: 200, data: good }) };
  };
  const batch = await technicalBatch(env, ["2330", "9999", "8888"], "2026-07-19", mockFetch);
  const ok = batch.find((x) => x.id === "2330"), bad = batch.find((x) => x.id === "9999"), empty = batch.find((x) => x.id === "8888");
  chk("批次好股正常回資料", ok && ok.ma && !ok.error);
  chk("批次全失敗股回 {id,error}", bad && bad.error && bad.id === "9999", JSON.stringify(bad));
  chk("批次查無資料股回 {id,error}", empty && empty.error && empty.id === "8888", JSON.stringify(empty));
  chk("批次長度=3（不因單股失敗而少）", batch.length === 3);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} 通過 / ${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
