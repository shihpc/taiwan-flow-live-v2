// 第九期：離線提醒——事件判定/去重/通道 離線單元測試（無需 token，mock KV/fetch）
// 執行：cd worker && node test/alerts.mjs
import { detectIdxEvent, detectSubEvents, dedupAlerts, webhookRequest, sendAlert, runAlerts,
  lineRequest, handleLineWebhook } from "../src/index.js";

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; } else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}

// ---- 事件①：加權指數 5 分變動 ----
{
  const cfg = { idx5: 40, subpp: 3 };
  const mk = (pts) => pts.map(([t, idx]) => ({ t, amt: 1, idx, chg: null }));
  // 情境 A：5 分漲 45 點 ≥ 40 → 觸發 up
  let ev = detectIdxEvent(mk([["09:25", 23000], ["09:30", 23000.0], ["09:35", 23045.0]]), "09:35", cfg);
  chk("idx5 漲45點觸發", ev.length === 1 && ev[0].id === "idx5-up", JSON.stringify(ev));
  chk("idx5 訊息含起訖", ev.length === 1 && ev[0].msg.includes("09:30") && ev[0].msg.includes("09:35"), ev[0] && ev[0].msg);
  // 情境 B：5 分跌 42 點 → 觸發 dn
  ev = detectIdxEvent(mk([["09:30", 23000], ["09:35", 22958.0]]), "09:35", cfg);
  chk("idx5 跌42點觸發 dn", ev.length === 1 && ev[0].id === "idx5-dn", JSON.stringify(ev));
  // 未達門檻不觸發
  ev = detectIdxEvent(mk([["09:30", 23000], ["09:35", 23035.0]]), "09:35", cfg);
  chk("idx5 35點未達門檻不觸發", ev.length === 0, JSON.stringify(ev));
  // 門檻 KV 可調：門檻改 30 → 35 點觸發
  ev = detectIdxEvent(mk([["09:30", 23000], ["09:35", 23035.0]]), "09:35", { idx5: 30 });
  chk("idx5 門檻可調(30→觸發)", ev.length === 1, JSON.stringify(ev));
  // 斷檔防護：參考點超過 8 分鐘前 → 不判
  ev = detectIdxEvent(mk([["09:20", 23000], ["09:35", 23100.0]]), "09:35", cfg);
  chk("idx5 參考點過舊(>8分)不判", ev.length === 0, JSON.stringify(ev));
  // 最新點非本分鐘（本分鐘 frame 沒存進 series）→ 不判
  ev = detectIdxEvent(mk([["09:30", 23000], ["09:34", 23100.0]]), "09:35", cfg);
  chk("idx5 最新點非本分鐘不判", ev.length === 0, JSON.stringify(ev));
  chk("idx5 空 series 不炸", detectIdxEvent([], "09:35", cfg).length === 0);
}

// ---- 事件②：連湧次產業近30分佔比 − 全日佔比 ≥ 3pp ----
{
  const cfg = { idx5: 40, subpp: 3 };
  const cl = {
    A1: { p: [["油品鏈", "加油站"]] }, A2: { p: [["油品鏈", "加油站"]] },
    B1: { p: [["其他鏈", "其他業"]] },
  };
  // 情境 A：加油站全日佔 10%（100/1000）、近30分佔 25%（Δ50/Δ200）→ +15pp ≥ 3pp 觸發
  const old1 = { A1: [30, 10], A2: [20, 20], B1: [750, 30], _ts: "2026-07-20 09:05:00" };
  const cur1 = { A1: [60, 11], A2: [40, 21], B1: [900, 29], _ts: "2026-07-20 09:35:00" };
  let ev = detectSubEvents(cur1, old1, cl, ["加油站"], cfg);
  chk("sub 佔比躍升觸發", ev.length === 1 && ev[0].id === "sub-加油站", JSON.stringify(ev));
  chk("sub 訊息含佔比數字", ev.length === 1 && ev[0].msg.includes("25%") && ev[0].msg.includes("10%"), ev[0] && ev[0].msg);
  // 情境 B：同數據但該次產業不在連湧清單 → 不觸發
  ev = detectSubEvents(cur1, old1, cl, ["其他業"], cfg);
  chk("sub 不在連湧清單不觸發", ev.length === 0, JSON.stringify(ev));
  // 佔比未躍升（近30分佔比≈全日佔比）不觸發
  const cur2 = { A1: [33, 11], A2: [22, 21], B1: [935, 29], _ts: "2026-07-20 09:35:00" };
  ev = detectSubEvents(cur2, old1, cl, ["加油站"], cfg);
  chk("sub 佔比未躍升不觸發", ev.length === 0, JSON.stringify(ev));
  // stale 防護：上游時戳停滯（cur._ts === old._ts）→ 不判
  ev = detectSubEvents({ ...cur1, _ts: old1._ts }, old1, cl, ["加油站"], cfg);
  chk("sub 時戳停滯不判", ev.length === 0, JSON.stringify(ev));
  chk("sub 空清單不判", detectSubEvents(cur1, old1, cl, [], cfg).length === 0);
  chk("sub 缺 frame 不炸", detectSubEvents(null, old1, cl, ["加油站"], cfg).length === 0);
}

// ---- 30 分去重 ----
{
  const now = Date.now();
  const events = [{ id: "idx5-up", msg: "m" }, { id: "sub-加油站", msg: "m2" }];
  // 20 分鐘前發過 idx5-up → 濾掉；sub 沒發過 → 保留
  let log = [{ ts: now - 20 * 60e3, id: "idx5-up" }];
  let fresh = dedupAlerts(events, log, now);
  chk("30分內同事件濾掉", fresh.length === 1 && fresh[0].id === "sub-加油站", JSON.stringify(fresh));
  // 35 分鐘前發過 → 可再發
  log = [{ ts: now - 35 * 60e3, id: "idx5-up" }];
  fresh = dedupAlerts(events, log, now);
  chk("超過30分可再發", fresh.length === 2, JSON.stringify(fresh.map((e) => e.id)));
  // 同 id 多筆取最近一筆判定
  log = [{ ts: now - 90 * 60e3, id: "idx5-up" }, { ts: now - 5 * 60e3, id: "idx5-up" }];
  fresh = dedupAlerts(events, log, now);
  chk("同id多筆取最近判定", fresh.length === 1, JSON.stringify(fresh.map((e) => e.id)));
  chk("空log全放行", dedupAlerts(events, [], now).length === 2);
}

// ---- 通道：webhook 請求格式（Discord/Telegram）----
{
  const d = webhookRequest("https://discord.com/api/webhooks/123/abc", "hi");
  chk("Discord 格式 {content}", JSON.parse(d.init.body).content === "hi", d.init.body);
  const t = webhookRequest("https://api.telegram.org/botTOKEN/sendMessage?chat_id=99", "hi");
  const tb = JSON.parse(t.init.body);
  chk("Telegram 格式 {chat_id,text}", tb.chat_id === "99" && tb.text === "hi", t.init.body);
  chk("POST + JSON header", d.init.method === "POST" && d.init.headers["Content-Type"] === "application/json");
}

// ---- 無 secret 靜默：不打任何外部請求、回明確 reason ----
{
  let called = 0;
  const fetchFn = async () => { called++; return { ok: true }; };
  const r = await sendAlert({}, "msg", fetchFn);
  chk("無 secret 不外送", r.sent === false && called === 0, JSON.stringify(r));
  chk("無 secret 回設定指引", (r.reason || "").includes("ALERT_WEBHOOK"), r.reason);
  const r2 = await sendAlert({ ALERT_WEBHOOK: "https://discord.com/api/webhooks/1/a" }, "msg", fetchFn);
  chk("有 secret 走 webhook", r2.sent === true && called === 1, JSON.stringify(r2));
}

// ---- LINE 通道：兩 secret 齊全才發、payload 格式、與 webhook 並存雙發、單通道失敗不擋 ----
{
  const calls = [];
  const fetchFn = async (url, init) => { calls.push({ url, init }); return { ok: true }; };
  let r = await sendAlert({ LINE_TOKEN: "tok" }, "hi", fetchFn);
  chk("LINE 只有 token 不發（靜默）", r.sent === false && calls.length === 0, JSON.stringify(r));
  r = await sendAlert({ LINE_USER_ID: "U123" }, "hi", fetchFn);
  chk("LINE 只有 userId 不發（靜默）", r.sent === false && calls.length === 0, JSON.stringify(r));
  r = await sendAlert({ LINE_TOKEN: "tok", LINE_USER_ID: "U123" }, "hi", fetchFn);
  chk("LINE 兩 secret 齊全發送", r.sent === true && calls.length === 1 && r.channels.join() === "line", JSON.stringify(r));
  const b = JSON.parse(calls[0].init.body);
  chk("LINE push URL/payload", calls[0].url === "https://api.line.me/v2/bot/message/push"
    && b.to === "U123" && b.messages.length === 1 && b.messages[0].type === "text" && b.messages[0].text === "hi",
    calls[0].url + " " + calls[0].init.body);
  chk("LINE Bearer 認證", calls[0].init.headers.Authorization === "Bearer tok", JSON.stringify(calls[0].init.headers));
  calls.length = 0;
  r = await sendAlert({ ALERT_WEBHOOK: "https://discord.com/api/webhooks/1/a",
    LINE_TOKEN: "tok", LINE_USER_ID: "U123" }, "hi", fetchFn);
  chk("webhook+LINE 並存雙發", r.sent === true && calls.length === 2
    && r.channels.join() === "webhook,line", JSON.stringify(r));
  // 單通道失敗（webhook 500）不擋 LINE，errors 帶回
  const fetchHalf = async (url, init) => ({ ok: !url.includes("discord.com"), status: 500 });
  r = await sendAlert({ ALERT_WEBHOOK: "https://discord.com/api/webhooks/1/a",
    LINE_TOKEN: "tok", LINE_USER_ID: "U123" }, "hi", fetchHalf);
  chk("單通道失敗不擋另一通道", r.sent === true && r.channels.join() === "line"
    && r.errors.length === 1 && r.errors[0].startsWith("webhook:"), JSON.stringify(r));
}

// ---- /line/webhook：uid 擷取寫 KV（變化才寫）----
{
  const store = new Map(); const puts = [];
  const kv = {
    async get(k) { const v = store.get(k); return v === undefined ? null : v; },
    async put(k, v) { store.set(k, v); puts.push(k); },
  };
  const env = { FLOW_KV: kv };
  let r = await handleLineWebhook(env, { events: [{ type: "message", source: { type: "user", userId: "U9" } }] });
  chk("webhook 事件寫入 uid", r.ok === true && r.uid === "U9" && store.get("line:uid") === "U9", JSON.stringify(r));
  r = await handleLineWebhook(env, { events: [{ source: { userId: "U9" } }] });
  chk("同 uid 再進不重寫（變化才寫）", r.uid === "U9" && puts.length === 1, String(puts.length));
  r = await handleLineWebhook(env, { events: [{ source: { userId: "U10" } }] });
  chk("uid 變化時覆寫", r.uid === "U10" && store.get("line:uid") === "U10" && puts.length === 2, String(puts.length));
  const before = puts.length;
  r = await handleLineWebhook(env, { events: [] });
  chk("空事件回 200 不寫", r.ok === true && r.uid === null && puts.length === before, JSON.stringify(r));
  r = await handleLineWebhook(env, null);
  chk("空 body 不炸", r.ok === true && r.uid === null, JSON.stringify(r));
}

// ---- runAlerts 整合（mock KV + mock fetch）：偵測→去重→寫 log 一次 ----
{
  const store = new Map();
  const puts = [];
  const kv = {
    async get(k, ty) { const v = store.get(k); return v === undefined ? null : (ty === "json" ? JSON.parse(v) : v); },
    async put(k, v, o) { store.set(k, v); puts.push(k); },
  };
  const d = "2026-07-20";
  store.set(`series:${d}`, JSON.stringify([
    { t: "09:30", amt: 100, idx: 23000, chg: 0 }, { t: "09:35", amt: 120, idx: 23050, chg: 50 },
  ]));
  // morning.json/classify.json fetch 會失敗（本測試無網路 stub globalThis.fetch）→ 事件②自然跳過
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 599 });
  try {
    const env = { FLOW_KV: kv, DATA_BASE: "https://x.invalid" };
    const tp = { date: d, hour: 9, minute: 35, dow: 1 };
    const r1x = await runAlerts(env, tp, `f:${d}:09:35`);
    chk("runAlerts 偵測到 idx5 事件並寫 log", r1x.events === 1 && puts.filter((k) => k === "alerts:log").length === 1, JSON.stringify(r1x));
    chk("runAlerts 無 secret → sent=false 但事件照記", r1x.sent === false, JSON.stringify(r1x));
    const lg = JSON.parse(store.get("alerts:log"));
    chk("log 內容含事件", lg.ev.length === 1 && lg.ev[0].id === "idx5-up" && lg.ev[0].sent === 0, JSON.stringify(lg));
    // 同分鐘再跑（或 5 分後同向再觸發）→ 30 分去重，不再寫
    const r2x = await runAlerts(env, tp, `f:${d}:09:35`);
    chk("runAlerts 30分內去重不重寫", r2x.deduped === 1 && puts.filter((k) => k === "alerts:log").length === 1, JSON.stringify(r2x));
    // 盤外時段直接 skip（不讀不寫）
    const before = puts.length;
    const r3x = await runAlerts(env, { date: d, hour: 14, minute: 0, dow: 1 }, null);
    chk("盤外時段 skip", r3x.skipped === true && puts.length === before, JSON.stringify(r3x));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---- 防迴歸：無 .list( 依賴 ----
{
  const src = await (await import("node:fs/promises")).readFile(
    new URL("../src/index.js", import.meta.url), "utf-8");
  chk("worker 原始碼無 .list( 呼叫", !src.includes(".list("));
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} 通過 / ${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
