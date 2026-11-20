"""Engine and session setup.

Two SQLite details matter for this project:
1. Foreign keys are OFF by default in SQLite, so we switch them on per
   connection.
2. API_CONTRACT requires validation and writing to happen in one serialized
   transaction. `BEGIN IMMEDIATE` takes SQLite's write lock at the start, so a
   second request cannot validate against stock that is about to change.
"""
import threading
from contextlib import contextmanager

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from .models import Base


# Per-thread flag read by the "begin" hook below. Writers (the default) take
# SQLite's write lock up front; read-only requests use a plain BEGIN so a page
# of GETs can never block, or be blocked by, a stock movement being saved.
_mode = threading.local()


def make_engine(url):
    engine = create_engine(url, future=True)

    @event.listens_for(engine, "connect")
    def _on_connect(dbapi_conn, _record):
        dbapi_conn.isolation_level = None  # we control BEGIN ourselves
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    @event.listens_for(engine, "begin")
    def _on_begin(conn):
        write = getattr(_mode, "write", True)
        conn.exec_driver_sql("BEGIN IMMEDIATE" if write else "BEGIN")

    return engine


def init_db(engine):
    Base.metadata.create_all(engine)


def make_session_factory(engine):
    return sessionmaker(bind=engine, expire_on_commit=False, future=True)


@contextmanager
def session_scope(factory, write=True):
    """Commit on success, roll back on any error. One request = one scope.

    write=True  -> BEGIN IMMEDIATE (serialized; use for every mutation).
    write=False -> plain BEGIN (reads only; still one consistent view).
    """
    previous = getattr(_mode, "write", True)
    _mode.write = write
    session = factory()
    try:
        yield session
        session.commit()
    except BaseException:
        session.rollback()
        raise
    finally:
        session.close()
        _mode.write = previous
