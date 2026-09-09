// 台指期 tick 量測班 離線單元測試（2026-09-09）
// 無需 token、不打真實網路——fetch / KV 全用 mock。
// 執行：cd worker && node test/tickdiag.mjs
import { readFileSync } from "node:fs";
import worker, { summarizeTickRows, tickSampleSlots, tickSampleKey, TICK_SAMPLE_TTL,
  TICK_CRON, TICK_START_HOUR, TICK_END_HOUR, TICK_MAX_PARSE_BYTES, maskTickErr,
  runTickSample, dispatchRoleForCron, scheduledRole, taipeiParts } from "../src/index.js";

let pass = 0, fail = 0;
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
  chk("crons 共 20 條", crons.length === 20, String(crons.length));
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
  let bodyRead = false;
  const bigRes = () => {
    const r = new Response("x".repeat(1000), {
      headers: { "content-length": String(TICK_MAX_PARSE_BYTES + 1) },
    });
    const orig = r.text.bind(r);
    r.text = async () => { bodyRead = true; return orig(); };
    return r;
  };
  const val = await runTickSample(env, tp, async () => bigRes());
  chk("★ clen 閘門：body 從未被讀取", bodyRead === false, String(bodyRead));
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

console.log(`tickdiag: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
