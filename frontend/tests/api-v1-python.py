"""Verify fixtures or serve a disposable copy of the audited Flask backend."""

import argparse
from datetime import datetime, timezone
from importlib.metadata import version
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from threading import Thread
import unittest
import zipfile


BACKEND_COMMIT = "76eec40bb5c645bd41b5df501ee8ac9c7ccf5564"
TESTS = Path(__file__).resolve().parent
REPOSITORY = TESTS.parents[1]


def export_backend(destination):
    archive = subprocess.check_output([
        "git", "-C", str(REPOSITORY), "archive", "--format=zip", BACKEND_COMMIT, "backend"
    ])
    with zipfile.ZipFile(io.BytesIO(archive)) as files:
        files.extractall(destination)
    backend = Path(destination, "backend")
    sys.path.insert(0, str(backend))
    return backend


def disposable_app(database):
    from app import create_app

    return create_app({
        "DATABASE_URL": "sqlite:///" + database.as_posix(),
        "NOW": lambda: datetime(2026, 11, 19, 3, tzinfo=timezone.utc),
        "TESTING": True,
    })


def expect(actual, expected, label):
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def verify_shared_fixtures(database):
    from app.core.canonical import build_command, canonical_json, fingerprint
    from app.core.commands import validate_payload
    from app.core.normalize import display_name, normalize_name

    fixture_path = TESTS / "fixtures" / "api-v1-commands.json"
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    expect(fixture["backendCommit"], BACKEND_COMMIT, "backend pin")
    application = disposable_app(database)
    valid_count = rejected_count = 0
    try:
        client = application.test_client()
        health = client.get("/api/v1/health")
        expect(health.status_code, 200, "fixture health response")
        headers = {"X-Inventory-Generation": health.headers["X-Inventory-Generation"]}
        for case in fixture["cases"]:
            label = case["name"]
            command = case["command"]
            if case["valid"]:
                operation = command["operation_type"]
                normalized = validate_payload(operation, command["payload"])
                canonical = build_command(operation, command["entity_id"], command["created_at"], normalized)
                expect(canonical_json(canonical), case["canonical"], label + " canonical JSON")
                expect(fingerprint(canonical), case["fingerprint"], label + " SHA-256")
                valid_count += 1
            else:
                response = client.post("/api/v1/sync", json=command, headers=headers)
                expect(response.status_code, case["pythonStatus"], label + " HTTP status")
                expect(response.get_json()["error"]["code"], case["pythonError"], label + " error code")
                rejected_count += 1
        for sample in fixture["normalization"]:
            expect(display_name(sample["input"]), sample["pythonDisplay"], sample["name"] + " display")
            expect(normalize_name(sample["input"]), sample["pythonNormalized"], sample["name"] + " full case fold")
        for sample in fixture["serialization"]:
            expect(canonical_json(sample["value"]), sample["canonical"], sample["name"] + " canonical JSON")
            expect(fingerprint(sample["value"]), sample["fingerprint"], sample["name"] + " SHA-256")
        for sample in fixture["rawRejections"]:
            response = client.post(
                "/api/v1/sync", data=sample["raw"], content_type="application/json", headers=headers
            )
            expect(response.status_code, sample["pythonStatus"], sample["name"] + " HTTP status")
            expect(response.get_json()["error"]["code"], sample["pythonError"], sample["name"] + " error code")
        print(
            f"Shared fixtures: {valid_count} canonical commands, {rejected_count} HTTP error cases, "
            f"{len(fixture['normalization'])} name normalization cases, "
            f"{len(fixture['serialization'])} serialization cases, "
            f"{len(fixture['rawRejections'])} raw request rejections.",
            flush=True,
        )
    finally:
        application.extensions["engine"].dispose()


def run_backend_suite(backend):
    tests = unittest.defaultTestLoader.discover(str(backend / "tests"), top_level_dir=str(backend))
    result = unittest.TextTestRunner(verbosity=1).run(tests)
    expect(result.testsRun, 59, "backend tests executed")
    expect(len(result.skipped), 0, "backend skips")
    if not result.wasSuccessful():
        raise SystemExit(1)
    versions = ", ".join(f"{package} {version(package)}" for package in ("Flask", "SQLAlchemy", "tzdata"))
    print(f"Pinned backend {BACKEND_COMMIT}. {versions}.", flush=True)


def serve(database):
    from werkzeug.serving import make_server

    application = disposable_app(database)
    server = make_server("127.0.0.1", 0, application)

    def stop_on_stdin_close():
        sys.stdin.read()
        server.shutdown()

    shutdown = Thread(target=stop_on_stdin_close, daemon=True)
    shutdown.start()
    try:
        print(f"http://127.0.0.1:{server.server_port}/api/v1/", flush=True)
        server.serve_forever()
    finally:
        server.server_close()
        application.extensions["engine"].dispose()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--serve", action="store_true", help="serve a fresh database until stdin closes")
    mode.add_argument("--backend-tests-only", action="store_true", help="run the pinned backend test suite alone")
    args = parser.parse_args()
    sys.dont_write_bytecode = True
    with tempfile.TemporaryDirectory(prefix="fulfil-fe09b-") as directory:
        backend = export_backend(directory)
        database = Path(directory, "integration.sqlite")
        if args.serve:
            serve(database)
        else:
            run_backend_suite(backend)
            if not args.backend_tests_only:
                verify_shared_fixtures(database)


if __name__ == "__main__":
    main()
