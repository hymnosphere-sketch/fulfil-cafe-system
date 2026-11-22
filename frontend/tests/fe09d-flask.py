"""Serve only disposable FE-09D Flask fixtures on loopback."""
import json
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
import sys
from threading import Thread

sys.path.insert(0, sys.argv[1])
from app import create_app
from werkzeug.serving import make_server

root = Path(sys.argv[2])
origin = sys.argv[3]
labels = ("ordered", "single", "owners", "persistence", "rejection",
          "temporary", "invalid", "lost", "restart", "generation", "other")
routes = {("GET", "/api/v2/snapshot"), ("OPTIONS", "/api/v2/sync"), ("POST", "/api/v2/sync")}
clock = lambda: datetime(2026, 11, 19, 3, tzinfo=timezone.utc)


def fixture_app(app, path, label):
    locked = False

    def dispatch(environ, start_response):
        nonlocal locked
        route = (environ["REQUEST_METHOD"], environ["PATH_INFO"])
        if route not in routes:
            start_response("405 Method Not Allowed", [("Content-Type", "text/plain")])
            return [b"Disposable FE-09D fixture routes only"]
        if label != "temporary" or locked or route[0] != "POST":
            return app(environ, start_response)
        locked = True
        conn = sqlite3.connect(path)
        try:
            conn.execute("BEGIN IMMEDIATE")
            return list(app(environ, start_response))
        finally:
            conn.rollback()
            conn.close()

    return dispatch


servers = []
urls = {}
try:
    for label in labels:
        path = root / (label + ".sqlite")
        assert not path.exists(), path
        app = create_app({"DATABASE_URL": "sqlite:///" + path.as_posix(),
                          "CORS_ORIGINS": [origin], "NOW": clock, "TESTING": True})
        server = make_server("127.0.0.1", 0, fixture_app(app, path, label))
        servers.append((server, app))
        urls[label] = f"http://127.0.0.1:{server.server_port}"
        Thread(target=server.serve_forever, daemon=True).start()
    print(json.dumps(urls), flush=True)
    sys.stdin.readline()
finally:
    for server, app in servers:
        server.shutdown()
        server.server_close()
        app.extensions["engine"].dispose()
