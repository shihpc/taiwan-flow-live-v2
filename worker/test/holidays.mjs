// /status 休市行事曆（docs/holiday-calendar.md，2026-09-28 批次一）離線測試。
// 不打真實網路：行事曆與各站來源全用 mock；closed 集合由測試自己給（**不是真實行事曆**，
// 09-28 是否休市以上線後 data/twse_holidays.json 為準）。執行：cd worker && node test/holidays.mjs
import { lastExpectedTradingDate, prevExpectedTradingDate, gradeMarket, gradeBacktest, addDaysISO,
  holidayClosed, parseHolidayCal, loadHolidayCal, buildStatus, HOLIDAYS_URL, STATUS_DUE_HOUR } from "../src/index.js";

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; } else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}
const dowOf = (d) => new Date(d + "T00:00:00Z").getUTCDay();
const tpOf = (date, hour, minute = 0) => ({ date, dow: dowOf(date), hour, minute });

const CAL = parseHolidayCal({ schema: 1, years: [2026], closed: ["2026-09-25", "2026-09-28"] });
// fixture 自檢：星期幾正確
chk("fixture：09-25 週五／09-26 週六／09-28 週一／09-29 週二",
  dowOf("2026-09-25") === 5 && dowOf("2026-09-26") === 6 && dowOf("2026-09-28") === 1 && dowOf("2026-09-29") === 2);

// ---- 行事曆解析與 holidayClosed ----
{
  chk("parseHolidayCal 合法 → Set", CAL && CAL.closed instanceof Set && CAL.years.has(2026) && CAL.closed.has("2026-09-25"));
  chk("parseHolidayCal null → null", parseHolidayCal(null) === null);
  chk("parseHolidayCal schema≠1 → null", parseHolidayCal({ schema: 2, years: [2026], closed: [] }) === null);
  chk("parseHolidayCal 缺 closed → null", parseHolidayCal({ schema: 1, years: [2026] }) === null);
  chk("parseHolidayCal years 空 → null", parseHolidayCal({ schema: 1, years: [], closed: ["2026-09-25"] }) === null);
  chk("parseHolidayCal 濾掉非法日期字串", parseHolidayCal({ schema: 1, years: [2026], closed: ["2026-9-25", 5, "2026-09-25"] }).closed.size === 1);
  chk("holidayClosed：涵蓋年度內的休市日 → true", holidayClosed("2026-09-25", CAL) === true);
  chk("holidayClosed：非休市日 → false", holidayClosed("2026-09-24", CAL) === false);
  chk("holidayClosed：cal 缺 → false", holidayClosed("2026-09-25", null) === false);
  const unc = parseHolidayCal({ schema: 1, years: [2025], closed: ["2026-09-25"] });
  chk("holidayClosed：年度不在 years（未知）→ false（不當成假日）", holidayClosed("2026-09-25", unc) === false);
  chk("holidayClosed：也接受純陣列形狀", holidayClosed("2026-09-25", { years: [2026], closed: ["2026-09-25"] }) === true);
}

// ---- 前一交易日／最近預期交易日 ----
{
  chk("prev：09-29 → 09-24（跳過 28 假日、27/26 週末、25 假日）", prevExpectedTradingDate("2026-09-29", CAL) === "2026-09-24");
  chk("prev：無 cal 時 09-29 → 09-28（舊行為）", prevExpectedTradingDate("2026-09-29") === "2026-09-28");
  chk("prev：09-26 → 09-24", prevExpectedTradingDate("2026-09-26", CAL) === "2026-09-24");
  const due = STATUS_DUE_HOUR.flows;
  chk("last：09-25 週五假日 21:00 → 09-24", lastExpectedTradingDate(tpOf("2026-09-25", 21), due, CAL) === "2026-09-24");
  chk("last：09-25 週五假日 08:00 → 09-24", lastExpectedTradingDate(tpOf("2026-09-25", 8), due, CAL) === "2026-09-24");
  chk("last：09-26 週六（週五是假日）→ 09-24", lastExpectedTradingDate(tpOf("2026-09-26", 10), due, CAL) === "2026-09-24");
  chk("last：09-27 週日 → 09-24", lastExpectedTradingDate(tpOf("2026-09-27", 10), due, CAL) === "2026-09-24");
  chk("last：09-28 週一假日 21:00 → 09-24", lastExpectedTradingDate(tpOf("2026-09-28", 21), due, CAL) === "2026-09-24");
  chk("last：09-29 首個交易日 10:00（未到 due）→ 09-24", lastExpectedTradingDate(tpOf("2026-09-29", 10), due, CAL) === "2026-09-24");
  chk("last：09-29 首個交易日 21:00 → 09-29", lastExpectedTradingDate(tpOf("2026-09-29", 21), due, CAL) === "2026-09-29");
  chk("last：無 cal 時 09-26 → 09-25（舊行為）", lastExpectedTradingDate(tpOf("2026-09-26", 10), due) === "2026-09-25");
  const unc = parseHolidayCal({ schema: 1, years: [2025], closed: ["2026-09-25", "2026-09-28"] });
  chk("last：年度未涵蓋 → 退回只排週末（09-26 → 09-25）", lastExpectedTradingDate(tpOf("2026-09-26", 10), due, unc) === "2026-09-25");
  chk("last：年度未涵蓋 → 09-28 21:00 仍期待 09-28", lastExpectedTradingDate(tpOf("2026-09-28", 21), due, unc) === "2026-09-28");
}

// ---- gradeMarket ----
{
  const due = STATUS_DUE_HOUR.flows;
  chk("market：09-26 週六、資料 09-24 → green（有 cal）", gradeMarket("2026-09-24", tpOf("2026-09-26", 10), due, CAL) === "green");
  chk("market：09-26 週六、資料 09-24 → yellow（無 cal，舊行為）", gradeMarket("2026-09-24", tpOf("2026-09-26", 10), due) === "yellow");
  chk("market：09-28 假日 21:00、資料 09-24 → green（有 cal）", gradeMarket("2026-09-24", tpOf("2026-09-28", 21), due, CAL) === "green");
  chk("market：09-28 假日 21:00、資料 09-24 → red（無 cal，舊行為）", gradeMarket("2026-09-24", tpOf("2026-09-28", 21), due) === "red");
  chk("market：09-29 21:00、資料 09-29 → green", gradeMarket("2026-09-29", tpOf("2026-09-29", 21), due, CAL) === "green");
  chk("market：09-29 21:00、資料 09-24 → yellow（落後 1 交易日＝跨假日那格）", gradeMarket("2026-09-24", tpOf("2026-09-29", 21), due, CAL) === "yellow");
  chk("market：09-29 21:00、資料 09-23 → red", gradeMarket("2026-09-23", tpOf("2026-09-29", 21), due, CAL) === "red");
  chk("market：09-29 10:00（未到 due）、資料 09-24 → green", gradeMarket("2026-09-24", tpOf("2026-09-29", 10), due, CAL) === "green");
  const unc = parseHolidayCal({ schema: 1, years: [2027], closed: ["2026-09-25", "2026-09-28"] });
  chk("market：年度未涵蓋 → 與無 cal 相同（09-28 21:00 資料 09-24 → red）",
    gradeMarket("2026-09-24", tpOf("2026-09-28", 21), due, unc) === "red");
}

// ---- gradeBacktest ----
{
  // 09-26 週六 10:00 → 參考日 09-25（假日）、參考時鐘 22:00
  chk("backtest：09-26 10:00、帳冊 09-24 → green（有 cal：參考日 09-25 是假日）", gradeBacktest("2026-09-24", tpOf("2026-09-26", 10), CAL) === "green");
  chk("backtest：09-26 10:00、帳冊 09-24 → red（無 cal，舊行為）", gradeBacktest("2026-09-24", tpOf("2026-09-26", 10)) === "red");
  // 09-28 23:00 → 參考日 09-28（假日）11:00
  chk("backtest：09-28 23:00、帳冊 09-24 → green（有 cal）", gradeBacktest("2026-09-24", tpOf("2026-09-28", 23), CAL) === "green");
  chk("backtest：09-28 23:00、帳冊 09-24 → red（無 cal：前一交易日 09-25 也缺）", gradeBacktest("2026-09-24", tpOf("2026-09-28", 23)) === "red");
  chk("backtest：09-28 假日、帳冊 09-23 → red（落後超過一個交易日）", gradeBacktest("2026-09-23", tpOf("2026-09-28", 23), CAL) === "red");
  // 09-29 22:00 → 參考日 09-29 10:00（等待窗）
  chk("backtest：09-29 22:00、帳冊 09-24 → yellow（有 cal：前一交易日＝09-24）", gradeBacktest("2026-09-24", tpOf("2026-09-29", 22), CAL) === "yellow");
  chk("backtest：09-29 22:00、帳冊 09-24 → red（無 cal：前一交易日＝09-28）", gradeBacktest("2026-09-24", tpOf("2026-09-29", 22)) === "red");
  chk("backtest：09-30 08:00、帳冊 09-29 → green", gradeBacktest("2026-09-29", tpOf("2026-09-30", 8), CAL) === "green");
  chk("backtest：09-30 08:00、帳冊 09-24 → red（兩班加緩衝都過）", gradeBacktest("2026-09-24", tpOf("2026-09-30", 8), CAL) === "red");
}

// ---- 預設參數＝舊行為：與改動前原始碼（逐字抄自 origin 版本）對跑整張網格 ----
{
  const oldPrev = (dateISO) => { let d = dateISO; do { d = addDaysISO(d, -1); } while (["0", "6"].includes(String(new Date(d + "T00:00:00Z").getUTCDay()))); return d; };
  const oldDue = (tp, dueHour = 0) => tp.hour + (tp.minute || 0) / 60 >= dueHour;
  const oldLast = (tp, dueHour = 0) => (tp.dow >= 1 && tp.dow <= 5) ? (oldDue(tp, dueHour) ? tp.date : oldPrev(tp.date)) : addDaysISO(tp.date, tp.dow === 6 ? -1 : -2);
  const oldLadder = (dd, exp, prevOf) => !dd ? "red" : dd >= exp ? "green" : dd >= prevOf(exp) ? "yellow" : "red";
  const oldMarket = (dd, tp, dueHour = 0) => oldLadder(dd, oldLast(tp, dueHour), oldPrev);
  const oldBt = (lastDate, tp) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(lastDate == null ? "" : lastDate))) return "red";
    const back = tp.hour < 12, h = back ? tp.hour + 12 : tp.hour - 12;
    const day = back ? addDaysISO(tp.date, -1) : tp.date, hm = `${String(h).padStart(2, "0")}:${String(tp.minute || 0).padStart(2, "0")}`;
    const dow = new Date(day + "T00:00:00Z").getUTCDay();
    if (dow === 0 || dow === 6) return lastDate >= oldPrev(day) ? "green" : "red";
    if (lastDate >= day) return "green";
    if (lastDate < oldPrev(day)) return "red";
    return hm < "09:07" ? "green" : hm < "19:07" ? "yellow" : "red";
  };
  const EMPTY = { closed: new Set(), years: new Set() };
  let n = 0, diff = 0;
  for (let k = 0; k < 21; k++) {
    const date = addDaysISO("2026-09-20", k);
    for (let hour = 0; hour < 24; hour++) for (const minute of [0, 30]) {
      const tp = tpOf(date, hour, minute);
      for (let off = -5; off <= 1; off++) {
        const dd = addDaysISO(date, off);
        for (const due of [0, 9, 20, 22.5, 23.75]) {
          const o = oldMarket(dd, tp, due);
          for (const g of [gradeMarket(dd, tp, due), gradeMarket(dd, tp, due, null), gradeMarket(dd, tp, due, EMPTY)]) { n++; if (g !== o) diff++; }
        }
        const ob = oldBt(dd, tp);
        for (const g of [gradeBacktest(dd, tp), gradeBacktest(dd, tp, null), gradeBacktest(dd, tp, EMPTY)]) { n++; if (g !== ob) diff++; }
        n++; if (lastExpectedTradingDate(tp, 20) !== oldLast(tp, 20)) diff++;
        n++; if (prevExpectedTradingDate(dd) !== oldPrev(dd)) diff++;
      }
    }
  }
  chk(`預設（省略／null／空 cal）與改動前逐字相同（${n} 組）`, diff === 0, `diff=${diff}`);
}

// ---- loadHolidayCal：fail-open ----
{
  const good = { schema: 1, years: [2026], closed: ["2026-09-25"], names: {}, raw_n: 1 };
  const seen = [];
  const r1 = await loadHolidayCal(async (u) => { seen.push(String(u)); return { ok: true, status: 200, json: async () => good }; });
  chk("load：合法 → cal", r1.cal && r1.cal.closed.has("2026-09-25") && r1.err === null);
  chk("load：打的是 HOLIDAYS_URL（本 repo raw main）", seen[0] === HOLIDAYS_URL && /shihpc\/taiwan-flow-live-v2\/main\/data\/twse_holidays\.json$/.test(HOLIDAYS_URL));
  const r2 = await loadHolidayCal(async () => ({ ok: false, status: 404, json: async () => null }));
  chk("load：404 → cal null＋err", r2.cal === null && /404/.test(r2.err));
  const r3 = await loadHolidayCal(async () => { throw new Error("net down"); });
  chk("load：fetch 拋錯 → 不拋、cal null", r3.cal === null && /net down/.test(r3.err));
  const r4 = await loadHolidayCal(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); } }));
  chk("load：壞 JSON → cal null", r4.cal === null);
  const r5 = await loadHolidayCal(async () => ({ ok: true, status: 200, json: async () => ({ schema: 1, years: "2026" }) }));
  chk("load：形狀不合 → cal null", r5.cal === null && r5.err === "bad-shape");
}

// ---- buildStatus 端到端：09-25 missing 形狀（actual_date=09-24）----
{
  const fakeKV = (init = {}) => { const m = new Map(Object.entries(init)); return { async get(k) { return m.has(k) ? m.get(k) : null; } }; };
  const kv = () => fakeKV({ "fi:2026-09-24": ["09:01", "13:30"], "fi:2026-09-23": ["13:30"] });
  const flowsMissing = { date: "2026-09-25", status: "missing", expected_date: "2026-09-25", actual_date: "2026-09-24",
    checked_at: "2026-09-26T03:32:12.570807+08:00" };
  const calFile = { schema: 1, source: "x", fetched_at: "2026-09-28T10:00:00+08:00", years: [2026],
    closed: ["2026-09-25", "2026-09-28"], names: {}, raw_n: 2 };
  const mk = (holidayResp) => async (u, init) => {
    const s = String(u);
    if (s === HOLIDAYS_URL) return holidayResp();
    if (s.includes("/taiwan-flows/")) return { ok: true, status: 200, json: async () => flowsMissing };
    if (s.endsWith("/news.json")) return { ok: true, status: 200, json: async () => ({ generated_at: "2026-09-26T09:07:00+08:00", trading_days: ["2026-09-24"], total_news: 1 }) };
    if (s.endsWith("/daily-brief-card.json")) return { ok: true, status: 200, json: async () => ({ date: "2026-09-26", generated_at: "x" }) };
    if (s.endsWith("/postmkt.json")) return { ok: true, status: 206, text: async () => '{"date":"2026-09-24","generated_at":"2026-09-24T22:05:00+08:00"' };
    if (s.endsWith("/ledger.csv")) return { ok: true, status: 206, text: async () => "date,x\n2026-09-24,1\n" };
    if (s.endsWith("/latest.json")) return { ok: true, status: 206, text: async () => '{"date":"2026-09-24","x":1' };
    return { ok: false, status: 404, json: async () => null, text: async () => "" };
  };
  const calOk = () => ({ ok: true, status: 200, json: async () => calFile });
  const by = (out, id) => (out.sites.find((x) => x.id === id) || {});
  const SAT = tpOf("2026-09-26", 10), MON = tpOf("2026-09-28", 21);
  for (const [tp, label] of [[SAT, "09-26 週六 10:00"], [MON, "09-28 假日 21:00"]]) {
    const meta = {};
    const out = await buildStatus({ FLOW_KV: kv() }, tp, mk(calOk), Date.parse(`${tp.date}T${String(tp.hour).padStart(2, "0")}:00:00+08:00`), meta);
    const f = by(out, "flows");
    chk(`端到端 ${label}：flows 09-24 → green`, f.level === "green" && f.data_date === "2026-09-24", JSON.stringify(f));
    for (const id of ["live", "postmkt", "backtest", "iching"]) {
      chk(`端到端 ${label}：${id} → green`, by(out, id).level === "green", JSON.stringify(by(out, id)));
    }
    chk(`端到端 ${label}：頂層鍵不變`, Object.keys(out).sort().join(",") === "generated_at,schema,sites,status", Object.keys(out).join(","));
    chk(`端到端 ${label}：meta.holidays loaded`, meta.holidays && meta.holidays.loaded === true && meta.holidays.years.join() === "2026", JSON.stringify(meta));
  }
  // 行事曆讀不到 → fail-open（與現行行為相同：09-26 週六 flows 09-24 → yellow），不拋、七站齊全
  for (const [bad, label] of [[() => ({ ok: false, status: 404, json: async () => null }), "404"],
    [() => { throw new Error("boom"); }, "拋錯"],
    [() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("x"); } }), "壞檔"]]) {
    const meta = {};
    const out = await buildStatus({ FLOW_KV: kv() }, SAT, mk(bad), Date.parse("2026-09-26T10:00:00+08:00"), meta);
    chk(`fail-open（${label}）：七站齊全、status ok`, out.status === "ok" && out.sites.length === 7);
    chk(`fail-open（${label}）：flows 退回只排週末 → yellow`, by(out, "flows").level === "yellow", JSON.stringify(by(out, "flows")));
    chk(`fail-open（${label}）：無任何站因行事曆被染紅`, !out.sites.some((x) => /行事曆|holiday/i.test(x.note)));
    chk(`fail-open（${label}）：meta.holidays.loaded=false`, meta.holidays && meta.holidays.loaded === false, JSON.stringify(meta));
  }
  // 行事曆讀不到時，站點輸出與「根本沒去讀行事曆」逐位相同（以 fail-open 形狀對 09-26 與 09-28 兩個時點對照 cal=null 的判級）
  {
    const out = await buildStatus({ FLOW_KV: kv() }, MON, mk(() => ({ ok: false, status: 404 })), Date.parse("2026-09-28T21:00:00+08:00"));
    chk("fail-open：09-28 21:00 flows 判級＝gradeMarket 不帶 cal", by(out, "flows").level === gradeMarket("2026-09-24", MON, STATUS_DUE_HOUR.flows));
  }
}

console.log(`holidays.mjs: ${pass} pass, ${fail} fail`);
if (fail) process.exit(1);
