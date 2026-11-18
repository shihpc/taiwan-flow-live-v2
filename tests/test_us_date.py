# tests/test_us_date.py — us.json 頂層 date／brief 不混日／us.yml 齊全判斷（免 token 免網路）
#
# 守的是 2026-11-18 事故：頂層 date 原取各列資料日的 max，FinMind 美股日線逐檔滾動入庫時
# 24 列只有 AAPL 先到 11-17、其餘 23 列（^SOX -5.28、TSM -6.34）仍是 11-16，檔案卻標
# date=2026-11-17、brief 寫「11/17美股大跌，費半-5.3%…」（commit 0e81002 的 data/us.json）。
# 修法：date 改各列資料日的眾數、平手取較舊者（build_us.pick_us_date）；brief 只引用
# d == date 的列；us.yml 的齊全判斷（build_us.rows_complete）多看「有沒有列超前 date」。
# fixture tests/fixtures/us_incident_20261118.json＝該 commit 的 groups 原樣（含頂層 date／brief 供對照）。
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import build_us  # noqa: E402
from build_us import all_rows, brief, pick_us_date, rows_complete  # noqa: E402

OLD, NEW = "2026-11-16", "2026-11-17"


def incident() -> dict:
    return json.loads((ROOT / "tests/fixtures/us_incident_20261118.json").read_text(encoding="utf-8"))


def redate(doc: dict, new_syms) -> dict:
    """把指定代號的列改成 NEW、其餘 OLD（只動 d，數字不動）。"""
    for r in all_rows(doc["groups"]):
        r["d"] = NEW if r["s"] in new_syms else OLD
    return doc


# ---------- pick_us_date ----------

def test_incident_shape_is_what_we_think():
    """fixture 自檢：24 列、1 列新（AAPL）23 列舊，舊口徑 max 給出錯的 11-17。"""
    doc = incident()
    ds = [r["d"] for r in all_rows(doc["groups"])]
    assert len(ds) == 24 and ds.count(NEW) == 1 and ds.count(OLD) == 23
    assert doc["date"] == NEW and max(ds) == NEW          # 事故當時的錯誤標示（對照）
    assert [r["s"] for r in all_rows(doc["groups"]) if r["d"] == NEW] == ["AAPL"]


def test_incident_date_is_majority_day():
    doc = incident()
    assert pick_us_date(r["d"] for r in all_rows(doc["groups"])) == OLD


def test_unanimous():
    assert pick_us_date([NEW] * 24) == NEW
    assert pick_us_date([OLD] * 24) == OLD


def test_majority_new_advances():
    """過半已新（13 新 11 舊）→ 推進到新日。"""
    assert pick_us_date([NEW] * 13 + [OLD] * 11) == NEW


def test_tie_takes_older():
    """平手（12:12）取較舊者——與 pick_primary（平手取大）刻意相反，順序無關。"""
    assert pick_us_date([NEW] * 12 + [OLD] * 12) == OLD
    assert pick_us_date([OLD] * 12 + [NEW] * 12) == OLD
    assert pick_us_date([OLD, NEW]) == OLD


def test_three_way_tie_takes_oldest():
    assert pick_us_date(["2026-11-17", "2026-11-13", "2026-11-16"]) == "2026-11-13"


def test_single_row_and_empty():
    assert pick_us_date([NEW]) == NEW
    assert pick_us_date([]) is None
    assert pick_us_date([None, ""]) is None


def test_timestamp_strings_are_cut_to_day():
    assert pick_us_date(["2026-11-16 00:00:00", "2026-11-16", "2026-11-17"]) == OLD


# ---------- brief 不混日 ----------

def test_incident_brief_uses_majority_day_numbers():
    doc = incident()
    d = pick_us_date(r["d"] for r in all_rows(doc["groups"]))
    b = brief(doc["groups"], d)
    assert b.startswith("11/16美股大跌")
    assert "費半-5.3%重挫" in b and "台積ADR-6.3%" in b
    assert "11/17" not in b


def test_brief_drops_row_of_other_day_tsm():
    """TSM 先到新日、其餘舊日 → date 仍舊日，brief 不得出現 TSM，也不得有靠 TSM 算的開盤含義。"""
    doc = redate(incident(), {"TSM"})
    d = pick_us_date(r["d"] for r in all_rows(doc["groups"]))
    assert d == OLD
    b = brief(doc["groups"], d)
    assert b.startswith("11/16") and "費半-5.3%" in b
    assert "台積ADR" not in b and "電子開盤" not in b


def test_brief_drops_sox_and_extreme_stock_of_other_day():
    doc = redate(incident(), {"^SOX", "SNDK"})
    b = brief(doc["groups"], OLD)
    assert "費半" not in b and "電子開盤" not in b and "SanDisk" not in b
    assert "台積ADR-6.3%" in b
    # 極端個股改由同日的列裡挑（MU -7.62 是剩下最大的）
    assert "美光-7.6%領跌" in b


def test_brief_tone_only_from_same_day_indices():
    """三大指數只有道瓊同日 → 定調只看道瓊（-1.41 → 收跌、未達 2% 不寫「大跌」）。"""
    doc = redate(incident(), {"^GSPC", "^IXIC"})
    # 這裡直接指定 OLD 當 date（多數列仍是 OLD）
    b = brief(doc["groups"], OLD)
    assert b.startswith("11/16美股收跌")


def test_brief_all_filtered_is_empty_string():
    doc = incident()
    assert brief(doc["groups"], "2026-11-10") == ""
    assert brief([], None) == ""
    assert brief([{"g": "指數", "rows": []}], OLD) == ""


def test_brief_unchanged_when_all_same_day():
    """全同日時輸出與舊版逐字相同（以事故檔數字、全部標成同一天，對照當時 brief 的非日期部分）。"""
    doc = redate(incident(), set())
    b = brief(doc["groups"], OLD)
    assert b == incident()["brief"].replace("11/17", "11/16")


# ---------- main()：頂層 date／brief／session 用同一個值 ----------

def _fake_api(doc):
    by = {r["s"]: r for r in all_rows(doc["groups"])}

    def api_get(dataset, **kw):
        if dataset == "USStockPrice":
            r = by[kw["data_id"]]
            pc = 100.0
            c = round(pc * (1 + r["chg"] / 100), 6)
            return [{"date": "2026-11-13", "Close": pc, "High": pc, "Low": pc, "Volume": 1},
                    {"date": r["d"], "Close": c, "High": c, "Low": c, "Volume": 1}]
        if dataset == "USStockPriceMinute":
            api_get.minute_dates.append(kw["start_date"])
            return []
        return []          # 匯率／台股收盤：空 → fx None、不算溢價
    api_get.minute_dates = []
    return api_get


def test_main_writes_majority_date(tmp_path, monkeypatch):
    api = _fake_api(incident())
    monkeypatch.setattr(build_us.fin, "api_get", api)
    monkeypatch.setattr(build_us, "OUT", tmp_path / "us.json")
    build_us.main()
    out = json.loads((tmp_path / "us.json").read_text(encoding="utf-8"))
    assert out["date"] == OLD
    assert out["brief"].startswith("11/16") and "費半-5.3%" in out["brief"] and "台積ADR-6.3%" in out["brief"]
    assert set(api.minute_dates) == {OLD}          # session 的分鐘 K 也只查同一個日期
    aapl = next(r for r in all_rows(out["groups"]) if r["s"] == "AAPL")
    assert aapl["d"] == NEW                        # 列自帶的 d 不動（鍵名與形狀不變）
    assert list(out) == ["date", "fx", "generated_at", "brief", "session", "groups"]
    assert rows_complete(out) is False             # 有超前列 → us.yml 不得宣告已齊


# ---------- rows_complete（us.yml 的 fresh）----------

def _doc(n_new, n_old, date_=None):
    rows = [{"s": f"N{i}", "d": NEW} for i in range(n_new)] + [{"s": f"O{i}", "d": OLD} for i in range(n_old)]
    return {"date": date_ or pick_us_date(r["d"] for r in rows), "groups": [{"g": "x", "rows": rows}]}


def test_complete_incident_shape_is_not_complete():
    """1 新 23 舊：date=舊日，但有列超前 → 不算齊（新一日正在入庫）。"""
    d = _doc(1, 23)
    assert d["date"] == OLD and rows_complete(d) is False


def test_complete_all_same_day():
    assert rows_complete(_doc(24, 0)) is True
    assert rows_complete(_doc(0, 24)) is True


def test_complete_behind_threshold_one_third():
    assert rows_complete(_doc(16, 8)) is True       # 落後 8/24＝1/3 → 齊（沿用舊門檻）
    assert rows_complete(_doc(15, 9)) is False      # 落後 >1/3
    assert rows_complete(_doc(13, 11)) is False     # 剛過半：date 已推進但還不算齊


def test_complete_tie_is_not_complete():
    d = _doc(12, 12)
    assert d["date"] == OLD and rows_complete(d) is False


def test_complete_empty_or_no_date():
    assert rows_complete({"date": None, "groups": []}) is False
    assert rows_complete({"date": OLD, "groups": [{"g": "x", "rows": []}]}) is False
    assert rows_complete({}) is False
    assert rows_complete({"date": None, "groups": [{"g": "x", "rows": [{"s": "A", "d": OLD}]}]}) is False


def test_us_yml_uses_rows_complete():
    """workflow 的齊全判斷必須走 build_us.py --complete（不得留著只數落後列的舊內嵌算式）。"""
    y = (ROOT / ".github/workflows/us.yml").read_text(encoding="utf-8")
    assert "fresh=$(python src/build_us.py --complete)" in y
    assert "stale*3<=len(rows)" not in y
    assert '[ "$new" != "$prev" ] && [ "$fresh" = "yes" ]' in y


def test_complete_bad_shapes_never_raise():
    """形狀異常一律未齊、不拋例外（非字串 d 視為不可信）。"""
    ok = _doc(24, 0)
    assert rows_complete(ok) is True
    bad_d = _doc(24, 0); bad_d["groups"][0]["rows"][3]["d"] = 20261117
    none_d = _doc(24, 0); none_d["groups"][0]["rows"][3]["d"] = None
    for bad in (bad_d, none_d, None, [], "x", {"date": 20261117, "groups": ok["groups"]},
                {"date": NEW, "groups": "x"}, {"date": NEW, "groups": [{"g": "x", "rows": [1, 2]}]},
                {"date": NEW, "groups": [None]}):
        assert rows_complete(bad) is False


def _cli(*args):
    """以子行程實跑 `python src/build_us.py --complete …`；環境不含 FINMIND_TOKEN。"""
    env = {"PATH": "/usr/bin:/bin", "PYTHONPATH": ":".join(p for p in sys.path if p)}
    assert "FINMIND_TOKEN" not in env
    r = subprocess.run([sys.executable, str(ROOT / "src/build_us.py"), "--complete", *args],
                       capture_output=True, text=True, env=env, cwd=ROOT)
    return r.returncode, r.stdout, r.stderr


def _write(tmp_path, doc_or_text):
    p = tmp_path / "us.json"
    p.write_text(doc_or_text if isinstance(doc_or_text, str) else json.dumps(doc_or_text), encoding="utf-8")
    return str(p)


def test_cli_complete_incident_shape_says_no(tmp_path):
    doc = incident()
    doc["date"] = pick_us_date(r["d"] for r in all_rows(doc["groups"]))     # 新口徑下的 date＝11-16
    rc, out, err = _cli(_write(tmp_path, doc))
    assert (rc, out) == (0, "no\n"), err


def test_cli_complete_all_same_day_says_yes(tmp_path):
    rc, out, err = _cli(_write(tmp_path, redate(incident() | {"date": OLD}, set())))
    assert (rc, out) == (0, "yes\n"), err


def test_cli_complete_missing_bad_json_int_d_say_no(tmp_path):
    assert _cli(str(tmp_path / "nope.json"))[:2] == (0, "no\n")
    assert _cli(_write(tmp_path, "{not json"))[:2] == (0, "no\n")
    doc = redate(incident() | {"date": OLD}, set())
    doc["groups"][0]["rows"][0]["d"] = 20261116
    assert _cli(_write(tmp_path, doc))[:2] == (0, "no\n")


def test_cli_complete_default_path_prints_one_line():
    """不帶路徑＝讀 repo 的 data/us.json（us.yml 的用法）：只印 yes/no 一行、rc 0。"""
    rc, out, err = _cli()
    assert rc == 0 and out in ("yes\n", "no\n"), err


# ---------- Worker 三處守門在新口徑下恢復作用（只讀 worker/src/index.js，不改它）----------

NODE = shutil.which("node")
WORKER_JS = r"""
import { lastExpectedUsTradingDate, productFresh, backupPipelines, runUsCatchup,
  buildCardsData, cardSourceUrls } from "%s";
const TODAY = "2026-11-18";                      // 台北週三
const ENV = { DATA_BASE: "https://raw.githubusercontent.com/shihpc/taiwan-flow-live-v2/main/data" };
const us = (date) => ({ date, generated_at: TODAY + "T06:58:34+08:00", brief: "美股收跌。",
  groups: [{ g: "指數", rows: [{ n: "道瓊", chg: -1.4 }, { n: "那斯達克", chg: -2.5 }] }] });
const usPipe = backupPipelines(ENV).find((p) => p.name === "us");
const tp = { date: TODAY, dow: 3, hour: 7, minute: 10 };
const usFetch = (obj) => async () => ({ ok: true, status: 200, json: async () => obj });
const U = cardSourceUrls(ENV, TODAY, "am");
const cardFetch = (obj) => async (u) => {
  const s = String(u).split("?")[0];
  const o = s === U.us ? obj : null;
  return { ok: o != null, status: o ? 200 : 404, json: async () => o };
};
const ids = async (obj) => (await buildCardsData(ENV, { date: TODAY, dow: 3, hour: 8, minute: 20 },
  cardFetch(obj), { slot: "am" })).cards.map((c) => c.id);
const env = { ...ENV, GH_DISPATCH_TOKEN: "T" };
console.log(JSON.stringify({
  expected: lastExpectedUsTradingDate(TODAY),
  usField: usPipe.field, usMode: usPipe.mode,
  freshNew: productFresh(us("2026-11-17"), usPipe, TODAY),
  freshOld: productFresh(us("2026-11-16"), usPipe, TODAY),
  catchupOld: await runUsCatchup(env, tp, usFetch(us("2026-11-16")), { dry: true }),
  catchupNew: await runUsCatchup(env, tp, usFetch(us("2026-11-17")), { dry: true }),
  cardsOld: await ids(us("2026-11-16")),
  cardsNew: await ids(us("2026-11-17")),
}));
"""


@pytest.mark.skipif(NODE is None, reason="需要 node")
def test_worker_guards_block_when_date_is_majority_day():
    """date=2026-11-16、台北 2026-11-18（週三）07:10：預期美股交易日 11-17 →
    補跑班會 dispatch、usDate 判不新鮮、晨卡 news-morning-4 被擋；date=11-17 時三者反向。
    事故當時 date 被標成 11-17，三道守門因此全部放行。"""
    src = WORKER_JS % (ROOT / "worker/src/index.js").as_uri()
    r = subprocess.run([NODE, "--input-type=module", "-e", src], capture_output=True, text=True, cwd=ROOT)
    assert r.returncode == 0, r.stderr
    o = json.loads(r.stdout.strip().splitlines()[-1])
    assert o["expected"] == "2026-11-17"
    assert o["usField"] == "date" and o["usMode"] == "usDate"
    assert o["freshOld"] is False and o["freshNew"] is True
    assert o["catchupOld"].get("wouldDispatch") is True and o["catchupOld"]["usDate"] == "2026-11-16"
    assert o["catchupNew"].get("fresh") is True
    assert "news-morning-4" not in o["cardsOld"]
    assert "news-morning-4" in o["cardsNew"]
