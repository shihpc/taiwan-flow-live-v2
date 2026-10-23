// 管理端點認證（2026-10-23，B3+B4 ①「只關門」）離線測試。
// 無需 token、不打真實網路——fetch／caches／KV 全用 mock，直接打 `export default` 的 fetch handler。
// 執行：cd worker && node test/adminkey.mjs
//
// 守的事：
//  ① 會產生副作用的請求（/snap、/alerts/test、/backup|/sumcheck|/evening|/health 的 dry=0）
//     ×（未設 secret／缺標頭／錯 key／長度不同的 key）→ 403、**零對外請求、零 KV 操作**、回應不含 key；
//  ② 正確 key → 照常執行（與改動前「無認證」版本的對外請求／KV 操作逐項相同，取得到舊版時對跑）；
//  ③ dry=1（預設）與唯讀路徑不需 key，且與改動前逐項相同；
//  ④ key 只認請求標頭、不認 query string；
//  ⑤ OPTIONS 預檢不放行 x-admin-key（CORS 未加 Allow-Headers）。
// 對跑舊版：git show <ADMINKEY_BASE，預設 41f6da1＝本批改動前已在 main 上的 commit>:worker/src/index.js（本批改動前）；CI 淺 clone 取不到時印 WARN 略過，
// 其餘不依賴舊版的斷言照跑。
import { writeFile, mkdtemp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import worker, { adminKeyEqual, adminCheck, ADMIN_HEADER } from "../src/index.js";

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) pass++; else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}

let OLD = null;
try {
  const base = process.env.ADMINKEY_BASE || "41f6da1";
  const src = execFileSync("git", ["show", `${base}:worker/src/index.js`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (src.includes("export function adminCheck")) throw new Error("base 已含本批改動");
  const dir = await mkdtemp(join(tmpdir(), "adm-"));
  const p = join(dir, "index_old.mjs");
  await writeFile(p, src);
  OLD = (await import(p)).default;
} catch (e) {
  console.log(`WARN 取不到改動前的 worker（${e && e.message}），對跑段落略過`);
}

const KEY = "test-admin-key-Zq81-DoNotLeak";     // 測試用假 key（HTTP 標頭值只能是 ByteString，故用 ASCII）
const WRONG = "test-admin-key-Zq81-DoNotLeaK";   // 同長度、只差最後一字
const SHORT = "test-admin";                        // 長度不同
const DATA_BASE = "https://raw.example/data";

function mockKV() {
  const m = new Map(), ops = [];
  return {
    ops,
    async get(k, type) { ops.push(`get ${k}`); const v = m.get(k); if (v == null) return null; return type === "json" ? JSON.parse(v) : v; },
    async put(k, v) { ops.push(`put ${k}`); m.set(k, String(v)); },
    async delete(k) { ops.push(`del ${k}`); m.delete(k); },
  };
}
const norm = (u) => String(u).replace(/([?&])(t|_)=\d+/g, "$1");
async function run(mod, { path, headers = {}, env: envOver = {}, method = "GET" }) {
  const calls = [];
  const origFetch = globalThis.fetch, origCaches = globalThis.caches, origLog = console.log, origErr = console.error;
  const logs = [];
  globalThis.fetch = async (u, init) => {
    const s = String(u && u.url ? u.url : u);
    calls.push(norm(s));
    if (s.includes("/dispatches")) return new Response(null, { status: 204 });
    if (s.includes("hooks.example") || s.includes("api.line.me")) return new Response("ok", { status: 200 });
    if (s.includes("api.finmindtrade.com")) return new Response(JSON.stringify({ status: 200, data: [] }));
    return new Response("not found", { status: 404 });
  };
  const store = new Map();
  globalThis.caches = { default: { match: async (k) => store.get(String(k.url)) || null, put: async (k, v) => { store.set(String(k.url), v); } } };
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => logs.push(a.join(" "));
  const kv = mockKV();
  const env = { DATA_BASE, FINMIND_TOKEN: "fm-x", GH_DISPATCH_TOKEN: "gh-x", ALERT_WEBHOOK: "https://hooks.example/w",
    FLOW_KV: kv, ADMIN_KEY: KEY, ...envOver };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const waits = [];
  let res, text;
  try {
    res = await mod.fetch(new Request(`https://w.invalid${path}`, { method, headers }), env, { waitUntil: (p) => waits.push(p) });
    text = await res.text();
    await Promise.allSettled(waits);
  } finally {
    globalThis.fetch = origFetch; globalThis.caches = origCaches; console.log = origLog; console.error = origErr;
  }
  let body = null; try { body = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, text, body, calls, kv: kv.ops, logs, headers: res.headers };
}
const H = (k) => ({ [ADMIN_HEADER]: k });
const sortJ = (a) => JSON.stringify([...a].sort());

// ---- 純函式 ----
{
  chk("adminKeyEqual 相同 → true", adminKeyEqual(KEY, KEY));
  chk("adminKeyEqual 同長不同 → false", WRONG.length === KEY.length && !adminKeyEqual(WRONG, KEY));
  chk("adminKeyEqual 長度不同 → false", !adminKeyEqual(SHORT, KEY) && !adminKeyEqual(KEY + "x", KEY));
  chk("adminKeyEqual 空字串對空字串仍回 true（但 adminCheck 先擋未設定）", adminKeyEqual("", ""));
  chk("adminKeyEqual 非字串 → false", !adminKeyEqual(null, KEY) && !adminKeyEqual(KEY, undefined));
  const req = (h) => new Request("https://w.invalid/x", { headers: h });
  chk("adminCheck 未設 ADMIN_KEY → 拒絕且 reason 寫明", /未設定 ADMIN_KEY/.test((adminCheck(req(H(KEY)), {}) || {}).reason || ""));
  chk("adminCheck ADMIN_KEY 為空字串 → 拒絕（fail-closed）", !!adminCheck(req(H("")), { ADMIN_KEY: "" }));
  chk("adminCheck 正確 → null", adminCheck(req(H(KEY)), { ADMIN_KEY: KEY }) === null);
}

// ---- 副作用路由 × 五種情況 ----
const SIDE = [
  { path: "/alerts/test",                  what: "送告警",        hit: (r) => r.calls.some((u) => u.includes("hooks.example")) },
  { path: "/snap",                         what: "打 FinMind／寫 frame", hit: (r) => r.calls.some((u) => u.includes("api.finmindtrade.com")) },
  { path: "/snap?force=1",                 what: "打 FinMind／寫 frame", hit: (r) => r.calls.some((u) => u.includes("api.finmindtrade.com")) },
  { path: "/backup?name=daysummary&dry=0", what: "dispatch 補發", dryFalse: true },
  { path: "/backup?name=us&dry=0",         what: "dispatch 補發", dryFalse: true },
  { path: "/sumcheck?slot=pm&dry=0",       what: "dispatch summary", dryFalse: true },
  { path: "/sumcheck?slot=am&dry=0",       what: "dispatch summary", dryFalse: true },
  { path: "/evening?dry=0",                what: "晚場鏈 dispatch", dryFalse: true },
  { path: "/health?slot=eve&dry=0",        what: "健檢告警",      dryFalse: true },
  { path: "/health?slot=morn&dry=0&date=2026-10-21", what: "健檢告警", dryFalse: true },
];
const DENY = [
  { id: "未設 secret",   env: { ADMIN_KEY: undefined }, headers: H(KEY), re: /未設定 ADMIN_KEY/ },
  { id: "secret 為空",   env: { ADMIN_KEY: "" },        headers: H(KEY), re: /未設定 ADMIN_KEY/ },
  { id: "缺標頭",        env: {},                       headers: {},     re: /缺少 x-admin-key/ },
  { id: "錯 key（同長）", env: {},                      headers: H(WRONG), re: /不符/ },
  { id: "長度不同的 key", env: {},                      headers: H(SHORT), re: /不符/ },
  { id: "key 放 query 不算數", env: {}, headers: {}, q: true, re: /缺少 x-admin-key/ },
];
for (const S of SIDE) {
  for (const D of DENY) {
    const path = D.q ? `${S.path}${S.path.includes("?") ? "&" : "?"}key=${encodeURIComponent(KEY)}&admin_key=${encodeURIComponent(KEY)}` : S.path;
    const r = await run(worker, { path, headers: D.headers, env: D.env });
    const tag = `${S.path} ${D.id}`;
    chk(`${tag}：403`, r.status === 403, `${r.status} ${r.text.slice(0, 120)}`);
    chk(`${tag}：{ok:false, reason}`, r.body && r.body.ok === false && D.re.test(r.body.reason || ""), r.text.slice(0, 160));
    chk(`${tag}：零對外請求（${S.what}未發生）`, r.calls.length === 0, r.calls.join(","));
    chk(`${tag}：零 KV 操作`, r.kv.length === 0, r.kv.join(","));
    chk(`${tag}：回應不含 key`, ![KEY, WRONG, SHORT, encodeURIComponent(KEY)].some((k) => r.text.includes(k)));
    chk(`${tag}：log 不含 key`, !r.logs.some((l) => [KEY, WRONG, SHORT].some((k) => l.includes(k))), r.logs.join("|"));
    chk(`${tag}：no-store`, r.headers.get("cache-control") === "no-store");
  }
  // 正確 key：照常執行
  const ok = await run(worker, { path: S.path, headers: H(KEY) });
  const tag = `${S.path} 正確 key`;
  chk(`${tag}：不是 403`, ok.status !== 403, `${ok.status} ${ok.text.slice(0, 160)}`);
  if (S.hit) chk(`${tag}：副作用確實發生（${S.what}）`, S.hit(ok), ok.calls.join(","));
  if (S.dryFalse) chk(`${tag}：以 dry=false 實跑`, ok.body && ok.body.dry === false, ok.text.slice(0, 160));
  chk(`${tag}：回應不含 key`, !ok.text.includes(KEY));
  chk(`${tag}：log 不含 key`, !ok.logs.some((l) => l.includes(KEY)));
  if (OLD) {
    const o = await run(OLD, { path: S.path });   // 改動前：無認證直接跑
    chk(`${tag}：對外請求與改動前相同`, sortJ(ok.calls) === sortJ(o.calls), `${sortJ(ok.calls)} vs ${sortJ(o.calls)}`);
    chk(`${tag}：KV 操作與改動前相同`, sortJ(ok.kv) === sortJ(o.kv), `${sortJ(ok.kv)} vs ${sortJ(o.kv)}`);
    chk(`${tag}：狀態碼與改動前相同`, ok.status === o.status, `${ok.status} vs ${o.status}`);
  }
}
// /alerts/test 在「正確 key」時確實打出 webhook（以 sendAlert 的 sent 回報）
{
  const r = await run(worker, { path: "/alerts/test", headers: H(KEY) });
  chk("/alerts/test 正確 key：回 ok:true（通道 mock 回 200）", r.body && r.body.ok === true, r.text);
}

// ---- dry=1（預設）與唯讀路徑：不需 key、與改動前相同 ----
const READ = [
  "/backup?name=daysummary", "/backup?name=daysummary&dry=1", "/sumcheck?slot=pm", "/sumcheck?slot=am&dry=1",
  "/evening", "/evening?dry=1", "/health?slot=eve", "/health?slot=morn&dry=1",
  "/backup?name=nope&dry=0",          // 參數不合法：dry=0 也在認證前就回錯（無副作用），維持原樣
  "/sumcheck?slot=xx&dry=0", "/health?slot=xx&dry=0",
  "/jobs?date=2026-10-21", "/alerts/log", "/replay?date=2026-10-21", "/",
];
for (const p of READ) {
  const noKey = await run(worker, { path: p, env: { ADMIN_KEY: undefined } });
  const wrongKey = await run(worker, { path: p, headers: H(WRONG) });
  chk(`${p}：未設 secret 也不是 403`, noKey.status !== 403, `${noKey.status} ${noKey.text.slice(0, 120)}`);
  chk(`${p}：帶錯 key 也不是 403`, wrongKey.status !== 403);
  chk(`${p}：不 dispatch、不告警`, !noKey.calls.some((u) => u.includes("/dispatches") || u.includes("hooks.example")), noKey.calls.join(","));
  chk(`${p}：有無 key 結果相同`, sortJ(noKey.calls) === sortJ(wrongKey.calls) && sortJ(noKey.kv) === sortJ(wrongKey.kv));
  if (OLD) {
    const o = await run(OLD, { path: p, env: { ADMIN_KEY: undefined } });
    const strip = (t) => t.replace(/"generated_at":"[^"]*"/g, "").replace(/"(at|ts|now)":[^,}]*/g, "");
    chk(`${p}：回應與改動前相同`, noKey.status === o.status && strip(noKey.text) === strip(o.text), `${noKey.text.slice(0, 100)} vs ${o.text.slice(0, 100)}`);
    chk(`${p}：對外請求與 KV 操作與改動前相同`, sortJ(noKey.calls) === sortJ(o.calls) && sortJ(noKey.kv) === sortJ(o.kv));
  }
}

// ---- OPTIONS 預檢：不放行 x-admin-key（瀏覽器跨站帶不出這個標頭）----
{
  const r = await run(worker, { path: "/alerts/test", method: "OPTIONS",
    headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": ADMIN_HEADER } });
  const ah = (r.headers.get("access-control-allow-headers") || "").toLowerCase();
  chk("OPTIONS 不列 x-admin-key 於 Allow-Headers", !ah.includes(ADMIN_HEADER), ah);
  chk("OPTIONS 不觸發任何請求", r.calls.length === 0 && r.kv.length === 0);
}

// ---- 靜態：key 只從標頭讀，原始碼不從 query 讀 ADMIN_KEY ----
{
  const { readFileSync } = await import("node:fs");
  const SRC = readFileSync(new URL("../src/index.js", import.meta.url), "utf-8");
  chk("原始碼無 searchParams 讀 key", !/searchParams\.get\(\s*["'](key|admin_key|admin|x-admin-key)["']/.test(SRC));
  chk("原始碼不 log env.ADMIN_KEY", !/console\.(log|error)\([^)]*ADMIN_KEY/.test(SRC));
}

console.log(`adminkey: ${pass} passed, ${fail} failed${OLD ? "" : "（對跑略過）"}`);
process.exit(fail ? 1 : 0);
