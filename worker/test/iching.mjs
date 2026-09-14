// 股市易經每日班主觸發角色 iching（2026-09-14）：cron 路由、dispatch 請求形狀、週末守門、secret 缺失告警、失敗重試＋告警。
// 離線、免 token：fetch／sleep／KV 全部注入。跑法：node test/iching.mjs
import { readFileSync } from "node:fs";
import { dispatchIching, dispatchRoleForCron, ICHING_CRON, DISPATCH_ROLES, taipeiParts, scheduledRole,
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

console.log(`iching: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
