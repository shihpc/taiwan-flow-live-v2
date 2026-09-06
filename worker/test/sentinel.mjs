// FinMind 哨兵離線單元測試（無需 token、不打網路）
// 執行：cd worker && node test/sentinel.mjs
import { taipeiParts, scheduledRole, sentinelKey, signalLanded, ghDispatchRequest,
  FRAME_CRON, dispatchNews, dispatchMorning, runSentinel, alertSecretMissing, alertChannelReady,
  alertedKey }
  from "../src/index.js";

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; } else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}
// 便利：指定「台北時間」造 UTC Date（台北 = UTC+8）
const tpe = (iso) => new Date(new Date(`${iso}Z`).getTime() - 8 * 3600e3);

// ---- taipeiParts：UTC → 台北拆解 ----
{
  const p = taipeiParts(new Date("2026-07-14T11:00:00Z"));   // 台北 2026-07-14(二) 19:00
  chk("taipeiParts 日期", p.date === "2026-07-14", p.date);
  chk("taipeiParts 時分", p.hour === 19 && p.minute === 0, `${p.hour}:${p.minute}`);
  chk("taipeiParts 星期", p.dow === 2, String(p.dow));
  const q = taipeiParts(new Date("2026-07-14T16:30:00Z"));   // 跨日：台北 07-15 00:30
  chk("taipeiParts 跨日", q.date === "2026-07-15" && q.hour === 0 && q.minute === 30,
    `${q.date} ${q.hour}:${q.minute}`);
}

// ---- scheduledRole：窗口 / 節流 / 週末 ----
{
  const role = (iso) => scheduledRole(taipeiParts(tpe(iso)));
  // 2026-07-14 = 週二；07-18 = 週六；07-19 = 週日
  chk("平日19:00 → sentinel", role("2026-07-14T19:00:00") === "sentinel");
  chk("平日20:35 → sentinel", role("2026-07-14T20:35:00") === "sentinel");
  chk("平日22:55 → sentinel", role("2026-07-14T22:55:00") === "sentinel");
  chk("平日19:03 非%5 → idle", role("2026-07-14T19:03:00") === "idle");
  chk("平日22:59 非%5 → idle", role("2026-07-14T22:59:00") === "idle");
  chk("平日16:59 窗口前 → frame", role("2026-07-14T16:59:00") === "frame");
  chk("平日17:00 窗口起點 → sentinel", role("2026-07-14T17:00:00") === "sentinel");
  chk("平日18:55 窗口內%5 → sentinel", role("2026-07-14T18:55:00") === "sentinel");
  chk("平日23:00 窗口後 → frame", role("2026-07-14T23:00:00") === "frame");
  chk("盤中10:30 → frame", role("2026-07-14T10:30:00") === "frame");
  chk("週六20:00 → 不進哨兵", role("2026-07-18T20:00:00") === "frame");
  chk("週日20:00 → 不進哨兵", role("2026-07-19T20:00:00") === "frame");
}

// ---- scheduledRole：新聞定點班（每天 :07，台北 06–22 時；含 event.cron 分流）----
{
  const role = (iso, cron) => scheduledRole(taipeiParts(tpe(iso)), cron);
  const NEWS_CRON = "7 0-14,22-23 * * *";   // 與 wrangler.toml crons[2] 一致
  chk("平日06:07 → news", role("2026-07-14T06:07:00", NEWS_CRON) === "news");
  chk("平日22:07 → news", role("2026-07-14T22:07:00", NEWS_CRON) === "news");
  chk("平日23:07 → 非news", role("2026-07-14T23:07:00", NEWS_CRON) !== "news");
  chk("平日05:07 → 非news", role("2026-07-14T05:07:00", NEWS_CRON) !== "news");
  chk("平日17:07 哨兵窗口內:07 → news（非sentinel/idle）",
    role("2026-07-14T17:07:00", NEWS_CRON) === "news");
  chk("平日17:05 → sentinel 照舊", role("2026-07-14T17:05:00", NEWS_CRON) === "sentinel");
  chk("週六10:07 → news（週末也收新聞）", role("2026-07-18T10:07:00", NEWS_CRON) === "news");
  chk("週六20:05 → 非sentinel", role("2026-07-18T20:05:00", NEWS_CRON) !== "sentinel");
  // 9:07-13:07 兩條 cron 同分重疊：frame cron 醒來的照存 frame、新聞 cron 醒來的才 news
  chk("平日09:07 frame cron 醒來 → frame（不搶 news）",
    role("2026-07-14T09:07:00", FRAME_CRON) === "frame");
  chk("平日09:07 新聞 cron 醒來 → news", role("2026-07-14T09:07:00", NEWS_CRON) === "news");
  chk("cron 未帶（防禦性）:07 → 仍判 news", role("2026-07-14T10:07:00") === "news");
  // 晨報準點班（平日 06:47）
  chk("平日06:47 → morning", role("2026-07-14T06:47:00", "47 22 * * 0-4") === "morning");
  chk("週六06:47 → 非morning", role("2026-07-18T06:47:00") !== "morning");
  chk("平日06:46 → frame（非morning）", role("2026-07-14T06:46:00") === "frame");
  chk("平日07:47 → 非morning", role("2026-07-14T07:47:00") !== "morning");
  chk("平日07:47 共用cron醒來 → idle（不落frame）",
    role("2026-07-14T07:47:00", "7,47 0-14,22-23 * * *") === "idle");
  chk("平日17:47 → idle", role("2026-07-14T17:47:00", "7,47 0-14,22-23 * * *") === "idle");
}

// ---- sentinelKey：去重 key 格式 ----
{
  chk("sentinelKey 格式", sentinelKey("2026-07-14", "inst") === "sentinel:20260714:inst",
    sentinelKey("2026-07-14", "inst"));
  chk("sentinelKey daytrade", sentinelKey("2026-01-05", "daytrade") === "sentinel:20260105:daytrade");
}

// ---- signalLanded：落地判定 ----
{
  const inst = { name: "inst" };
  const daytrade = { name: "daytrade", needVolume: true };
  chk("inst 空 → 未落地", signalLanded(inst, []) === false);
  chk("inst null → 未落地", signalLanded(inst, null) === false);
  chk("inst 有列 → 落地", signalLanded(inst, [{ buy: 100 }]) === true);
  chk("daytrade 空 → 未落地", signalLanded(daytrade, []) === false);
  chk("daytrade Volume=0 → 未落地",
    signalLanded(daytrade, [{ Volume: 0 }, { Volume: "0" }]) === false);
  chk("daytrade Volume>0 → 落地",
    signalLanded(daytrade, [{ Volume: 0 }, { Volume: 12345 }]) === true);
}

// ---- ghDispatchRequest：URL / headers / body ----
{
  const { url, init } = ghDispatchRequest("taiwan-flows", "daily.yml", "TOK123");
  chk("dispatch URL",
    url === "https://api.github.com/repos/shihpc/taiwan-flows/actions/workflows/daily.yml/dispatches", url);
  chk("dispatch method POST", init.method === "POST");
  chk("dispatch Authorization", init.headers["Authorization"] === "Bearer TOK123");
  chk("dispatch Accept", init.headers["Accept"] === "application/vnd.github+json");
  chk("dispatch User-Agent 必填", !!init.headers["User-Agent"]);
  chk("dispatch body ref=main", JSON.parse(init.body).ref === "main");
  const p = ghDispatchRequest("postmkt", "build.yml", "T");
  chk("dispatch postmkt URL",
    p.url === "https://api.github.com/repos/shihpc/postmkt/actions/workflows/build.yml/dispatches", p.url);
}

// ---- mock fetch：ghDispatch 走到 fetch 的實際參數（透過 request 建構函式間接驗，
//      另直接驗 204 判定——這裡以最小 mock 重現 ghDispatch 的判定邏輯輸入）----
{
  // ghDispatch 未 export（掛在 env 上有 secret），改以 ghDispatchRequest + mock fetch
  // 驗「送出的東西」與「204 才算成功」的組合行為
  const calls = [];
  const mockFetch = (status) => async (url, init) => { calls.push({ url, init }); return { status }; };
  const { url, init } = ghDispatchRequest("taiwan-flows", "daily.yml", "TOK");
  // 成功路徑：204
  const ok = await mockFetch(204)(url, init);
  chk("mock 204 視為成功", ok.status === 204);
  // 失敗路徑：401（token 權限不足）→ 呼叫端應丟錯（哨兵會 log 後下輪重試）
  const bad = await mockFetch(401)(url, init);
  chk("mock 401 視為失敗", bad.status !== 204);
  chk("mock fetch 收到正確 URL", calls[0].url.endsWith("/daily.yml/dispatches"));
  chk("mock fetch 收到 Bearer", calls[0].init.headers["Authorization"] === "Bearer TOK");
}

// ---- dispatchNews：mock fetch 驗 URL/headers/失敗行為 ----
{
  const calls = [];
  const mock204 = async (url, init) => { calls.push({ url, init }); return { status: 204 }; };
  const ok = await dispatchNews({ GH_DISPATCH_TOKEN: "TOK" }, mock204);
  chk("dispatchNews 有 token → 觸發", ok === true && calls.length === 1);
  chk("dispatchNews URL 正確", calls[0] && calls[0].url ===
    "https://api.github.com/repos/shihpc/taiwan-stock-news/actions/workflows/build-news.yml/dispatches",
    calls[0] && calls[0].url);
  chk("dispatchNews method POST", calls[0].init.method === "POST");
  chk("dispatchNews Bearer", calls[0].init.headers["Authorization"] === "Bearer TOK");
  chk("dispatchNews body ref=main", JSON.parse(calls[0].init.body).ref === "main");
  // 無 token → 安靜跳過、不打網路
  const skipped = await dispatchNews({}, mock204);
  chk("dispatchNews 無 token → 跳過不打網路", skipped === false && calls.length === 1);
  // 兩次都非 204 → 重試 1 次後仍丟錯（scheduled handler 端只 log，備援 cron 兜底）
  // 用 noSleep 略過重試間隔實際等待，測試不需真的卡 3 秒
  const noSleep = async () => {};
  let threw = false;
  try {
    await dispatchNews({ GH_DISPATCH_TOKEN: "T" }, async () => ({ status: 401 }), noSleep);
  } catch { threw = true; }
  chk("dispatchNews 兩次都401 → 重試後仍丟錯", threw);
}

// ---- dispatchNews：失敗重試 1 次 ----
{
  const noSleep = async () => {};
  // 第1次失敗、第2次成功 → 應送出（呼叫2次 fetch）且不 throw、回傳 true
  {
    const calls = [];
    let n = 0;
    const flaky = async (url, init) => {
      n++; calls.push({ url, init });
      if (n === 1) return { status: 500 };
      return { status: 204 };
    };
    const ok = await dispatchNews({ GH_DISPATCH_TOKEN: "TOK" }, flaky, noSleep);
    chk("dispatchNews 重試：第1次失敗第2次成功 → 不丟錯", ok === true);
    chk("dispatchNews 重試：實際打了2次 fetch", n === 2, String(n));
  }
  // 兩次都失敗 → 仍 throw，且確實重試過（打了2次）
  {
    let n = 0;
    const alwaysFail = async () => { n++; return { status: 500 }; };
    let threw = false;
    try { await dispatchNews({ GH_DISPATCH_TOKEN: "TOK" }, alwaysFail, noSleep); }
    catch { threw = true; }
    chk("dispatchNews 重試：兩次都失敗 → 仍丟錯", threw);
    chk("dispatchNews 重試：兩次都失敗仍只重試1次（共打2次）", n === 2, String(n));
  }
  // sleepFn 真的被呼叫過一次（驗證重試間確實有等待這個步驟，不是跳過）
  {
    let sleptMs = null;
    const sleepSpy = async (ms) => { sleptMs = ms; };
    let n = 0;
    const failThenOk = async () => { n++; return n === 1 ? { status: 500 } : { status: 204 }; };
    await dispatchNews({ GH_DISPATCH_TOKEN: "TOK" }, failThenOk, sleepSpy);
    chk("dispatchNews 重試：有呼叫 sleepFn 等待", sleptMs === 3000, String(sleptMs));
  }
}

// ---- dispatchMorning：同樣結構的失敗重試 1 次 ----
{
  const noSleep = async () => {};
  let n = 0;
  const flaky = async () => { n++; return n === 1 ? { status: 500 } : { status: 204 }; };
  const ok = await dispatchMorning({ GH_DISPATCH_TOKEN: "TOK" }, flaky, noSleep);
  chk("dispatchMorning 重試：第1次失敗第2次成功 → 不丟錯", ok === true);
  chk("dispatchMorning 重試：實際打了2次 fetch", n === 2, String(n));

  let n2 = 0;
  const alwaysFail = async () => { n2++; return { status: 500 }; };
  let threw = false;
  try { await dispatchMorning({ GH_DISPATCH_TOKEN: "TOK" }, alwaysFail, noSleep); }
  catch { threw = true; }
  chk("dispatchMorning 重試：兩次都失敗 → 仍丟錯", threw);
  chk("dispatchMorning 重試：兩次都失敗仍只重試1次（共打2次）", n2 === 2, String(n2));

  const skipped = await dispatchMorning({}, flaky, noSleep);
  chk("dispatchMorning 無 token → 跳過不打網路", skipped === false);
}

// ---- runSentinel：dispatch 失敗接告警／secret 缺失告警（2026-09-06）----
// mock：KV（Map）＋依 URL 分流的 fetch（FinMind 探測 → 落地；GitHub dispatch → 可控狀態；
// webhook → 收集告警文字）。console.error 暫時攔下來驗「無通道時至少留下錯誤 log」。
function mockKV() {
  const m = new Map();
  return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); } };
}
function mockNet({ ghStatus = 204, landed = true } = {}) {
  const calls = { fin: 0, gh: [], hook: [] };
  const fetchFn = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://api.finmindtrade.com/")) {
      calls.fin += 1;
      return { ok: true, status: 200, async json() { return { status: 200, data: landed ? [{ buy: 1, Volume: 5 }] : [] }; } };
    }
    if (u.startsWith("https://api.github.com/")) { calls.gh.push(u); return { status: ghStatus, ok: ghStatus < 300 }; }
    if (u.startsWith("https://hook.example/")) { calls.hook.push(JSON.parse(init.body).content); return { ok: true, status: 200 }; }
    throw new Error(`unexpected fetch ${u}`);
  };
  return { calls, fetchFn };
}
const captureErr = () => { const msgs = []; const orig = console.error; console.error = (...a) => msgs.push(a.join(" ")); return { msgs, restore: () => { console.error = orig; } }; };
const TP = taipeiParts(new Date("2026-07-14T11:00:00Z"));   // 台北 2026-07-14(二) 19:00

{ // alertChannelReady：三種組合
  chk("channel：webhook 即可", alertChannelReady({ ALERT_WEBHOOK: "https://hook.example/x" }) === true);
  chk("channel：LINE 需 token＋user", alertChannelReady({ LINE_TOKEN: "t" }) === false
    && alertChannelReady({ LINE_TOKEN: "t", LINE_USER_ID: "u" }) === true);
  chk("channel：全缺 → false", alertChannelReady({}) === false);
}

{ // 落地 + dispatch 401 → alertJob（sentinel-err-inst）、sentinel KV 不記、同晚第二輪不重複告警
  const kv = mockKV();
  const { calls, fetchFn } = mockNet({ ghStatus: 401 });
  const env = { GH_DISPATCH_TOKEN: "T", FINMIND_TOKEN: "F", FLOW_KV: kv, ALERT_WEBHOOK: "https://hook.example/x" };
  await runSentinel(env, TP, fetchFn);
  chk("dispatch 失敗：四訊號都探測且都嘗試 dispatch", calls.fin === 4 && calls.gh.length === 4, `${calls.fin}/${calls.gh.length}`);
  chk("dispatch 失敗：sentinel KV 不記", ![...kv.m.keys()].some((k) => k.startsWith("sentinel:")), [...kv.m.keys()].join(","));
  chk("dispatch 失敗：每訊號一則告警（共 4）", calls.hook.length === 4, String(calls.hook.length));
  chk("dispatch 失敗：告警文字含訊號名與 HTTP 狀態", calls.hook.some((t) => t.includes("inst") && t.includes("401")), calls.hook[0]);
  chk("dispatch 失敗：告警走【排程】前綴", calls.hook.every((t) => t.startsWith("【排程】")));
  chk("dispatch 失敗：KV 記 alerted:<date>:sentinel-err-inst", kv.m.has(alertedKey(TP.date, "sentinel-err-inst")));
  await runSentinel(env, TP, fetchFn);   // 5 分後下一輪：仍失敗 → 重試 dispatch 但不再重複告警
  chk("dispatch 失敗：下一輪仍重試 dispatch", calls.gh.length === 8, String(calls.gh.length));
  chk("dispatch 失敗：同日同 tag 不重複告警", calls.hook.length === 4, String(calls.hook.length));
}

{ // 落地 + dispatch 204 → KV 記、無告警
  const kv = mockKV();
  const { calls, fetchFn } = mockNet({ ghStatus: 204 });
  const env = { GH_DISPATCH_TOKEN: "T", FINMIND_TOKEN: "F", FLOW_KV: kv, ALERT_WEBHOOK: "https://hook.example/x" };
  await runSentinel(env, TP, fetchFn);
  chk("dispatch 成功：四訊號 KV 皆記 dispatched", ["inst", "holding", "margin", "daytrade"].every((n) => kv.m.get(sentinelKey(TP.date, n)) === "dispatched"));
  chk("dispatch 成功：無告警", calls.hook.length === 0);
  await runSentinel(env, TP, fetchFn);
  chk("dispatch 成功：四訊號齊 → 當晚短路不再探測", calls.fin === 4 && calls.gh.length === 4);
}

{ // secret 缺失 + 有通道 → alertJob secret-missing-sentinel（每日一則），不探測、不碰 sentinel KV
  const kv = mockKV();
  const { calls, fetchFn } = mockNet();
  const env = { FINMIND_TOKEN: "F", FLOW_KV: kv, ALERT_WEBHOOK: "https://hook.example/x" };   // 缺 GH_DISPATCH_TOKEN
  const cap = captureErr();
  await runSentinel(env, TP, fetchFn);
  await runSentinel(env, TP, fetchFn);
  cap.restore();
  chk("secret 缺失：不探測不 dispatch", calls.fin === 0 && calls.gh.length === 0);
  chk("secret 缺失：告警一則且點名缺的 secret", calls.hook.length === 1 && calls.hook[0].includes("GH_DISPATCH_TOKEN"), calls.hook.join("|"));
  chk("secret 缺失：KV 記 secret-missing-sentinel 去重鍵", kv.m.has(alertedKey(TP.date, "secret-missing-sentinel")));
  chk("secret 缺失：console.error 每輪都有", cap.msgs.length >= 2 && cap.msgs[0].includes("secret-missing-sentinel"));
  const both = mockNet();
  const cap2 = captureErr();
  await runSentinel({ FLOW_KV: mockKV(), ALERT_WEBHOOK: "https://hook.example/x" }, TP, both.fetchFn);
  cap2.restore();
  chk("secret 兩者皆缺：告警文字列出兩個", both.calls.hook.length === 1 && both.calls.hook[0].includes("GH_DISPATCH_TOKEN") && both.calls.hook[0].includes("FINMIND_TOKEN"));
}

{ // secret 缺失 + 無通道 → 只 console.error、不打任何網路、不寫 KV（去重鍵不被白白用掉）
  const kv = mockKV();
  const { calls, fetchFn } = mockNet();
  const cap = captureErr();
  const r = await alertSecretMissing({ FLOW_KV: kv }, TP, "sentinel", ["GH_DISPATCH_TOKEN"], fetchFn);
  cap.restore();
  chk("無通道：回 no-channel", r && r.sent === false && r.reason === "no-channel", JSON.stringify(r));
  chk("無通道：不打網路", calls.hook.length === 0 && calls.gh.length === 0);
  chk("無通道：不寫 KV", kv.m.size === 0);
  chk("無通道：console.error 兩則（訊息＋通道亦缺）", cap.msgs.length === 2 && cap.msgs[1].includes("通道"), cap.msgs.join("|"));
}

{ // dispatchNews 無 token：有通道 → 告警一則；無通道 → 只 console.error；兩者皆回 false、不打 GitHub
  const kv = mockKV();
  const { calls, fetchFn } = mockNet();
  const cap = captureErr();
  const r1 = await dispatchNews({ FLOW_KV: kv, ALERT_WEBHOOK: "https://hook.example/x" }, fetchFn);
  const r2 = await dispatchNews({ FLOW_KV: kv, ALERT_WEBHOOK: "https://hook.example/x" }, fetchFn);
  cap.restore();
  chk("news 無 token：回 false、不打 GitHub", r1 === false && r2 === false && calls.gh.length === 0);
  // alertJob 週末不發：依「現在」的台北星期判定，週末跑測試時 hook 為 0 也正確
  const wk = taipeiParts().dow;
  const expectHook = (wk >= 1 && wk <= 5) ? 1 : 0;
  chk("news 無 token：有通道 → 每日一則 secret-missing-news（週末 0）", calls.hook.length === expectHook
    && (expectHook === 0 || calls.hook[0].includes("news")), `${calls.hook.length} dow=${wk}`);
  chk("news 無 token：console.error 留痕", cap.msgs.some((m) => m.includes("secret-missing-news")));
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} 通過 / ${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
