// /status 全系統資料健康端點離線單元測試（2026-08-11）
// 無需 token、不打真實網路——fetch 全用 mock。執行：cd worker && node test/status.mjs
import { addDaysISO, lastExpectedTradingDate, prevExpectedTradingDate, gradeMarket,
  gradeNews, gradeBrief, isoTaipei, extractHeadFields, buildStatus } from "../src/index.js";

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; } else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}

// 2026-08-11 = 週二；2026-08-08 = 週六；2026-08-09 = 週日；2026-08-07 = 週五
const TUE = { date: "2026-08-11", dow: 2, hour: 12, minute: 0 };
const MON = { date: "2026-08-10", dow: 1, hour: 12, minute: 0 };
const SAT = { date: "2026-08-08", dow: 6, hour: 12, minute: 0 };
const SUN = { date: "2026-08-09", dow: 0, hour: 12, minute: 0 };

// ---- 日期工具 ----
{
  chk("addDaysISO 退 1 天", addDaysISO("2026-08-11", -1) === "2026-08-10");
  chk("addDaysISO 跨月", addDaysISO("2026-08-01", -1) === "2026-07-31");
  chk("最近預期交易日：平日＝今天", lastExpectedTradingDate(TUE) === "2026-08-11");
  chk("最近預期交易日：週六退到週五", lastExpectedTradingDate(SAT) === "2026-08-07");
  chk("最近預期交易日：週日退到週五", lastExpectedTradingDate(SUN) === "2026-08-07");
  chk("前一交易日：週二→週一", prevExpectedTradingDate("2026-08-11") === "2026-08-10");
  chk("前一交易日：週一跳過週末→週五", prevExpectedTradingDate("2026-08-10") === "2026-08-07");
}

// ---- 市場資料類判級（live/flows/postmkt）----
{
  chk("市場：資料日＝今天(平日) → green", gradeMarket("2026-08-11", TUE) === "green");
  chk("市場：落後 1 交易日 → yellow", gradeMarket("2026-08-10", TUE) === "yellow");
  chk("市場：落後 2 交易日 → red", gradeMarket("2026-08-07", TUE) === "red");
  chk("市場：週末看上週五 → green", gradeMarket("2026-08-07", SAT) === "green");
  chk("市場：週日資料落後至週四 → yellow", gradeMarket("2026-08-06", SUN) === "yellow");
  chk("市場：週一資料仍是上週四 → red", gradeMarket("2026-08-06", MON) === "red");
  chk("市場：無日期 → red", gradeMarket(null, TUE) === "red");
}

// ---- news 判級（generated_at 距今時數）----
{
  const now = Date.parse("2026-08-11T12:00:00+08:00");
  chk("news：2 小時內 → green", gradeNews("2026-08-11T10:30:00+08:00", now) === "green");
  chk("news：3 小時整（邊界）→ green", gradeNews("2026-08-11T09:00:00+08:00", now) === "green");
  chk("news：10 小時 → yellow", gradeNews("2026-08-11T02:00:00+08:00", now) === "yellow");
  chk("news：24 小時整（邊界）→ yellow", gradeNews("2026-08-10T12:00:00+08:00", now) === "yellow");
  chk("news：25 小時 → red", gradeNews("2026-08-10T11:00:00+08:00", now) === "red");
  chk("news：無法解析 → red", gradeNews(null, now) === "red" && gradeNews("bogus", now) === "red");
}

// ---- brief 判級 ----
{
  chk("brief：date＝今天(平日) → green", gradeBrief("2026-08-11", TUE) === "green");
  chk("brief：date＝昨天(平日) → yellow", gradeBrief("2026-08-10", TUE) === "yellow");
  chk("brief：更舊 → red", gradeBrief("2026-08-07", TUE) === "red");
  chk("brief：週六看週五版 → yellow", gradeBrief("2026-08-07", SAT) === "yellow");
  chk("brief：週日仍是週五版 → yellow", gradeBrief("2026-08-07", SUN) === "yellow");
  chk("brief：週末但版太舊 → red", gradeBrief("2026-08-06", SAT) === "red");
  chk("brief：無日期 → red", gradeBrief(null, TUE) === "red");
}

// ---- isoTaipei / extractHeadFields ----
{
  chk("isoTaipei 轉 +08:00", isoTaipei(Date.parse("2026-08-11T04:00:00Z")) === "2026-08-11T12:00:00+08:00");
  const h = extractHeadFields('{"date":"2026-08-11","generated_at":"2026-08-11T21:01:04+08:00","margin":{');
  chk("extractHeadFields 撈出 date/generated_at", h.date === "2026-08-11" && h.generated_at === "2026-08-11T21:01:04+08:00");
  const h2 = extractHeadFields("not json at all");
  chk("extractHeadFields 撈不到回 null", h2.date === null && h2.generated_at === null);
}

// ---- buildStatus 整合（mock fetch＋mock KV）----
function fakeKV(init = {}) {
  const m = new Map(Object.entries(init));
  return { async get(k, type) { const v = m.get(k); if (v === undefined) return null; return type === "json" ? (typeof v === "string" ? JSON.parse(v) : v) : v; } };
}
const NOW = Date.parse("2026-08-11T22:00:00+08:00");
// mock fetch：五來源全鮮。postmkt 模擬 Range 回 206 檔頭。
const okFetch = async (u, init) => {
  const s = String(u);
  if (s.includes("/taiwan-flows/")) return { ok: true, status: 200, json: async () => ({ date: "2026-08-11", status: "ok", checked_at: "2026-08-11T21:30:00+08:00" }) };
  if (s.endsWith("/news.json")) return { ok: true, status: 200, json: async () => ({ generated_at: "2026-08-11T21:52:00+08:00", trading_days: ["2026-08-10", "2026-08-11"], total_news: 42 }) };
  if (s.endsWith("/daily-brief-card.json")) return { ok: true, status: 200, json: async () => ({ schema: 1, date: "2026-08-11", edition: 3, generated_at: "2026-08-11T07:30:00+08:00" }) };
  if (s.endsWith("/postmkt.json")) {
    // 驗證有帶 Range 檔頭（大檔不整包抓）
    if (!init || !init.headers || !init.headers.Range) return { ok: false, status: 500, text: async () => "" };
    return { ok: true, status: 206, text: async () => '{"date":"2026-08-11","generated_at":"2026-08-11T21:01:04+08:00","margin":{' };
  }
  return { ok: false, status: 404, json: async () => null, text: async () => "" };
};
{
  const kv = fakeKV({ "fi:2026-08-11": ["09:01", "09:02", "13:30"] });
  const out = await buildStatus({ FLOW_KV: kv }, TUE, okFetch, NOW);
  chk("schema:1＋generated_at＋status:ok", out.schema === 1 && out.status === "ok" && /\+08:00$/.test(out.generated_at));
  chk("五站齊全且順序 live/flows/news/brief/postmkt",
    out.sites.map((s) => s.id).join(",") === "live,flows,news,brief,postmkt");
  chk("每站欄位齊全（id/name/data_date/updated_at/level/note）",
    out.sites.every((s) => ["id", "name", "data_date", "updated_at", "level", "note"].every((k) => k in s)));
  chk("全鮮 → 五站 green", out.sites.every((s) => s.level === "green"),
    out.sites.map((s) => `${s.id}:${s.level}`).join(" "));
  const live = out.sites[0];
  chk("live 用 KV frame 索引（資料日＝今天、updated_at＝最後格）",
    live.data_date === "2026-08-11" && live.updated_at === "2026-08-11T13:30:00+08:00");
  chk("brief 判 date 而非 generated_at", out.sites[3].data_date === "2026-08-11");
}
{
  // 今日無 frame → 回退前一交易日 → yellow
  const kv = fakeKV({ "fi:2026-08-10": ["13:30"] });
  const out = await buildStatus({ FLOW_KV: kv }, TUE, okFetch, NOW);
  chk("live 今日無 frame 回退昨日 → yellow", out.sites[0].level === "yellow" && out.sites[0].data_date === "2026-08-10");
  const out2 = await buildStatus({ FLOW_KV: fakeKV() }, TUE, okFetch, NOW);
  chk("live 近兩交易日皆無 frame → red＋date null", out2.sites[0].level === "red" && out2.sites[0].data_date === null);
}
{
  // 單來源失敗不垮全體：flows 拋錯、postmkt 回 404，其餘照常
  const badFetch = async (u, init) => {
    const s = String(u);
    if (s.includes("/taiwan-flows/")) throw new Error("network boom");
    if (s.endsWith("/postmkt.json")) return { ok: false, status: 404, text: async () => "" };
    return okFetch(u, init);
  };
  const kv = fakeKV({ "fi:2026-08-11": ["09:01"] });
  const out = await buildStatus({ FLOW_KV: kv }, TUE, badFetch, NOW);
  chk("flows 失敗 → 該站 red＋note 說明＋日期 null",
    out.sites[1].level === "red" && out.sites[1].note.includes("boom") && out.sites[1].data_date === null);
  chk("postmkt 404 → 該站 red", out.sites[4].level === "red" && out.sites[4].note.includes("404"));
  chk("其餘站不受拖累（live/news/brief 仍 green）",
    out.sites[0].level === "green" && out.sites[2].level === "green" && out.sites[3].level === "green");
  chk("端點整體仍成功回應（schema/status 不變）", out.schema === 1 && out.status === "ok");
}
{
  // KV 缺失（env.FLOW_KV 未綁）也只是 live red，不拋例外
  const out = await buildStatus({}, TUE, okFetch, NOW);
  chk("無 KV → live red、其餘照常", out.sites[0].level === "red" && out.sites[1].level === "green");
}
{
  // 週末：fi 索引 TTL 已拉到 5 天（f frame 仍 2 天）——只要週五索引還在，
  // 即使 f: frame 本體已過期，statusSiteLive 仍以索引回報週五資料日 → green
  const SAT_NOW = Date.parse("2026-08-08T15:00:00+08:00");
  const kv = fakeKV({ "fi:2026-08-07": ["09:01", "13:30"] });   // 只有索引、無任何 f: 鍵
  const out = await buildStatus({ FLOW_KV: kv }, SAT, okFetch, SAT_NOW);
  chk("週六：週五 fi 索引在（frame 已蒸發）→ live green＋資料日=週五",
    out.sites[0].level === "green" && out.sites[0].data_date === "2026-08-07",
    `${out.sites[0].level} ${out.sites[0].data_date}`);
}

console.log(`status.mjs: ${pass} pass, ${fail} fail`);
if (fail) process.exit(1);
