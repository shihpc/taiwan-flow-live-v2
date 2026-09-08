// /live 對外 `ts` ＝指數列時戳（C 案）的離線單元測試（2026-09-08）
// 免 token、免網路。執行：cd worker && node test/livets.mjs
//
// 背景與依據：PROJECT_SUMMARY.md「/live 資料時間改取 max(date)」段。使用者 2026-09-07 裁示
// 採「候選二＝指數列」，規則為：
//   ts ＝ 指數列 `001`（加權指數）的 date；`001` 取不到退 `101`；兩者皆取不到回 `null`；
//   `001` 與 `101` 不一致時**取 `001`**。
// 本檔逐一釘住這四種形狀，並在每一種形狀下同時釘住 **snap_ts 維持原口徑**
// （有分類、非指數個股 max(date)）——`ts` 與 `snap_ts` 語意分家後，只驗其中一個會漏掉
// 「改 ts 時不小心把 snap_ts 一起改掉」這類回歸。
import { aggregate } from "../src/index.js";

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; } else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}

const CL = { 2330: { e: "半導體", c: ["晶圓代工"], t: "twse", sh: 1000 },
             2317: { e: "電子", c: [], t: "twse", sh: 500 } };
const row = (code, date, extra = {}) => ({ stock_id: code, date, close: 100, total_amount: 1e6,
  total_volume: 10, change_rate: 1, change_price: 1, buy_volume: 5, sell_volume: 5, ...extra });
// 個股列固定用這兩筆：max(date) ＝ 2330 的 15:00（模擬盤後零股把個股 max 推離收盤），
// 與任何指數列時戳都不同 → 只要 ts 誤取回 max(date) 就會被抓到。
const STK = [row("2330", "2026-09-04 15:00:00.000000"), row("2317", "2026-09-04 13:12:51.000000")];
const SNAP_MAX = "2026-09-04 15:00:00.000000";
const TS_001 = "2026-09-04 13:33:00.000000";
const TS_101 = "2026-09-04 13:31:00.000000";
const agg = (rows) => aggregate(CL, rows, {}, null);

// ---- 形狀①：正常——001 存在 → 取 001 ----
{
  const a = agg([...STK, row("001", TS_001), row("101", TS_001)]);
  chk("① 001 存在 → ts ＝ 001 的 date", a.ts === TS_001, a.ts);
  chk("① ts 不是個股 max(date)", a.ts !== SNAP_MAX, a.ts);
  chk("① snap_ts 仍是個股 max(date)", a.snap_ts === SNAP_MAX, a.snap_ts);
}

// ---- 形狀②：001 缺、101 在 → 退 101 ----
{
  const a = agg([...STK, row("101", TS_101)]);
  chk("② 001 缺席 → ts 退到 101 的 date", a.ts === TS_101, a.ts);
  chk("② snap_ts 不受影響", a.snap_ts === SNAP_MAX, a.snap_ts);
  // idxOut 對缺席列吐的是「全 null 的殼」而非 null（既有行為，本次不動）；這條只確認
  // ts 的退路沒有連帶改寫 index 欄——001 缺席時 index.tse 仍是空殼、index.otc 仍有值。
  chk("② index.tse 為空殼、index.otc 有值（ts 退路不影響 index 欄）",
    a.index.tse.val === null && a.index.otc.val === 100, JSON.stringify(a.index));
}

// ---- 形狀③：兩者皆缺 → ts === null ----
{
  const a = agg([...STK]);
  chk("③ 001/101 皆缺席 → ts === null（不得退回個股 max(date)）", a.ts === null, String(a.ts));
  chk("③ snap_ts 仍有值（內部線不受 ts 為 null 影響）", a.snap_ts === SNAP_MAX, a.snap_ts);
  chk("③ stocks 照常產出（前端閘門 liveUsable 看的是 stocks 非空，不是 ts）",
    Object.keys(a.stocks).length === 2, JSON.stringify(Object.keys(a.stocks)));
}

// ---- 形狀④：001 ≠ 101 → 取 001（裁示：前端頂列與 /status 的 live 都是加權指數口徑）----
{
  const a = agg([...STK, row("001", TS_001), row("101", TS_101)]);
  chk("④ 001≠101 → 取 001", a.ts === TS_001, a.ts);
  chk("④ 明確不是 101", a.ts !== TS_101, a.ts);
  // 順序顛倒（101 列排在 001 之前）也必須取 001，證明規則不是「取第一列指數」
  const b = agg([...STK, row("101", TS_101), row("001", TS_001)]);
  chk("④ 列順序顛倒仍取 001（規則不是「第一列指數」）", b.ts === TS_001, b.ts);
  // 即使 101 比 001 晚，仍取 001，證明規則不是「取兩者較大者」
  const c = agg([...STK, row("001", TS_101), row("101", TS_001)]);
  chk("④ 101 較晚仍取 001（規則不是「取較大者」）", c.ts === TS_101, c.ts);
}

// ---- 邊界：有列但 date 缺欄／空字串，等同缺席，往下一個候選退 ----
{
  const a = agg([...STK, row("001", ""), row("101", TS_101)]);
  chk("邊界 001 的 date 為空字串 → 退 101", a.ts === TS_101, a.ts);
  const b = agg([...STK, { stock_id: "001", close: 20000, change_price: 1 }, row("101", TS_101)]);
  chk("邊界 001 無 date 欄 → 退 101", b.ts === TS_101, b.ts);
  const c = agg([...STK, row("001", ""), row("101", "")]);
  chk("邊界 兩列 date 皆空 → null", c.ts === null, String(c.ts));
}

// ---- 邊界：完全沒有有分類個股（aggregate 的 stocks:{} 形狀）ts 仍取得到指數列 ----
{
  const a = aggregate(CL, [row("6680", "2026-09-04 14:00:00.000000"), row("001", TS_001)], {}, null);
  chk("邊界 無有分類個股 → ts 仍是 001 的 date", a.ts === TS_001, a.ts);
  chk("邊界 無有分類個股 → snap_ts 為 null（原算法：沒有可取的個股列）",
    a.snap_ts === null, String(a.snap_ts));
}

// ---- 非交易日形狀（樣本 1/2 實測）：個股 max 是盤前殘留 08:30，指數列是正確的前一交易日 ----
{
  const rows = [row("2330", "2026-09-05 08:30:00.000000"),      // ETN/權證脫隊的殘留時戳
    row("2317", "2026-09-04 13:20:00.000000"),
    row("001", "2026-09-04 13:33:00.000000")];
  const a = aggregate(CL, rows, {}, null);
  chk("非交易日 ts 給出正確的前一交易日（不是殘留的 09-05 08:30）",
    a.ts === "2026-09-04 13:33:00.000000", a.ts);
  chk("非交易日 ts 的日期部分＝前一交易日", a.ts.slice(0, 10) === "2026-09-04", a.ts);
  chk("非交易日 snap_ts 仍是被殘留毒化的 max(date)（原算法不變）",
    a.snap_ts === "2026-09-05 08:30:00.000000", a.snap_ts);
}

console.log(`livets: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
