"""Application factory. `create_app(overrides)` makes tests and dev runs easy."""
import json
import os
import uuid

from flask import Flask

from .core.timeutil import canonical_timestamp, utc_now
# Database modules are imported inside the functions below so that the pure
# logic in app.core can be imported and tested without SQLAlchemy installed.


def create_app(overrides=None):
    from .db import init_db, make_engine, make_session_factory

    app = Flask(__name__, instance_relative_config=True)
    os.makedirs(app.instance_path, exist_ok=True)
    app.config.update(
        DATABASE_URL="sqlite:///" + os.path.join(app.instance_path, "fulfil_dev.db"),
        NOW=utc_now,                       # tests replace this with a fixed clock
        REQUIRE_GENERATION=True,           # X-Inventory-Generation on mutations
        EXPIRATION_WARNING_DAYS=None,      # unset until the café approves a value
        BUSINESS_TIMEZONE="Asia/Manila",   # proposed, not yet confirmed
        CORS_ORIGINS=["http://localhost:5173", "http://127.0.0.1:5173"],
    )
    app.config.update(overrides or {})

    _check_timezone(app.config["BUSINESS_TIMEZONE"])

    engine = make_engine(app.config["DATABASE_URL"])
    init_db(engine)
    factory = make_session_factory(engine)
    app.extensions["engine"] = engine
    app.extensions["session_factory"] = factory
    _seed_settings(app, factory)

    from .api import bp, bp_v2
    app.register_blueprint(bp)
    app.register_blueprint(bp_v2)
    return app


def _check_timezone(name):
    """Fail at start-up with a clear message instead of a 500 on the dashboard.

    On Windows, Python has no time-zone database of its own: the `tzdata`
    package (in requirements.txt) provides it.
    """
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    try:
        ZoneInfo(name)
    except ZoneInfoNotFoundError:
        raise RuntimeError(
            f"Time zone {name!r} is not available. Run: pip install -r requirements.txt "
            "(the tzdata package provides time zones on Windows)."
        ) from None


def _seed_settings(app, factory):
    """First start: create the server generation id and default settings."""
    from .db import session_scope
    from .models import Setting

    stamp = canonical_timestamp(app.config["NOW"]())
    defaults = {
        "server_generation_id": str(uuid.uuid4()),
        "settings_version": 1,
        "business_timezone": app.config["BUSINESS_TIMEZONE"],
        "expiration_warning_days": app.config["EXPIRATION_WARNING_DAYS"],
    }
    with session_scope(factory) as s:
        for key, value in defaults.items():
            if s.get(Setting, key) is None:
                s.add(Setting(setting_key=key, value=json.dumps(value), updated_at=stamp))
