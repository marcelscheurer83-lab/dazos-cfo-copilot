"""SQLite database and session for Dazos CFO Copilot."""
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import declarative_base
import os

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./cfo.db")

# Timeout (seconds) for SQLite when DB is locked; reduces "database is locked" on concurrent sheet sync + dashboard reads
_connect_args = {}
if DATABASE_URL.startswith("sqlite"):
    _connect_args["timeout"] = 15

engine = create_async_engine(DATABASE_URL, echo=False, connect_args=_connect_args)
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
