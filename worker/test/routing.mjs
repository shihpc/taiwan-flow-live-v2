// cron 路由與 wrangler.toml 一致性＋全檔靜態守門 離線測試（2026-10-23）
// 由來：這些斷言原本放在 test/tickdiag.mjs（台指期 tick 量測班的測試）裡，但它們守的是**與 tick 無關**的
// 全域不變式——toml cron 條數／無重複、每條 cron 的 dispatchRoleForCron 歸屬、全檔零 KV list、
// 根路徑 endpoints 不列診斷路徑、/live 的 finFuturesVix 請求形狀。2026-10-23 拆除 tick 班時整支
// tickdiag.mjs 刪除，這些守門搬到這裡保留（數字依拆除後的實況更新：22→21 條）。
// 無需 token、不打網路。執行：cd worker && node test/routing.mjs
import { readFileSync } from "node:fs";
import { dispatchRoleForCron, scheduledRole, taipeiParts, FRAME_CRON, ICHING_CRON, ICHING_AM_CRON }
  from "../src/index.js";

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; } else { fail++; console.log(`  x ${name}  ${detail || ""}`); }
}
const SRC = readFileSync(new URL("../src/index.js", import.meta.url), "utf-8");
const TOML = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf-8");
const CRONS = TOML.split("crons = [")[1].split("]")[0].split("\n")
  .map((l) => (l.match(/^\s*"([^"]+)"/) || [])[1]).filter(Boolean);
const tpe = (iso) => new Date(new Date(`${iso}Z`).getTime() - 8 * 3600e3);

// ---- wrangler.toml：條數、無重複 ----
{
  chk("crons 共 21 條", CRONS.length === 21, String(CRONS.length));   // 2026-10-23 拆 tick 量測班：22→21
  chk("crons 無重複字串", new Set(CRONS).size === CRONS.length);
  chk("已拆除的 tick 量測班 cron 不在 toml 內", !CRONS.includes("*/5 1-11 * * 2-6"));
  chk("FRAME_CRON 是 toml 第一條", CRONS[0] === FRAME_CRON, CRONS[0]);
  chk("ICHING_CRON 在 toml 內且僅一次", CRONS.filter((c) => c === ICHING_CRON).length === 1);
  chk("ICHING_AM_CRON 在 toml 內且僅一次", CRONS.filter((c) => c === ICHING_AM_CRON).length === 1);
}

// ---- toml 每一條的路由歸屬（null＝不走 dispatchRoleForCron、落 scheduledRole 由台北時刻分流）----
{
  const EXPECT = {
    "* 1-5 * * 2-6": null, "*/5 9-14 * * 2-6": null, "7,47 0-14,22-23 * * *": null,
    "35 5 * * 2-6": "backup", "40 6 * * 2-6": "backup", "35 10 * * 2-6": "backup",
    "5 12 * * 2-6": "backup", "5 21 * * *": "backup", "5 6 * * 2-6": "backup",
    "10 7 * * 2-6": "backup", "0 11 * * 2-6": "backup", "55 12 * * 2-6": "backup",
    "35 21 * * *": "backup", "*/5 13-15 * * 2-6": "evening", "50,55 22 * * *": "summary-am",
    "*/5 23 * * *": "summary-am", "*/10 0 * * *": "summary-am",
    "50 15 * * 2-6": "health", "30 1 * * 2-6": "health",
    [ICHING_CRON]: "iching", [ICHING_AM_CRON]: "iching",
  };
  chk("路由表恰 21 條且與 toml 集合相同",
    Object.keys(EXPECT).length === 21 && CRONS.every((c) => c in EXPECT),
    CRONS.filter((c) => !(c in EXPECT)).join(" | "));
  for (const [cron, kind] of Object.entries(EXPECT)) {
    const got = dispatchRoleForCron(cron);
    chk(`cron 歸屬：${cron}`, kind === null ? got === null : (got && got.kind === kind), JSON.stringify(got));
  }
  // 已拆除的 tick cron 不再被攔截（若有人誤把它加回 toml，會落到 scheduledRole＝frame——這正是當初必須攔的理由）
  chk("dispatchRoleForCron 不再認得 tick cron", dispatchRoleForCron("*/5 1-11 * * 2-6") === null);
  chk("（反證）未攔截的 cron 在盤中會被 scheduledRole 判成 frame",
    scheduledRole(taipeiParts(tpe("2026-10-21T10:30:00")), "*/5 1-11 * * 2-6") === "frame");
}

// ---- 全檔靜態守門 ----
{
  chk("全檔 .list( 零命中（KV list 額度曾爆過）",
    (SRC.match(/\.list\(/g) || []).length === 0, String((SRC.match(/\.list\(/g) || []).length));
  const line = SRC.split("\n").find((l) => l.includes('service: "taiwan-flow-v2"'));
  chk("根路徑 endpoints 不含 /livediag", !!line && !line.includes("/livediag"));
  chk("/tickdiag 路由已移除", !SRC.includes('"/tickdiag"'));
  chk("finFuturesVix 仍帶 cacheTtl:15 cacheEverything（/live 請求形狀不變）",
    SRC.includes("dataset=TaiwanFuturesTick&data_id=TX&start_date=${date}&token=${encodeURIComponent(token)}`,\n      { cf: { cacheTtl: 15, cacheEverything: true } }"));
}

console.log(`routing: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
