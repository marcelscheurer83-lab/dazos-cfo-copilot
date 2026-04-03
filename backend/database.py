"""SQLite database and session for Dazos CFO Cockpit."""
import os

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import declarative_base

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./cfo.db")

# Timeout (seconds) for SQLite when DB is locked; reduces "database is locked" on concurrent sync + reads
_connect_args = {}
if DATABASE_URL.startswith("sqlite"):
    # Seconds to wait when DB is locked (python sqlite3). Also set PRAGMA busy_timeout below (ms).
    _connect_args["timeout"] = float(os.getenv("SQLITE_LOCK_TIMEOUT_SECONDS", "120"))

_engine_kw: dict = {"echo": False, "connect_args": _connect_args}
# SQLite uses NullPool and doesn't support pool_size/max_overflow
if not DATABASE_URL.startswith("sqlite"):
    _engine_kw["pool_size"] = 1
    _engine_kw["max_overflow"] = 0

engine = create_async_engine(DATABASE_URL, **_engine_kw)
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
Base = declarative_base()


def _sqlite_connect_pragma(dbapi_conn, _connection_record):
    """WAL improves read/write concurrency; busy_timeout backs up connect timeout for lock waits."""
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA synchronous=NORMAL")
    busy_ms = int(float(os.getenv("SQLITE_BUSY_TIMEOUT_MS", "120000")))
    cur.execute(f"PRAGMA busy_timeout={busy_ms}")
    cur.close()


if DATABASE_URL.startswith("sqlite"):
    event.listens_for(engine.sync_engine, "connect")(_sqlite_connect_pragma)


async def get_db():
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()
