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
  return aggregate(cl, rows, limits, lw);
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
// key = f:<資料日>:<HH:MM>（取快照自身時間戳 → 收盤後重跑覆寫同 key，冪等）
// value = {code: 累計成交額}；expirationTtl 2 天自動清理
async function storeFrame(env) {
  const rows = await finSnapshot(env.FINMIND_TOKEN);
  let ts = null;
  const amt = {};
  for (const r of rows) {
    const c = String(r.stock_id || "");
    if (!c || c === "001" || c === "101") continue;
    ts = ts || String(r.date || "");
    const a = num(r.total_amount);
    if (a > 0) amt[c] = Math.round(a);
  }
  if (!ts) throw new Error("snapshot 無資料");
  const d = ts.slice(0, 10), hm = ts.slice(11, 16);
  await env.FLOW_KV.put(`f:${d}:${hm}`, JSON.stringify(amt), { expirationTtl: 172800 });
  return { key: `f:${d}:${hm}`, stocks: Object.keys(amt).length };
}

// ---- HTTP ----
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };
const json = (obj, extra) => new Response(JSON.stringify(obj), {
  headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...(extra || {}) },
});

export default {
  // Cron（盤中每分鐘）：存分鐘 frame
  async scheduled(event, env, ctx) {
    ctx.waitUntil(storeFrame(env).catch((e) => console.log("storeFrame:", e.message)));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (url.pathname === "/snap") {  // 手動觸發存 frame（測試/補格用）
      try {
        return json(await storeFrame(env));
      } catch (e) {
        return json({ error: String(e && e.message || e) });
      }
    }
    if (url.pathname !== "/live") {
      return json({ ok: true, service: "taiwan-flow-v2", endpoints: ["/live", "/snap"] });
    }
    const cache = caches.default;
    const cacheKey = new Request(new URL("/live", url.origin).toString());
    const hit = await cache.match(cacheKey);
    if (hit) return hit;                            // 命中快取（未過期）→ 秒回、不打 FinMind
    try {
      const live = await buildLive(env);
      const ttl = Number(env.LIVE_TTL || 15);
      const resp = json(live, { "Cache-Control": `public, max-age=${ttl}` });
      ctx.waitUntil(cache.put(cacheKey, resp.clone()));
      return resp;
    } catch (e) {
      return json({ error: String(e && e.message || e) }, { "Cache-Control": "no-store" });
    }
  },
};
