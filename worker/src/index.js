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
    ts = ts || r.date;
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
// GitHub workflow_dispatch 請求（純建構、可離線驗 URL/headers/body）
export function ghDispatchRequest(repo, wf, token) {
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
      body: JSON.stringify({ ref: "main" }),
    },
  };
}
async function ghDispatch(env, repo, wf, fetchFn = fetch) {
  const { url, init } = ghDispatchRequest(repo, wf, env.GH_DISPATCH_TOKEN);
  const r = await fetchFn(url, init);
  if (r.status !== 204) throw new Error(`dispatch ${repo}/${wf} HTTP ${r.status}`);
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
// 每個時點只有新聞 cron 一次醒來，不需 KV 去重。dispatch 失敗只 log 不重試：
// 下一小時自然再觸發，且 news repo 保留 22:37 台北 GitHub cron 當備援兜底。
const NEWS_REPO = "taiwan-stock-news";
const NEWS_WF = "build-news.yml";
export async function dispatchNews(env, fetchFn = fetch) {
  if (!env.GH_DISPATCH_TOKEN) return false;   // secret 未設 → 安靜跳過（同哨兵）
  await ghDispatch(env, NEWS_REPO, NEWS_WF, fetchFn);
  console.log(`news: dispatched ${NEWS_REPO}/${NEWS_WF}`);
  return true;
}
// 晨報準點班（平日 06:47）：dispatch 本 repo 的 morning.yml。
// GitHub cron 06:00（延遲後 ~07:00 跑）保留當備援，晨報建置冪等、多跑無害。
const MORNING_REPO = "taiwan-flow-live-v2";
const MORNING_WF = "morning.yml";
export async function dispatchMorning(env, fetchFn = fetch) {
  if (!env.GH_DISPATCH_TOKEN) return false;
  await ghDispatch(env, MORNING_REPO, MORNING_WF, fetchFn);
  console.log(`morning: dispatched ${MORNING_REPO}/${MORNING_WF}`);
  return true;
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
    ctx.waitUntil(storeFrame(env, event.scheduledTime).catch(async (e) => {
      console.log("storeFrame:", e && e.message);
      await recordFrameErr(env, tp.date, e);
    }));
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
    if (url.pathname !== "/live") {
      const out = { ok: true, service: "taiwan-flow-v2", endpoints: ["/live", "/snap", "/uswatch", "/replay"] };
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
