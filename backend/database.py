"""SQLite database and session for Dazos CFO Copilot."""
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import declarative_base
import os

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./cfo.db")

# Timeout (seconds) for SQLite when DB is locked; reduces "database is locked" on concurrent sync + reads
_connect_args = {}
if DATABASE_URL.startswith("sqlite"):
    _connect_args["timeout"] = 30

_engine_kw: dict = {"echo": False, "connect_args": _connect_args}
# SQLite uses NullPool and doesn't support pool_size/max_overflow
if not DATABASE_URL.startswith("sqlite"):
    _engine_kw["pool_size"] = 1
    _engine_kw["max_overflow"] = 0

engine = create_async_engine(DATABASE_URL, **_engine_kw)
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
Base = declarative_base()


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
