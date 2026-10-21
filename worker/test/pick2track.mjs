// 選股二「追蹤名單」新選入 LINE 通知（pushPick2Track，2026-10-19）離線單元測試（fetch／KV 全 mock）
// 執行：cd worker && node test/pick2track.mjs
// 守的規格：track.json 介面契約（postmkt docs/pick2-score.md「追蹤名單」節）＋本 repo CLAUDE.md 晚場班說明。
import { pushPick2Track, pick2TrackText, runEvening, alertedKey, PICK2_TRACK_URL,
  PICK2_DISCLAIMER, PICK2_TEXT_MAX, PICK2_ALERTED_TTL, PICK2_CATCHUP_DAYS, pick2DateLag } from "../src/index.js";

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) pass++; else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}
function fakeKV(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    _m: m, ops: [],
    async get(k, type) { this.ops.push(`get ${k}`); const v = m.get(k);
      if (v === undefined) return null; return type === "json" ? (typeof v === "string" ? JSON.parse(v) : v) : v; },
    ttl: {},
    async put(k, v, o) { this.ops.push(`put ${k}`); m.set(k, v); if (o) this.ttl[k] = o.expirationTtl; },
  };
}
const TODAY = "2026-10-19";
const KEY = alertedKey(TODAY, "pick2");               // alerted:20261019:pick2
const TP = (hour, minute) => ({ date: TODAY, hour, minute, dow: 1 });
const ENV = (kv, extra = {}) => ({ FLOW_KV: kv, LINE_TOKEN: "lt", LINE_USER_ID: "U1",
  ALERT_WEBHOOK: "https://hooks.example/x", ...extra });
const TRACK = (over = {}) => ({
  schema: 1, date: TODAY, generated_at: `${TODAY}T21:40:00+08:00`,
  rule: { min_score: 80, min_items: 9 }, spec: "pick2-score-v1",
  tracking: [
    { code: "2330", name: "台積電", src: "auto", since: TODAY, entry_close: 1000, entry_score: 85.24,
      last_close: 1000, last_score: 85.24, ret: 0, pool_ret: 0, mdd: 0, days: 1 },
    { code: "2454", name: "聯發科", src: "manual", since: "2026-10-15", entry_close: 1200, entry_score: 70,
      last_close: 1260, last_score: 72, ret: 0.05, pool_ret: 0.01, mdd: -0.02, days: 3 },
    { code: "3017", name: "奇鋐", src: "auto", since: TODAY, entry_close: 900, entry_score: 81,
      last_close: 900, last_score: 81, ret: 0, pool_ret: 0, mdd: 0, days: 1 },
  ],
  new_today: [
    { code: "2330", name: "台積電", src: "auto", score: 85.24 },
    { code: "3017", name: "奇鋐", src: "manual", score: 81 },
  ],
  deleted: [],
  ...over,
});
// mock fetch：LINE → mode.line（預設 200）；track.json → mode.track（物件＝200 JSON、"404"、"bad"＝壞 JSON、"throw"）；
// 其他 → 404。spy 記 { url, kind, body }。
const mkFetch = (mode = {}, spy = []) => async (u, init) => {
  const s = String(u).split("?")[0];
  if (s.startsWith("https://api.line.me/")) {
    spy.push({ url: s, kind: "line", body: JSON.parse(init.body) });
    const st = mode.line ?? 200;
    if (st === "throw") throw new Error("network down");
    return { ok: st >= 200 && st < 300, status: st, json: async () => ({}) };
  }
  if (s === "https://hooks.example/x") { spy.push({ url: s, kind: "webhook" }); return { ok: true, status: 200 }; }
  if (s === PICK2_TRACK_URL) {
    spy.push({ url: String(u), kind: "track" });
    const t = mode.track;
    if (t === "throw") throw new Error("fetch failed");
    if (t === "404" || t === undefined) return { ok: false, status: 404, json: async () => { throw new Error("nf"); } };
    if (t === "bad") return { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token"); } };
    return { ok: true, status: 200, json: async () => structuredClone(t) };   // 不走 JSON 往返：保留 NaN／Infinity 以測守門（真 JSON 裡它們本來就出不來）
  }
  spy.push({ url: s, kind: "other" });
  return { ok: false, status: 404, json: async () => null };
};
const lines = (spy) => spy.filter((c) => c.kind === "line");

// ---- ① 時窗：22:00 前／23:55 後不抓 ----
for (const [h, m, want] of [[21, 55, "waiting"], [21, 0, "waiting"], [23, 56, "skipped"]]) {
  const spy = [], kv = fakeKV();
  const out = await pushPick2Track(ENV(kv), TP(h, m), mkFetch({ track: TRACK() }, spy));
  chk(`${h}:${m} 時窗外 → ${want}、零網路、零 KV`, out[want] && spy.length === 0 && kv.ops.length === 0, JSON.stringify(out));
}
{
  const spy = [];
  const out = await pushPick2Track(ENV(fakeKV()), TP(23, 55), mkFetch({ track: TRACK() }, spy));
  chk("23:55（窗尾含）→ 推送", out.sent === true && lines(spy).length === 1, JSON.stringify(out));
}

// ---- ② 成功推一次並寫 KV；同日第二次不推 ----
{
  const spy = [], kv = fakeKV();
  const out = await pushPick2Track(ENV(kv), TP(22, 0), mkFetch({ track: TRACK() }, spy));
  chk("22:00 → sent", out.sent === true && out.n === 2 && out.tracking === 3, JSON.stringify(out));
  chk("恰一次 LINE push、不送 webhook", lines(spy).length === 1 && !spy.some((c) => c.kind === "webhook"),
    spy.map((c) => c.kind).join(","));
  chk("track.json 帶破快取參數", spy.some((c) => c.kind === "track" && /\?d=\d+$/.test(c.url)));
  const body = lines(spy)[0].body;
  chk("LINE push 對 LINE_USER_ID、單一 text message", body.to === "U1" && body.messages.length === 1 && body.messages[0].type === "text");
  const text = body.messages[0].text;
  const want = [`【選股二追蹤】${TODAY} 新選入 2 檔`, "2330 台積電 總分 85.2（自動）", "3017 奇鋐 總分 81.0（手動）",
    "目前追蹤 3 檔", PICK2_DISCLAIMER].join("\n");
  chk("文字內容逐字符合", text === want, JSON.stringify(text));
  chk("KV 寫 alerted:<ymd>:pick2＝pushed", kv._m.get(KEY) === "pushed" && KEY === "alerted:20261019:pick2", KEY);
  chk("去重鍵 TTL＝PICK2_ALERTED_TTL（5 天，長於補推窗）", kv.ttl[KEY] === PICK2_ALERTED_TTL
    && PICK2_ALERTED_TTL > PICK2_CATCHUP_DAYS * 86400, String(kv.ttl[KEY]));
  const spy2 = [];
  const again = await pushPick2Track(ENV(kv), TP(22, 5), mkFetch({ track: TRACK() }, spy2));
  chk("同日第二次 → already-pushed、不推（只抓 track 一次）", again.skipped === "already-pushed"
    && lines(spy2).length === 0 && spy2.filter((c) => c.kind === "track").length === 1, JSON.stringify(again));
}

// ---- ③ date 不符／new_today 空／契約形狀不合 → 不推、不寫 KV ----
const noPush = async (label, track, wantSkip) => {
  const spy = [], kv = fakeKV();
  const out = await pushPick2Track(ENV(kv), TP(22, 30), mkFetch({ track }, spy));
  chk(`${label} → 不推`, lines(spy).length === 0 && (!wantSkip || out.skipped === wantSkip), JSON.stringify(out));
  chk(`${label} → 不寫去重鍵`, !kv._m.has(KEY));
};
await noPush("date 為 5 天前", TRACK({ date: "2026-10-14" }), "stale-date");
await noPush("date 為 4 天前（窗外邊界）", TRACK({ date: "2026-10-15" }), "stale-date");
await noPush("date 在未來（明日）", TRACK({ date: "2026-10-20" }), "future-date");
await noPush("date 缺", TRACK({ date: undefined }), "bad-date");
await noPush("date 非法（2026-02-30）", TRACK({ date: "2026-02-30" }), "bad-date");
await noPush("date 帶時間", TRACK({ date: "2026-10-19T00:00" }), "bad-date");
await noPush("new_today 空陣列", TRACK({ new_today: [] }), "no-new-today");
await noPush("new_today 非陣列", TRACK({ new_today: { code: "2330" } }));
await noPush("tracking 缺", TRACK({ tracking: undefined }));
await noPush("schema≠1", TRACK({ schema: 2 }));
await noPush("頂層為陣列", [TRACK()]);
await noPush("頂層 null", null);
await noPush("new_today 全部單筆不合（代號／score／src）", TRACK({ new_today: [
  { code: "<img>", name: "x", src: "auto", score: 90 },
  { code: "2330", name: "台積電", src: "auto", score: "85" },
  { code: "2330", name: "台積電", src: "bot", score: 85 },
  { code: "2330", name: "台積電", src: "auto", score: NaN },
  null,
] }), "no-new-today");

// ---- ③b 補推：track.date 在 4 個日曆日內（含今日）、該 track.date 未推過 → 推，第一行寫 track.date ----
chk("pick2DateLag 基本", pick2DateLag("2026-10-18", TODAY) === 1 && pick2DateLag(TODAY, TODAY) === 0
  && pick2DateLag("2026-10-20", TODAY) === -1 && pick2DateLag("x", TODAY) === null);
for (const [d, lag] of [["2026-10-18", 1], ["2026-10-16", 3]]) {
  const spy = [], kv = fakeKV();
  const out = await pushPick2Track(ENV(kv), TP(22, 0), mkFetch({ track: TRACK({ date: d }) }, spy));
  const k = alertedKey(d, "pick2");
  chk(`補推 ${d}（落後 ${lag} 天）→ sent、catchup`, out.sent === true && out.catchup === true && out.trackDate === d, JSON.stringify(out));
  chk(`補推 ${d} → 第一行寫 track.date`, lines(spy)[0]?.body.messages[0].text.startsWith(`【選股二追蹤】${d} 新選入 2 檔`));
  chk(`補推 ${d} → 去重鍵以 track.date 寫、不寫今日鍵`, kv._m.get(k) === "pushed" && !kv._m.has(KEY), [...kv._m.keys()].join(","));
}
{
  // 同一個 track.date 只推一次：昨晚（10-18）23:30 才產出、10-18 晚漏推 → 10-19 22:00 補推 → 10-19 22:05 與 10-20 22:00 都不再推
  const kv = fakeKV(), d = "2026-10-18", T = TRACK({ date: d });
  const a = await pushPick2Track(ENV(kv), TP(22, 0), mkFetch({ track: T }));
  const spyB = [], spyC = [];
  const b = await pushPick2Track(ENV(kv), TP(22, 5), mkFetch({ track: T }, spyB));
  const c = await pushPick2Track(ENV(kv), { date: "2026-10-20", hour: 22, minute: 0, dow: 2 }, mkFetch({ track: T }, spyC));
  chk("同 track.date 只推一次（跨日亦然）", a.sent === true && b.skipped === "already-pushed" && c.skipped === "already-pushed"
    && lines(spyB).length === 0 && lines(spyC).length === 0, JSON.stringify([a, b, c]));
  // 新的一天 track.date 前進 → 新鍵、照推
  const spyD = [];
  const e = await pushPick2Track(ENV(kv), { date: "2026-10-20", hour: 22, minute: 0, dow: 2 },
    mkFetch({ track: TRACK({ date: "2026-10-20" }) }, spyD));
  chk("track.date 前進 → 新鍵照推", e.sent === true && lines(spyD).length === 1 && kv._m.get(alertedKey("2026-10-20", "pick2")) === "pushed");
}

// ---- ③c score 為 null（手動加入池外股）→ 保留、顯示「總分 —」；非 null 非有限數仍丟 ----
{
  const t = TRACK({ new_today: [
    { code: "6789", name: "池外股", src: "manual", score: null },
    { code: "2330", name: "台積電", src: "auto", score: Infinity },
    { code: "2454", name: "聯發科", src: "auto", score: "88" },
  ] });
  const spy = [], kv = fakeKV();
  const out = await pushPick2Track(ENV(kv), TP(22, 0), mkFetch({ track: t }, spy));
  const text = lines(spy)[0]?.body.messages[0].text || "";
  chk("null score → 保留並推", out.sent === true && out.n === 1, JSON.stringify(out));
  chk("null score → 「總分 —（手動）」", text.split("\n")[1] === "6789 池外股 總分 —（手動）", JSON.stringify(text));
  chk("Infinity／字串 score 仍丟", !text.includes("2330") && !text.includes("2454"));
}

// ---- ④ 抓取失敗：404／壞 JSON／fetch 拋錯 → 不拋、不推、不寫 KV ----
for (const t of ["404", "bad", "throw"]) {
  const spy = [], kv = fakeKV();
  let out, threw = null;
  try { out = await pushPick2Track(ENV(kv), TP(22, 30), mkFetch({ track: t }, spy)); }
  catch (e) { threw = e; }
  chk(`track ${t} → 不拋`, !threw, String(threw));
  chk(`track ${t} → fetch-failed、不推、不寫 KV`, out && out.skipped === "fetch-failed" && lines(spy).length === 0 && !kv._m.has(KEY),
    JSON.stringify(out));
}

// ---- ⑤ 推送 500／拋錯 → 不寫 KV（下輪重試）；下輪成功才寫 ----
for (const st of [500, 429, "throw"]) {
  const kv = fakeKV();
  const out = await pushPick2Track(ENV(kv), TP(22, 30), mkFetch({ track: TRACK(), line: st }));
  chk(`LINE ${st} → error、不寫 KV`, typeof out.error === "string" && !kv._m.has(KEY), JSON.stringify(out));
  const retry = await pushPick2Track(ENV(kv), TP(22, 35), mkFetch({ track: TRACK() }));
  chk(`LINE ${st} 後下輪 → 成功並寫 KV`, retry.sent === true && kv._m.get(KEY) === "pushed", JSON.stringify(retry));
}

// ---- ⑥ 通道缺失：不抓、不推、不寫 KV（webhook 有設也不走） ----
for (const extra of [{ LINE_TOKEN: undefined }, { LINE_USER_ID: undefined }, { LINE_TOKEN: undefined, LINE_USER_ID: undefined }]) {
  const spy = [], kv = fakeKV();
  const out = await pushPick2Track(ENV(kv, extra), TP(22, 30), mkFetch({ track: TRACK() }, spy));
  chk(`通道缺 ${Object.keys(extra).join("+")} → no-channel、零網路、零 KV`,
    out.skipped === "no-channel" && spy.length === 0 && kv.ops.length === 0, JSON.stringify(out));
}

// ---- ⑦ dry：不推、不寫 KV ----
{
  const spy = [], kv = fakeKV();
  const out = await pushPick2Track(ENV(kv), TP(22, 30), mkFetch({ track: TRACK() }, spy), { dry: true });
  chk("dry → wouldPush、不推、不寫 KV", out.wouldPush === 2 && lines(spy).length === 0 && !kv._m.has(KEY), JSON.stringify(out));
}

// ---- ⑧ 外來字串：名稱去控制字元／換行並截斷；單筆不合者丟棄、其餘照推；長名單截斷 ≤上限 ----
{
  const t = TRACK({ new_today: [
    { code: "2330", name: "台積\n電\u0000" + "長".repeat(50), src: "auto", score: 85 },
    { code: "bad!", name: "x", src: "auto", score: 99 },
    { code: "00631L", name: 123, src: "manual", score: 80 },
  ] });
  const msg = pick2TrackText(t, TODAY);
  const ls = msg.text.split("\n");
  chk("有效 2 筆（壞代號丟棄）", msg.n === 2 && ls[0] === `【選股二追蹤】${TODAY} 新選入 2 檔`, msg.text);
  chk("名稱無換行／控制字元、截 20 字", ls[1].startsWith("2330 台積 電") && !/[\u0000-\u001f]/.test(ls[1])
    && ls[1].length <= "2330 ".length + 20 + " 總分 85.0（自動）".length, JSON.stringify(ls[1]));
  chk("名稱非字串 → 只顯示代號", ls[2] === "00631L 總分 80.0（手動）", JSON.stringify(ls[2]));
}
{
  const many = Array.from({ length: 500 }, (_, i) => ({ code: String(1000 + i), name: "名".repeat(20), src: "auto", score: 80 + (i % 20) }));
  const msg = pick2TrackText(TRACK({ new_today: many }), TODAY);
  chk("500 檔 → 文字 ≤ PICK2_TEXT_MAX 且 ≤5000", msg.text.length <= PICK2_TEXT_MAX && msg.text.length <= 5000, String(msg.text.length));
  chk("500 檔 → 首行報實數、尾行保留免責句", msg.text.startsWith(`【選股二追蹤】${TODAY} 新選入 500 檔`)
    && msg.text.endsWith(PICK2_DISCLAIMER) && msg.text.includes("…另 440 檔"), msg.text.slice(-80));
}

// ---- ⑨ 接線：runEvening 末步、既有步驟照常、失敗被隔離 ----
{
  const kv = fakeKV({ [`series:${TODAY}`]: [{ t: "09:00", amt: 1 }] });
  const env = ENV(kv, { GH_DISPATCH_TOKEN: "T", DATA_BASE: "https://raw.githubusercontent.com/shihpc/taiwan-flow-live-v2/main/data" });
  const spy = [];
  const f = async (u, init) => (String(u).includes("/dispatches") ? { ok: true, status: 204 } : mkFetch({ track: TRACK() }, spy)(u, init));
  const out = await runEvening(env, TP(22, 5), f);
  const keys = Object.keys(out);
  chk("runEvening → pick2 為最後一步、既有步驟都在",
    keys[keys.length - 1] === "pick2" && ["summary", "diag", "mktbal", "aetf2", "cardsRender", "cards"].every((k) => keys.includes(k)),
    JSON.stringify(keys));
  chk("runEvening 22:05 → pick2 sent", out.pick2 && out.pick2.sent === true, JSON.stringify(out.pick2));
  const kv2 = fakeKV({ [`series:${TODAY}`]: [{ t: "09:00", amt: 1 }] });
  const env2 = { ...env, FLOW_KV: kv2 };
  const out2 = await runEvening(env2, TP(21, 30), f);
  chk("runEvening 21:30 → pick2 waiting", out2.pick2 && out2.pick2.waiting === "before-22:00", JSON.stringify(out2.pick2));
  // pushPick2Track 內部若拋（模擬 KV get 拋錯）→ 被 runEvening 隔離
  const kv3 = fakeKV({ [`series:${TODAY}`]: [{ t: "09:00", amt: 1 }] });
  const g = kv3.get.bind(kv3);
  kv3.get = async (k, t) => { if (k === KEY) throw new Error("kv boom"); return g(k, t); };
  const out3 = await runEvening({ ...env, FLOW_KV: kv3 }, TP(22, 5), f);
  chk("pick2 拋錯 → runEvening 不拋、記 error、既有步驟照常", out3.pick2 && /kv boom/.test(out3.pick2.error)
    && "cards" in out3 && "aetf2" in out3, JSON.stringify(out3.pick2));
  // 非交易日：runEvening 開頭 series 守門 → pick2 根本不跑
  const spy4 = [];
  const out4 = await runEvening({ ...env, FLOW_KV: fakeKV() }, TP(22, 30), mkFetch({ track: TRACK() }, spy4));
  chk("非交易日 → 整段 skip、pick2 不跑", out4.skipped === "non-trading-day" && !("pick2" in out4) && spy4.length === 0);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} 通過 / ${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
