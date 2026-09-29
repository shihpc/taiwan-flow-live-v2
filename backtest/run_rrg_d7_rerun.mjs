// backtest/run_rrg_d7_rerun.mjs — D7 複跑：位移異常條數／收盤窗／OV_RRG_ODDMAX 的多日檢驗
//
// 報告：docs/rrg-d7-rerun-20260929.md（本腳本的輸出即該報告的數字來源）。
// 用法（repo 根目錄）：node backtest/run_rrg_d7_rerun.mjs [--json out.json]
//   需要完整 git 歷史（shallow clone 先 `git fetch --unshallow origin`），免 token、免網路。
//
// 口徑原則（不得違反）：
//   * 座標、z、象限、oddRaw／closeWin 一律用 **index.html 真正的** ovRrgCompute／ovRrgTimes／
//     ovRrgZ／ovRrgMed／ovRrgQuad／ovRrgBaseAt 與 OV_RRG_* 常數——以大括號配對從 index.html
//     抽出丟進 vm 執行，本檔**不重寫任何口徑**。
//   * 每格 frame 的鏈層 share＝cg[鏈][i]／cmkt[i]、amtYi＝cg[鏈][i]（src/archive_intraday.py 的
//     cmeta.share 定義；該欄位由 build_rrg_frozen.agg_frame() 產，已與前端 ovRrgAggFrame 逐位 parity）。
//     frame 物件形狀同 ovRrgAggFrame 的回傳 {t,mktYi,shares,amtYi}。
//   * base＝「該日盤中使用者實際看到的那版」：main 在台北當日 09:00（UTC 01:00）時的
//     data/rrg_base.json（git rev-list --first-parent -1 --before）。另檢查其 days 是否含
//     休市日（2026-09-25／09-28）與當日本身。
//   * 時點集合＝前端 ovRrgTimes(anchor).all；錨點＝ovRrgAnchorMin 會產生的 10 分格
//     （13:30 往回每 10 分，09:10…13:30）。歸檔 54 格（09:05–13:30 每 5 分）只當 frame 來源。
//   * 唯一在本檔「照抄」的前端邏輯是 ovRrgHtml 內決定畫布強制標示的三行（impSet／oddAll），
//     那是顯示層、不是座標口徑；照抄處有註明。
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });

// ── 1. 從 index.html 抽真正的函式與常數 ──────────────────────────────────────
function pickFunc(name) {
  const start = HTML.indexOf(`function ${name}(`);
  if (start < 0 || HTML.indexOf(`function ${name}(`, start + 1) >= 0) throw new Error(`function ${name} 須唯一命中`);
  const open = HTML.indexOf("{", start);
  let depth = 0, inStr = null;
  for (let i = open; i < HTML.length; i++) {
    const c = HTML[i];
    if (inStr) { if (c === "\\") { i++; continue; } if (c === inStr) inStr = null; }
    else if (c === '"' || c === "'" || c === "`") inStr = c;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return HTML.slice(start, i + 1); }
  }
  throw new Error(`function ${name} 大括號未配對`);
}
function pickLine(re) {
  const m = HTML.match(re);
  if (!m) throw new Error(`index.html 找不到 ${re}`);
  return m[0];
}
const constLines = HTML.split("\n").filter(l => /^const OV_RRG_[A-Z_]+=/.test(l)).map(l => l.replace(/\/\/.*$/, ""));
const code = [
  ...constLines,
  pickLine(/^const ovMin2Hm=.*$/m),
  pickLine(/^const ovRrgMed=.*$/m),
  pickLine(/^const ovRrgQuad=.*$/m),
  "var OV_RRG_BASE=null, OV_RRG_BASE_IDX=null, OV_RRG=null;",
  ...["ovRrgTimes", "ovRrgZ", "ovRrgBaseAt", "ovRrgCompute"].map(pickFunc),
  "globalThis.__api={ovRrgTimes,ovRrgCompute,C:{CLOSE:OV_RRG_CLOSE,ODDMAX:OV_RRG_ODDMAX,IMPMAX:OV_RRG_IMPMAX,TOPN:OV_RRG_TOPN,Z:OV_RRG_Z,DPP:OV_RRG_DPP,TMIN:OV_RRG_TMIN,TMAX:OV_RRG_TMAX,STEP:OV_RRG_STEP},",
  " set(b,idx,fr){OV_RRG_BASE=b;OV_RRG_BASE_IDX=idx;OV_RRG={frames:fr};}};",
].join("\n");
const ctx = { Math, Set, Object, Array, String, Number, isNaN };
vm.createContext(ctx);
new vm.Script(code).runInContext(ctx);
const API = ctx.__api, C = API.C;
const hm2m = hm => +hm.slice(0, 2) * 60 + +hm.slice(3, 5);
const m2hm = m => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");

// ── 2. 資料：歸檔檔、當日 base、當日定格檔（交叉驗證用） ────────────────────
const HOLIDAYS = ["2026-09-25", "2026-09-28"];
const days = fs.readdirSync(path.join(ROOT, "data/intraday"))
  .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort()
  .filter(d => d >= "2026-09-14");

function baseSeen(d) {
  const sha = git("rev-list", "--first-parent", "-1", `--before=${d}T01:00:00Z`, "origin/main").trim();
  return { sha: sha.slice(0, 7), j: JSON.parse(git("show", `${sha}:data/rrg_base.json`)) };
}
let frozenIdx = null;   // date → 第一個寫出該日定格檔的 commit
function frozenOf(d) {
  if (!frozenIdx) {
    frozenIdx = {};
    const shas = git("log", "--first-parent", "--reverse", "--format=%H", "--since=2026-09-13", "origin/main", "--", "data/rrg_frozen.json").trim().split("\n");
    for (const s of shas) {
      try { const j = JSON.parse(git("show", `${s}:data/rrg_frozen.json`)); if (!frozenIdx[j.date]) frozenIdx[j.date] = { sha: s.slice(0, 7), j }; } catch {}
    }
  }
  return frozenIdx[d] || null;
}
function framesFromArchive(a) {
  const fr = {};
  a.times.forEach((t, i) => {
    const mk = a.cmkt[i];
    if (!(mk > 0)) { fr[t] = false; return; }
    const shares = {}, amtYi = {};
    for (const n in a.cg) { const v = a.cg[n][i]; if (v == null) continue; amtYi[n] = v; shares[n] = v / mk; }
    fr[t] = { t, mktYi: mk, shares, amtYi };
  });
  return fr;
}
const ANCHORS = []; for (let m = C.TMAX; m >= C.TMIN; m -= C.STEP) ANCHORS.unshift(m);   // 09:10…13:30

function runDay(d, base, frames) {
  const idx = {}; base.times.forEach((t, i) => { idx[t] = i; });
  API.set(base, idx, frames);
  const out = [];
  for (const a of ANCHORS) {
    const T = API.ovRrgTimes(a);
    const { rows } = API.ovRrgCompute(T);
    const zable = rows.some(r => r.ndisp >= 4);      // 結構上 z 算得出來（≥MIN_WIN 筆位移）
    const raw = rows.filter(r => r.oddRaw);
    // ↓ 照抄 index.html ovRrgHtml 的畫布強制標示判定（顯示層三行，非座標口徑）
    const impAll = rows.filter(r => r.quad === "改善").sort((x, y) => y.move30 - x.move30);
    const impSet = new Set(impAll.slice(0, C.IMPMAX).map(r => r.name));
    const extraRaw = raw.filter(r => r.rank > C.TOPN && !impSet.has(r.name));   // 以 oddRaw 計（不套收盤窗時的名額需求）
    out.push({
      hm: m2hm(a), m: a, close: a >= C.CLOSE, zable, nrows: rows.length,
      raw: raw.length, odd: rows.filter(r => r.odd).length, extraRaw: extraRaw.length,
      rawDown: raw.filter(r => r.quad === "落後" || r.quad === "轉弱").length,
      allDown: rows.filter(r => r.quad === "落後" || r.quad === "轉弱").length,
      rawQ: raw.map(r => r.quad), rawList: raw.map(r => ({ n: r.name, q: r.quad, z: +r.z.toFixed(2), rank: r.rank, dpp: +r.dpp.toFixed(3) })),
    });
  }
  return out;
}

const res = [];
for (const d of days) {
  const a = JSON.parse(fs.readFileSync(path.join(ROOT, `data/intraday/${d}.json`), "utf8"));
  if (!a.cg || !a.cmkt) { res.push({ d, skip: "無 cg/cmkt" }); continue; }
  const flat = a.total.every(v => v === a.total[0]);
  const { sha, j: base } = baseSeen(d);
  const bad = base.days.filter(x => HOLIDAYS.includes(x) || x >= d);
  const frames = framesFromArchive(a);
  const seen = runDay(d, base, frames);
  let clean = null;
  if (bad.length) clean = "（base 含休市日或當日；需另跑剔除版——本批 9 天皆不觸發）";
  // 交叉驗證：定格檔（盤中 /replay 實抓）12 時點 share vs 歸檔 cg/cmkt 還原的 share
  const fz = frozenOf(d);
  let fzDiff = null, fzBase = null;
  if (fz) {
    let mx = 0, n = 0;
    for (const hm of fz.j.times) {
      const f = fz.j.frames[hm], g = frames[hm]; if (!f || !g) continue;
      for (const k in f) { mx = Math.max(mx, Math.abs(f[k] - (g.shares[k] || 0)) / Math.max(f[k], 1e-12)); n++; }
    }
    fzDiff = { sha: fz.sha, cells: n, maxRel: mx };
    fzBase = (fz.j.base_days || []).join(",") === base.days.join(",");
  }
  // 真分母 cmkt 的 10 分增額倍數（基準＝11:30–13:00 的 10 分增額中位數；同 2026-09-13 的做法）
  const ci = {}; a.times.forEach((t, i) => { ci[t] = a.cmkt[i]; });
  const inc = hm => ci[hm] - ci[m2hm(hm2m(hm) - 10)];
  const baseHm = []; for (let m = 690; m <= 780; m += 10) baseHm.push(m2hm(m));
  const med = (xs => { const s = [...xs].sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; })(baseHm.map(inc));
  const mult = { "13:00": inc("13:00") / med, "13:10": inc("13:10") / med, "13:20": inc("13:20") / med, "13:30": inc("13:30") / med };
  const firstJump = ["13:10", "13:20", "13:30"].find(h => mult[h] >= 1.3) || null;
  res.push({ d, flat, baseSha: sha, baseDays: base.days, bad, clean, fzDiff, fzBase, seen, cmkt: { medInc: med, mult, firstJump } });
}

// ── 3. 彙整與輸出（Markdown 片段，直接貼進報告） ─────────────────────────────
const P = (xs, p) => { const s = [...xs].sort((x, y) => x - y); if (!s.length) return NaN; const r = (s.length - 1) * p, lo = Math.floor(r), hi = Math.ceil(r); return s[lo] + (s[hi] - s[lo]) * (r - lo); };
const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
const ok = res.filter(r => !r.skip);
const L = [];
L.push(`## 資料與 base 版本\n`);
L.push(`| 日期 | total 非常數 | 盤中 base（main@台北 09:00） | base.days | 含休市日／當日 | 定格檔 base_days 一致 | 定格檔 share 對照（格數／最大相對差） |`);
L.push(`|---|---|---|---|---|---|---|`);
for (const r of res) {
  if (r.skip) { L.push(`| ${r.d} | — | — | — | — | — | ${r.skip} |`); continue; }
  L.push(`| ${r.d} | ${r.flat ? "否（常數）" : "是"} | \`${r.baseSha}\` | ${r.baseDays[0].slice(5)}~${r.baseDays.at(-1).slice(5)} | ${r.bad.length ? r.bad.join(",") : "無"} | ${r.fzBase == null ? "無定格檔" : r.fzBase ? "是" : "否"} | ${r.fzDiff ? `${r.fzDiff.cells}／${r.fzDiff.maxRel.toExponential(1)}（\`${r.fzDiff.sha}\`）` : "—"} |`);
}
const hms = ANCHORS.map(m2hm);
L.push(`\n## D1 逐日逐時點位移異常條數（oddRaw＝不套收盤窗；收盤窗格括號內為 odd＝套收盤窗後實際採用；非收盤窗 odd＝oddRaw）\n`);
L.push(`z 結構上可算（有 ≥4 筆 30 分位移）的最早錨點：${hms.find((h, i) => ok[0].seen[i].zable)}；更早的錨點條數恆為 0（不是訊號，是視窗不足）。\n`);
L.push(`| 錨點 | ${ok.map(r => r.d.slice(5)).join(" | ")} | 合計 |`);
L.push(`|---|${ok.map(() => "---").join("|")}|---|`);
ANCHORS.forEach((m, i) => {
  const cells = ok.map(r => { const s = r.seen[i]; return s.close ? `**${s.raw}**（0）` : `${s.raw}`; });
  const tot = ok.reduce((s, r) => s + r.seen[i].raw, 0);
  L.push(`| ${m2hm(m)}${m >= C.CLOSE ? " ⛔" : ""} | ${cells.join(" | ")} | ${tot} |`);
});
L.push(`| 全日 oddRaw | ${ok.map(r => r.seen.reduce((s, x) => s + x.raw, 0)).join(" | ")} | ${ok.reduce((s, r) => s + r.seen.reduce((t, x) => t + x.raw, 0), 0)} |`);
L.push(`| 全日 odd（套窗） | ${ok.map(r => r.seen.reduce((s, x) => s + x.odd, 0)).join(" | ")} | ${ok.reduce((s, r) => s + r.seen.reduce((t, x) => t + x.odd, 0), 0)} |`);

const nonClose = ok.flatMap(r => r.seen.filter(s => !s.close));
const nonCloseZ = nonClose.filter(s => s.zable);
const closeCells = ok.flatMap(r => r.seen.filter(s => s.close));
const stat = xs => `最大 ${Math.max(...xs)}／p95 ${P(xs, 0.95).toFixed(2)}／平均 ${mean(xs).toFixed(2)}／中位數 ${P(xs, 0.5)}（n=${xs.length}）`;
L.push(`\n### 跨日分布\n`);
L.push(`| 範圍 | 統計 |`);
L.push(`|---|---|`);
L.push(`| 非收盤窗、全部錨點 09:10–13:00（含 z 不可算的早盤，${nonClose.length / ok.length} 格/日） | ${stat(nonClose.map(s => s.raw))} |`);
L.push(`| 非收盤窗、z 可算錨點（${nonCloseZ.length / ok.length} 格/日） | ${stat(nonCloseZ.map(s => s.raw))} |`);
L.push(`| 收盤窗 13:10／13:20／13:30（oddRaw） | ${["13:10", "13:20", "13:30"].map(h => { const xs = ok.map(r => r.seen.find(s => s.hm === h).raw); return `${h}: ${xs.join("/")}（平均 ${mean(xs).toFixed(1)}）`; }).join("；")} |`);
L.push(`| 收盤窗三格合計 | ${stat(closeCells.map(s => s.raw))} |`);

// D2
L.push(`\n## D2 依據②③：收盤窗是否仍是跳升處、落後／轉弱比例\n`);
L.push(`| 日期 | 11:00–13:00 每格平均 | 11:00–13:00 最大 | 13:10 | 13:20 | 13:30 | 收盤窗佔全日 oddRaw | 收盤窗 oddRaw 落後／轉弱 | 同窗全部族群落後／轉弱比例（對照） | 非收盤窗 oddRaw 落後／轉弱 |`);
L.push(`|---|---|---|---|---|---|---|---|---|---|`);
const mid = s => s.m >= 660 && s.m <= 780;
let A = { mid: [], c: 0, all: 0, cd: 0, rows: 0, rowsDown: 0, nc: 0, ncd: 0 };
for (const r of ok) {
  const m = r.seen.filter(mid).map(s => s.raw);
  const cs = r.seen.filter(s => s.close);
  const c = cs.reduce((s, x) => s + x.raw, 0), cd = cs.reduce((s, x) => s + x.rawDown, 0);
  const all = r.seen.reduce((s, x) => s + x.raw, 0);
  const rows = cs.reduce((s, x) => s + x.nrows, 0), rowsDown = cs.reduce((s, x) => s + x.allDown, 0);
  const nc = r.seen.filter(s => !s.close).reduce((s, x) => s + x.raw, 0), ncd = r.seen.filter(s => !s.close).reduce((s, x) => s + x.rawDown, 0);
  A.mid.push(...m); A.c += c; A.all += all; A.cd += cd; A.rows += rows; A.rowsDown += rowsDown; A.nc += nc; A.ncd += ncd;
  const g = h => r.seen.find(s => s.hm === h).raw;
  L.push(`| ${r.d} | ${mean(m).toFixed(2)} | ${Math.max(...m)} | ${g("13:10")} | ${g("13:20")} | ${g("13:30")} | ${c}/${all} | ${cd}/${c} | ${rowsDown}/${rows} | ${ncd}/${nc} |`);
}
L.push(`| **合計** | ${mean(A.mid).toFixed(2)} | ${Math.max(...A.mid)} | ${ok.reduce((s, r) => s + r.seen.find(x => x.hm === "13:10").raw, 0)} | ${ok.reduce((s, r) => s + r.seen.find(x => x.hm === "13:20").raw, 0)} | ${ok.reduce((s, r) => s + r.seen.find(x => x.hm === "13:30").raw, 0)} | ${A.c}/${A.all}（${(100 * A.c / A.all).toFixed(0)}%） | ${A.cd}/${A.c}（${(100 * A.cd / A.c).toFixed(0)}%） | ${A.rowsDown}/${A.rows}（${(100 * A.rowsDown / A.rows).toFixed(0)}%） | ${A.ncd}/${A.nc}（${A.nc ? (100 * A.ncd / A.nc).toFixed(0) : "—"}%） |`);
// 收盤窗內非落後／轉弱的例外列出
const exc = ok.flatMap(r => r.seen.filter(s => s.close).flatMap(s => s.rawList.filter(x => x.q !== "落後" && x.q !== "轉弱").map(x => `${r.d.slice(5)} ${s.hm} ${x.n}（${x.q}，z=${x.z}，rank ${x.rank}）`)));
L.push(`\n收盤窗內**不在**落後／轉弱象限的 oddRaw（${exc.length} 條）：${exc.join("；") || "無"}`);

// D2 補：逐格象限比例（與「同格全部族群」的基準率對照）與特殊日敏感度
L.push(`\n| 錨點 | oddRaw 條數（9 天合計） | 其中落後／轉弱 | 同格全部族群落後／轉弱（基準率） |`);
L.push(`|---|---|---|---|`);
const qrow = (lab, cells) => { const r = cells.reduce((s, x) => s + x.raw, 0), d = cells.reduce((s, x) => s + x.rawDown, 0), a = cells.reduce((s, x) => s + x.nrows, 0), ad = cells.reduce((s, x) => s + x.allDown, 0);
  L.push(`| ${lab} | ${r} | ${d}（${r ? (100 * d / r).toFixed(0) : "—"}%） | ${ad}/${a}（${(100 * ad / a).toFixed(0)}%） |`); };
qrow("10:40–13:00（z 可算的非收盤窗）", ok.flatMap(r => r.seen.filter(s => !s.close && s.zable)));
for (const h of ["13:00", "13:10", "13:20", "13:30"]) qrow(h, ok.map(r => r.seen.find(s => s.hm === h)));
const SPECIAL = ["2026-09-16", "2026-09-18"];
const sub = ok.filter(r => !SPECIAL.includes(r.d));
L.push(`\n敏感度（剔除疑似特殊日 ${SPECIAL.join("、")}，剩 ${sub.length} 天）：`);
for (const h of ["13:10", "13:20", "13:30"]) { const cs = sub.map(r => r.seen.find(s => s.hm === h)); const r = cs.reduce((s, x) => s + x.raw, 0), d = cs.reduce((s, x) => s + x.rawDown, 0); L.push(`- ${h}：oddRaw ${cs.map(x => x.raw).join("/")}，落後／轉弱 ${d}/${r}`); }

// D3
L.push(`\n## D3 OV_RRG_ODDMAX=${C.ODDMAX}\n`);
const over = (xs, k) => xs.filter(s => s.raw > k);
L.push(`| 口徑 | >${C.ODDMAX} 的時點數 | 被上限擠掉的條數 | 最大條數 |`);
L.push(`|---|---|---|---|`);
L.push(`| 非收盤窗、全部 oddRaw（含錨點／改善象限） | ${over(nonClose, C.ODDMAX).length} | ${over(nonClose, C.ODDMAX).reduce((s, x) => s + x.raw - C.ODDMAX, 0)} | ${Math.max(...nonClose.map(s => s.raw))} |`);
L.push(`| 非收盤窗、扣掉錨點 Top${C.TOPN}／改善象限（真正吃 ODDMAX 名額者） | ${nonClose.filter(s => s.extraRaw > C.ODDMAX).length} | ${nonClose.reduce((s, x) => s + Math.max(0, x.extraRaw - C.ODDMAX), 0)} | ${Math.max(...nonClose.map(s => s.extraRaw))} |`);
L.push(`| （對照）收盤窗若不停用、扣錨點／改善 | ${closeCells.filter(s => s.extraRaw > C.ODDMAX).length} | ${closeCells.reduce((s, x) => s + Math.max(0, x.extraRaw - C.ODDMAX), 0)} | ${Math.max(...closeCells.map(s => s.extraRaw))} |`);
const hist = {}; for (const s of nonCloseZ) hist[s.raw] = (hist[s.raw] || 0) + 1;
L.push(`\n非收盤窗、z 可算錨點的條數直方圖（條數:格數）：${Object.entries(hist).map(([k, v]) => `${k}:${v}`).join("，")}`);

// D4
L.push(`\n## D4 OV_RRG_CLOSE=${C.CLOSE}（${m2hm(C.CLOSE)}）交叉檢查\n`);
L.push(`判準一（位移異常條數）：13:00 之後首個「oddRaw > 當日 11:00–13:00 最大值」的錨點。判準二（真分母 cmkt）：以 11:30–13:00 的 10 分增額中位數為基準，13:00 之後首個 ≥1.3× 的時點（同 2026-09-13 的 38 天做法，但分母換成真口徑 mkt.tseYi）。\n`);
L.push(`| 日期 | 11:00–13:00 最大 | 13:00 | 13:10 | 13:20 | 13:30 | 條數跳升點 | cmkt 增額倍數 13:00／13:10／13:20／13:30 | cmkt 跳升點 |`);
L.push(`|---|---|---|---|---|---|---|---|---|`);
const jumpCnt = {}, cjCnt = {};
for (const r of ok) {
  const mx = Math.max(...r.seen.filter(mid).map(s => s.raw));
  const g = h => r.seen.find(s => s.hm === h).raw;
  const j = ["13:10", "13:20", "13:30"].find(h => g(h) > mx) || "無";
  jumpCnt[j] = (jumpCnt[j] || 0) + 1; cjCnt[r.cmkt.firstJump || "無"] = (cjCnt[r.cmkt.firstJump || "無"] || 0) + 1;
  const mu = r.cmkt.mult;
  L.push(`| ${r.d} | ${mx} | ${g("13:00")} | ${g("13:10")} | ${g("13:20")} | ${g("13:30")} | ${j} | ${["13:00", "13:10", "13:20", "13:30"].map(h => mu[h].toFixed(2)).join("／")} | ${r.cmkt.firstJump || "無"} |`);
}
const mm = h => P(ok.map(r => r.cmkt.mult[h]), 0.5).toFixed(2);
L.push(`| **彙總** | | | | | | ${Object.entries(jumpCnt).map(([k, v]) => `${k}:${v}天`).join("，")} | 中位數 ${["13:00", "13:10", "13:20", "13:30"].map(mm).join("／")} | ${Object.entries(cjCnt).map(([k, v]) => `${k}:${v}天`).join("，")} |`);

// D3 補：真正吃名額的 extraRaw 分布
const ex = nonCloseZ.map(s => s.extraRaw);
const eh = {}; for (const v of ex) eh[v] = (eh[v] || 0) + 1;
L.push(`\n非收盤窗、z 可算錨點的 extraRaw（扣錨點／改善後）直方圖：${Object.entries(eh).map(([k, v]) => `${k}:${v}`).join("，")}；${stat(ex)}`);
for (const r of ok) for (const s of r.seen) if (!s.close && s.extraRaw > C.ODDMAX) L.push(`- 超出上限的時點：${r.d} ${s.hm}（oddRaw ${s.raw}、extraRaw ${s.extraRaw}、落後／轉弱 ${s.rawDown}）`);
// D4 補：若把 13:00 本身也算進搜尋範圍
const inc13 = {}; for (const r of ok) { const k = ["13:00", "13:10", "13:20", "13:30"].find(h => r.cmkt.mult[h] >= 1.3) || "無"; inc13[k] = (inc13[k] || 0) + 1; }
L.push(`\ncmkt 跳升點若把 13:00 也納入搜尋：${Object.entries(inc13).map(([k, v]) => `${k}:${v}天`).join("，")}；11:30–13:00 的 10 分增額中位數（億）：${ok.map(r => r.cmkt.medInc.toFixed(1)).join("／")}`);

const txt = L.join("\n");
console.log(txt);
const ji = process.argv.indexOf("--json");
if (ji > 0) fs.writeFileSync(process.argv[ji + 1], JSON.stringify(res, null, 1));
