// taiwan-flow-live-v2 — Cloudflare Worker
// 即時全市場快照 + 分類聚合 + 指數貢獻點 → /live（等同 V1 src/snapshot.py 的 build_live 輸出）
//
// 分工：Worker 只做「熱路徑」——抓 tick_snapshot 即時聚合。
//   classify.json（分類表）與 lastweek.json（上週欄位）當靜態檔從 DATA_BASE 抓、快取一天/時。
//   FINMIND token 藏在 secret，前端不碰。
//
// 端點：
//   GET /live   → 即時聚合 JSON（結果快取 LIVE_TTL 秒，保護 FinMind 額度）
//   GET /       → 健康檢查 / 說明
//
// 部署：cd worker && npx wrangler secret put FINMIND_TOKEN && npx wrangler deploy

const FIN_BASE = "https://api.finmindtrade.com/api/v4/data";
const FIN_SNAP = "https://api.finmindtrade.com/api/v4/taiwan_stock_tick_snapshot";
const MKT = { twse: "tse", tpex: "otc" };          // classify.t → 市場 key
const LW_KEY = { tse: "twse", otc: "tpex" };       // 市場 key → lastweek.tot 鍵

const num = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v));
const orNull = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const r2 = (v) => Math.round(v * 100) / 100;
const r1 = (v) => Math.round(v * 10) / 10;
const r3 = (v) => Math.round(v * 1000) / 1000;

// ---- FinMind ----
// fetch 逾時（2026-08-09）：frame 班每分鐘一趟，上游一慢就可能讓單班跨越 60 秒與下一班重疊
// ——那正是 appendSeries 亂序／重複的放大器（storeFrame 另有失敗後 sleep 1500ms 重試一次，
// 最壞 20 + 1.5 + 20 ≈ 41.5 秒，仍在一分鐘內收斂）。
// AbortSignal.timeout 在 workerd 與 Node 18+ 都有；不存在時退 AbortController + setTimeout，
// 兩者都沒有（極舊 runtime）則回 undefined＝沿用舊行為（不逾時），絕不因此讓抓取整個失敗。
export const FIN_FETCH_TIMEOUT_MS = 20000;
export function timeoutSignal(ms = FIN_FETCH_TIMEOUT_MS) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  if (typeof AbortController === "undefined") return undefined;
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error(`fetch timeout ${ms}ms`)), ms);
  return ac.signal;
}
async function finSnapshot(token) {
  const r = await fetch(`${FIN_SNAP}?token=${encodeURIComponent(token)}`, { signal: timeoutSignal() });
  if (!r.ok) throw new Error(`snapshot HTTP ${r.status}`);
  const j = await r.json();
  if (j.status !== 200) throw new Error(`snapshot: ${j.msg}`);
  return j.data || [];
}
async function finPriceLimit(token, date) {
  // 當日漲跌停價，依 date 快取一小時（同一天不重抓）
  const u = `${FIN_BASE}?dataset=TaiwanStockPriceLimit&start_date=${date}&end_date=${date}&token=${encodeURIComponent(token)}`;
  const r = await fetch(u, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!r.ok) return {};
  const j = await r.json();
  const out = {};
  for (const row of j.data || []) out[String(row.stock_id)] = [num(row.limit_up), num(row.limit_down)];
  return out;
}
async function fetchJSON(url, ttl) {
  const r = await fetch(url, { cf: { cacheTtl: ttl, cacheEverything: true } });
  if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
  return r.json();
}
// 台指期正逆價差 + VIX恐慌指數：近月合約(依當日累計量挑主力月)最新一筆 tick 價 vs 加權現貨；
// TaiwanOptionVix 當日最新一筆。兩者皆為當日快照，快取15秒跟 /live 節奏一致。
async function finFuturesVix(token, date) {
  // VIX 開盤前/資料未settle時當日可能查無資料，回看3天保底取最新一筆（資料量小，成本低）；
  // 期貨tick當日量已足夠判斷主力月，不額外擴大範圍（避免大量資料拖慢/live）。
  const prevDate = new Date(`${date}T00:00:00Z`);
  prevDate.setUTCDate(prevDate.getUTCDate() - 3);
  const vixStart = prevDate.toISOString().slice(0, 10);
  const [futJ, vixJ] = await Promise.all([
    fetch(`${FIN_BASE}?dataset=TaiwanFuturesTick&data_id=TX&start_date=${date}&token=${encodeURIComponent(token)}`,
      { cf: { cacheTtl: 15, cacheEverything: true } }).then((r) => (r.ok ? r.json() : { data: [] })),
    fetch(`${FIN_BASE}?dataset=TaiwanOptionVix&start_date=${vixStart}&end_date=${date}&token=${encodeURIComponent(token)}`,
      { cf: { cacheTtl: 15, cacheEverything: true } }).then((r) => (r.ok ? r.json() : { data: [] })),
  ]);
  const futRows = (futJ.data || []).filter((r) => !String(r.contract_date || "").includes("/"));
  let contract = null, price = null;
  if (futRows.length) {
    const vol = {};
    for (const r of futRows) vol[r.contract_date] = (vol[r.contract_date] || 0) + num(r.volume);
    contract = Object.entries(vol).sort((a, b) => b[1] - a[1])[0][0];
    const frontRows = futRows.filter((r) => r.contract_date === contract);
    price = num(frontRows[frontRows.length - 1].price);
  }
  const vixRows = (vixJ.data || []).slice().sort((a, b) =>
    `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  const vix = vixRows.length ? num(vixRows[vixRows.length - 1].vix) : null;
  return { price, contract, vix };
}

// ---- 聚合（對應 snapshot.py）----
const zero = () => ({ amt: 0, lw: 0, wchg: 0, up: 0, down: 0, flat: 0, n: 0, pts: 0 });
function acc(d, key, m, amt, lw, chg, pts) {
  let o = d[key];
  if (!o) o = d[key] = { sector: key, tse: zero(), otc: zero() };
  const b = o[m];
  b.amt += amt; b.lw += lw; b.wchg += chg * amt; b.n += 1; b.pts += pts;
  if (chg > 0) b.up += 1; else if (chg < 0) b.down += 1; else b.flat += 1;
}
const one = (b) => ({
  amt_yi: r2(b.amt / 1e8), lw_amt_yi: r2(b.lw / 1e8),
  avg_chg: b.amt ? r2(b.wchg / b.amt) : 0,
  up: b.up, down: b.down, flat: b.flat, n: b.n, pts: r2(b.pts),
});
const finalize = (d) => Object.values(d).map((o) => ({ sector: o.sector, tse: one(o.tse), otc: one(o.otc) }));
const idxOut = (r) => {
  r = r || {};
  return { val: orNull(r.close), chgP: orNull(r.change_price), chg: orNull(r.change_rate),
    vol: orNull(r.total_volume), amt_yi: r1(num(r.total_amount) / 1e8) };
};

async function buildLive(env) {
  const token = env.FINMIND_TOKEN;
  if (!token) throw new Error("缺少 FINMIND_TOKEN（wrangler secret put FINMIND_TOKEN）");
  const base = env.DATA_BASE;

  const [classifyJson, rows] = await Promise.all([
    fetchJSON(`${base}/classify.json`, 86400),   // 分類表：快取一天
    finSnapshot(token),                           // 即時快照：每次都抓
  ]);
  const cl = classifyJson.map;

  // 先取當日日期抓漲跌停價，再併同上週欄位一起餵進純聚合
  let d = "";
  for (const r of rows) { const c = String(r.stock_id || ""); if (c && c !== "001" && c !== "101" && cl[c]) { d = String(r.date || "").slice(0, 10); break; } }
  const [limits, lw] = await Promise.all([
    finPriceLimit(token, d),
    fetchJSON(`${base}/lastweek.json`, 3600),     // 上週欄位：快取一小時
  ]);
  const live = aggregate(cl, rows, limits, lw);

  // 台指期正逆價差 + VIX（失敗不影響 /live 主體）
  try {
    const { price, contract, vix } = await finFuturesVix(token, d);
    const spot = live.index.tse.val;
    live.futures = (price != null && spot != null)
      ? { price, contract, basis: r1(price - spot) } : null;
    live.vix = vix;
  } catch (e) {
    live.futures = null;
    live.vix = null;
  }

  // P3：資金湧入（frames + baseline；任何失敗不影響 /live 主體）
  try {
    const baseline = await fetchJSON(`${base}/baseline.json`, 3600);
    const ts = String(live.ts || "");
    const frames = env.FLOW_KV
      ? await pickFrames(env, ts.slice(0, 10), hm2min(ts.slice(11, 16)), [10, 30])
      : {};
    const items = Object.entries(live.stocks).map(([code, a]) => ({ code, amt: a[1], close: a[2] }));
    const { flow, per } = computeFlow(cl, items, baseline, frames, ts);
    const blst = baseline.stocks || {};
    for (const code in live.stocks) {
      const s = per[code] || [null, null, null, null, null];
      const b = blst[code] || [0, 0, 0, 0, 0, 0, 0];
      live.stocks[code].push(s[0], s[1], s[2], s[3], b[1], b[2], b[3] || 0, b[4] || 0, b[5] || 0, b[6] || 0, s[4]);
    }
    // f30＝個股原始30分Δ成交額（同 f10 無 5 日基準正規化，純即時，追加於尾端不動既有欄序）：
    // 即時一覽 tab 用來算次產業「近30分佔比」= 次產業 f30 加總 ÷ flow.mkt.d30_yi（c30 無法拿來反推，
    // 因它已除以基準佔比且基準本身不外送前端）。
    live.stock_cols = [...live.stock_cols, "f10", "c10", "c30", "r10", "it", "fi", "y1", "y2", "ints", "nl", "f30"];
    live.flow = flow;
  } catch (e) {
    live.flow = null;
    live.flow_err = String(e && e.message || e);
  }

  // 案三（2026-07-19）：flow 為 null（盤前/盤外/週末/異常）時多 1 次 get 附最後收盤定格
  // flow_last（additive 頂層欄位；flow 可用時不附、不多讀）。既有欄位零改動。
  await attachFlowLast(env, live);

  // 分鐘動能序列（即時一覽 tab 第二期 sparkline）：1 次 get，附近 60 分；失敗不影響 /live 主體
  try {
    const ts = String(live.ts || "");
    const sd = ts.slice(0, 10);
    const arr = env.FLOW_KV && sd ? await env.FLOW_KV.get(`series:${sd}`, "json") : null;
    live.series = seriesTail(arr);
  } catch (e) {
    live.series = [];
  }
  return live;
}

// 純聚合（無 I/O，可離線測試）：對應 snapshot.py 的 build_live 主體
export function aggregate(cl, rows, limits, lw) {
  let ts = null;
  const idxrow = {};
  const items = [];
  const sumMc = { twse: 0, tpex: 0 };
  for (const r of rows) {
    const code = String(r.stock_id || "");
    if (!code) continue;
    if (code === "001" || code === "101") { idxrow[code] = r; continue; }
    const info = cl[code];
    if (!info) continue;
    const amt = num(r.total_amount);
    const chg = num(r.change_rate);
    const dp = num(r.change_price);
    const bv = num(r.buy_volume);
    const sv = num(r.sell_volume);
    // 取全體有分類個股的最新成交時戳（date 為 YYYY-MM-DD HH:MM:SS.ffffff 定寬字串，
    // 字典序即時序），避免舊制「第一檔 date」被單一冷門股（如 6680）最後成交時刻定格。
    if (r.date && (!ts || r.date > ts)) ts = r.date;
    const sh = num(info.sh);
    const mkt = info.t || "";
    const etf = code.startsWith("00");
    items.push({ code, info, amt, chg, bv, sv, dp, sh, etf, mkt, close: orNull(r.close), vol: orNull(r.total_volume) });
    if (sh && !etf && mkt in sumMc) sumMc[mkt] += dp * sh;
  }

  const dI = { twse: num((idxrow["001"] || {}).change_price), tpex: num((idxrow["101"] || {}).change_price) };
  const lwmap = (lw && lw.stocks) || {}, lwtot = (lw && lw.tot) || {};

  const stocks = {}, ex = {}, ch = {};
  const mk = { tse: mkZero(), otc: mkZero() };
  for (const it of items) {
    const { code, info, amt, chg, bv, sv, dp, sh, etf, mkt, close, vol } = it;
    let pts = 0;
    if (sh && !etf && mkt in sumMc && sumMc[mkt]) pts = (dI[mkt] * (dp * sh)) / sumMc[mkt];
    const lwa = num(lwmap[code]);
    const [lu, ld] = limits[code] || [0, 0];
    const lim = close !== null && lu && close >= lu - 1e-6 ? 1
      : close !== null && ld && close <= ld + 1e-6 ? -1 : 0;
    stocks[code] = [r2(chg), Math.round(amt), close, vol, Math.round(bv), Math.round(sv), r3(pts), r2(dp), lim, Math.round(lwa)];
    const m = MKT[mkt];
    if (!m) continue;                              // 興櫃等無市場別 → 不計入分市場統計
    const b = mk[m];
    b.amt += amt; b.n += 1;
    if (chg > 0) b.up += 1; else if (chg < 0) b.down += 1; else b.flat += 1;
    if (lim === 1) b.ul += 1; else if (lim === -1) b.dl += 1;
    acc(ex, info.e, m, amt, lwa, chg, pts);
    for (const nd of info.c) acc(ch, nd, m, amt, lwa, chg, pts);
  }

  let cov = 0;
  for (const code in stocks) if (cl[code] && cl[code].c && cl[code].c.length) cov += 1;
  const market = {};
  for (const k of ["tse", "otc"]) {
    const v = mk[k];
    market[k] = { amt_yi: r1(v.amt / 1e8), lw_amt_yi: r1(num(lwtot[LW_KEY[k]]) / 1e8),
      up: v.up, down: v.down, flat: v.flat, n: v.n, up_lim: v.ul, down_lim: v.dl };
  }
  return {
    ts, generated_at: new Date().toISOString(),
    stock_cols: ["chg", "amt", "close", "vol", "bv", "sv", "pts", "dp", "lim", "lw"],
    index: { tse: idxOut(idxrow["001"]), otc: idxOut(idxrow["101"]) },
    market, exchange: finalize(ex), chain: finalize(ch),
    chain_coverage: { with_chain: cov, total: Object.keys(stocks).length },
    stocks,
  };
}
const mkZero = () => ({ amt: 0, up: 0, down: 0, flat: 0, n: 0, ul: 0, dl: 0 });

// ---- 盤中分鐘 frame（Cron 每分鐘寫入 KV，資金湧入的時間序列）----
// key = f:<台北日期>:<HH:MM>——2026-07-18 起取「喚醒時間」event.scheduledTime 的台北牆鐘。
//   舊制取 FinMind 快照自身時戳，07-16/17 上游時戳停滯時同 key 被反覆覆寫、當日格數塌縮
//   （斷檔放大器）；牆鐘 key 保證每分鐘一格，上游停滯只會讓相鄰格內容相同（Δ=0 → 下游降級）。
// value = {code: [累計成交額, 現價], _ts: FinMind 原始時戳, _stale?: 1}
//   _ts/_stale 為保留 meta 鍵（股票代號不會撞名）；computeFlow 依 code 查表不受影響，
//   replayFrame 回傳前抽出改掛頂層 src_ts/stale。expirationTtl 2 天自動清理。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function storeFrame(env, scheduledTime, opts = {}) {
  const snap = opts.snapFn || (() => finSnapshot(env.FINMIND_TOKEN));
  let rows;
  try { rows = await snap(); }
  catch (e) {
    // FinMind 偶發失敗 → 短暫間隔後重試一次；第二次失敗照舊 throw，由 scheduled 端記 err:<date>
    await sleep(opts.retryMs != null ? opts.retryMs : 1500);
    rows = await snap();
  }
  const tp = taipeiParts(new Date(scheduledTime || Date.now()));
  const d = tp.date;
  const hm = `${String(tp.hour).padStart(2, "0")}:${String(tp.minute).padStart(2, "0")}`;
  const wallMin = tp.hour * 60 + tp.minute;
  // 收盤後（>13:35）快照不再變化：舊制覆寫同 key 冪等無害，牆鐘 key 會長出盤後假格
  // （frame cron 跑到台北 13:59）→ 直接跳過；/snap 手動測試可帶 force=1 略過此檢查
  if (!opts.force && wallMin > 13 * 60 + 35) return { skipped: true, reason: "盤後（>13:35）不落格" };
  let ts = null;
  const fr = {};   // {code: [累計成交額, 現價]}
  let mktAmt = 0;  // 全市場累計成交額（原始值，個股加總，含001/101外的所有列）
  let idxRow = null;   // 加權指數(001)當筆快照，供分鐘序列存指數值/漲跌點
  for (const r of rows) {
    const c = String(r.stock_id || "");
    if (!c) continue;
    if (c === "001") { idxRow = r; continue; }
    if (c === "101") continue;
    ts = ts || String(r.date || "");
    const a = num(r.total_amount);
    if (a > 0) { fr[c] = [Math.round(a), orNull(r.close)]; mktAmt += a; }
  }
  if (!ts) throw new Error("snapshot 無資料");
  const nStocks = Object.keys(fr).length;
  // FinMind 時戳與牆鐘差 >3 分（或日期不同）→ 照存但標 stale（07-16 時戳停滯型異常可見化）
  const stale = ts.slice(0, 10) !== d || !(Math.abs(wallMin - hm2min(ts.slice(11, 16))) <= 3);
  fr._ts = ts;
  if (stale) fr._stale = 1;
  await env.FLOW_KV.put(`f:${d}:${hm}`, JSON.stringify(fr), { expirationTtl: 172800 });
  // 維護當日 frame 時間索引（pickFrames 用 get 讀索引，不用 list——KV 免費版 list 僅 1000次/日）
  const idxKey = `fi:${d}`;
  const idx = (await env.FLOW_KV.get(idxKey, "json")) || [];
  if (!idx.includes(hm)) {
    idx.push(hm);
    // fi 索引 TTL 拉到 120h（5 天）：48h 會讓週五索引在週日下午蒸發，statusSiteLive 週末誤判紅燈。
    // frame 本體（f:）維持 48h 不動（資料量大，拉長會倍增 KV 儲存）；「索引在、frame 已過期」安全：
    // pickFrames 對 null body 已 filter、detectSubEvents 對 !old 回空、statusSiteLive/health 只讀索引。
    await env.FLOW_KV.put(idxKey, JSON.stringify(idx.sort()), { expirationTtl: 432000 });
  }
  // 分鐘動能序列（即時一覽 tab 第二期）：單一 rolling key，繞開 fi 索引最終一致性偶爾漏筆的問題
  // （fi 用 get-modify-put 也會漏，但 series 只需「近60分連續走勢」，單筆漏格不影響判讀；
  // 用同一支 key 而非 list 掃描，讀寫成本固定 1 get + 1 put/分鐘）。失敗不影響 storeFrame 主體。
  try {
    await appendSeries(env, d, hm, mktAmt, idxRow);
  } catch (e) {
    console.log("appendSeries:", e && e.message);
  }
  return { key: `f:${d}:${hm}`, src_ts: ts, stale, stocks: nStocks };
}
// storeFrame 失敗可見化（07-16/17 斷檔兩天無人知的教訓）：err:<date> 存最後錯誤＋當日計數，
// TTL 2 天；「僅錯誤內容變化時寫」省 KV write 額度——同錯誤連續發生時 count 不再累加（可接受取捨）。
export async function recordFrameErr(env, dateISO, e) {
  try {
    const msg = String(e && e.message || e);
    const key = `err:${dateISO}`;
    const prev = await env.FLOW_KV.get(key, "json");
    if (prev && prev.last === msg) return false;
    await env.FLOW_KV.put(key, JSON.stringify({
      last: msg, at: new Date().toISOString(), count: ((prev && prev.count) || 0) + 1,
    }), { expirationTtl: 172800 });
    return true;
  } catch (e2) { console.log("recordFrameErr:", e2 && e2.message); return false; }
}
// series:<date> = [{t:"HH:MM", amt:市場總成交額(億), idx:加權指數值|null, chg:漲跌點|null}, ...]
// 保留當日全部（盤中每分鐘一筆，≤270 筆，遠低於 KV 單值 25MB 上限）；同一分鐘重跑覆寫（冪等）。
//
// ---- 2026-08-09：亂序／重複點修正（PROJECT_SUMMARY「appendSeries 的 lost update 競態」）----
// 單一 key 的 get-modify-put 在 CF KV（無 CAS）下會互相覆蓋，而 hm 取自 event.scheduledTime
// 而非實際執行時刻 → 慢班會用自己的舊標籤在較晚的牆鐘寫入。舊版冪等檢查只比對
// arr[arr.length-1].t，亂序寫入不會被去重、而是 push 成重複點（2026-07-30 實證：11:41 排在
// 11:40 前、兩筆 amt/idx/chg byte 全等）。lost update 本身無 CAS 救不回（漏格已被 storeFrame
// 區塊註解接受），但**亂序與重複可以消滅**：改成以 t 為鍵對全陣列去重、put 前 sort by t。
// 效果：seriesTail 的 .slice(-n) 末筆必為當日最新分鐘，任何「取最後一筆／相鄰差分」的消費者
// （detectIdxEvent、build_daysummary…）不再靜默算錯。成本 O(n log n)（去重 O(n)，但 put 前的
// out.sort 是 O(n log n)）、n≤276，零額外 KV 請求；實測 n×4 → 時間 ×3~×5（O(n²) 會是 ×16），
// 確認非 O(n²)。此規模下 O(n) 與 O(n log n) 無實務差別（n=276 約 0.16 ms/次）。
//
// 同 t 衝突保留策略：**amt 較小者勝**（平手或不可比 → 後寫入者勝，沿用舊版「同分鐘重跑覆寫」）。
// 理由（2026-08-09 獨立複核後重寫；原理由「amt 盤中單調不減」只是近似，見下）：同一標籤 t 的
// 兩筆快照只有兩種偏差方向——
//   ①「遲到班把較晚的累計額寫進較早的標籤」→ amt **偏高**。cron 只會準時或遲到、不會提早，
//     這是常態偏差；取較小者＝取擷取牆鐘較早的那筆，正好消滅 amt(11:40) > amt(11:41) 的負差分。
//   ②「FinMind 回不完整清單（status 200 但列數偏少）」→ amt **偏低**，會被 min-amt 誤判成
//     「較早擷取」而鎖住。這是 min-amt 唯一的曝險面。
// 13 個交易日（2026-07-20~08-07，data/intraday/）實測：①型偏差明確可觀測（見下段），
// ②型**零觀測**（各日 frame 的 nstk 全日波動 ≤0.071%，最大一次 2796→2798）。
// 故在現有證據上，取較小者是對的一邊；曝險面的成本是「未觀測到的風險」。
//
// ⚠️「amt 盤中單調不減」是近似、不是事實（2026-08-09 實測更正）：13 個交易日 3,574 組相鄰對
// 有 **23 組（0.64%）遞減**，集中在 09:00–09:04（另一組起點在 09:40）。最差的是 2026-08-03
// 的 amt(09:00)=25871.6 → amt(09:01)=2710（比值 0.105）。根因已查明：**開盤前 FinMind 快照回的是
// 前一交易日的收盤殘留值**——2026-08-04 的 09:00 點 (idx 43386.41, chg 266.66) 與 2026-08-03
// 的 13:35 收盤點 **byte 完全相同**。亦即 amt **會偏高、不只會偏低**，而 min-amt 在這類異常上
// 正好選對（挑掉殘留值、留下真正的開盤累計額）。
//
// ❌ 為什麼不改用 FinMind 自己的時戳（ts）去重（2026-08-09 評估後否決，記錄於此以免再試）：
// storeFrame 已算出 ts（`String(r.date)`，分鐘解析度），存進 point 後同 t 取 ts 較早者，
// 表面上比 amt 這個代理更直接地量測「哪筆擷取較早」。實測三項否決理由——
//   (a)**開盤殘留值的 ts 反而更早**：2026-08-09（休市日）實打 /live 得 ts="2026-08-09 08:30:00"，
//      而內容是 08-07 的收盤值（idx 44225.91／chg -170.79 ＝ 08-07 的 13:35 點）。亦即殘留快照帶的
//      是「當日 08:30」的盤前時戳，比任何盤中新鮮快照都早 → 「取 ts 較早者」會在上段那三個開盤
//      異常案例上**全部選錯**，與被推翻的 0.5 下限犯完全同一個錯。
//   (b)**ts 會停滯**：2026-07-29 的 09:01/09:02/09:03 三筆 amt/idx/chg byte 全等（上游時戳凍結），
//      此時兩筆 ts 相等 → 退回「後寫入者勝」，等於沒有策略。13 個交易日的 frame 有 **95.7%
//      （672/702）** 被標 stale（ts 與牆鐘差 >3 分），落後量並非常數，「相對比較不受 stale 影響」
//      這個推論不成立。
//   (c) 本檔上方 `f:<date>:<hm>` 的 key 設計註解已載明：**舊制就是拿 FinMind 時戳當 key**，
//      07-16/17 上游時戳停滯時當日格數塌縮，才改成牆鐘 key。拿 ts 去重＝把當初刻意逃離的
//      失效模式請回來。
//
// 順序相依性（2026-08-09 移除下限後重新測量）：min-amt 是 min 歸約（可交換、可結合），
// **同一個 t 不論累積幾筆，只要 amt 皆為有限值且兩兩相異，結果就與寫入順序無關**
// （n=3／n=4 各 20000 組隨機相異值、窮舉全部排列，零發散）。這比帶 0.5 下限的版本**嚴格更好**：
// 下限是成對比較、不滿足結合律，同一批測量得 n=3 有 **12.46%**、n=4 有 **27.79%** 的組合會因
// 寫入順序收斂到不同結果（並非罕見邊角）。**只有平手或不可比時才依賴寫入順序**（後寫入者勝，
// 沿用舊版冪等），該類配對按定義必然發散；其在隨機樣本中的佔比完全由取樣分佈決定——原記錄的
// 「約 2%」與「約 5%」是兩次不同取樣的產物、不是同一個量的兩個估計，故不再記任何百分比。
//
// 已知曝險（誠實揭露，皆為既有狀況、非本批引入，不修）：
//   - `num()` 對非數值字串回 NaN → 走「不可比」分支（後寫入者勝）。
//   - 但 `Number(null)`／`Number("")`／`Number(0)` 皆為**有限的 0**，會走正常比較並以最小值勝出
//     → amt 為 null/""/0 的壞點會鎖住該分鐘。**只有 key 根本不存在（undefined → NaN）才真的不可比**。
//   - `storeFrame` 對「FinMind 回不完整清單」本來就毫無守門：`nStocks` 只在回傳值裡報告、不擋任何東西。
function pickSeriesDup(oldP, newP) {
  const a = Number(oldP && oldP.amt), b = Number(newP && newP.amt);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return newP;   // 平手／不可比 → 後寫者勝
  return a < b ? oldP : newP;   // 純 min-amt：比較對稱且為 min 歸約 → 與寫入順序無關（含三筆以上）
}
// 全陣列以 t 去重＋依 t 排序（"HH:MM" 定寬字串，字典序＝時序）。點可為 null/壞資料 → 直接濾掉。
// 也會就地清理舊版程式留下的既有亂序／重複（下一次 append 即自癒）。
export function mergeSeriesPoint(arr, point) {
  const out = [], at = new Map();   // t → out 內的索引
  for (const p of [...(Array.isArray(arr) ? arr : []), point]) {
    if (!p || typeof p.t !== "string") continue;
    const i = at.get(p.t);
    if (i === undefined) { at.set(p.t, out.length); out.push(p); continue; }
    out[i] = pickSeriesDup(out[i], p);
  }
  out.sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : 0));
  return out;
}
export async function appendSeries(env, d, hm, mktAmtRaw, idxRow) {
  const key = `series:${d}`;
  const point = {
    t: hm,
    amt: r1(mktAmtRaw / 1e8),
    idx: idxRow ? orNull(idxRow.close) : null,
    chg: idxRow ? orNull(idxRow.change_price) : null,
  };
  const arr = mergeSeriesPoint(await env.FLOW_KV.get(key, "json"), point);
  await env.FLOW_KV.put(key, JSON.stringify(arr), { expirationTtl: 172800 });
  return arr;
}
// /live 回應只帶近 60 分（前端 sparkline 用），KV 內仍保留當日全部
export function seriesTail(arr, n = 60) {
  return (arr || []).slice(-n);
}

// ---- 資金湧入指標（P3）----
// 集中度 = 短窗佔全市場成交比 ÷ 常態佔比(a5/tot5)。佔比相除 → 市場 U 型時段效應自動抵消；
// 窗長取「最接近目標的既有 frame」，佔比法對實際窗長不敏感。回測依據 backtest/report_sector.md。
const hm2min = (hm) => +hm.slice(0, 2) * 60 + +hm.slice(3, 5);

export async function pickFrames(env, d, nowMin, wins) {   // export 供 test/frames.mjs 直測「fi 在但 f 缺」
  // 讀索引 key（storeFrame 維護）取代 list——免費版 list 僅 1000次/日，get 有 10 萬
  const times = (await env.FLOW_KV.get(`fi:${d}`, "json")) || [];
  const chosen = {};
  for (const w of wins) {
    const target = nowMin - w;
    let best = null;
    for (const hm of times) {
      const m = hm2min(hm);
      if (m <= target && m < nowMin - 2) best = hm;   // 最接近目標且確實比現在舊
    }
    if (best) chosen[w] = `f:${d}:${best}`;
  }
  const uniq = [...new Set(Object.values(chosen))];
  const bodies = {};
  await Promise.all(uniq.map(async (nm) => { bodies[nm] = await env.FLOW_KV.get(nm, "json"); }));
  const out = {};
  for (const w of wins) if (chosen[w] && bodies[chosen[w]]) out[w] = { name: chosen[w], data: bodies[chosen[w]] };
  return out;
}

// ---- 第五期：當日回放 ----
// /replay?t=HH:MM：直接按 key 規則讀 f:<date>:<HH:MM>（不經 fi 索引——索引已知會漏筆），
// 該分鐘缺格時往前逐分鐘回退最多 5 分鐘（≤6 次 get，無 list）。
// date 參數僅供驗證／測試用（正式前端不帶，預設台北今日）。錯誤一律 200＋{error}（不 500）。
export async function replayFrame(env, d, t) {
  if (!/^\d{2}:\d{2}$/.test(t || "")) return { error: "t 需為 HH:MM（09:00–13:30）" };
  let m = hm2min(t);
  if (m > 13 * 60 + 30) m = 13 * 60 + 30;   // 收盤後的時間夾到 13:30
  if (m < 9 * 60) return { error: "盤前時段無盤中資料（09:00 起）", date: d, t };
  for (let i = 0; i <= 5; i++) {
    const mm = m - i;
    if (mm < 9 * 60) break;
    const hm = `${String(Math.floor(mm / 60)).padStart(2, "0")}:${String(mm % 60).padStart(2, "0")}`;
    const fr = await env.FLOW_KV.get(`f:${d}:${hm}`, "json");
    if (fr) {
      // meta 保留鍵抽出改掛頂層（additive；舊格式 frame 無 _ts → 欄位缺省），stocks 保持乾淨
      const out = { t: hm, date: d, stocks: fr };
      if (fr._ts) { out.src_ts = fr._ts; delete fr._ts; }
      if (fr._stale) { out.stale = 1; delete fr._stale; }
      return out;
    }
  }
  return { error: "該時段無盤中資料（該分鐘與往前 5 分鐘皆無 frame）", date: d, t };
}

// frame 舊格式（純數字）相容
const frAmt = (v) => (v == null ? null : Array.isArray(v) ? v[0] : v);
const frClose = (v) => (v == null || !Array.isArray(v) ? null : v[1]);

// 台股收盤 13:30。窗起點一旦到收盤，該窗量到的只可能是盤後定價/零股，不是盤中資金流。
export const CLOSE_MIN = 13 * 60 + 30;
// 最短窗的起點是否已到收盤 → 這份 flow 是「收盤殘影」。抽成具名函式是為了讓門檻可被
// 測試直接釘住（內聯的話改門檻不會有任何測試變紅——實測過）。
export function framesDegenerate(frameNames, w1) {
  const hm = frameNames && frameNames[w1];
  if (!hm) return true;
  return hm2min(hm) >= CLOSE_MIN;
}
export function computeFlow(cl, items, baseline, frames, nowTs) {
  const bl = baseline.stocks || {}, tot5 = baseline.tot5 || 0;
  if (!tot5) return { flow: null, per: {} };
  // stale 防護（07-16/17 上游時戳停滯教訓）：窗口 frame 的 _ts 與當前快照時戳完全相同
  // → 上游停滯、該窗 Δ 必為 0，視同「無 frame」走既有降級（cx/mkt 回 null），不產生假訊號
  if (nowTs) for (const w of Object.keys(frames)) {
    const f = frames[w];
    if (f && f.data && f.data._ts === nowTs) delete frames[w];
  }
  const wins = Object.keys(frames).map(Number).sort((a, b) => a - b);
  if (!wins.length) return { flow: null, per: {} };

  // 每檔各窗Δ額；全市場Δ = baseline universe 加總
  const per = {};        // code → {d:{win:Δ}, cNow, cThen(win10)}
  const mktD = {};       // win → 市場Δ
  for (const it_ of items) {
    const { code, amt, close } = it_;
    if (!bl[code]) continue;
    const o = { d: {}, close };
    for (const w of wins) {
      const f = frames[w].data[code];
      const a0 = frAmt(f);
      if (a0 == null || amt < a0) continue;      // 無舊值或資料倒退 → 略過該窗
      o.d[w] = amt - a0;
      mktD[w] = (mktD[w] || 0) + (amt - a0);
      if (frClose(f) != null) o["p" + w] = frClose(f);   // 窗口起點價
    }
    per[code] = o;
  }

  // 個股集中度（r10=窗內漲跌%，湧入/退出方向判定用——全日跌但近窗爆量反攻仍屬湧入）
  const stockFlow = {};  // code → [f10, c10, c30, r10]
  const W1 = wins[0];
  // 開盤初期只有短窗時，長窗回 null（避免 c30 顯示成 c10 的複製品誤導）
  const W2 = wins.length > 1 ? wins[wins.length - 1] : null;
  for (const code in per) {
    const o = per[code], b = bl[code];
    const base = b[0] / tot5;
    const cx = (w) => (o.d[w] != null && mktD[w] > 0 && base > 0)
      ? Math.round((o.d[w] / mktD[w]) / base * 100) / 100 : null;
    const p1 = o["p" + W1];
    const r10 = (p1 && o.close != null) ? Math.round((o.close / p1 - 1) * 10000) / 100 : null;
    stockFlow[code] = [o.d[W1] != null ? o.d[W1] : null, cx(W1), cx(W2), r10, o.d[W2] != null ? o.d[W2] : null];
  }

  // 次產業聚合（classify.p 第二層）
  const subs = {};
  for (const code in per) {
    const info = cl[code];
    if (!info || !info.p) continue;
    const o = per[code], b = bl[code];
    for (const sname of new Set(info.p.map((p) => p[1]))) {
      const s = subs[sname] || (subs[sname] = { name: sname, d1: 0, d2: 0, a5: 0, n: 0, rets: [] });
      if (o.d[W1] != null) { s.d1 += o.d[W1]; s.n += 1; }
      if (o.d[W2] != null) s.d2 += o.d[W2];
      s.a5 += b[0];
      const p1 = o["p" + W1];
      if (p1 && o.close != null) s.rets.push(o.close / p1 - 1);
    }
  }
  const subList = [];
  const subsY = baseline.subs_y || {};   // 昨日/前日次產業訊號 [y1,y2]（見 build_baseline.py）
  for (const k in subs) {
    const s = subs[k];
    if (s.d1 <= 0 || s.n < 3) continue;          // 有意義門檻：有量且成員≥3
    const base = s.a5 / tot5;
    const c1 = mktD[W1] > 0 && base > 0 ? (s.d1 / mktD[W1]) / base : null;
    const c2 = mktD[W2] > 0 && base > 0 ? (s.d2 / mktD[W2]) / base : null;
    const ret = s.rets.length ? s.rets.reduce((a, b2) => a + b2, 0) / s.rets.length : null;
    subList.push({ name: k, n: s.n, d_yi: Math.round(s.d1 / 1e6) / 100,
      c1: c1 && Math.round(c1 * 100) / 100, c2: c2 && Math.round(c2 * 100) / 100,
      ret: ret != null ? Math.round(ret * 10000) / 100 : null,
      y: subsY[k] || null });
  }
  subList.sort((a, b) => b.d_yi - a.d_yi);
  // 市場級短窗成交增量（即時一覽儀表列用）：沿用上面已算好的 mktD（全股 Δ 加總），
  // 換算億元，不新增任何 KV 讀寫。10/30 分窗長對應 buildLive 呼叫 pickFrames 的 [10, 30]；
  // 若某窗當下沒有可比對的 frame（例如開盤剛滿10分還沒有30分窗）該欄位回 null。
  const toYi = (v) => (v == null ? null : Math.round(v / 1e6) / 100);
  const mkt = { d10_yi: toYi(mktD[10]), d30_yi: toYi(mktD[30]) };
  const frameNames = Object.fromEntries(wins.map((w) => [w, frames[w].name.slice(-5)]));
  const flow = {
    wins: { w1: W1, w2: W2 },
    frames: frameNames,
    baseline_date: baseline.date,
    subs: subList,
    mkt,
    // 收盤殘影標記（2026-07-30）：storeFrame 在 >13:35 就不落格，但 buildLive 是用
    // FinMind 快照時戳 live.ts 算窗（不是牆鐘），而 ts 收盤後會前進到 14:30~15:00
    // （盤後定價/零股）。於是每個窗都挑到最後那幾格，Δ 只剩盤後定價雜訊：
    //   ts ≥ 14:05      → 兩窗挑到同一格，連窗內方向都算不出來
    //   ts 13:36~14:04  → 兩窗還不同格，但短窗起點已 ≥13:30，c1/r10 全是假的
    // 判準取「最短窗的起點是否已到收盤（13:30）」——收盤後開始的窗，量到的必然
    // 只有盤後定價。這同時涵蓋上面兩種，且不誤傷開盤初期（09:15 時起點 09:05）。
    // 下游（attachFlowLast、前端）據此退回收盤定格，不要各自去猜。
    degenerate: framesDegenerate(frameNames, W1),
  };
  return { flow, per: stockFlow };
}

// ---- 案三（2026-07-19）：收盤前定格 flow:last ——盤外/週末即時一覽「象限圖＋treemap 角標」fallback ----
// 動機：flow 盤外為 null、frame TTL 2 天 → 盤外沒有短窗資料可退回；收盤前把最後一份可用 flow
//   定格存 KV，/live 於 flow 為 null 或收盤殘影時附頂層 flow_last（標註資料日）。
//   消費者：象限圖＋treemap 角標（案三）與 湧入/退出 tab（案四）。
// 寫入路徑：只走 frame cron 保底（scheduled 於台北平日 13:25–13:40 每分鐘 buildLive→storeFlowLast），
//   /live 流量路徑不寫——寫入次數固定 ≤16/日，不隨流量浮動。
// KV write 預算（免費 1000/日）：既有 frame+fi+series 每盤中分鐘 ≤3 put（~275 分 ≈825）＋alerts/err/哨兵
//   零星 ≤20 → 本功能 +16 後 worst case ≈860/日，仍留 >100 餘裕。讀：/live 僅 flow=null 時 +1 get（10 萬/日額度無虞）。
// 案四（2026-07-19）擴充：payload 加 subs/frames/baseline_date/stocks，供「資金湧入／退出」
//   tab（renderFlow）比照定格 fallback；寫入路徑/頻率/窗口不變，見 flowLastPayload 上方註解。
//   KV value 大小需量測（目標 <1MB，遠低於 25MB 上限）——見 test/flowlast.mjs 的位元組數測試。
export const FLOW_LAST_KEY = "flow:last";
export const FLOW_LAST_TTL = 604800;   // 7 天：超長連假過期 → 前端自然退回既有「盤中生效」降級
// 寫入窗口：台北平日 13:25–13:40（收盤撮合 13:30 前後；13:36+ 快照凍結、frames 停更，覆寫冪等無害）
export function inFlowLastWindow(tp) {
  const m = tp.hour * 60 + tp.minute;
  return tp.dow >= 1 && tp.dow <= 5 && m >= 13 * 60 + 25 && m <= 13 * 60 + 40;
}
// live → flow:last payload（純函式可離線測）：flow null 或 d30 缺 → null（不寫）
// f30 只收 >0 的個股（省 KV 值大小；前端聚合缺鍵視同 0，語意不變）
//
// 案四（2026-07-19）擴充：「資金湧入／資金退出」tab（renderFlow）比照案三定格 fallback，
// 需要完整 flow.subs[]／flow.frames／flow.baseline_date，以及逐股 f10/c10/c30/r10
// （it/fi/y1/y2/ints/nl 是 baseline 直出、不受 flow=null 影響、永遠可從 sval(c) 取得，
// 不需要在這裡重複存一份）。stocks 比照 f30 的省空間做法，只收 f10>0 的個股。
// 純 additive：既有 mkt/f30 欄位與寫入路徑/頻率/窗口完全不變（案三驗收不得退化）。
export function flowLastPayload(live) {
  const fl = live && live.flow;
  if (!fl || !fl.mkt || fl.mkt.d30_yi == null) return null;
  const cols = live.stock_cols || [];
  const iF30 = cols.indexOf("f30");
  const iF10 = cols.indexOf("f10"), iC10 = cols.indexOf("c10"),
    iC30 = cols.indexOf("c30"), iR10 = cols.indexOf("r10");
  const f30 = {};
  if (iF30 >= 0) for (const c in live.stocks) {
    const v = live.stocks[c][iF30];
    if (v != null && v > 0) f30[c] = v;
  }
  const stocks = {};
  if (iF10 >= 0) for (const c in live.stocks) {
    const a = live.stocks[c];
    const f10 = a[iF10];
    if (f10 != null && f10 > 0) stocks[c] = [f10, a[iC10], a[iC30], a[iR10]];
  }
  return { date: String(live.ts || "").slice(0, 10), ts: live.ts,
    mkt: { d10_yi: fl.mkt.d10_yi, d30_yi: fl.mkt.d30_yi }, f30,
    subs: fl.subs, frames: fl.frames, baseline_date: fl.baseline_date, stocks };
}
// flow 是否為「收盤殘影」——收盤後的退化 flow。舊 payload 沒有 degenerate 欄位時
// 退回用「兩窗同格」近似（只抓得到 ts≥14:05，13:36~14:04 抓不到，故僅作相容用）。
export function flowDegenerate(flow) {
  if (!flow) return true;
  if (flow.degenerate != null) return !!flow.degenerate;
  const fr = flow.frames || {};
  return !!(fr["10"] && fr["10"] === fr["30"]);
}
// 窗口內且 flow 可用才覆寫單一 key（冪等；TTL 7 天）
export async function storeFlowLast(env, live, tp) {
  if (!env.FLOW_KV || !inFlowLastWindow(tp)) return { stored: false, reason: "窗口外" };
  // 別把收盤殘影存成「定格」——會被 TTL 保留 7 天並當成正常定格顯示。
  // 寫入窗 13:25–13:40 內短窗起點必 <13:30（要 ≥13:30 得 ts≥13:40 且該格存在），
  // 正常不會命中；純防禦。
  if (flowDegenerate(live && live.flow)) return { stored: false, reason: "flow 為 null 或收盤殘影" };
  const pl = flowLastPayload(live);
  if (!pl) return { stored: false, reason: "flow null" };
  await env.FLOW_KV.put(FLOW_LAST_KEY, JSON.stringify(pl), { expirationTtl: FLOW_LAST_TTL });
  return { stored: true, key: FLOW_LAST_KEY, date: pl.date };
}
// /live 附掛：flow 為 null 或收盤殘影時 1 次 get；KV 讀失敗吞錯不影響 /live 主體。
// 注意閘門只看 degenerate，**不綁 subs、不綁 d30_yi 是否為 null**：開盤 09:10–09:30
// 只有 10 分窗（d30_yi=null）但今日短窗資料完全有效，那時照樣附上 flow_last（成本一次
// get），由前端各分頁自己決定要用即時還是定格——不同消費者需要的欄位不一樣。
export async function attachFlowLast(env, live) {
  if (!live || !flowDegenerate(live.flow) || !env.FLOW_KV) return live;
  try {
    const fl = await env.FLOW_KV.get(FLOW_LAST_KEY, "json");
    if (fl) live.flow_last = fl;
  } catch (e) { console.log("attachFlowLast:", e && e.message); }
  return live;
}

// ---- FinMind 哨兵（傍晚探測盤後資料落地 → GitHub workflow 兩段式觸發）----
// 目的：FinMind 盤後資料（法人買賣超/外資持股/融資券/當沖）落地時間不定，
//   固定 cron 只能保守晚跑。哨兵在台北平日 17:00–23:00 每 5 分探一次（單檔 2330、
//   單日，最便宜的請求），哪個訊號落地就立刻 workflow_dispatch 對應 repo，
//   讓「盤後法人動態」與「盤後分析」在資料可得後 10 分鐘內更新。
// 備援（雙觸發機制）：taiwan-flows daily.yml（台北 21:19）與 postmkt build.yml
//   （21:53）的 GitHub cron 保留不動；兩條管線冪等，哨兵先觸發後 cron 再跑一次
//   只是重算相同結果，無害。
// 去重：KV `sentinel:<YYYYMMDD>:<signal>` = dispatched → 當晚該訊號不再探測；
//   四個訊號都觸發完，整個哨兵當晚短路（只剩 KV 讀，不打 FinMind）。
// 安全：env.GH_DISPATCH_TOKEN（wrangler secret，GitHub PAT 需 repo 的 actions:write）
//   未設定時整段直接 return，不影響 worker 既有功能。

const GH_OWNER = "shihpc";
const SENTINEL_SIGNALS = [
  // 第一波：法人買賣超落地 → flows 主排行可算
  { name: "inst",     dataset: "TaiwanStockInstitutionalInvestorsBuySell", repo: "taiwan-flows", wf: "daily.yml" },
  // 第二波：外資持股% 落地（官方約 21:00 後）→ flows 冪等重跑補持股欄位
  { name: "holding",  dataset: "TaiwanStockShareholding",                  repo: "taiwan-flows", wf: "daily.yml" },
  // 第一波：融資券落地 → postmkt 融借券/鉅額/零股/分點可算
  { name: "margin",   dataset: "TaiwanStockMarginPurchaseShortSale",       repo: "postmkt",      wf: "build.yml" },
  // 第二波：當沖量值落地（約 21:30 後才非零）→ postmkt 冪等重跑補當沖
  { name: "daytrade", dataset: "TaiwanStockDayTrading",                    repo: "postmkt",      wf: "build.yml", needVolume: true },
];

// 台北時間拆解（UTC+8、無夏令時間；可離線測試）
export function taipeiParts(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 3600e3);
  return { date: t.toISOString().slice(0, 10), hour: t.getUTCHours(),
    minute: t.getUTCMinutes(), dow: t.getUTCDay() };
}
// 這次 cron 醒來該做什麼（依台北時間＋觸發它的 cron 字串分流）：
// - news：每天（含週末）06:07–22:07 每小時 :07 → dispatch taiwan-stock-news。
//   例外：盤中 frame cron（* 1-5 * * 2-6）在 9:07–13:07 也會於 :07 醒來（兩條 cron
//   同分重疊、各發一個 scheduled 事件），frame cron 醒來的那個要照存 frame，
//   否則會重複 dispatch news 且掉一格分鐘 frame——所以用 event.cron 排除它。
//   17:07–22:07 落在哨兵窗口內但 7 不是 %5==0（原本是 idle），改判 news 不衝突。
// - morning：平日 06:47 → dispatch 本 repo morning.yml（晨報準點產出；夜盤 05:00
//   收盤後留 ~1.5 小時給 FinMind 入庫。GitHub cron 06:00 保留當備援，冪等多跑無害）。
// - sentinel：平日 17:00–22:59 台北每 5 分一輪盤後落地探測，其餘分鐘 idle。
// - frame：其餘（實際上只有盤中 cron 會打到）。週六日永不進哨兵。
export const FRAME_CRON = "* 1-5 * * 2-6";   // 需與 wrangler.toml crons[0] 完全一致
export function scheduledRole(tp, cron) {
  if (tp.minute === 7 && tp.hour >= 6 && tp.hour <= 22 && cron !== FRAME_CRON)
    return "news";
  if (tp.minute === 47 && tp.hour === 6 && tp.dow >= 1 && tp.dow <= 5)
    return "morning";
  // 新聞/晨報共用 cron 也會在其他小時的 :47 醒來（CF 免費方案 3 條 cron 上限，
  // 無法為晨報開第四條）——非 06:47 的 :47 且非盤中 cron 一律 idle，不能落到 frame
  if (tp.minute === 47 && cron !== FRAME_CRON) return "idle";
  const weekday = tp.dow >= 1 && tp.dow <= 5;
  if (weekday && tp.hour >= 17 && tp.hour < 23)
    return tp.minute % 5 === 0 ? "sentinel" : "idle";
  return "frame";
}
export const sentinelKey = (dateISO, signal) => `sentinel:${dateISO.replaceAll("-", "")}:${signal}`;
// 訊號落地判定：今日資料非空；daytrade 另要求 Volume>0（FinMind 先出空殼列、量值晚到）
export function signalLanded(sig, rows) {
  if (!rows || !rows.length) return false;
  return sig.needVolume ? rows.some((r) => num(r.Volume) > 0) : true;
}
// GitHub workflow_dispatch 請求（純建構、可離線驗 URL/headers/body）。
// inputs 選填（2026-07-22 起，summary.yml 需帶 slot）：不傳時 body 與舊版位元組級相同，
// 既有 sentinel/news/morning/backup 呼叫零影響。
export function ghDispatchRequest(repo, wf, token, inputs) {
  return {
    url: `https://api.github.com/repos/${GH_OWNER}/${repo}/actions/workflows/${wf}/dispatches`,
    init: {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "taiwan-flow-v2-sentinel",   // GitHub API 必填
        "Content-Type": "application/json",
      },
      body: JSON.stringify(inputs ? { ref: "main", inputs } : { ref: "main" }),
    },
  };
}
async function ghDispatch(env, repo, wf, fetchFn = fetch, inputs) {
  const { url, init } = ghDispatchRequest(repo, wf, env.GH_DISPATCH_TOKEN, inputs);
  const r = await fetchFn(url, init);
  if (r.status !== 204) throw new Error(`dispatch ${repo}/${wf} HTTP ${r.status}`);
}
// 共用：dispatch 失敗重試 1 次（間隔 3 秒，沿用 storeFrame 同款 sleep()），
// 兩次都失敗才把錯誤丟給呼叫端（呼叫端既有 .catch(log) 兜底，日後再靠下一輪
// 定點班/備援 cron 自然重試）。sleepFn 供測試注入（略過實際等待）。
const DISPATCH_RETRY_MS = 3000;
async function ghDispatchWithRetry(env, repo, wf, fetchFn = fetch, sleepFn = sleep, inputs) {
  try {
    await ghDispatch(env, repo, wf, fetchFn, inputs);
  } catch (e) {
    console.log(`dispatch ${repo}/${wf} 第1次失敗（${e && e.message}），${DISPATCH_RETRY_MS / 1000}秒後重試一次`);
    await sleepFn(DISPATCH_RETRY_MS);
    await ghDispatch(env, repo, wf, fetchFn, inputs);   // 仍失敗就往外丟
  }
}
async function probeSignal(env, sig, date) {
  // 最便宜探測：data_id=2330、start=end=今日。不掛 cf 快取——要看的是「剛剛落地了沒」
  const u = `${FIN_BASE}?dataset=${sig.dataset}&data_id=2330&start_date=${date}&end_date=${date}&token=${encodeURIComponent(env.FINMIND_TOKEN)}`;
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${sig.dataset} HTTP ${r.status}`);
  const j = await r.json();
  if (j.status !== 200) throw new Error(`${sig.dataset}: ${j.msg}`);
  return signalLanded(sig, j.data || []);
}
async function runSentinel(env, tp) {
  if (!env.GH_DISPATCH_TOKEN || !env.FINMIND_TOKEN) return;   // secret 未設 → 安靜跳過（部署順序安全）
  const keys = SENTINEL_SIGNALS.map((s) => sentinelKey(tp.date, s.name));
  const done = await Promise.all(keys.map((k) => env.FLOW_KV.get(k)));
  if (done.every(Boolean)) return;                            // 四訊號都觸發過 → 當晚短路
  for (let i = 0; i < SENTINEL_SIGNALS.length; i++) {
    if (done[i]) continue;                                    // 已觸發過的訊號跳過探測（省請求）
    const sig = SENTINEL_SIGNALS[i];
    let landed;
    try { landed = await probeSignal(env, sig, tp.date); }
    catch (e) { console.log(`sentinel probe ${sig.name}:`, e && e.message); continue; }
    if (!landed) continue;                                    // 未落地 → 下輪再探
    try {
      await ghDispatch(env, sig.repo, sig.wf);
      await env.FLOW_KV.put(keys[i], "dispatched", { expirationTtl: 172800 });
      console.log(`sentinel: ${sig.name} 落地 → dispatched ${sig.repo}/${sig.wf}`);
    } catch (e) {
      // dispatch 失敗（token 權限不足等）→ log 後放棄該輪，KV 不記，下輪自動重試
      console.log(`sentinel dispatch ${sig.name}:`, e && e.message);
    }
  }
}

// ---- 新聞定點班（每天台北 06:07–22:07 每小時 :07 → dispatch taiwan-stock-news）----
// 與哨兵不同：新聞週末也收（抓的是日曆日新聞，不分交易日），且採定點制——
// 每個時點只有新聞 cron 一次醒來，不需 KV 去重。dispatch 失敗會重試 1 次（見
// ghDispatchWithRetry）；仍失敗才 log，下一小時自然再觸發，且 news repo 保留
// 22:37 台北 GitHub cron 當備援兜底。
const NEWS_REPO = "taiwan-stock-news";
const NEWS_WF = "build-news.yml";
export async function dispatchNews(env, fetchFn = fetch, sleepFn = sleep) {
  if (!env.GH_DISPATCH_TOKEN) return false;   // secret 未設 → 安靜跳過（同哨兵）
  await ghDispatchWithRetry(env, NEWS_REPO, NEWS_WF, fetchFn, sleepFn);
  console.log(`news: dispatched ${NEWS_REPO}/${NEWS_WF}`);
  return true;
}
// 晨報準點班（平日 06:47）：dispatch 本 repo 的 morning.yml。
// GitHub cron 06:00（延遲後 ~07:00 跑）保留當備援，晨報建置冪等、多跑無害。
const MORNING_REPO = "taiwan-flow-live-v2";
const MORNING_WF = "morning.yml";
export async function dispatchMorning(env, fetchFn = fetch, sleepFn = sleep) {
  if (!env.GH_DISPATCH_TOKEN) return false;
  await ghDispatchWithRetry(env, MORNING_REPO, MORNING_WF, fetchFn, sleepFn);
  console.log(`morning: dispatched ${MORNING_REPO}/${MORNING_WF}`);
  return true;
}

// ---- 排程備援（2026-07-20）：純靠 GitHub schedule 的每日管線，準點檢查產物新鮮度 → 未更新則補發 ----
// 動機：GitHub Actions schedule 常延遲甚至漏發（2026-07-20 aetf 延遲 2 小時實例）。Worker 在各班
//   「排定＋緩衝」的準點檢查該班線上產物的日期欄是否為今日；非今日 → workflow_dispatch 補發。
//   只解「GH 排程延遲/漏發」——上游 FinMind 資料公布時點與異常仍是天花板，備援不會讓資料比來源更早，
//   只保證「一旦來源有了，最多晚幾分鐘就被抓」。
// 機制：①產物新鮮度（fetch 線上 raw JSON 檢查日期欄，不需 GH token 權限、直接量到資料有沒有更新）
//   ②冪等（KV bkfired:<date>:<name>，同班每日至多補發一次，GH 原班已跑則跳過不發）
//   ③交易日守門（TW 班用「當日 frame series 是否存在」＝當日盤中有無資料；假日/週末無 series → 不補發。
//     us 為美股班，僅靠 cron dow 守門，比照其原排程日）④GH_DISPATCH_TOKEN 未設 → 整段靜默（同哨兵/news）。
// cron：每班一條專屬 cron（見 wrangler.toml；Paid 帳戶 cron 上限 250，additive 新增）。event.cron 命中
//   備援 cron → backupPipelineForCron 取對應設定；即使與哨兵 cron 同分觸發，兩者各帶自己的 event.cron、
//   互不干擾（既有 frame/哨兵/news/morning 路由零改動）。
// 跨 repo：mktbal/diag 在 postmkt repo——既有 GH_DISPATCH_TOKEN 已含 postmkt actions:write（見 wrangler.toml
//   secret 註解與哨兵 postmkt dispatch），故跨 repo 補發沿用同一 token，無需額外授權。
const POSTMKT_BASE = "https://raw.githubusercontent.com/shihpc/postmkt/main";
// 六條每日高價值班設定：
//   mode "date"     → 產物 field（前 10 碼）=== 今日台北交易日；
//   mode "genToday" → generated_at 的台北日 === 今日（判「今天有沒有跑過」；news 等用）；
//   mode "usDate"   → 產物 date（美股交易日）≥ 最近預期美股交易日（lastExpectedUsTradingDate；
//                     us 專用，2026-08-13 取代 genToday——舊判準被每輪重寫的 generated_at 污染）。
//   tw true  → 交易日守門用當日 frame series（假日無 → 不補發）；us 為 false（美股班，cron dow 已守門）。
// 2026-07-22 翻轉：Worker 從「備援補發」升格「主排程」——CF cron 挪到「上游資料就緒的理想
// 時點」先跑（GH cron 挪後變兜底備援、一條不刪＝CF 單點故障防線）。機制不變（新鮮度檢查→
// dispatch），常態變成「檢查時產物必非今日 → 天天 dispatch」；freshness 的意義變成
// 「GH 備援若先跑過就不重發」。diag/mktbal 另有 dep（依賴鏈，見 chainStep）：上游產物
// 非今日就不 dispatch 下游（上游遲到 → 下游自動等，不拿舊資料算）。
// url 支援 {date} 佔位（intraday 產物按日命名），runBackup 內以今日代入。
export function backupPipelines(env) {
  const V2 = env.DATA_BASE;
  return [
    { name: "daysummary", repo: "taiwan-flow-live-v2", wf: "daysummary.yml", url: `${V2}/daysummary/latest.json`, field: "date",       mode: "date",     tw: true  },
    { name: "aetf",       repo: "taiwan-flow-live-v2", wf: "aetf.yml",       url: `${V2}/aetf/latest.json`,       field: "run_date",   mode: "date",     tw: true  },
    { name: "baseline",   repo: "taiwan-flow-live-v2", wf: "baseline.yml",   url: `${V2}/baseline.json`,          field: "date",       mode: "date",     tw: true  },
    // us（2026-08-13 改 usDate）：date 欄=美股交易日，判「≥ 最近預期美股交易日」——
    // 舊 genToday 被 us.yml 每輪重寫 generated_at 污染，recheck 永遠不補發
    { name: "us",         repo: "taiwan-flow-live-v2", wf: "us.yml",         url: `${V2}/us.json`,                field: "date",       mode: "usDate",   tw: false },
    // intraday（2026-07-22 納管）：KV frame TTL 僅 2 天，GH 排程漏發/失敗即永久掉回測樣本
    //   （7a 上線後 07-20/07-21 全漏的教訓）。14:40 檢查當日檔存在與否，缺即補發。
    { name: "intraday",   repo: "taiwan-flow-live-v2", wf: "intraday.yml",   url: `${V2}/intraday/{date}.json`,   field: "date",       mode: "date",     tw: true  },
    { name: "diag",       repo: "postmkt",             wf: "diag.yml",       url: `${POSTMKT_BASE}/data/diag/diag.json`,                 field: "date",       mode: "date", tw: true,
      dep: { url: `${POSTMKT_BASE}/data/postmkt.json`,      field: "date" } },
    { name: "mktbal",     repo: "postmkt",             wf: "mktbal.yml",     url: `${POSTMKT_BASE}/data/market_balance_history.json`,    field: "latest_date", mode: "date", tw: true,
      dep: { url: `${POSTMKT_BASE}/data/diag/diag.json`,    field: "date" } },
  ];
}
// event.cron → 單體班 pipeline 名（cron 字串需與 wrangler.toml crons[] 完全一致）。
// diag/mktbal 無專屬 cron（併入晚場協調班 runEvening 鏈式觸發）。
export const BACKUP_CRONS = {
  "35 5 * * 2-6":  "daysummary",   // 台北 13:35 主觸發（/live 13:30 收盤定格後即備；GH 備援 14:35）
  "40 6 * * 2-6":  "intraday",     // 台北 14:40 備援（GH 主班 14:10 先跑先贏，缺檔才補發）
  "35 10 * * 2-6": "aetf",         // 台北 18:35 主觸發（GH 備援 19:05；二段見 runEvening aetf2）
  "5 12 * * 2-6":  "baseline",     // 台北 20:05 主觸發（法人官方 20:00＋腳本自帶 10 分×4 重試；GH 備援 21:15）
  // us 主觸發 05:05 台北 = 21:05 UTC 前一日；此班跨台北日界、dow 無法直接表達（且 CF cron dow 為 Quartz 慣例 1-7＝日~六，非 POSIX），改用 dow *、
  // 週末守門移到 runBackup 內用台北 dow（21:05 UTC 只在台北一~五晨落在平日）：
  "5 21 * * *":    "us",           // 台北 05:05 主觸發（GH 備援 06:10）；weekend 由 runBackup dow 守門
  // recheck 班（2026-07-25）：主觸發後 T+25~50 分再看一次產物。首發的 GH run 若自己失敗，
  // 舊版靠 bkfired 短路等於當日不再管；現在 bkGate 冷卻期過→產物仍非今日就補發第 2 次並告警。
  // 時點都排在該班 GH 兜底 cron 之前（補發還來得及，來不及才輪到 GH）。
  "5 6 * * 2-6":   "daysummary",   // 台北 14:05（首發 13:35＋30 分；GH 兜底 14:35）
  "10 7 * * 2-6":  "intraday",     // 台北 15:10（首發 14:40＋30 分）
  "0 11 * * 2-6":  "aetf",         // 台北 19:00（首發 18:35＋25 分；GH 兜底 19:05）
  "55 12 * * 2-6": "baseline",     // 台北 20:55（首發 20:05＋50 分——baseline 腳本自帶 10 分×4 重試，
                                   //   等它跑完才判失敗，否則誤判重發；GH 兜底 21:15）
  "35 21 * * *":   "us",           // 台北 05:35（首發 05:05＋30 分；GH 兜底 06:10）；weekend 同樣由 dow 守門
};
// 非單體班的排程角色（cron 字串 → 角色；晚場協調班／am summary 輪詢窗）
export const DISPATCH_ROLES = {
  "*/5 13-15 * * 2-6": "evening",      // 台北 21:00–23:55 每 5 分：pm summary→diag 鏈→mktbal 鏈→aetf2
  "50,55 22 * * *":    "summary-am",   // 台北 06:50/06:55 起手（dow 程式守門）
  "*/5 23 * * *":      "summary-am",   // 台北 07:00–07:55 主窗（morning 常態 07:1x 落地）
  "*/10 0 * * *":      "summary-am",   // 台北 08:00–08:50 尾窗兜底（morning 遲到仍趕 09:00 前）
};
// 健檢班（2026-07-25 P1）：不 dispatch 任何東西，只「盤點當日該有的產物有沒有落地」→ 缺就告警。
// 補的是 recheck 之後的最後一個洞：達 BK_MAX_ATTEMPTS 上限、或某條管線根本不在 Worker 管轄
// （flows/postmkt/news 走哨兵事件驅動、summary 走事件驅動）時，失敗一樣沒人知道。
export const HEALTH_CRONS = {
  "50 15 * * 2-6": "eve",    // 台北 23:50——晚場協調班窗（-23:55）尾聲，所有 GH 兜底 cron（-22:55）也都過了
  "30 1 * * 2-6":  "morn",   // 台北 09:30——morning/us/summary-am 全部窗口（-08:50）之後
};
// 統一路由（scheduled handler 最先判，先於 scheduledRole——晚場/am 窗的台北時刻落在
// 哨兵窗（17-23 時 %5 分）與 :47/:07 分流範圍，不先攔截會誤入 sentinel/news/idle）
export function dispatchRoleForCron(cron) {
  if (BACKUP_CRONS[cron]) return { kind: "backup", name: BACKUP_CRONS[cron] };
  if (HEALTH_CRONS[cron]) return { kind: "health", slot: HEALTH_CRONS[cron] };
  const role = DISPATCH_ROLES[cron];
  return role ? { kind: role } : null;
}
export function backupPipelineForCron(cron, env) {
  const name = BACKUP_CRONS[cron];
  if (!name) return null;
  return backupPipelines(env).find((p) => p.name === name) || null;
}
export const BKFIRED_TTL = 172800;   // 2 天（同 sentinel/frame）
export const bkfiredKey = (dateISO, name) => `bkfired:${dateISO.replaceAll("-", "")}:${name}`;
// ---- 冪等狀態升級（2026-07-25）：dispatch 成功 ≠ job 成功 ----
// 舊版 dispatch 回 204 就寫 `fired`，之後同班一律 already-fired 短路——若那個 GH run
// 自己失敗、產物根本沒更新，Worker 當日不再補救，只剩 GH 兜底 cron 一次機會（單發班
// daysummary/intraday/aetf/baseline/us 各只有一條主 cron，等於 Worker 端零重試）。
// 改法：值改存 JSON `{s,ts,n}`（s=fired|produced、ts=寫入時刻、n=已 dispatch 次數），
// 各單發班另加一條 T+25~50 分的 recheck cron；recheck 時若產物仍非今日 → 補發第 2 次
// 並告警，落地了則標 produced 當日短路。上限 BK_MAX_ATTEMPTS 次後不再發（留給 GH 兜底）。
// 向後相容：讀到舊格式純字串（"fired"/"produced"）視為 ts=0、n=1——ts=0 代表冷卻已過，
// 部署當日既有的 fired 鍵仍能被 recheck 檢查（且仍受產物新鮮度守門，不會亂發）。
export const BK_RECHECK_MS = 20 * 60e3;   // 首發後至少隔這麼久才重檢（各 recheck cron 實排 25-50 分）
export const BK_MAX_ATTEMPTS = 2;         // 每班每日至多 dispatch 次數（首發＋補發一次）
export function parseBkState(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return { s: raw.s || "fired", ts: raw.ts || 0, n: raw.n || 1 };
  const t = String(raw);
  if (t.startsWith("{")) {
    try { const o = JSON.parse(t); return { s: o.s || "fired", ts: o.ts || 0, n: o.n || 1 }; }
    catch { /* 壞 JSON → 當舊格式處理 */ }
  }
  return { s: t, ts: 0, n: 1 };   // 舊格式
}
export const bkStateValue = (s, n, nowMs = Date.now()) => JSON.stringify({ s, ts: nowMs, n });
// 冪等閘門（純函式，可離線測）：null=首次可發；produced=當日已落地，永不再發；
// fired 則看次數上限與冷卻期——冷卻未過照舊短路，過了才進 recheck（仍要過新鮮度才補發）。
export function bkGate(st, nowMs, recheckMs = BK_RECHECK_MS, maxN = BK_MAX_ATTEMPTS) {
  if (!st) return { act: "go", n: 1 };
  if (st.s === "produced") return { act: "skip", why: "already-produced", n: st.n };
  if (st.n >= maxN) return { act: "skip", why: "max-attempts", n: st.n };
  if (nowMs - (st.ts || 0) < recheckMs) return { act: "skip", why: "already-fired", n: st.n };
  return { act: "recheck", n: st.n + 1 };
}
// 最近預期美股交易日（台北視角，純函式；復用 /status 的 addDaysISO，函式本身不動）：
// 台北週二~週六＝台北昨日（美股前夜收盤）；週日＝上週五（-2）；週一＝上週五（-3）。
// 美國國定假日不處理（簡化）：假日當天會誤判 stale 觸發補跑/告警，補跑拿不到新資料也無害。
export function lastExpectedUsTradingDate(dateISO) {
  const dow = new Date(dateISO + "T00:00:00Z").getUTCDay();
  if (dow >= 2 && dow <= 6) return addDaysISO(dateISO, -1);
  return addDaysISO(dateISO, dow === 0 ? -2 : -3);   // 週日 -2／週一 -3 → 上週五
}
// 產物新鮮度判定（純函式，可離線測）：fresh=true 代表今日已跑、不需補發
export function productFresh(obj, pipe, today) {
  if (!obj) return false;
  if (pipe.mode === "genToday") {
    const g = obj[pipe.field];
    if (!g) return false;
    const t = new Date(g);
    if (isNaN(t.getTime())) return false;
    return taipeiParts(t).date === today;   // generated_at 帶 +08:00，正規化後取台北日
  }
  if (pipe.mode === "usDate") {
    // us（2026-08-13，取代 genToday）：資料日判準——us.json 的 date（美股交易日）已達
    // 最近預期美股交易日才算新鮮。舊 genToday 只判「今天跑過」，us.yml 每輪重寫
    // generated_at 導致空轉也算新鮮、recheck/健檢永遠不補發不告警。
    const d = String(obj[pipe.field] || "").slice(0, 10);
    return !!d && d >= lastExpectedUsTradingDate(today);
  }
  return String(obj[pipe.field] || "").slice(0, 10) === today;
}
// 產物抓取：cache-buster（?_=）繞開 GitHub raw CDN ~5 分快取，要看的是「當下最新狀態」
async function fetchProduct(url, fetchFn = fetch) {
  const r = await fetchFn(`${url}?_=${Date.now()}`);
  if (!r.ok) throw new Error(`product HTTP ${r.status}`);
  return r.json();
}
// 單班備援：token 守門 → 交易日守門 → 冪等 → 新鮮度 → 非今日補發。
// 回傳決策物件（供 /backup 端點觀察與單元測試）；opts.dry=true 只回決策、不真的 dispatch。
export async function runBackup(env, tp, pipe, fetchFn = fetch, opts = {}) {
  if (!env.GH_DISPATCH_TOKEN) return { name: pipe.name, skipped: "no-token" };   // 靜默（同哨兵/news/morning）
  const today = tp.date;
  if (pipe.tw) {
    // TW 班：當日 frame series 存在＝盤中有資料＝交易日（假日/週末無 → 不補發）
    const series = env.FLOW_KV ? await env.FLOW_KV.get(`series:${today}`, "json") : null;
    if (!series || !series.length) return { name: pipe.name, skipped: "non-trading-day" };
  } else if (tp.dow != null && (tp.dow < 1 || tp.dow > 5)) {
    // us（美股班）：cron 用 dow *（跨台北日界；CF dow 為 Quartz 1-7＝日~六），週末守門改在此用台北 dow——21:30 UTC 只在
    // 台北一~五晨落平日；台北六/日晨（UTC 五/六）不補發，避免週末對無新資料的 us.yml 空轉補發
    return { name: pipe.name, skipped: "non-trading-day" };
  }
  const key = bkfiredKey(today, pipe.name);
  const now = opts.nowMs || Date.now();   // 判定與寫入用同一個時鐘（nowMs 供測試注入）
  const st = env.FLOW_KV ? parseBkState(await env.FLOW_KV.get(key)) : null;
  const gate = bkGate(st, now);           // 冪等＋冷卻＋次數上限
  if (gate.act === "skip") return { name: pipe.name, skipped: gate.why, attempts: gate.n };
  // us（usDate 判準）：台北 07:00（入庫窗前緣）之前的 recheck 必然拿不到新資料——
  // FinMind 美股收盤常態 07:30-08:30 才入庫，05:35 的補發＋告警只是每日固定噪音
  // （2026-08-14 實例：每晨 05:35 都發「已補發第 2 次」告警）。改為入庫窗前靜默延後，
  // 交給 07:00-08:05 的 us-catchup 與 09:30 晨間健檢接手；tp 時間欄位缺失時保守放行。
  if (pipe.mode === "usDate" && gate.act === "recheck") {
    const mins = tp.hour * 60 + tp.minute;
    if (Number.isFinite(mins) && mins < US_CATCHUP_AFTER_MIN) {
      if (!opts.dry) await recordJob(env, tp, pipe.name, "recheck-defer", "入庫窗未開，交給 us-catchup");
      return { name: pipe.name, deferred: "before-us-ingest-window", attempts: gate.n };
    }
  }
  let obj = null, fetchErr = null;
  // {date} 佔位：intraday 產物按日命名（data/intraday/YYYY-MM-DD.json），代入今日；
  // 當日檔 404 → obj=null → 不新鮮 → 補發，語意與固定 URL 班一致
  try { obj = await fetchProduct(pipe.url.replace("{date}", today), fetchFn); }
  catch (e) { fetchErr = String((e && e.message) || e); }
  const productDate = obj ? String(obj[pipe.field] || "") : null;
  if (productFresh(obj, pipe, today)) {
    // recheck 輪確認落地成功 → 標 produced，當日剩餘喚醒直接短路（省一次產物抓取）
    if (gate.act === "recheck" && env.FLOW_KV)
      await env.FLOW_KV.put(key, bkStateValue("produced", gate.n - 1, now), { expirationTtl: BKFIRED_TTL });
    if (!opts.dry) await recordJob(env, tp, pipe.name, gate.act === "recheck" ? "landed" : "fresh", productDate);
    return { name: pipe.name, fresh: true, productDate, recheck: gate.act === "recheck" || undefined };
  }
  if (opts.dry) return { name: pipe.name, fresh: false, wouldDispatch: true, attempt: gate.n, productDate, today, fetchErr };
  try {
    await ghDispatchWithRetry(env, pipe.repo, pipe.wf, fetchFn, opts.sleepFn || sleep);
    if (env.FLOW_KV) await env.FLOW_KV.put(key, bkStateValue("fired", gate.n, now), { expirationTtl: BKFIRED_TTL });
    console.log(`backup: ${pipe.name} 產物非今日(${productDate}) → dispatched ${pipe.repo}/${pipe.wf}（第 ${gate.n} 次）`);
    await recordJob(env, tp, pipe.name, `fired#${gate.n}`, productDate);
    // 第 2 次才告警：代表首發那輪的 GH run 沒把產物做出來（dispatch 成功 ≠ job 成功）
    if (gate.act === "recheck")
      await alertJob(env, tp, `bk-recheck-${pipe.name}`,
        `⚠️ ${pipe.name}：首發後產物仍非今日（${productDate || "無檔"}），已補發第 ${gate.n} 次；仍失敗則等 GH 兜底 cron`, fetchFn);
    return { name: pipe.name, fired: true, attempt: gate.n, productDate };
  } catch (e) {
    // dispatch 兩次都失敗 → 告警＋log 後放棄該班（KV 不記，recheck cron 或 GH 兜底 cron 再接手）
    console.log(`backup dispatch ${pipe.name}:`, e && e.message);
    await recordJob(env, tp, pipe.name, "error", String((e && e.message) || e));
    await alertJob(env, tp, `bk-err-${pipe.name}`,
      `❌ ${pipe.name} dispatch 失敗：${String((e && e.message) || e)}（GH 兜底 cron 仍會跑）`, fetchFn);
    return { name: pipe.name, error: String((e && e.message) || e), productDate };
  }
}

// ---- summary 事件驅動觸發＋晚場協調班（2026-07-22，GH cron 延遲徹底解決方案）----
// postmkt 彙總分析（summary.yml，內用 Claude ×7 次）原純靠 GH cron（am 06:23／pm 22:47），
// 常態延遲 60-90 分使 pm 拖到午夜後。改為 Worker 事件驅動：輪詢上游產物新鮮度、
// 全齊即 dispatch（帶 inputs.slot）→ summary 自帶閘門秒過。上游遲到自然不觸發
// （誠實原則：分析不早於資料）；GH cron 原位保留當兜底，配合 build_summary.py
// 「已產出守門」＋concurrency queue，任意交錯下恰一場真跑、零重複 LLM 花費。
const SUMMARY_REPO = "postmkt";
const SUMMARY_WF = "summary.yml";
export const sumfiredKey = (dateISO, slot) => `sumfired:${dateISO.replaceAll("-", "")}:${slot}`;
// ISO 時戳 → 台北日（無效輸入回 null）
export function taipeiDayOf(iso) {
  if (!iso) return null;
  const t = new Date(iso);
  return isNaN(t.getTime()) ? null : taipeiParts(t).date;
}
// news 晚班判定：generated_at 台北日=今日且時 >= minHour。移植 build_summary.py news_fresh
// 的當日分支；Worker 輪詢窗只到 23:55，跨午夜（next_day_before）情境輪不到 Worker，
// 由 GH 備援＋build_summary 既有補丁處理，這裡不重複實作。
export function newsFreshW(generatedAt, today, minHour = 21) {
  if (!generatedAt) return false;
  const t = new Date(generatedAt);
  if (isNaN(t.getTime())) return false;
  const tp = taipeiParts(t);
  return tp.date === today && tp.hour >= minHour;
}
// 場次就緒判定（純函式）：srcs 為各上游產物解析後 JSON（抓取失敗傳 null）。
// pm 三源 = flows latest.json（date）＋postmkt.json（date）＋news.json（晚班 >=21）；
// am 單源 = morning.json（generated_at 台北日=今日）。與 build_summary.py wait_gate 同口徑。
export function summaryReady(slot, srcs, today) {
  const reasons = [];
  if (slot === "pm") {
    if (!srcs.flows || String(srcs.flows.date || "").slice(0, 10) !== today) reasons.push("flows-not-today");
    if (!srcs.news || !newsFreshW(srcs.news.generated_at, today, 21)) reasons.push("news-evening-not-ready");
    if (!srcs.postmkt || String(srcs.postmkt.date || "").slice(0, 10) !== today) reasons.push("postmkt-not-today");
  } else {
    if (!srcs.morning || taipeiDayOf(srcs.morning.generated_at) !== today) reasons.push("morning-not-today");
  }
  return { ready: reasons.length === 0, reasons };
}
// summary 上游產物 URL 表（flows/news 為跨 repo raw；morning 在本 repo DATA_BASE）
export function summarySources(env) {
  return {
    flows:   "https://raw.githubusercontent.com/shihpc/taiwan-flows/main/data/latest.json",
    postmkt: `${POSTMKT_BASE}/data/postmkt.json`,
    news:    "https://raw.githubusercontent.com/shihpc/taiwan-stock-news/main/news.json",
    morning: `${env.DATA_BASE}/morning.json`,
  };
}
// 單場觸發：token 守門 → 交易日守門 → 冪等 → 產物防重 → 三源/單源就緒 → dispatch(slot)。
// opts.getProduct 供晚場協調班注入共用快取（同一次喚醒 postmkt.json 只抓一次）；
// opts.dry 只回決策不真發（/sumcheck 端點與測試用）。
export async function runSummaryDispatch(env, tp, slot, fetchFn = fetch, opts = {}) {
  if (!env.GH_DISPATCH_TOKEN) return { slot, skipped: "no-token" };
  const today = tp.date;
  if (slot === "pm") {
    // pm：當日 series 存在＝交易日（同 runBackup tw 守門；21:00 後必已存在）
    const series = env.FLOW_KV ? await env.FLOW_KV.get(`series:${today}`, "json") : null;
    if (!series || !series.length) return { slot, skipped: "non-trading-day" };
  } else if (tp.dow < 1 || tp.dow > 5) {
    // am：06:5x-08:5x 當日 series 尚未誕生，只用台北 dow 守週末；國定假日不在 Worker 重複
    // 實作（summary.yml 進場即查 TWSE 休市行事曆，誤發成本=一次秒退 runner，每年 2-4 次可接受）
    return { slot, skipped: "non-trading-day" };
  }
  const key = sumfiredKey(today, slot);
  if (env.FLOW_KV && await env.FLOW_KV.get(key)) return { slot, skipped: "already-fired" };   // 冪等
  const getP = opts.getProduct || ((u) => fetchProduct(u, fetchFn).catch(() => null));
  // 產物防重：本場當日檔已在線上（GH cron 或手動先跑了）→ 補記 KV 後跳過，防重複 LLM 花費
  const prodUrl = `${POSTMKT_BASE}/data/summary/${today.replaceAll("-", "")}-${slot}.json`;
  if (await getP(prodUrl)) {
    if (env.FLOW_KV) await env.FLOW_KV.put(key, bkStateValue("produced", 0), { expirationTtl: BKFIRED_TTL });
    if (!opts.dry) await recordJob(env, tp, `summary-${slot}`, "produced");
    return { slot, skipped: "already-produced" };
  }
  const S = summarySources(env);
  const srcs = slot === "pm"
    ? { flows: await getP(S.flows), news: await getP(S.news), postmkt: await getP(S.postmkt) }
    : { morning: await getP(S.morning) };
  const chk = summaryReady(slot, srcs, today);
  if (!chk.ready) return { slot, waiting: chk.reasons };   // 未齊 → 下輪再看（不記 KV）
  if (opts.dry) return { slot, wouldDispatch: true };
  try {
    await ghDispatchWithRetry(env, SUMMARY_REPO, SUMMARY_WF, fetchFn, opts.sleepFn || sleep, { slot });
    if (env.FLOW_KV) await env.FLOW_KV.put(key, bkStateValue("fired", 1), { expirationTtl: BKFIRED_TTL });
    console.log(`summary: ${slot} 上游全齊 → dispatched ${SUMMARY_REPO}/${SUMMARY_WF} slot=${slot}`);
    await recordJob(env, tp, `summary-${slot}`, "fired");
    return { slot, fired: true };
  } catch (e) {
    console.log(`summary dispatch ${slot}:`, e && e.message);   // KV 不記 → 下輪自動重試
    await recordJob(env, tp, `summary-${slot}`, "error", String((e && e.message) || e));
    // 注意：summary 帶 LLM 花費，冪等維持「當日單發」不套 bkGate recheck（重發風險 > 漏發風險，
    // 且 GH 兜底 cron＋build_summary.py 已產出守門仍在）；這裡只補「失敗有人知道」。
    await alertJob(env, tp, `sum-err-${slot}`,
      `❌ summary(${slot}) dispatch 失敗：${String((e && e.message) || e)}（GH 兜底 cron 仍會跑）`, fetchFn);
    return { slot, error: String((e && e.message) || e) };
  }
}
// 依賴鏈判定（純函式）：自身已今日 → fresh；上游已今日 → dispatch；否則 wait-dep
export function chainStep(pipe, depObj, selfObj, today) {
  if (productFresh(selfObj, pipe, today)) return { action: "fresh" };
  const depDate = depObj ? String(depObj[pipe.dep.field] || "").slice(0, 10) : null;
  if (depDate === today) return { action: "dispatch" };
  return { action: "wait-dep", depDate };
}
// 鏈式單班：冪等 → chainStep → dispatch。與 runBackup 同構，多一層上游守門
// （上游遲到 → 下游自動等，絕不拿舊上游資料起算）。
export async function runChain(env, tp, pipe, getP, fetchFn = fetch, opts = {}) {
  const today = tp.date;
  const key = bkfiredKey(today, pipe.name);
  const now = opts.nowMs || Date.now();                // 判定與寫入用同一個時鐘
  const st = env.FLOW_KV ? parseBkState(await env.FLOW_KV.get(key)) : null;
  const gate = bkGate(st, now);                        // 同 runBackup：冷卻過了才 recheck
  if (gate.act === "skip") return { name: pipe.name, skipped: gate.why, attempts: gate.n };
  const selfObj = await getP(pipe.url.replace("{date}", today));
  const depObj = await getP(pipe.dep.url);
  const step = chainStep(pipe, depObj, selfObj, today);
  if (step.action === "fresh") {
    if (env.FLOW_KV) await env.FLOW_KV.put(key, bkStateValue("produced", gate.act === "recheck" ? gate.n - 1 : 0, now), { expirationTtl: BKFIRED_TTL });
    if (!opts.dry) await recordJob(env, tp, pipe.name, gate.act === "recheck" ? "landed" : "fresh");
    return { name: pipe.name, fresh: true };
  }
  if (step.action === "wait-dep") return { name: pipe.name, waiting: "dep", depDate: step.depDate };
  if (opts.dry) return { name: pipe.name, wouldDispatch: true, attempt: gate.n };
  try {
    await ghDispatchWithRetry(env, pipe.repo, pipe.wf, fetchFn, opts.sleepFn || sleep);
    if (env.FLOW_KV) await env.FLOW_KV.put(key, bkStateValue("fired", gate.n, now), { expirationTtl: BKFIRED_TTL });
    console.log(`chain: ${pipe.name} 上游今日已備 → dispatched ${pipe.repo}/${pipe.wf}（第 ${gate.n} 次）`);
    await recordJob(env, tp, pipe.name, `fired#${gate.n}`);
    if (gate.act === "recheck")
      await alertJob(env, tp, `bk-recheck-${pipe.name}`,
        `⚠️ ${pipe.name}：首發後產物仍非今日，已補發第 ${gate.n} 次；仍失敗則等 GH 兜底 cron`, fetchFn);
    return { name: pipe.name, fired: true, attempt: gate.n };
  } catch (e) {
    console.log(`chain dispatch ${pipe.name}:`, e && e.message);
    await recordJob(env, tp, pipe.name, "error", String((e && e.message) || e));
    await alertJob(env, tp, `bk-err-${pipe.name}`,
      `❌ ${pipe.name} dispatch 失敗：${String((e && e.message) || e)}（GH 兜底 cron 仍會跑）`, fetchFn);
    return { name: pipe.name, error: String((e && e.message) || e) };
  }
}
// aetf 二段（取代原 GH 21:37 補抓班）：台北 >=21:45 無條件 dispatch 一次（冪等 aetf2），
// 補齊一段（18:35）時部分投信 T+1 尚未揭露的 ETF。非新鮮度判斷——aetf latest.json
// 一段後已是今日，freshness 必過，需要的是「晚間再跑一次」。
export const AETF2_AFTER_MIN = 21 * 60 + 45;
export async function runAetf2(env, tp, fetchFn = fetch, opts = {}) {
  if (tp.hour * 60 + tp.minute < AETF2_AFTER_MIN) return { name: "aetf2", waiting: "before-21:45" };
  const key = bkfiredKey(tp.date, "aetf2");
  if (env.FLOW_KV && await env.FLOW_KV.get(key)) return { name: "aetf2", skipped: "already-fired" };
  if (opts.dry) return { name: "aetf2", wouldDispatch: true };
  try {
    await ghDispatchWithRetry(env, "taiwan-flow-live-v2", "aetf.yml", fetchFn, opts.sleepFn || sleep);
    if (env.FLOW_KV) await env.FLOW_KV.put(key, bkStateValue("fired", 1), { expirationTtl: BKFIRED_TTL });
    console.log("aetf2: 二段補抓 dispatched");
    await recordJob(env, tp, "aetf2", "fired");
    return { name: "aetf2", fired: true };
  } catch (e) {
    console.log("aetf2 dispatch:", e && e.message);
    await recordJob(env, tp, "aetf2", "error", String((e && e.message) || e));
    await alertJob(env, tp, "bk-err-aetf2",
      `❌ aetf 二段 dispatch 失敗：${String((e && e.message) || e)}`, fetchFn);
    return { name: "aetf2", error: String((e && e.message) || e) };
  }
}
// ---- 盤後圖卡 PNG 渲染主觸發（2026-08-09；修正「圖卡推播時序錯位」）----
// 問題：.github/workflows/cards.yml 的 cron 是台北 22:12，但 GitHub schedule 實測延遲
//   54 分~2 小時 25 分（PROJECT_SUMMARY「Worker 升格全系統主排程」待改進①），渲染常跨午夜
//   才完成 → manifest.date 永遠不是推播當下的台北日 → attachCardImages／longformImage 一律
//   回 0 張／null。**據外部證據 PNG hero 與長文圖從未真正掛上過任何一次 LINE 推播。**
// 修法：比照其他班由 Worker 主動 workflow_dispatch，GH cron 留兜底（不變式：一條不刪）。
// 時點取台北 22:00 而非 21:50：aetf2 在 21:45 才 dispatch aetf.yml，它要幾分鐘才把
//   data/aetf/diff.json push 上來；21:50 渲染會把昨日的主動ETF 數字燒進 PNG（manifest.date
//   取 baseline.date＝今日，守門攔不到這種「當日 manifest 裝舊數字」）。22:00 起跑、渲染實測
//   約 5 分鐘，對 22:30 的推播窗仍有約 25 分餘裕；真的遲到還有 pushDailyCards 的等待邏輯兜底。
// 冪等：KV bkfired:<date>:cardsrender（沿用 runAetf2 的鍵與值格式），每日至多 dispatch 一次；
//   失敗不寫鍵 → 下一輪（5 分後）自動重試。
export const CARDS_RENDER_AFTER_MIN = 22 * 60;
export async function runCardsRender(env, tp, fetchFn = fetch, opts = {}) {
  if (tp.hour * 60 + tp.minute < CARDS_RENDER_AFTER_MIN) return { name: "cards-render", waiting: "before-22:00" };
  const key = bkfiredKey(tp.date, "cardsrender");
  if (env.FLOW_KV && await env.FLOW_KV.get(key)) return { name: "cards-render", skipped: "already-fired" };
  if (opts.dry) return { name: "cards-render", wouldDispatch: true };
  try {
    await ghDispatchWithRetry(env, "taiwan-flow-live-v2", "cards.yml", fetchFn, opts.sleepFn || sleep);
    if (env.FLOW_KV) await env.FLOW_KV.put(key, bkStateValue("fired", 1), { expirationTtl: BKFIRED_TTL });
    console.log("cards-render: 圖卡渲染 dispatched");
    await recordJob(env, tp, "cards-render", "fired");
    return { name: "cards-render", fired: true };
  } catch (e) {
    console.log("cards-render dispatch:", e && e.message);
    await recordJob(env, tp, "cards-render", "error", String((e && e.message) || e));
    await alertJob(env, tp, "cards-render-err",
      `❌ 圖卡渲染 dispatch 失敗：${String((e && e.message) || e)}（GH 22:12 兜底 cron 仍會跑）`, fetchFn);
    return { name: "cards-render", error: String((e && e.message) || e) };
  }
}
// 晚場協調班（台北 21:00–23:55 每 5 分喚醒）：每醒依序 pm summary → diag 鏈 → mktbal 鏈
// → aetf2。各步獨立 try/catch＋各自冪等；同一次喚醒共用產物快取（postmkt.json 2.4MB，
// summary 三源與 diag dep 都要看，只抓一次）。交易日守門一次做在最前（series）。
export async function runEvening(env, tp, fetchFn = fetch, opts = {}) {
  if (!env.GH_DISPATCH_TOKEN) return { skipped: "no-token" };
  const series = env.FLOW_KV ? await env.FLOW_KV.get(`series:${tp.date}`, "json") : null;
  if (!series || !series.length) return { skipped: "non-trading-day" };
  const cache = {};
  const getP = (u) => (cache[u] ??= fetchProduct(u, fetchFn).catch(() => null));
  const out = {};
  try { out.summary = await runSummaryDispatch(env, tp, "pm", fetchFn, { ...opts, getProduct: getP }); }
  catch (e) { out.summary = { error: String((e && e.message) || e) }; }
  const pipes = backupPipelines(env);
  for (const name of ["diag", "mktbal"]) {
    const pipe = pipes.find((p) => p.name === name);
    try { out[name] = await runChain(env, tp, pipe, getP, fetchFn, opts); }
    catch (e) { out[name] = { error: String((e && e.message) || e) }; }
  }
  try { out.aetf2 = await runAetf2(env, tp, fetchFn, opts); }
  catch (e) { out.aetf2 = { error: String((e && e.message) || e) }; }
  // 圖卡 PNG 渲染主觸發（台北 22:00，見 runCardsRender）：必須排在 pushDailyCards 之前，
  // 讓當晚的 manifest 有機會在 22:30 推播窗開啟前落地。整步 try/catch，失敗不影響推播。
  try { out.cardsRender = await runCardsRender(env, tp, fetchFn, opts); }
  catch (e) { out.cardsRender = { error: String((e && e.message) || e) }; }
  // Phase B2 附加步驟：盤後圖卡推播（pushDailyCards 內建 台北≥22:30 時間守門＋KV 去重＋
  // baseline 交易日守門；21:00–22:25 的喚醒零成本略過）。整步 try/catch——失敗只告警
  // （tag cards-err，勿與去重鍵 alerted:<date>:cards 同名相撞），絕不影響上面既有 evening 鏈。
  try { out.cards = await pushDailyCards(env, tp, fetchFn, { ...opts, getProduct: getP }); }
  catch (e) {
    out.cards = { error: String((e && e.message) || e) };
    await alertJob(env, tp, "cards-err", `❌ 盤後圖卡：${out.cards.error}（KV 未記，下輪自動重試）`, fetchFn);
  }
  return out;
}

// ---- 晨場協調班（2026-08-10 AM slot）：晨間 LINE 圖卡渲染 dispatch ＋推播 ----
// 掛載點＝summary-am 三條 cron 的同一處喚醒（06:50/06:55、07:00–07:55 每 5 分、
// 08:00–08:50 每 10 分），與既有 runSummaryDispatch(env,tp,"am") 並存、互不影響。
// 時窗：08:05–08:15 dispatch cards.yml（inputs.slot=am；此窗內實際只有 08:10 一輪喚醒
// （尾窗 cron 為 */10），dispatch 失敗由 GH 兜底 cron UTC 00:40 接手）；08:20–08:50
// pushMorningCards（每 10 分一輪＝08:20/08:30/08:40/08:50 共 4 次機會）。
// 週末：summary-am cron dow 為 *，比照 runSummaryDispatch 用台北 dow 守一次。
// 晚間路徑（runEvening／pushDailyCards／FX_ACTIVE_CARDS）零改動。
export const CARDS_AM_RENDER_AFTER_MIN = 8 * 60 + 5;    // 台北 08:05（晨報 07:30 產出後有餘裕）
export const CARDS_AM_RENDER_UNTIL_MIN = 8 * 60 + 15;   // 台北 08:15（窗上緣，exclusive）
export const CARDS_AM_PUSH_AFTER_MIN = 8 * 60 + 20;     // 台北 08:20（渲染實測約 5 分）
export const CARDS_AM_PUSH_UNTIL_MIN = 8 * 60 + 50;     // 台北 08:50（summary-am 尾窗最後一輪，inclusive）
export async function runCardsRenderAm(env, tp, fetchFn = fetch, opts = {}) {
  const nowMin = tp.hour * 60 + tp.minute;
  if (nowMin < CARDS_AM_RENDER_AFTER_MIN || nowMin >= CARDS_AM_RENDER_UNTIL_MIN)
    return { name: "cards-render-am", waiting: "outside-08:05-08:15" };
  const key = bkfiredKey(tp.date, "cardsrender-am");
  if (env.FLOW_KV && await env.FLOW_KV.get(key)) return { name: "cards-render-am", skipped: "already-fired" };
  if (opts.dry) return { name: "cards-render-am", wouldDispatch: true };
  try {
    await ghDispatchWithRetry(env, "taiwan-flow-live-v2", "cards.yml", fetchFn, opts.sleepFn || sleep, { slot: "am" });
    if (env.FLOW_KV) await env.FLOW_KV.put(key, bkStateValue("fired", 1), { expirationTtl: BKFIRED_TTL });
    console.log("cards-render-am: 晨間圖卡渲染 dispatched");
    await recordJob(env, tp, "cards-render-am", "fired");
    return { name: "cards-render-am", fired: true };
  } catch (e) {
    console.log("cards-render-am dispatch:", e && e.message);
    await recordJob(env, tp, "cards-render-am", "error", String((e && e.message) || e));
    await alertJob(env, tp, "cards-render-am-err",
      `❌ 晨間圖卡渲染 dispatch 失敗：${String((e && e.message) || e)}（GH 08:40 兜底 cron 仍會跑）`, fetchFn);
    return { name: "cards-render-am", error: String((e && e.message) || e) };
  }
}
// 晨間推播：manifest（data/cards/am/）當日且至少 1 張圖才推——不同於晚間，晨間**沒有**
// 純文字退路（morning2/3/4 資料晚間已推過一輪文字版的等價內容，晨間價值在圖卡本身；
// manifest 整窗等不到就當日不推，KV 不寫、不告警轟炸——渲染失敗已有 cards-render-am 告警）。
// 訊息組成：morning2/3/4 → Flex carousel（≤12 bubbles、<50KB、hero 圖 1024 上限由渲染端保證）
// ＋晨報長文卡 → 單獨 Image message（同 pm-summary-1 慣例）。
export async function pushMorningCards(env, tp, fetchFn = fetch, opts = {}) {
  const nowMin = tp.hour * 60 + tp.minute;
  if (nowMin < CARDS_AM_PUSH_AFTER_MIN) return { name: "cards-am", waiting: "before-08:20" };
  if (nowMin > CARDS_AM_PUSH_UNTIL_MIN) return { name: "cards-am", skipped: "after-08:50" };
  if (!env.LINE_TOKEN || !env.LINE_USER_ID) return { name: "cards-am", skipped: "no-channel" };
  const key = alertedKey(tp.date, "cards-am");
  if (env.FLOW_KV && await env.FLOW_KV.get(key)) return { name: "cards-am", skipped: "already-pushed" };
  // manifest：raw 直抓、帶 ?d= 破快取（GitHub raw CDN ~5 分快取；推播窗僅 30 分，吃舊檔會整窗撲空）
  let manifest = null;
  try {
    const r = await fetchFn(`${env.DATA_BASE}/cards/am/manifest.json?d=${opts.nowMs || Date.now()}`);
    if (r.ok) manifest = await r.json();
  } catch (e) { console.log("cards-am manifest:", e && e.message); }
  const manifestDate = String((manifest || {}).date || "").slice(0, 10);
  const nImgs = manifest && manifest.images && typeof manifest.images === "object"
    ? Object.keys(manifest.images).length : 0;
  // gate：manifest.date===台北今日且至少 1 張圖；未達標＝純等待（零副作用，下輪 10 分後再看）
  if (manifestDate !== tp.date || nImgs < 1) {
    return { name: "cards-am", waiting: "manifest-not-ready",
      manifestDate: manifestDate || null, imgs: nImgs };
  }
  // 卡片資料：與 /cards/data?slot=am 同一套組裝＋新鮮度守門（date/白名單/assertCardAllowed）
  const data = await buildCardsData(env, tp, fetchFn, { ...opts, slot: "am" });
  const cards = data.cards.filter((c) => c.id !== FX_AM_LONGFORM_CARD);
  const hasBrief = data.cards.some((c) => c.id === FX_AM_LONGFORM_CARD);
  const lf = hasBrief ? longformImage(manifest, tp.date, FX_AM_LONGFORM_CARD) : null;
  const imgs = attachCardImages(cards, manifest, tp.date);
  if (!cards.length && !lf) {
    // 卡全數不新鮮（或晨報圖缺且無其他卡）→ 記 skip 短路當日（同晚間 skip-empty 慣例）
    if (env.FLOW_KV) await env.FLOW_KV.put(key, "skip-empty", { expirationTtl: ALERTED_TTL });
    await recordJob(env, tp, "cards-am", "skip-empty", `manifest=${manifestDate} imgs=${nImgs}`);
    return { name: "cards-am", skipped: "no-cards" };
  }
  if (opts.dry) return { name: "cards-am", wouldPush: cards.length, imgs,
    longform: lf ? "attached" : (hasBrief ? "no-image" : "no-card") };
  const messages = [];
  if (cards.length) {
    const ms = buildCardCarousels(cards, "股市雷達 晨間圖卡");
    ms.forEach((m, i) => {
      m.altText = `股市雷達 晨間圖卡 ${i + 1}/${ms.length}｜${tp.date}`.slice(0, 1500);
    });
    messages.push(...ms);
  }
  if (lf && messages.length < 5) {
    messages.push({ type: "image", originalContentUrl: lf.url, previewImageUrl: lf.preview });
  }
  const { url, init } = lineRequest(env.LINE_TOKEN, env.LINE_USER_ID, messages);
  const resp = await fetchFn(url, init);
  if (!resp.ok) {
    // 失敗不寫 KV → 下輪（10 分後）自動重試；接線層（runMorning）負責告警
    await recordJob(env, tp, "cards-am", "error", `LINE HTTP ${resp.status}`);
    throw new Error(`晨間圖卡 LINE push 失敗：HTTP ${resp.status}`);
  }
  if (env.FLOW_KV) await env.FLOW_KV.put(key, "pushed", { expirationTtl: ALERTED_TTL });
  await recordJob(env, tp, "cards-am", "pushed",
    `cards=${cards.length} imgs=${imgs} lf=${lf ? "attached" : (hasBrief ? "no-image" : "no-card")}`);
  return { name: "cards-am", sent: true, cards: cards.length, imgs, longform: !!lf };
}
// 晨場協調班本體：週末守門 → 渲染 dispatch（有 token 才做）→ 推播。兩步各自 try/catch，
// 任何失敗都不影響同一次喚醒裡並行的 runSummaryDispatch(am)。
export async function runMorning(env, tp, fetchFn = fetch, opts = {}) {
  if (tp.dow != null && (tp.dow < 1 || tp.dow > 5)) return { skipped: "non-trading-day" };
  const out = {};
  if (env.GH_DISPATCH_TOKEN) {
    try { out.render = await runCardsRenderAm(env, tp, fetchFn, opts); }
    catch (e) { out.render = { error: String((e && e.message) || e) }; }
  } else out.render = { skipped: "no-token" };
  try { out.push = await pushMorningCards(env, tp, fetchFn, opts); }
  catch (e) {
    out.push = { error: String((e && e.message) || e) };
    await alertJob(env, tp, "cards-am-err",
      `❌ 晨間圖卡：${out.push.error}（KV 未記，下輪自動重試）`, fetchFn);
  }
  return out;
}

// ---- us 晨間補跑班（2026-08-13）：FinMind 美股常態台北 07:30-08:30 才入庫，05:05 主班的
// 12 輪×10 分重試在 06:59 耗盡、永遠搆不到入庫窗（過去靠 GH 備援 cron 的排程延遲「碰巧」
// 推進 07-08 點窗才拿到資料）。掛在既有 summary-am crons #11（*/5 23）/#12（*/10 0）的
// scheduled 分派處（比照 runMorning，不加 cron）：台北 07:00-08:05 檢查 us.json 資料日，
// 未達最近預期美股交易日即 dispatch us.yml（inputs.rounds=2 小輪數快跑）。
// 08:05 後不再觸發（別跟 08:10 的 AM 圖卡渲染窗搶）；台北週日/週一早上不跑
// （美股週末無新資料；週一早上預期=上週五，通常週六已補齊）。
// dedup：KV 每 20 分鐘至多 dispatch 一次（key 含當日＋20 分時段桶），一晨最多 4 次——
// 每次 dispatch 的 us.yml 自帶 2 輪×10 分重試，涵蓋整個入庫窗又不轟炸 Actions。
export const US_CATCHUP_AFTER_MIN = 7 * 60;        // 台北 07:00（入庫窗前緣）
export const US_CATCHUP_UNTIL_MIN = 8 * 60 + 5;    // 台北 08:05（inclusive；之後不再觸發）
export const usCatchupKey = (dateISO, nowMin) =>
  `${bkfiredKey(dateISO, "uscatchup")}:${Math.floor(nowMin / 20)}`;
export async function runUsCatchup(env, tp, fetchFn = fetch, opts = {}) {
  if (!env.GH_DISPATCH_TOKEN) return { name: "us-catchup", skipped: "no-token" };
  const nowMin = tp.hour * 60 + tp.minute;
  if (nowMin < US_CATCHUP_AFTER_MIN || nowMin > US_CATCHUP_UNTIL_MIN)
    return { name: "us-catchup", waiting: "outside-07:00-08:05" };
  if (tp.dow === 0 || tp.dow === 1) return { name: "us-catchup", skipped: "no-new-us-data-sun-mon" };
  const key = usCatchupKey(tp.date, nowMin);
  if (env.FLOW_KV && await env.FLOW_KV.get(key)) return { name: "us-catchup", skipped: "deduped-20min" };
  let obj = null;
  try { obj = await fetchProduct(`${env.DATA_BASE}/us.json`, fetchFn); } catch { /* 抓不到＝不新鮮 */ }
  const expected = lastExpectedUsTradingDate(tp.date);
  const usDate = obj ? String(obj.date || "").slice(0, 10) : null;
  if (usDate && usDate >= expected) return { name: "us-catchup", fresh: true, usDate };
  if (opts.dry) return { name: "us-catchup", wouldDispatch: true, usDate, expected };
  try {
    await ghDispatchWithRetry(env, "taiwan-flow-live-v2", "us.yml", fetchFn, opts.sleepFn || sleep,
      { rounds: "2" });
    if (env.FLOW_KV) await env.FLOW_KV.put(key, bkStateValue("fired", 1), { expirationTtl: BKFIRED_TTL });
    console.log(`us-catchup: us.json(${usDate || "無檔"}) 未達預期美股交易日(${expected}) → dispatched us.yml rounds=2`);
    await recordJob(env, tp, "us-catchup", "fired", `us=${usDate || "無檔"} exp=${expected}`);
    return { name: "us-catchup", fired: true, usDate, expected };
  } catch (e) {
    // dispatch 失敗只 log＋記錄（KV 不寫 → 下一個 20 分桶自動重試；GH 備援 cron 06:10 仍在）
    console.log("us-catchup dispatch:", e && e.message);
    await recordJob(env, tp, "us-catchup", "error", String((e && e.message) || e));
    return { name: "us-catchup", error: String((e && e.message) || e) };
  }
}

// ---- 排程狀態軌跡 jobstat（2026-07-25 P1）----
// 動機：排程決策原本只進 console.log，Worker 日誌不持久＝事後查不到「今天這班到底發生什麼」。
// 只記**狀態轉換**（fired／fresh／produced／error），不記輪詢噪音（skip/waiting）——晚場班
// 每 5 分醒一次，全記的話一天 140+ 筆 KV 寫入且沒有資訊量。實際每日約 15-25 筆。
export const JOBSTAT_TTL = 259200;   // 3 天（比 bkfired 的 2 天長一天，方便隔天早上回頭查昨晚）
export const JOBSTAT_MAX = 120;      // 陣列上限，超過丟最舊（防單日異常暴衝把值撐爆）
export const jobstatKey = (dateISO) => `jobstat:${dateISO.replaceAll("-", "")}`;
export const hhmm = (tp) => `${String(tp.hour ?? 0).padStart(2, "0")}:${String(tp.minute ?? 0).padStart(2, "0")}`;
export async function recordJob(env, tp, name, result, extra) {
  if (!env.FLOW_KV) return false;
  try {
    const key = jobstatKey(tp.date);
    const arr = (await env.FLOW_KV.get(key, "json")) || [];
    arr.push(extra != null ? { t: hhmm(tp), n: name, r: result, x: extra } : { t: hhmm(tp), n: name, r: result });
    await env.FLOW_KV.put(key, JSON.stringify(arr.slice(-JOBSTAT_MAX)), { expirationTtl: JOBSTAT_TTL });
    return true;
  } catch (e) { console.log("recordJob:", e && e.message); return false; }   // 記錄失敗絕不拖垮排程主體
}

// ---- 日終／晨間健檢（2026-07-25 P1）----
// 「有沒有人在看」的最後一道：不 dispatch、不補跑，只盤點當日該有的產物是否落地，缺就告警。
// 涵蓋 recheck 管不到的範圍——① 達 BK_MAX_ATTEMPTS 上限後仍沒落地；② 哨兵事件驅動的
// flows/postmkt、定點班 news、事件驅動 summary（這些班沒有 bkGate recheck）。
// mode：date=日期欄前 10 碼為今日；genToday=generated_at 台北日為今日；exists=當日檔存在即可；
//       usDate=us.json 資料日 ≥ 最近預期美股交易日（見 lastExpectedUsTradingDate）；
//       lowfreq=低頻班（週頻／月頻），只在該檢查的日子檢查、判準見 lowFreqDue。

// ---- 低頻班健檢（2026-08-30 C5）----
// 使用者裁定的範圍：lastweek（週一）與 meta（每月第一個週六）**只納健檢告警**，
// 不納 backupPipelines、不新增任何 CF cron。理由：自動補發要在 productFresh 新增週頻／月頻
// 判準模式、2~4 條 CF cron，外加交易日守門例外（lastweek 排台北週一 09:00，但 frame
// series:<date> 最早 09:05 才有第一格，tw:true 會誤判成非交易日）。低頻班漏一次不急迫，
// 人工 workflow_dispatch 即可，不值得為它動全系統排程中樞。
// 判準**刻意不進 productFresh**：那支是備援補發路徑（runBackup）共用的，加進沒人用的
// 週頻／月頻分支只是把風險帶進補發路徑；改在健檢端（healthVerdict + runHealthCheck 過濾）特例處理，
// 成本只有一支純函式，且完全不碰既有補發語意。

// 某月第一個週六（純函式，回 YYYY-MM-DD）：meta.yml 用「每週六觸發＋UTC 日 ≤7 守門」表達
// 「每月第一個週六」，其 UTC 00:00＝台北 08:00 同日，故台北日與 UTC 日一致。
export function firstSaturdayISO(dateISO) {
  const ym = dateISO.slice(0, 8);                                   // "YYYY-MM-"
  const dow1 = new Date(`${ym}01T00:00:00Z`).getUTCDay();           // 該月 1 號星期幾（0=日）
  return `${ym}${String(1 + ((6 - dow1 + 7) % 7)).padStart(2, "0")}`;
}
// 低頻班的「今天該不該檢查」＋新鮮度基準日（純函式）：
//   回 null＝今天不檢查這項（runHealthCheck 直接濾掉，連抓都不抓）；
//   回 YYYY-MM-DD＝今天要檢查，且產物 generated_at 的台北日 ≥ 該日才算落地。
// 只掛台北週一的 **eve 班（23:50）**，不掛 morn（09:30）：lastweek.yml 排台北週一 09:00，
// 但 GitHub cron 常態延遲 1~2 小時（2026-08-24 實測 10:19:32 才落地），09:30 檢查必然每週誤報。
// 週一以外一律不檢查——低頻班天天檢查就是天天告警，會磨掉告警可信度。
export function lowFreqDue(name, dateISO) {
  if (new Date(`${dateISO}T00:00:00Z`).getUTCDay() !== 1) return null;   // 只在（台北）週一檢查
  if (name === "lastweek") return dateISO;                               // 當日 09:00 產出、23:50 檢查
  if (name === "meta") {
    // 每月第一個週六產出 → 該週六起算兩天後（＝週一）的每個週一都檢查一次：
    // 健康時零告警，真的沒跑時一個月最多叫 4 次（每週一一次），不是天天叫。
    const first = firstSaturdayISO(dateISO);
    return dateISO >= addDaysISO(first, 2) ? first : null;               // 本月還沒輪到 → 不檢查
  }
  return null;
}
export function healthTargets(env) {
  const V2 = env.DATA_BASE;
  const FLOWS = "https://raw.githubusercontent.com/shihpc/taiwan-flows/main/data/latest.json";
  const NEWS = "https://raw.githubusercontent.com/shihpc/taiwan-stock-news/main/news.json";
  return {
    eve: [
      { name: "daysummary", url: `${V2}/daysummary/latest.json`, field: "date",         mode: "date" },
      { name: "aetf",       url: `${V2}/aetf/latest.json`,       field: "run_date",     mode: "date" },
      { name: "baseline",   url: `${V2}/baseline.json`,          field: "date",         mode: "date" },
      { name: "intraday",   url: `${V2}/intraday/{date}.json`,   field: "date",         mode: "date" },
      { name: "flows",      url: FLOWS,                          field: "date",         mode: "date" },
      { name: "postmkt",    url: `${POSTMKT_BASE}/data/postmkt.json`,                    field: "date",         mode: "date" },
      { name: "diag",       url: `${POSTMKT_BASE}/data/diag/diag.json`,                  field: "date",         mode: "date" },
      { name: "mktbal",     url: `${POSTMKT_BASE}/data/market_balance_history.json`,     field: "latest_date",  mode: "date" },
      { name: "news",       url: NEWS,                           field: "generated_at", mode: "genToday" },
      { name: "summary-pm", url: `${POSTMKT_BASE}/data/summary/{ymd}-pm.json`,           field: null,           mode: "exists" },
      // 低頻班（見上方 lowFreqDue）：非該檢查的日子由 runHealthCheck 濾掉，不抓也不計入 checked
      { name: "lastweek",   url: `${V2}/lastweek.json`,          field: "generated_at", mode: "lowfreq" },
      { name: "meta",       url: `${V2}/classify.json`,          field: "generated_at", mode: "lowfreq" },
    ],
    morn: [
      { name: "morning",    url: `${V2}/morning.json`,           field: "generated_at", mode: "genToday" },
      // us（2026-08-13 改 usDate）：資料日 ≥ 最近預期美股交易日才算落地（美國國定假日會誤報
      // 一次 stale 告警，屬可接受誤差——與 gradeMarket 對台股假日同一套簡化立場）
      { name: "us",         url: `${V2}/us.json`,                field: "date",         mode: "usDate" },
      { name: "summary-am", url: `${POSTMKT_BASE}/data/summary/{ymd}-am.json`,           field: null,           mode: "exists" },
    ],
  };
}
// 單項判定（純函式）：ok=已落地；at=產物上的時間（給告警文字用，抓不到檔回 null）
export function healthVerdict(t, obj, today) {
  if (t.mode === "exists") return { ok: !!obj, at: obj ? "有檔" : null };
  if (t.mode === "lowfreq") {
    const due = lowFreqDue(t.name, today);
    if (!due) return { ok: true, at: null, skipped: "not-due" };   // 今天不是該檢查的日子
    const g = obj ? obj[t.field] : null;
    const at = g ? new Date(g) : null;
    const genDay = at && !isNaN(at.getTime()) ? taipeiParts(at).date : null;
    return { ok: !!genDay && genDay >= due, at: String(g || "").slice(0, 19) || null, due };
  }
  if (!obj) return { ok: false, at: null };
  return { ok: productFresh(obj, t, today), at: String(obj[t.field] || "").slice(0, 19) || null };
}
export function healthUrl(t, today) {
  return t.url.replace("{date}", today).replace("{ymd}", today.replaceAll("-", ""));
}
// 一輪健檢：併發抓全部產物 → 缺件清單 → 告警（opts.dry 只回結果不告警、不記錄）。
// **刻意不拿 series 當守門**：其他班用「當日 series 存在＝交易日」是合理的，但健檢是看門狗——
// 拿一個可能自己壞掉的訊號當守門，等於故障時把看門狗一起弄瞎（2026-07-25 實例：07-24 整天
// 沒有任何 frame/series，所有 TW 主觸發被守門靜默跳過、系統退化成只剩延遲的 GH cron，
// 若健檢也照守門就同樣不會叫）。改成：series 缺只當「提示」寫進告警，照樣盤點照樣叫。
// 代價＝國定假日會誤報一次（每年約 10 次，訊息會標「無盤中 series，可能為休市」，一眼可辨），
// 換到的是「真故障一定叫得出來」。
export async function runHealthCheck(env, tp, slot, fetchFn = fetch, opts = {}) {
  const today = tp.date;
  let noSeries = false;
  if (env.FLOW_KV) {
    const series = await env.FLOW_KV.get(`series:${today}`, "json");
    noSeries = !series || !series.length;
  }
  // 低頻班：今天不到期就整項濾掉（不抓、不計入 checked、不可能誤報）
  const targets = (healthTargets(env)[slot] || [])
    .filter((t) => t.mode !== "lowfreq" || lowFreqDue(t.name, today));
  const rows = await Promise.all(targets.map(async (t) => {
    const obj = await fetchProduct(healthUrl(t, today), fetchFn).catch(() => null);
    return { name: t.name, ...healthVerdict(t, obj, today) };
  }));
  const missing = rows.filter((r) => !r.ok);
  const label = missing.map((m) => `${m.name}(${m.at || "無檔"})`);
  const out = { slot, date: today, checked: rows.length, noSeries, missing: label, rows };
  if (opts.dry) return out;
  if (missing.length) {
    // series 缺＝要嘛休市、要嘛盤中 frame 班故障（後者會連帶讓所有 TW 主觸發靜默跳過），
    // 兩種都該讓使用者一眼看到，所以直接寫進告警文字。
    const note = noSeries ? "（無盤中 series，可能為休市或 frame 班故障）" : "";
    await alertJob(env, tp, `health-${slot}`,
      `🩺 ${slot === "eve" ? "日終" : "晨間"}健檢：${missing.length}/${rows.length} 項未落地${note} — ${label.join("、")}`, fetchFn);
  }
  await recordJob(env, tp, `health-${slot}`, missing.length ? `missing:${missing.length}` : "all-ok",
    missing.length ? label.join(",") : undefined);
  return out;
}

// ---- 第九期：離線提醒（盤中事件偵測 → webhook 外送；頁面關著也能收到）----
// 誠實前提：只推「有依據」的保守事件集，訊號擴充等 8 月 7b 回測結果。
//   ①加權指數 5 分變動 ≥ 門檻（預設 40 點）——大盤大幅波動，門檻 KV 可調（alerts:cfg）
//   ②晨報「連湧」次產業（morning.json signals.cont_subs，已驗證多日連湧訊號打底）
//     近30分佔比 − 全日佔比 ≥ 門檻（預設 3pp）——已在湧清單上的次產業盤中再度放量
// 排程：併入既有每分鐘 frame 班（cron 上限 3 條已滿，不新增 cron），storeFrame 成功後跑，
//   偵測失敗不影響 frame 主體。無 ALERT_WEBHOOK secret 時偵測照跑、只記 log 不外送（靜默）。
// KV 額度（免費 write 1000/日 精打細算）：
//   讀：cfg+series 每分鐘 2 get；連湧清單非空時另 fi+cur+old 3 get；有候選事件才讀 log 1 get
//       → 盤中 ~270 分 × ≤6 get ≈ 1,600/日，遠低於免費 10 萬/日
//   寫：僅「去重後有新事件」才 put alerts:log 一次（30 分去重 → 典型 0~10 次/日）
// 通道：(a) Email——不可行（Cloudflare Email Sending 需 onboard 自有網域 zone 配 SPF/DKIM，
//   本帳戶無自有網域，全系統站點皆 GitHub Pages / workers.dev；不為此動帳戶層設定）。
//   (b) 通用 webhook：secret ALERT_WEBHOOK，Discord 格式 {content}；
//   URL host 為 api.telegram.org 時自動改 Telegram sendMessage 格式 {chat_id, text}。
//   (c) LINE（LINE Notify 已於 2025-03 終止 → 走 Messaging API bot push）：
//   secrets LINE_TOKEN（channel access token）＋LINE_USER_ID 兩者齊全才發；
//   userId 靠 /line/webhook 一次性擷取（KV line:uid，變化才寫）。通道可並存（都設就都發）。

const ALERTS_LOG_KEY = "alerts:log";
const ALERTS_CFG_KEY = "alerts:cfg";
const ALERTS_DEFAULT_CFG = { idx5: 40, subpp: 3 };
const ALERTS_DEDUP_MIN = 30;

// 事件①：加權指數 5 分變動（純函式；series = [{t,amt,idx,chg}...]，hm = 當前分鐘）
export function detectIdxEvent(series, hm, cfg) {
  const arr = series || [];
  if (!arr.length) return [];
  const nowP = arr[arr.length - 1];
  if (!nowP || nowP.t !== hm || nowP.idx == null) return [];   // 最新點不是本分鐘 → 不判（避免斷檔誤判）
  const nowMin = hm2min(hm);
  let ref = null;   // 取「最接近 now-5 且不早於 now-8」的點（容忍偶發漏格，斷檔過久不判）
  for (const p of arr) {
    const m = hm2min(p.t);
    if (m <= nowMin - 5 && m >= nowMin - 8 && p.idx != null) ref = p;
  }
  if (!ref) return [];
  const diff = r1(nowP.idx - ref.idx);
  if (Math.abs(diff) < (cfg.idx5 || ALERTS_DEFAULT_CFG.idx5)) return [];
  const up = diff > 0;
  return [{ id: up ? "idx5-up" : "idx5-dn",
    msg: `加權指數 5 分${up ? "急漲" : "急跌"} ${Math.abs(diff)} 點（${ref.t} ${ref.idx} → ${nowP.t} ${nowP.idx}）` }];
}
// 事件②：連湧次產業近30分佔比 − 全日佔比 ≥ subpp（純函式）
// cur/old = frame 物件 {code:[累計額,價], _ts, _stale?}；cl = classify map；surge = 連湧清單
export function detectSubEvents(cur, old, cl, surge, cfg) {
  if (!cur || !old || !surge || !surge.length) return [];
  if (cur._stale || old._stale) return [];
  if (cur._ts && old._ts && cur._ts === old._ts) return [];   // 上游時戳停滯 → Δ 全 0，不判（07-16 教訓）
  const want = new Set(surge);
  const subCum = {}, subD = {};
  let mktCum = 0, mktD = 0;
  for (const code in cur) {
    if (code.startsWith("_")) continue;                        // 保留 meta 鍵
    const a1 = frAmt(cur[code]);
    if (a1 == null) continue;
    mktCum += a1;
    const a0 = frAmt(old[code]);
    const d = a0 != null && a1 >= a0 ? a1 - a0 : null;
    if (d != null) mktD += d;
    const info = cl[code];
    if (!info || !info.p) continue;
    for (const s of new Set(info.p.map((p) => p[1]))) {
      if (!want.has(s)) continue;
      subCum[s] = (subCum[s] || 0) + a1;
      if (d != null) subD[s] = (subD[s] || 0) + d;
    }
  }
  if (!(mktCum > 0) || !(mktD > 0)) return [];
  const out = [];
  const thr = cfg.subpp || ALERTS_DEFAULT_CFG.subpp;
  for (const s of surge) {
    const s30 = ((subD[s] || 0) / mktD) * 100;
    const sDay = ((subCum[s] || 0) / mktCum) * 100;
    if (s30 - sDay >= thr)
      out.push({ id: `sub-${s}`,
        msg: `連湧次產業「${s}」近30分佔比 ${r1(s30)}%，高於全日 ${r1(sDay)}%（+${r1(s30 - sDay)}pp）` });
  }
  return out;
}
// 30 分去重（純函式）：同 id 事件 30 分內只發一次；logArr = [{ts(epoch ms), id, ...}]
export function dedupAlerts(events, logArr, nowMs) {
  const last = {};
  for (const e of logArr || []) if (e.id) last[e.id] = Math.max(last[e.id] || 0, e.ts || 0);
  return (events || []).filter((e) => !(last[e.id] && nowMs - last[e.id] < ALERTS_DEDUP_MIN * 60e3));
}
// webhook 請求建構（純函式，可離線驗格式）：Discord {content}；Telegram {chat_id,text}
export function webhookRequest(urlStr, text) {
  let body = { content: text };
  try {
    const u = new URL(urlStr);
    if (u.hostname === "api.telegram.org")
      body = { chat_id: u.searchParams.get("chat_id"), text };
  } catch { /* URL 異常照 Discord 格式送，由對端回錯 */ }
  return { url: urlStr, init: { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } };
}
// LINE Messaging API push 請求建構（純函式，可離線驗格式）
// 第二參數可為字串（既有呼叫端，包成 text message）或 message object 陣列（Flex 圖卡用）
export function lineRequest(token, userId, textOrMessages) {
  const messages = Array.isArray(textOrMessages)
    ? textOrMessages : [{ type: "text", text: textOrMessages }];
  return { url: "https://api.line.me/v2/bot/message/push", init: { method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ to: userId, messages }) } };
}

// ---- LINE Flex 圖卡渲染層（2026-07-28，規格：docs/line-cards-spec.md）----
// 全部純函式、無 I/O。卡片資料物件 → Flex bubble/carousel JSON。
// 卡片資料形狀：{ id, title, sub, rows:[{l,m,r,c}], paras:[str], note, foot }
//   rows＝三欄資料列（代號/名稱/數值，c=顏色鍵）；paras＝純文字段（看板卡）；兩者可並用。
//   note/foot＝卡底口徑註記（B 類排行卡 note 必填：標明排序欄位，見規格 3B.2）。
export const FX_COLORS = { up: "#D5342F", down: "#12855A", neutral: "#8A8F93", muted: "#9AA0A3" };
// 誠實原則守門（規格第 4 節）：卡面禁用字。建構時擋＋測試字串比對雙保險。
// 「Top 1」含空格的變體也擋（2026-07-28 驗收抓漏）。獨立的「建議」「關注」刻意不入清單：
// 誤殺面太大（「外資關注度」等中性句），pm-aetf-1 解鎖時另以卡別專屬檢查處理其文案。
export const FX_FORBIDDEN = ["第1名", "第一名", "Top1", "TOP1", "Top 1", "TOP 1", "最強", "最弱",
  "必漲", "必跌", "該買", "該賣", "買進", "賣出", "建議關注", "值得關注", "訊號明確", "看多", "看空"];
// 長文摘要卡（2026-08-07）：走**獨立 Image message**，不進 Flex carousel——
// 全文約 2000 字，Flex hero 的 1024×1024 與 3:1 aspectRatio 都塞不下（實測縮完
// 有效字級 7.5px 不可讀）。故不列入 FX_ACTIVE_CARDS，另由 FX_LONGFORM_CARD 走專用管道。
export const FX_LONGFORM_CARD = "pm-summary-1";
// 禁用字中性化：比照既有 fxSanitize 的精神——命中就換成描述性中性詞，而非整張剔除。
// LLM 生成的 2000 字踩中黑名單的機率遠高於人工短文案，整張丟等於該卡常態消失。
// 換完仍交給 assertCardAllowed 當最後防線（使用者 2026-08-07 定案：禁用字排除照樣適用）。
export const FX_NEUTRALIZE = {
  "最強": "最大", "最弱": "最小", "第一名": "居首", "第1名": "居首", "Top1": "居首",
  "TOP1": "居首", "Top 1": "居首", "TOP 1": "居首", "必漲": "偏強", "必跌": "偏弱",
  "該買": "偏多", "該賣": "偏空", "買進": "偏多", "賣出": "偏空",
  "看多": "偏多解讀", "看空": "偏空解讀", "建議關注": "可留意", "值得關注": "可留意",
  "訊號明確": "訊號清楚",
};
export function fxNeutralize(text) {
  let t = String(text || "");
  for (const w of Object.keys(FX_NEUTRALIZE).sort((a, b) => b.length - a.length)) {
    t = t.split(w).join(FX_NEUTRALIZE[w]);
  }
  return t;
}
// C 類訊號卡白名單守門（規格 3B.3/6）：回測結論產出前不得上線。
// 解鎖條件：alpha sweep AS-01~04 通過（前四張）；pm-aetf-1 另需文案改寫完成。
export const FX_BLOCKED_CARDS = new Set(
  ["flows-sync-1", "flows-sync-2", "flows-oppose-1", "flows-oppose-2", "pm-aetf-1"]);
export const FX_DISCLAIMER =
  "技術指標為現況描述、非買賣訊號，僅供參考。排序來自歷史統計的分層傾向，經回測確認不具單調性——名次先後不代表強弱高低。不預測後續走勢。";

const fxText = (text, o = {}) => ({ type: "text", text: String(text), wrap: true, ...o });
// KB 上限一律量 UTF-8 位元組——JSON.stringify().length 是 UTF-16 字元數，中文 1 字 3 bytes，
// 用字元數守門會鬆 3 倍（2026-07-28 驗收抓到的實 bug）。
const utf8len = (s) => new TextEncoder().encode(s).length;
// 誠實原則＋C 類守門，Flex 與純文字降級版共用——違規內容不得從任何通道漏出
export function assertCardAllowed(card) {
  const bad = FX_FORBIDDEN.filter((w) =>
    JSON.stringify([card.title, card.sub, card.paras, card.note, card.foot]).includes(w));
  if (bad.length) throw new Error(`卡 ${card.id} 含禁用字: ${bad.join(",")}`);
  if (FX_BLOCKED_CARDS.has(card.id)) throw new Error(`卡 ${card.id} 屬 C 類，回測未過不得上線`);
}
export function fxRow(r) {
  const cols = [];
  if (r.l != null) cols.push(fxText(r.l, { flex: 2, size: "xxs", color: FX_COLORS.muted }));
  cols.push(fxText(r.m, { flex: 5, size: "sm" }));
  // r2＝張數次要值：與金額同格右對齊、小字灰（金額仍是主要值，張數是佐證量體）
  if (r.r2 != null) {
    cols.push({ type: "box", layout: "vertical", flex: 4, contents: [
      fxText(r.r, { size: "sm", align: "end", weight: "bold",
        color: FX_COLORS[r.c] || FX_COLORS.neutral }),
      fxText(r.r2, { size: "xxs", align: "end", color: FX_COLORS.muted }),
    ] });
  } else {
    cols.push(fxText(r.r, { flex: 3, size: "sm", align: "end", weight: "bold",
      color: FX_COLORS[r.c] || FX_COLORS.neutral }));
  }
  return { type: "box", layout: "horizontal", spacing: "sm", contents: cols };
}
export function cardBubble(card) {
  assertCardAllowed(card);
  // PNG hero 版（spec 3C 呈現層改向）：card.img（HTTPS，pushDailyCards 由 manifest 掛上）
  // → hero 圖＋body 精簡（title＋資料日＋note/foot）——rows/paras 的數字都在圖裡，不重複。
  // 卡物件本身仍保留 rows/paras：cardsFallbackText 純文字退路照用，內容不因有圖而變薄。
  const hasImg = typeof card.img === "string" && card.img.startsWith("https://");
  const body = [fxText(card.title, { weight: "bold", size: "md" })];
  if (card.sub) body.push(fxText(card.sub, { size: "xxs", color: FX_COLORS.muted }));
  if (!hasImg) {
    for (const p of card.paras || []) body.push(fxText(p, { size: "sm", margin: "md" }));
    if ((card.rows || []).length) body.push({ type: "box", layout: "vertical", spacing: "xs",
      margin: "md", contents: card.rows.map(fxRow) });
  }
  const foot = [card.note, card.foot].filter(Boolean);
  if (foot.length) body.push({ type: "separator", margin: "md" },
    fxText(foot.join("\n"), { size: "xxs", color: FX_COLORS.muted, margin: "sm" }));
  const b = { type: "bubble", size: "kilo",
    ...(hasImg ? { hero: { type: "image", url: card.img, size: "full",
      aspectRatio: /^\d+:\d+$/.test(card.imgRatio || "") ? card.imgRatio : "3:4",
      aspectMode: "cover" } } : {}),
    body: { type: "box", layout: "vertical", contents: body } };
  const bytes = utf8len(JSON.stringify(b));
  if (bytes >= 30000) throw new Error(`卡 ${card.id} bubble ${bytes}B（UTF-8）達 30KB 上限`);
  return b;
}
export function disclaimerBubble() {
  return cardBubble({ id: "_disclaimer", title: "關於這份清單",
    paras: [FX_DISCLAIMER], foot: "口徑與回測依據：backtest/report_sorting.md" });
}
// 卡片陣列 → messages 陣列（每 carousel ≤12 bubble、≤50KB；≤5 message）。
// 2026-08-16（使用者指示）：不再壓底免責卡——disclaimerBubble／FX_DISCLAIMER 保留
// （純文字降級版 cardsFallbackText 仍帶免責句），只有 carousel 不再附這張卡。
export function buildCardCarousels(cards, altText) {
  const bubbles = cards.map(cardBubble);
  const messages = [];
  for (let i = 0; i < bubbles.length; i += 12) {
    const contents = bubbles.slice(i, i + 12);
    const c = { type: "carousel", contents };
    const bytes = utf8len(JSON.stringify(c));
    if (bytes >= 50000) throw new Error(`carousel#${messages.length} ${bytes}B（UTF-8）達 50KB 上限`);
    messages.push({ type: "flex",
      altText: String(altText || "股市雷達 盤後圖卡").slice(0, 1500), contents: c });
  }
  if (messages.length > 5) throw new Error(`messages ${messages.length} 超過一次 push 上限 5`);
  return messages;
}
// 純文字降級版（webhook 通道用；Flex 建構丟例外時 LINE 也退這份，規格 5.3）
// 同樣過 assertCardAllowed——降級是為版型錯誤設計的退路，不是誠實原則的漏洞；
// 發送層應先逐卡過濾（過不了的卡整張剔除），再把剩餘卡分別餵兩條路徑。
export function cardsFallbackText(cards, dateStr) {
  for (const c of cards) assertCardAllowed(c);
  const L = [`【股市雷達 盤後圖卡】${dateStr || ""}`];
  for (const c of cards) {
    L.push(`■ ${c.title}${c.sub ? `（${c.sub}）` : ""}`);
    for (const p of c.paras || []) L.push(`  ${p}`);
    for (const r of (c.rows || []).slice(0, 5))
      L.push(`  ${r.l != null ? r.l + " " : ""}${r.m}  ${r.r}${r.r2 ? ` / ${r.r2}` : ""}`);
  }
  L.push(`※ ${FX_DISCLAIMER}`);
  return L.join("\n");
}
// 外送：通道可並存（webhook 與 LINE 都設就都發）；單通道失敗不擋另一通道（errors 帶回）；
// 全部未設 → {sent:false}（靜默，不打任何外部請求）
export async function sendAlert(env, text, fetchFn = fetch) {
  const jobs = [];
  if (env.ALERT_WEBHOOK) jobs.push(["webhook", webhookRequest(env.ALERT_WEBHOOK, text)]);
  if (env.LINE_TOKEN && env.LINE_USER_ID) jobs.push(["line", lineRequest(env.LINE_TOKEN, env.LINE_USER_ID, text)]);
  if (!jobs.length)
    return { sent: false, reason: "未設定通道（wrangler secret put ALERT_WEBHOOK，或 LINE_TOKEN＋LINE_USER_ID）" };
  const ok = [], errs = [];
  for (const [name, { url, init }] of jobs) {
    try {
      const r = await fetchFn(url, init);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      ok.push(name);
    } catch (e) { errs.push(`${name}: ${String(e && e.message || e)}`); }
  }
  const out = { sent: ok.length > 0, channels: ok };
  if (errs.length) out.errors = errs;
  return out;
}
// ---- 排程告警（2026-07-25）：沿用上面第九期三通道，接到「排程失敗」路徑 ----
// 原本 sendAlert 只服務盤中價格事件，排程班別失敗全靠 console.log——Worker 日誌不持久，
// 等於沒人在看（07-16/17 斷檔兩天無人知的同型問題）。這裡把它接到 dispatch 失敗與
// recheck 補發兩個路徑上。防噪：每日每 tag 至多一則（KV alerted:<date>:<tag>），
// 因為 runChain/runEvening 是每 5 分輪詢，同一個故障一晚會撞上 30+ 次。
// 通道未設 → sendAlert 回 {sent:false} 靜默，不打任何外部請求（不影響既有行為）。
export const ALERTED_TTL = 172800;
export const alertedKey = (dateISO, tag) => `alerted:${dateISO.replaceAll("-", "")}:${tag}`;
export async function alertJob(env, tp, tag, text, fetchFn = fetch) {
  if (tp.dow != null && (tp.dow < 1 || tp.dow > 5)) return { skipped: "weekend" };
  try {
    const key = alertedKey(tp.date, tag);
    if (env.FLOW_KV && await env.FLOW_KV.get(key)) return { skipped: "already-alerted" };
    const res = await sendAlert(env, `【排程】${text}`, fetchFn);
    if (env.FLOW_KV) await env.FLOW_KV.put(key, "1", { expirationTtl: ALERTED_TTL });
    return res;
  } catch (e) {   // 告警自己失敗絕不能拖垮排程主體
    console.log("alertJob:", e && e.message);
    return { error: String((e && e.message) || e) };
  }
}
// ---- LINE 圖卡資料組裝層（Phase B1，2026-07-28，規格：docs/line-cards-spec.md 第 9 節）----
// buildDailyCards(src) 純函式：無 fetch、無 KV、無 Date.now（日期一律取各資料源自帶的日期欄）。
// src＝發送層 fetch 好的 13 支 JSON 物件包：{daysummary, baseline, morning, us, lastweek,
//   aetfLatest, aetfDiff, flowsLatest, totals, foreignHistory, flowsDaily, postmkt, mktbal,
//   vix, dateStr}，任何鍵可為 null。回傳 {cards:[卡片資料物件], skipped:[{id,reason}]}。
// 每張卡獨立組裝、獨立失敗：來源缺欄→該卡進 skipped，絕不擋其他卡。
// C 類 5 張（FX_BLOCKED_CARDS）與第二期兩張圖表卡（v2-ov-9/10）不在此組——共 33 張。

const FX_ROWS_MAX = 8;
const fxR1 = (v) => { const s = (Math.round(v * 10) / 10).toFixed(1); return s === "-0.0" ? "0.0" : s; };
const fxSgn = (v, unit = "") => `${v > 0 ? "+" : ""}${fxR1(v)}${unit}`;
const fxC = (v) => (v > 0 ? "up" : v < 0 ? "down" : "neutral");
// 張數次要值（row.r2，個股金額卡附註）：帶正負號＋千分位（en-US 固定分組，確定性輸出）
const fxLots = (v) => `${v > 0 ? "+" : ""}${Math.round(v).toLocaleString("en-US")}張`;
const fxYiK = (k) => k / 1e5;   // 千元 → 億元
const fxYi = (v) => v / 1e8;    // 元 → 億元
const fxNeed = (v, what) => { if (v == null) throw new Error(`${what} 缺`); return v; };
// 上游生成文案（如 daysummary.tone）可能含 FX_FORBIDDEN 字（實檔 tone 有「貢獻最強」），
// 卡面前先做同義中性替換，否則 assertCardAllowed 會把整張卡打掉。
const fxSanitize = (t) => String(t).replaceAll("最強", "最大").replaceAll("最弱", "最小");

// 陣列守門：來源「非 null 但形狀壞」（rows=42、buy_by_amt={}）時退空陣列——
// 沒有這層，單一源半寫壞會讓共用 ctx 建構拋例外、33 張全滅（B1 驗收 A2 缺口）
const fxArr = (x) => (Array.isArray(x) ? x : []);
// 代號→名稱：flowsDaily／baseline 皆無名稱欄（實檔確認），從其餘來源湊；查不到回退代號。
export function fxNameMap(s) {
  const m = new Map();
  const add = (r, ck, nk) => { if (r && r[ck] != null && r[nk] && !m.has(String(r[ck]))) m.set(String(r[ck]), String(r[nk])); };
  for (const pg of ["foreign", "trust"])
    for (const k of ["buy_by_amt", "sell_by_amt", "buy_by_chg", "sell_by_chg", "buy_by_vol", "sell_by_vol"])
      for (const r of fxArr((s.flowsLatest && s.flowsLatest.pages && s.flowsLatest.pages[pg] || {})[k])) add(r, "code", "name");
  for (const r of fxArr((s.postmkt && s.postmkt.lending || {}).rows)) add(r, "c", "n");
  for (const r of fxArr((s.postmkt && s.postmkt.blocktrade || {}).rows)) add(r, "c", "n");
  for (const r of fxArr((s.aetfDiff || {}).stocks)) add(r, "c", "n");
  for (const k of ["stocks_top5", "stocks_bot3"]) for (const r of fxArr((s.daysummary || {})[k])) add(r, "c", "n");
  for (const k of ["it3", "it3_sell"]) for (const r of fxArr((s.morning && s.morning.chips || {})[k])) add(r, "c", "n");
  return m;
}
// flows daily 檔（cols+rows 陣列表）→ 代號索引。cols 見 taiwan-flows CLAUDE.md 尾（張/千元/%）。
export function fxFlowsIndex(fd) {
  if (!fd || !Array.isArray(fd.cols) || !Array.isArray(fd.rows)) return null;
  const ci = {}; fd.cols.forEach((c, i) => { ci[c] = i; });
  const map = new Map();
  for (const r of fd.rows) map.set(String(r[ci.code]), r);
  return { date: fd.date, ci, map,
    get(code, field) { const r = map.get(String(code)); const i = ci[field];
      return r && i != null ? r[i] : null; } };
}
// Regime 判定（規格 9.1.6）：totals.rows[date].taiex 取最近 20 個非 null 值算 MA（含最新日），
// 收盤>MA=bull。資料不足 20 筆→視為 bull（保守：不抑制）並由卡 note 標「regime 未判定」。
export function fxRegime(totals) {
  const dates = fxArr(totals && totals.dates);
  const vals = [];
  for (const d of dates) {
    const v = totals && totals.rows && totals.rows[d] ? totals.rows[d].taiex : null;
    if (v != null) vals.push(v);
  }
  const w = vals.slice(-20);
  if (w.length < 20) return { regime: "bull", undetermined: true };
  const ma = w.reduce((a, b) => a + b, 0) / w.length;
  return { regime: w[w.length - 1] > ma ? "bull" : "bear", undetermined: false };
}
const fxRegimeNote = (ctx) => ctx.regime.undetermined
  ? "regime 未判定（TAIEX 有效序列不足 20 筆，保守視為多頭不抑制）" : null;

// ---- 訊號卡 6 張（baseline.json；stocks: [a5,it,fi,y1,y2,ints,nl,its,nh,a20]、
//      subs_y: {sub:[y1,y2,C,R]}——Phase A 後 schema，src/build_baseline.py:4-22）----
function fxCardSubSurge(s, ctx) {   // 卡1 次產業湧入：subs_y y1==1，依 R 降序（分離度 0.97%）
  if (ctx.regime.regime === "bear") return { skip: "regime-bear" };
  const b = fxNeed(s.baseline, "baseline");
  const subs = Object.entries(b.subs_y || {}).filter(([, v]) => v && v[0] === 1);
  if (!subs.length) return { skip: "今日無次產業湧入訊號" };
  subs.sort((a, b2) => ((b2[1][3] ?? -Infinity) - (a[1][3] ?? -Infinity)));
  const rows = subs.slice(0, FX_ROWS_MAX).map(([n, v]) => ({ m: n,
    r: v[3] == null ? "R —" : `R ${fxSgn(v[3] * 100, "%")}`, c: v[3] == null ? "neutral" : fxC(v[3]) }));
  return { title: "次產業湧入", sub: `資料日 ${b.date}`, rows,
    note: ["依成員等權漲跌 R 降序，歷史分離度 0.97%、非單調", fxRegimeNote(ctx)].filter(Boolean).join("；") };
}
// 回測母體＝訊號日成交額 ≥1 億（run_sorting.py LIQ=1e8）。個股訊號卡（2-6）必須鏡像
// 同一過濾，否則低流動股的比率型欄位（ints 等）天然灌爆、榜面被冷門股佔據
// （2026-07-29 首晚實推即中此雷）。首選 flowsDaily 當日 amt（千元＝回測同口徑），
// flows 缺時退 baseline a5（5日均額，元）近似。
const fxLiqOk = (ctx, code, a) => {
  const amt = ctx.flows ? ctx.flows.get(code, "amt") : null;
  if (amt != null) return amt * 1000 >= 1e8;
  return ((a && a[0]) || 0) >= 1e8;
};
function fxCardDualBuy(s, ctx) {    // 卡2 土洋同買：y1==1 ∩ it≥2 ∩ fi≥2，依 flowsDaily f_amt 降序
  if (ctx.regime.regime === "bear") return { skip: "regime-bear" };
  const b = fxNeed(s.baseline, "baseline");
  const fl = fxNeed(ctx.flows, "flowsDaily");
  const hits = Object.entries(b.stocks || {}).filter(([c, a]) =>
    a && a[3] === 1 && a[1] >= 2 && a[2] >= 2 && fxLiqOk(ctx, c, a));
  if (!hits.length) return { skip: "今日無土洋同買訊號" };
  const list = hits.map(([c]) => ({ c, f: fl.get(c, "f_amt"), n: fl.get(c, "f_net") }));
  list.sort((a, b2) => ((b2.f ?? -Infinity) - (a.f ?? -Infinity)));
  const rows = list.slice(0, FX_ROWS_MAX).map((o) => ({ l: o.c, m: ctx.names.get(o.c) || o.c,
    r: o.f == null ? "—" : fxSgn(fxYiK(o.f), "億"), c: o.f == null ? "neutral" : fxC(o.f),
    ...(o.n != null ? { r2: fxLots(o.n) } : {}) }));
  return { title: "土洋同買", sub: `資料日 ${b.date}`, rows,
    note: ["依外資當日買超金額降序（歷史 Q1 中位數 +1.74%）、非單調", fxRegimeNote(ctx)].filter(Boolean).join("；") };
}
function fxCardNewHigh(s, ctx) {    // 卡3 突破新高：nh==1，依法人買強度 ints 降序（分離度 0.92%）
  const b = fxNeed(s.baseline, "baseline");
  const entries = Object.entries(b.stocks || {});
  if (!entries.some(([, a]) => Array.isArray(a) && a.length >= 9))
    throw new Error("baseline 缺 nh 欄（Phase A schema 未落地）");
  const hits = entries.filter(([c, a]) => a && a[8] === 1 && fxLiqOk(ctx, c, a));
  if (!hits.length) return { skip: "今日無突破20日新高" };
  hits.sort((x, y) => ((y[1][5] ?? -Infinity) - (x[1][5] ?? -Infinity)));
  const rows = hits.slice(0, FX_ROWS_MAX).map(([c, a]) => ({ l: c, m: ctx.names.get(c) || c,
    r: fxSgn(a[5], "%"), c: fxC(a[5]) }));
  return { title: "突破新高", sub: `資料日 ${b.date}`, rows,
    note: "依法人買強度降序，歷史分離度 0.92%、非單調",
    foot: "母體歷史 T+3 超額為負（勝大盤僅 41.7%）——本卡僅記錄突破事實，不構成偏多解讀" };
}
function fxCardNewLow(s, ctx) {     // 卡4 弱勢榜：nl==1，依量能趨勢 a5/a20 降序（分離度 0.45%）
  const b = fxNeed(s.baseline, "baseline");
  const entries = Object.entries(b.stocks || {});
  if (!entries.some(([, a]) => Array.isArray(a) && a.length >= 10))
    throw new Error("baseline 缺 a20 欄（Phase A schema 未落地）");
  const hits = entries.filter(([c, a]) => a && a[6] === 1 && fxLiqOk(ctx, c, a));
  if (!hits.length) return { skip: "今日無跌破20日新低" };
  const list = hits.map(([c, a]) => ({ c, v: a[9] > 0 ? a[0] / a[9] : null }));
  list.sort((x, y) => ((y.v ?? -Infinity) - (x.v ?? -Infinity)));
  const rows = list.slice(0, FX_ROWS_MAX).map((o) => ({ l: o.c, m: ctx.names.get(o.c) || o.c,
    r: o.v == null ? "量能 —" : `量能 ${fxR1(o.v)}x`, c: "neutral" }));
  return { title: "弱勢榜（跌破20日新低）", sub: `資料日 ${b.date}`, rows,
    note: "依量能趨勢（5日均額/20日均額）降序，歷史分離度 0.45%、非單調；未排除跌停鎖死（缺漲跌停資料）" };
}
function fxCardExitSell(s, ctx) {   // 卡5 退出＋法人賣：y1==-1 ∩ ints<-5%，不排序（回測：候選欄無效）
  const b = fxNeed(s.baseline, "baseline");
  const hits = Object.entries(b.stocks || {}).filter(([c, a]) =>
    a && a[3] === -1 && a[5] < -5 && fxLiqOk(ctx, c, a));
  if (!hits.length) return { skip: "今日無退出＋法人賣訊號" };
  hits.sort((x, y) => x[0].localeCompare(y[0]));   // 僅為輸出確定性依代號排列，非強弱排序
  const rows = hits.slice(0, FX_ROWS_MAX).map(([c, a]) => ({ l: c, m: ctx.names.get(c) || c,
    r: fxSgn(a[5], "%"), c: fxC(a[5]) }));
  return { title: "退出＋法人賣", sub: `資料日 ${b.date}`, rows,
    note: "本卡不排序（候選排序欄回測無效），依代號排列，順序不含強弱意義" };
}
function fxCardSurgeWarn(s, ctx) {  // 卡6 追高警示：y1==1，S=當日成交額/5日均額 降序呈現
  const b = fxNeed(s.baseline, "baseline");
  const fl = fxNeed(ctx.flows, "flowsDaily");
  const hits = Object.entries(b.stocks || {}).filter(([c, a]) =>
    a && a[3] === 1 && fxLiqOk(ctx, c, a));
  if (!hits.length) return { skip: "今日無爆量大漲訊號" };
  const list = hits.map(([c, a]) => {
    const amt = fl.get(c, "amt");   // 千元；a5 為元 → S = amt*1000/a5
    return { c, s: amt != null && a[0] > 0 ? amt * 1000 / a[0] : null };
  });
  list.sort((x, y) => ((y.s ?? -Infinity) - (x.s ?? -Infinity)));
  const rows = list.slice(0, FX_ROWS_MAX).map((o) => ({ l: o.c, m: ctx.names.get(o.c) || o.c,
    r: o.s == null ? "S —" : `S ${fxR1(o.s)}x`, c: "neutral" }));
  return { title: "追高警示（爆量大漲）", sub: `資料日 ${b.date}`, rows,
    note: "S 值（當日成交額/5日均額）降序呈現，僅為排列依據、不代表強弱；未排除漲停鎖死（缺漲跌停資料）" };
}

// ---- A 類·純描述（daysummary／morning／us／flows／postmkt／mktbal）----
const fxPtsRow = (r) => ({ ...(r.c != null ? { l: r.c } : {}), m: r.n, r: fxSgn(r.pts, "點"), c: fxC(r.pts) });
function fxCardGlobal(s) {          // v2-global-1 市場指數＋VIX（vix null 顯「—」不擋卡）
  const d = fxNeed(s.daysummary, "daysummary");
  const ix = fxNeed(d.index, "daysummary.index");
  const vix = s.vix == null ? null : (typeof s.vix === "object" ? s.vix.vix : s.vix);
  const rows = [];
  if (ix.tse) rows.push({ m: "加權指數", r: `${ix.tse.val}（${fxSgn(ix.tse.chg, "%")}）`, c: fxC(ix.tse.chg) });
  if (ix.otc) rows.push({ m: "櫃買指數", r: `${ix.otc.val}（${fxSgn(ix.otc.chg, "%")}）`, c: fxC(ix.otc.chg) });
  if (ix.tse && ix.tse.amt_yi != null) rows.push({ m: "成交值(加權)", r: `${fxR1(ix.tse.amt_yi)}億`, c: "neutral" });
  if (!rows.length) throw new Error("daysummary.index 欄缺");
  rows.push({ m: "VIX", r: vix == null ? "—" : fxR1(vix), c: "neutral" });
  return { title: "市場指數", sub: `資料日 ${d.date}`, rows };
}
function fxCardOv1(s) {             // v2-ov-1 今日總結
  const d = fxNeed(s.daysummary, "daysummary");
  const ix = fxNeed(d.index, "daysummary.index"); const br = fxNeed(d.breadth, "daysummary.breadth");
  return { title: "今日總結", sub: `資料日 ${d.date}`, rows: [
    { m: "加權", r: `${fxSgn(ix.tse.chgP, "點")}（${fxSgn(ix.tse.chg, "%")}）`, c: fxC(ix.tse.chg) },
    { m: "櫃買", r: `${fxSgn(ix.otc.chgP, "點")}（${fxSgn(ix.otc.chg, "%")}）`, c: fxC(ix.otc.chg) },
    { m: "漲跌家數", r: `漲${br.up}／跌${br.down}`, c: "neutral" },
  ] };
}
function fxCardOv5(s) {             // v2-ov-5 規則式定調句
  const d = fxNeed(s.daysummary, "daysummary");
  return { title: "今日定調", sub: `資料日 ${d.date}`, paras: [fxSanitize(fxNeed(d.tone, "daysummary.tone"))] };
}
function fxCardOv6(s) {             // v2-ov-6 貢獻點發散·次產業（2026-08-16 附每業貢獻前 3 檔個股）
  const d = fxNeed(s.daysummary, "daysummary");
  // subs_stocks＝daysummary 新欄（{次產業名:[{c,n,pts}…]}，build_daysummary.py 2026-08-16 起產出）。
  // 欄位不存在（舊資料）→ 退回現行純次產業列，合併上線當晚舊 latest.json 不會壞。
  const ss = d.subs_stocks && typeof d.subs_stocks === "object" ? d.subs_stocks : null;
  const mk = (r) => {
    const row = fxPtsRow(r);
    const st = ss && Array.isArray(ss[r.n]) ? ss[r.n].slice(0, 3) : [];
    if (st.length) row.r2 = st.map((o) => `${o.n}${fxSgn(o.pts)}`).join("、");
    return row;
  };
  const rows = [...(fxNeed(d.subs_top5, "daysummary.subs_top5")).slice(0, 5), ...(d.subs_bot3 || []).slice(0, 3)].map(mk);
  if (!rows.length) throw new Error("subs_top5/subs_bot3 空");
  return { title: "指數貢獻·次產業", sub: `資料日 ${d.date}`, rows,
    note: "貢獻點＝權重×漲跌的會計分解，全市場加總＝指數漲跌點；小字＝該業貢獻絕對值前 3 檔" };
}
function fxCardOv7(s) {             // v2-ov-7 貢獻點發散·產業鏈（daysummary Phase A 補欄）
  const d = fxNeed(s.daysummary, "daysummary");
  const rows = [...(fxNeed(d.chain_top5, "daysummary.chain_top5（Phase A 欄）")).slice(0, 5), ...(d.chain_bot3 || []).slice(0, 3)].map(fxPtsRow);
  if (!rows.length) throw new Error("chain_top5/chain_bot3 空");
  return { title: "指數貢獻·產業鏈", sub: `資料日 ${d.date}`, rows, note: "產業鏈為多對多分類，跨產業有重疊、不可加總" };
}
function fxCardOv8(s) {             // v2-ov-8 貢獻點發散·個股
  const d = fxNeed(s.daysummary, "daysummary");
  const rows = [...(fxNeed(d.stocks_top5, "daysummary.stocks_top5")).slice(0, 5), ...(d.stocks_bot3 || []).slice(0, 3)].map(fxPtsRow);
  if (!rows.length) throw new Error("stocks_top5/stocks_bot3 空");
  return { title: "指數貢獻·個股", sub: `資料日 ${d.date}`, rows, note: "貢獻點＝權重×漲跌的會計分解" };
}
function fxCardOv14(s) {            // v2-ov-14 次產業強弱總表 前10（daysummary Phase A 補欄 subs_all）
  const d = fxNeed(s.daysummary, "daysummary");
  const all = fxNeed(d.subs_all, "daysummary.subs_all（Phase A 欄）");
  if (!all.length) throw new Error("subs_all 空");
  const rows = all.slice(0, 10).map((r) => ({ m: r.n, r: `${fxSgn(r.pts, "點")}｜佔比${fxR1(r.share_pct)}%`, c: fxC(r.pts) }));
  return { title: "次產業總表（前10）", sub: `資料日 ${d.date}`, rows, note: "依貢獻點降序節錄前 10" };
}
function fxCardChain1(s) {          // v2-chain-1 產業鏈排行
  const d = fxNeed(s.daysummary, "daysummary");
  const rows = [...(fxNeed(d.chain_top5, "daysummary.chain_top5（Phase A 欄）")).slice(0, 5), ...(d.chain_bot3 || []).slice(0, 3)]
    .map((r) => ({ m: r.n, r: `${fxR1(r.amt_yi)}億（${fxSgn(r.pts, "點")}）`, c: fxC(r.pts) }));
  if (!rows.length) throw new Error("chain_top5/chain_bot3 空");
  return { title: "產業鏈排行", sub: `資料日 ${d.date}`, rows,
    note: "多對多分類，金額跨產業重疊、≠大盤、不可讀成市佔；不含 ETF" };
}
function fxCardFlowsHdr1(s) {       // flows-hdr-1 三大法人（totals 末日 tse+otc 自加合計）
  const t = fxNeed(s.totals, "totals");
  const d = fxNeed((t.dates || [])[(t.dates || []).length - 1], "totals.dates");
  const row = fxNeed(t.rows && t.rows[d], "totals.rows 末日");
  const sum = (f) => {
    const a = row.tse ? row.tse[f] : null, b = row.otc ? row.otc[f] : null;
    return a == null && b == null ? null : (a || 0) + (b || 0);
  };
  const rows = [["外資", "f_net_k"], ["投信", "t_net_k"], ["自營", "d_net_k"]].map(([n, f]) => {
    const v = sum(f);
    return { m: n, r: v == null ? "—" : fxSgn(fxYiK(v), "億"), c: v == null ? "neutral" : fxC(v) };
  });
  return { title: "三大法人買賣超（上市＋上櫃）", sub: `資料日 ${d}`, rows };
}
function fxCardFlowsHdr2(s) {       // flows-hdr-2 台指期外資未平倉
  const fc = fxNeed(s.flowsLatest && s.flowsLatest.pages && s.flowsLatest.pages.foreign
    && s.flowsLatest.pages.foreign.futures_card, "flowsLatest pages.foreign.futures_card");
  const rows = [{ m: "外資台指期未平倉淨額", r: `${fc.oi_net_lots > 0 ? "+" : ""}${fc.oi_net_lots}口`, c: fxC(fc.oi_net_lots) }];
  if (fc.vs_prev_month_lots != null)
    rows.push({ m: `較上月底（${fc.prev_month_end || "—"}）`, r: `${fc.vs_prev_month_lots > 0 ? "+" : ""}${fc.vs_prev_month_lots}口`, c: fxC(fc.vs_prev_month_lots) });
  return { title: "台指期外資未平倉", sub: `資料日 ${fc.date}`, rows };
}
// v2-dash-1 三合一看板（2026-08-16）：ov-1 今日總結＋flows-hdr-1 三大法人＋flows-hdr-2
// 台指期合併成一張（舊三張 builder 保留、僅移出白名單）。降級語意：三源（daysummary／
// totals／flowsLatest.futures_card）各自獨立，某源缺→省略該組列，三源全缺才 skip 整卡。
function fxCardDash1(s) {
  const rows = [];
  let sub = null;
  const d = s.daysummary;                       // ── daysummary 組：加權／櫃買／成交值／漲跌家數
  if (d && d.index) {
    const tse = d.index.tse || {}, otc = d.index.otc || {};
    if (tse.chgP != null) rows.push({ m: "加權", r: `${fxSgn(tse.chgP, "點")}（${fxSgn(tse.chg, "%")}）`, c: fxC(tse.chg) });
    if (otc.chgP != null) rows.push({ m: "櫃買", r: `${fxSgn(otc.chgP, "點")}（${fxSgn(otc.chg, "%")}）`, c: fxC(otc.chg) });
    // 成交值＝成交金額口徑（使用者 2026-08-16 裁定）：上市＋櫃買各標億元
    const amt = [];
    if (tse.amt_yi != null) amt.push(`上市${fxR1(tse.amt_yi)}億`);
    if (otc.amt_yi != null) amt.push(`櫃買${fxR1(otc.amt_yi)}億`);
    if (amt.length) rows.push({ m: "成交值", r: amt.join("｜"), c: "neutral" });
    if (d.breadth) rows.push({ m: "漲跌家數", r: `漲${d.breadth.up}／跌${d.breadth.down}`, c: "neutral" });
    sub = sub || d.date;
  }
  const t = s.totals;                           // ── totals 組：三大法人淨額（沿 fxCardFlowsHdr1 邏輯）
  const td = t && Array.isArray(t.dates) ? t.dates[t.dates.length - 1] : null;
  const trow = td && t.rows ? t.rows[td] : null;
  if (trow) {
    const sum = (f) => {
      const a = trow.tse ? trow.tse[f] : null, b = trow.otc ? trow.otc[f] : null;
      return a == null && b == null ? null : (a || 0) + (b || 0);
    };
    for (const [n, f] of [["外資", "f_net_k"], ["投信", "t_net_k"], ["自營", "d_net_k"]]) {
      const v = sum(f);
      rows.push({ m: n, r: v == null ? "—" : fxSgn(fxYiK(v), "億"), c: v == null ? "neutral" : fxC(v) });
    }
    sub = sub || td;
  }
  const fc = s.flowsLatest && s.flowsLatest.pages && s.flowsLatest.pages.foreign
    && s.flowsLatest.pages.foreign.futures_card;  // ── futures 組：台指期外資未平倉（沿 fxCardFlowsHdr2）
  if (fc && fc.oi_net_lots != null) {
    rows.push({ m: "台指期外資淨未平倉", r: `${fc.oi_net_lots > 0 ? "+" : ""}${fc.oi_net_lots}口`, c: fxC(fc.oi_net_lots) });
    if (fc.vs_prev_month_lots != null)
      rows.push({ m: `較上月底（${fc.prev_month_end || "—"}）`, r: `${fc.vs_prev_month_lots > 0 ? "+" : ""}${fc.vs_prev_month_lots}口`, c: fxC(fc.vs_prev_month_lots) });
    sub = sub || fc.date;
  }
  if (!rows.length) return { skip: "daysummary/totals/flowsLatest 三源全缺" };
  return { title: "今日總結", sub: `資料日 ${sub}`, rows,
    note: "外資／投信／自營＝當日買賣超淨額（上市＋上櫃）" };
}
function fxCardFlowsEtf1(s) {       // flows-etf-1 ETF 概況三組
  const st = fxNeed(s.flowsLatest && s.flowsLatest.pages && s.flowsLatest.pages.etf
    && s.flowsLatest.pages.etf.stats, "flowsLatest pages.etf.stats");
  const rows = [["全部", "all"], ["股票型", "nonbond"], ["債券型", "bond"]].flatMap(([n, k]) => {
    const o = st[k]; if (!o) return [];
    return [{ m: `${n}（${o.count}檔）`, r: `市值${Math.round(fxYiK(o.mktcap_k))}億｜外資${fxSgn(fxYiK(o.f_amt_k), "億")}`, c: fxC(o.f_amt_k) }];
  });
  if (!rows.length) throw new Error("etf.stats 空");
  return { title: "ETF 概況", sub: `資料日 ${s.flowsLatest.date}`, rows, note: "外資＝當日買賣超金額" };
}
function fxCardFF1(s) {             // flows-ff-1 外資買賣超近 5 日＋本週
  const fh = fxNeed(s.foreignHistory, "foreignHistory");
  const daily = fxNeed(fh.daily, "foreignHistory.daily");
  const dates = Object.keys(daily).sort();
  if (!dates.length) throw new Error("foreignHistory.daily 空");
  const net = (d) => (((daily[d].tse || {}).net_k || 0) + ((daily[d].otc || {}).net_k || 0));
  const rows = dates.slice(-5).reverse().map((d) => ({ m: d.slice(5), r: fxSgn(fxYiK(net(d)), "億"), c: fxC(net(d)) }));
  const latest = fh.latest_date || dates[dates.length - 1];
  const dt = new Date(`${latest}T00:00:00Z`);
  const mon = new Date(dt.getTime() - ((dt.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
  const wk = dates.filter((d) => d >= mon && d <= latest);
  const wsum = wk.reduce((a, d) => a + net(d), 0);
  rows.push({ m: `本週累計（${wk.length}日）`, r: fxSgn(fxYiK(wsum), "億"), c: fxC(wsum) });
  return { title: "外資買賣超近期", sub: `資料日 ${latest}`, rows, note: "合計＝上市＋上櫃" };
}
function fxCardBlock1(s) {          // pm-block-1 鉅額交易前 5 組
  const bt = fxNeed(s.postmkt && s.postmkt.blocktrade, "postmkt.blocktrade");
  const rows = (bt.rows || []).slice(0, 5).map((r) => ({ l: r.c, m: `${r.n}｜${r.type || ""}`,
    r: `${fxR1(fxYi(r.money))}億`, c: "neutral" }));
  if (!rows.length) return { skip: "本日無鉅額交易" };
  return { title: "鉅額交易", sub: `資料日 ${bt.date}`, rows, note: "逐筆前 5 組（依原始序），金額＝成交值" };
}
function fxCardMktbal1(s) {         // pm-mktbal-1 大盤融資餘額（末筆＋前筆差，帶資料日標註）
  const m = fxNeed(s.mktbal, "mktbal");
  const dl = fxNeed(m.daily, "mktbal.daily");
  if (!dl.length) throw new Error("mktbal.daily 空");
  const cur = dl[dl.length - 1], prev = dl.length > 1 ? dl[dl.length - 2] : null;
  const rows = [{ m: "融資餘額", r: `${fxR1(fxYi(fxNeed(cur.margin_money, "margin_money")))}億`, c: "neutral" }];
  if (prev && prev.margin_money != null) {
    const df = fxYi(cur.margin_money - prev.margin_money);
    rows.push({ m: `較前日（${String(prev.date).slice(5)}）`, r: fxSgn(df, "億"), c: fxC(df) });
  }
  return { title: "大盤融資餘額", sub: `資料日 ${cur.date}`, rows };
}
function fxCardMktbal2(s) {         // pm-mktbal-2 大盤借賣餘額（sbl_short；末筆＋前筆差，帶資料日標註）
  const m = fxNeed(s.mktbal, "mktbal");
  const dl = fxNeed(m.daily, "mktbal.daily");
  if (!dl.length) throw new Error("mktbal.daily 空");
  const cur = dl[dl.length - 1], prev = dl.length > 1 ? dl[dl.length - 2] : null;
  const rows = [{ m: "借賣餘額市值", r: `${fxR1(fxYi(fxNeed(cur.sbl_short_value, "sbl_short_value")))}億`, c: "neutral" }];
  if (prev && prev.sbl_short_value != null) {
    const df = fxYi(cur.sbl_short_value - prev.sbl_short_value);
    rows.push({ m: `較前日（${String(prev.date).slice(5)}）`, r: fxSgn(df, "億"), c: fxC(df) });
  }
  return { title: "大盤借賣餘額", sub: `資料日 ${cur.date}`, rows, note: "借賣＝借券後已於市場放空的餘額（sbl_short）" };
}
function fxCardMorning2(s) {        // news-morning-2 籌碼備忘（morning.chips，標 D-1）
  const ch = fxNeed(s.morning && s.morning.chips, "morning.chips");
  const inst = ch.inst || {};
  const rows = [["外資", inst.foreign], ["投信", inst.trust], ["自營", inst.dealer]]
    .filter(([, v]) => v != null).map(([n, v]) => ({ m: n, r: fxSgn(v, "億"), c: fxC(v) }));
  const paras = [];
  if ((ch.it3 || []).length) paras.push(`投信連3買：${ch.it3.slice(0, 8).map((o) => o.n || o.c).join("、")}`);
  if ((ch.it3_sell || []).length) paras.push(`投信連3賣：${ch.it3_sell.slice(0, 8).map((o) => o.n || o.c).join("、")}`);
  for (const t of ch.aetf || []) paras.push(fxSanitize(t));
  if (!rows.length && !paras.length) throw new Error("morning.chips 欄空");
  return { title: "籌碼備忘", sub: `資料日 ${inst.date || ch.aetf_date || "—"}（D-1）`, rows, paras };
}
function fxCardMorning3(s) {        // news-morning-3 昨日資金流向（同 ov-1 來源、晨報版型）
  const d = fxNeed(s.daysummary, "daysummary");
  const ix = fxNeed(d.index, "daysummary.index");
  const rows = [
    { m: "加權", r: fxSgn(ix.tse.chg, "%"), c: fxC(ix.tse.chg) },
    { m: "櫃買", r: fxSgn(ix.otc.chg, "%"), c: fxC(ix.otc.chg) },
  ];
  const paras = [];
  if (d.share_top) paras.push(`成交佔比最高：${d.share_top.n}（${fxR1(d.share_top.share_pct)}%）`);
  if (d.pts_top) paras.push(`正貢獻最大：${d.pts_top.n}（${fxSgn(d.pts_top.pts, "點")}）`);
  return { title: "昨日資金流向", sub: `資料日 ${d.date}`, rows, paras };
}
function fxCardMorning4(s) {        // news-morning-4 美股速覽（us.brief＋指數群組）
  const u = fxNeed(s.us, "us");
  const paras = u.brief ? [fxSanitize(u.brief)] : [];
  const g = (u.groups || []).find((x) => x.g === "指數");
  const rows = ((g && g.rows) || []).slice(0, 5).map((r) => ({ m: r.n, r: fxSgn(r.chg, "%"), c: fxC(r.chg) }));
  if (!paras.length && !rows.length) throw new Error("us.brief/groups 空");
  return { title: "美股速覽", sub: `資料日 ${u.date}（美東）`, rows, paras };
}

// ---- B 類·排行榜（note 必標排序欄位，無強弱形容詞——規格 3B.2）----
function fxCardRank1(s, ctx) {      // v2-rank-1 全市場成交佔比 vs 上週（lastweek.json）
  const fl = fxNeed(ctx.flows, "flowsDaily");
  let tot = 0;
  for (const r of fl.map.values()) tot += r[fl.ci.amt] || 0;
  if (!(tot > 0)) throw new Error("flowsDaily amt 總額為 0");
  const lw = s.lastweek;
  const lwTot = lw && lw.tot ? (lw.tot.twse || 0) + (lw.tot.tpex || 0) : 0;
  const list = [];
  for (const [c, r] of fl.map) list.push({ c, sh: (r[fl.ci.amt] || 0) / tot * 100 });
  list.sort((a, b) => b.sh - a.sh);
  const rows = list.slice(0, FX_ROWS_MAX).map((o) => {
    const lwSh = lw && lw.stocks && lw.stocks[o.c] != null && lwTot > 0 ? lw.stocks[o.c] / lwTot * 100 : null;
    return { l: o.c, m: ctx.names.get(o.c) || o.c,
      r: `${fxR1(o.sh)}%${lwSh == null ? "" : `（上週 ${fxR1(lwSh)}%）`}`,
      c: lwSh == null ? "neutral" : fxC(o.sh - lwSh) };
  });
  return { title: "全市場成交佔比", sub: `資料日 ${fl.date}`, rows,
    note: "依本日成交佔比降序；括號＝上週全週佔比，顏色＝佔比較上週增減" };
}
function fxCardInstRank(s, key, label) {  // flows-foreign-1／flows-trust-1 買賣超排行·依金額
  const pg = fxNeed(s.flowsLatest && s.flowsLatest.pages && s.flowsLatest.pages[key], `flowsLatest pages.${key}`);
  const buy = (pg.buy_by_amt || []).slice(0, 5), sell = (pg.sell_by_amt || []).slice(0, 5);
  if (!buy.length && !sell.length) throw new Error(`${key} buy_by_amt/sell_by_amt 空`);
  // r2 張數：latest.json 有 net_lots 就附（金額為主、張數佐證量體），缺欄則省略
  const mk = (r) => ({ l: r.code, m: r.name, r: fxSgn(fxYiK(r.net_amt_k), "億"),
    c: fxC(r.net_amt_k), ...(r.net_lots != null ? { r2: fxLots(r.net_lots) } : {}) });
  return { title: `${label}買賣超排行`, sub: `資料日 ${s.flowsLatest.date}`,
    rows: [...buy.map(mk), ...sell.map(mk)], note: `依${label}買超／賣超金額（net_amt_k）各自降序，買超在前` };
}
function fxCardAetf2(s) {           // pm-aetf-2 主動ETF 總覽（aetfDiff.etfs）
  const e = fxNeed(s.aetfDiff && s.aetfDiff.etfs, "aetfDiff.etfs");
  const list = Object.entries(e).map(([c, o]) => ({ c, n: o.name || c,
    aum: o.twse_aum_yi != null ? o.twse_aum_yi : (o.aum != null ? fxYi(o.aum) : null),
    nb: o.n_buy || 0, ns: o.n_sell || 0 })).filter((o) => o.aum != null);
  if (!list.length) throw new Error("aetfDiff.etfs 規模欄全空");
  list.sort((a, b) => b.aum - a.aum);
  const rows = list.slice(0, FX_ROWS_MAX).map((o) => ({ l: o.c, m: o.n,
    r: `${fxR1(o.aum)}億｜加${o.nb}/減${o.ns}`, c: "neutral" }));
  return { title: "主動ETF 總覽", sub: `資料日 ${s.aetfDiff.primary_date || "—"}`, rows,
    note: "依上市規模（twse_aum_yi）降序；加/減＝當日加減碼檔數" };
}
function fxCardAetf4(s) {           // pm-aetf-4 主動ETF 加減碼明細（aetfDiff.stocks zh/val）
  const st = fxNeed(s.aetfDiff && s.aetfDiff.stocks, "aetfDiff.stocks");
  const up = st.filter((o) => (o.zh || 0) > 0).sort((a, b) => (b.val || 0) - (a.val || 0)).slice(0, 4);
  const dn = st.filter((o) => (o.zh || 0) < 0).sort((a, b) => (a.val || 0) - (b.val || 0)).slice(0, 4);
  if (!up.length && !dn.length) return { skip: "本日無主動ETF加減碼" };
  const mk = (o) => ({ l: o.c, m: o.n || o.c,
    r: `${fxSgn(fxYi(o.val || 0), "億")}（${o.zh > 0 ? "+" : ""}${o.zh}張）`, c: fxC(o.val || 0) });
  return { title: "主動ETF 加減碼明細", sub: `資料日 ${s.aetfDiff.primary_date || "—"}`,
    rows: [...up.map(mk), ...dn.map(mk)], note: "依加減碼金額（val）排序：加碼前 4、減碼前 4" };
}
function fxCardAetf5(s) {           // pm-aetf-5 主動ETF 進出個股（2026-08-16 改排行 rows 形，比照 fxCardInstRank）
  const st = fxNeed(s.aetfDiff && s.aetfDiff.stocks, "aetfDiff.stocks");
  const up = st.filter((o) => (o.zh || 0) > 0).sort((a, b) => (b.val || 0) - (a.val || 0)).slice(0, 5);
  const dn = st.filter((o) => (o.zh || 0) < 0).sort((a, b) => (a.val || 0) - (b.val || 0)).slice(0, 5);
  if (!up.length && !dn.length) return { skip: "本日無主動ETF進出個股" };
  const mk = (o) => ({ l: o.c, m: o.n || o.c, r: fxSgn(fxYi(o.val || 0), "億"),
    c: fxC(o.val || 0), r2: fxLots(o.zh || 0) });
  return { title: "主動ETF 進出個股", sub: `資料日 ${s.aetfDiff.primary_date || "—"}`,
    rows: [...up.map(mk), ...dn.map(mk)],
    note: "依加減碼金額（val）排序：加碼前 5、減碼前 5，張數為佐證量體" };
}
function fxCardLending(s, field, title, fieldLabel) {   // pm-lending-3/4/6 共用（單位：張）
  const ld = fxNeed(s.postmkt && s.postmkt.lending, "postmkt.lending");
  const list = (ld.rows || []).filter((r) => r && r[field] != null);
  if (!list.length) throw new Error(`lending.${field} 空`);
  list.sort((a, b) => (b[field] || 0) - (a[field] || 0));
  const rows = list.slice(0, 5).map((r) => ({ l: r.c, m: r.n || r.c,
    r: `${fxR1((r[field] || 0) / 1e4)}萬張`, c: "neutral" }));
  return { title, sub: `資料日 ${ld.date}`, rows, note: `依${fieldLabel}（${field}）降序` };
}

// 35 張逐卡建構表（id → builder）。順序＝規格 3B.5 主題分組的粗排；C 類 5 張與
// 第二期圖表卡（v2-ov-9/10）不在表內。
export const FX_CARD_BUILDERS = [
  ["sig-sub-surge", fxCardSubSurge], ["sig-dual-buy", fxCardDualBuy],
  ["sig-new-high", fxCardNewHigh], ["sig-new-low", fxCardNewLow],
  ["sig-exit-sell", fxCardExitSell], ["sig-surge-warn", fxCardSurgeWarn],
  ["v2-global-1", fxCardGlobal], ["v2-ov-1", fxCardOv1], ["v2-ov-5", fxCardOv5],
  ["v2-ov-6", fxCardOv6], ["v2-ov-7", fxCardOv7], ["v2-ov-8", fxCardOv8],
  ["v2-ov-14", fxCardOv14], ["v2-chain-1", fxCardChain1],
  ["flows-hdr-1", fxCardFlowsHdr1], ["flows-hdr-2", fxCardFlowsHdr2],
  ["v2-dash-1", fxCardDash1],
  ["flows-etf-1", fxCardFlowsEtf1], ["flows-ff-1", fxCardFF1],
  ["pm-block-1", fxCardBlock1], ["pm-mktbal-1", fxCardMktbal1], ["pm-mktbal-2", fxCardMktbal2],
  ["news-morning-2", fxCardMorning2], ["news-morning-3", fxCardMorning3], ["news-morning-4", fxCardMorning4],
  ["v2-rank-1", fxCardRank1],
  ["flows-foreign-1", (s) => fxCardInstRank(s, "foreign", "外資")],
  ["flows-trust-1", (s) => fxCardInstRank(s, "trust", "投信")],
  ["pm-aetf-2", fxCardAetf2], ["pm-aetf-4", fxCardAetf4], ["pm-aetf-5", fxCardAetf5],
  ["pm-lending-3", (s) => fxCardLending(s, "plat_total", "券商借券餘額排行", "兩平台借券餘額")],
  ["pm-lending-4", (s) => fxCardLending(s, "sbl_short_bal", "借賣餘額排行", "借賣餘額")],
  ["pm-lending-6", (s) => fxCardLending(s, "margin_bal", "融資餘額排行", "融資餘額")],
  ["pm-summary-1", fxCardSummaryLongform],
];
// 晨報長文卡 am-brief-1 **刻意不進上表**：表是晚間 buildDailyCards 的來源，掛進去會讓
// 每個 pm 之夜多一筆「dailyBrief 缺」的 skipped（污染 pushDailyCards 的 skippedCards
// 觀測值，也違反「晚間路徑零改動」）。AM 場由 buildCardsData(slot=am) 另行組裝。
// 2026-07-30 內容裁剪（使用者授權以投資人角度評選）：39→11 張，判準＝
// 「不開網站也想送到眼前、會影響明天的決定、更新頻率配得上每日推播」。
// 2026-08-16 二次裁剪（使用者指示）：11→5 張——sig 四張（sub-surge／dual-buy／
// exit-sell／surge-warn）移出；v2-ov-1＋flows-hdr-1＋flows-hdr-2 合併成 v2-dash-1。
// builder 全保留——砍掉的卡加回這個清單即復活。詳見 spec 3C 節。
export const FX_ACTIVE_CARDS = new Set([
  "v2-dash-1",                                // 三合一看板（大盤總結＋三大法人＋台指期）
  "v2-ov-6",                                  // 次產業貢獻發散（附每業前 3 檔個股）
  "flows-foreign-1", "flows-trust-1",         // 外資／投信買賣超排行
  "pm-aetf-5",                                // 主動ETF進出個股（差異化資訊）
]);
// 盤後分析摘要長文卡：postmkt data/summary/<date>-pm.json 的 synthesis 全文。
// 使用者 2026-08-07 定案採「保留全文＋改免責句」（另兩案為改 prompt／只取綜合研判節）：
// 本卡明標 AI 生成、內含方向判斷與假設性進出情境，與其餘卡片「僅描述歷史統計傾向」不同。
export function fxCardSummaryLongform(s) {
  const j = s.summaryPm;
  const text = j && j.synthesis && j.synthesis.text;
  if (!text) return { skip: "summary-pm 未就緒" };
  const dataDate = s.baseline && s.baseline.date ? String(s.baseline.date).slice(0, 10) : null;
  const sumDate = j.date ? String(j.date).slice(0, 10) : null;
  // 摘要日與卡片資料日必須一致，否則會把昨日分析標成今日（同 attachCardImages 的守門精神）。
  // dataDate 缺（baseline 沒抓到）也一律 skip——沒有可信資料日就無從核對摘要是不是當日的，
  // 與 buildCardsData「baseline 缺 → date:null → Python 拒渲染」同一套保守立場。
  if (!sumDate || !dataDate || sumDate !== dataDate) {
    return { skip: `summary 日期不符（summary=${sumDate} data=${dataDate}）` };
  }
  const paras = fxNeutralize(text).split("\n").map((x) => x.trim()).filter(Boolean);
  if (!paras.length) return { skip: "summary 內容為空" };
  return {
    kind: "longform",
    title: "盤後分析摘要",
    sub: `AI 生成 · 資料日 ${sumDate}`,
    paras,
    note: "與本站其他圖卡不同：其餘卡片僅描述歷史統計傾向，本卡含推測性內容。"
        + "僅供參考，非投資建議，據以操作風險自負。",
    disclaimer: "本卡由 AI 依當日資料彙整，內含方向判斷與假設性進出情境，未經回測驗證",
  };
}

// ---- 晨間 AM slot（2026-08-10）：每日晨報長文卡＋昨日市場三卡 ----
// 晨報卡資料源＝taiwan-stock-news 的 daily-brief-card.json（台北 07:30 前後產出）；
// 昨日市場三卡＝重新啟用休眠 builder fxCardMorning2/3/4（morning.json／daysummary／us）。
// FX_AM_CARDS＝晨間白名單（與晚間 FX_ACTIVE_CARDS 平行、互不相干——晚間白名單不動）。
export const FX_AM_LONGFORM_CARD = "am-brief-1";
export const FX_AM_CARDS = new Set([
  FX_AM_LONGFORM_CARD,                                       // 每日晨報（longform 長圖）
  "news-morning-2", "news-morning-3", "news-morning-4",      // 籌碼備忘／昨日資金流向／美股速覽
]);
// 長文卡 id 依 slot：pm 沿用 FX_LONGFORM_CARD（既有行為不變）、am＝晨報卡
export const fxLongformCard = (slot) => (slot === "am" ? FX_AM_LONGFORM_CARD : FX_LONGFORM_CARD);
export const DAILY_BRIEF_URL =
  "https://raw.githubusercontent.com/shihpc/taiwan-stock-news/main/daily-brief-card.json";
// 晨報長文卡：daily-brief-card.json → longform 卡。段落順序（使用者定案）：
// 今日三件事 → 開盤前定位 → 本週關鍵事件 → 今日一句話；life 欄可缺可空（容錯，不入卡）。
// 不放具體買賣點位／操作建議（網頁版晨報才有）；全文過 fxNeutralize 後仍受
// assertCardAllowed 禁用字最後防線（與 pm-summary-1 同一套誠實原則守門）。
// 新鮮度（date===台北今日）不在此判——builder 是無時鐘純函式，守門在 buildCardsData(am)。
// 「今日一句話」分句（2026-08-29）：上游規範已改 quote ≤120 字、至多 3 句，但渲染端
// 防禦舊格式與超標內容（曾出現 673 字整段糊成一塊）——依全形句讀切句、逐句自成段落
// （render_longform 每個 para 自帶段距，Python 端零改動），連續短句（≤FX_QUOTE_SHORT 字）
// 併同段避免過碎；總長 >FX_QUOTE_MAX 截到最近句尾＋末段尾註。非字串／空值回空陣列
// （該段缺席、不整卡失敗，同其餘各段的逐段容錯立場）。
export const FX_QUOTE_MAX = 360;   // 防禦上限（字）：總長超過即截斷到最近句尾
const FX_QUOTE_SHORT = 20;         // 連續短句門檻（字）：前後兩句皆 ≤ 此值才併同段
const FX_QUOTE_TAIL = "（全文見網頁版晨報）";
export function fxSplitQuote(quote) {
  if (typeof quote !== "string") return [];
  const text = quote.trim();
  if (!text) return [];
  // 依全形句讀（。；！？）切句，標點留在句尾；全無句讀＝整段視為一句
  const sents = (text.match(/[^。；！？]+[。；！？]*/g) || [])
    .map((x) => x.trim()).filter(Boolean);
  if (!sents.length) return [];
  // 防禦截斷：總長超標 → 只留累計 ≤ 上限的完整句；連第一句都超標（無句讀長文）則硬截
  const total = sents.reduce((a, x) => a + [...x].length, 0);
  let kept = sents, truncated = false;
  if (total > FX_QUOTE_MAX) {
    truncated = true;
    kept = [];
    let acc = 0;
    for (const x of sents) {
      const len = [...x].length;
      if (acc + len > FX_QUOTE_MAX) break;
      kept.push(x);
      acc += len;
    }
    if (!kept.length) kept = [[...sents[0]].slice(0, FX_QUOTE_MAX).join("") + "…"];
  }
  // 分段：每句一段；前後兩句皆為短句時併入同段
  const paras = [];
  let prevShort = false;
  for (const x of kept) {
    const short = [...x].length <= FX_QUOTE_SHORT;
    if (short && prevShort && paras.length) paras[paras.length - 1] += x;
    else paras.push(x);
    prevShort = short;
  }
  if (truncated) paras[paras.length - 1] += FX_QUOTE_TAIL;
  return paras;
}
export function fxCardMorningBrief(s) {
  const j = fxNeed(s.dailyBrief, "dailyBrief");
  const date = String(j.date || "").slice(0, 10);
  if (!date) return { skip: "daily-brief 無日期" };
  const paras = [];
  const top3 = (Array.isArray(j.top3) ? j.top3 : []).filter((o) => o && o.title);
  if (top3.length) {
    paras.push("## 今日三件事");
    top3.forEach((o, i) => {
      paras.push(`${i + 1}. ${o.title}`);
      if (o.why) paras.push(`→ ${o.why}`);
    });
  }
  const pos = (Array.isArray(j.positioning) ? j.positioning : []).filter((o) => o && (o.fact || o.view));
  if (pos.length) {
    paras.push("## 開盤前定位");
    for (const o of pos) {
      const seg = [o.fact, o.view ? `解讀：${o.view}` : null].filter(Boolean).join("｜");
      paras.push(`${o.market ? `【${o.market}】` : ""}${seg}`);
    }
  }
  const wk = (Array.isArray(j.week_events) ? j.week_events : []).filter((o) => o && o.what);
  if (wk.length) {
    paras.push("## 本週關鍵事件");
    for (const o of wk) paras.push(`${o.when ? `${o.when}：` : ""}${o.what}`);
  }
  const qparas = fxSplitQuote(j.quote);   // 分句渲染＋防禦截斷；非字串／空值＝該段缺席
  if (qparas.length) {
    paras.push("## 今日一句話");
    paras.push(...qparas);
  }
  const body = paras.map((x) => fxNeutralize(x)).filter(Boolean);
  // 只剩段標＝四段內容全空 → skip（top3 空、positioning 空…逐段容錯，全空才整卡不出）
  if (!body.some((x) => !x.startsWith("##"))) return { skip: "daily-brief 內容為空" };
  return {
    kind: "longform",
    title: "每日晨報",
    sub: `AI 彙整 · ${date}${j.edition != null ? ` 第${j.edition}期` : ""}`,
    paras: body,
    note: "本卡由 AI 彙整晨間公開資訊，不含買賣點位與操作建議；完整內容見網頁版晨報。",
    disclaimer: "本卡由 AI 依晨間公開資訊彙整，僅供參考，非投資建議",
  };
}

export function buildDailyCards(src) {
  const s = src || {};
  // ctx 三件各自帶保底：任何一件建構失敗只降級該件（names 空 Map／regime 未判定／
  // flows null），逐卡 builder 自行面對降級後的 ctx——不讓共用層拖垮全表卡片
  const ctx = {};
  try { ctx.names = fxNameMap(s); } catch { ctx.names = new Map(); }
  try { ctx.regime = fxRegime(s.totals); } catch { ctx.regime = { regime: "bull", undetermined: true }; }
  try { ctx.flows = fxFlowsIndex(s.flowsDaily); } catch { ctx.flows = null; }
  const cards = [], skipped = [];
  for (const [id, fn] of FX_CARD_BUILDERS) {
    try {
      const card = fn(s, ctx);
      if (card && card.skip) { skipped.push({ id, reason: card.skip }); continue; }
      cards.push({ id, ...card });
    } catch (e) { skipped.push({ id, reason: String((e && e.message) || e) }); }
  }
  return { cards, skipped };
}

// ---- LINE 圖卡發送層＋排程接線（Phase B2，2026-07-29，規格：docs/line-cards-spec.md 第 5/9 節）----
// 不改 wrangler.toml cron：evening 班（台北 21:00–23:55 每 5 分）已涵蓋 22:30–23:00 推播窗，
// 發送做成 runEvening 內「附加」的一步：程式端時間守門（台北 ≥22:30）＋KV 去重
// `alerted:<date>:cards`（沿用 alertJob 的鍵型與 ALERTED_TTL）確保一晚只推一次。
// 發送失敗不寫 KV → 下一輪（5 分後）自動重試，同 sentinel 慣例。
const FLOWS_RAW_BASE = "https://raw.githubusercontent.com/shihpc/taiwan-flows/main";
export const CARDS_PUSH_AFTER_MIN = 22 * 60 + 30;   // 台北 22:30（規格 9.1.1 推播窗下緣）
// 等 manifest 的截止時刻（2026-08-09）：到此仍非當日 manifest 就放棄等待、退純文字推出去。
// 取 23:45 而非 23:55——晚場班 cron 到 23:55，留 23:45/23:50/23:55 三輪讓推播本身還有重試機會。
export const CARDS_WAIT_UNTIL_MIN = 23 * 60 + 45;
// LINE text message 官方上限 5000 字（messaging-api reference #text-message）；
// 33 卡純文字降級版可能貼近上限，保守截 4900 保整則可發（截尾勝於整則 400 不發）
const CARDS_TEXT_MAX = 4900;
// 14 支來源 URL（規格第 9 節逐卡對應表的來源 13 支＋PNG 渲染 manifest；flowsDaily 按日命名）。
// base 全用既有常數／慣例：env.DATA_BASE（本 repo data/）、POSTMKT_BASE、flows raw main。
// manifest＝Actions cards.yml（台北 22:12）用 Pillow 渲染 /cards/data 後 commit 的
// data/cards/latest/manifest.json——pushDailyCards 只在 manifest.date==今日時把 PNG 掛進
// Flex hero（spec 3C 呈現層改向），非當日／缺檔一律文字版（昨日圖絕不誤用）。
// slot="am"（2026-08-10）：晨間場只抓 AM 四卡用得到的源——morning2/3/4＝morning／
// daysummary／us、晨報卡＝dailyBrief；不含 manifest（AM 的 manifest 在 data/cards/am/，
// 由 pushMorningCards 自行帶破快取抓，避免此處重複 fetch）。預設 "pm" 回既有 15 支不變。
export function cardSourceUrls(env, dateISO, slot = "pm") {
  const V2 = env.DATA_BASE;
  if (slot === "am") {
    return {
      daysummary: `${V2}/daysummary/latest.json`,
      morning:    `${V2}/morning.json`,
      us:         `${V2}/us.json`,
      dailyBrief: DAILY_BRIEF_URL,
    };
  }
  return {
    daysummary:     `${V2}/daysummary/latest.json`,
    baseline:       `${V2}/baseline.json`,
    morning:        `${V2}/morning.json`,
    us:             `${V2}/us.json`,
    lastweek:       `${V2}/lastweek.json`,
    aetfLatest:     `${V2}/aetf/latest.json`,
    aetfDiff:       `${V2}/aetf/diff.json`,
    flowsLatest:    `${FLOWS_RAW_BASE}/data/latest.json`,
    totals:         `${FLOWS_RAW_BASE}/data/totals.json`,
    foreignHistory: `${FLOWS_RAW_BASE}/data/foreign_history.json`,
    flowsDaily:     `${FLOWS_RAW_BASE}/data/daily/${dateISO.replaceAll("-", "")}.json`,
    postmkt:        `${POSTMKT_BASE}/data/postmkt.json`,
    mktbal:         `${POSTMKT_BASE}/data/market_balance_history.json`,
    summaryPm:      `${POSTMKT_BASE}/data/summary/${dateISO.replaceAll("-", "")}-pm.json`,
    manifest:       `${V2}/cards/latest/manifest.json`,
  };
}
// fetch 編排：14 支各自獨立 try/catch，失敗給 null（buildDailyCards 對 null 源已能逐卡降級）。
// opts.getProduct 沿用 runEvening 的 getP 快取——postmkt.json（2.4MB）若 summary 步同一次
// 喚醒已抓過，這裡直接吃快取不重抓（快取鍵＝原始 URL，fetchProduct 的 cache-buster 不影響）。
// VIX 走既有 finFuturesVix（其內部用全域 fetch、非注入式）——僅在 FINMIND_TOKEN 有設時打，
// 失敗給 null（v2-global-1 顯「—」不擋卡）；離線測試不設 token 即零真實網路。
// opts.noVix：/cards/data 端點用（FX_ACTIVE_CARDS 活躍卡皆不用 vix，公開端點不必打 FinMind）。
export async function fetchCardSources(env, tp, fetchFn = fetch, opts = {}) {
  const getP = opts.getProduct || ((u) => fetchProduct(u, fetchFn).catch(() => null));
  const urls = cardSourceUrls(env, tp.date, opts.slot || "pm");
  const src = { dateStr: tp.date, vix: null };
  await Promise.all(Object.entries(urls).map(async ([k, u]) => {
    try { src[k] = await getP(u); } catch { src[k] = null; }
  }));
  if (env.FINMIND_TOKEN && !opts.noVix) {
    try { src.vix = await finFuturesVix(env.FINMIND_TOKEN, tp.date); }
    catch (e) { console.log("cards vix:", e && e.message); }
  }
  return src;
}
// /cards/data 端點主體（PNG 渲染管線的上游，spec 3C）：卡片邏輯唯一來源＝
// buildDailyCards，Python 只渲染不算數。輸出＝FX_ACTIVE_CARDS 過濾＋assertCardAllowed
// 縱深過濾後的卡片資料（與 pushDailyCards ⑤ 同一套守門——PNG 與文字版看到同一份內容）。
// 資料全是公開 raw JSON 的加工，無需鑑權；noVix＝活躍卡皆不用 vix，不打 FinMind。
export async function buildCardsData(env, tp, fetchFn = fetch, opts = {}) {
  const slot = opts.slot === "am" ? "am" : "pm";
  const src = await fetchCardSources(env, tp, fetchFn, { ...opts, slot, noVix: true });
  const built = buildDailyCards(src);   // AM：morning2/3/4 由既有 builder 表組出（其餘卡因源缺自然 skip）
  if (slot === "am") {
    // 晨報卡不在 FX_CARD_BUILDERS（避免污染晚間 skipped 觀測），此處單獨組裝
    let brief = null;
    try {
      const c = fxCardMorningBrief(src);
      if (c && !c.skip) brief = { id: FX_AM_LONGFORM_CARD, ...c };
      else if (c && c.skip) console.log("cards/data(am) 晨報卡 skip:", c.skip);
    } catch (e) { console.log("cards/data(am) 晨報卡:", e && e.message); }
    const candidates = brief ? [brief, ...built.cards] : built.cards;
    // AM 新鮮度守門（**不用**晚間 baseline gate——早上 baseline 必為昨日，套用必然全滅）：
    //   晨報卡 am-brief-1 → daily-brief-card.json 的 date 為台北今日；
    //   morning2/3      → morning.json 的 generated_at 台北日為今日（morning 管線今晨跑過）；
    //   美股速覽卡 news-morning-4（2026-08-13 改用自己的 gate）→ us.json 的 date 已達
    //   最近預期美股交易日（≥ 恆等於 =：date 不可能超前預期日）。美國國定假日該卡會
    //   當天缺席（date 停在前一交易日、gate 誤判 stale），屬可接受行為；其他卡不受影響。
    // 不新鮮的卡直接不進 payload；全部不新鮮 → 空卡清單＋date=null（Python 拒渲染）。
    const briefFresh = !!(src.dailyBrief && String(src.dailyBrief.date || "").slice(0, 10) === tp.date);
    const morningFresh = !!(src.morning && taipeiDayOf(src.morning.generated_at) === tp.date);
    const usFresh = !!(src.us
      && String(src.us.date || "").slice(0, 10) >= lastExpectedUsTradingDate(tp.date));
    const amCards = [];
    for (const c of candidates) {
      if (!FX_AM_CARDS.has(c.id)) continue;
      const fresh = c.id === FX_AM_LONGFORM_CARD ? briefFresh
        : c.id === "news-morning-4" ? usFresh : morningFresh;
      if (!fresh) continue;
      try { assertCardAllowed(c); amCards.push(c); }
      catch (e) { console.log("cards/data(am) 過濾剔除:", c.id, e && e.message); }
    }
    // date＝資料日（manifest 語意同晚間）：晨報新鮮取 dailyBrief.date（規格指定），
    // 否則取 tp.date——morning2/3 的 gate 保證 generated_at 台北日＝今日；us 卡的 gate
    // 保證其為「今晨該有的最新美股資料」，兩者都屬今晨內容、tp.date 語意成立。
    const amDate = amCards.length
      ? (briefFresh ? String(src.dailyBrief.date).slice(0, 10) : tp.date) : null;
    return { date: amDate, slot, renderedFor: src.dateStr, cards: amCards };
  }
  const cards = [];
  for (const c of built.cards) {
    // 長文卡不在 FX_ACTIVE_CARDS（不進 carousel），但要出現在 /cards/data 讓 Python 渲染
    if (!FX_ACTIVE_CARDS.has(c.id) && c.id !== FX_LONGFORM_CARD) continue;
    try { assertCardAllowed(c); cards.push(c); }
    catch (e) { console.log("cards/data 過濾剔除:", c.id, e && e.message); }
  }
  // date ＝**資料日**（baseline.date）而非渲染當日。這是守門語意的關鍵：上游遲到時
  // 卡片內容是昨日資料，manifest.date 就該是昨日，attachCardImages 的當日比對才會
  // 正確拒用——若標成渲染當日，會出現「今日 manifest 裝昨日數字」而被放行
  // （2026-07-30 PNG 管線驗收發現 1）。baseline 缺 → date=null → Python 拒渲染。
  const dataDate = src.baseline && src.baseline.date ? String(src.baseline.date).slice(0, 10) : null;
  return { date: dataDate, renderedFor: src.dateStr, cards };
}
// manifest（data/cards/latest/manifest.json）→ 逐卡掛 img/imgRatio。守門：
// manifest.date 必須等於台北今日（昨日圖絕不誤用）；URL 必須 https；ratio 需 W:H 格式。
// 掛不上的卡維持文字 bubble（cardBubble 對無 img 卡走原版型）——退場永遠可用。
export function attachCardImages(cards, manifest, dateISO) {
  if (!manifest || String(manifest.date || "").slice(0, 10) !== dateISO
    || !manifest.images || typeof manifest.images !== "object") return 0;
  let n = 0;
  for (const c of cards) {
    const u = manifest.images[c.id];
    if (typeof u !== "string" || !u.startsWith("https://")) continue;
    c.img = u;
    const r = manifest.ratios && manifest.ratios[c.id];
    if (typeof r === "string" && /^\d+:\d+$/.test(r)) c.imgRatio = r;
    n++;
  }
  return n;
}
// 發送流程（規格 5 節＋任務 B2 定案）：時間守門 → 通道守門 → KV 去重 → 抓源 →
// baseline 交易日守門 → 組卡＋assertCardAllowed 縱深過濾 → 0 卡記 skip →
// LINE Flex（失敗退純文字）＋ webhook（固定純文字）→ 任一通道成功才寫 KV。
// 全通道失敗 → 拋錯（不寫 KV，下輪自動重試；接線層負責 alertJob 告警）。
// 長文圖取用守門：manifest 當日、原圖與預覽都在、都是 https。任一不成立回 null＝
// 當晚沒有長文圖（Flex carousel 完全不受影響——長文是純附加）。
export function longformImage(manifest, dateISO, cardId = FX_LONGFORM_CARD) {
  const m = manifest || {};
  if (String(m.date || "") !== dateISO) return null;
  const url = (m.images || {})[cardId];
  const preview = (m.previews || {})[cardId];
  if (typeof url !== "string" || !url.startsWith("https://")) return null;
  if (typeof preview !== "string" || !preview.startsWith("https://")) return null;
  return { url, preview };
}

export async function pushDailyCards(env, tp, fetchFn = fetch, opts = {}) {
  const nowMin = tp.hour * 60 + tp.minute;
  // 觀測取樣（2026-08-09，修正 C）：pushDailyCards 原本完全沒呼叫 recordJob，/jobs?date= 與
  // /health?slot=eve 都查不到當晚推播結局。但晚場班每 5 分醒一次，非終局分支全記會變輪詢噪音
  // （違反 recordJob「只記狀態轉換」的慣例）→ 只在**窗首第一輪**與**窗尾第一輪**各取樣一次：
  // 窗首那筆說明「22:30 當下 manifest／baseline 是什麼狀態」（判斷時序有沒有修好的依據），
  // 窗尾那筆保證「等到最後仍推不出去」不會靜默無紀錄。終局（pushed／skip-empty／error）一律記。
  //
  // 兩個等待分支實際取樣到的輪次不同（2026-08-09 複驗，逐分鐘窮舉 0~1439 驗證）：
  // - ④ baseline 等待分支沒有窗尾截止條件 → **窗首（22:30~22:34）與窗尾（23:45~23:49）都會記**。
  // - ⑥b manifest 等待分支的進入條件是 `nowMin < CARDS_WAIT_UNTIL_MIN`，與窗尾取樣條件
  //   `nowMin >= CARDS_WAIT_UNTIL_MIN` **互斥** → 它的窗尾取樣是不可達分支，**只會在窗首記**。
  //   這不是缺陷：manifest 等到窗尾就不再走等待分支，而是往下走完整推播並記終局 `pushed`
  //   （或 error），觀測不會留白。
  const sampleTick = (nowMin >= CARDS_PUSH_AFTER_MIN && nowMin < CARDS_PUSH_AFTER_MIN + 5)
    || (nowMin >= CARDS_WAIT_UNTIL_MIN && nowMin < CARDS_WAIT_UNTIL_MIN + 5);
  // ① 時間守門：evening 班 21:00 起每 5 分醒，22:30 前一律不動作（零 fetch 零 KV 讀）
  if (nowMin < CARDS_PUSH_AFTER_MIN) return { name: "cards", waiting: "before-22:30" };
  // ② 通道守門：兩通道皆未設 → 靜默（同 sendAlert 慣例，不打任何外部請求）
  const hasLine = !!(env.LINE_TOKEN && env.LINE_USER_ID);
  if (!hasLine && !env.ALERT_WEBHOOK) return { name: "cards", skipped: "no-channel" };
  // ③ KV 去重：一晚只推一次（值 pushed／skip-empty，事後查 KV 可分辨當晚結局）
  const key = alertedKey(tp.date, "cards");
  if (env.FLOW_KV && await env.FLOW_KV.get(key)) return { name: "cards", skipped: "already-pushed" };
  // ④ 抓源＋交易日守門：baseline 週末/假日不更新，date 非台北今日即自然跳過。
  //    不寫 KV——交易日 baseline 若只是遲到，下輪 5 分後再看（23:55 窗尾自然截止）
  const src = await fetchCardSources(env, tp, fetchFn, opts);
  if (!src.baseline || String(src.baseline.date || "").slice(0, 10) !== tp.date) {
    const baselineDate = src.baseline ? String(src.baseline.date || "") : null;
    if (sampleTick) await recordJob(env, tp, "cards", "waiting", `baseline=${baselineDate || "缺"}`);
    return { name: "cards", skipped: "baseline-not-today", baselineDate };
  }
  // ⑤ 組卡＋縱深防禦：buildDailyCards 產物理論上已乾淨，這裡逐卡再過 assertCardAllowed
  //    一次——過不了的整張剔除記 log，不擋其他卡（規格 9.3 發送層驗收條件）
  const built = buildDailyCards(src);
  const cards = [], dropped = [];
  let hasLongform = false;
  for (const c of built.cards) {
    const isLf = c.id === FX_LONGFORM_CARD;
    if (!FX_ACTIVE_CARDS.has(c.id) && !isLf) continue;   // 內容裁剪白名單（spec 3C）
    try {
      assertCardAllowed(c);                    // 長文卡同樣過守門（文字在 card.paras，看得到）
      if (isLf) hasLongform = true; else cards.push(c);
    } catch (e) {
      dropped.push({ id: c.id, reason: String((e && e.message) || e) });
      console.log("cards 預過濾剔除:", c.id, e && e.message);
    }
  }
  // 長文圖：卡文字過了守門、且 manifest 有當日渲染結果，才附加
  const lf = hasLongform ? longformImage(src.manifest, tp.date) : null;
  // ⑤b PNG hero（spec 3C）：manifest 當日才掛圖，非當日／缺檔＝0 張掛圖＝整批文字版。
  //    只影響 Flex 版型（cardBubble 對有 img 卡出 hero）；fallback 純文字不受影響——
  //    卡物件保留 rows/paras 原資料，數字版內容兩條路徑一致。
  const imgs = attachCardImages(cards, src.manifest, tp.date);
  const manifestDate = String((src.manifest || {}).date || "").slice(0, 10);
  const manifestReady = !!manifestDate && manifestDate === tp.date;
  if (opts.dry) {
    const out = { name: "cards", wouldPush: cards.length,
      skippedCards: built.skipped.length, dropped: dropped.length, imgs,
      longform: lf ? "attached" : (hasLongform ? "no-image" : "no-card") };
    if (!manifestReady) out.manifestDate = manifestDate || null;
    if (!manifestReady && nowMin < CARDS_WAIT_UNTIL_MIN) out.waiting = "manifest-not-today";
    return out;
  }
  // ⑥ 0 卡不推：寫 KV 記 skip 後短路（0 卡之夜後續喚醒不再白抓 13 支）
  //    排在等待邏輯之前——0 卡之夜等 manifest 也沒有意義（沒有卡可以掛圖）
  if (!cards.length) {
    if (env.FLOW_KV) await env.FLOW_KV.put(key, "skip-empty", { expirationTtl: ALERTED_TTL });
    await recordJob(env, tp, "cards", "skip-empty",
      `skipped=${built.skipped.length} dropped=${dropped.length}`);
    return { name: "cards", skipped: "no-cards",
      skippedCards: built.skipped.length, dropped: dropped.length };
  }
  // ⑥b manifest 非當日 → 先不推、**也不寫 KV 去重鍵**，等下一輪（2026-08-09 修正 B）
  //    舊行為：22:30 一到就用「還是昨天的 manifest」推出去、任一通道成功即寫去重鍵短路整晚，
  //    等到 23:0x 圖真的渲染好時已經沒有第二次機會 → PNG hero 與長文圖從未掛上過推播。
  //    新行為：manifest 不是今日就純粹等（零副作用，下一輪 5 分後再看）；等到窗尾
  //    CARDS_WAIT_UNTIL_MIN（台北 23:45）仍沒等到，才照舊退純文字推出去——晚場班窗到 23:55，
  //    窗尾之後還有 23:45/23:50/23:55 三輪機會，單輪推播失敗仍能重試。
  //    注意：這裡不寫 KV 是安全的——真的一整晚都沒等到，窗尾那輪會走完整推播流程並寫鍵。
  if (!manifestReady && nowMin < CARDS_WAIT_UNTIL_MIN) {
    if (sampleTick) await recordJob(env, tp, "cards", "waiting",
      `manifest=${manifestDate || "缺"} cards=${cards.length}`);
    return { name: "cards", waiting: "manifest-not-today",
      manifestDate: manifestDate || null, cards: cards.length };
  }
  // ⑦ 發送：LINE Flex → 建構或推送拋錯退 cardsFallbackText 純文字再試一次（規格 5.3：
  //    不可因版型錯誤整則不發）；webhook 通道固定送純文字版（Flex 只有 LINE 認得）
  const fallback = cardsFallbackText(cards, tp.date).slice(0, CARDS_TEXT_MAX);
  const sentVia = [], errs = [];
  const post = async (label, { url, init }) => {
    const r = await fetchFn(url, init);
    if (!r.ok) throw new Error(`${label} HTTP ${r.status}`);
  };
  if (hasLine) {
    try {
      const messages = buildCardCarousels(cards, "股市雷達 盤後圖卡");
      messages.forEach((m, i) => {   // altText 帶序號：盤後圖卡 N/M（任務 4g）
        m.altText = `股市雷達 盤後圖卡 ${i + 1}/${messages.length}｜${tp.date}`.slice(0, 1500);
      });
      // 長文摘要走獨立 image message（不算多一則計費：官方計費按收訊人數，
      // 非 request 內 message 物件數 —— messaging-api/pricing #how-to-count）。
      // push 上限 5 則 message，超過就不附（Flex 優先，長文是附加品）。
      if (lf && messages.length < 5) {
        messages.push({ type: "image", originalContentUrl: lf.url, previewImageUrl: lf.preview });
      }
      await post("LINE flex", lineRequest(env.LINE_TOKEN, env.LINE_USER_ID, messages));
      sentVia.push("line-flex");
    } catch (e) {
      errs.push(`line-flex: ${String((e && e.message) || e)}`);
      try {
        await post("LINE text", lineRequest(env.LINE_TOKEN, env.LINE_USER_ID, fallback));
        sentVia.push("line-text");
      } catch (e2) { errs.push(`line-text: ${String((e2 && e2.message) || e2)}`); }
    }
  }
  if (env.ALERT_WEBHOOK) {
    try { await post("webhook", webhookRequest(env.ALERT_WEBHOOK, fallback)); sentVia.push("webhook"); }
    catch (e) { errs.push(`webhook: ${String((e && e.message) || e)}`); }
  }
  // ⑧ 全通道失敗 → 拋錯、不寫 KV（下輪重試）。任一成功即寫 KV——單鍵去重下不寫的話，
  //    已成功的通道下輪會重複推（LINE 一晚一推是硬約束）；代價是失敗的次要通道當晚
  //    不再補送，errors 帶回結果供 jobstat/告警查。
  if (!sentVia.length) {
    await recordJob(env, tp, "cards", "error", errs.join("；").slice(0, 300));
    throw new Error(`圖卡推播全通道失敗：${errs.join("；")}`);
  }
  // LINE 是主要交付通道：只剩 webhook 成功時 KV 仍會寫（一晚一推硬約束），
  // LINE 當晚不補推——但不得靜默，補一發告警讓使用者知道主通道失守（B2 驗收建議）
  if (!sentVia.some((v) => v.startsWith("line")))
    await alertJob(env, tp, "cards-line-err",
      `圖卡 LINE 通道全敗（已由 webhook 送達）：${errs.join("；")}`, fetchFn);
  if (env.FLOW_KV) await env.FLOW_KV.put(key, "pushed", { expirationTtl: ALERTED_TTL });
  const out = { name: "cards", sent: true, via: sentVia, cards: cards.length,
    skippedCards: built.skipped.length, imgs };
  if (dropped.length) out.dropped = dropped.length;
  if (errs.length) out.errors = errs;
  if (!manifestReady) out.manifestDate = manifestDate || null;   // 窗尾退純文字時留下佐證
  // 終局紀錄（修正 C）：走哪個分支、掛了幾張圖、長文圖有無掛上，都要能事後從 /jobs 查到。
  // 欄位慣例同其他呼叫點：result 為短狀態字串、extra 為單行細節。
  await recordJob(env, tp, "cards", "pushed",
    `via=${sentVia.join("+")} cards=${cards.length} imgs=${imgs} `
    + `lf=${lf ? "attached" : (hasLongform ? "no-image" : "no-card")} `
    + `manifest=${manifestReady ? "today" : (manifestDate || "缺")}`);
  return out;
}

// /line/webhook：LINE 平台事件進來時擷取 source.userId 存 KV（單 key line:uid，變化才寫）。
// 僅用於「一次性取 userId」設定 LINE_USER_ID；不驗 x-line-signature（簽章需 channel secret，
// 為降低設定步驟省略）——取得 userId 後可關閉 LINE 平台 webhook，此端點平時收不到流量。
export async function handleLineWebhook(env, body) {
  let uid = null;
  for (const ev of (body && body.events) || []) {
    if (ev && ev.source && ev.source.userId) { uid = ev.source.userId; break; }
  }
  if (!uid || !env.FLOW_KV) return { ok: true, uid: null };
  const prev = await env.FLOW_KV.get("line:uid");
  if (prev !== uid) await env.FLOW_KV.put("line:uid", uid);
  return { ok: true, uid };
}
// I/O 協調器：每分鐘 frame 班 storeFrame 成功後呼叫（scheduled 端已 catch，不影響主體）
export async function runAlerts(env, tp, frameKey, fetchFn = fetch) {
  const wallMin = tp.hour * 60 + tp.minute;
  if (wallMin < 9 * 60 + 6 || wallMin > 13 * 60 + 31) return { skipped: true };   // 開盤滿 5 分後才有窗
  const d = tp.date;
  const hm = `${String(tp.hour).padStart(2, "0")}:${String(tp.minute).padStart(2, "0")}`;
  const [cfgKV, series] = await Promise.all([
    env.FLOW_KV.get(ALERTS_CFG_KEY, "json"),
    env.FLOW_KV.get(`series:${d}`, "json"),
  ]);
  const cfg = { ...ALERTS_DEFAULT_CFG, ...(cfgKV || {}) };
  let events = detectIdxEvent(series, hm, cfg);
  // 事件②：連湧清單非空且已過 09:35（湊得出 30 分窗）才讀 frame（省 KV get）
  let surge = [];
  try {
    const mj = await fetchJSON(`${env.DATA_BASE}/morning.json`, 3600);
    surge = (mj.signals && mj.signals.cont_subs) || [];
  } catch { /* 晨報缺檔 → 事件②跳過，事件①不受影響 */ }
  if (surge.length && wallMin >= 9 * 60 + 35 && frameKey) {
    try {
      const times = (await env.FLOW_KV.get(`fi:${d}`, "json")) || [];
      let oldHm = null;   // 最接近 now-30 的既有 frame（同 pickFrames 邏輯，不用 list）
      for (const t of times) { const m = hm2min(t); if (m <= wallMin - 30 && m < wallMin - 2) oldHm = t; }
      if (oldHm) {
        const [cur, old, cls] = await Promise.all([
          env.FLOW_KV.get(frameKey, "json"),
          env.FLOW_KV.get(`f:${d}:${oldHm}`, "json"),
          fetchJSON(`${env.DATA_BASE}/classify.json`, 86400),
        ]);
        events = events.concat(detectSubEvents(cur, old, (cls && cls.map) || {}, surge, cfg));
      }
    } catch (e) { console.log("alerts sub:", e && e.message); }
  }
  if (!events.length) return { events: 0 };
  // 有候選才讀 log（去重）；有新事件才寫（KV write 精打細算）
  const logObj = (await env.FLOW_KV.get(ALERTS_LOG_KEY, "json")) || { ev: [] };
  const nowMs = Date.now();
  const fresh = dedupAlerts(events, logObj.ev, nowMs);
  if (!fresh.length) return { events: 0, deduped: events.length };
  let sent = false;
  try {
    const r = await sendAlert(env, fresh.map((e) => `[台股提醒 ${hm}] ${e.msg}`).join("\n"), fetchFn);
    sent = r.sent;
  } catch (e) { console.log("alerts send:", e && e.message); }
  const ev = logObj.ev.concat(fresh.map((e) => ({ ts: nowMs, id: e.id, msg: e.msg, sent: sent ? 1 : 0 })));
  // 只留近 48h 且至多 200 筆（單 key 防膨脹；/alerts/log 只回近 24h）
  const trimmed = ev.filter((e) => nowMs - e.ts < 48 * 3600e3).slice(-200);
  await env.FLOW_KV.put(ALERTS_LOG_KEY, JSON.stringify({ ev: trimmed }), { expirationTtl: 172800 });
  return { events: fresh.length, sent };
}

// ---- 美股自選（/uswatch?t=PLTR,ARM）----
// 前端自選清單存 localStorage，這裡代抓 USStockPrice 並算與 build_us.py 相同的指標。
// 每檔 FinMind 回應以 cf cacheTtl 1800s 邊緣快取（日線資料，30 分綽綽有餘）。
const USW_RE = /^[A-Z0-9^.\-]{1,8}$/;
async function usWatch(env, list) {
  const start = new Date(Date.now() - 25 * 86400e3).toISOString().slice(0, 10);
  const out = await Promise.all(list.map(async (t) => {
    try {
      const u = `${FIN_BASE}?dataset=USStockPrice&data_id=${encodeURIComponent(t)}&start_date=${start}&token=${encodeURIComponent(env.FINMIND_TOKEN)}`;
      const r = await fetch(u, { cf: { cacheTtl: 1800, cacheEverything: true } });
      if (!r.ok) return { s: t, err: "HTTP " + r.status };
      const d = ((await r.json()).data || []).filter((x) => num(x.Close));
      if (d.length < 2) return { s: t, err: "查無資料" };
      const cur = d[d.length - 1], prev = d[d.length - 2];
      const vols = d.slice(-6, -1).map((x) => num(x.Volume));
      const v5 = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
      const c = num(cur.Close), pc = num(prev.Close);
      return { s: t, d: cur.date, c,
        chg: Math.round((c / pc - 1) * 10000) / 100,
        vr: v5 && num(cur.Volume) ? Math.round(num(cur.Volume) / v5 * 100) / 100 : null,
        amp: (cur.High != null && cur.Low != null) ? Math.round((num(cur.High) - num(cur.Low)) / pc * 10000) / 100 : null };
    } catch (e) { return { s: t, err: String(e && e.message || e) }; }
  }));
  return out;
}

// ---- 個股追蹤：基本面（/fundamentals?id=2330 或 ?ids=a,b,c，additive、無新 cron）----
// FinMind 財報/月營收皆 Free 層，沿用既有 FINMIND_TOKEN secret；MoM/YoY/三率/QoQ 皆本檔算，
// 前端只渲染。純函式全部 export 供 test/fundamentals.mjs 離線驗算（無需 token）。
//
// KV 每股每日快取 key `fund:<code>:<date>`（TTL 2 天）：同股同日只打一次 FinMind。
// 預算：實務自選＋持股 <30 檔／人；每檔每日最多 1 read（查快取）＋1 write（miss 時）。
// 縱使一天出現 100 檔不同股，仍 ~100 write « 免費 1000 write／10 萬 read，額度充裕。
// 另每次 FinMind 回應以 cf cacheTtl 3600 邊緣快取，多裝置同股同小時不重打。

// 相對變化%（EPS／營收／稅後淨利用）：prev 為 0 或缺值回 null，分母取絕對值容忍負值。
export function pctChange(cur, prev) {
  if (cur == null || prev == null || prev === 0) return null;
  return r2(((cur - prev) / Math.abs(prev)) * 100);
}
// 百分點差（三率用；三率本身已是百分比，相對%意義不清，故取 pp 差）。
export function ppChange(cur, prev) {
  if (cur == null || prev == null) return null;
  return r2(cur - prev);
}
// 月營收：TaiwanStockMonthRevenue。date 欄比 revenue_month 晚一個月，故以 revenue_year+
// revenue_month 對月份（ym="YYYY-MM"）；create_time=公布日（舊資料可能空→announce null）。
// 依 ym 升冪，MoM 對上一日曆月、YoY 對去年同月（用 map 精準對齊，不靠索引避免缺月誤配）。
export function buildRevenue(rows, limit = 24) {
  const byYm = new Map();
  for (const row of rows || []) {
    const y = num(row.revenue_year), m = num(row.revenue_month);
    if (!y || !m) continue;
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    byYm.set(ym, { ym, rev: num(row.revenue), announce: row.create_time || null });
  }
  const prevYm = (ym) => { const [y, m] = ym.split("-").map(Number); return `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, "0")}`; };
  const yoyYm = (ym) => { const [y, m] = ym.split("-").map(Number); return `${y - 1}-${String(m).padStart(2, "0")}`; };
  const out = [...byYm.keys()].sort().map((ym) => {
    const e = byYm.get(ym), p = byYm.get(prevYm(ym)), yy = byYm.get(yoyYm(ym));
    return { ym, rev: e.rev, mom: p ? pctChange(e.rev, p.rev) : null, yoy: yy ? pctChange(e.rev, yy.rev) : null, announce: e.announce };
  });
  return out.slice(-limit);
}
// 季財報：TaiwanStockFinancialStatements（單季值）。取 Revenue/GrossProfit/OperatingIncome/
// IncomeAfterTaxes/EPS，三率＝各項÷Revenue×100。季別由 date 月份推（03→Q1…12→Q4）。
// QoQ（對上一季）／YoY（對去年同季）：EPS/營收/稅後淨利用相對%、三率用百分點差。
const FIN_TYPE_MAP = { Revenue: "rev", GrossProfit: "gross", OperatingIncome: "op", IncomeAfterTaxes: "net", EPS: "eps" };
const QMONTH = { "03": 1, "06": 2, "09": 3, "12": 4 };
export function buildFinancials(rows, limit = 10) {
  const byQ = new Map();
  for (const row of rows || []) {
    const key = FIN_TYPE_MAP[row.type];
    if (!key) continue;
    const d = String(row.date || ""), q = QMONTH[d.slice(5, 7)];
    if (!q) continue;
    const qid = `${d.slice(0, 4)}Q${q}`;
    if (!byQ.has(qid)) byQ.set(qid, { q: qid });
    byQ.get(qid)[key] = Number(row.value);
    byQ.get(qid).date = d;   // 季底日（業績事件排序用；同季各列 date 相同）
  }
  const quarters = [...byQ.keys()].sort((a, b) => a.localeCompare(b)).map((qid) => {
    const e = byQ.get(qid), rev = e.rev;
    const margin = (x) => (rev && x != null ? r2((x / rev) * 100) : null);
    return { q: qid, date: e.date || null, eps: e.eps ?? null, rev: rev ?? null, gross: e.gross ?? null, op: e.op ?? null, net: e.net ?? null,
      gross_margin: margin(e.gross), op_margin: margin(e.op), net_margin: margin(e.net) };
  });
  const byId = new Map(quarters.map((x) => [x.q, x]));
  const prevQ = (qid) => { const [y, q] = qid.split("Q").map(Number); return q === 1 ? `${y - 1}Q4` : `${y}Q${q - 1}`; };
  const yoyQ = (qid) => { const [y, q] = qid.split("Q").map(Number); return `${y - 1}Q${q}`; };
  const chg = (cur, prev) => prev ? {
    eps: pctChange(cur.eps, prev.eps), rev: pctChange(cur.rev, prev.rev), net: pctChange(cur.net, prev.net),
    gross_margin: ppChange(cur.gross_margin, prev.gross_margin), op_margin: ppChange(cur.op_margin, prev.op_margin), net_margin: ppChange(cur.net_margin, prev.net_margin),
  } : null;
  for (const x of quarters) { x.qoq = chg(x, byId.get(prevQ(x.q))); x.yoy = chg(x, byId.get(yoyQ(x.q))); }
  return quarters.slice(-limit);
}
// FinMind 讀取（重試一次）：非 2xx 或 data 非陣列 → 拋出，由呼叫端決定是否降級成 {id,error}。
async function finData(token, dataset, id, start, fetchFn = fetch) {
  const u = `${FIN_BASE}?dataset=${dataset}&data_id=${encodeURIComponent(id)}&start_date=${start}&token=${encodeURIComponent(token)}`;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetchFn(u, { cf: { cacheTtl: 3600, cacheEverything: true } });
      if (!r.ok) throw new Error(`${dataset} HTTP ${r.status}`);
      const j = await r.json();
      if (!Array.isArray(j.data)) throw new Error(j.msg || `${dataset} 無資料`);
      return j.data;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
// 個股新聞：TaiwanStockNews（欄 date/stock_id/link/source/title；同一 link 常有多來源列 → 去重
// by link，無 link 者以 title 去重）。依 date 降冪取最新 limit 條，皆媒體新聞（event:false，掛外連）。
export function buildNews(rows, limit = 12) {
  const seen = new Set(), out = [];
  const sorted = (rows || []).slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  for (const r of sorted) {
    const title = String((r && r.title) || "").trim();
    if (!title) continue;
    const key = String((r && r.link) || "").trim() || title;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date: String(r.date || "").slice(0, 10), source: r.source || "", title, link: r.link || null, event: false });
    if (out.length >= limit) break;
  }
  return out;
}
// 股利：TaiwanStockDividend（現金 CashEarningsDistribution／股票 StockEarningsDistribution／除息
// CashExDividendTradingDate／公告 AnnouncementDate／年度季別 year）。取公告日最新一筆；cash 回原值。
export function buildDividend(rows) {
  const valid = (rows || []).filter((r) => r && (num(r.CashEarningsDistribution) || num(r.StockEarningsDistribution)));
  if (!valid.length) return null;
  const keyDate = (r) => String(r.AnnouncementDate || r.CashExDividendTradingDate || r.date || "");
  valid.sort((a, b) => keyDate(a).localeCompare(keyDate(b)));
  const last = valid[valid.length - 1];
  return {
    cash: num(last.CashEarningsDistribution) || null,
    stock: num(last.StockEarningsDistribution) || null,
    exDate: last.CashExDividendTradingDate || null,
    announce: last.AnnouncementDate || null,
    year: last.year || null,
    payDate: last.CashDividendPaymentDate || null,
  };
}
// 股票名稱：TaiwanStockInfo（同股多列不同產業別，取首筆 stock_name）。取不到回 null。
export function buildName(rows, id) {
  for (const r of rows || []) {
    if (r && r.stock_name && (id == null || String(r.stock_id) === String(id))) return String(r.stock_name);
  }
  return null;
}
// 業績事件：從月營收/季財報/股利合成「業績快訊」新聞項（event:true，不外連，source 標明自財報數據生成），
// 與媒體新聞區分。墊底保證：股利＋最新季財報＋月營收（不足 3 條時往前補月營收），任一上市櫃股皆可靠達 ≥3。
const md = (s) => { const t = String(s || ""); return t.length >= 10 ? t.slice(5, 10).replace("-", "/") : t; };   // YYYY-MM-DD → MM/DD
const EV_SRC = "業績事件（自財報數據生成）";
export function buildEvents(revenue, financials, dividend) {
  const ev = [], revArr = revenue || [], finArr = financials || [];
  if (dividend && (dividend.cash || dividend.stock)) {
    const parts = [];
    if (dividend.cash) parts.push(`現金股利 ${r2(dividend.cash)} 元`);
    if (dividend.stock) parts.push(`股票股利 ${r2(dividend.stock)} 元`);
    const ex = dividend.exDate ? `，除息 ${md(dividend.exDate)}` : "";
    ev.push({ date: dividend.announce || dividend.exDate || "", source: EV_SRC, event: true, link: null,
      title: `宣告${dividend.year ? dividend.year + " " : ""}${parts.join("、")}${ex}` });
  }
  if (finArr.length) {
    const q = finArr[finArr.length - 1], bits = [];
    if (q.eps != null) bits.push(`EPS ${r2(q.eps)}`);
    if (q.net_margin != null) bits.push(`淨利率 ${r2(q.net_margin)}%`);
    ev.push({ date: q.date || "", source: EV_SRC, event: true, link: null,
      title: `${q.q} 財報${bits.length ? " " + bits.join("／") : ""} 公布` });
  }
  const revEvent = (m) => {
    const yi = m.rev != null ? Math.round((m.rev / 1e8) * 10) / 10 : null;
    const yoy = m.yoy != null ? ` YoY ${m.yoy > 0 ? "+" : ""}${r2(m.yoy)}%` : "";
    const pub = m.announce ? `（公布 ${md(m.announce)}）` : "";
    return { date: m.announce || `${m.ym}-01`, source: EV_SRC, event: true, link: null,
      title: `${m.ym} 營收 ${yi != null ? yi + " 億" : "—"}${yoy}${pub}` };
  };
  if (revArr.length) ev.push(revEvent(revArr[revArr.length - 1]));
  for (let i = revArr.length - 2; ev.length < 3 && i >= 0; i--) ev.push(revEvent(revArr[i]));
  return ev;
}
// 合併 媒體新聞＋業績事件 → 去重（by link|title）→ 依日期降冪，保證 ≥min 條且業績事件必顯（墊底、
// 消除「不在新聞池」死路）。為業績事件保留名額（cap-events），故熱門股即使媒體充足也同時含業績事件。
export function assembleNews(mediaRows, revenue, financials, dividend, min = 3, cap = 12) {
  const events = buildEvents(revenue, financials, dividend);
  const media = buildNews(mediaRows, cap).slice(0, Math.max(min, cap - events.length));
  const seen = new Set(), all = [];
  for (const n of [...media, ...events]) {
    const key = (n.link || n.title || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key); all.push(n);
  }
  all.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return all;
}
// 單股基本面：先查 KV 每日快取（命中不重抓）；miss 才打 FinMind（月營收＋季財報＋新聞＋股利＋名稱並行；
// 新聞/股利/名稱為 additive 且非致命，個別 .catch 降級不阻斷既有月營收/季財報回傳）。
export async function fundamentalsFor(env, id, date, fetchFn = fetch) {
  const cacheKey = `fund:4:${id}:${date}`;   // v3 schema（加 news/dividend/name＋近 5 日新聞窗＋業績事件保留名額）；版本前綴讓舊快取自然失效
  if (env.FLOW_KV) {
    const hit = await env.FLOW_KV.get(cacheKey, "json");
    if (hit) return hit;
  }
  const token = env.FINMIND_TOKEN;
  const start = `${Number(date.slice(0, 4)) - 4}-01-01`;   // ~4 年：涵蓋 24 月營收＋10 季財報＋YoY 對照＋近年股利
  const newsStart = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) - 5))
    .toISOString().slice(0, 10);   // 新聞近 ~5 天：FinMind TaiwanStockNews 由 start_date 升冪、≤500 列截斷，
                                   // 熱門股用短窗避免最新新聞被截掉（買賣力 buildNews 內再降冪取最新 12 條）
  const [revRows, finRows, newsRows, divRows, infoRows] = await Promise.all([
    finData(token, "TaiwanStockMonthRevenue", id, start, fetchFn),
    finData(token, "TaiwanStockFinancialStatements", id, start, fetchFn),
    finData(token, "TaiwanStockNews", id, newsStart, fetchFn).catch(() => []),
    finData(token, "TaiwanStockDividend", id, start, fetchFn).catch(() => []),
    finData(token, "TaiwanStockInfo", id, start, fetchFn).catch(() => []),
  ]);
  const revenue = buildRevenue(revRows), financials = buildFinancials(finRows), dividend = buildDividend(divRows);
  const out = {
    id, name: buildName(infoRows, id), revenue, financials, dividend,
    news: assembleNews(newsRows, revenue, financials, dividend), updated: new Date().toISOString(),
  };
  if (env.FLOW_KV && (out.revenue.length || out.financials.length)) {
    await env.FLOW_KV.put(cacheKey, JSON.stringify(out), { expirationTtl: 172800 });
  }
  return out;
}
// 批次：每股獨立 try（某股 FinMind 失敗回 {id,error}，不整批倒）。
export async function fundamentalsBatch(env, ids, date, fetchFn = fetch) {
  return Promise.all(ids.map((id) =>
    fundamentalsFor(env, id, date, fetchFn).catch((e) => ({ id, error: String((e && e.message) || e) }))));
}
const FUND_RE = /^[0-9]{4,6}[A-Z]?$/;

// ---- 個股追蹤：籌碼面（/chips?id=2330 或 ?ids=a,b,c，additive、無新 cron）----
// 三大法人/融資券/借券/當沖/外資持股皆 FinMind Free 層；千張大戶 TaiwanStockHoldingSharesPer
// 為 Backer 付費層——執行時 finData 取不到即該欄降級 null＋big_note，不整批倒。純函式全 export
// 供 test/chips.mjs 離線驗算（無需 token）。KV 每股每日快取 key `chips:<code>:<date>`（TTL 2 天）。
// 沿用 fundamentals 的 finData（重試一次）＋批次逐股 try 容錯＋json() CORS，不動既有回傳。
//
// 回傳結構（單位一律標清；張＝1000 股）：
//   inst  三大法人：{foreign:[{d,v}…≤20日 淨買賣張], trust:[…], dealer:[…],
//                   streak:{foreign,trust,dealer 連續同號天數±（正買負賣）}, sum5:{…近5日合計張}}
//   margin 融資融券：{bal 融資餘額張, chg 增減張, series:[{d,v}…≤20日 融資餘額張],
//                    short_bal 融券餘額張, short_chg 增減張, credit_ratio 券資比%, date}
//   sbl    借券賣出：{bal 餘額張, chg 增減張, date}
//   daytrade 當沖：{ratio 當沖量÷成交量%, date}
//   foreign_hold 外資持股：{ratio 持股率%, chg 區間pp變化, date}
//   big    千張大戶（週資料，date=資料週）：{ratio 持股比%, wchg 週變化pp, date}|null
//   big_note 付費層取不到時的降級說明；updated
const chipT = (v) => Math.round(v);   // 張數取整（股數÷1000）
// 連續同號天數（由最近往前數）：最近淨額>0 回正計數、<0 回負計數、=0 回 0。
export function chipStreak(nets) {
  const n = (nets || []).length;
  if (!n) return 0;
  const last = nets[n - 1];
  if (last === 0) return 0;
  const s = last > 0 ? 1 : -1;
  let c = 0;
  for (let i = n - 1; i >= 0; i--) {
    if ((s > 0 && nets[i] > 0) || (s < 0 && nets[i] < 0)) c++;
    else break;
  }
  return s * c;
}
// 三大法人 TaiwanStockInstitutionalInvestorsBuySell：依 name 歸併三大法人，每日淨買賣（張）。
// 外資＝Foreign_Investor＋Foreign_Dealer_Self；投信＝Investment_Trust；自營＝Dealer_self＋Dealer_Hedging。
const INST_GROUP = {
  Foreign_Investor: "foreign", Foreign_Dealer_Self: "foreign",
  Investment_Trust: "trust",
  Dealer_self: "dealer", Dealer_Hedging: "dealer",
};
export function buildInst(rows, days = 20) {
  const byDate = new Map();   // date -> {foreign,trust,dealer} 淨股數
  for (const row of rows || []) {
    const g = INST_GROUP[row.name];
    const d = String(row.date || "");
    if (!g || !d) continue;
    if (!byDate.has(d)) byDate.set(d, { foreign: 0, trust: 0, dealer: 0 });
    byDate.get(d)[g] += num(row.buy) - num(row.sell);
  }
  const dates = [...byDate.keys()].sort();
  if (!dates.length) return null;
  const out = { streak: {}, sum5: {} };
  for (const g of ["foreign", "trust", "dealer"]) {
    const arr = dates.slice(-days).map((d) => ({ d, v: chipT(byDate.get(d)[g] / 1000) }));
    out[g] = arr;
    out.streak[g] = chipStreak(arr.map((x) => x.v));
    out.sum5[g] = arr.slice(-5).reduce((a, b) => a + b.v, 0);
  }
  return out;
}
// 融資融券 TaiwanStockMarginPurchaseShortSale（餘額原生單位＝張）：末日餘額＋增減＋券資比＋20日融資餘額序列。
export function buildMargin(rows, days = 20) {
  const sorted = (rows || []).filter((r) => r.date).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!sorted.length) return null;
  const last = sorted[sorted.length - 1];
  const bal = num(last.MarginPurchaseTodayBalance);
  const short_bal = num(last.ShortSaleTodayBalance);
  return {
    bal, chg: bal - num(last.MarginPurchaseYesterdayBalance),
    short_bal, short_chg: short_bal - num(last.ShortSaleYesterdayBalance),
    credit_ratio: bal ? r2((short_bal / bal) * 100) : null,   // 券資比＝融券餘額÷融資餘額
    series: sorted.slice(-days).map((r) => ({ d: String(r.date), v: num(r.MarginPurchaseTodayBalance) })),
    date: String(last.date),
  };
}
// 借券賣出 TaiwanDailyShortSaleBalances（SBL 餘額原生單位＝股）：末日餘額＋增減，換算張。
export function buildSBL(rows) {
  const sorted = (rows || []).filter((r) => r.date).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!sorted.length) return null;
  const last = sorted[sorted.length - 1];
  const cur = num(last.SBLShortSalesCurrentDayBalance), prev = num(last.SBLShortSalesPreviousDayBalance);
  return { bal: chipT(cur / 1000), chg: chipT((cur - prev) / 1000), date: String(last.date) };
}
// 當沖 TaiwanStockDayTrading：當沖成交量÷當日總成交量（TaiwanStockPrice.Trading_Volume）＝當沖比%。
export function buildDayTrade(dtRows, priceRows) {
  const dt = (dtRows || []).filter((r) => r.date).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!dt.length) return null;
  const last = dt[dt.length - 1];
  const tv = new Map((priceRows || []).map((r) => [String(r.date), num(r.Trading_Volume)])).get(String(last.date));
  return { ratio: tv ? r2((num(last.Volume) / tv) * 100) : null, date: String(last.date) };
}
// 外資持股 TaiwanStockShareholding：末日 ForeignInvestmentSharesRatio＋對區間首筆的 pp 變化。
export function buildForeignHold(rows) {
  const sorted = (rows || []).filter((r) => r.date && r.ForeignInvestmentSharesRatio != null)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!sorted.length) return null;
  const last = sorted[sorted.length - 1], ratio = num(last.ForeignInvestmentSharesRatio);
  const ref = sorted[Math.max(0, sorted.length - 6)];   // ~5 交易日前
  return { ratio: r2(ratio), chg: r2(ratio - num(ref.ForeignInvestmentSharesRatio)), date: String(last.date) };
}
// 千張大戶 TaiwanStockHoldingSharesPer（週資料，付費層）：取 >1000 張級距(more than 1,000,001)持股比％，
// 末週值＋對上一週的 pp 變化。取不到（空/finData 拋出被 catch 成 null）回 null → big_note 標降級。
export function buildBigHolder(rows) {
  const byDate = new Map();
  for (const r of rows || []) {
    if (r.HoldingSharesLevel === "more than 1,000,001" && r.date) byDate.set(String(r.date), num(r.percent));
  }
  const dates = [...byDate.keys()].sort();
  if (!dates.length) return null;
  const lastD = dates[dates.length - 1], prevD = dates.length >= 2 ? dates[dates.length - 2] : null;
  return { ratio: r2(byDate.get(lastD)), wchg: prevD ? r2(byDate.get(lastD) - byDate.get(prevD)) : null, date: lastD };
}
// 單股籌碼：先查 KV 每日快取（命中不重抓）；miss 才並行打 FinMind（各 dataset 獨立容錯，某表失敗
// 該欄 null；千張大戶付費取不到降級不整批倒）。全部區塊皆 null → 拋出交由 batch 降成 {id,error}。
export async function chipsFor(env, id, date, fetchFn = fetch) {
  const cacheKey = `chips:${id}:${date}`;
  if (env.FLOW_KV) {
    const hit = await env.FLOW_KV.get(cacheKey, "json");
    if (hit) return hit;
  }
  const token = env.FINMIND_TOKEN;
  const start = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) - 75))
    .toISOString().slice(0, 10);   // ~75 天回溯：涵蓋 20 交易日序列＋千張大戶近幾週＋外資持股區間
  const get = (ds) => finData(token, ds, id, start, fetchFn).catch(() => null);
  const [instR, marginR, sblR, dtR, priceR, fhR, bigR] = await Promise.all([
    get("TaiwanStockInstitutionalInvestorsBuySell"),
    get("TaiwanStockMarginPurchaseShortSale"),
    get("TaiwanDailyShortSaleBalances"),
    get("TaiwanStockDayTrading"),
    get("TaiwanStockPrice"),
    get("TaiwanStockShareholding"),
    get("TaiwanStockHoldingSharesPer"),   // 付費層，取不到 → null → big 降級
  ]);
  const big = buildBigHolder(bigR);
  const out = {
    id,
    inst: buildInst(instR),
    margin: buildMargin(marginR),
    sbl: buildSBL(sblR),
    daytrade: buildDayTrade(dtR, priceR),
    foreign_hold: buildForeignHold(fhR),
    big,
    big_note: big ? null : "千張大戶為 FinMind 付費層，此 token 或此股暫無法取得（其餘欄不受影響）",
    updated: new Date().toISOString(),
  };
  if (!out.inst && !out.margin && !out.sbl && !out.daytrade && !out.foreign_hold && !out.big)
    throw new Error("查無籌碼資料");
  if (env.FLOW_KV) await env.FLOW_KV.put(cacheKey, JSON.stringify(out), { expirationTtl: 172800 });
  return out;
}
// 批次：每股獨立 try（某股 FinMind 失敗或查無回 {id,error}，不整批倒）。
export async function chipsBatch(env, ids, date, fetchFn = fetch) {
  return Promise.all(ids.map((id) =>
    chipsFor(env, id, date, fetchFn).catch((e) => ({ id, error: String((e && e.message) || e) }))));
}

// ---- 個股追蹤：技術面（/technical?id=2330 或 ?ids=a,b,c，additive、無新 cron）----
// FinMind TaiwanStockPrice（Free(w/id)，OHLCV）抓近 ~250 交易日；7 項指標（均線/KD/MACD/RSI/
// 布林/量能/距52週高低）全部在 Worker 算，寫成純函式供 test/technical.mjs 離線驗算（固定序列對照
// 教科書值）。KV 每股每日快取 key `tech:<code>:<date>`（TTL 2 天）。沿用 finData（重試一次）＋批次
// 逐股 try 容錯＋json() CORS，不動既有回傳。
//
// 誠實原則（專案鐵律）：所有 state 皆為「指標數學狀態的中性描述」（超買/超賣/黃金交叉/死亡交叉/
// 黏合/多頭排列…），非買賣訊號、非行動建議、非預測宣稱；前端另加固定免責。
//
// 精選 7 項回傳結構（值不足回 null，不炸）：
//   ma      均線：{ma5,ma10,ma20,ma60, dist5..60 現價距離%, arrange 多空排列描述}
//   kd      KD(9,3,3)：{k,d, state 高檔/低檔/黃金交叉/死亡交叉/中性}
//   macd    MACD(12,26,9)：{dif,macd(訊號線),hist 柱狀體, state 柱翻正/翻負/黏合＋零軸上下}
//   rsi     RSI(5,10)：{rsi5,rsi10, state 超買>70/超賣<30/中性；背離不自動判、留白}
//   boll    布林(20,2)：{mid,upper,lower, pb %b 通道位置, state 觸上軌/觸下軌/中軌上下}
//   volume  量能：{avg5,avg20(張), ratio 5日均量÷20日均量, surge 爆量, shrink 量縮, state}
//   range52 距52週高/低：{high,low, distHigh 距高%(≤0), distLow 距低%(≥0)}

// 簡單移動平均：最後 period 個值的平均；不足 period 回 null。
export function sma(arr, period) {
  const a = arr || [];
  if (a.length < period || period <= 0) return null;
  let s = 0;
  for (let i = a.length - period; i < a.length; i++) s += a[i];
  return s / period;
}
// 指數移動平均（回整條序列，種子＝前 period 個的 SMA、其後遞迴 k=2/(period+1)）；
// 不足 period 回 []。教科書慣例：EMA[period-1]=SMA(0..period-1)，之後 EMA[i]=v[i]*k+EMA[i-1]*(1-k)。
export function ema(arr, period) {
  const a = arr || [];
  if (a.length < period || period <= 0) return [];
  const k = 2 / (period + 1), out = new Array(a.length).fill(null);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += a[i];
  out[period - 1] = seed / period;
  for (let i = period; i < a.length; i++) out[i] = a[i] * k + out[i - 1] * (1 - k);
  return out;
}
// KD 隨機指標（台股慣例 RSV→K→D，平滑 1/smooth；初值 K=D=50）。回最後一日 {k,d}，不足 n 回 null。
// RSV=(C-最低LL)/(最高HH-最低LL)×100；區間為 0 時（無波動）RSV=50。
export function kd(highs, lows, closes, n = 9, smooth = 3) {
  const H = highs || [], L = lows || [], C = closes || [];
  if (C.length < n) return null;
  const a = 1 / smooth;
  let k = 50, d = 50;
  for (let i = n - 1; i < C.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) { if (H[j] > hh) hh = H[j]; if (L[j] < ll) ll = L[j]; }
    const rng = hh - ll, rsv = rng === 0 ? 50 : ((C[i] - ll) / rng) * 100;
    k = k * (1 - a) + rsv * a;
    d = d * (1 - a) + k * a;
  }
  return { k: r2(k), d: r2(d) };
}
// MACD（快慢 EMA 差＝DIF、DIF 的 signal EMA＝MACD 線、柱狀體＝DIF−MACD）。回最後一日
// {dif,macd,hist} 及前一日 histPrev（供翻正/翻負判定）；不足回 null。
export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const C = closes || [];
  if (C.length < slow + signal) return null;
  const ef = ema(C, fast), es = ema(C, slow);
  const dif = C.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const difVals = dif.filter((x) => x != null);
  const sig = ema(difVals, signal);
  if (!sig.length || sig[sig.length - 1] == null) return null;
  const macdLine = sig[sig.length - 1], macdPrev = sig[sig.length - 2];
  const difLast = difVals[difVals.length - 1], difPrev = difVals[difVals.length - 2];
  const hist = difLast - macdLine, histPrev = (difPrev != null && macdPrev != null) ? difPrev - macdPrev : null;
  return { dif: r2(difLast), macd: r2(macdLine), hist: r2(hist), histPrev: histPrev == null ? null : r2(histPrev) };
}
// RSI（Wilder 平滑；序列長度恰 period+1 時＝簡單平均 RSI 種子）。全漲回 100、全跌回 0、
// 無波動回 50。不足 period+1 回 null。
export function rsi(closes, period = 14) {
  const C = closes || [];
  if (C.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const ch = C[i] - C[i - 1]; if (ch >= 0) gain += ch; else loss -= ch; }
  let avgG = gain / period, avgL = loss / period;
  for (let i = period + 1; i < C.length; i++) {
    const ch = C[i] - C[i - 1];
    avgG = (avgG * (period - 1) + (ch > 0 ? ch : 0)) / period;
    avgL = (avgL * (period - 1) + (ch < 0 ? -ch : 0)) / period;
  }
  if (avgL === 0) return avgG === 0 ? 50 : 100;
  if (avgG === 0) return 0;
  return r2(100 - 100 / (1 + avgG / avgL));
}
// 布林通道（中軌＝SMA、母體標準差×mult）。回 {mid,upper,lower,pb}；區間 0 時 pb=0.5。不足回 null。
export function boll(closes, period = 20, mult = 2) {
  const C = closes || [];
  if (C.length < period) return null;
  const mid = sma(C, period);
  let v = 0;
  for (let i = C.length - period; i < C.length; i++) v += (C[i] - mid) ** 2;
  const sd = Math.sqrt(v / period);
  const upper = mid + mult * sd, lower = mid - mult * sd, close = C[C.length - 1];
  const rng = upper - lower, pb = rng === 0 ? 0.5 : (close - lower) / rng;
  return { mid: r2(mid), upper: r2(upper), lower: r2(lower), pb: r2(pb) };
}
// 量能：近5日均量 vs 20日均量比（單位＝原始量，前端可轉張）。爆量＝比≥2 且末日收漲；量縮＝比≤0.5。
export function volumeRatio(volumes, closes) {
  const V = volumes || [], C = closes || [];
  const avg5 = sma(V, 5), avg20 = sma(V, 20);
  if (avg5 == null || avg20 == null || avg20 === 0) return null;
  const ratio = avg5 / avg20;
  const up = C.length >= 2 ? C[C.length - 1] > C[C.length - 2] : false;
  return { avg5: Math.round(avg5), avg20: Math.round(avg20), ratio: r2(ratio), surge: ratio >= 2 && up, shrink: ratio <= 0.5 };
}
// 距 52 週（全序列）高/低 %：distHigh=(C−HH)/HH×100（≤0）、distLow=(C−LL)/LL×100（≥0）。
export function range52(highs, lows, closes) {
  const H = highs || [], L = lows || [], C = closes || [];
  if (!C.length) return null;
  let hh = -Infinity, ll = Infinity;
  for (const h of H) if (h > hh) hh = h;
  for (const l of L) if (l < ll) ll = l;
  const close = C[C.length - 1];
  return {
    high: r2(hh), low: r2(ll),
    distHigh: hh > 0 ? r2(((close - hh) / hh) * 100) : null,
    distLow: ll > 0 ? r2(((close - ll) / ll) * 100) : null,
  };
}
// 多空排列（中性描述、非訊號）：MA5>MA10>MA20>MA60 多頭排列；反向 空頭排列；否則 糾結。
export function maArrange(m5, m10, m20, m60) {
  const v = [m5, m10, m20, m60];
  if (v.some((x) => x == null)) return "資料不足";
  if (m5 > m10 && m10 > m20 && m20 > m60) return "多頭排列";
  if (m5 < m10 && m10 < m20 && m20 < m60) return "空頭排列";
  return "糾結";
}
// 由 KD 值推中性狀態描述：交叉（黃金/死亡）優先，其次高/低檔區，否則中性。
function kdState(cur, prevK, prevD) {
  if (prevK != null && prevD != null) {
    if (prevK <= prevD && cur.k > cur.d) return "黃金交叉（K 上穿 D）";
    if (prevK >= prevD && cur.k < cur.d) return "死亡交叉（K 下穿 D）";
  }
  if (cur.k > 80 && cur.d > 80) return "高檔區（>80）";
  if (cur.k < 20 && cur.d < 20) return "低檔區（<20）";
  return "中性";
}
// MACD 中性狀態：柱翻正/翻負（跨零）或黏合（近零），附零軸上下描述。
function macdState(m) {
  let bar = "柱狀持平";
  if (m.histPrev != null) {
    if (m.histPrev <= 0 && m.hist > 0) bar = "柱狀翻正（跨零軸）";
    else if (m.histPrev >= 0 && m.hist < 0) bar = "柱狀翻負（跨零軸）";
    else if (Math.abs(m.hist) < 0.05) bar = "黏合（近零）";
    else bar = m.hist > 0 ? "柱狀為正" : "柱狀為負";
  }
  return `${bar}；DIF ${m.dif > 0 ? "零軸之上" : "零軸之下"}`;
}
// RSI 中性狀態（取較短 rsi5 判超買/超賣；背離不自動判、留白）。
function rsiState(v) {
  if (v == null) return "資料不足";
  if (v > 70) return "超買區（>70）";
  if (v < 30) return "超賣區（<30）";
  return "中性";
}
// 布林中性狀態（依 %b 描述通道位置）。
function bollState(pb) {
  if (pb == null) return "資料不足";
  if (pb >= 1) return "觸/破上軌";
  if (pb <= 0) return "觸/破下軌";
  return pb >= 0.5 ? "中軌之上" : "中軌之下";
}
// 量能中性狀態（爆量需價漲；量縮）。
function volState(vr) {
  if (!vr) return "資料不足";
  if (vr.surge) return "爆量（量增且價漲）";
  if (vr.shrink) return "量縮";
  return "量能正常";
}
// TaiwanStockPrice 原始列 → 依日期升冪的 {date,o,h,l,c,v} 序列（欄：open/max/min/close/Trading_Volume）。
export function buildSeries(rows) {
  return (rows || [])
    .filter((r) => r && r.date != null && r.close != null)
    .map((r) => ({ date: String(r.date).slice(0, 10), o: num(r.open), h: num(r.max), l: num(r.min), c: num(r.close), v: num(r.Trading_Volume) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
// 由 OHLCV 序列組 7 項技術指標（全中性描述）；序列空回 {error}，個別指標不足時該項 null＋arrange/state 註記。
export function buildTechnical(series) {
  if (!series || !series.length) return { error: "查無價格資料" };
  const closes = series.map((x) => x.c), highs = series.map((x) => x.h), lows = series.map((x) => x.l), vols = series.map((x) => x.v);
  const last = series[series.length - 1], price = last.c;
  const distPct = (mv) => (mv == null ? null : r2(((price - mv) / mv) * 100));
  const m5 = sma(closes, 5), m10 = sma(closes, 10), m20 = sma(closes, 20), m60 = sma(closes, 60);
  // KD 需當日與前一日以判交叉：用全序列與去尾一筆各算一次
  const kdCur = kd(highs, lows, closes), kdPrev = kd(highs.slice(0, -1), lows.slice(0, -1), closes.slice(0, -1));
  const macdVal = macd(closes);
  const rsi5 = rsi(closes, 5), rsi10 = rsi(closes, 10);
  const bollVal = boll(closes);
  const vr = volumeRatio(vols, closes);
  const r52 = range52(highs, lows, closes);
  return {
    date: last.date, price: r2(price),
    ma: {
      ma5: m5 == null ? null : r2(m5), ma10: m10 == null ? null : r2(m10), ma20: m20 == null ? null : r2(m20), ma60: m60 == null ? null : r2(m60),
      dist5: distPct(m5), dist10: distPct(m10), dist20: distPct(m20), dist60: distPct(m60),
      arrange: maArrange(m5, m10, m20, m60),
    },
    kd: kdCur ? { k: kdCur.k, d: kdCur.d, state: kdState(kdCur, kdPrev ? kdPrev.k : null, kdPrev ? kdPrev.d : null) } : null,
    macd: macdVal ? { dif: macdVal.dif, macd: macdVal.macd, hist: macdVal.hist, state: macdState(macdVal) } : null,
    rsi: (rsi5 == null && rsi10 == null) ? null : { rsi5, rsi10, state: rsiState(rsi5 != null ? rsi5 : rsi10) },
    boll: bollVal ? { ...bollVal, state: bollState(bollVal.pb) } : null,
    volume: vr ? { ...vr, state: volState(vr) } : null,
    range52: r52,
  };
}
// 單股技術面：先查 KV 每日快取（命中不重抓）；miss 才打 FinMind TaiwanStockPrice（近 ~250 交易日）。
export async function technicalFor(env, id, date, fetchFn = fetch) {
  const cacheKey = `tech:${id}:${date}`;
  if (env.FLOW_KV) {
    const hit = await env.FLOW_KV.get(cacheKey, "json");
    if (hit) return hit;
  }
  const token = env.FINMIND_TOKEN;
  const start = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) - 400))
    .toISOString().slice(0, 10);   // ~400 曆日回溯：涵蓋 ~250 交易日（MA60／布林20／52週高低／MACD 暖身）
  const rows = await finData(token, "TaiwanStockPrice", id, start, fetchFn);   // 失敗（重試後）拋出 → 批次端降級 {id,error}
  const tech = buildTechnical(buildSeries(rows));
  if (tech.error) throw new Error(tech.error);
  const out = { id, ...tech, updated: new Date().toISOString() };
  if (env.FLOW_KV) await env.FLOW_KV.put(cacheKey, JSON.stringify(out), { expirationTtl: 172800 });
  return out;
}
// 批次：每股獨立 try（某股 FinMind 失敗或查無回 {id,error}，不整批倒）。
export async function technicalBatch(env, ids, date, fetchFn = fetch) {
  return Promise.all(ids.map((id) =>
    technicalFor(env, id, date, fetchFn).catch((e) => ({ id, error: String((e && e.message) || e) }))));
}

// ---- 美股自選跨裝置同步（/usersync?k=同步碼[&set=A,B]）----
// 清單存 KV `usw:<sha256(碼)>`（永久）；同步碼=輕量共享密鑰，內容僅股票代號、低敏感。
async function syncKey(code) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("usw:" + code));
  return "usw:" + [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ---- /status 全系統資料健康端點（新資料規範 schema:1 首例，2026-08-11）----
// 五站一覽：live（本站 KV）／flows／news／brief／postmkt（跨 repo raw JSON）。
// 單站失敗不拖垮端點（Promise.allSettled）；判級為可測純函式，台北時區。

// 日期加減（YYYY-MM-DD 字串運算，不碰本地時區）
export function addDaysISO(dateISO, days) {
  const t = new Date(dateISO + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}
// 最近預期交易日：平日＝今天、週末＝上週五。國定假日不處理（簡化：連假日仍以平日計，
// 假日當天會誤判 yellow/red，屬已知可接受誤差）。
export function lastExpectedTradingDate(tp) {
  if (tp.dow >= 1 && tp.dow <= 5) return tp.date;
  return addDaysISO(tp.date, tp.dow === 6 ? -1 : -2);   // 週六退1天、週日退2天到週五
}
// 往前一個預期交易日（跳過週末；同樣不處理國定假日）
export function prevExpectedTradingDate(dateISO) {
  let d = dateISO;
  do { d = addDaysISO(d, -1); } while (["0", "6"].includes(String(new Date(d + "T00:00:00Z").getUTCDay())));
  return d;
}
// 市場資料類判級（live/flows/postmkt）：資料日 ≥ 最近預期交易日 → green；
// 落後 1 個交易日 → yellow；更舊或無日期 → red。
export function gradeMarket(dataDate, tp) {
  if (!dataDate) return "red";
  const exp = lastExpectedTradingDate(tp);
  if (dataDate >= exp) return "green";
  if (dataDate >= prevExpectedTradingDate(exp)) return "yellow";
  return "red";
}
// news 判級：generated_at 距今 ≤3 小時 green、≤24 小時 yellow、否則（含無法解析）red
export function gradeNews(generatedAt, nowMs) {
  const t = Date.parse(generatedAt || "");
  if (!Number.isFinite(t)) return "red";
  const hours = (nowMs - t) / 3600e3;
  return hours <= 3 ? "green" : hours <= 24 ? "yellow" : "red";
}
// brief 判級：date＝今天（平日）→ green；date＝昨天、或今天是週末（date 不舊於上週五）→ yellow；
// 更舊 → red。
export function gradeBrief(dataDate, tp) {
  if (!dataDate) return "red";
  const weekday = tp.dow >= 1 && tp.dow <= 5;
  if (!weekday) return dataDate >= lastExpectedTradingDate(tp) ? "yellow" : "red";
  if (dataDate === tp.date) return "green";
  return dataDate === addDaysISO(tp.date, -1) ? "yellow" : "red";
}
// epoch ms → ISO8601 +08:00（秒級）
export function isoTaipei(ms) {
  return new Date(ms + 8 * 3600e3).toISOString().slice(0, 19) + "+08:00";
}
// 從 JSON 檔頭文字撈 date/generated_at（postmkt.json 逾 1.6MB，只抓 Range 檔頭時用；
// 兩欄位是該檔前兩個 key，regex 取值即可，不需完整 parse）
export function extractHeadFields(text) {
  return {
    date: (String(text).match(/"date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/) || [])[1] || null,
    generated_at: (String(text).match(/"generated_at"\s*:\s*"([^"]+)"/) || [])[1] || null,
  };
}
// 小檔 JSON 來源（<300KB）：整包抓＋parse
async function fetchStatusJson(fetchFn, url) {
  const r = await fetchFn(url, { signal: timeoutSignal() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
// 大檔來源：Range 只取檔頭（raw.githubusercontent.com 支援 Range，實測回 206）；
// 若 CDN 忽略 Range 回 200 全檔，改用 reader 讀首塊即止，不把整包載入記憶體。
async function fetchStatusHead(fetchFn, url, bytes = 2048) {
  const r = await fetchFn(url, { headers: { Range: `bytes=0-${bytes - 1}` }, signal: timeoutSignal() });
  if (!r.ok && r.status !== 206) throw new Error(`HTTP ${r.status}`);
  if (r.status === 206 || !r.body || !r.body.getReader) return r.text();
  const reader = r.body.getReader();
  const { value } = await reader.read();
  reader.cancel().catch(() => {});
  return new TextDecoder().decode(value || new Uint8Array());
}
// live：直接用本站 KV 的 fi 索引（同 `/` 根路徑 health 區塊做法，不外抓）。
// 依序查最近兩個預期交易日的 frame 索引，第一個非空者為資料日。
async function statusSiteLive(env, tp) {
  const exp = lastExpectedTradingDate(tp);
  for (const d of [exp, prevExpectedTradingDate(exp)]) {
    const fi = env.FLOW_KV ? await env.FLOW_KV.get(`fi:${d}`, "json") : null;
    if (fi && fi.length) {
      const lastHm = fi.reduce((a, b) => (b > a ? b : a));   // 索引為 HH:MM 字串，取最大值最穩
      return { data_date: d, updated_at: `${d}T${lastHm}:00+08:00`, note: `${d} 共 ${fi.length} 格 frame` };
    }
  }
  return { data_date: null, updated_at: null, note: "近兩個交易日 KV 無 frame" };
}
// /status 主體：五站併發、單站失敗只染紅該站
export async function buildStatus(env, tp, fetchFn = fetch, nowMs = Date.now()) {
  const FLOWS_STATUS = "https://raw.githubusercontent.com/shihpc/taiwan-flows/main/data/status.json";
  const NEWS_URL = "https://raw.githubusercontent.com/shihpc/taiwan-stock-news/main/news.json";
  const BRIEF_URL = "https://raw.githubusercontent.com/shihpc/taiwan-stock-news/main/daily-brief-card.json";
  const POSTMKT_URL = `${POSTMKT_BASE}/data/postmkt.json`;
  const defs = [
    { id: "live", name: "即時類股動態", grade: "market", run: () => statusSiteLive(env, tp) },
    { id: "flows", name: "盤後法人動態", grade: "market", run: async () => {
      const j = await fetchStatusJson(fetchFn, FLOWS_STATUS);   // 353B 小檔
      return { data_date: j.date || null, updated_at: j.checked_at || null, note: `健檢 ${j.status || "unknown"}` };
    } },
    { id: "news", name: "新聞晨報", grade: "news", run: async () => {
      const j = await fetchStatusJson(fetchFn, NEWS_URL);   // ~200KB，<300KB 門檻內
      const days = Array.isArray(j.trading_days) ? j.trading_days : [];
      return { data_date: days[days.length - 1] || (j.generated_at || "").slice(0, 10) || null,
        updated_at: j.generated_at || null, note: `${j.total_news || 0} 則新聞` };
    } },
    { id: "brief", name: "每日晨報", grade: "brief", run: async () => {
      const j = await fetchStatusJson(fetchFn, BRIEF_URL);   // ~4KB 小檔
      return { data_date: j.date || null, updated_at: j.generated_at || null,
        note: j.edition ? `第 ${j.edition} 版` : "" };
    } },
    { id: "postmkt", name: "盤後分析", grade: "market", run: async () => {
      const h = extractHeadFields(await fetchStatusHead(fetchFn, POSTMKT_URL));   // 1.6MB 大檔只取 Range 檔頭
      return { data_date: h.date, updated_at: h.generated_at, note: "" };
    } },
  ];
  const results = await Promise.allSettled(defs.map((d) => d.run()));
  const sites = defs.map((d, i) => {
    const r = results[i];
    if (r.status !== "fulfilled") {
      return { id: d.id, name: d.name, data_date: null, updated_at: null, level: "red",
        note: `來源抓取失敗: ${String(r.reason && r.reason.message || r.reason)}` };
    }
    const v = r.value;
    const level = d.grade === "news" ? gradeNews(v.updated_at, nowMs)
      : d.grade === "brief" ? gradeBrief(v.data_date, tp)
      : gradeMarket(v.data_date, tp);
    return { id: d.id, name: d.name, data_date: v.data_date, updated_at: v.updated_at, level, note: v.note || "" };
  });
  return { schema: 1, generated_at: isoTaipei(nowMs), status: "ok", sites };
}

// ---- HTTP ----
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };
const json = (obj, extra) => new Response(JSON.stringify(obj), {
  headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...(extra || {}) },
});

export default {
  // Cron 三個時段共用同一個 handler（見 wrangler.toml [triggers]）：
  //   盤中每分鐘 → 存分鐘 frame；傍晚哨兵窗口 → FinMind 落地探測（每 5 分一輪）；
  //   每天每小時 :07（台北 06–22 時）→ dispatch taiwan-stock-news 新聞管線
  async scheduled(event, env, ctx) {
    const tp = taipeiParts(new Date(event.scheduledTime));
    // 主排程/備援/晚場/am 路由（最先判斷，先於 scheduledRole——晚場與 am 窗的台北時刻
    // 落在哨兵窗（17-23 時 %5 分）/:07/:47 分流範圍，不先攔截會誤入 sentinel/news/idle）。
    // event.cron 精確比對，與既有 frame/哨兵/news/morning cron 各自的 event 互不干擾。
    const droute = dispatchRoleForCron(event.cron);
    if (droute) {
      if (droute.kind === "backup") {
        const bpipe = backupPipelineForCron(event.cron, env);
        ctx.waitUntil(runBackup(env, tp, bpipe).catch((e) => console.log("backup:", e && e.message)));
      } else if (droute.kind === "evening") {
        ctx.waitUntil(runEvening(env, tp).catch((e) => console.log("evening:", e && e.message)));
      } else if (droute.kind === "health") {
        // 健檢班：不 dispatch、只盤點產物，缺件告警（失敗只 log，絕不影響其他班）
        ctx.waitUntil(runHealthCheck(env, tp, droute.slot).catch((e) => console.log("health:", e && e.message)));
      } else if (droute.kind === "summary-am") {
        ctx.waitUntil(runSummaryDispatch(env, tp, "am").catch((e) => console.log("summary-am:", e && e.message)));
        // 晨間圖卡（AM slot，2026-08-10）：同窗並存的第二件事——08:05–08:15 dispatch 渲染、
        // 08:20–08:50 推播；runMorning 內部各步已 try/catch，絕不影響上面的 summary-am
        ctx.waitUntil(runMorning(env, tp).catch((e) => console.log("morning-cards:", e && e.message)));
        // us 晨間補跑（2026-08-13）：同窗第三件事——台北 07:00-08:05 檢查 us.json 資料日，
        // 未達預期即 dispatch us.yml（rounds=2）；獨立 waitUntil，失敗不影響前兩件
        ctx.waitUntil(runUsCatchup(env, tp).catch((e) => console.log("us-catchup:", e && e.message)));
      }
      return;
    }
    const role = scheduledRole(tp, event.cron);
    if (role === "idle") return;   // 哨兵窗口內的非 %5 分鐘：直接省下
    if (role === "news") {
      // 失敗只 log（22:37 GitHub cron 備援＋下一小時自然重試），不影響既有功能
      ctx.waitUntil(dispatchNews(env).catch((e) => console.log("news dispatch:", e && e.message)));
      return;
    }
    if (role === "morning") {
      ctx.waitUntil(dispatchMorning(env).catch((e) => console.log("morning dispatch:", e && e.message)));
      return;
    }
    if (role === "sentinel") {
      // 哨兵整段獨立 try/catch（runSentinel 內部已逐步吞錯），不影響既有功能
      ctx.waitUntil(runSentinel(env, tp).catch((e) => console.log("sentinel:", e && e.message)));
      return;
    }
    // frame key 由喚醒時間決定（scheduledTime）；失敗除 log 外寫 err:<date> 可見化（不再靜默斷檔）
    // 第九期：frame 存成功後接離線提醒偵測（同一班、不加 cron）；偵測失敗只 log，不影響 frame
    ctx.waitUntil(storeFrame(env, event.scheduledTime)
      .then((res) => (res && res.key)
        ? runAlerts(env, tp, res.key).catch((e) => console.log("alerts:", e && e.message))
        : null)
      .catch(async (e) => {
        console.log("storeFrame:", e && e.message);
        await recordFrameErr(env, tp.date, e);
      }));
    // 案三：收盤前 13:25–13:40 每分鐘保底定格 flow:last（不依賴 /live 流量，頁面沒開也保證
    // 每交易日落一份；與 storeFrame 並行互不影響，失敗只 log）。窗口/非null 守門在 storeFlowLast。
    if (inFlowLastWindow(tp)) {
      ctx.waitUntil(buildLive(env)
        .then((live) => storeFlowLast(env, live, tp))
        // 結果一定要 log：原本整個丟掉，守門若誤擋就會靜默失效，唯一症狀是前端永遠
        // 顯示「盤中每分鐘累積後生效」——正是這個 bug 當初難被發現的同一個機制。
        .then((r) => { if (r && !r.stored) console.log("flowLast 未寫入:", r.reason); })
        .catch((e) => console.log("flowLast:", e && e.message)));
    }
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (url.pathname === "/snap") {  // 手動觸發存 frame（測試/補格用；force=1 略過收盤後守門）
      try {
        return json(await storeFrame(env, undefined, { force: url.searchParams.get("force") === "1" }));
      } catch (e) {
        return json({ error: String(e && e.message || e) });
      }
    }
    if (url.pathname === "/usersync") {  // 自選清單跨裝置同步
      const k = (url.searchParams.get("k") || "").trim();
      if (k.length < 4 || k.length > 64) return json({ error: "同步碼需 4~64 字元" });
      const key = await syncKey(k);
      const set = url.searchParams.get("set");
      if (set !== null) {
        const list = [...new Set(set.toUpperCase().split(",").map((s) => s.trim()).filter((s) => USW_RE.test(s)))].slice(0, 12);
        await env.FLOW_KV.put(key, JSON.stringify(list));
        return json({ ok: true, list });
      }
      return json({ list: (await env.FLOW_KV.get(key, "json")) || [] });
    }
    if (url.pathname === "/uswatch") {  // 美股自選報價
      const list = [...new Set((url.searchParams.get("t") || "").toUpperCase()
        .split(",").map((s) => s.trim()).filter((s) => USW_RE.test(s)))].slice(0, 12);
      if (!list.length) return json({ error: "t 參數需為逗號分隔代號（≤12 檔）" });
      return json({ rows: await usWatch(env, list) }, { "Cache-Control": "public, max-age=300" });
    }
    if (url.pathname === "/fundamentals") {  // 個股追蹤基本面（?id=單股回物件／?ids=批次回 {stocks}）
      const date = taipeiParts().date;
      const idsRaw = url.searchParams.get("ids"), single = url.searchParams.get("id");
      const ids = [...new Set((idsRaw || single || "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => FUND_RE.test(s)))].slice(0, 30);
      if (!ids.length) return json({ error: "id/ids 參數需為逗號分隔台股代號（≤30 檔）" }, { "Cache-Control": "no-store" });
      const stocks = await fundamentalsBatch(env, ids, date);
      const body = idsRaw === null ? stocks[0] : { stocks, date };
      return json(body, { "Cache-Control": "public, max-age=1800" });
    }
    if (url.pathname === "/chips") {  // 個股追蹤籌碼面（?id=單股回物件／?ids=批次回 {stocks}）
      const date = taipeiParts().date;
      const idsRaw = url.searchParams.get("ids"), single = url.searchParams.get("id");
      const ids = [...new Set((idsRaw || single || "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => FUND_RE.test(s)))].slice(0, 30);
      if (!ids.length) return json({ error: "id/ids 參數需為逗號分隔台股代號（≤30 檔）" }, { "Cache-Control": "no-store" });
      const stocks = await chipsBatch(env, ids, date);
      const body = idsRaw === null ? stocks[0] : { stocks, date };
      return json(body, { "Cache-Control": "public, max-age=1800" });
    }
    if (url.pathname === "/technical") {  // 個股追蹤技術面（?id=單股回物件／?ids=批次回 {stocks}）
      const date = taipeiParts().date;
      const idsRaw = url.searchParams.get("ids"), single = url.searchParams.get("id");
      const ids = [...new Set((idsRaw || single || "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => FUND_RE.test(s)))].slice(0, 30);
      if (!ids.length) return json({ error: "id/ids 參數需為逗號分隔台股代號（≤30 檔）" }, { "Cache-Control": "no-store" });
      const stocks = await technicalBatch(env, ids, date);
      const body = idsRaw === null ? stocks[0] : { stocks, date };
      return json(body, { "Cache-Control": "public, max-age=1800" });
    }
    if (url.pathname === "/cards/data") {  // LINE 圖卡資料（PNG 渲染管線上游，spec 3C）
      // cf 快取 5 分鐘（caches.default，同 /live 慣例）：Actions 渲染班打一次、
      // 其餘流量吃快取；來源全為公開 raw JSON 的加工，無需鑑權。
      // ?slot=am（2026-08-10）＝晨間場。cacheKey 把 slot 併進 path——caches.default 的
      // 快取鍵原本丟棄 query string，am/pm 若共用同一鍵，5 分內互打會拿到對方的卡。
      const slot = url.searchParams.get("slot") === "am" ? "am" : "pm";
      const cache = caches.default;
      const cacheKey = new Request(new URL(`/cards/data/${slot}`, url.origin).toString());
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
      try {
        const body = await buildCardsData(env, taipeiParts(), fetch, { slot });
        const resp = json(body, { "Cache-Control": "public, max-age=300" });
        ctx.waitUntil(cache.put(cacheKey, resp.clone()));
        return resp;
      } catch (e) {
        return json({ error: String(e && e.message || e) }, { "Cache-Control": "no-store" });
      }
    }
    if (url.pathname === "/replay") {  // 第五期：當日回放（frame 當日不變 → 命中時短快取 60s）
      const dq = url.searchParams.get("date") || "";   // date 僅供驗證/測試（正式前端不帶＝台北今日）
      const d = /^\d{4}-\d{2}-\d{2}$/.test(dq) ? dq : taipeiParts().date;
      const t = url.searchParams.get("t");
      try {
        if (t === null) {   // 不帶 t：回當日全日分鐘序列（收盤總結曲線用；1 次 get，無 list）
          const series = (await env.FLOW_KV.get(`series:${d}`, "json")) || [];
          return json({ date: d, series }, { "Cache-Control": "public, max-age=60" });
        }
        const out = await replayFrame(env, d, t);
        return json(out, { "Cache-Control": out.error ? "no-store" : "public, max-age=60" });
      } catch (e) {
        return json({ error: String(e && e.message || e) }, { "Cache-Control": "no-store" });
      }
    }
    if (url.pathname === "/alerts/test") {  // 第九期：手動驗證外送通道（未設 secret 回明確 JSON，不觸外部請求）
      try {
        const r = await sendAlert(env, `[台股提醒 測試] 通道驗證訊息（${taipeiParts().date}），收到代表提醒通道設定成功`);
        // KV 有 line:uid（使用者傳過訊息給 bot）就附帶顯示，供設定 LINE_USER_ID 時抄用
        const uid = env.FLOW_KV ? await env.FLOW_KV.get("line:uid") : null;
        if (uid) r.line_uid = uid;
        return json({ ok: r.sent, ...r }, { "Cache-Control": "no-store" });
      } catch (e) {
        return json({ ok: false, sent: false, error: String(e && e.message || e) }, { "Cache-Control": "no-store" });
      }
    }
    if (url.pathname === "/line/webhook") {  // 第九期 LINE：一次性 userId 擷取（詳 handleLineWebhook 註解）
      try {
        const body = request.method === "POST" ? await request.json().catch(() => null) : null;
        return json(await handleLineWebhook(env, body), { "Cache-Control": "no-store" });
      } catch (e) {   // LINE 平台要求回 200：任何錯誤照回 ok（僅 log 用途）
        return json({ ok: true, error: String(e && e.message || e) }, { "Cache-Control": "no-store" });
      }
    }
    if (url.pathname === "/backup") {  // 排程備援手動檢查（dry 預設 1：只回決策不真的 dispatch；dry=0 才真的補發）
      const name = url.searchParams.get("name");
      const pipe = backupPipelines(env).find((p) => p.name === name);
      if (!pipe) return json({ error: "name 需為 " + backupPipelines(env).map((p) => p.name).join("/") }, { "Cache-Control": "no-store" });
      const dry = url.searchParams.get("dry") !== "0";
      try {
        const out = await runBackup(env, taipeiParts(), pipe, fetch, { dry });
        return json({ dry, ...out }, { "Cache-Control": "no-store" });
      } catch (e) {
        return json({ error: String(e && e.message || e) }, { "Cache-Control": "no-store" });
      }
    }
    if (url.pathname === "/sumcheck") {  // summary 觸發手動檢查（?slot=am|pm；dry 預設 1，dry=0 才真發）
      const slot = url.searchParams.get("slot");
      if (slot !== "am" && slot !== "pm") return json({ error: "slot 需為 am/pm" }, { "Cache-Control": "no-store" });
      const dry = url.searchParams.get("dry") !== "0";
      try {
        const out = await runSummaryDispatch(env, taipeiParts(), slot, fetch, { dry });
        return json({ dry, ...out }, { "Cache-Control": "no-store" });
      } catch (e) {
        return json({ error: String(e && e.message || e) }, { "Cache-Control": "no-store" });
      }
    }
    if (url.pathname === "/evening") {  // 晚場協調班手動檢查（dry 預設 1；dry=0 真發，各步各自冪等）
      const dry = url.searchParams.get("dry") !== "0";
      try {
        const out = await runEvening(env, taipeiParts(), fetch, { dry });
        return json({ dry, ...out }, { "Cache-Control": "no-store" });
      } catch (e) {
        return json({ error: String(e && e.message || e) }, { "Cache-Control": "no-store" });
      }
    }
    if (url.pathname === "/health") {  // 日終/晨間健檢手動查（?slot=eve|morn；dry 預設 1＝只回結果不告警）
      const slot = url.searchParams.get("slot") || "eve";
      if (slot !== "eve" && slot !== "morn") return json({ error: "slot 需為 eve/morn" }, { "Cache-Control": "no-store" });
      const dry = url.searchParams.get("dry") !== "0";
      // ?date= 可回頭盤點某一天（除錯用；健檢不 dispatch 任何東西，最壞只是多抓幾份產物）
      const d = url.searchParams.get("date");
      const tp = d ? { ...taipeiParts(), date: d } : taipeiParts();
      try {
        const out = await runHealthCheck(env, tp, slot, fetch, { dry });
        return json({ dry, ...out }, { "Cache-Control": "no-store" });
      } catch (e) {
        return json({ error: String(e && e.message || e) }, { "Cache-Control": "no-store" });
      }
    }
    if (url.pathname === "/jobs") {  // 排程狀態軌跡（?date=YYYY-MM-DD，預設今日；單 key 1 get，無 list）
      const d = url.searchParams.get("date") || taipeiParts().date;
      try {
        const events = (await env.FLOW_KV.get(jobstatKey(d), "json")) || [];
        return json({ date: d, count: events.length, events }, { "Cache-Control": "no-store" });
      } catch (e) {
        return json({ error: String(e && e.message || e) }, { "Cache-Control": "no-store" });
      }
    }
    if (url.pathname === "/status") {  // 全系統資料健康端點（五站紅黃綠；新資料規範 schema:1 首例）
      // cf 快取 5 分鐘：cacheKey 用獨立 path（同 /cards/data 慣例——caches.default 丟棄
      // query string，獨立 path 可避免與其他路由互踩；/status 本身無參數，固定一鍵）。
      const cache = caches.default;
      const cacheKey = new Request(new URL("/status/v1", url.origin).toString());
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
      try {
        const body = await buildStatus(env, taipeiParts(), fetch);
        const resp = json(body, { "Cache-Control": "public, max-age=300" });
        ctx.waitUntil(cache.put(cacheKey, resp.clone()));
        return resp;
      } catch (e) {   // buildStatus 內已 allSettled，理論上不拋；此處為最後保險
        return json({ error: String(e && e.message || e) }, { "Cache-Control": "no-store" });
      }
    }
    if (url.pathname === "/alerts/log") {  // 第九期：近 24h 事件紀錄（單 key 1 get，無 list）
      try {
        const lg = (await env.FLOW_KV.get(ALERTS_LOG_KEY, "json")) || { ev: [] };
        const now = Date.now();
        const events = lg.ev.filter((e) => now - e.ts < 24 * 3600e3)
          .map((e) => ({ at: new Date(e.ts).toISOString(), id: e.id, msg: e.msg, sent: e.sent }));
        return json({ events }, { "Cache-Control": "no-store" });
      } catch (e) {
        return json({ error: String(e && e.message || e) }, { "Cache-Control": "no-store" });
      }
    }
    if (url.pathname !== "/live") {
      const out = { ok: true, service: "taiwan-flow-v2", endpoints: ["/live", "/snap", "/usersync", "/uswatch", "/fundamentals", "/chips", "/technical", "/replay", "/cards/data", "/line/webhook", "/alerts/test", "/alerts/log", "/backup", "/sumcheck", "/evening", "/health", "/jobs", "/status"] };
      // 輕量健康資訊（僅根路徑；2 次 KV get，讀既有 fi 索引與 err key，無 list）：
      // 當日 frame 數＋最後 storeFrame 錯誤——07-16/17 斷檔兩天無人知的可見化補課
      if (url.pathname === "/" && env.FLOW_KV) {
        try {
          const tpd = taipeiParts().date;
          const [fi, err] = await Promise.all([
            env.FLOW_KV.get(`fi:${tpd}`, "json"),
            env.FLOW_KV.get(`err:${tpd}`, "json"),
          ]);
          out.health = { date: tpd, frames_today: (fi || []).length, last_err: err || null };
        } catch (e) {
          out.health = { error: String(e && e.message || e) };
        }
      }
      return json(out);
    }
    // stale-while-revalidate：新鮮(≤LIVE_TTL秒)直接回；過期但未太舊(≤STALE秒)先回舊資料、
    // 背景重建下一份（使用者永遠毫秒級回應，不用同步等 FinMind）；太舊才同步重建。
    const FRESH_MS = Number(env.LIVE_TTL || 15) * 1000;
    const STALE_MS = 120 * 1000;
    const cache = caches.default;
    const cacheKey = new Request(new URL("/live", url.origin).toString());
    const rebuild = async () => {
      const live = await buildLive(env);
      const resp = json(live, { "Cache-Control": "public, max-age=120", "x-gen": String(Date.now()) });
      await cache.put(cacheKey, resp.clone());
      return resp;
    };
    const hit = await cache.match(cacheKey);
    if (hit) {
      const age = Date.now() - Number(hit.headers.get("x-gen") || 0);
      if (age < FRESH_MS) return hit;
      if (age < STALE_MS) {
        ctx.waitUntil(rebuild().catch(() => {}));   // 背景刷新，失敗下次再試
        return hit;
      }
    }
    try {
      return await rebuild();
    } catch (e) {
      return json({ error: String(e && e.message || e) }, { "Cache-Control": "no-store" });
    }
  },
};
