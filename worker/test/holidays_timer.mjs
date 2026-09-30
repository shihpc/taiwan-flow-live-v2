// holidayCalCached 的硬上限 race timer 必須在 finally 以 clearTimeout 清掉（CLAUDE.md「休市日（國定假日）
// 各排程角色」節；補 S1 測試漏洞：原本把 clearTimeout 拿掉所有測試仍綠）。
// 執行：cd worker && node test/holidays_timer.mjs
//
// 做法：stub 全域 setTimeout／clearTimeout，記錄每個 timer 的建立（含 delay）、清除與觸發；以獨特的 hardMs 值
// 辨識 race timer（delay === hardMs），跑三條路徑——①行事曆快速成功 ②fetch 拋錯（fail-open）③body 永不
// resolve 觸發硬上限——每條結束後斷言「本次建立的 race timer 恰 1 個、且全數被 clearTimeout 清除、無殘留」。
// ③的 timer 已觸發過，但 finally 仍會 clearTimeout 它；斷言要求它也被清（對清掉 clearTimeout 的突變一樣會紅）。
import { readFile } from "node:fs/promises";
import { resetHolidayMemo, holidayCalCached, HOLIDAYS_URL } from "../src/index.js";

let fails = 0;
const ok = (c, m) => { if (c) console.log("  ok  " + m); else { fails++; console.log("  FAIL " + m); } };

const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
let timers = [];   // { h, delay, cleared, fired }
function installStub() {
  timers = [];
  globalThis.setTimeout = (fn, delay, ...a) => {
    const rec = { delay, cleared: false, fired: false, h: null };
    rec.h = realSet(() => { rec.fired = true; fn(...a); }, delay);
    timers.push(rec);
    return rec.h;
  };
  globalThis.clearTimeout = (h) => {
    for (const t of timers) if (t.h === h) t.cleared = true;
    return realClear(h);
  };
}
function uninstallStub() { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; }

const calJson = JSON.parse(await readFile(new URL("../../data/twse_holidays.json", import.meta.url), "utf8"));

async function runCase(name, hardMs, fetchFn, expectCal, expectErr) {
  console.log(name);
  resetHolidayMemo();
  installStub();
  let r;
  try { r = await holidayCalCached(fetchFn, Date.parse("2026-09-25T02:00:00Z"), hardMs); }
  finally { uninstallStub(); }
  await new Promise((res) => realSet(res, 0));   // 讓 finally 鏈跑完
  const race = timers.filter((t) => t.delay === hardMs);
  ok(expectCal ? !!r.cal : r.cal === null, `cal ${expectCal ? "非 null" : "為 null"}`);
  if (expectErr) ok(expectErr(r.err), `err＝${r.err}`);
  ok(race.length === 1, `建立 race timer 恰 1 個（實得 ${race.length}）`);
  ok(race.every((t) => t.cleared), `race timer 全數被 clearTimeout 清除（未清 ${race.filter((t) => !t.cleared).length} 個）`);
  ok(race.every((t) => t.cleared || t.fired), "無殘留（未清且未觸發＝0）");
  for (const t of race) if (!t.cleared && !t.fired) realClear(t.h);   // 失敗時別讓殘留 timer 拖住行程
}

// ① 快速成功
await runCase("① 行事曆快速成功", 4321,
  async (url) => { if (url !== HOLIDAYS_URL) throw new Error("unexpected " + url); return { ok: true, status: 200, json: async () => calJson }; },
  true, (e) => e === null);

// ② fetch 拋錯（fail-open）
await runCase("② fetch 拋錯（fail-open）", 4322,
  async () => { throw new Error("boom"); },
  false, (e) => /boom/.test(String(e)));

// ③ body 永不 resolve → 硬上限
await runCase("③ body 永不 resolve 觸發硬上限", 30,
  async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }),
  false, (e) => e === "timeout");

resetHolidayMemo();
if (fails) { console.log(`\n${fails} FAIL`); process.exit(1); }
console.log("\nall ok");
