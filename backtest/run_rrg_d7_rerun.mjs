// backtest/run_rrg_d7_rerun.mjs — D7 複跑：位移異常條數／收盤窗／OV_RRG_ODDMAX 的多日檢驗
//
// 報告：docs/rrg-d7-rerun-20260929.md（本腳本的輸出即該報告的數字來源）。
// 用法（repo 根目錄）：node backtest/run_rrg_d7_rerun.mjs [--json out.json] [--days all|YYYY-MM-DD,...] [--until YYYY-MM-DD]
//   不帶 --days：釘死的 9 天（docs/rrg-d7-rerun-20260929.md），輸出與該版逐字相同。
//   --days all：data/intraday/ 下 ≥2026-09-14 且 ≤ --until（預設 2026-10-14）、非週末／非 HOLIDAYS、
//     且帶 cg/cmkt 的全部檔（報告 docs/rrg-d7-rerun-20261015.md）。--days a,b,c：指定日期。
//   帶 --days 時另印「擴充檢查」段（檔案篩選、base 違規與剔除版、離群日檢查）；不帶時一行都不多印。
//   參數錯誤（缺值、非真實日期、只給 --until、列舉含週末／休市日／缺檔、空集合）一律報錯 exit 2，規則見下方「參數驗證」。
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
const HOLIDAYS = ["2026-09-25", "2026-09-28", "2026-10-09", "2026-10-26"];   // 平日休市日（行事曆 data/twse_holidays.json 所列；週末另判）
// 預設重算範圍釘死為這 9 個交易日（不以 glob 取 ≥09-14）：在任何 commit 上重跑輸出皆相同，
// 除非這 9 天的歸檔檔或 index.html 的被抽函式／常數有變。新日子走 --days（2026-10-15 起）。
const DEFAULT_DAYS = ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18",
  "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"];
// 參數驗證（錯誤一律印訊息後 exit 2，不靜默忽略）：
//   * --days／--until 缺值（位於最後或後面緊接另一個 --旗標）→ 錯誤。
//   * 日期須為真實日曆日（2026-02-30、2026-99-99 擋下）。
//   * 只給 --until 不給 --days → 錯誤（--until 只對 --days all 有意義）。
//   * --days 列舉：去重後排序；列到週末或 HOLIDAYS → **錯誤退出**（不剔除，避免誤以為有算到）；
//     檔案不存在 → 錯誤退出。
//   * 篩完為空集合 → 錯誤退出。
const die = msg => { console.error(`錯誤：${msg}`); process.exit(2); };
const argOf = k => {
  const i = process.argv.indexOf(k);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  if (v == null || v.startsWith("--")) die(`${k} 缺值`);
  return v;
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = d => { if (!DATE_RE.test(d)) return false; const t = new Date(d + "T00:00:00Z"); return !isNaN(t) && t.toISOString().slice(0, 10) === d; };
const DAYS_ARG = argOf("--days"), UNTIL_ARG = argOf("--until"), UNTIL = UNTIL_ARG || "2026-10-14";
const EXT = DAYS_ARG != null;          // 擴充模式：才印額外段落、才在 JSON 加新欄位
if (UNTIL_ARG != null && !EXT) die("--until 只能與 --days all 一起用（未給 --days）");
if (UNTIL_ARG != null && DAYS_ARG !== "all") die("--until 只對 --days all 有意義；列舉日期時請勿同時給 --until");
if (!isRealDate(UNTIL)) die(`--until 須為真實日期 YYYY-MM-DD：${UNTIL}`);
const isWeekend = d => { const w = new Date(d + "T00:00:00Z").getUTCDay(); return w === 0 || w === 6; };
const extNotes = [];                   // 擴充模式的檔案篩選紀錄
let days;
if (!EXT) days = DEFAULT_DAYS;
else if (DAYS_ARG === "all") {
  days = [];
  const files = fs.readdirSync(path.join(ROOT, "data/intraday")).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort();
  for (const d of files) {
    if (d < "2026-09-14" || d > UNTIL) continue;
    if (isWeekend(d)) { extNotes.push(`${d}：週末檔，排除`); continue; }
    if (HOLIDAYS.includes(d)) { extNotes.push(`${d}：休市日檔（HOLIDAYS），排除——假歸檔線索`); continue; }
    const a = JSON.parse(fs.readFileSync(path.join(ROOT, `data/intraday/${d}.json`), "utf8"));
    if (!a.cg || !a.cmkt) { extNotes.push(`${d}：無 cg/cmkt，排除`); continue; }
    days.push(d);
  }
  if (!days.length) die(`--days all：2026-09-14～${UNTIL} 之間沒有可用的歸檔檔（篩選紀錄：${extNotes.join("；") || "無"}）`);
} else {
  const list = [...new Set(DAYS_ARG.split(",").map(x => x.trim()).filter(Boolean))].sort();
  if (!list.length) die("--days 為空");
  for (const d of list) {
    if (!isRealDate(d)) die(`--days 日期不是真實日曆日 YYYY-MM-DD：${d}`);
    if (isWeekend(d)) die(`--days 含週末：${d}`);
    if (HOLIDAYS.includes(d)) die(`--days 含休市日（HOLIDAYS）：${d}`);
    if (!fs.existsSync(path.join(ROOT, `data/intraday/${d}.json`))) die(`--days 找不到歸檔檔 data/intraday/${d}.json`);
  }
  days = list;
}

function baseSeen(d) {
  const sha = git("rev-list", "--first-parent", "-1", `--before=${d}T01:00:00Z`, "origin/main").trim();
  return { sha: sha.slice(0, 7), j: JSON.parse(git("show", `${sha}:data/rrg_base.json`)) };
}
// 擴充模式：盤中 base 含休市日或當日時，找當日台北 09:00 之後、14:00 之前 main 上第一版
// days 乾淨的 rrg_base.json（＝當日稍晚載入頁面者看到的版本）當「剔除版」。
function baseClean(d) {
  const shas = git("log", "--first-parent", "--reverse", "--format=%H", `--since=${d}T01:00:00Z`, `--until=${d}T06:00:00Z`, "origin/main", "--", "data/rrg_base.json").trim().split("\n").filter(Boolean);
  for (const s of shas) {
    const j = JSON.parse(git("show", `${s}:data/rrg_base.json`));
    if (!j.days.some(x => HOLIDAYS.includes(x) || x >= d)) return { sha: s.slice(0, 7), j, at: git("show", "-s", "--format=%cI", s).trim() };
  }
  return null;
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
  let { sha, j: base } = baseSeen(d);
  const bad = base.days.filter(x => HOLIDAYS.includes(x) || x >= d);
  const frames = framesFromArchive(a);
  let seen = runDay(d, base, frames);
  let clean = null, polluted = null;
  if (bad.length && !EXT) clean = "（base 含休市日或當日；需另跑剔除版——本批 9 天皆不觸發）";
  if (bad.length && EXT) {
    // 擴充模式：主表改用剔除版，盤中實際看到的（受污染）版本另存 polluted 供對照
    const bc = baseClean(d);
    if (!bc) throw new Error(`${d} base 含 ${bad.join(",")}，且當日找不到乾淨的 base 版本`);
    polluted = { sha, days: base.days, seen };
    clean = { sha: bc.sha, at: bc.at, days: bc.j.days };
    sha = bc.sha; base = bc.j; seen = runDay(d, base, frames);
  }
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
  // 同一算法改用歸檔 total（全市場口徑，元）——供 §7(c)「total 對 13:30 低估」的同日直接比對
  const ti = {}; a.times.forEach((t, i) => { ti[t] = a.total[i]; });
  const incT = hm => ti[hm] - ti[m2hm(hm2m(hm) - 10)];
  const medT = (xs => { const s = [...xs].sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; })(baseHm.map(incT));
  const totMult1330 = incT("13:30") / medT;
  const rec = { d, flat, baseSha: sha, baseDays: base.days, bad, clean, fzDiff, fzBase, seen, cmkt: { medInc: med, mult, firstJump }, total: { medIncYi: medT / 1e8, mult1330: totMult1330 } };
  if (EXT) { rec.polluted = polluted; rec.stale = (a.frames || []).filter(f => f && f.stale).map(f => f.t); }
  res.push(rec);
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
  L.push(`| ${r.d} | ${r.flat ? "否（常數）" : "是"} | \`${r.baseSha}\`${r.polluted ? `（剔除版；09:00 實為 \`${r.polluted.sha}\`）` : ""} | ${r.baseDays[0].slice(5)}~${r.baseDays.at(-1).slice(5)} | ${r.bad.length ? r.bad.join(",") : "無"} | ${r.fzBase == null ? "無定格檔" : r.fzBase ? "是" : "否"} | ${r.fzDiff ? `${r.fzDiff.cells}／${r.fzDiff.maxRel.toExponential(1)}（\`${r.fzDiff.sha}\`）` : "—"} |`);
}
const hms = ANCHORS.map(m2hm);
L.push(`\n## D1 逐日逐時點位移異常條數（oddRaw＝不套收盤窗；收盤窗格括號內為 odd＝套收盤窗後實際採用；非收盤窗 odd＝oddRaw）\n`);
L.push(`z 結構上可算（有 ≥4 筆 30 分位移）的最早錨點：${hms.find((h, i) => ok[0].seen[i].zable)}；更早的錨點條數恆為 0（不是訊號，是視窗不足）。\n`);
L.push(`| 錨點 | ${ok.map(r => r.d.slice(5)).join(" | ")} | 合計 |`);
L.push(`|---|${ok.map(() => "---").join("|")}|---|`);
ANCHORS.forEach((m, i) => {
  const cells = ok.map(r => { const s = r.seen[i]; return s.close ? `**${s.raw}**（${s.odd}）` : `${s.raw}`; });
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
L.push(`\n| 錨點 | oddRaw 條數（${ok.length} 天合計） | 其中落後／轉弱 | 同格全部族群落後／轉弱（基準率） |`);
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

// D4 補：13:30 倍數，真分母 cmkt vs 歸檔 total（同 9 天、同算法：基準＝11:30–13:00 的 10 分增額中位數）
L.push(`\n13:30 增額倍數，同日對照（同算法，只換分母）：`);
L.push(`\n| 日期 | cmkt（mkt.tseYi） | 歸檔 total（全市場） | total／cmkt |`);
L.push(`|---|---|---|---|`);
for (const r of ok) L.push(`| ${r.d} | ${r.cmkt.mult["13:30"].toFixed(2)} | ${r.total.mult1330.toFixed(2)} | ${(r.total.mult1330 / r.cmkt.mult["13:30"]).toFixed(2)} |`);
const mc = P(ok.map(r => r.cmkt.mult["13:30"]), 0.5), mt = P(ok.map(r => r.total.mult1330), 0.5), mr = P(ok.map(r => r.total.mult1330 / r.cmkt.mult["13:30"]), 0.5);
L.push(`| **中位數** | ${mc.toFixed(2)} | ${mt.toFixed(2)} | ${mr.toFixed(2)} |`);
L.push(`\n歸檔 total 的 11:30–13:00 10 分增額中位數（億）：${ok.map(r => r.total.medIncYi.toFixed(1)).join("／")}`);

// ── 4. 擴充模式專屬段落（不帶 --days 時一行都不印，保預設輸出逐字不變） ──────
if (EXT) {
  L.push(`\n## 擴充檢查（--days ${DAYS_ARG}${DAYS_ARG === "all" ? `，--until ${UNTIL}` : ""}）\n`);
  L.push(`納入 ${ok.length} 天：${ok.map(r => r.d.slice(5)).join(", ")}`);
  L.push(`\n檔案篩選紀錄：${extNotes.length ? extNotes.join("；") : "無（範圍內無週末／休市日／缺 cg 檔）"}；HOLIDAYS＝${HOLIDAYS.join(", ")}`);
  const flatDays = ok.filter(r => r.flat).map(r => r.d);
  L.push(`\ntotal 為常數（假歸檔形狀）的日子：${flatDays.length ? flatDays.join(", ") : "無"}`);
  const stl = ok.filter(r => r.stale.length);
  L.push(`\n歸檔 frames 帶 stale:1 的格數／54（Worker storeFrame：FinMind 時戳與牆鐘差 >3 分或日期不同即標 stale）：${ok.map(r => `${r.d.slice(5)} ${r.stale.length}`).join("，")}。`);
  L.push(`  註：09-22 以前幾乎每格都 stale（worker/src/index.js 註解記載「近 8 個交易日 frames[].stale 實測 52–54/54」），該旗標在那段期間沒有鑑別力；09-23 起常態為 0。13:30 那格 stale 的日子：${ok.filter(r => r.stale.includes("13:30") && r.stale.length < 27).map(r => r.d).join(", ") || "無"}（只列 stale 格數 <27 的日子）。`);
  const pol = ok.filter(r => r.polluted);
  L.push(`\n### 盤中 base 違規（含休市日或當日）\n`);
  if (!pol.length) L.push(`無。`);
  else {
    L.push(`| 日期 | 盤中 09:00 版 base | 其 days | 違規項 | 主表改用（剔除版） | 剔除版 days | 剔除版進 main 時刻 |`);
    L.push(`|---|---|---|---|---|---|---|`);
    for (const r of pol) L.push(`| ${r.d} | \`${r.polluted.sha}\` | ${r.polluted.days.map(x => x.slice(5)).join(",")} | ${r.bad.join(",")} | \`${r.clean.sha}\` | ${r.clean.days.map(x => x.slice(5)).join(",")} | ${r.clean.at} |`);
    L.push(`\n受污染版 vs 剔除版的逐錨點 oddRaw（10:40 起；同一份 frame，只換 base）：\n`);
    for (const r of pol) {
      const pick = xs => xs.filter(s => s.m >= 640).map(s => `${s.hm.slice(0, 5)}:${s.raw}`).join(" ");
      L.push(`- ${r.d} 受污染 \`${r.polluted.sha}\`：${pick(r.polluted.seen)}（全日 ${r.polluted.seen.reduce((s, x) => s + x.raw, 0)}）`);
      L.push(`- ${r.d} 剔除版 \`${r.clean.sha}\`：${pick(r.seen)}（全日 ${r.seen.reduce((s, x) => s + x.raw, 0)}）`);
    }
  }
  // 離群日檢查：沿用 09-29 報告點名 09-16／09-18 的兩種形狀，並加穩健 z（中位數／MAD）
  L.push(`\n### 離群日檢查\n`);
  L.push(`形狀 A（09-16 型）：13:00 cmkt 增額倍數 ≥1.5（量能提早集中）。形狀 B（09-18 型）：13:30 cmkt 倍數 ≥ 全樣本中位數 ×2。形狀 C：13:30 oddRaw 落後／轉弱比例 < 50%（09-18 為 6/19）。形狀 D（2026-10-15 新增，資料面）：13:30 cmkt 增額倍數 < 2（收盤集合競價量疑似未進 frame），或 stale 格數 <27 的日子 13:30 那格 stale。另對四個指標試算穩健 z＝(x−中位數)/(1.4826×MAD)，|z|>3.5 標 ★；MAD＝0 的指標 z 算不出、顯示「—」（實際有 z 的指標見表下）。\n`);
  const met = ok.map(r => { const s30 = r.seen.find(s => s.hm === "13:30"); const cs = r.seen.filter(s => s.close);
    return { d: r.d, m1300: r.cmkt.mult["13:00"], m1330: r.cmkt.mult["13:30"], raw1330: s30.raw, dr1330: s30.raw ? s30.rawDown / s30.raw : NaN, s30, closeRaw: cs.reduce((s, x) => s + x.raw, 0), closeDown: cs.reduce((s, x) => s + x.rawDown, 0) }; });
  const rz = k => { const xs = met.map(m => m[k]).filter(x => !isNaN(x)); const md = P(xs, 0.5); const mad = P(xs.map(x => Math.abs(x - md)), 0.5); return m => (isNaN(m[k]) || !mad ? NaN : (m[k] - md) / (1.4826 * mad)); };
  const zf = { m1300: rz("m1300"), m1330: rz("m1330"), raw1330: rz("raw1330"), dr1330: rz("dr1330") };
  const med1330 = P(met.map(m => m.m1330), 0.5);
  const ZLAB = { m1300: "13:00 cmkt 倍數", m1330: "13:30 cmkt 倍數", raw1330: "13:30 oddRaw", dr1330: "13:30 落後／轉弱比例" };
  const zNone = Object.keys(zf).filter(k => met.every(m => isNaN(zf[k](m))));
  L.push(`| 日期 | 13:00 cmkt 倍數（z） | 13:30 cmkt 倍數（z） | 13:30 oddRaw（z） | 13:30 落後／轉弱（比例 z） | 收盤窗三格 oddRaw 落後／轉弱 | 形狀 |`);
  L.push(`|---|---|---|---|---|---|---|`);
  const flagged = [];
  for (const m of met) {
    const f = (k, v, dg) => { const z = zf[k](m); return `${v}（${isNaN(z) ? "—" : z.toFixed(1)}${Math.abs(z) > 3.5 ? " ★" : ""}）`; };
    const sh = []; if (m.m1300 >= 1.5) sh.push("A"); if (m.m1330 >= 2 * med1330) sh.push("B"); if (m.raw1330 && m.dr1330 < 0.5) sh.push("C");
    const rr = ok.find(r => r.d === m.d); if (m.m1330 < 2 || (rr.stale.includes("13:30") && rr.stale.length < 27)) sh.push("D");
    const star = Object.values(zf).some(fn => Math.abs(fn(m)) > 3.5);
    if (sh.length || star) flagged.push(m.d);
    L.push(`| ${m.d} | ${f("m1300", m.m1300.toFixed(2))} | ${f("m1330", m.m1330.toFixed(2))} | ${f("raw1330", m.raw1330)} | ${f("dr1330", `${m.s30.rawDown}/${m.raw1330}`)} | ${m.closeDown}/${m.closeRaw} | ${sh.join("") || "—"}${star ? " ★" : ""} |`);
  }
  L.push(`\n穩健 z 實際算得出的指標：${Object.keys(zf).filter(k => !zNone.includes(k)).map(k => ZLAB[k]).join("、")}（${Object.keys(zf).length - zNone.length} 個）；MAD＝0 算不出：${zNone.map(k => ZLAB[k]).join("、") || "無"}。`);
  L.push(`\n13:30 cmkt 倍數全樣本中位數 ${med1330.toFixed(2)}；被標出（任一形狀或 ★）的日子：${flagged.join(", ") || "無"}`);
  const newFlag = flagged.filter(d => !SPECIAL.includes(d));
  L.push(`\n### 敏感度（擴充）\n`);
  for (const [lab, ex] of [[`剔除 ${SPECIAL.join("、")}`, SPECIAL], [`剔除全部被標出日（${flagged.join("、") || "無"}）`, flagged], [`只看 ${DEFAULT_DAYS.length} 天以外的新日子`, DEFAULT_DAYS]]) {
    const sb = ok.filter(r => !ex.includes(r.d));
    if (!sb.length) continue;
    const part = ["13:10", "13:20", "13:30"].map(h => { const cs = sb.map(r => r.seen.find(s => s.hm === h)); const r0 = cs.reduce((s, x) => s + x.raw, 0), d0 = cs.reduce((s, x) => s + x.rawDown, 0), a0 = cs.reduce((s, x) => s + x.nrows, 0), ad = cs.reduce((s, x) => s + x.allDown, 0);
      return `${h} oddRaw 平均 ${(r0 / sb.length).toFixed(2)}、落後／轉弱 ${d0}/${r0}（${r0 ? (100 * d0 / r0).toFixed(0) : "—"}%；基準率 ${(100 * ad / a0).toFixed(0)}%）`; });
    const nz = sb.flatMap(r => r.seen.filter(s => !s.close && s.zable));
    const mid0 = sb.flatMap(r => r.seen.filter(mid).map(s => s.raw));
    const jmp = {}; for (const r of sb) { const mx = Math.max(...r.seen.filter(mid).map(s => s.raw)); const g = h => r.seen.find(s => s.hm === h).raw; const j = ["13:10", "13:20", "13:30"].find(h => g(h) > mx) || "無"; jmp[j] = (jmp[j] || 0) + 1; }
    L.push(`- ${lab}（${sb.length} 天）：11:00–13:00 每格平均 ${mean(mid0).toFixed(2)}；${part.join("；")}；條數跳升點 ${Object.entries(jmp).map(([k, v]) => `${k}:${v}天`).join("，")}；非收盤窗 z 可算 extraRaw >${C.ODDMAX} 的格數 ${nz.filter(s => s.extraRaw > C.ODDMAX).length}/${nz.length}`);
  }
  L.push(`\n新被標出的日子（不在 ${SPECIAL.join("、")}）：${newFlag.join(", ") || "無"}`);
  // 收盤窗 790 vs 810 的直接後果：13:10／13:20 若不停用，會多出多少條標示（odd 名額內／extraRaw）
  const c1020 = ok.flatMap(r => r.seen.filter(s => s.hm === "13:10" || s.hm === "13:20"));
  L.push(`\n### 790 vs 810 的直接後果（13:10／13:20 兩格）\n`);
  L.push(`- 790（現行）：兩格 odd 一律 0；被停止標示的 oddRaw 合計 ${c1020.reduce((s, x) => s + x.raw, 0)} 條（${ok.length} 天，平均每天 ${(c1020.reduce((s, x) => s + x.raw, 0) / ok.length).toFixed(1)} 條），其中扣錨點／改善後真正會額外上畫布者 ${c1020.reduce((s, x) => s + Math.min(x.extraRaw, C.ODDMAX), 0)} 條；收盤窗標示每天出現於 13:10、13:20、13:30 三個錨點。`);
  L.push(`- 810：上述 oddRaw 恢復標示；收盤窗標示只剩 13:30 一個錨點。兩格中 extraRaw >${C.ODDMAX}（會被上限擠掉）的格數 ${c1020.filter(s => s.extraRaw > C.ODDMAX).length}/${c1020.length}。`);
}

const txt = L.join("\n");
console.log(txt);
const ji = process.argv.indexOf("--json");
if (ji > 0) fs.writeFileSync(process.argv[ji + 1], JSON.stringify(res, null, 1));
