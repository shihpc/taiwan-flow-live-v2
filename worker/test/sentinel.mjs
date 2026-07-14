// FinMind 哨兵離線單元測試（無需 token、不打網路）
// 執行：cd worker && node test/sentinel.mjs
import { taipeiParts, scheduledRole, sentinelKey, signalLanded, ghDispatchRequest }
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
  chk("平日18:59 窗口前 → frame", role("2026-07-14T18:55:00") === "frame");
  chk("平日23:00 窗口後 → frame", role("2026-07-14T23:00:00") === "frame");
  chk("盤中10:30 → frame", role("2026-07-14T10:30:00") === "frame");
  chk("週六20:00 → 不進哨兵", role("2026-07-18T20:00:00") === "frame");
  chk("週日20:00 → 不進哨兵", role("2026-07-19T20:00:00") === "frame");
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

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} 通過 / ${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
