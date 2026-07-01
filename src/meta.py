# src/meta.py — 建立分類對照表 data/classify.json（偶爾跑，變動慢）
#
# code -> {n:名稱, e:交易所產業別, c:[產業鏈節點], p:[[產業,次產業]...]}
#   e 來自 TaiwanStockInfo.industry_category（含上櫃ETF命名正規化）
#   c/p 來自 TaiwanStockIndustryChain（產業鏈，多對多 + 次產業配對）
#
# 用法：python src/meta.py

from __future__ import annotations
import json
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fin  # noqa: E402

OUT = fin.ROOT / "data" / "classify.json"
TPE = timezone(timedelta(hours=8))
# 交易所產業別命名正規化：櫃買兩個「上櫃ETF」字串合併（與 taiwan-flows 一致）
EXCH_ALIAS = {"上櫃指數股票型基金(ETF)": "上櫃ETF"}


def build() -> dict:
    print("抓 TaiwanStockInfo …")
    info = fin.api_get("TaiwanStockInfo")
    print("抓 TaiwanStockIndustryChain …")
    chain = fin.api_get("TaiwanStockIndustryChain")
    print("抓 TaiwanStockShareholding（發行股數，指數貢獻點數用）…")
    today = datetime.now(TPE).date()
    start = (today - timedelta(days=18)).isoformat()
    share = fin.api_get("TaiwanStockShareholding", start_date=start, end_date=today.isoformat())

    name, exch, mtype = {}, {}, {}
    for r in info:
        c = str(r["stock_id"])
        name[c] = r.get("stock_name") or c
        ind = str(r.get("industry_category") or "").strip()
        ind = EXCH_ALIAS.get(ind, ind) or "其他"
        exch.setdefault(c, ind)
        mtype.setdefault(c, str(r.get("type") or ""))  # twse / tpex

    # 發行股數（張）：取區間內最新一筆
    shares = {}
    for r in sorted(share, key=lambda x: x.get("date") or ""):
        v = r.get("NumberOfSharesIssued")
        if v:
            shares[str(r["stock_id"])] = round(float(v) / 1000)

    ch: dict[str, dict] = {}
    for r in chain:
        c = str(r["stock_id"])
        e = ch.setdefault(c, {"c": [], "p": []})
        i, s = str(r.get("industry") or ""), str(r.get("sub_industry") or "")
        if i and i not in e["c"]:
            e["c"].append(i)
        if i and s and [i, s] not in e["p"]:
            e["p"].append([i, s])

    m = {}
    for c in set(list(name) + list(exch) + list(ch)):
        e = ch.get(c, {"c": [], "p": []})
        m[c] = {"n": name.get(c, c), "e": exch.get(c, "其他"), "c": e["c"], "p": e["p"],
                "t": mtype.get(c, ""), "sh": shares.get(c, 0)}  # t:市場(twse/tpex)、sh:發行張數

    snap = {"generated_at": datetime.now(TPE).isoformat(), "count": len(m), "map": m}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(snap, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n_chain = sum(1 for v in m.values() if v["c"])
    n_sh = sum(1 for v in m.values() if v["sh"])
    print(f"已寫入 {OUT.relative_to(fin.ROOT)}：{len(m)} 檔（產業鏈 {n_chain}、有發行股數 {n_sh}）, "
          f"{OUT.stat().st_size/1024:.0f} KB")
    return snap


if __name__ == "__main__":
    build()
