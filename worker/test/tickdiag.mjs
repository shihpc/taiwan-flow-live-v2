// 台指期 tick 量測班 離線單元測試（2026-09-09）
// 無需 token、不打真實網路——fetch / KV 全用 mock。
// 執行：cd worker && node test/tickdiag.mjs
import { readFileSync } from "node:fs";
import worker, { summarizeTickRows, tickSampleSlots, tickSampleKey, TICK_SAMPLE_TTL,
  TICK_CRON, TICK_START_HOUR, TICK_END_HOUR, TICK_MAX_PARSE_BYTES, maskTickErr,
  runTickSample, dispatchRoleForCron, scheduledRole, taipeiParts,
  TICK_FETCH_TIMEOUT_MS, TICK_BODY_TIMEOUT_MS, TICK_CANCEL_TIMEOUT_MS, TICK_TIMEOUT_NAME,
  tickWithTimeout, TICK_SAMPLE_SINCE, TICK_TEARDOWN_DUE_DAYS, tickAgeDays,
  tickTeardownDue, TICK_KV_TIMEOUT_MS, TICK_ALERT_TIMEOUT_MS } from "../src/index.js";

let pass = 0, fail = 0;
// 逾時那幾條會刻意放生一票永不 resolve 的 promise（Promise.race 不取消底層操作）。放生本身
// 無害，但若其中任何一個**被拒絕**而沒人接，node 預設會讓整個行程爆掉——那是 crash 不是紅字。
// 明確接起來記成一條斷言，讓「逾時實作不小心留下無人接的 rejection」會是可讀的紅。
let unhandled = 0;
process.on("unhandledRejection", (e) => {
  unhandled++; console.log(`  x unhandledRejection: ${(e && e.message) || e}`);
});
function chk(name, ok, detail) {
  if (ok) { pass++; } else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// 便利：指定「台北時間」造 UTC Date（台北 = UTC+8）
const tpe = (iso) => new Date(new Date(`${iso}Z`).getTime() - 8 * 3600e3);
const SRC = readFileSync(new URL("../src/index.js", import.meta.url), "utf-8");

// ---- summarizeTickRows：三段分布與收盤段 d13（本批的核心量測值）----
{
  // 三段各有樣本：凌晨夜盤 / 日盤（含 13:44 之後的收盤段）/ 當日夜盤
  const rows = [
    { time: "07:30:00.000000", date: "2026-09-09", contract_date: "202609" },   // seg.a
    { time: "08:45:00.000000", date: "2026-09-09", contract_date: "202609" },   // seg.b
    { time: "13:20:00.000000", date: "2026-09-09", contract_date: "202609" },   // seg.b，**不算 d13**
    { time: "13:44:00.000000", date: "2026-09-09", contract_date: "202612" },   // seg.b + d13（下界含）
    { time: "13:59:59.000000", date: "2026-09-09", contract_date: "202612" },   // seg.b + d13
    { time: "14:30:00.000000", date: "2026-09-09", contract_date: "202609" },   // seg.c（上界不含 → 不算 d13）
    { time: "15:00:00.000000", date: "2026-09-09", contract_date: "202609" },   // seg.c
  ];
  const s = summarizeTickRows(rows);
  chk("n = 全部列數", s.n === 7, String(s.n));
  chk("seg 三段門檻 08:00 / 14:00", eq(s.seg, { a: 1, b: 4, c: 2 }), JSON.stringify(s.seg));
  chk("d13 = time∈[13:44,14:00) 的列數（13:20 不算、14:30 不算）", s.d13 === 2, String(s.d13));
  chk("mn/mx 為原始字串字典序極值",
    s.mn === "07:30:00.000000" && s.mx === "15:00:00.000000", `${s.mn} / ${s.mx}`);
  chk("ct = distinct contract_date", s.ct === 2, String(s.ct));
  chk("dates 去重", eq(s.dates, ["2026-09-09"]), JSON.stringify(s.dates));
  chk("tk 偵測到 time", s.tk === "time", String(s.tk));
}

// ---- summarizeTickRows：門檻邊界（14:00 那一秒屬夜盤段、08:00 那一秒屬日盤段）----
{
  const s = summarizeTickRows([
    { time: "07:59:59" }, { time: "08:00:00" }, { time: "13:43:59" },
    { time: "14:00:00" },
  ]);
  chk("邊界 07:59:59→a、08:00:00→b、14:00:00→c", eq(s.seg, { a: 1, b: 2, c: 1 }), JSON.stringify(s.seg));
  chk("邊界 13:43:59 不算 d13", s.d13 === 0, String(s.d13));
}

// ---- summarizeTickRows：時間欄位名不靠印象（依序試 time/Time/datetime/Datetime）----
{
  chk("tk=Time", summarizeTickRows([{ Time: "09:00:00" }]).tk === "Time");
  chk("tk=datetime（且吃得下 'YYYY-MM-DD HH:MM:SS' 形狀）",
    summarizeTickRows([{ datetime: "2026-09-09 13:50:00" }]).tk === "datetime");
  chk("datetime 形狀仍分得出段與 d13",
    eq(summarizeTickRows([{ datetime: "2026-09-09 13:50:00" }]).seg, { a: 0, b: 1, c: 0 })
    && summarizeTickRows([{ datetime: "2026-09-09 13:50:00" }]).d13 === 1);
  chk("tk=Datetime", summarizeTickRows([{ Datetime: "09:00:00" }]).tk === "Datetime");
  const none = summarizeTickRows([{ price: 1 }, { price: 2 }]);
  chk("四個欄位名都沒有 → tk=null 且不拋錯", none.tk === null && none.n === 2
    && eq(none.seg, { a: 0, b: 0, c: 0 }), JSON.stringify(none));
}

// ---- summarizeTickRows：空／非陣列輸入不得拋錯（採樣班不能因一次壞回應整班掛掉）----
{
  const EMPTY = { n: 0, mn: null, mx: null, seg: { a: 0, b: 0, c: 0 }, d13: 0, ct: 0, dates: [], tk: null };
  for (const [name, v] of [["null", null], ["undefined", undefined], ["[]", []],
    ["物件", { data: [] }], ["字串", "x"], ["數字", 0]]) {
    let out, threw = false;
    try { out = summarizeTickRows(v); } catch (e) { threw = true; out = String(e && e.message); }
    chk(`空/非陣列輸入(${name}) 回 n:0 且不拋錯`, !threw && eq(out, EMPTY), String(out));
  }
}

// ---- summarizeTickRows：dates 上限 5 筆 ----
{
  const rows = ["01", "02", "03", "04", "05", "06", "07"].map((d) =>
    ({ time: "09:00:00", date: `2026-09-${d}` }));
  const s = summarizeTickRows(rows);
  chk("dates 上限 5 筆且已排序", s.dates.length === 5 && s.dates[0] === "2026-09-01"
    && s.dates[4] === "2026-09-05", JSON.stringify(s.dates));
}

// ---- tickSampleSlots：與 cron `*/5 1-11 * * 2-6` 決定性一致（台北 09:00–19:55 每 5 分）----
{
  const slots = tickSampleSlots();
  chk("132 個時點（11 小時 × 12）", slots.length === 132, String(slots.length));
  chk("首末時點 0900 / 1955", slots[0] === "0900" && slots[131] === "1955",
    `${slots[0]} / ${slots[slots.length - 1]}`);
  chk("時窗常數 9–20", TICK_START_HOUR === 9 && TICK_END_HOUR === 20,
    `${TICK_START_HOUR}-${TICK_END_HOUR}`);
  chk("全部 HHMM 且分鐘為 5 的倍數", slots.every((h) => /^\d{4}$/.test(h) && Number(h.slice(2)) % 5 === 0));
  chk("無重複", new Set(slots).size === 132);
  chk("不含 20:00 之後的時點", !slots.some((h) => Number(h.slice(0, 2)) >= 20));
}

// ---- KV key 與 TTL ----
{
  chk("tickSampleKey 格式", tickSampleKey("2026-09-09", "1345") === "tick:20260909:1345",
    tickSampleKey("2026-09-09", "1345"));
  chk("TTL = 7 天", TICK_SAMPLE_TTL === 7 * 86400, String(TICK_SAMPLE_TTL));
  // 一次採樣一把獨立 key＝天生免疫 same-key 1 write/s，且免去讀-改-寫索引
  const keys = tickSampleSlots().map((hm) => tickSampleKey("2026-09-09", hm));
  chk("132 個時點 → 132 把互異 key", new Set(keys).size === 132);
}

// ---- 路由：TICK_CRON 必須在 dispatchRoleForCron 就被攔下 ----
{
  chk("TICK_CRON 字面量", TICK_CRON === "*/5 1-11 * * 2-6", TICK_CRON);
  chk("dispatchRoleForCron(TICK_CRON) → ticksample",
    eq(dispatchRoleForCron(TICK_CRON), { kind: "ticksample" }),
    JSON.stringify(dispatchRoleForCron(TICK_CRON)));
  // 為什麼一定要攔：不攔就會落到 scheduledRole，在台北 09:00–13:59 被判成 frame → 重複寫格
  chk("（反證）未攔截時 scheduledRole 會把它判成 frame",
    scheduledRole(taipeiParts(tpe("2026-09-09T10:30:00")), TICK_CRON) === "frame");
  // 既有 19 條 cron 的歸屬一條都不能變
  const EXIST = {
    "* 1-5 * * 2-6": null, "*/5 9-14 * * 2-6": null, "7,47 0-14,22-23 * * *": null,
    "35 5 * * 2-6": "backup", "40 6 * * 2-6": "backup", "35 10 * * 2-6": "backup",
    "5 12 * * 2-6": "backup", "5 21 * * *": "backup", "5 6 * * 2-6": "backup",
    "10 7 * * 2-6": "backup", "0 11 * * 2-6": "backup", "55 12 * * 2-6": "backup",
    "35 21 * * *": "backup", "*/5 13-15 * * 2-6": "evening", "50,55 22 * * *": "summary-am",
    "*/5 23 * * *": "summary-am", "*/10 0 * * *": "summary-am",
    "50 15 * * 2-6": "health", "30 1 * * 2-6": "health",
  };
  chk("既有 cron 恰 19 條", Object.keys(EXIST).length === 19);
  for (const [cron, kind] of Object.entries(EXIST)) {
    const got = dispatchRoleForCron(cron);
    chk(`既有 cron 歸屬不變：${cron}`, kind === null ? got === null : (got && got.kind === kind),
      JSON.stringify(got));
  }
  chk("TICK_CRON 不與既有 19 條任何一條同字串", !(TICK_CRON in EXIST));
}

// ---- wrangler.toml：只新增一條、且與 TICK_CRON 逐字一致 ----
{
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf-8");
  const crons = toml.split("crons = [")[1].split("]")[0].split("\n")
    .map((l) => (l.match(/^\s*"([^"]+)"/) || [])[1]).filter(Boolean);
  chk("crons 共 21 條", crons.length === 21, String(crons.length));
  chk("crons 含 TICK_CRON 且僅一次", crons.filter((c) => c === TICK_CRON).length === 1);
  chk("crons 無重複字串", new Set(crons).size === crons.length);
}

// ---- runTickSample：正常採樣（mock fetch + mock KV）----
{
  const puts = [];
  const env = { FINMIND_TOKEN: "TK", FLOW_KV: { put: async (k, v, o) => { puts.push([k, v, o]); } } };
  let seenUrl = "";
  const fetchFn = async (u) => {
    seenUrl = String(u);
    return new Response(JSON.stringify({ status: 200, data: [
      { time: "08:46:00.000000", date: "2026-09-09", contract_date: "202609", price: 24000 },
      { time: "13:45:00.000000", date: "2026-09-09", contract_date: "202609", price: 24010 },
    ] }));
  };
  const tp = taipeiParts(tpe("2026-09-09T13:50:00"));   // 週三 13:50
  const val = await runTickSample(env, tp, fetchFn);
  chk("URL 形狀與 /live 的 finFuturesVix 相同（dataset/data_id/start_date）",
    seenUrl.startsWith("https://api.finmindtrade.com/api/v4/data?dataset=TaiwanFuturesTick&data_id=TX&start_date=2026-09-09&token="),
    seenUrl.replace(/token=.*/, "token=***"));
  chk("不帶任何快取參數（不污染 /live 的 cf 快取）", !seenUrl.includes("cache"));
  chk("恰寫一把 KV", puts.length === 1, String(puts.length));
  chk("key = tick:<YYYYMMDD>:<HHMM>", puts[0][0] === "tick:20260909:1350", puts[0][0]);
  chk("帶 expirationTtl 7 天", puts[0][2] && puts[0][2].expirationTtl === TICK_SAMPLE_TTL,
    JSON.stringify(puts[0][2]));
  const w = JSON.parse(puts[0][1]);
  chk("寫入值＝摘要＋at/st/ms/bytes", w.st === 200 && typeof w.at === "number"
    && typeof w.ms === "number" && w.bytes > 0, JSON.stringify(w).slice(0, 160));
  chk("寫入值含分段摘要", w.n === 2 && eq(w.seg, { a: 0, b: 2, c: 0 }) && w.d13 === 1 && w.tk === "time",
    JSON.stringify(w));
  chk("成功時無 err 欄", !("err" in w));
  chk("回傳值與寫入值一致", eq(val, w));
}

// ---- runTickSample：fetch 例外也要寫一筆（「沒樣本」與「抓失敗」不可混講）----
{
  const puts = [];
  const env = { FINMIND_TOKEN: "TK", FLOW_KV: { put: async (k, v, o) => { puts.push([k, v, o]); } } };
  const tp = taipeiParts(tpe("2026-09-09T09:05:00"));
  const val = await runTickSample(env, tp, async () => { throw new Error("boom"); });
  chk("例外仍寫一筆", puts.length === 1 && puts[0][0] === "tick:20260909:0905", JSON.stringify(puts.map((p) => p[0])));
  chk("st=0 代表 fetch 例外", val.st === 0, String(val.st));
  chk("err 記下訊息", val.err === "boom", String(val.err));
  chk("摘要為空樣本（n:0）", val.n === 0 && val.tk === null, JSON.stringify(val));
}

// ---- runTickSample：HTTP 非 200 記真實 status（與 fetch 例外分得開）----
{
  const puts = [];
  const env = { FINMIND_TOKEN: "TK", FLOW_KV: { put: async (k, v) => { puts.push([k, v]); } } };
  const tp = taipeiParts(tpe("2026-09-09T09:10:00"));
  const val = await runTickSample(env, tp,
    async () => new Response(JSON.stringify({ msg: "rate limit" }), { status: 402 }));
  chk("HTTP 402 記 st=402（不是 0）", val.st === 402, String(val.st));
  chk("無 data 欄 → n:0 且不拋錯", val.n === 0 && !("err" in val), JSON.stringify(val));
  chk("非 200 仍寫一筆", puts.length === 1);
}

// ---- 鐵律 1：例外訊息**絕不可**把 FINMIND_TOKEN 帶進 KV（樣本活 7 天、/tickdiag 無認證對外）----
// 測試一律用明顯的假值，真 token 不進 repo。
const FAKE = "FAKE_TOKEN_FOR_TEST_abcdef0123456789";
{
  // maskTickErr 純函式層
  chk("遮罩：訊息含 token 字面量 → 不得殘留",
    !maskTickErr(`fetch failed: https://api.finmindtrade.com/api/v4/data?dataset=X&token=${FAKE}`, FAKE)
      .includes(FAKE));
  chk("遮罩：token= 之後的內容一律遮掉（即使 token 參數對不上，例如百分比編碼後）",
    !maskTickErr("Network connection lost: https://a.b/c?d=1&token=%41%42%43xyz&e=2", "ZZZZZZZZ")
      .includes("%41%42%43xyz"));
  chk("遮罩：token= 後面接 & 時只吃到分隔符為止（其餘參數保留，訊息仍可讀）",
    maskTickErr("https://a.b/c?dataset=TaiwanFuturesTick&token=abcdef&start_date=2026-09-09", "abcdef")
      .includes("start_date=2026-09-09"));
  // ★ token 為空／undefined／過短時不得走 split 路徑（"".split("") 會把訊息炸成逐字元）
  for (const [name, tk] of [["undefined", undefined], ["null", null], ["空字串", ""], ["過短", "ab"]]) {
    const out = maskTickErr("boom happened", tk);
    chk(`遮罩：token 為 ${name} 時訊息不得被毀`, out === "boom happened", JSON.stringify(out));
  }
  // 迴歸：2026-09-09 覆驗構造出的半遮反例——token 同時含「會被百分比編碼的字元」（使 ① 失效）
  // 與「原本被當成停止字元的 ' 或 )」（使 ② 提前停下）。停止字元收窄到 &/空白後全部遮乾淨。
  for (const t of ["ab)cd/ef_TAIL", "ab'cd/ef_TAIL", "ab(cd)ef/gh_TAIL"]) {
    const url = `https://api.x/v4/data?dataset=T&token=${encodeURIComponent(t)}&start_date=2026-09-09`;
    chk(`★ 遮罩反例（token 含 ')' 或 "'" ＋需編碼字元）：${t}`,
      !maskTickErr(`fetch failed: ${url}`, t).includes("TAIL"), maskTickErr(`fetch failed: ${url}`, t));
  }
  chk("遮罩：非字串輸入不拋錯", maskTickErr(null, FAKE) === "" && maskTickErr(undefined, FAKE) === "");
  chk("遮罩：超長訊息截到 300 字元", maskTickErr("x".repeat(5000), FAKE).length === 300);

  // 端到端：注入一個 message 內含假 token 的例外，斷言**寫進 KV 的值**不含該字串
  const puts = [];
  const env = { FINMIND_TOKEN: FAKE, FLOW_KV: { put: async (k, v, o) => { puts.push([k, v, o]); } } };
  const tp = taipeiParts(tpe("2026-09-09T11:00:00"));
  const val = await runTickSample(env, tp, async (u) => {
    // 模擬 workerd 的 fetch 例外會帶上請求 URL（cloudflare/workerd #1957）
    throw new TypeError(`Network connection lost while fetching ${u}`);
  });
  chk("端到端：確實寫了一筆", puts.length === 1 && puts[0][0] === "tick:20260909:1100",
    JSON.stringify(puts.map((p) => p[0])));
  chk("★ 寫進 KV 的整串字串不含 token", !puts[0][1].includes(FAKE),
    puts[0][1].slice(0, 200));
  chk("★ 回傳值的 err 不含 token", !String(val.err).includes(FAKE), String(val.err));
  chk("遮罩後仍看得出是哪一類例外（err 保留可讀訊息）",
    val.err.includes("Network connection lost") && val.err.includes("<token>"), String(val.err));
  chk("ern 記例外類別名", val.ern === "TypeError", String(val.ern));
  chk("fetch 例外仍 st=0", val.st === 0, String(val.st));
}

// ---- 尺寸閘門：payload 過大時跳過 JSON.parse（量測班不能把 Worker 打爆）----
{
  chk("TICK_MAX_PARSE_BYTES = 20e6", TICK_MAX_PARSE_BYTES === 20e6, String(TICK_MAX_PARSE_BYTES));
  const puts = [];
  const env = { FINMIND_TOKEN: FAKE, FLOW_KV: { put: async (k, v, o) => { puts.push([k, v, o]); } } };
  const tp = taipeiParts(tpe("2026-09-09T14:00:00"));
  // ── 第一關：上游有給 content-length，**在讀 body 之前**就短路 ──
  // 這一關才是真的擋 OOM 的那道：真會打爆 isolate 的檔在 `.text()` 當下就爆了，
  // 事後用 text.length 判等於沒判。所以這裡要斷言「body 從頭到尾沒被讀過」。
  // 偵測面必須涵蓋**所有**讀 body 的方法，不能只包 `r.text`（2026-09-10 覆驗發現的假通過：
  // 舊版只包 `r.text`，於是把閘門改成先 `await r.arrayBuffer()`／`r.json()`／`r.clone().text()`
  // ——把這關要防的事原封做一遍——**★ 那條斷言三次都照樣 pass**，完全沒有牙齒。
  // 這條是被 ★ 標記、CLAUDE.md 稱為「才是真的擋 OOM 的那道」的核心斷言）。
  // **2026-09-11 更正**：本註解初稿寫「140 條測試照樣全綠」，那句**只對 `clone().text()` 成立**。
  // 拿 `a7f5f5e` 的舊測試檔實跑三個突變：`arrayBuffer` 129/11 紅、`json` 125/15 紅、
  // `clone().text()` 140/0 **真的全綠**。前兩者是被旁證斷言（「非 ASCII 時 bytes 是字元數」、
  // 「text 閘門：bytes 照記」）擋下來的，**不是 ★ 這條擋的**。
  // 兩件事要分開講：**單一斷言無牙**（三個變體皆為真）vs **整包會不會全綠**（只有一個變體為真）。
  // 修補本身正確且必要，錯的是初稿舉證的那句話——把偵測缺口說得比實際更大。
  // `r.body` 也要換掉：`getReader()` 同樣讀得到 body，只留 `cancel` 不記錄（那是本關該做的事）。
  // 註：不可改用 ReadableStream 的 `pull` 當探針——Node/undici 在 `new Response(stream)` 當下
  // 就會 pull，量到的是 mock 的假象、不是程式行為（覆驗實測）。
  const bodyReads = [];
  const bigRes = () => {
    const r = new Response("x".repeat(1000), {
      headers: { "content-length": String(TICK_MAX_PARSE_BYTES + 1) },
    });
    for (const m of ["text", "json", "arrayBuffer", "blob", "bytes", "clone"]) {
      if (typeof r[m] !== "function") continue;
      const orig = r[m].bind(r);
      r[m] = (...a) => { bodyReads.push(m); return orig(...a); };
    }
    Object.defineProperty(r, "body", {
      configurable: true,
      get: () => ({
        cancel: async () => {},                                   // 本關該做的事，不計入
        getReader: (...a) => { bodyReads.push("getReader"); return a; },
      }),
    });
    return r;
  };
  const val = await runTickSample(env, tp, async () => bigRes());
  chk("★ clen 閘門：body 從未被讀取（text/json/arrayBuffer/blob/bytes/clone/getReader 全零）",
    bodyReads.length === 0, JSON.stringify(bodyReads));
  chk("clen 閘門：skip='too-large:clen'", val.skip === "too-large:clen", String(val.skip));
  chk("★ clen 閘門：bytes 為 null（＝沒量到，不是 0＝回應是空的）", val.bytes === null, String(val.bytes));
  chk("clen 閘門：clen 照記", val.clen === TICK_MAX_PARSE_BYTES + 1, String(val.clen));
  chk("★ clen 閘門：n 為 null（＝未知列數，不是 0＝真的沒列）", val.n === null, String(val.n));
  chk("★ clen 閘門不是錯誤：不得寫 err／ern", !("err" in val) && !("ern" in val),
    JSON.stringify(val).slice(0, 200));
  chk("clen 閘門：st 仍是真實 HTTP status", val.st === 200, String(val.st));
  chk("clen 閘門：仍寫一筆 KV", puts.length === 1);
  chk("clen 閘門：KV 值同樣 n=null／bytes=null", (() => {
    const w = JSON.parse(puts[0][1]);
    return w.n === null && w.bytes === null && w.skip === "too-large:clen";
  })(), puts[0][1].slice(0, 200));

  // ── 第二關：上游沒給 content-length（chunked／被中介改寫）時的後備 ──
  const puts2 = [];
  const env2 = { FINMIND_TOKEN: FAKE, FLOW_KV: { put: async (k, v) => { puts2.push([k, v]); } } };
  const big = "x".repeat(TICK_MAX_PARSE_BYTES + 1);   // 刻意不是合法 JSON：真的 parse 就會拋錯
  const val2 = await runTickSample(env2, tp, async () => {
    const r = new Response(big);
    r.headers.delete("content-length");
    return r;
  });
  chk("text 閘門：clen 為 null（上游沒給）", val2.clen === null, String(val2.clen));
  chk("text 閘門：skip='too-large:text'", val2.skip === "too-large:text", String(val2.skip));
  chk("text 閘門：不 JSON.parse（餵不合法 JSON 也不進 catch → 無 err）", !("err" in val2),
    JSON.stringify(val2).slice(0, 200));
  chk("★ text 閘門：bytes 照記（body 已讀進來了，這關擋的是 parse）",
    val2.bytes === TICK_MAX_PARSE_BYTES + 1, String(val2.bytes));
  chk("★ text 閘門：n 為 null", val2.n === null, String(val2.n));
  chk("text 閘門：仍寫一筆 KV", puts2.length === 1);

  // 對照組：未超過門檻就照常 parse（證明上面的 skip 是門檻造成的，不是這條路徑本來就不 parse）
  const okVal = await runTickSample({ FINMIND_TOKEN: FAKE, FLOW_KV: { put: async () => {} } }, tp,
    async () => new Response(JSON.stringify({ data: [{ time: "13:50:00" }] })));
  chk("未超過門檻：照常 parse（n 為數字、無 skip）", okVal.n === 1 && !("skip" in okVal),
    JSON.stringify(okVal));
}

// ---- clen：有 content-length 才記，沒有一律 null（不臆造）----
{
  const env = { FINMIND_TOKEN: FAKE, FLOW_KV: { put: async () => {} } };
  const tp = taipeiParts(tpe("2026-09-09T15:00:00"));
  const body = JSON.stringify({ data: [{ time: "13:50:00" }] });
  const a = await runTickSample(env, tp, async () =>
    new Response(body, { headers: { "content-length": String(body.length) } }));
  chk("clen 有標頭就轉數字", a.clen === body.length, String(a.clen));
  chk("全 ASCII 時 clen === bytes（假設成立的驗證方式）", a.clen === a.bytes, `${a.clen}/${a.bytes}`);
  const b = await runTickSample(env, tp, async () => {
    const r = new Response(body);
    r.headers.delete("content-length");
    return r;
  });
  chk("無 content-length → clen 為 null（不臆造）", b.clen === null, String(b.clen));
  const c = await runTickSample(env, tp, async () =>
    new Response(body, { headers: { "content-length": "not-a-number" } }));
  chk("content-length 不是數字 → clen 為 null", c.clen === null, String(c.clen));
  // 非 ASCII：bytes（UTF-16 字元數）會低估真實位元組數——註解那條「假設」的反證
  const zh = JSON.stringify({ msg: "額度不足，請稍後再試", data: [] });
  const d = await runTickSample(env, tp, async () => new Response(zh, { status: 402 }));
  chk("非 ASCII 時 bytes 是字元數、確實小於 UTF-8 位元組數",
    d.bytes === zh.length && d.bytes < new TextEncoder().encode(zh).length,
    `${d.bytes} < ${new TextEncoder().encode(zh).length}`);
}

// ---- runTickSample：程式端二次守門（週末／時窗外／缺 token 或 KV 一律不採樣、不寫 KV）----
{
  const mk = () => { const puts = []; return [{ FINMIND_TOKEN: "TK",
    FLOW_KV: { put: async () => { puts.push(1); } } }, puts]; };
  const fetchFn = async () => new Response(JSON.stringify({ data: [] }));
  for (const [name, iso] of [["週六 10:00", "2026-09-12T10:00:00"], ["週日 10:00", "2026-09-13T10:00:00"]]) {
    const [env, puts] = mk();
    const r = await runTickSample(env, taipeiParts(tpe(iso)), fetchFn);
    chk(`守門：${name} 不採樣`, r === null && puts.length === 0);
  }
  // 2026-09-12 是週六、09-13 週日、09-09 週三
  for (const [name, iso] of [["08:55 窗前", "2026-09-09T08:55:00"], ["20:00 窗後", "2026-09-09T20:00:00"],
    ["23:30 窗後", "2026-09-09T23:30:00"]]) {
    const [env, puts] = mk();
    const r = await runTickSample(env, taipeiParts(tpe(iso)), fetchFn);
    chk(`守門：${name} 不採樣`, r === null && puts.length === 0);
  }
  const [envA, putsA] = mk();
  chk("守門：09:00 整點在窗內", (await runTickSample(envA, taipeiParts(tpe("2026-09-09T09:00:00")), fetchFn)) !== null
    && putsA.length === 1);
  const [envB, putsB] = mk();
  chk("守門：19:55 在窗內", (await runTickSample(envB, taipeiParts(tpe("2026-09-09T19:55:00")), fetchFn)) !== null
    && putsB.length === 1);
  let called = 0;
  const cnt = async () => { called += 1; return new Response(JSON.stringify({ data: [] })); };
  chk("守門：缺 FINMIND_TOKEN → return，且不打 FinMind",
    (await runTickSample({ FLOW_KV: { put: async () => {} } }, taipeiParts(tpe("2026-09-09T10:00:00")), cnt)) === null
    && called === 0);
  chk("守門：缺 FLOW_KV → return",
    (await runTickSample({ FINMIND_TOKEN: "TK" }, taipeiParts(tpe("2026-09-09T10:00:00")), cnt)) === null
    && called === 0);
}

// ---- /tickdiag：唯讀、零 KV put、只回實際存在的樣本 ----
// 取新模組實例的理由同 test/livediag.mjs：節流計數 diagQuota 是模組層 in-isolate 變數，
// 同一實例下 30 秒內第二次必被短路，那樣「零 put」只是沒跑到的假通過。
{
  const store = {
    "tick:20260909:0900": { at: 1, st: 200, ms: 120, bytes: 1000, n: 5, seg: { a: 5, b: 0, c: 0 }, d13: 0 },
    "tick:20260909:1350": { at: 2, st: 200, ms: 130, bytes: 2000, n: 9, seg: { a: 5, b: 4, c: 0 }, d13: 2 },
  };
  let puts = 0, gets = 0, listCalls = 0;
  const env = { FLOW_KV: {
    get: async (k) => { gets += 1; return store[k] || null; },
    put: async () => { puts += 1; },
    list: async () => { listCalls += 1; return { keys: [] }; },
  } };
  const fresh = (await import(`../src/index.js?isolate=tickdiag-${Date.now()}`)).default;
  const res = await (await fresh.fetch(new Request("https://w.invalid/tickdiag?date=2026-09-09"),
    env, { waitUntil: () => {} })).json();
  chk("前置：未被節流、確實跑完主體", res.schema === 1 && res.date === "2026-09-09",
    JSON.stringify(res).slice(0, 160));
  chk("slots=132、只回實際存在的樣本", res.slots === 132 && res.n === 2 && res.samples.length === 2,
    JSON.stringify({ slots: res.slots, n: res.n }));
  chk("樣本帶 hm 且依時點排序", res.samples[0].hm === "0900" && res.samples[1].hm === "1350",
    JSON.stringify(res.samples.map((s) => s.hm)));
  chk("樣本內容原樣吐出", res.samples[1].d13 === 2 && res.samples[1].bytes === 2000,
    JSON.stringify(res.samples[1]));
  chk("/tickdiag 全程零 KV put", puts === 0, `puts=${puts}`);
  chk("/tickdiag 不用 KV list", listCalls === 0, `list=${listCalls}`);
  chk("132 個時點各一次 get（無讀-改-寫索引）", gets === 132, `gets=${gets}`);
}

// ---- /tickdiag：非法 date 靜默退回台北今日；單把 get 失敗只讓該時點缺席 ----
{
  const today = taipeiParts().date;
  const key = tickSampleKey(today, "0900");
  const env = { FLOW_KV: {
    get: async (k) => { if (k === key) return { at: 1, st: 200, n: 3 }; throw new Error("kv boom"); },
    put: async () => { throw new Error("不該被呼叫"); },
  } };
  const fresh = (await import(`../src/index.js?isolate=tickdiag-bad-${Date.now()}`)).default;
  const res = await (await fresh.fetch(new Request("https://w.invalid/tickdiag?date=not-a-date"),
    env, { waitUntil: () => {} })).json();
  chk("非法 date → 退回台北今日", res.date === today, `${res.date} vs ${today}`);
  chk("其餘時點 get 拋錯不整包失敗，只該時點有樣本", res.n === 1 && res.samples[0].hm === "0900",
    JSON.stringify(res).slice(0, 200));
}

// ---- /tickdiag：沿用既有 diagThrottle（30 秒 gap）----
{
  const env = { FLOW_KV: { get: async () => null, put: async () => { throw new Error("不該被呼叫"); } } };
  const fresh = (await import(`../src/index.js?isolate=tickdiag-throttle-${Date.now()}`)).default;
  const one = await (await fresh.fetch(new Request("https://w.invalid/tickdiag"), env,
    { waitUntil: () => {} })).json();
  chk("節流 第一次通過", one.schema === 1, JSON.stringify(one).slice(0, 120));
  const two = await (await fresh.fetch(new Request("https://w.invalid/tickdiag"), env,
    { waitUntil: () => {} })).json();
  chk("節流 30 秒內第二次被擋", two.error === "診斷路徑節流中" && two.reason === "too_frequent",
    JSON.stringify(two));
  // 同一實例下 /livediag 與 /tickdiag 共用同一組計數（刻意：同一條唯讀診斷額度）
  const three = await (await fresh.fetch(new Request("https://w.invalid/livediag"), env,
    { waitUntil: () => {} })).json();
  chk("節流 與 /livediag 共用計數", three.error === "診斷路徑節流中", JSON.stringify(three).slice(0, 120));
}

// ================= 逾時（2026-09-13 新增）=================
// 為什麼每一條都要自帶 watchdog：這批要證明的是「不會掛住」。如果直接 await 受測函式，
// 迴歸（把 timeout 拿掉）的表現會是**測試永遠跑不完**——那不是紅，是掛住，CI 只會 timeout
// 而看不出是哪一條。所以一律 race 一個 2 秒的 watchdog：迴歸時得到 "HUNG"，斷言正常變紅。
const HUNG = Symbol("HUNG");
const raceHung = (p, ms = 2000) =>
  Promise.race([p, new Promise((r) => setTimeout(() => r(HUNG), ms))]);
const never = () => new Promise(() => {});          // 永不 resolve、也不掛 timer
// 迴歸時 val 會是 HUNG（Symbol），JSON.stringify 回 undefined → 細節字串炸掉會把「紅」變成
// 「crash」，後面的斷言就跑不到了。統一走這支安全格式化，確保迴歸看得到完整紅字。
const shw = (v) => (v === HUNG ? "HUNG" : (JSON.stringify(v) ?? String(v)));

{
  chk("逾時常數：fetch/body 45 秒、cancel 5 秒",
    TICK_FETCH_TIMEOUT_MS === 45000 && TICK_BODY_TIMEOUT_MS === 45000 && TICK_CANCEL_TIMEOUT_MS === 5000,
    `${TICK_FETCH_TIMEOUT_MS}/${TICK_BODY_TIMEOUT_MS}/${TICK_CANCEL_TIMEOUT_MS}`);
  chk("逾時常數：KV put／alert 各 10 秒（2026-09-13 覆驗退回後補）",
    TICK_KV_TIMEOUT_MS === 10000 && TICK_ALERT_TIMEOUT_MS === 10000,
    `${TICK_KV_TIMEOUT_MS}/${TICK_ALERT_TIMEOUT_MS}`);
  // 門檻必須遠小於 cron 間隔 300 秒（掛住的那一格不可以壓到下一格）。
  // **五個都要算進來**：原本只算三段，正是「漏掉 put 與 alert」那個錯的一部分。
  const worst = (TICK_FETCH_TIMEOUT_MS + TICK_BODY_TIMEOUT_MS + TICK_CANCEL_TIMEOUT_MS
    + TICK_KV_TIMEOUT_MS + TICK_ALERT_TIMEOUT_MS) / 1000;
  chk("五段最壞總和 < cron 間隔 300 秒", worst < 300, String(worst));
  chk("逾時例外類別名常數", TICK_TIMEOUT_NAME === "TickTimeout", TICK_TIMEOUT_NAME);
}

// ---- tickWithTimeout 純函式：正常放行 / 逾時拋 TickTimeout / 原例外原樣穿過 ----
{
  chk("tickWithTimeout：p 先 resolve 就原值回傳",
    (await raceHung(tickWithTimeout(Promise.resolve(7), 1000, "x"))) === 7);
  let e1 = null;
  try { await raceHung(tickWithTimeout(never(), 20, "fetch")); } catch (e) { e1 = e; }
  chk("tickWithTimeout：永不 resolve → 拋出且 name=TickTimeout", e1 && e1.name === TICK_TIMEOUT_NAME,
    String(e1 && e1.name));
  chk("tickWithTimeout：訊息帶階段名與毫秒數（供 err 分辨階段）",
    e1 && e1.message.includes("fetch") && e1.message.includes("20"), String(e1 && e1.message));
  chk("★ 逾時訊息不含 URL／token 之類的東西（樣本活 7 天、/tickdiag 無認證）",
    e1 && !/https?:|token/i.test(e1.message), String(e1 && e1.message));
  let e2 = null;
  try { await raceHung(tickWithTimeout(Promise.reject(new TypeError("boom")), 1000, "x")); } catch (e) { e2 = e; }
  chk("tickWithTimeout：p 自己的例外原樣穿過（不被改寫成逾時）",
    e2 && e2.name === "TypeError" && e2.message === "boom", String(e2));
  // timer 必須清掉：沒清的話 node 會被吊著、workerd 也可能多留著 invocation。
  // 這裡以「process 沒有殘留 timer 也能跑完後續測試」間接驗；直接證據是原始碼裡的 clearTimeout。
  chk("tickWithTimeout 原始碼有 clearTimeout（未清的 timer 會把 invocation 多吊著）",
    SRC.includes("finally(() => { if (timer !== null) clearTimeout(timer); })"));
}

// ---- ★ J-1：fetchFn 永不 resolve → 門檻後仍寫得出樣本，且帶得出成因 ----
{
  const puts = [];
  const env = { FINMIND_TOKEN: FAKE, FLOW_KV: { put: async (k, v, o) => { puts.push([k, v, o]); } } };
  const tp = taipeiParts(tpe("2026-09-09T10:00:00"));
  const val = await raceHung(runTickSample(env, tp, () => never(), { fetchMs: 20 }));
  chk("★ fetch 永不 resolve：runTickSample 仍會回來（不是 HUNG）", val !== HUNG, String(val === HUNG));
  chk("★ fetch 逾時：照樣寫一筆 KV（「樣本缺席」與「cron 沒醒」必須分得出來）",
    puts.length === 1 && puts[0][0] === "tick:20260909:1000", JSON.stringify(puts.map((p) => p[0])));
  chk("fetch 逾時：ern=TickTimeout（與其他例外分得開）", val !== HUNG && val.ern === TICK_TIMEOUT_NAME,
    shw(val && val.ern));
  chk("fetch 逾時：err 帶得出階段", val !== HUNG && String(val.err).includes("fetch"),
    shw(val && val.err));
  chk("fetch 逾時：st 維持 0（還沒拿到 status，與 fetch 本身例外同一類）",
    val !== HUNG && val.st === 0, shw(val && val.st));
  chk("fetch 逾時：bytes／clen 維持 null（沒量到，不是 0）",
    val !== HUNG && val.bytes === null && val.clen === null, shw(val).slice(0, 160));
  chk("fetch 逾時：KV 值與回傳值一致", puts.length === 1 && eq(JSON.parse(puts[0][1]), val));
  chk("★ 逾時樣本不含 token", puts.length === 1 && !puts[0][1].includes(FAKE));
}

// ---- ★ J-2：r.text() 永不 resolve（標頭已到、卡在讀 body）----
{
  const puts = [];
  const env = { FINMIND_TOKEN: FAKE, FLOW_KV: { put: async (k, v, o) => { puts.push([k, v, o]); } } };
  const tp = taipeiParts(tpe("2026-09-09T10:05:00"));
  const val = await raceHung(runTickSample(env, tp, async () => {
    const r = new Response("{}", { status: 200 });
    r.text = () => never();
    return r;
  }, { bodyMs: 20 }));
  chk("★ r.text() 永不 resolve：runTickSample 仍會回來", val !== HUNG);
  chk("★ body 逾時：照樣寫一筆 KV", puts.length === 1 && puts[0][0] === "tick:20260909:1005",
    JSON.stringify(puts.map((p) => p[0])));
  chk("body 逾時：ern=TickTimeout", val !== HUNG && val.ern === TICK_TIMEOUT_NAME, shw(val && val.ern));
  chk("body 逾時：err 帶得出階段是 body（不是 fetch）",
    val !== HUNG && String(val.err).includes("body") && !String(val.err).includes("fetch"),
    shw(val && val.err));
  chk("★ body 逾時：st 是**真實 HTTP status**（標頭已到），刻意不硬寫回 0",
    val !== HUNG && val.st === 200, shw(val && val.st));
  chk("body 逾時：bytes 仍 null（body 從沒讀成字串）", val !== HUNG && val.bytes === null,
    shw(val && val.bytes));
}

// ---- ★ J-3：r.body.cancel() 永不 resolve（覆驗實測會掛住的就是這一條）----
{
  const puts = [];
  const env = { FINMIND_TOKEN: FAKE, FLOW_KV: { put: async (k, v, o) => { puts.push([k, v, o]); } } };
  const tp = taipeiParts(tpe("2026-09-09T10:10:00"));
  const bodyReads = [];
  const val = await raceHung(runTickSample(env, tp, async () => {
    const r = new Response("x".repeat(10), {
      headers: { "content-length": String(TICK_MAX_PARSE_BYTES + 1) },
    });
    for (const m of ["text", "json", "arrayBuffer", "blob", "bytes", "clone"]) {
      if (typeof r[m] !== "function") continue;
      const orig = r[m].bind(r);
      r[m] = (...a) => { bodyReads.push(m); return orig(...a); };
    }
    Object.defineProperty(r, "body", {
      configurable: true,
      get: () => ({
        cancel: () => never(),                                    // ★ 就是這一條會掛住
        getReader: (...a) => { bodyReads.push("getReader"); return a; },
      }),
    });
    return r;
  }, { cancelMs: 20 }));
  chk("★ r.body.cancel() 永不 resolve：runTickSample 仍會回來（不是 HUNG）", val !== HUNG);
  chk("★ cancel 逾時：照樣寫一筆 KV", puts.length === 1 && puts[0][0] === "tick:20260909:1010",
    JSON.stringify(puts.map((p) => p[0])));
  chk("cancel 逾時：樣本仍是 clen 閘門的正常形狀（skip／n／bytes 不變）",
    val !== HUNG && val.skip === "too-large:clen" && val.n === null && val.bytes === null,
    shw(val).slice(0, 200));
  chk("★ cancel 逾時不算抓失敗：不得寫 err／ern", val !== HUNG && !("err" in val) && !("ern" in val),
    shw(val).slice(0, 200));
  chk("★ cancel 逾時仍留痕跡：cx=TickTimeout（「無妨」不等於「完全不留痕跡」）",
    val !== HUNG && val.cx === TICK_TIMEOUT_NAME, shw(val && val.cx));
  chk("cancel 逾時：body 仍從未被讀取（閘門該做的事沒被破壞）",
    bodyReads.length === 0, JSON.stringify(bodyReads));
  chk("cancel 逾時：KV 值與回傳值一致", puts.length === 1 && eq(JSON.parse(puts[0][1]), val));
}

// ---- ★ J-4：env.FLOW_KV.put() 永不 resolve（本批第一版**漏掉**的那一個）----
// 這一條是覆驗退回的要害：put 掛住 → **樣本寫不出去**，正是這批宣稱要治的失效模式本身。
{
  let putCalls = 0;
  const env = { FINMIND_TOKEN: FAKE, FLOW_KV: { put: () => { putCalls++; return never(); } } };
  const tp = taipeiParts(tpe("2026-09-09T11:00:00"));
  const val = await raceHung(runTickSample(env, tp,
    async () => new Response(JSON.stringify({ data: [{ time: "13:50:00" }] })), { kvMs: 20 }));
  chk("★ FLOW_KV.put 永不 resolve：runTickSample 仍會回來（不是 HUNG）", val !== HUNG,
    String(val === HUNG));
  chk("put 確實被呼叫過（證明不是「根本沒走到」的假通過）", putCalls === 1, String(putCalls));
  chk("★ put 逾時留下 kx=TickTimeout（語意＝『這次沒等到寫入確認』，不是『沒寫入』）",
    val !== HUNG && val.kx === TICK_TIMEOUT_NAME, shw(val && val.kx));
  chk("put 逾時**不算抓失敗**：不得寫 err／ern（那兩欄是上游抓取階段的）",
    val !== HUNG && !("err" in val) && !("ern" in val), shw(val).slice(0, 200));
  chk("put 逾時：量測欄位不被寫入結果污染（n／st 照常）",
    val !== HUNG && val.n === 1 && val.st === 200, shw(val).slice(0, 200));
}

// ---- put 直接拋例外（不是掛住）：一樣記 kx，且不得讓整支 reject ----
{
  const env = { FINMIND_TOKEN: FAKE, FLOW_KV: { put: async () => { throw new TypeError("kv down"); } } };
  let threw = null;
  const val = await raceHung(runTickSample(env, taipeiParts(tpe("2026-09-09T11:05:00")),
    async () => new Response(JSON.stringify({ data: [] }))).catch((e) => { threw = e; return "REJECTED"; }));
  chk("put 拋例外：不得讓 runTickSample reject（本函式立場是失敗一律吞掉）",
    threw === null && val !== "REJECTED" && val !== HUNG, String(threw));
  chk("put 拋例外：kx 記原例外類別名（與逾時的 TickTimeout 分得開）",
    val !== HUNG && val.kx === "TypeError", shw(val && val.kx));
}

// ---- ★ J-5：alertJob 永不 resolve（本批**自己新增**的那個 await）----
// alertJob 自帶 try/catch，擋得住「拋出」，擋不住「永不 resolve」——不包就是自己種一個掛住點。
{
  const puts = [];
  const env = { FINMIND_TOKEN: FAKE, ALERT_WEBHOOK: "https://hook.invalid/x",
    FLOW_KV: { get: async () => null, put: async (k) => { puts.push(k); } } };
  const tp = taipeiParts(tpe("2026-10-09T09:00:00"));   // 到期日的當日第一格
  const val = await raceHung(runTickSample(env, tp, (u) => {
    if (String(u).includes("hook.invalid")) return never();          // ★ 告警通道掛住
    return Promise.resolve(new Response(JSON.stringify({ data: [{ time: "13:50:00" }] })));
  }, { alertMs: 20 }));
  chk("★ alertJob 永不 resolve：runTickSample 仍會回來（不是 HUNG）", val !== HUNG,
    String(val === HUNG));
  chk("★ 告警掛住之前樣本已經落地（順序的價值就在這裡）",
    puts.includes("tick:20261009:0900"), JSON.stringify(puts));
  chk("alert 逾時留下 ax=TickTimeout", val !== HUNG && val.ax === TICK_TIMEOUT_NAME,
    shw(val && val.ax));
  chk("alert 逾時不得污染樣本欄位（不寫 err／ern／kx）",
    val !== HUNG && !("err" in val) && !("ern" in val) && !("kx" in val), shw(val).slice(0, 200));
  chk("alert 掛住時去重鍵未寫（下一個平日還會再提醒）",
    !puts.some((k) => k.startsWith("alerted:")), JSON.stringify(puts));
}

// ---- 對照組：正常路徑不得出現假逾時、也不得多出 cx 欄 ----
{
  const val = await raceHung(runTickSample({ FINMIND_TOKEN: FAKE, FLOW_KV: { put: async () => {} } },
    taipeiParts(tpe("2026-09-09T10:15:00")),
    async () => new Response(JSON.stringify({ data: [{ time: "13:50:00" }] }))));
  chk("正常路徑：無 err／ern／cx／kx／ax（證明上面幾條的欄位是逾時造成的）",
    val !== HUNG && !("err" in val) && !("ern" in val) && !("cx" in val)
    && !("kx" in val) && !("ax" in val), shw(val));
  chk("正常路徑：n 照常", val !== HUNG && val.n === 1, shw(val));
  // cancel 正常 resolve 時也不得留 cx
  const val2 = await raceHung(runTickSample({ FINMIND_TOKEN: FAKE, FLOW_KV: { put: async () => {} } },
    taipeiParts(tpe("2026-09-09T10:20:00")), async () => {
      const r = new Response("x", { headers: { "content-length": String(TICK_MAX_PARSE_BYTES + 1) } });
      Object.defineProperty(r, "body", { configurable: true, get: () => ({ cancel: async () => {} }) });
      return r;
    }));
  chk("clen 閘門 + cancel 正常：不得留 cx", val2 !== HUNG && !("cx" in val2), shw(val2));
}

// ---- 生產呼叫不帶 opts 時，三個門檻走常數（不是 undefined → setTimeout(…, undefined)）----
{
  chk("opts 省略時門檻回落常數（原始碼以 != null 判，0 也能被覆寫）",
    SRC.includes("opts.fetchMs != null ? opts.fetchMs : TICK_FETCH_TIMEOUT_MS")
    && SRC.includes("opts.bodyMs != null ? opts.bodyMs : TICK_BODY_TIMEOUT_MS")
    && SRC.includes("opts.cancelMs != null ? opts.cancelMs : TICK_CANCEL_TIMEOUT_MS")
    && SRC.includes("opts.kvMs != null ? opts.kvMs : TICK_KV_TIMEOUT_MS")
    && SRC.includes("opts.alertMs != null ? opts.alertMs : TICK_ALERT_TIMEOUT_MS"));
  chk("生產呼叫端仍是 runTickSample(env, tp)（沒被本批改成帶 opts）",
    SRC.includes("ctx.waitUntil(runTickSample(env, tp)"));
}

// ================= 拆除提醒（2026-09-13 新增）=================
// ---- 純函式：日曆日齡與到期判定 ----
{
  chk("TICK_SAMPLE_SINCE = 本班上線日", TICK_SAMPLE_SINCE === "2026-09-09", TICK_SAMPLE_SINCE);
  chk("TICK_TEARDOWN_DUE_DAYS = 30 日曆日（≈21 交易日）", TICK_TEARDOWN_DUE_DAYS === 30,
    String(TICK_TEARDOWN_DUE_DAYS));
  chk("tickAgeDays：同日為 0", tickAgeDays("2026-09-09") === 0, String(tickAgeDays("2026-09-09")));
  chk("tickAgeDays：跨月正確", tickAgeDays("2026-10-09") === 30, String(tickAgeDays("2026-10-09")));
  chk("tickAgeDays：早於 since 為負", tickAgeDays("2026-09-08") === -1, String(tickAgeDays("2026-09-08")));
  for (const bad of ["not-a-date", "", null, undefined, "2026-13-99"]) {
    chk(`tickAgeDays：解不出日期回 null（${JSON.stringify(bad)}）`, tickAgeDays(bad) === null,
      String(tickAgeDays(bad)));
  }
  chk("tickTeardownDue：第 29 天未到期", tickTeardownDue("2026-10-08") === false);
  chk("tickTeardownDue：第 30 天到期（下界含）", tickTeardownDue("2026-10-09") === true);
  chk("tickTeardownDue：第 31 天仍到期", tickTeardownDue("2026-10-10") === true);
  chk("★ tickTeardownDue：age 算不出來時**不**判到期（寧可不提醒，也不用算不出的值發告警）",
    tickTeardownDue("not-a-date") === false, String(tickTeardownDue("not-a-date")));
}

// ---- runTickSample：到期時每天最多一則告警，且**不 dispatch、不碰其他班** ----
{
  // 2026-10-09 是週五（2026-09-09 週三 + 30 天），距上線 30 日曆日 → 到期
  const mkEnv = (extra = {}) => {
    const kv = {};
    const puts = [];
    return [{ FINMIND_TOKEN: FAKE, ALERT_WEBHOOK: "https://hook.invalid/x", ...extra,
      FLOW_KV: {
        get: async (k) => (k in kv ? kv[k] : null),
        put: async (k, v, o) => { kv[k] = v; puts.push([k, v, o]); },
      } }, puts, kv];
  };
  const calls = [];
  const bodies = [];
  const fetchFn = async (u, init) => {
    calls.push(String(u));
    if (init && init.body) bodies.push(String(init.body));
    if (String(u).includes("finmind")) return new Response(JSON.stringify({ data: [{ time: "13:50:00" }] }));
    return new Response("ok", { status: 200 });
  };

  const [env, puts] = mkEnv();
  const tpDue = taipeiParts(tpe("2026-10-09T09:00:00"));   // 當日第一格
  await raceHung(runTickSample(env, tpDue, fetchFn));
  chk("到期：樣本照寫", puts.some(([k]) => k === "tick:20261009:0900"), JSON.stringify(puts.map((p) => p[0])));
  chk("到期：發出一則告警（走既有 sendAlert 通道）",
    calls.some((u) => u.includes("hook.invalid")), JSON.stringify(calls));
  chk("到期：寫下 alertJob 的當日去重鍵", puts.some(([k]) => k.startsWith("alerted:") && k.includes("tick-teardown-due")),
    JSON.stringify(puts.map((p) => p[0])));
  chk("★ 到期告警**不 dispatch**（不得出現 GitHub Actions 端點）",
    !calls.some((u) => u.includes("api.github.com")), JSON.stringify(calls));
  chk("告警文字說得出天數、暫時班身分與下一步（不是一句沒資訊的『到期了』）",
    bodies.length === 1 && bodies[0].includes("30") && bodies[0].includes("暫時班")
    && bodies[0].includes("/tickdiag"), bodies[0] ? bodies[0].slice(0, 160) : "(無 body)");
  chk("★ 告警文字不含 token", bodies.every((b) => !b.includes(FAKE)));

  // 同日第二次（下一格）：不得再評估、也不得再發
  const before = calls.length;
  await raceHung(runTickSample(env, taipeiParts(tpe("2026-10-09T09:05:00")), fetchFn));
  chk("同日第二格：只打 FinMind、不再告警", calls.slice(before).every((u) => u.includes("finmind")),
    JSON.stringify(calls.slice(before)));
  // ★ 上一條**證不了第一格守門**：即使把守門拿掉，alertJob 的 KV 去重也會擋下第二則，
  // 它照樣會綠（實測突變「每格都評估」→ 207/0 全綠，是假通過）。要驗守門本身，必須用
  // **乾淨的 env**（沒有去重鍵可依靠）從非第一格進來——守門若失效，這裡就會發出告警。
  const [envMid, , kvMid] = mkEnv();
  const callsMid = [];
  const fetchMid = async (u, init) => {
    callsMid.push(String(u));
    if (String(u).includes("finmind")) return new Response(JSON.stringify({ data: [] }));
    return new Response("ok", { status: 200 });
  };
  await raceHung(runTickSample(envMid, taipeiParts(tpe("2026-10-09T09:05:00")), fetchMid));
  chk("★ 非第一格 + 乾淨 env（無去重鍵可依靠）：根本不評估，不得告警",
    callsMid.every((u) => u.includes("finmind")), JSON.stringify(callsMid));
  chk("★ 非第一格 + 乾淨 env：不得寫下去重鍵",
    !Object.keys(kvMid).some((k) => k.startsWith("alerted:")), JSON.stringify(Object.keys(kvMid)));
  // 同一天的非第一「小時」也一樣（守門同時看 hour 與 minute）
  const [envHr, , kvHr] = mkEnv();
  const callsHr = [];
  await raceHung(runTickSample(envHr, taipeiParts(tpe("2026-10-09T14:00:00")),
    async (u) => { callsHr.push(String(u)); return new Response(JSON.stringify({ data: [] })); }));
  chk("★ 非第一小時的整點（14:00）+ 乾淨 env：不得告警",
    callsHr.every((u) => u.includes("finmind"))
    && !Object.keys(kvHr).some((k) => k.startsWith("alerted:")), JSON.stringify(callsHr));

  // 就算重跑第一格（重試／重放），alertJob 的 KV 去重也擋得住
  const before2 = calls.length;
  await raceHung(runTickSample(env, tpDue, fetchFn));
  chk("★ 重跑第一格：alertJob 的 alerted:<date>:<tag> 去重擋下第二則",
    calls.slice(before2).every((u) => u.includes("finmind")), JSON.stringify(calls.slice(before2)));

  // 未到期：完全不評估
  const [env2, puts2, kv2] = mkEnv();
  const calls2 = [];
  await raceHung(runTickSample(env2, taipeiParts(tpe("2026-09-09T09:00:00")),
    async (u) => { calls2.push(String(u)); return new Response(JSON.stringify({ data: [] })); }));
  chk("未到期：不告警、不寫去重鍵",
    !Object.keys(kv2).some((k) => k.startsWith("alerted:"))
    && calls2.every((u) => u.includes("finmind")), JSON.stringify(Object.keys(kv2)));
  chk("未到期：樣本照寫", puts2.some(([k]) => k === "tick:20260909:0900"));

  // ★ 已知限制 7 的教訓：通道未設時**不呼叫 alertJob**，不可把當天唯一那把去重鍵寫掉
  const [env3, , kv3] = mkEnv();
  delete env3.ALERT_WEBHOOK;
  const calls3 = [];
  await raceHung(runTickSample(env3, tpDue,
    async (u) => { calls3.push(String(u)); return new Response(JSON.stringify({ data: [] })); }));
  chk("★ 告警通道未設：不打任何告警請求", calls3.every((u) => u.includes("finmind")), JSON.stringify(calls3));
  chk("★ 告警通道未設：**不得**寫下去重鍵（否則當天唯一一次機會被白白用掉）",
    !Object.keys(kv3).some((k) => k.startsWith("alerted:")), JSON.stringify(Object.keys(kv3)));
  chk("告警通道未設：樣本仍照寫", Object.keys(kv3).some((k) => k.startsWith("tick:")),
    JSON.stringify(Object.keys(kv3)));

  // 告警本身爆掉也不可影響量測（樣本已經先寫了）
  const [env4] = mkEnv();
  const kv4keys = [];
  env4.FLOW_KV = { get: async () => null, put: async (k) => { kv4keys.push(k); } };
  const val4 = await raceHung(runTickSample(env4, tpDue, async (u) => {
    if (String(u).includes("hook.invalid")) throw new Error("alert channel down");
    return new Response(JSON.stringify({ data: [{ time: "13:50:00" }] }));
  }));
  chk("★ 告警通道爆掉：樣本仍寫成功、runTickSample 正常回傳",
    val4 !== HUNG && val4 && val4.n === 1 && kv4keys.includes("tick:20261009:0900"),
    JSON.stringify(kv4keys));
}

// ---- ★ 順序：樣本 KV put 必須排在「拆除到期評估」之前 ----
// 為什麼要單獨鎖這條：覆驗的突變 M6（把評估搬到 put 之前）讓 210 條測試**全綠**，也就是
// 這個順序當時零覆蓋。而順序正是本設計的重點——評估會打告警通道，通道一掛住（J-5）就會把
// 樣本一起拖住；「告警送不出去」是可接受的降級，「樣本缺席」不是（那正是本班要治的東西）。
// 用事件序列直接斷言，不靠「告警有沒有發」這種間接訊號。
{
  const events = [];
  const env = { FINMIND_TOKEN: FAKE, ALERT_WEBHOOK: "https://hook.invalid/x",
    FLOW_KV: {
      get: async (k) => { events.push(`get:${k}`); return null; },
      put: async (k) => { events.push(`put:${k}`); },
    } };
  const tp = taipeiParts(tpe("2026-10-09T09:00:00"));   // 到期日的當日第一格＝會評估、會告警
  await raceHung(runTickSample(env, tp, async (u) => {
    events.push(String(u).includes("hook.invalid") ? "fetch:alert" : "fetch:finmind");
    return new Response(JSON.stringify({ data: [{ time: "13:50:00" }] }));
  }));
  const iSample = events.indexOf("put:tick:20261009:0900");
  const iAlertFetch = events.indexOf("fetch:alert");
  const iDedupeGet = events.findIndex((e) => e.startsWith("get:alerted:"));
  chk("順序前提：這一格確實有寫樣本、也確實評估了拆除（否則下面的順序斷言是空的）",
    iSample >= 0 && iAlertFetch >= 0 && iDedupeGet >= 0, JSON.stringify(events));
  chk("★ 樣本 put 排在告警請求之前", iSample >= 0 && iAlertFetch > iSample, JSON.stringify(events));
  chk("★ 樣本 put 排在拆除評估的第一個動作（alertJob 讀去重鍵）之前",
    iSample >= 0 && iDedupeGet > iSample, JSON.stringify(events));
  chk("★ 樣本 put 是整支函式的第一個 KV 寫入（評估的去重鍵一律在它之後）",
    events.filter((e) => e.startsWith("put:"))[0] === "put:tick:20261009:0900",
    JSON.stringify(events.filter((e) => e.startsWith("put:"))));
}

// ---- /tickdiag：拆除提醒的讀側欄位（唯讀、不影響既有形狀）----
{
  const env = { FLOW_KV: { get: async () => null, put: async () => { throw new Error("不該被呼叫"); } } };
  const fresh = (await import(`../src/index.js?isolate=tickdiag-age-${Date.now()}`)).default;
  const res = await (await fresh.fetch(new Request("https://w.invalid/tickdiag"), env,
    { waitUntil: () => {} })).json();
  chk("/tickdiag 帶 since", res.since === TICK_SAMPLE_SINCE, String(res.since));
  chk("/tickdiag 帶 age_days（以台北今日計，不是查詢的 date）",
    res.age_days === tickAgeDays(taipeiParts().date), `${res.age_days} vs ${tickAgeDays(taipeiParts().date)}`);
  chk("/tickdiag 帶 teardown_due", res.teardown_due === tickTeardownDue(taipeiParts().date),
    String(res.teardown_due));
  chk("/tickdiag 既有欄位不變（schema/date/slots/n/samples）",
    res.schema === 1 && typeof res.date === "string" && res.slots === 132
    && res.n === 0 && Array.isArray(res.samples), JSON.stringify(res).slice(0, 200));
}

// ---- ★ /tickdiag?date=：age_days／teardown_due 一律以**台北今日**計，與查詢日無關 ----
// 為什麼要帶 ?date= 打：覆驗的突變 M11（改成用查詢參數算 age_days）讓 210 條全綠——因為
// 既有那條從不帶 ?date=，查詢日恰好就是今日，斷言變成自我實現。程式本來就是對的，是測試沒牙。
// 兩個查詢日刻意一過去一未來，各自的 teardownDue 必然一真一假，所以無論「今日」跑到哪一天，
// 兩者中一定有一個與今日不同值 → 這組斷言永遠有鑑別力（不會隨時間退化成自我實現）。
{
  const env = { FLOW_KV: { get: async () => null, put: async () => { throw new Error("不該被呼叫"); } } };
  const today = taipeiParts().date;
  const QS = ["2020-01-02", "2099-12-31"];
  for (const q of QS) {
    const fresh = (await import(`../src/index.js?isolate=tickdiag-qdate-${q}-${Date.now()}`)).default;
    const res = await (await fresh.fetch(new Request(`https://w.invalid/tickdiag?date=${q}`), env,
      { waitUntil: () => {} })).json();
    chk(`?date=${q} 真的生效（不生效的話下面兩條又變成自我實現）`, res.date === q, String(res.date));
    chk(`★ age_days 以台北今日計、不隨 ?date= 走（${q}）`,
      res.age_days === tickAgeDays(today) && res.age_days !== tickAgeDays(q),
      `${res.age_days} / today=${tickAgeDays(today)} / q=${tickAgeDays(q)}`);
    chk(`★ teardown_due 以台北今日計、不隨 ?date= 翻面（${q}）`,
      res.teardown_due === tickTeardownDue(today),
      `${res.teardown_due} / today=${tickTeardownDue(today)} / q=${tickTeardownDue(q)}`);
    chk(`?date= 只影響樣本那一組欄位（slots/n/samples 形狀不變）（${q}）`,
      res.slots === 132 && res.n === 0 && Array.isArray(res.samples), JSON.stringify(res).slice(0, 160));
  }
  chk("★ 上面兩個查詢日的 teardown_due 本來就一真一假（證明該斷言有鑑別力）",
    tickTeardownDue(QS[0]) !== tickTeardownDue(QS[1]),
    `${tickTeardownDue(QS[0])}/${tickTeardownDue(QS[1])}`);
}

// ---- 靜態守門 ----
{
  chk("全檔 .list( 零命中（KV list 額度曾爆過）",
    (SRC.match(/\.list\(/g) || []).length === 0,
    String((SRC.match(/\.list\(/g) || []).length));
  const block = SRC.split('if (url.pathname === "/tickdiag")')[1].split('if (url.pathname !== "/live")')[0];
  chk("/tickdiag handler 區塊內零 put(", block && !block.includes("put("), "handler 內出現 put(");
  chk("/tickdiag handler 區塊內零 .list(", block && !block.includes(".list("));
  const line = SRC.split("\n").find((l) => l.includes('service: "taiwan-flow-v2"'));
  chk("根路徑 endpoints 不含 /tickdiag", !!line && !line.includes("/tickdiag"));
  chk("根路徑 endpoints 仍不含 /livediag（不回歸）", !!line && !line.includes("/livediag"));
  // /live 零改動的守門：finFuturesVix 的請求形狀逐字保留
  chk("finFuturesVix 仍帶 cacheTtl:15 cacheEverything（/live 未被本批動到）",
    SRC.includes("dataset=TaiwanFuturesTick&data_id=TX&start_date=${date}&token=${encodeURIComponent(token)}`,\n      { cf: { cacheTtl: 15, cacheEverything: true } }"));
}

// 給可能的 unhandledRejection 一點時間浮現（它在 microtask 之後才由 node 判定）
await new Promise((r) => setTimeout(r, 50));
chk("★ 全程無 unhandledRejection（逾時是把 promise 放生，不是留下無人接的拒絕）",
  unhandled === 0, String(unhandled));

console.log(`tickdiag: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
