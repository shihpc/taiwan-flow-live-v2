// LINE Flex 圖卡渲染層 離線單元測試（無需 token/網路）
// 執行：cd worker && node test/cards.mjs
// 守的規格：docs/line-cards-spec.md 第 2 節（Flex 硬限制）、第 4 節（誠實原則）、
//           3B.3（C 類白名單）、第 6 節驗收條件。
import { lineRequest, cardBubble, disclaimerBubble, buildCardCarousels,
  cardsFallbackText, assertCardAllowed, FX_FORBIDDEN, FX_BLOCKED_CARDS, FX_COLORS } from "../src/index.js";

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; } else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}

const mkCard = (i) => ({
  id: `t-${i}`, title: `測試卡${i}`, sub: "07-28 · 口徑說明",
  rows: [
    { l: "0001", m: "範例甲", r: "+4.8億", c: "up" },
    { l: "0002", m: "範例乙", r: "−2.1億", c: "down" },
    { l: "0003", m: "範例丙", r: "0.0億", c: "neutral" },
  ],
  note: "依範例金額降序", foot: "歷史分離度 0.92%、非單調",
});

// ---- lineRequest 相容性 ----
{
  const r1 = lineRequest("tk", "uid", "hello");
  const b1 = JSON.parse(r1.init.body);
  chk("lineRequest 字串→text message（既有呼叫端不變）",
    b1.messages.length === 1 && b1.messages[0].type === "text" && b1.messages[0].text === "hello");
  const r2 = lineRequest("tk", "uid", [{ type: "flex", altText: "a", contents: { type: "carousel", contents: [] } }]);
  const b2 = JSON.parse(r2.init.body);
  chk("lineRequest 陣列→原樣帶入 messages", b2.messages.length === 1 && b2.messages[0].type === "flex");
  chk("lineRequest 帶 Authorization", r2.init.headers.Authorization === "Bearer tk");
}

// ---- cardBubble 基本結構 ----
{
  const b = cardBubble(mkCard(1));
  chk("bubble type/size", b.type === "bubble" && b.size === "kilo");
  chk("body 為 vertical box", b.body.type === "box" && b.body.layout === "vertical");
  const js = JSON.stringify(b);
  chk("含標題與資料列", js.includes("測試卡1") && js.includes("範例甲"));
  chk("紅漲綠跌 hex", js.includes(FX_COLORS.up) && js.includes(FX_COLORS.down));
  chk("口徑註記在卡底", js.includes("依範例金額降序") && js.includes("非單調"));
}

// ---- cardBubble PNG hero 版（spec 3C：img 卡出 hero、body 精簡；缺圖走原版型）----
{
  const url = "https://raw.githubusercontent.com/shihpc/taiwan-flow-live-v2/main/data/cards/latest/t-1.png?d=2026-07-28";
  const b = cardBubble({ ...mkCard(1), img: url, imgRatio: "1040:1216" });
  chk("img 卡有 hero image", b.hero && b.hero.type === "image" && b.hero.url === url);
  chk("hero size=full／aspectMode=cover", b.hero.size === "full" && b.hero.aspectMode === "cover");
  chk("aspectRatio 用實際圖比例", b.hero.aspectRatio === "1040:1216");
  const js = JSON.stringify(b.body);
  chk("body 精簡：標題＋資料日在、rows 不重複出", js.includes("測試卡1") && js.includes("07-28")
    && !js.includes("範例甲"), js.slice(0, 120));
  chk("note/foot 仍在卡底（口徑註記不因有圖而消失）",
    js.includes("依範例金額降序") && js.includes("非單調"));
  const b2 = cardBubble({ ...mkCard(2), img: url });
  chk("無 imgRatio → 預設 3:4", b2.hero.aspectRatio === "3:4");
  const b3 = cardBubble({ ...mkCard(3), img: url, imgRatio: "not-a-ratio" });
  chk("壞 imgRatio → 退預設 3:4", b3.hero.aspectRatio === "3:4");
  const b4 = cardBubble({ ...mkCard(4), img: "http://insecure.example/x.png" });
  chk("非 https img → 忽略、走原文字版型", !b4.hero && JSON.stringify(b4).includes("範例甲"));
  // hero 卡照樣過 30KB 守門與誠實原則
  let threw = null;
  try { cardBubble({ id: "hb", title: "大", img: url, note: "x".repeat(31000) }); }
  catch (e) { threw = e.message; }
  chk("hero 卡 >30KB 同樣拋錯", threw && threw.includes("30KB"), threw);
  threw = false;
  try { cardBubble({ id: "hf", title: "本週最強", img: url }); } catch { threw = true; }
  chk("hero 卡禁用字同樣擋", threw === true);
}

// ---- wrap:true 全樹斷言（規格：所有 text 元件必須 wrap）----
{
  const walk = (n, out = []) => {
    if (n && typeof n === "object") {
      if (n.type === "text") out.push(n);
      for (const v of Object.values(n)) walk(v, out);
    }
    return out;
  };
  const texts = walk(buildCardCarousels([mkCard(1), mkCard(2)], "alt"));
  chk("樹內有 text 元件", texts.length > 0);
  chk("所有 text 元件 wrap:true", texts.every((t) => t.wrap === true),
    `未 wrap: ${texts.filter((t) => t.wrap !== true).length} 個`);
}

// ---- 誠實原則守門 ----
{
  let threw = null;
  try { cardBubble({ id: "bad", title: "本週最強股", paras: [] }); } catch (e) { threw = e.message; }
  chk("禁用字「最強」建構即擋", threw && threw.includes("最強"), threw);
  threw = null;
  try { cardBubble({ id: "bad2", title: "排行", note: "建議關注前三檔" }); } catch (e) { threw = e.message; }
  chk("禁用字「建議關注」在 note 也擋", threw && threw.includes("建議關注"), threw);
  chk("禁用字清單非空且含該買/必漲", FX_FORBIDDEN.includes("該買") && FX_FORBIDDEN.includes("必漲"));
}

// ---- C 類白名單守門（回測未過不得上線）----
{
  for (const id of ["flows-sync-1", "flows-sync-2", "flows-oppose-1", "flows-oppose-2", "pm-aetf-1"]) {
    let threw = false;
    try { cardBubble({ id, title: "x", paras: [] }); } catch { threw = true; }
    chk(`C 類 ${id} 被擋`, threw);
  }
  chk("白名單恰為 5 張", FX_BLOCKED_CARDS.size === 5);
}

// ---- carousel 切分與上限（2026-08-16 起不再壓底免責卡）----
{
  const cards14 = Array.from({ length: 14 }, (_, i) => mkCard(i));
  const msgs = buildCardCarousels(cards14, "股市雷達 07-28");
  // 14 卡 = 14 bubble → 12 + 2（無免責卡）
  chk("14 bubble 切成 2 carousel", msgs.length === 2);
  chk("首個 carousel 恰 12 bubble", msgs[0].contents.contents.length === 12);
  chk("次個 carousel 2 bubble", msgs[1].contents.contents.length === 2);
  chk("payload 不含免責卡", !JSON.stringify(msgs).includes("關於這份清單"));
  chk("每則有 altText 且 ≤1500", msgs.every((m) => m.altText && m.altText.length <= 1500));
  chk("同 carousel 內 size 一致",
    msgs.every((m) => new Set(m.contents.contents.map((b) => b.size)).size === 1));
  chk("每 carousel < 50KB", msgs.every((m) => JSON.stringify(m.contents).length < 50000));
  // 38 張（第一期實際卡數）→ 38 bubble → 4 carousel，仍 ≤5 message
  const msgs38 = buildCardCarousels(Array.from({ length: 38 }, (_, i) => mkCard(i)), "alt");
  chk("38 卡 → 4 carousel（12/12/12/2）", msgs38.length === 4
    && msgs38.map((m) => m.contents.contents.length).join(",") === "12,12,12,2");
  // 61 卡 → 61 bubble → 6 carousel → 超過 5 要炸（60 卡恰 5 carousel 已合法）
  let threw = false;
  try { buildCardCarousels(Array.from({ length: 61 }, (_, i) => mkCard(i)), "alt"); } catch { threw = true; }
  chk("超過 5 message 上限拋錯", threw);
}

// ---- bubble 30KB 上限（UTF-8 位元組，非字元數）----
{
  let threw = null;
  const big = { id: "big", title: "大", paras: [ "x".repeat(31000) ] };
  try { cardBubble(big); } catch (e) { threw = e.message; }
  chk("單 bubble >30KB 拋錯", threw && threw.includes("30KB"), threw);
  // 全中文：11,000 字元 ≈ 33KB UTF-8——字元數守門會放行、位元組守門必須擋
  threw = null;
  const zh = { id: "zh", title: "中文", paras: [ "中".repeat(11000) ] };
  try { cardBubble(zh); } catch (e) { threw = e.message; }
  chk("全中文 33KB（字元數僅 1.1 萬）也被擋", threw && threw.includes("30KB"), threw);
  chk("錯誤訊息標明 UTF-8", threw && threw.includes("UTF-8"), threw);
}

// ---- 禁用字全清單逐詞驗擋（不只驗成員，實走建構路徑）----
{
  let blocked = 0;
  for (const w of FX_FORBIDDEN) {
    try { cardBubble({ id: "fw", title: `xx${w}yy`, paras: [] }); }
    catch { blocked++; }
  }
  chk(`FX_FORBIDDEN 全部 ${FX_FORBIDDEN.length} 詞逐一擋下`, blocked === FX_FORBIDDEN.length,
    `擋下 ${blocked}/${FX_FORBIDDEN.length}`);
  let threw = false;
  try { cardBubble({ id: "sp", title: "Top 1 股票", paras: [] }); } catch { threw = true; }
  chk("「Top 1」含空格變體被擋", threw);
}

// ---- 降級版同樣過守門（違規內容不得從任何通道漏出）----
{
  let threw = false;
  try { cardsFallbackText([{ id: "flows-sync-1", title: "x", paras: [] }], "07-28"); }
  catch { threw = true; }
  chk("降級版擋 C 類卡", threw);
  threw = false;
  try { cardsFallbackText([{ id: "fw", title: "本週最強", paras: [] }], "07-28"); }
  catch { threw = true; }
  chk("降級版擋禁用字", threw);
  chk("assertCardAllowed 可獨立供發送層預過濾", typeof assertCardAllowed === "function");
}

// ---- 行為釘住：空陣列與 12 倍數切分（2026-08-16 起無免責卡）----
{
  const empty = buildCardCarousels([], "alt");
  chk("空 cards → 0 message（無免責卡可湊，發送層應先判空跳過）", empty.length === 0,
    JSON.stringify(empty));
  const m12 = buildCardCarousels(Array.from({ length: 12 }, (_, i) => mkCard(i)), "alt");
  chk("恰 12 卡 → 單一 carousel 恰 12 bubble（不再多出免責卡尾車）",
    m12.length === 1 && m12[0].contents.contents.length === 12
    && !JSON.stringify(m12).includes("關於這份清單"), JSON.stringify(m12.map((m) => m.contents.contents.length)));
}

// ---- lineRequest 多 message ----
{
  const msgs = buildCardCarousels(Array.from({ length: 14 }, (_, i) => mkCard(i)), "alt");
  const r = lineRequest("tk", "uid", msgs);
  const b = JSON.parse(r.init.body);
  chk("lineRequest 帶 2 個 flex message 原樣入 payload",
    b.messages.length === 2 && b.messages.every((m) => m.type === "flex"));
}

// ---- 純文字降級版 ----
{
  const txt = cardsFallbackText([mkCard(1), mkCard(2)], "07-28");
  chk("降級版含標題與日期", txt.includes("盤後圖卡】07-28") && txt.includes("測試卡1"));
  chk("降級版含免責句", txt.includes("非買賣訊號"));
  chk("降級版是純字串無 JSON", typeof txt === "string" && !txt.includes('"type"'));
}

// ---- disclaimerBubble 自身合法 ----
{
  const d = disclaimerBubble();
  chk("免責卡可建構且含免責句", JSON.stringify(d).includes("非買賣訊號"));
}

console.log(`\nPASS  ${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
