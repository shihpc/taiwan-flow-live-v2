# src/build_holidays.py — 抓 TWSE 休市行事曆 → data/twse_holidays.json（家族共用國定假日行事曆）
#
# 規格正本：docs/holiday-calendar.md §1（資料契約）。本檔是該契約的唯一產出端。
#
# - 來源：TWSE OpenAPI holidaySchedule（免金鑰，只回**當年度**）。
# - 解析規則逐字沿用 postmkt build_summary.py 的 is_twse_holiday：
#   Date 為民國年 7 碼（1150925 = 2026-09-25）；**只有 Name 含「無交易」或 Description 含
#   「放假」／「補假」才算休市**——行事曆混有「開始交易日／最後交易日」等交易日標記，必須濾掉。
# - 合併：本次抓到的年度**整年覆寫**，舊檔其他年度保留（跨年時上一年不丟）。
#   years＝本次實際抓到「≥1 筆休市日」的年度 ∪ 舊檔保留的年度；某年不在 years＝該年未知，
#   消費端一律退回「只排週末」（不得當成「該年沒假日」）。
# - **失敗不覆寫**：抓取失敗、形狀不對、解析後休市 0 筆 → 不寫檔、exit 1（workflow 紅燈＋issue）。
# - 內容無變化（忽略 fetched_at）→ 不寫檔（檔案位元組不變 → workflow 的 git diff 為空、不 commit）。
#   **刻意不靠 tools/noop_guard.py**：那支只忽略頂層 generated_at／built_at，本檔時戳鍵是 fetched_at。
# - **手動補登清單（2026-10-25 使用者裁定 A）**：`data/twse_holidays_extra.json` 收 TWSE 行事曆不會列的
#   臨時停市（颱風等；起因 2026-10-23 颱風停市，TWSE OpenAPI 事後仍未列入）。每次重建都把清單併進
#   closed／names，所以 TWSE 整年覆寫不會洗掉手動補的日子。規則：
#   - 只併入「已在 years 內」的年度；年度未涵蓋的條目略過並印 warning（否則會把未知年度誤標成已知）。
#   - TWSE 已列同一天時沿用 TWSE 的名稱（清單只補缺、不改名）。
#   - 清單檔不存在＝沒有補登；檔案壞掉／形狀不對／日期不合 → 視同抓取失敗：不寫檔、exit 1
#     （手寫檔寫錯要大聲失敗，不能默默產出少了補登日的行事曆）。
#   - 產物 schema 與鍵不變（消費端不需改）；補登日只多出在 closed／names 裡。
#   - 已知限制：跨年後舊年度改由舊檔保留，若之後才從清單刪掉舊年度的條目，舊檔裡那天不會被移除。
#
# 用法：python src/build_holidays.py [--out data/twse_holidays.json] [--extra data/twse_holidays_extra.json]
# 測試：python -m pytest tests/test_build_holidays.py -q（fetch 可注入，免網路）

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

SOURCE_URL = "https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule"
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "data" / "twse_holidays.json"
DEFAULT_EXTRA = DEFAULT_OUT.with_name("twse_holidays_extra.json")
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TPE = timezone(timedelta(hours=8))
ROC_RE = re.compile(r"^(\d{3})(\d{2})(\d{2})$")


class HolidayError(Exception):
    """抓取／形狀／解析失敗（呼叫端 exit 1、不寫檔）。"""


def http_fetch(url: str = SOURCE_URL, timeout: int = 30):
    # 同族慣例：帶普通瀏覽器 UA（postmkt build_summary.py:41-43；cards 管線曾被 Cloudflare 依 UA 全擋）
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                                               "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def roc_to_iso(s) -> str | None:
    """民國年 7 碼 → YYYY-MM-DD；格式不合或日期不存在回 None。"""
    m = ROC_RE.match(str(s or "").strip())
    if not m:
        return None
    try:
        return date(int(m.group(1)) + 1911, int(m.group(2)), int(m.group(3))).isoformat()
    except ValueError:
        return None


def is_closed_row(r: dict) -> bool:
    """同 postmkt is_twse_holiday：Name 含「無交易」或 Description 含「放假」／「補假」。"""
    name = str(r.get("Name", ""))
    desc = str(r.get("Description", ""))
    return ("無交易" in name) or ("放假" in desc) or ("補假" in desc)


def parse_rows(rows) -> dict[str, str]:
    """回 {YYYY-MM-DD: 名稱}（只含休市日）。形狀不對拋 HolidayError。"""
    if not isinstance(rows, list):
        raise HolidayError(f"回應不是陣列：{type(rows).__name__}")
    out: dict[str, str] = {}
    for r in rows:
        if not isinstance(r, dict):
            raise HolidayError(f"列不是物件：{type(r).__name__}")
        if not is_closed_row(r):
            continue
        iso = roc_to_iso(r.get("Date"))
        if iso is None:
            print(f"::warning::休市列日期無法解析，略過：Date={r.get('Date')!r}", flush=True)
            continue
        out.setdefault(iso, str(r.get("Name", "")).strip())
    return out


def merge(old: dict | None, fresh: dict[str, str]) -> tuple[list[int], dict[str, str]]:
    """新抓到的年度整年覆寫、其他年度保留。回 (years, {date: name})。"""
    new_years = {int(d[:4]) for d in fresh}
    merged: dict[str, str] = {}
    kept_years: set[int] = set()
    if isinstance(old, dict):
        old_names = old.get("names") if isinstance(old.get("names"), dict) else {}
        for y in old.get("years") or []:
            if isinstance(y, int) and y not in new_years:
                kept_years.add(y)
        for d in old.get("closed") or []:
            if isinstance(d, str) and len(d) == 10 and d[:4].isdigit() and int(d[:4]) in kept_years:
                merged[d] = str(old_names.get(d, ""))
    merged.update(fresh)
    return sorted(new_years | kept_years), dict(sorted(merged.items()))


def load_extra(path: Path | None) -> dict[str, str]:
    """讀手動補登清單 → {YYYY-MM-DD: 名稱}。檔案不存在回 {}；壞檔／形狀不對拋 HolidayError。

    格式：{"schema": 1, "closed": {"YYYY-MM-DD": "名稱", ...}, ...其他鍵（說明用）忽略}
    """
    if path is None or not path.exists():
        return {}
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError) as e:
        raise HolidayError(f"補登清單讀不到或壞檔：{e}") from e
    if not isinstance(d, dict) or d.get("schema") != 1 or isinstance(d.get("schema"), bool):
        raise HolidayError("補登清單 schema 必須為整數 1")
    closed = d.get("closed")
    if not isinstance(closed, dict):
        raise HolidayError("補登清單 closed 必須是 {日期: 名稱} 物件")
    out: dict[str, str] = {}
    for k, v in closed.items():
        if not isinstance(k, str) or not ISO_RE.match(k):
            raise HolidayError(f"補登清單日期格式不合：{k!r}")
        try:
            date.fromisoformat(k)
        except ValueError as e:
            raise HolidayError(f"補登清單日期不存在：{k!r}") from e
        if not isinstance(v, str) or not v.strip():
            raise HolidayError(f"補登清單 {k} 的名稱必須是非空字串")
        out[k] = v.strip()
    return out


def apply_extra(years: list[int], names: dict[str, str], extra: dict[str, str]) -> dict[str, str]:
    """把補登日併進 names（只限 years 內的年度；TWSE 已有的沿用 TWSE 名稱）。"""
    out = dict(names)
    for d, nm in extra.items():
        if int(d[:4]) not in years:
            print(f"::warning::補登 {d} 的年度不在 years={years}，略過（年度未涵蓋＝未知，不可只標這一天）", flush=True)
            continue
        out.setdefault(d, nm)
    return dict(sorted(out.items()))


def build(old: dict | None, rows, fetched_at: str, extra: dict[str, str] | None = None) -> dict:
    fresh = parse_rows(rows)
    if not fresh:
        raise HolidayError("解析後休市 0 筆（形狀或規則可能已變）")
    years, names = merge(old, fresh)
    if extra:
        names = apply_extra(years, names, extra)
    return {"schema": 1, "source": SOURCE_URL, "fetched_at": fetched_at, "years": years,
            "closed": list(names), "names": names, "raw_n": len(rows)}


def same_except_fetched_at(a: dict | None, b: dict) -> bool:
    if not isinstance(a, dict):
        return False
    strip = lambda d: {k: v for k, v in d.items() if k != "fetched_at"}  # noqa: E731
    return strip(a) == strip(b)


def dumps(d: dict) -> str:
    return json.dumps(d, ensure_ascii=False, indent=1) + "\n"


def run(out: Path = DEFAULT_OUT, fetch=http_fetch, now=None, extra_path: Path | None = None) -> int:
    old = None
    if out.exists():
        try:
            old = json.loads(out.read_text(encoding="utf-8"))
        except (ValueError, OSError) as e:
            print(f"::warning::舊檔讀不到或壞檔，視為無舊檔：{e}", flush=True)
    try:
        extra = load_extra(extra_path)
        rows = fetch()
        fetched_at = (now or datetime.now(TPE)).isoformat(timespec="seconds")
        new = build(old, rows, fetched_at, extra)
    except Exception as e:   # 任何失敗都不覆寫
        print(f"::error::休市行事曆更新失敗，保留舊檔不覆寫：{e}", flush=True)
        return 1
    if same_except_fetched_at(old, new):
        print(f"內容無變化（忽略 fetched_at），不寫檔：years={new['years']} closed={len(new['closed'])}")
        return 0
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(dumps(new), encoding="utf-8")
    print(f"已寫入 {out}：years={new['years']} closed={len(new['closed'])} raw_n={new['raw_n']}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--extra", type=Path, default=DEFAULT_EXTRA)
    a = ap.parse_args(argv)
    return run(a.out, extra_path=a.extra)


if __name__ == "__main__":
    sys.exit(main())
