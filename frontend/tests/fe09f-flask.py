"""Run FE-09F against real Flask with fresh, disposable loopback databases."""

import argparse
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from threading import Thread
from urllib.parse import urlsplit


def fixture_only(app):
    def dispatch(environ, start_response):
        route = (environ["REQUEST_METHOD"], environ["PATH_INFO"])
        if route not in {("GET", "/api/v2/snapshot"), ("OPTIONS", "/api/v2/sync"),
                         ("POST", "/api/v2/sync")}:
            start_response("405 Method Not Allowed", [("Content-Type", "text/plain")])
            return [b"Disposable FE-09F fixture routes only"]

        def marked_response(status, headers, exc_info=None):
            exposed = "X-Fulfil-Fixture"
            for name, value in headers:
                if name.lower() == "access-control-expose-headers":
                    exposed = value + ", " + exposed
            headers = [(name, value) for name, value in headers
                       if name.lower() != "access-control-expose-headers"]
            headers += [("X-Fulfil-Fixture", "FE-09F"), ("Access-Control-Expose-Headers", exposed)]
            return start_response(status, headers, exc_info)

        return app(environ, marked_response)

    return dispatch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("backend_root", type=Path)
    parser.add_argument("vite_origin")
    parser.add_argument("--browser-tests", action="store_true")
    options = parser.parse_args()
    origin = urlsplit(options.vite_origin)
    if (origin.scheme != "http" or origin.hostname != "127.0.0.1" or origin.port is None
            or origin.username or origin.path or origin.query or origin.fragment):
        parser.error("Use the http://127.0.0.1:<port> Vite origin.")
    sys.path.insert(0, str(options.backend_root.resolve()))
    from app import create_app
    from werkzeug.serving import make_server

    labels = ("core", "offline", "lost", "rejected", "recovery", "seed") if options.browser_tests else ("core",)
    with TemporaryDirectory(prefix="fulfil-fe09f-sqlite-") as temp:
        servers = []
        urls = {}
        try:
            for label in labels:
                database = Path(temp, label + ".sqlite")
                app = create_app({"DATABASE_URL": "sqlite:///" + database.as_posix(),
                                  "CORS_ORIGINS": [options.vite_origin], "TESTING": True})
                server = make_server("127.0.0.1", 0, fixture_only(app))
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


if __name__ == "__main__":
    main()
