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
async function finSnapshot(token) {
  const r = await fetch(`${FIN_SNAP}?token=${encodeURIComponent(token)}`);
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
  // flow_last（additive 頂層欄位；flow 非 null 時不附、不多讀）。既有欄位零改動。
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
    await env.FLOW_KV.put(idxKey, JSON.stringify(idx.sort()), { expirationTtl: 172800 });
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
// 保留當日全部（盤中每分鐘一筆，≤270 筆，遠低於 KV 單值 25MB 上限）；同一分鐘重跑覆寫最後一筆（冪等）。
export async function appendSeries(env, d, hm, mktAmtRaw, idxRow) {
  const key = `series:${d}`;
  const arr = (await env.FLOW_KV.get(key, "json")) || [];
  const point = {
    t: hm,
    amt: r1(mktAmtRaw / 1e8),
    idx: idxRow ? orNull(idxRow.close) : null,
    chg: idxRow ? orNull(idxRow.change_price) : null,
  };
  if (arr.length && arr[arr.length - 1].t === hm) arr[arr.length - 1] = point;
  else arr.push(point);
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

async function pickFrames(env, d, nowMin, wins) {
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
  const flow = {
    wins: { w1: W1, w2: W2 },
    frames: Object.fromEntries(wins.map((w) => [w, frames[w].name.slice(-5)])),
    baseline_date: baseline.date,
    subs: subList,
    mkt,
  };
  return { flow, per: stockFlow };
}

// ---- 案三（2026-07-19）：收盤前定格 flow:last ——盤外/週末即時一覽「象限圖＋treemap 角標」fallback ----
// 動機：flow 盤外為 null、frame TTL 2 天 → 盤外沒有短窗資料可退回；收盤前把最後一份非 null flow
//   定格存 KV，/live 於 flow=null 時附頂層 flow_last，前端僅象限圖與角標退回定格值（標註資料日）。
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
// 窗口內且 flow 非 null 才覆寫單一 key（冪等；TTL 7 天）
export async function storeFlowLast(env, live, tp) {
  if (!env.FLOW_KV || !inFlowLastWindow(tp)) return { stored: false, reason: "窗口外" };
  const pl = flowLastPayload(live);
  if (!pl) return { stored: false, reason: "flow null" };
  await env.FLOW_KV.put(FLOW_LAST_KEY, JSON.stringify(pl), { expirationTtl: FLOW_LAST_TTL });
  return { stored: true, key: FLOW_LAST_KEY, date: pl.date };
}
// /live 附掛：flow=null 時 1 次 get；KV 讀失敗吞錯不影響 /live 主體
export async function attachFlowLast(env, live) {
  if (!live || live.flow != null || !env.FLOW_KV) return live;
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
//   例外：盤中 frame cron（* 1-5 * * 1-5）在 9:07–13:07 也會於 :07 醒來（兩條 cron
//   同分重疊、各發一個 scheduled 事件），frame cron 醒來的那個要照存 frame，
//   否則會重複 dispatch news 且掉一格分鐘 frame——所以用 event.cron 排除它。
//   17:07–22:07 落在哨兵窗口內但 7 不是 %5==0（原本是 idle），改判 news 不衝突。
// - morning：平日 06:47 → dispatch 本 repo morning.yml（晨報準點產出；夜盤 05:00
//   收盤後留 ~1.5 小時給 FinMind 入庫。GitHub cron 06:00 保留當備援，冪等多跑無害）。
// - sentinel：平日 17:00–22:59 台北每 5 分一輪盤後落地探測，其餘分鐘 idle。
// - frame：其餘（實際上只有盤中 cron 會打到）。週六日永不進哨兵。
export const FRAME_CRON = "* 1-5 * * 1-5";   // 需與 wrangler.toml crons[0] 完全一致
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
//   mode "genToday" → generated_at 的台北日 === 今日（us 產物 date 欄是美股交易日、天生落後一日，
//                     改判「今天有沒有跑過」）。
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
    { name: "us",         repo: "taiwan-flow-live-v2", wf: "us.yml",         url: `${V2}/us.json`,                field: "generated_at", mode: "genToday", tw: false },
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
  "35 5 * * 1-5":  "daysummary",   // 台北 13:35 主觸發（/live 13:30 收盤定格後即備；GH 備援 14:35）
  "40 6 * * 1-5":  "intraday",     // 台北 14:40 備援（GH 主班 14:10 先跑先贏，缺檔才補發）
  "35 10 * * 1-5": "aetf",         // 台北 18:35 主觸發（GH 備援 19:05；二段見 runEvening aetf2）
  "5 12 * * 1-5":  "baseline",     // 台北 20:05 主觸發（法人官方 20:00＋腳本自帶 10 分×4 重試；GH 備援 21:15）
  // us 主觸發 05:05 台北 = 21:05 UTC 前一日；CF cron 拒收 dow 0-4（code 10100），改用 dow *、
  // 週末守門移到 runBackup 內用台北 dow（21:05 UTC 只在台北一~五晨落在平日）：
  "5 21 * * *":    "us",           // 台北 05:05 主觸發（GH 備援 06:10）；weekend 由 runBackup dow 守門
};
// 非單體班的排程角色（cron 字串 → 角色；晚場協調班／am summary 輪詢窗）
export const DISPATCH_ROLES = {
  "*/5 13-15 * * 1-5": "evening",      // 台北 21:00–23:55 每 5 分：pm summary→diag 鏈→mktbal 鏈→aetf2
  "50,55 22 * * *":    "summary-am",   // 台北 06:50/06:55 起手（dow 程式守門）
  "*/5 23 * * *":      "summary-am",   // 台北 07:00–07:55 主窗（morning 常態 07:1x 落地）
  "*/10 0 * * *":      "summary-am",   // 台北 08:00–08:50 尾窗兜底（morning 遲到仍趕 09:00 前）
};
// 統一路由（scheduled handler 最先判，先於 scheduledRole——晚場/am 窗的台北時刻落在
// 哨兵窗（17-23 時 %5 分）與 :47/:07 分流範圍，不先攔截會誤入 sentinel/news/idle）
export function dispatchRoleForCron(cron) {
  if (BACKUP_CRONS[cron]) return { kind: "backup", name: BACKUP_CRONS[cron] };
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
    // us（美股班）：cron 用 dow *（CF 拒收 0-4），週末守門改在此用台北 dow——21:30 UTC 只在
    // 台北一~五晨落平日；台北六/日晨（UTC 五/六）不補發，避免週末對無新資料的 us.yml 空轉補發
    return { name: pipe.name, skipped: "non-trading-day" };
  }
  const key = bkfiredKey(today, pipe.name);
  if (env.FLOW_KV && await env.FLOW_KV.get(key)) return { name: pipe.name, skipped: "already-fired" };   // 冪等
  let obj = null, fetchErr = null;
  // {date} 佔位：intraday 產物按日命名（data/intraday/YYYY-MM-DD.json），代入今日；
  // 當日檔 404 → obj=null → 不新鮮 → 補發，語意與固定 URL 班一致
  try { obj = await fetchProduct(pipe.url.replace("{date}", today), fetchFn); }
  catch (e) { fetchErr = String((e && e.message) || e); }
  const productDate = obj ? String(obj[pipe.field] || "") : null;
  if (productFresh(obj, pipe, today)) return { name: pipe.name, fresh: true, productDate };   // 原班已跑 → 不發
  if (opts.dry) return { name: pipe.name, fresh: false, wouldDispatch: true, productDate, today, fetchErr };
  try {
    await ghDispatchWithRetry(env, pipe.repo, pipe.wf, fetchFn, opts.sleepFn || sleep);
    if (env.FLOW_KV) await env.FLOW_KV.put(key, "fired", { expirationTtl: BKFIRED_TTL });
    console.log(`backup: ${pipe.name} 產物非今日(${productDate}) → dispatched ${pipe.repo}/${pipe.wf}`);
    return { name: pipe.name, fired: true, productDate };
  } catch (e) {
    // dispatch 兩次都失敗 → log 後放棄該班（KV 不記，理論上明日同班 cron 再檢查；當日 aetf 另有 runEvening aetf2 二段兜底）
    console.log(`backup dispatch ${pipe.name}:`, e && e.message);
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
    if (env.FLOW_KV) await env.FLOW_KV.put(key, "produced", { expirationTtl: BKFIRED_TTL });
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
    if (env.FLOW_KV) await env.FLOW_KV.put(key, "fired", { expirationTtl: BKFIRED_TTL });
    console.log(`summary: ${slot} 上游全齊 → dispatched ${SUMMARY_REPO}/${SUMMARY_WF} slot=${slot}`);
    return { slot, fired: true };
  } catch (e) {
    console.log(`summary dispatch ${slot}:`, e && e.message);   // KV 不記 → 下輪自動重試
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
  if (env.FLOW_KV && await env.FLOW_KV.get(key)) return { name: pipe.name, skipped: "already-fired" };
  const selfObj = await getP(pipe.url.replace("{date}", today));
  const depObj = await getP(pipe.dep.url);
  const step = chainStep(pipe, depObj, selfObj, today);
  if (step.action === "fresh") {
    if (env.FLOW_KV) await env.FLOW_KV.put(key, "produced", { expirationTtl: BKFIRED_TTL });
    return { name: pipe.name, fresh: true };
  }
  if (step.action === "wait-dep") return { name: pipe.name, waiting: "dep", depDate: step.depDate };
  if (opts.dry) return { name: pipe.name, wouldDispatch: true };
  try {
    await ghDispatchWithRetry(env, pipe.repo, pipe.wf, fetchFn, opts.sleepFn || sleep);
    if (env.FLOW_KV) await env.FLOW_KV.put(key, "fired", { expirationTtl: BKFIRED_TTL });
    console.log(`chain: ${pipe.name} 上游今日已備 → dispatched ${pipe.repo}/${pipe.wf}`);
    return { name: pipe.name, fired: true };
  } catch (e) {
    console.log(`chain dispatch ${pipe.name}:`, e && e.message);
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
    if (env.FLOW_KV) await env.FLOW_KV.put(key, "fired", { expirationTtl: BKFIRED_TTL });
    console.log("aetf2: 二段補抓 dispatched");
    return { name: "aetf2", fired: true };
  } catch (e) {
    console.log("aetf2 dispatch:", e && e.message);
    return { name: "aetf2", error: String((e && e.message) || e) };
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
export function lineRequest(token, userId, text) {
  return { url: "https://api.line.me/v2/bot/message/push", init: { method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ to: userId, messages: [{ type: "text", text }] }) } };
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
      } else if (droute.kind === "summary-am") {
        ctx.waitUntil(runSummaryDispatch(env, tp, "am").catch((e) => console.log("summary-am:", e && e.message)));
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
      const out = { ok: true, service: "taiwan-flow-v2", endpoints: ["/live", "/snap", "/uswatch", "/fundamentals", "/chips", "/replay", "/alerts/test", "/alerts/log", "/backup", "/sumcheck", "/evening"] };
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
