// 離線移植正確性測試：用 V1 產出的 data/live.json 反推快照列，餵進 Worker 的 aggregate()，
// 比對是否重現 V1 的 market / exchange / stocks 數字。無需 FINMIND token。
//
// 執行：cd worker && node test/parity.mjs
import { readFileSync } from "node:fs";
import { aggregate } from "../src/index.js";

const DATA = new URL("../../data/", import.meta.url);
const rd = (f) => JSON.parse(readFileSync(new URL(f, DATA), "utf-8"));
const classify = rd("classify.json");
const lastweek = rd("lastweek.json");
const ref = rd("live.json");          // V1 參考輸出

// --- 反推快照列 ---
const SC = ref.stock_cols;            // [chg,amt,close,vol,bv,sv,pts,dp,lim,lw]
const gi = (k) => SC.indexOf(k);
const rows = [];
const limits = {};
for (const [code, a] of Object.entries(ref.stocks)) {
  const chg = a[gi("chg")], amt = a[gi("amt")], close = a[gi("close")], vol = a[gi("vol")];
  const bv = a[gi("bv")], sv = a[gi("sv")], dp = a[gi("dp")], lim = a[gi("lim")];
  rows.push({ stock_id: code, date: ref.ts, change_rate: chg, total_amount: amt,
    close, total_volume: vol, buy_volume: bv, sell_volume: sv, change_price: dp });
  if (lim === 1) limits[code] = [close, 0];        // 重現漲停：close>=limit_up
  else if (lim === -1) limits[code] = [0, close];  // 重現跌停：close<=limit_down
}
// 指數 pseudo-row
const ix = (code, d) => rows.push({ stock_id: code, date: ref.ts, close: d.val,
  change_price: d.chgP, change_rate: d.chg, total_volume: d.vol, total_amount: (d.amt_yi || 0) * 1e8 });
ix("001", ref.index.tse); ix("101", ref.index.otc);

const got = aggregate(classify.map, rows, limits, lastweek);

// --- 比對 ---
let pass = 0, fail = 0;
const approx = (a, b, tol) => Math.abs(a - b) <= tol;
function chk(name, ok, detail) {
  if (ok) { pass++; } else { fail++; console.log(`  ✗ ${name}  ${detail || ""}`); }
}

// market
for (const k of ["tse", "otc"]) {
  const g = got.market[k], r = ref.market[k];
  chk(`market.${k}.amt_yi`, approx(g.amt_yi, r.amt_yi, 0.5), `got ${g.amt_yi} ref ${r.amt_yi}`);
  for (const f of ["up", "down", "flat", "n", "up_lim", "down_lim"])
    chk(`market.${k}.${f}`, g[f] === r[f], `got ${g[f]} ref ${r[f]}`);
  chk(`market.${k}.lw_amt_yi`, approx(g.lw_amt_yi, r.lw_amt_yi, 0.5), `got ${g.lw_amt_yi} ref ${r.lw_amt_yi}`);
}

// exchange：逐類股比對（sector 對齊）
const refEx = Object.fromEntries(ref.exchange.map((s) => [s.sector, s]));
for (const s of got.exchange) {
  const r = refEx[s.sector];
  if (!r) { chk(`exchange sector 存在:${s.sector}`, false); continue; }
  for (const mk of ["tse", "otc"]) {
    chk(`exchange[${s.sector}].${mk}.amt_yi`, approx(s[mk].amt_yi, r[mk].amt_yi, 0.5), `got ${s[mk].amt_yi} ref ${r[mk].amt_yi}`);
    chk(`exchange[${s.sector}].${mk}.n`, s[mk].n === r[mk].n, `got ${s[mk].n} ref ${r[mk].n}`);
    chk(`exchange[${s.sector}].${mk}.pts`, approx(s[mk].pts, r[mk].pts, 1.0), `got ${s[mk].pts} ref ${r[mk].pts}`);
  }
}
chk("exchange 類股數", got.exchange.length === ref.exchange.length, `got ${got.exchange.length} ref ${ref.exchange.length}`);

// Σ 類股貢獻點 ≈ 指數漲跌點（自洽）
const sumPts = (mk) => got.exchange.reduce((a, s) => a + s[mk].pts, 0);
chk("Σexchange.tse.pts ≈ 加權漲跌點", approx(sumPts("tse"), ref.index.tse.chgP, 5), `got ${sumPts("tse").toFixed(1)} idx ${ref.index.tse.chgP}`);
chk("Σexchange.otc.pts ≈ 櫃買漲跌點", approx(sumPts("otc"), ref.index.otc.chgP, 5), `got ${sumPts("otc").toFixed(1)} idx ${ref.index.otc.chgP}`);

// stocks 抽樣：非 pts 欄位應完全一致
const codes = Object.keys(ref.stocks).slice(0, 200);
let sMis = 0;
for (const c of codes) {
  const g = got.stocks[c], r = ref.stocks[c];
  for (const f of ["chg", "amt", "close", "vol", "bv", "sv", "dp", "lim", "lw"])
    if (g[gi(f)] !== r[gi(f)]) { sMis++; if (sMis <= 5) console.log(`  ✗ stocks[${c}].${f} got ${g[gi(f)]} ref ${r[gi(f)]}`); }
}
chk(`stocks 抽樣 200 檔非 pts 欄位一致`, sMis === 0, `${sMis} 個不符`);
chk("stocks 檔數", Object.keys(got.stocks).length === Object.keys(ref.stocks).length, `got ${Object.keys(got.stocks).length} ref ${Object.keys(ref.stocks).length}`);
chk("chain_coverage.total", got.chain_coverage.total === ref.chain_coverage.total);

console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"}  ${pass} 通過 / ${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
