# src/server.py — 本機開發伺服器（手機正式版走 GitHub Pages + Actions，不需要這支）
#
# 提供：
#   - 靜態檔（index.html、data/*.json）
#   - GET /api/refresh → 立即重抓即時快照、重算 data/live.json 並回傳（本機按鈕即時更新用）
#
# 用法：set FINMIND_TOKEN=... ; python src/server.py  → http://127.0.0.1:8899

from __future__ import annotations
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fin  # noqa: E402
import snapshot  # noqa: E402

ROOT = fin.ROOT


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body: bytes, ctype="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/refresh":
            try:
                live = snapshot.build_live()
                self._send(200, json.dumps(live, ensure_ascii=False).encode("utf-8"))
            except Exception as e:
                self._send(500, json.dumps({"error": str(e)}, ensure_ascii=False).encode("utf-8"))
            return
        rel = path.lstrip("/") or "index.html"
        fp = (ROOT / rel).resolve()
        if not str(fp).startswith(str(ROOT)) or not fp.is_file():
            self._send(404, b'{"error":"not found"}')
            return
        ctype = {"html": "text/html; charset=utf-8", "json": "application/json; charset=utf-8",
                 "js": "text/javascript", "css": "text/css"}.get(fp.suffix[1:], "application/octet-stream")
        self._send(200, fp.read_bytes(), ctype)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8899"))
    print(f"taiwan-flow-live 本機伺服器：http://127.0.0.1:{port}  （/api/refresh 即時重算）")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
