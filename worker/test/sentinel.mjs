// FinMind 哨兵離線單元測試（無需 token、不打網路）
// 執行：cd worker && node test/sentinel.mjs
import { taipeiParts, scheduledRole, sentinelKey, signalLanded, ghDispatchRequest,
  FRAME_CRON, dispatchNews }
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
  // 非 204 → 丟錯（scheduled handler 端只 log，備援 cron 兜底）
  let threw = false;
  try { await dispatchNews({ GH_DISPATCH_TOKEN: "T" }, async () => ({ status: 401 })); }
  catch { threw = true; }
  chk("dispatchNews 401 → 丟錯", threw);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} 通過 / ${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
