// ts / snap_ts 拆分的「隔離證明」離線單元測試（2026-09-07）
// 免 token、免網路。執行：cd worker && node test/snapts.mjs
//
// 背景：對外 `ts` 的語意即將改變（C 案，見 PROJECT_SUMMARY.md「/live 資料時間改取 max(date)」段）。
// 內部窗計算／KV frame 定位／收盤殘影判定要的是「這份快照本身的時戳」，已拆成 `snap_ts`。
// 本檔要證明的是**隔離真的做到了**，兩個方向都要驗，缺一就可能是「兩個都沒讀到」的假綠：
//   正向：把 live.ts 設成明顯錯值（1999-01-01）→ 這些消費者的產出必須**逐字不動**；
//   反向：把 live.snap_ts 設錯 → 產出必須**改變**（證明它們確實在讀 snap_ts）。
import { computeLiveFlow, snapTs, flowLastPayload, framesDegenerate, CLOSE_MIN } from "../src/index.js";

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; } else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const BAD = "1999-01-01 00:00:00.000000";      // 明顯錯誤的時戳（突變注入值）

// ---- 素材 ----
const CL = { 2330: { e: "半導體", c: ["晶圓代工"], p: [["半導體", "晶圓代工"]], t: "twse", sh: 1000 },
             2317: { e: "電子", c: ["電子零組件"], p: [["電子", "組裝"]], t: "twse", sh: 500 } };
const BASELINE = { date: "2026-09-03", tot5: 1e11, subs_y: {},
  stocks: { 2330: [5e10, 1, 2, 3, 4, 5, 6], 2317: [1e10, 1, 2, 3, 4, 5, 6] } };
// live 的 stocks 欄序＝aggregate 的 stock_cols 前三欄 [chg, amt, close]（computeLiveFlow 只取 amt/close）
const mkLive = (over) => ({ ts: "2026-09-04 14:40:06.000000", snap_ts: "2026-09-04 14:40:06.000000",
  stocks: { 2330: [1.2, 9e9, 1150], 2317: [-0.5, 2e9, 210] }, ...over });
const frame = (a1, a2, ts) => JSON.stringify({ 2330: [a1, 1140], 2317: [a2, 208], _ts: ts });
// 收盤後的真實形狀：13:35 是當日最後一格（storeFrame >13:35 不落格）
const KV_MAIN = {
  "fi:2026-09-04": JSON.stringify(["09:05", "13:00", "13:20", "13:35"]),
  "f:2026-09-04:09:05": frame(1e9, 2e8, "2026-09-04 09:05:01.000000"),
  "f:2026-09-04:13:00": frame(6e9, 1.2e9, "2026-09-04 13:00:03.000000"),
  "f:2026-09-04:13:20": frame(7e9, 1.5e9, "2026-09-04 13:20:04.000000"),
  "f:2026-09-04:13:35": frame(8e9, 1.8e9, "2026-09-04 13:35:02.000000"),
};
const mkEnv = (init) => ({ FLOW_KV: {
  async get(key, type) {
    const v = init[key];
    if (v === undefined) return null;
    return type === "json" ? JSON.parse(v) : v;
  },
} });
// 比對用：flow 的全部欄位（frames／degenerate／mkt／subs／wins／baseline_date）＋逐股輸出
const shot = (r) => JSON.stringify({ flow: r.flow, per: r.per });

// ---- 0. 前置：控制組本身必須是「有內容」的收盤殘影，否則下面的比對全是空對空 ----
const CTRL = await computeLiveFlow(mkEnv(KV_MAIN), mkLive(), CL, BASELINE);
{
  chk("前置 控制組 flow 非 null", CTRL.flow !== null && !!CTRL.flow.mkt, JSON.stringify(CTRL.flow));
  chk("前置 控制組兩窗都挑到 13:35（收盤後現行形狀）",
    eq(CTRL.flow.frames, { 10: "13:35", 30: "13:35" }), JSON.stringify(CTRL.flow.frames));
  chk("前置 控制組 degenerate=true（13:35 ≥ CLOSE_MIN 13:30）",
    CTRL.flow.degenerate === true && CLOSE_MIN === 810);
  chk("前置 控制組逐股有值", CTRL.per["2330"] && CTRL.per["2330"][0] === 1e9, JSON.stringify(CTRL.per));
}

// ---- 1. 正向突變：ts 設成 1999 錯值 → pickFrames/computeFlow/framesDegenerate 逐字不動 ----
{
  const mut = await computeLiveFlow(mkEnv(KV_MAIN), mkLive({ ts: BAD }), CL, BASELINE);
  chk("正向 ts=1999 → flow 與 per 逐字相同", shot(mut) === shot(CTRL),
    `${JSON.stringify(mut.flow && mut.flow.frames)} vs ${JSON.stringify(CTRL.flow.frames)}`);
  chk("正向 ts=1999 → degenerate 仍為 true（收盤殘影標記不失效）",
    !!mut.flow && mut.flow.degenerate === true, JSON.stringify(mut.flow && mut.flow.degenerate));
  // ts 缺席（C 案「ts 可能回 null」的形狀）同樣不得影響內部線
  const nul = await computeLiveFlow(mkEnv(KV_MAIN), mkLive({ ts: null }), CL, BASELINE);
  chk("正向 ts=null → flow 與 per 逐字相同", shot(nul) === shot(CTRL));
  chk("正向 series 取日期不受 ts 影響",
    snapTs(mkLive({ ts: BAD })).slice(0, 10) === "2026-09-04", snapTs(mkLive({ ts: BAD })));
}

// ---- 2. 反向突變：snap_ts 設錯 → 上述消費者必須受影響（否則是「兩個都沒讀到」的假綠）----
{
  // 2a 退回 13:25：窗目標退到 13:1x/12:5x → 挑到 13:00/09:05 → degenerate 由 true 翻 false
  //    （這正是 C 案若不拆 snap_ts 會踩到的事故形狀）
  const back = await computeLiveFlow(mkEnv(KV_MAIN), mkLive({ snap_ts: "2026-09-04 13:25:00.000000" }), CL, BASELINE);
  chk("反向 snap_ts=13:25 → 挑到不同 frame", !!back.flow && !eq(back.flow.frames, CTRL.flow.frames),
    JSON.stringify(back.flow && back.flow.frames));
  chk("反向 snap_ts=13:25 → degenerate 由 true 變 false（證明殘影判定吃 snap_ts）",
    !!back.flow && back.flow.degenerate === false, JSON.stringify(back.flow && back.flow.degenerate));
  chk("反向 snap_ts=13:25 → 產出不同", shot(back) !== shot(CTRL));
  // 2b 錯到別的日期：fi:<date> 讀不到 → 無 frame → flow 直接 null
  const bad = await computeLiveFlow(mkEnv(KV_MAIN), mkLive({ snap_ts: BAD }), CL, BASELINE);
  chk("反向 snap_ts=1999 → 無 frame → flow=null（證明 KV frame 定位吃 snap_ts）",
    bad.flow === null, JSON.stringify(bad.flow));
  chk("反向 series 取日期跟著 snap_ts 走",
    snapTs(mkLive({ snap_ts: BAD })).slice(0, 10) === "1999-01-01");
}

// ---- 3. computeFlow 的上游停滯守門（nowTs 比對 frame._ts）也吃 snap_ts ----
// 形狀：13:20 那格的 _ts 與當前快照時戳完全相同（上游停滯）→ 該窗必須被丟棄。
{
  const STALL_TS = "2026-09-04 13:35:02.000000";
  const KV_STALL = {
    "fi:2026-09-04": JSON.stringify(["13:00", "13:20"]),
    "f:2026-09-04:13:00": frame(6e9, 1.2e9, "2026-09-04 13:00:03.000000"),
    "f:2026-09-04:13:20": frame(7e9, 1.5e9, STALL_TS),      // ← 與 snap_ts 同值＝停滯
  };
  const ctrl = await computeLiveFlow(mkEnv(KV_STALL), mkLive({ snap_ts: STALL_TS, ts: STALL_TS }), CL, BASELINE);
  chk("停滯 控制組：10 分窗被 stale 守門丟棄，只剩 30 分窗",
    ctrl.flow && eq(ctrl.flow.frames, { 30: "13:00" }), JSON.stringify(ctrl.flow && ctrl.flow.frames));
  const fwd = await computeLiveFlow(mkEnv(KV_STALL), mkLive({ snap_ts: STALL_TS, ts: BAD }), CL, BASELINE);
  chk("停滯 正向 ts=1999 → 守門結果不變", shot(fwd) === shot(ctrl));
  // 反向：snap_ts 差 1 秒 → 不再判定停滯 → 10 分窗復活
  const rev = await computeLiveFlow(mkEnv(KV_STALL),
    mkLive({ snap_ts: "2026-09-04 13:35:03.000000", ts: STALL_TS }), CL, BASELINE);
  chk("停滯 反向 snap_ts 差 1 秒 → 10 分窗復活（證明 nowTs 吃 snap_ts）",
    rev.flow && eq(rev.flow.frames, { 10: "13:20", 30: "13:00" }), JSON.stringify(rev.flow && rev.flow.frames));
}

// ---- 4. framesDegenerate 本身不吃時戳（不需改動）：純看 frame 名稱與門檻 ----
{
  chk("framesDegenerate 13:35 → true", framesDegenerate({ 10: "13:35" }, 10) === true);
  chk("framesDegenerate 13:20 → false", framesDegenerate({ 10: "13:20" }, 10) === false);
  chk("framesDegenerate 無 frame → true", framesDegenerate({}, 10) === true);
}

// ---- 5. flowLastPayload 刻意**維持吃對外 ts**（釘住這個設計決定；理由見其上方註解）----
{
  const live = { ts: "2026-09-05 13:30:00.000000", snap_ts: BAD,
    stock_cols: ["chg", "amt", "close", "f10", "c10", "c30", "r10", "f30"],
    stocks: { 2330: [1, 9e9, 1150, 5e8, 1.1, 1.0, 0.5, 15e8] },
    flow: { wins: { w1: 10, w2: 30 }, frames: { 10: "13:20", 30: "13:00" }, baseline_date: "2026-09-04",
      subs: [], mkt: { d10_yi: 1, d30_yi: 2 } } };
  const pl = flowLastPayload(live);
  chk("flow_last.date 跟著對外 ts（不是 snap_ts）", pl.date === "2026-09-05", pl.date);
  chk("flow_last.ts 跟著對外 ts（不是 snap_ts）", pl.ts === "2026-09-05 13:30:00.000000", pl.ts);
}

console.log(`snapts: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
