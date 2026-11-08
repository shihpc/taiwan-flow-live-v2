// 股市易經每日班主觸發角色 iching（2026-09-14）：cron 路由、dispatch 請求形狀、週末守門、secret 缺失告警、失敗重試＋告警。
// 離線、免 token：fetch／sleep／KV 全部注入。跑法：node test/iching.mjs
import { readFileSync } from "node:fs";
import { dispatchIching, dispatchRoleForCron, ICHING_CRON, ICHING_AM_CRON, ICHING_TRIAL_CRON, ichingSlot, DISPATCH_ROLES, taipeiParts, scheduledRole,
  alertedKey } from "../src/index.js";

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; } else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}
const tpe = (iso) => new Date(new Date(`${iso}Z`).getTime() - 8 * 3600e3);   // 台北時刻 → UTC Date
function mockKV() {
  const m = new Map();
  return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); } };
}
function mockNet(ghStatuses) {
  const calls = { gh: [], hook: [] };
  const seq = [...ghStatuses];
  const fetchFn = async (url, init) => {
    if (url.startsWith("https://api.github.com/")) { calls.gh.push({ url, init }); return { status: seq.length > 1 ? seq.shift() : seq[0] }; }
    if (url.startsWith("https://hook.example/")) { calls.hook.push(JSON.parse(init.body).content); return { ok: true, status: 200 }; }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { calls, fetchFn };
}
const noSleep = async () => {};
const WEEKDAY = taipeiParts(tpe("2026-09-14T22:30:00"));   // 週一
const WEEKDAY_2330 = taipeiParts(tpe("2026-09-14T23:30:00"));
const SAT = taipeiParts(tpe("2026-09-12T22:30:00"));

// 1. cron 路由：精確攔截、與 wrangler.toml 一致、不影響既有角色
{
  chk("ICHING_CRON 字面量", ICHING_CRON === "30 14,15 * * 2-6", ICHING_CRON);
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf-8");
  chk("wrangler.toml 含同一條 cron", toml.includes(`"${ICHING_CRON}"`));
  chk("dispatchRoleForCron → iching", dispatchRoleForCron(ICHING_CRON)?.kind === "iching");
  chk("DISPATCH_ROLES 登錄", DISPATCH_ROLES[ICHING_CRON] === "iching");
  chk("哨兵 cron 不被攔截", dispatchRoleForCron("*/5 9-14 * * 2-6") === null);
  chk("晚場班 cron 仍 evening", dispatchRoleForCron("*/5 13-15 * * 2-6")?.kind === "evening");
  chk("同分醒的哨兵 cron 在 22:30 仍走 sentinel（互不干擾）", scheduledRole(WEEKDAY, "*/5 9-14 * * 2-6") === "sentinel");
  chk("WEEKDAY 為週一 22:30", WEEKDAY.dow === 1 && WEEKDAY.hour === 22 && WEEKDAY.minute === 30);
  chk("23:30 亦為平日班", WEEKDAY_2330.hour === 23 && WEEKDAY_2330.minute === 30);
}

// 2. 正常 dispatch：URL／method／Bearer／body 恰為 {ref:"main"}（無 inputs）
{
  const { calls, fetchFn } = mockNet([204]);
  const r = await dispatchIching({ GH_DISPATCH_TOKEN: "TOK" }, WEEKDAY, fetchFn, noSleep);
  chk("回 dispatched:true", r.dispatched === true, JSON.stringify(r));
  chk("只打 GitHub 一次", calls.gh.length === 1 && calls.hook.length === 0);
  chk("URL 正確", calls.gh[0]?.url === "https://api.github.com/repos/shihpc/taiwan-stock-iching/actions/workflows/daily.yml/dispatches", calls.gh[0]?.url);
  chk("POST＋Bearer", calls.gh[0].init.method === "POST" && calls.gh[0].init.headers["Authorization"] === "Bearer TOK");
  chk("body 恰為 {ref:main}", calls.gh[0].init.body === JSON.stringify({ ref: "main" }), calls.gh[0].init.body);
  const r2 = await dispatchIching({ GH_DISPATCH_TOKEN: "TOK" }, WEEKDAY_2330, fetchFn, noSleep);
  chk("23:30 再叫一次（不看 22:30 結果）", r2.dispatched === true && calls.gh.length === 2);
}

// 3. 週末：不打網路
{
  const { calls, fetchFn } = mockNet([204]);
  const r = await dispatchIching({ GH_DISPATCH_TOKEN: "TOK" }, SAT, fetchFn, noSleep);
  chk("週六 → skipped weekend、零呼叫", r.skipped === "weekend" && calls.gh.length === 0);
}

// 4. secret 缺失：有通道 → 每日一則 secret-missing-iching；不打 GitHub
{
  const kv = mockKV();
  const { calls, fetchFn } = mockNet([204]);
  const env = { FLOW_KV: kv, ALERT_WEBHOOK: "https://hook.example/x" };
  const r1 = await dispatchIching(env, WEEKDAY, fetchFn, noSleep);
  const r2 = await dispatchIching(env, WEEKDAY_2330, fetchFn, noSleep);
  chk("無 token → skipped no-token、不打 GitHub", r1.skipped === "no-token" && r2.skipped === "no-token" && calls.gh.length === 0);
  chk("有通道 → 當日只告警一則", calls.hook.length === 1 && calls.hook[0].includes("iching"), JSON.stringify(calls.hook));
  chk("文案明示無 GH cron 兜底（不沿用共用的『下游 GH 兜底 cron 仍會跑』）",
    calls.hook[0].includes("無 GH cron 兜底") && !calls.hook[0].includes("兜底 cron 仍會跑"), calls.hook[0]);
  chk("KV 去重鍵已寫", kv.m.has(alertedKey(WEEKDAY.date, "secret-missing-iching")));
  const { calls: c2, fetchFn: f2 } = mockNet([204]);
  const r3 = await dispatchIching({ FLOW_KV: mockKV() }, WEEKDAY, f2, noSleep);
  chk("無 token 無通道 → 只 console.error、不打任何網路", r3.skipped === "no-token" && c2.gh.length === 0 && c2.hook.length === 0);
}

// 5. dispatch 失敗：重試 1 次仍失敗 → 回 dispatched:false ＋ alertJob（當日一則）；不往外丟
{
  const kv = mockKV();
  const { calls, fetchFn } = mockNet([401, 401, 401, 401]);
  const env = { GH_DISPATCH_TOKEN: "T", FLOW_KV: kv, ALERT_WEBHOOK: "https://hook.example/x" };
  let threw = false, r;
  try { r = await dispatchIching(env, WEEKDAY, fetchFn, noSleep); } catch { threw = true; }
  chk("兩次 401 → 不拋錯、回 dispatched:false", !threw && r && r.dispatched === false && /401/.test(r.error), JSON.stringify(r));
  chk("GitHub 打了 2 次（重試 1 次）", calls.gh.length === 2, String(calls.gh.length));
  chk("alertJob 告警一則、內容含失敗與 token 提示", calls.hook.length === 1 && calls.hook[0].includes("dispatch 失敗") && calls.hook[0].includes("GH_DISPATCH_TOKEN"), JSON.stringify(calls.hook));
  chk("KV 去重鍵 iching-dispatch-err", kv.m.has(alertedKey(WEEKDAY.date, "iching-dispatch-err")));
  const r2 = await dispatchIching(env, WEEKDAY_2330, fetchFn, noSleep);
  chk("23:30 再失敗 → 同日不重複告警", r2.dispatched === false && calls.gh.length === 4 && calls.hook.length === 1);
}

// 6. 第 1 次 500、第 2 次 204 → 重試後成功、不告警
{
  const { calls, fetchFn } = mockNet([500, 204]);
  const r = await dispatchIching({ GH_DISPATCH_TOKEN: "T", ALERT_WEBHOOK: "https://hook.example/x" }, WEEKDAY, fetchFn, noSleep);
  chk("flaky → 重試後 dispatched:true、無告警", r.dispatched === true && calls.gh.length === 2 && calls.hook.length === 0);
}

// 7. 早晨補叫班（2026-09-30，ICHING_AM_CRON＝台北 07:10 週二～六）
{
  // 7a. cron 路由：字面量、toml 一致、精確攔截、與 pm 那條與 am summary 主窗互不干擾
  chk("ICHING_AM_CRON 字面量", ICHING_AM_CRON === "10 23 * * 2-6", ICHING_AM_CRON);
  chk("ICHING_AM_CRON 與 ICHING_CRON 不同字串", ICHING_AM_CRON !== ICHING_CRON);
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf-8");
  const crons = toml.split("crons = [")[1].split("]")[0].split("\n").map((l) => (l.match(/^\s*"([^"]+)"/) || [])[1]).filter(Boolean);
  chk("wrangler.toml 含 ICHING_AM_CRON 且僅一次", crons.filter((c) => c === ICHING_AM_CRON).length === 1, crons.join(" | "));
  chk("wrangler.toml 仍含 ICHING_CRON 且僅一次", crons.filter((c) => c === ICHING_CRON).length === 1);
  chk("dispatchRoleForCron(ICHING_AM_CRON) → iching", dispatchRoleForCron(ICHING_AM_CRON)?.kind === "iching");
  chk("DISPATCH_ROLES 登錄 am", DISPATCH_ROLES[ICHING_AM_CRON] === "iching");
  chk("同分撞點 am summary 主窗（*/5 23）仍走 summary-am", dispatchRoleForCron("*/5 23 * * *")?.kind === "summary-am");
  // 7b. 時點：UTC 週一 23:10 ＝ 台北週二 07:10；UTC 週五 23:10 ＝ 台北週六 07:10
  const TUE_0710 = taipeiParts(new Date("2026-09-28T23:10:00Z"));   // 週一 UTC → 台北週二
  const SAT_0710 = taipeiParts(new Date("2026-10-02T23:10:00Z"));   // 週五 UTC → 台北週六
  const SUN_0710 = taipeiParts(tpe("2026-10-04T07:10:00"));
  const MON_0710 = taipeiParts(tpe("2026-10-05T07:10:00"));
  chk("UTC 週一 23:10 → 台北週二 07:10", TUE_0710.dow === 2 && TUE_0710.hour === 7 && TUE_0710.minute === 10, JSON.stringify(TUE_0710));
  chk("UTC 週五 23:10 → 台北週六 07:10", SAT_0710.dow === 6 && SAT_0710.hour === 7 && SAT_0710.minute === 10, JSON.stringify(SAT_0710));
  chk("ichingSlot：07:10 為 am、22:30／23:30 為 pm", ichingSlot(TUE_0710) === "am" && ichingSlot(WEEKDAY) === "pm" && ichingSlot(WEEKDAY_2330) === "pm");
  // 7c. 若沒被 dispatchRoleForCron 攔下、落到 scheduledRole：07:10 不是 news／morning／sentinel／idle，
  //     而是 fallthrough 的 "frame"（會多寫一格 f:<date>:07:10）——所以精確攔截是硬需求，這裡把該事實釘住
  const fall = scheduledRole(TUE_0710, ICHING_AM_CRON);
  chk("scheduledRole(07:10) 不會成 sentinel／news／morning", fall !== "sentinel" && fall !== "news" && fall !== "morning", fall);
  chk("scheduledRole(07:10) 是 fallthrough 的 frame（證明必須先攔截）", fall === "frame", fall);
  chk("同分醒的 am summary 主窗 cron 在 07:10 走 dispatchRoleForCron、不落 scheduledRole", dispatchRoleForCron("*/5 23 * * *") !== null);
  // 7d. 週末守門：am 收週二～六（週六 07:10 補週五），週日／週一 07:10 skip；pm 仍週一～五
  {
    const { calls, fetchFn } = mockNet([204]);
    const rT = await dispatchIching({ GH_DISPATCH_TOKEN: "TOK" }, TUE_0710, fetchFn, noSleep);
    const rS = await dispatchIching({ GH_DISPATCH_TOKEN: "TOK" }, SAT_0710, fetchFn, noSleep);
    chk("週二 07:10 → dispatched（slot am）", rT.dispatched === true && rT.slot === "am", JSON.stringify(rT));
    chk("週六 07:10 → dispatched（補週五那班、不被當週末 skip）", rS.dispatched === true && rS.slot === "am" && calls.gh.length === 2, JSON.stringify(rS));
    chk("am 的 body 仍恰為 {ref:main}（同一支 daily.yml、無 inputs）", calls.gh[1].init.body === JSON.stringify({ ref: "main" })
      && calls.gh[1].url.endsWith("/taiwan-stock-iching/actions/workflows/daily.yml/dispatches"));
    const rSun = await dispatchIching({ GH_DISPATCH_TOKEN: "TOK" }, SUN_0710, fetchFn, noSleep);
    const rMon = await dispatchIching({ GH_DISPATCH_TOKEN: "TOK" }, MON_0710, fetchFn, noSleep);
    chk("週日／週一 07:10 → skipped weekend、零呼叫", rSun.skipped === "weekend" && rMon.skipped === "weekend" && calls.gh.length === 2);
    const rSatPm = await dispatchIching({ GH_DISPATCH_TOKEN: "TOK" }, SAT, fetchFn, noSleep);
    chk("pm 週六 22:30 仍 skipped weekend（既有行為不變）", rSatPm.skipped === "weekend" && rSatPm.slot === "pm" && calls.gh.length === 2);
  }
  // 7e. 告警去重鍵分家：同一台北日早晨失敗與當晚失敗各自一則（tag iching-am-dispatch-err vs iching-dispatch-err）
  {
    const kv = mockKV();
    const { calls, fetchFn } = mockNet([401]);
    const env = { GH_DISPATCH_TOKEN: "T", FLOW_KV: kv, ALERT_WEBHOOK: "https://hook.example/x" };
    const D = "2026-09-29";   // 週二
    const am = taipeiParts(tpe(`${D}T07:10:00`)), pm1 = taipeiParts(tpe(`${D}T22:30:00`)), pm2 = taipeiParts(tpe(`${D}T23:30:00`));
    const r1 = await dispatchIching(env, am, fetchFn, noSleep);
    chk("早晨失敗 → 告警一則、tag iching-am-dispatch-err", r1.dispatched === false && calls.hook.length === 1
      && kv.m.has(alertedKey(D, "iching-am-dispatch-err")) && !kv.m.has(alertedKey(D, "iching-dispatch-err")), JSON.stringify(calls.hook));
    chk("早晨文案標明補叫班、不寫『無 GH cron 兜底』誤導", calls.hook[0].includes("早晨補叫班") && calls.hook[0].includes("當晚 22:30 主班仍會叫"), calls.hook[0]);
    const r2 = await dispatchIching(env, pm1, fetchFn, noSleep);
    chk("同日當晚 22:30 失敗 → 仍能告警第二則（早晨沒吃掉當晚額度）", r2.dispatched === false && calls.hook.length === 2
      && kv.m.has(alertedKey(D, "iching-dispatch-err")), String(calls.hook.length));
    const r3 = await dispatchIching(env, pm2, fetchFn, noSleep);
    chk("23:30 再失敗 → 與 22:30 同 tag、不重複", r3.dispatched === false && calls.hook.length === 2);
    const r4 = await dispatchIching(env, taipeiParts(tpe(`${D}T07:15:00`)), fetchFn, noSleep);
    chk("早晨同日再失敗 → 同 am tag、不重複", r4.dispatched === false && calls.hook.length === 2);
  }
  // 7f. 反向：當晚先失敗、隔晨再失敗——隔晨是新的台北日，且 tag 不同，兩則都發得出
  {
    const kv = mockKV();
    const { calls, fetchFn } = mockNet([401]);
    const env = { GH_DISPATCH_TOKEN: "T", FLOW_KV: kv, ALERT_WEBHOOK: "https://hook.example/x" };
    await dispatchIching(env, taipeiParts(tpe("2026-09-29T23:30:00")), fetchFn, noSleep);
    await dispatchIching(env, taipeiParts(tpe("2026-09-30T07:10:00")), fetchFn, noSleep);
    chk("當晚失敗＋隔晨失敗 → 兩則", calls.hook.length === 2 && kv.m.has(alertedKey("2026-09-29", "iching-dispatch-err"))
      && kv.m.has(alertedKey("2026-09-30", "iching-am-dispatch-err")));
  }
  // 7g. secret 缺失：am 走 tag secret-missing-iching-am，與 pm 的 secret-missing-iching 分家
  {
    const kv = mockKV();
    const { calls, fetchFn } = mockNet([204]);
    const env = { FLOW_KV: kv, ALERT_WEBHOOK: "https://hook.example/x" };
    const r1 = await dispatchIching(env, TUE_0710, fetchFn, noSleep);
    const r2 = await dispatchIching(env, taipeiParts(tpe("2026-09-29T22:30:00")), fetchFn, noSleep);
    chk("無 token：早晨與當晚各一則、tag 分家", r1.skipped === "no-token" && r2.skipped === "no-token" && calls.hook.length === 2
      && kv.m.has(alertedKey("2026-09-29", "secret-missing-iching-am")) && kv.m.has(alertedKey("2026-09-29", "secret-missing-iching")), JSON.stringify(calls.hook));
  }
  // 7h. 已知限制（釘住現況、不是期望）：週六 07:10 dispatch 失敗時 alertJob 對週末一律 skip → 不告警
  {
    const kv = mockKV();
    const { calls, fetchFn } = mockNet([401]);
    const r = await dispatchIching({ GH_DISPATCH_TOKEN: "T", FLOW_KV: kv, ALERT_WEBHOOK: "https://hook.example/x" }, SAT_0710, fetchFn, noSleep);
    chk("週六 07:10 失敗 → 有重試、回 dispatched:false，但 alertJob 週末 skip（零告警、零去重鍵）",
      r.dispatched === false && calls.gh.length === 2 && calls.hook.length === 0 && kv.m.size === 0, JSON.stringify(r));
  }
}

// 8. 試算卦班（#77 T4，ICHING_TRIAL_CRON＝台北 08:15／08:45 週二～六）
{
  // 8a. cron 路由：字面量、toml 一致、精確攔截、與其他 iching cron 不同字串
  chk("ICHING_TRIAL_CRON 字面量", ICHING_TRIAL_CRON === "15,45 0 * * 3-7", ICHING_TRIAL_CRON);
  chk("ICHING_TRIAL_CRON 與 am／pm 不同字串", ICHING_TRIAL_CRON !== ICHING_CRON && ICHING_TRIAL_CRON !== ICHING_AM_CRON);
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf-8");
  const crons = toml.split("crons = [")[1].split("]")[0].split("\n").map((l) => (l.match(/^\s*"([^"]+)"/) || [])[1]).filter(Boolean);
  chk("wrangler.toml 含 ICHING_TRIAL_CRON 且僅一次", crons.filter((c) => c === ICHING_TRIAL_CRON).length === 1);
  chk("dispatchRoleForCron(ICHING_TRIAL_CRON) → iching", dispatchRoleForCron(ICHING_TRIAL_CRON)?.kind === "iching" && DISPATCH_ROLES[ICHING_TRIAL_CRON] === "iching");
  // 8b. 時點：UTC 00:15／00:45 與台北 08:15／08:45 同日；Quartz dow 3-7＝週二～六
  const TUE_0815 = taipeiParts(new Date("2026-11-10T00:15:00Z"));   // 週二
  const SAT_0845 = taipeiParts(new Date("2026-11-14T00:45:00Z"));   // 週六
  const SUN_0815 = taipeiParts(tpe("2026-11-15T08:15:00"));
  const MON_0845 = taipeiParts(tpe("2026-11-09T08:45:00"));
  chk("UTC 週二 00:15 → 台北週二 08:15", TUE_0815.dow === 2 && TUE_0815.hour === 8 && TUE_0815.minute === 15, JSON.stringify(TUE_0815));
  chk("UTC 週六 00:45 → 台北週六 08:45", SAT_0845.dow === 6 && SAT_0845.hour === 8 && SAT_0845.minute === 45, JSON.stringify(SAT_0845));
  chk("ichingSlot：08:15／08:45＝trial；07:10 仍 am、22:30 仍 pm", ichingSlot(TUE_0815) === "trial" && ichingSlot(SAT_0845) === "trial"
    && ichingSlot(taipeiParts(tpe("2026-11-10T07:10:00"))) === "am" && ichingSlot(taipeiParts(tpe("2026-11-10T07:59:00"))) === "am"
    && ichingSlot(WEEKDAY) === "pm" && ichingSlot(taipeiParts(tpe("2026-11-10T11:59:00"))) === "trial" && ichingSlot(taipeiParts(tpe("2026-11-10T12:00:00"))) === "pm");
  // 8c. 落到 scheduledRole 會成 frame（證明必須精確攔截）
  chk("scheduledRole(08:15) 是 fallthrough 的 frame", scheduledRole(TUE_0815, ICHING_TRIAL_CRON) === "frame", scheduledRole(TUE_0815, ICHING_TRIAL_CRON));
  // 8d. 週二～六 dispatch、週日／週一 skip；body 同一支 daily.yml 無 inputs
  {
    const { calls, fetchFn } = mockNet([204]);
    const rT = await dispatchIching({ GH_DISPATCH_TOKEN: "TOK" }, TUE_0815, fetchFn, noSleep);
    const rS = await dispatchIching({ GH_DISPATCH_TOKEN: "TOK" }, SAT_0845, fetchFn, noSleep);
    chk("週二 08:15／週六 08:45 → dispatched（slot trial）", rT.dispatched === true && rT.slot === "trial" && rS.dispatched === true && rS.slot === "trial" && calls.gh.length === 2);
    chk("trial body 恰為 {ref:main}、同一支 daily.yml", calls.gh[0].init.body === JSON.stringify({ ref: "main" })
      && calls.gh[0].url.endsWith("/taiwan-stock-iching/actions/workflows/daily.yml/dispatches"));
    const rSun = await dispatchIching({ GH_DISPATCH_TOKEN: "TOK" }, SUN_0815, fetchFn, noSleep);
    const rMon = await dispatchIching({ GH_DISPATCH_TOKEN: "TOK" }, MON_0845, fetchFn, noSleep);
    chk("週日 08:15／週一 08:45 → skipped weekend、零呼叫", rSun.skipped === "weekend" && rMon.skipped === "weekend" && calls.gh.length === 2);
  }
  // 8e. 告警 tag 三者分家：同一台北日早晨、試算、當晚各自一則；試算兩班同 tag 不重複
  {
    const kv = mockKV();
    const { calls, fetchFn } = mockNet([401]);
    const env = { GH_DISPATCH_TOKEN: "T", FLOW_KV: kv, ALERT_WEBHOOK: "https://hook.example/x" };
    const D = "2026-11-10";
    await dispatchIching(env, taipeiParts(tpe(`${D}T07:10:00`)), fetchFn, noSleep);
    const r1 = await dispatchIching(env, taipeiParts(tpe(`${D}T08:15:00`)), fetchFn, noSleep);
    chk("試算失敗 → 第二則、tag iching-trial-dispatch-err", r1.dispatched === false && calls.hook.length === 2 && kv.m.has(alertedKey(D, "iching-trial-dispatch-err")), JSON.stringify(calls.hook));
    chk("試算文案標明只影響試算卦", calls.hook[1].includes("試算卦班") && calls.hook[1].includes("正式卦不受影響"), calls.hook[1]);
    await dispatchIching(env, taipeiParts(tpe(`${D}T08:45:00`)), fetchFn, noSleep);
    chk("08:45 再失敗 → 同 trial tag、不重複", calls.hook.length === 2);
    await dispatchIching(env, taipeiParts(tpe(`${D}T22:30:00`)), fetchFn, noSleep);
    chk("當晚失敗 → 第三則（試算沒吃掉當晚額度）", calls.hook.length === 3 && kv.m.has(alertedKey(D, "iching-dispatch-err")));
  }
  // 8f. secret 缺失：trial 走 secret-missing-iching-trial
  {
    const kv = mockKV();
    const { calls, fetchFn } = mockNet([204]);
    const r = await dispatchIching({ FLOW_KV: kv, ALERT_WEBHOOK: "https://hook.example/x" }, TUE_0815, fetchFn, noSleep);
    chk("無 token：trial 告警一則、tag secret-missing-iching-trial", r.skipped === "no-token" && r.slot === "trial" && calls.hook.length === 1
      && kv.m.has(alertedKey("2026-11-10", "secret-missing-iching-trial")) && calls.gh.length === 0, JSON.stringify(calls.hook));
  }
}

console.log(`iching: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
