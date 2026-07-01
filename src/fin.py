# src/fin.py — FinMind 共用 client（即時資金流監控用）
#
# 即時資料源：taiwan_stock_tick_snapshot（Sponsor 級，專屬 endpoint）
#   一次 request 取全市場快照（~2,800 檔），盤中即時更新、盤後為當日最終值。
#   欄位：close, change_rate, average_price, total_volume, total_amount(累計成交金額,元),
#         buy_volume/sell_volume(最佳買賣盤量), volume_ratio, date(時間戳), stock_id
#
# token：環境變數 FINMIND_TOKEN 或 repo 根 .env（不進 git）

from __future__ import annotations
import os
import requests
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://api.finmindtrade.com/api/v4/data"
SNAP = "https://api.finmindtrade.com/api/v4/taiwan_stock_tick_snapshot"


def token() -> str:
    t = os.environ.get("FINMIND_TOKEN")
    if t:
        return t.strip()
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("FINMIND_TOKEN="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError("找不到 FINMIND_TOKEN（環境變數或 .env）")


def api_get(dataset: str, **params) -> list:
    """通用 /api/v4/data 查詢（建分類表用）。"""
    params.update(dataset=dataset, token=token())
    r = requests.get(BASE, params=params, timeout=40)
    r.raise_for_status()
    j = r.json()
    if j.get("status") not in (200, None):
        raise RuntimeError(f"{dataset}: {j.get('msg')}")
    return j.get("data") or []


def snapshot_all() -> list:
    """全市場即時快照（一次 request、無 data_id）。"""
    r = requests.get(SNAP, params={"token": token()}, timeout=40)
    r.raise_for_status()
    j = r.json()
    if j.get("status") != 200:
        raise RuntimeError(f"snapshot: {j.get('msg')}")
    return j.get("data") or []
