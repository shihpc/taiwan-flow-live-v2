// 即時一覽 tab 第二期：分鐘序列（series:<date> rolling key）離線單元測試（無需 token，mock KV）
// 執行：cd worker && node test/series.mjs
import { appendSeries, seriesTail, mergeSeriesPoint, timeoutSignal,
  FIN_FETCH_TIMEOUT_MS } from "../src/index.js";

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

// ---- appendSeries：同一分鐘重跑（cron 補跑/收盤後重算）→ 覆寫，不重複 append ----
// 註：兩次 amt 相同（1000/2000 皆 r1→0.0）＝去重策略的「平手」情形 → 沿用舊版「後寫入者勝」。
{
  const env = { FLOW_KV: mockKV() };
  const d = "2026-07-20";
  await appendSeries(env, d, "09:00", 1000, { close: 100, change_price: 1 });
  await appendSeries(env, d, "09:00", 2000, { close: 101, change_price: 2 });   // 同分鐘重跑
  const arr = await env.FLOW_KV.get(`series:${d}`, "json");
  chk("同分鐘冪等：長度仍為1", arr.length === 1, String(arr.length));
  chk("同分鐘冪等：amt 平手時值取最新一次", arr[0].idx === 101, String(arr[0].idx));
}

// ================= 2026-08-09 修正 A：亂序與重複點 =================
// 背景：CF KV 無 CAS，單一 key series:<date> 的 get-modify-put 每分鐘互相覆蓋；hm 取自
// event.scheduledTime 而非實際執行時刻，慢班會用自己的舊標籤在較晚的牆鐘寫入。舊版冪等只比對
// arr[arr.length-1].t，亂序寫入不會被去重、而是 push 成重複點（2026-07-30 實證 11:41 在 11:40 前）。
const strictlyIncreasing = (arr) => arr.every((p, i) => i === 0 || arr[i - 1].t < p.t);
const dupTs = (arr) => arr.length - new Set(arr.map((p) => p.t)).size;

// ---- 亂序寫入：先 append 11:41 再 append 11:40 → 最終陣列必須按 t 嚴格遞增且無重複 ----
{
  const env = { FLOW_KV: mockKV() };
  const d = "2026-07-30";
  await appendSeries(env, d, "11:38", 2.50e12, { close: 40270.1, change_price: 230.9 });
  await appendSeries(env, d, "11:41", 2.53916e12, { close: 40280.45, change_price: 241.27 });   // 快班先到
  await appendSeries(env, d, "11:40", 2.53000e12, { close: 40279.0, change_price: 239.8 });     // 慢班後到
  const arr = await env.FLOW_KV.get(`series:${d}`, "json");
  chk("亂序寫入 → 長度 3（沒有多長出重複點）", arr.length === 3, String(arr.length));
  chk("亂序寫入 → 按 t 嚴格遞增", strictlyIncreasing(arr), JSON.stringify(arr.map((p) => p.t)));
  chk("亂序寫入 → 無重複 t", dupTs(arr) === 0, JSON.stringify(arr.map((p) => p.t)));
  chk("亂序寫入 → 末筆是當日最新分鐘（seriesTail 取得到）",
    seriesTail(arr, 1)[0].t === "11:41", JSON.stringify(seriesTail(arr, 1)));
  chk("亂序寫入 → 各筆內容沒被搞混（11:40 仍是自己的 idx）",
    arr[1].t === "11:40" && arr[1].idx === 40279.0, JSON.stringify(arr[1]));
  // 註：這是本組 fixture 內的性質（三筆皆為盤中正常累計值），不是「amt 全日必單調不減」的斷言
  // ——實測 0.64% 的相鄰對會遞減，見 src/index.js pickSeriesDup 上方註解的 ⚠️ 段。
  chk("亂序寫入 → 本組 amt 隨 t 單調不減（相鄰差分不再算出負值）",
    arr.every((p, i) => i === 0 || arr[i - 1].amt <= p.amt), JSON.stringify(arr.map((p) => p.amt)));
}

// ---- 同 t 重複：保留 amt 較小者（＝擷取牆鐘較早＝離標籤分鐘較近）----
// cron 只會準時或遲到、不會提早，故同標籤兩筆快照中 amt 較小的那筆才是 t 這一分鐘該有的值；
// 若讓後寫入者（遲到班）勝，會把 11:43 的累計額寫進 11:40，造成 amt(11:40) > amt(11:41)。
// 註：此理由**不預設** amt 全日單調不減（該敘述已被實測推翻）——它只需要「同一標籤的兩筆中，
// 擷取較晚者累計額不會比較早者少」，而盤中相鄰分鐘的遞減案例全部來自盤前殘留快照（見下方
// 「純 min-amt」組的三個真實案例），min-amt 在那些案例上同樣選對。
{
  const env = { FLOW_KV: mockKV() };
  const d = "2026-07-30";
  await appendSeries(env, d, "11:41", 2.60e12, { close: 40290, change_price: 250 });
  await appendSeries(env, d, "11:40", 2.50e12, { close: 40270, change_price: 230 });   // 亂序補上 11:40
  await appendSeries(env, d, "11:40", 2.62e12, { close: 40295, change_price: 255 });   // 遲到班：同 t、amt 更大
  const arr = await env.FLOW_KV.get(`series:${d}`, "json");
  chk("同 t 重複 → 長度仍為 2", arr.length === 2, JSON.stringify(arr.map((p) => p.t)));
  chk("同 t 重複 → 保留 amt 較小（較早擷取）那筆", arr[0].t === "11:40" && arr[0].idx === 40270,
    JSON.stringify(arr[0]));
  chk("同 t 重複 → 仍嚴格遞增且 amt 不倒退", strictlyIncreasing(arr) && arr[0].amt < arr[1].amt,
    JSON.stringify(arr));
}

// ---- 舊資料自癒：KV 內既有的亂序／重複（舊版程式留下）在下一次 append 就被清乾淨 ----
{
  const env = { FLOW_KV: mockKV() };
  const d = "2026-07-30";
  // 模擬 07-30 現場：11:41 排在 11:40 前，且 11:40 被重複寫過一次
  await env.FLOW_KV.put(`series:${d}`, JSON.stringify([
    { t: "11:38", amt: 250.0, idx: 40270.1, chg: 230.9 },
    { t: "11:41", amt: 253.9, idx: 40280.45, chg: 241.27 },
    { t: "11:40", amt: 253.9, idx: 40280.45, chg: 241.27 },
    { t: "11:40", amt: 260.0, idx: 40285.0, chg: 245.0 },
  ]));
  await appendSeries(env, d, "11:42", 2.70e12, { close: 40300, change_price: 260 });
  const arr = await env.FLOW_KV.get(`series:${d}`, "json");
  chk("自癒 → 去重後長度 4", arr.length === 4, JSON.stringify(arr.map((p) => p.t)));
  chk("自癒 → 嚴格遞增無重複", strictlyIncreasing(arr) && dupTs(arr) === 0, JSON.stringify(arr.map((p) => p.t)));
  chk("自癒 → 重複的 11:40 保留 amt 較小那筆", arr[1].t === "11:40" && arr[1].amt === 253.9,
    JSON.stringify(arr[1]));
}

// ---- 純 min-amt（2026-08-09 獨立複核後：移除 0.5 合理性下限 SERIES_TRUNC_RATIO）----
// 被推翻的設計：舊版加了「較小者需達較大者的 0.5 倍才偏好較小者，否則視為截斷快照取較大者」。
// 推翻依據（皆 13 個交易日 data/intraday/ 實測）：
//   ① 下限要防的「FinMind 回不完整清單」在 13 天內**零觀測**（nstk 波動 ≤0.071%）；
//   ② 下限要付的代價卻在 3/13 個交易日（23%）**確定性地選錯**——開盤前 FinMind 回前一交易日的
//      收盤殘留值，amt 比開盤後的真值大一個量級（比值 0.105/0.124/0.315），下限會把殘留值留下；
//   ③ 舊註解「amt 盤中單調不減」只是近似：3,574 組相鄰對有 23 組（0.64%）遞減。
//   ④ 舊註解引的「實測下界 0.618」是靜默排除 t=09:00 後的產物，真值 k=3 分為 **0.600**、
//      k=5 分 0.518、k=6 分 **0.473 已跌破 0.5 門檻**——下限本身就站不住。
// 也未改用 FinMind 時戳 ts 去重，否決理由見 src/index.js pickSeriesDup 上方註解（❌ 段）。
{
  const P = (t, amt, id) => ({ t, amt, idx: null, chg: null, id });
  const both = (t, x, y) => {   // 兩種寫入順序都跑，回傳 [先X後Y 的贏家, 先Y後X 的贏家]
    const f = mergeSeriesPoint([P(t, x.amt, x.id)], P(t, y.amt, y.id));
    const r = mergeSeriesPoint([P(t, y.amt, y.id)], P(t, x.amt, x.id));
    return [f, r];
  };

  // (a) 三個真實開盤異常案例（複核者實測；值直接取自 data/intraday/*.json 的 series）。
  //     情境：同一個標籤 t 被寫兩次，一筆拿到盤前殘留快照（amt 為前一交易日收盤累計額量級），
  //     一筆拿到開盤後的真值。正解＝留下開盤後的真值（較小者）。
  //     舊版 0.5 下限在這三例會全部選成殘留值（比值 0.105/0.124/0.315 皆 < 0.5）。
  const openCases = [
    ["2026-08-03", "09:00", 25871.6, 2710, 0.105],
    ["2026-08-04", "09:00", 27286.8, 3391.4, 0.124],
    ["2026-07-29", "09:03", 10439.3, 3285, 0.315],
  ];
  for (const [date, t, residual, real, ratio] of openCases) {
    const [f, r] = both(t, { amt: residual, id: "盤前殘留" }, { amt: real, id: "開盤真值" });
    chk(`開盤異常 ${date} ${t}（比值 ${ratio}）→ 取開盤真值、丟掉盤前殘留`,
      f.length === 1 && f[0].id === "開盤真值" && f[0].amt === real, JSON.stringify(f));
    chk(`開盤異常 ${date} ${t} → 殘留值先寫或後寫結果相同（與順序無關）`,
      r.length === 1 && r[0].id === "開盤真值", JSON.stringify(r));
  }

  // (b) 一般遲到：amt 小幅偏高的那筆是遲到班 → 取較小者（min-amt 的主戰場，行為不變）
  const normal = mergeSeriesPoint([P("11:40", 25000, "早")], P("11:40", 26200, "遲")); // 比值 0.954
  chk("一般遲到（0.954）→ 取較小者", normal.length === 1 && normal[0].id === "早", JSON.stringify(normal));

  // (c) 防迴歸：0.5 下限確實不存在了——舊門檻兩側的四個比值一律取較小者，不再有翻轉點
  for (const [small, big, tag] of [[5000, 10000, "=0.5"], [4999, 10000, "0.4999"],
    [2500, 25000, "0.1"], [473, 1000, "0.473（k=6 分實測下界）"]]) {
    const [f, r] = both("11:40", { amt: small, id: "小" }, { amt: big, id: "大" });
    chk(`無下限：比值 ${tag} → 仍取較小者（兩種寫入順序皆是）`,
      f[0].id === "小" && r[0].id === "小", `${JSON.stringify(f[0])} / ${JSON.stringify(r[0])}`);
  }
  const src0 = await (await import("node:fs/promises")).readFile(
    new URL("../src/index.js", import.meta.url), "utf-8");
  chk("防迴歸：原始碼已無 SERIES_TRUNC_RATIO", !src0.includes("SERIES_TRUNC_RATIO"));

  // (d) 可交換性（移除下限後重新測量）：min-amt 是 min 歸約，n 筆皆有限且兩兩相異時，
  //     **窮舉全部寫入排列必須收斂到同一筆**。帶 0.5 下限的舊版在 n=3 有 12.46%、n=4 有 27.79%
  //     的組合會發散（下限是成對比較、不滿足結合律），故本組是新策略獨有的性質。
  const perm = (a) => (a.length <= 1 ? [a]
    : a.flatMap((x, i) => perm([...a.slice(0, i), ...a.slice(i + 1)]).map((rest) => [x, ...rest])));
  for (const n of [2, 3, 4]) {
    let diverged = 0, tried = 0;
    for (let k = 0; k < 3000; k++) {
      const v = Array.from({ length: n }, () => Math.round(Math.random() * 30000) + 1);
      if (new Set(v).size !== n) continue;
      tried++;
      const winners = new Set(perm(v.map((x, i) => P("09:00", x, `P${i}`)))
        .map((order) => order.reduce((acc, p) => mergeSeriesPoint(acc, p), [])[0].id));
      if (winners.size > 1) diverged++;
    }
    chk(`可交換性 n=${n}：皆有限且兩兩相異 → 窮舉 ${n}! 種寫入順序零發散（${tried} 組）`,
      diverged === 0 && tried > 100, `發散 ${diverged}/${tried}`);
  }
  // (d2) 順序相依性只剩「平手」與「不可比」兩個分支——這兩者按定義依賴寫入順序
  const tie = mergeSeriesPoint([P("09:00", 100, "先")], P("09:00", 100, "後"));
  chk("平手 → 後寫入者勝（沿用舊版同分鐘重跑冪等）", tie[0].id === "後", JSON.stringify(tie));

  // (e) 「有效」界線（B5，2026-09-12 修）：有效＝有限且 > 0。
  //     null/""/0 都是**有限的 0**，舊版走正常比較並以最小值勝出＝壞點鎖住該分鐘；
  //     現在一律視為無效，**有效值恆勝**（不分先後），故好點留下。
  for (const [bad, tag] of [[null, "null"], ["", "空字串"], [0, "0"], [-1, "負值"]]) {
    const got = mergeSeriesPoint([P("09:00", 12345, "好點")], P("09:00", bad, "壞點"));
    chk(`amt=${tag}（後寫）→ 無效，有效的好點恆勝`,
      got.length === 1 && got[0].id === "好點", JSON.stringify(got));
    const rev = mergeSeriesPoint([P("09:00", bad, "壞點")], P("09:00", 12345, "好點"));
    chk(`amt=${tag}（先寫）→ 無效，有效的好點恆勝（與寫入順序無關）`,
      rev.length === 1 && rev[0].id === "好點", JSON.stringify(rev));
  }
  // (e2) 兩者皆無效 → 沿用舊版冪等：後寫者勝
  const bothBad = mergeSeriesPoint([P("09:00", 0, "先壞")], P("09:00", null, "後壞"));
  chk("兩者皆無效 → 後寫者勝（沿用同分鐘重跑冪等）", bothBad[0].id === "後壞", JSON.stringify(bothBad));
  // (e3) B5 的核心：含無效值時，六種寫入順序必須收斂到同一個贏家
  //      （若寫成「無效→不可比→後寫者勝」，{50,100,0} 會收斂到 0，可交換性就破了）
  {
    const vals = [[50, "A"], [100, "B"], [0, "壞"]];
    const perm3 = (a) => (a.length <= 1 ? [a]
      : a.flatMap((x, i) => perm3([...a.slice(0, i), ...a.slice(i + 1)]).map((r) => [x, ...r])));
    const winners = new Set(perm3(vals.map(([v, id]) => P("09:00", v, id)))
      .map((order) => order.reduce((acc, q) => mergeSeriesPoint(acc, q), [])[0].id));
    chk("含無效值 {50,100,0}：窮舉 3! 種寫入順序皆收斂到最小的有效值 A",
      winners.size === 1 && winners.has("A"), [...winners].join("/"));
  }
  // 非數值字串 → NaN → 同樣不算有效。B5 之前它走「不可比 → 後寫者勝」＝壞點覆蓋好點，
  // 現在由「有效恆勝」一併關掉（原註解列為已知曝險的第一條）。
  const nan = mergeSeriesPoint([P("09:00", 12345, "好點")], { t: "09:00", amt: "abc", id: "NaN點" });
  chk("amt 為非數值字串 → NaN → 無效，有效的好點恆勝（B5 前是壞點勝）",
    nan[0].id === "好點", JSON.stringify(nan));
  const nanFirst = mergeSeriesPoint([{ t: "09:00", amt: "abc", id: "NaN點" }], P("09:00", 12345, "好點"));
  chk("非數值字串先寫 → 有效的好點仍勝（與寫入順序無關）",
    nanFirst[0].id === "好點", JSON.stringify(nanFirst));
}

// ---- mergeSeriesPoint 純函式邊界 ----
{
  const P = (t, amt) => ({ t, amt, idx: null, chg: null });
  chk("空陣列 → 只有新點", mergeSeriesPoint([], P("09:00", 1)).length === 1);
  chk("null/undefined 舊值不炸", mergeSeriesPoint(null, P("09:00", 1)).length === 1
    && mergeSeriesPoint(undefined, P("09:00", 1)).length === 1);
  chk("非陣列舊值（KV 壞資料）不炸", mergeSeriesPoint({ bad: 1 }, P("09:00", 1)).length === 1);
  chk("壞點（無 t／非字串）被濾掉",
    mergeSeriesPoint([{ amt: 1 }, { t: 42 }, null, P("09:01", 2)], P("09:00", 1)).length === 2);
  // 「不可比」＝amt 這個 key 根本不存在（undefined → NaN）；amt 為 null/""/0 不算不可比，見上組 (e)
  const noAmt = mergeSeriesPoint([{ t: "09:00", idx: 1 }], { t: "09:00", idx: 2 });
  chk("amt 鍵不存在（undefined）→ 真正不可比 → 後寫入者勝",
    noAmt.length === 1 && noAmt[0].idx === 2, JSON.stringify(noAmt));
  const big = Array.from({ length: 276 }, (_, i) =>
    P(`${String(9 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`, i));
  const shuffled = [...big].reverse();
  const merged = mergeSeriesPoint(shuffled, P("13:36", 999));   // big 末筆是 13:35
  chk("整份倒序輸入 → 排序回正確順序", strictlyIncreasing(merged) && merged.length === 277,
    String(merged.length));
}

// ---- finSnapshot fetch timeout（次要項）----
{
  chk("FIN_FETCH_TIMEOUT_MS = 20 秒", FIN_FETCH_TIMEOUT_MS === 20000, String(FIN_FETCH_TIMEOUT_MS));
  const sig = timeoutSignal(50);
  chk("timeoutSignal 回 AbortSignal", sig && typeof sig.aborted === "boolean", String(sig));
  chk("timeoutSignal 初始未 abort", sig.aborted === false);
  await new Promise((r) => setTimeout(r, 90));
  chk("timeoutSignal 逾時後 aborted", sig.aborted === true);
  const src = await (await import("node:fs/promises")).readFile(
    new URL("../src/index.js", import.meta.url), "utf-8");
  chk("finSnapshot 的 fetch 有帶 signal",
    /FIN_SNAP\}\?token=\$\{encodeURIComponent\(token\)\}`, \{ signal: timeoutSignal\(\) \}\)/.test(src));
  chk("storeFrame 失敗重試路徑仍在（snap 失敗 → sleep 後再試一次）",
    /catch \(e\) \{[\s\S]{0,200}await sleep\(opts\.retryMs != null \? opts\.retryMs : 1500\);\s*rows = await snap\(\);/.test(src));
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
