# src/twse_holidays.py — 本 repo Python 端的休市日判定（行事曆**消費端**，2026-09-29）
#
# 起因：2026-09-25（中秋）與 09-28（教師節）兩個平日國定假日，intraday.yml 照 cron 跑、
#   Worker KV 裡有休市日殘留的 frame（全部 stale=1、54 格累計額全天同一值 2540006019891），
#   archive_intraday.py 的「無 frame／覆蓋率 <90% 就不歸檔」守門擋不住（覆蓋率 100%），
#   於是寫出兩份內容逐位相同的假歸檔，再污染 rrg_base.json 與 rrg_frozen.json。
#   細節見 CLAUDE.md「盤中 RRG 盤外定格」節的「假日假歸檔事故」段。
#
# 規格正本：docs/holiday-calendar.md（§1 資料契約、§2 消費端共同規則）。
# 本檔形狀比照 taiwan-flows/src/twse_holidays.py（parse 驗契約、load 失敗回 None 不拋），
# 差別只在**先讀本地檔**：本 repo 就是行事曆的產出端，intraday.yml checkout 後
# data/twse_holidays.json 就在磁碟上，不必打網路；本地讀不到／壞檔才退 raw URL。
#
# 核心約束（§2）：**fail-open**——本地與遠端都讀不到、壞檔、schema 不合、或目標年度不在
#   `years` 裡，一律退回「只排週末」，絕不拋例外、絕不因行事曆掛掉而把真交易日判成休市。
#
# 共用者（判定邏輯只有這一份，不得各寫一份）：
#   src/archive_intraday.py（休市日不歸檔）、src/build_rrg_frozen.py（休市日不定格）、
#   src/build_rrg_base.py（選基準日時剔除休市日檔，防既有殘檔回流）。

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from datetime import date as _date
from pathlib import Path
from typing import Callable

DEFAULT_PATH = Path(__file__).resolve().parent.parent / "data" / "twse_holidays.json"
HOLIDAYS_URL = ("https://raw.githubusercontent.com/shihpc/taiwan-flow-live-v2/"
                "main/data/twse_holidays.json")
FETCH_TIMEOUT_SEC = 10
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

Fetch = Callable[[str, float], "str | bytes"]


@dataclass(frozen=True)
class TwseHolidays:
    years: frozenset
    closed: frozenset
    names: dict = field(default_factory=dict)
    src: str = ""          # "local" / "remote"：只供 log

    def covers(self, day: str) -> bool:
        try:
            return int(day[:4]) in self.years
        except (TypeError, ValueError):
            return False

    def is_holiday(self, day: str) -> bool:
        """年度未涵蓋一律 False（fail-open＝只排週末）。"""
        return self.covers(day) and day in self.closed


def parse(doc: object, src: str = "") -> TwseHolidays | None:
    """驗 §1 契約；任一處不合回 None。schema 必須等於 1 且不是 bool（Python 的 True == 1）；1.0 照收，與家族其他四端一致。"""
    if not isinstance(doc, dict):
        return None
    schema = doc.get("schema")
    if isinstance(schema, bool) or schema != 1:   # 1.0 照收：與 Worker（=== 1）／taiwan-flows／看門狗／回測一致
        return None
    years, closed, names = doc.get("years"), doc.get("closed"), doc.get("names") or {}
    if not isinstance(years, list) or not years or \
            not all(isinstance(y, int) and not isinstance(y, bool) for y in years):
        return None
    if not isinstance(closed, list) or \
            not all(isinstance(d, str) and _DATE_RE.match(d) for d in closed):
        return None
    if not isinstance(names, dict):
        names = {}
    return TwseHolidays(frozenset(years), frozenset(closed),
                        {str(k): str(v) for k, v in names.items()}, src)


def _default_fetch(url: str, timeout: float) -> bytes:
    import requests  # 延後 import：純函式測試不需要它
    r = requests.get(url, timeout=timeout)
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}")
    return r.content


def _warn(msg: str) -> None:
    print(f"::warning::{msg}", file=sys.stderr)


def load(path: Path | None = None, fetch: Fetch | None = None,
         url: str = HOLIDAYS_URL, remote: bool = True) -> TwseHolidays | None:
    """本地優先、失敗退 raw URL；兩者都失敗回 None（呼叫端 fail-open），任何情況都不拋。"""
    p = Path(path) if path is not None else DEFAULT_PATH
    try:
        cal = parse(json.loads(p.read_text(encoding="utf-8")), "local")
        if cal is not None:
            return cal
        _warn(f"本地行事曆 {p} 形狀不合契約（schema／years／closed）")
    except Exception as e:  # noqa: BLE001
        _warn(f"本地行事曆 {p} 讀不到（{type(e).__name__}: {e}）")
    if remote:
        try:
            raw = (fetch or _default_fetch)(url, FETCH_TIMEOUT_SEC)
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8")
            cal = parse(json.loads(raw), "remote")
            if cal is not None:
                return cal
            _warn("遠端行事曆形狀不合契約")
        except Exception as e:  # noqa: BLE001
            _warn(f"遠端行事曆讀不到（{type(e).__name__}: {e}）")
    _warn("國定假日行事曆不可用 → 退回只排週末（fail-open）")
    return None


def closed_reason(day: str, cal: TwseHolidays | None) -> str | None:
    """day（YYYY-MM-DD）休市就回原因字串，交易日（或無法判斷）回 None。

    週末一律休市（與行事曆是否可用無關）；國定假日只在行事曆可用且涵蓋該年度時判定。
    日期格式不合 → None（不擋；格式錯誤由呼叫端自己的檢查處理）。
    """
    try:
        d = _date.fromisoformat(day)
    except (TypeError, ValueError):
        return None
    if d.weekday() >= 5:
        return "週末"
    if cal is not None and cal.is_holiday(day):
        nm = cal.names.get(day, "")
        return f"國定假日{('：' + nm) if nm else ''}"
    return None


def is_closed(day: str, cal: TwseHolidays | None) -> bool:
    return closed_reason(day, cal) is not None


def check_closed(day: str) -> str | None:
    """三支腳本共用入口：讀行事曆（fail-open）＋判定。"""
    return closed_reason(day, load())
