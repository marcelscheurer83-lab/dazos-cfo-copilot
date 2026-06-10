"""
Dazos CFO Cockpit — FastAPI backend.
Dashboard, P&L, cash flow, budget vs actuals, and Copilot Q&A.
Background jobs use America/New_York (EST/EDT): optional hourly Salesforce sync; daily EOD snapshot at 23:59:59 EST from current DB (Salesforce rows reflect Dashboard → Refresh app data unless hourly sync is enabled).
"""
import asyncio
import calendar
import json
import logging
import time
import os
import re
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
from typing import Any, Callable, List, Optional

from dotenv import load_dotenv, dotenv_values
from fastapi import FastAPI, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from sqlalchemy import select, delete, func, or_, and_
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db, AsyncSessionLocal

try:
    import anthropic as _anthropic_mod
    _ANTHROPIC_AVAILABLE = True
except ImportError:
    _anthropic_mod = None  # type: ignore
    _ANTHROPIC_AVAILABLE = False

# Serialize unified dataset refresh (Salesforce + Sheets + Chargebee); commit inside lock to avoid overlapping SQLite writes.
_dataset_refresh_lock = asyncio.Lock()
# Backwards-compatible alias (scheduled job / comments)
_salesforce_sync_lock = _dataset_refresh_lock
from models import (
    Company,
    KPI,
    PnLLine,
    CashFlowLine,
    BudgetLine,
    BalanceSheetLine,
    DeptDetailLine,
    FinancialAnalysis,
    SheetSnapshot,
    Account,
    Opportunity,
    OpportunityLineItem,
    OpportunityRecordTypeOverride,
    ActiveARRAccountOverride,
    QuickBooksReportSnapshot,
    ChargebeeSnapshot,
    AppDatasetState,
    SalesforceEODSnapshot,
    ARRScheduleDaily,
    ARRSchedulePeriod,
    MonthlyArrSnapshot,
    OppFieldHistory,
    OppNote,
    OppActivity,
    AIForecastObservations,
    DealAIScore,
    ForecastSnapshot,
    ChurnRecord,
    ChurnObservations,
    WeeklyBriefing,
    ConversationMessage,
)
from schemas import (
    KPISummary,
    PnLLineOut,
    CashFlowLineOut,
    BalanceSheetLineOut,
    DeptDetailLineOut,
    BudgetVsActualOut,
    FinancialAnalysisOut,
    FPAChatRequest,
    FPAChatResponse,
    CopilotRequest,
    CopilotResponse,
    DashboardKPI,
    BookingsMTDResponse,
    BookingsMTDRow,
    BookingsPeriod,
    CashMTDResponse,
    CashPeriod,
    RenewalsMTDResponse,
    RenewalsMTDRow,
    RenewalsPeriod,
    RenewalsChartMonth,
    RenewalsOverviewRow,
    RenewalsOverviewResponse,
    WeeklyBriefingResponse,
    AgentChatRequest,
)
from seed_data import seed


async def _remove_ascension_ascend_overrides():
    """Remove Ascension and Ascend Active ARR overrides so local and deployed stay in sync (no hardcoded overrides)."""
    async with AsyncSessionLocal() as db:
        try:
            r = await db.execute(select(ActiveARRAccountOverride))
            rows = r.scalars().all()
            for row in rows:
                name_lower = (row.account_name or "").strip().lower()
                if name_lower == "ascension recovery services" or "ascend" in name_lower:
                    await db.delete(row)
            await db.commit()
        except Exception:
            await db.rollback()


def _is_ascension_or_ascend_account(account_name: Optional[str]) -> bool:
    n = (account_name or "").strip().lower()
    return n == "ascension recovery services" or "ascend" in n


async def _remove_ascension_ascend_record_type_overrides():
    """Remove record-type overrides (e.g. Amendment) for opportunities belonging to Ascension or Ascend.
    Find opps by account_name containing 'ascension' or 'ascend' so we don't miss due to name variants."""
    async with AsyncSessionLocal() as db:
        try:
            # Find all opportunity sf_ids for accounts whose name contains ascension or ascend
            q_opps = select(Opportunity.sf_id).where(
                or_(
                    func.lower(Opportunity.account_name).like("%ascension%"),
                    func.lower(Opportunity.account_name).like("%ascend%"),
                )
            )
            r_opps = await db.execute(q_opps)
            target_sf_ids = set((row[0] or "").strip() for row in r_opps.all() if (row[0] or "").strip())
            # Also 15-char form for matching
            expand = set(target_sf_ids)
            for i in target_sf_ids:
                if len(i) == 18:
                    expand.add(i[:15])
            target_sf_ids = expand
            if not target_sf_ids:
                return
            q = select(OpportunityRecordTypeOverride)
            r = await db.execute(q)
            for row in r.scalars().all():
                sf_id = (row.opportunity_sf_id or "").strip()
                if sf_id in target_sf_ids or (len(sf_id) == 18 and sf_id[:15] in target_sf_ids):
                    await db.delete(row)
            await db.commit()
        except Exception:
            await db.rollback()


# Load .env from backend directory so GOOGLE_SHEET_ID etc. are available so GOOGLE_SHEET_ID etc. are available
load_dotenv(Path(__file__).resolve().parent / ".env", override=True)

# App password: read from .env file first; if not set there, use system env (for deployed hosts that set APP_PASSWORD in the environment).
_env_path = Path(__file__).resolve().parent / ".env"
_env_dict = dotenv_values(str(_env_path)) if _env_path.exists() else {}
_app_password_raw = _env_dict.get("APP_PASSWORD") or os.getenv("APP_PASSWORD")
APP_PASSWORD = (_app_password_raw or "").strip().strip('"').strip("'") or None

ANTHROPIC_API_KEY = (os.getenv("ANTHROPIC_API_KEY") or "").strip() or None

EST = ZoneInfo("America/New_York")


def _app_dataset_updated_at_as_utc(dt: datetime) -> datetime:
    """Interpret stored refresh time as a UTC instant (legacy rows may be naive UTC)."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _format_updated_at_utc_display(dt: datetime) -> str:
    """Human-readable UTC for dashboard (stored instant is UTC)."""
    utc = _app_dataset_updated_at_as_utc(dt)
    hm = utc.strftime("%I:%M %p")
    if len(hm) >= 2 and hm[0] == "0":
        hm = hm[1:]
    return f"{utc.strftime('%b %d, %Y')}, {hm} UTC"


def _step_is_unified_quickbooks(s: dict) -> bool:
    """Legacy unified refresh used step 'quickbooks'; tolerate casing/variants."""
    st = str(s.get("step", "") or "").strip().lower()
    return st == "quickbooks" or st.startswith("quickbooks:") or "quickbook" in st


def _is_quickbooks_only_dataset_error(err: str) -> bool:
    """Errors that can no longer occur in Refresh app data (QB removed from pipeline)."""
    if not err:
        return False
    if "QuickBooks" in err:
        return True
    return "ProfitAndLoss" in err and "failed" in err.lower()


async def _scrub_legacy_quickbooks_from_dataset_state(db: AsyncSession, row: AppDatasetState) -> None:
    """Remove legacy QuickBooks steps/errors from app_dataset_state (unified refresh no longer syncs QB)."""
    try:
        steps = json.loads(row.steps_json or "[]")
    except json.JSONDecodeError:
        steps = []
    if not isinstance(steps, list):
        steps = []
    new_steps = [s for s in steps if not (isinstance(s, dict) and _step_is_unified_quickbooks(s))]
    had_qb = len(new_steps) != len(steps)
    err = row.last_error or ""
    qb_err_only = _is_quickbooks_only_dataset_error(err)
    if not had_qb and not qb_err_only:
        return
    if had_qb:
        row.steps_json = json.dumps(new_steps)
    other_failed = any(s.get("ok") is False for s in new_steps if isinstance(s, dict))
    if qb_err_only:
        row.last_error = None
    row.last_refresh_ok = 0 if other_failed else 1
    await db.commit()


async def _force_clear_quickbooks_dataset_error(db: AsyncSession, row: AppDatasetState) -> None:
    """Last resort: clear last_error if it still mentions QuickBooks/ProfitAndLoss (legacy token errors)."""
    err = row.last_error or ""
    if not err:
        return
    el = err.lower().replace(" ", "")
    if "quickbooks" not in err.lower() and "profitandloss" not in el:
        return
    try:
        steps = json.loads(row.steps_json or "[]")
    except json.JSONDecodeError:
        steps = []
    if not isinstance(steps, list):
        steps = []
    new_steps = [s for s in steps if not (isinstance(s, dict) and _step_is_unified_quickbooks(s))]
    if len(new_steps) != len(steps):
        row.steps_json = json.dumps(new_steps)
    other_failed = any(s.get("ok") is False for s in new_steps if isinstance(s, dict))
    row.last_error = None
    row.last_refresh_ok = 0 if other_failed else 1
    await db.commit()


async def _scrub_app_dataset_quickbooks_legacy_on_startup() -> None:
    """One-time cleanup of legacy QuickBooks failures in app_dataset_state (unified refresh no longer calls QB)."""
    try:
        async with AsyncSessionLocal() as db:
            row = await db.get(AppDatasetState, 1)
            if row:
                await _scrub_legacy_quickbooks_from_dataset_state(db, row)
                row = await db.get(AppDatasetState, 1)
                if row:
                    await _force_clear_quickbooks_dataset_error(db, row)
    except Exception:
        logging.getLogger(__name__).exception("Startup QuickBooks dataset scrub failed")


def _scheduled_background_jobs_wanted() -> bool:
    """Run the background scheduler if scheduled EOD and/or hourly Salesforce sync is enabled."""
    eod = os.getenv("ENABLE_SCHEDULED_EOD_SNAPSHOT", "1").lower() not in ("0", "false", "no")
    hourly = os.getenv("ENABLE_SCHEDULED_BACKGROUND_SYNC", "").lower() in ("1", "true", "yes")
    return eod or hourly


# One-time cleanup of Ascension/Ascend overrides when active-ARR is first requested (in case lifespan didn't run on deploy).
_ascension_ascend_cleanup_done = False


async def _migrate_db() -> None:
    """Add new columns to existing tables created before recent schema updates."""
    from sqlalchemy import text as _text
    new_cols = [
        ("opportunities",          "next_step",    "TEXT"),
        ("opportunities",          "lead_type",    "VARCHAR(128)"),
        ("opportunities",          "current_crm",  "VARCHAR(128)"),
        ("opportunities",          "current_voip", "VARCHAR(128)"),
        ("opportunities",          "deal_tier",    "VARCHAR(64)"),
        ("ai_forecast_observations", "obs_type",   "VARCHAR(16)"),
        # ForecastSnapshot: full AI-adjusted + tier-weighted columns
        ("forecast_snapshots", "nb_ai_adjusted_forecast",    "FLOAT"),
        ("forecast_snapshots", "exp_ai_adjusted_forecast",   "FLOAT"),
        ("forecast_snapshots", "total_ai_adjusted_forecast", "FLOAT"),
        ("forecast_snapshots", "nb_pipeline_tier_weighted",  "FLOAT"),
        ("forecast_snapshots", "exp_pipeline_tier_weighted", "FLOAT"),
        ("forecast_snapshots", "nb_tier_forecast",           "FLOAT"),
        ("forecast_snapshots", "exp_tier_forecast",          "FLOAT"),
        ("forecast_snapshots", "total_tier_forecast",        "FLOAT"),
        # Account customer health fields
        ("accounts", "health_score",              "FLOAT"),
        ("accounts", "risk_score",                "FLOAT"),
        ("accounts", "product_usage_score",       "FLOAT"),
        ("accounts", "financial_score",           "FLOAT"),
        ("accounts", "customer_engagement_score", "FLOAT"),
        ("accounts", "support_score",             "FLOAT"),
        ("accounts", "customer_journey_phase",    "VARCHAR(64)"),
        ("accounts", "payment_status",            "VARCHAR(64)"),
        ("accounts", "outstanding_balance",       "FLOAT"),
        ("accounts", "overdue_invoice_count",     "INTEGER"),
        ("cash_flow_lines",   "is_subtotal",   "INTEGER"),
        ("pnl_lines",         "is_plan_only",  "INTEGER"),
        ("dept_detail_lines", "is_plan_only",  "INTEGER"),
        ("opportunity_line_items", "arr",      "FLOAT"),
    ]
    async with AsyncSessionLocal() as db:
        for tbl, col, col_type in new_cols:
            try:
                await db.execute(_text(f"ALTER TABLE {tbl} ADD COLUMN {col} {col_type}"))
                await db.commit()
            except Exception:
                await db.rollback()  # column already exists — safe to ignore
        # Back-fill obs_type = 'forecast' for rows that pre-date this migration
        try:
            await db.execute(_text(
                "UPDATE ai_forecast_observations SET obs_type = 'forecast' WHERE obs_type IS NULL"
            ))
            await db.commit()
        except Exception:
            await db.rollback()
        # Drop the old single-column unique index on scored_at if it still exists.
        # SQLAlchemy names it ix_ai_forecast_observations_scored_at.
        # After dropping it, inserts of multiple obs_type rows with the same scored_at work fine.
        for old_idx in (
            "ix_ai_forecast_observations_scored_at",
            "uq_ai_forecast_observations_scored_at",
        ):
            try:
                await db.execute(_text(f"DROP INDEX IF EXISTS {old_idx}"))
                await db.commit()
            except Exception:
                await db.rollback()
    # Create new tables (idempotent — create_all skips existing tables)
    from database import engine
    from models import Base
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await seed()
    await _migrate_db()
    await _scrub_app_dataset_quickbooks_legacy_on_startup()
    await asyncio.to_thread(_init_api_timing_log_file_on_startup)
    await _remove_ascension_ascend_overrides()
    await _remove_ascension_ascend_record_type_overrides()
    # Scheduled EOD at 23:59 EST (default on): snapshots current SQLite CRM data (typically last Dashboard → Refresh app data).
    # Optional hourly Salesforce sync: ENABLE_SCHEDULED_BACKGROUND_SYNC=true (otherwise CRM updates are manual refresh only).
    task = asyncio.create_task(_scheduled_salesforce_jobs()) if _scheduled_background_jobs_wanted() else None
    yield
    if task:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="Dazos CFO Cockpit API", version="1.0.0", lifespan=lifespan)
_cors_origins_env = os.getenv("CORS_ORIGINS", "").strip()
_cors_origins = [o.strip() for o in _cors_origins_env.split(",") if o.strip()] if _cors_origins_env else ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=False if "*" in _cors_origins else True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _cors_headers_for_request(request: Request) -> dict:
    """Return CORS headers so browser doesn't hide error responses (e.g. 401)."""
    origin = request.headers.get("origin")
    allowed = [o.strip() for o in _cors_origins if o.strip()]
    if origin and origin in allowed:
        return {"Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true"}
    return {}


class RequireAppPasswordMiddleware(BaseHTTPMiddleware):
    """When APP_PASSWORD is set, require X-App-Password header on all /api/ requests."""

    async def dispatch(self, request: Request, call_next):
        if not request.url.path.startswith("/api/"):
            return await call_next(request)
        # Let OPTIONS (CORS preflight) through so the browser gets 200 and can send the real request with the password header
        if request.method == "OPTIONS":
            return await call_next(request)
        # Health check: no auth so frontend can detect "backend reachable" before login
        if request.method == "GET" and request.url.path == "/api/health":
            return await call_next(request)
        # Read-only status check: list EOD snapshot dates (no sensitive data)
        if request.method == "GET" and request.url.path == "/api/salesforce/eod-snapshots":
            return await call_next(request)
        # Debug endpoints: config and field names only, so you can open them in the browser without the password
        if request.method == "GET" and request.url.path.startswith("/api/debug/"):
            return await call_next(request)
        # Read-only override lists: so you can check manual overrides without the password
        if request.method == "GET" and request.url.path in (
            "/api/arr-schedule/active-arr-overrides",
            "/api/manual-overwrites",
        ):
            return await call_next(request)
        # Allow DELETE on active-arr-overrides so you can remove overrides without the password
        if request.method == "DELETE" and request.url.path.startswith("/api/arr-schedule/active-arr-overrides/"):
            return await call_next(request)
        # Allow DELETE on manual-overwrites (record type overrides) so you can remove them without the password
        if request.method == "DELETE" and request.url.path.startswith("/api/manual-overwrites/"):
            return await call_next(request)
        password = APP_PASSWORD
        if not password:
            return await call_next(request)
        password = password.strip()
        # Proxies often normalize header names to lowercase
        supplied = request.headers.get("X-App-Password") or request.headers.get("x-app-password")
        if supplied is not None:
            supplied = supplied.strip()
        if supplied != password:
            resp = JSONResponse(
                status_code=401,
                content={"detail": "Missing or invalid app password"},
            )
            for k, v in _cors_headers_for_request(request).items():
                resp.headers[k] = v
            return resp
        return await call_next(request)


def _api_timing_log_file_path() -> Optional[Path]:
    """Optional log file; no terminal needed when set. See APITimingMiddleware docstring."""
    raw = (os.getenv("API_TIMING_LOG_FILE") or "").strip()
    if not raw or raw.lower() in ("0", "false", "no", "off"):
        return None
    base = Path(__file__).resolve().parent
    if raw.lower() in ("1", "true", "yes"):
        return base / "api_timing.log"
    p = Path(raw)
    if not p.is_absolute():
        p = base / p
    return p


def _append_api_timing_line(path: Path, line: str) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(EST).isoformat(timespec="milliseconds")
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"{ts} {line}\n")
    except OSError:
        pass


def _init_api_timing_log_file_on_startup() -> None:
    """Create/append a line so backend/api_timing.log exists when API_TIMING_LOG_FILE is set."""
    log_path = _api_timing_log_file_path()
    if log_path is None:
        return
    _append_api_timing_line(log_path, "--- backend started — timing log (see API_TIMING_LOG / SLOW_REQUEST_MS for console) ---")


class APITimingMiddleware(BaseHTTPMiddleware):
    """Log how long each /api request takes. Enable when profiling slowness.

    Env:
    - API_TIMING_LOG=1 (or true/all) — log every /api request with duration in ms (Uvicorn console).
    - Otherwise log only if duration >= SLOW_REQUEST_MS (default 500).
    - API_TIMING_LOG_FILE=1 (or true/yes) — append **every** /api request to backend/api_timing.log
      (independent of console; no terminal needed). Or set to a path (backend-relative or absolute).
    """

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if not path.startswith("/api/") or request.method == "OPTIONS":
            return await call_next(request)
        raw = (os.getenv("API_TIMING_LOG") or "").strip().lower()
        log_all = raw in ("1", "true", "all", "yes")
        try:
            slow_ms = float(os.getenv("SLOW_REQUEST_MS") or "500")
        except ValueError:
            slow_ms = 500.0
        t0 = time.perf_counter()
        response = await call_next(request)
        elapsed_ms = (time.perf_counter() - t0) * 1000
        if log_all or elapsed_ms >= slow_ms:
            logging.getLogger("api.timing").info("%s %s %.2fms", request.method, path, elapsed_ms)
        log_path = _api_timing_log_file_path()
        if log_path is not None:
            # Never block the asyncio event loop with sync disk I/O (would stall all API responses).
            line = f"{request.method} {path} {elapsed_ms:.2f}ms"
            await asyncio.to_thread(_append_api_timing_line, log_path, line)
        return response


app.add_middleware(RequireAppPasswordMiddleware)
app.add_middleware(APITimingMiddleware)

# Ensure dashboard MTD endpoints never return 500/non-JSON (e.g. if get_db or any dependency fails)
_DASHBOARD_MTD_PATHS = frozenset({"/api/dashboard/cash-mtd", "/api/dashboard/bookings-mtd"})
_logger = logging.getLogger(__name__)

# ── Background job registry ───────────────────────────────────────────────────
# Tracks in-flight and recently-completed jobs so the frontend can poll for
# status regardless of which view triggered the work.
_bg_jobs: dict[str, dict] = {}


def _bg_job_start(job_id: str, job_type: str, label: str) -> None:
    _bg_jobs[job_id] = {
        "id": job_id,
        "type": job_type,
        "label": label,
        "status": "running",
        "started_at": datetime.now(EST).isoformat(),
        "finished_at": None,
        "result": None,
    }


def _bg_job_done(job_id: str, ok: bool, detail: str = "") -> None:
    if job_id in _bg_jobs:
        _bg_jobs[job_id].update({
            "status": "done" if ok else "error",
            "finished_at": datetime.now(EST).isoformat(),
            "result": detail,
        })
    # Prune: keep at most the 30 most recent jobs
    if len(_bg_jobs) > 30:
        oldest = sorted(_bg_jobs.keys(), key=lambda k: _bg_jobs[k].get("started_at", ""))
        for k in oldest[:-30]:
            del _bg_jobs[k]


@app.exception_handler(Exception)
async def _dashboard_mtd_exception_handler(request: Request, exc: Exception):
    """Catch any unhandled exception for dashboard MTD endpoints and return 200 + JSON so frontend never sees 500/non-JSON."""
    if request.url.path not in _DASHBOARD_MTD_PATHS:
        raise exc
    _logger.exception("Dashboard MTD error for %s: %s", request.url.path, exc)
    msg = f"{type(exc).__name__}: {str(exc)[:120]}"
    if request.url.path == "/api/dashboard/cash-mtd":
        return JSONResponse(status_code=200, content=_safe_cash_fallback(msg))
    if request.url.path == "/api/dashboard/bookings-mtd":
        return JSONResponse(status_code=200, content=_safe_bookings_fallback(msg))
    raise exc


def _runway_months(cash: float, burn: float) -> Optional[float]:
    if burn and burn > 0:
        return round(cash / burn, 1)
    return None


def _growth_pct(current: float, prior: float) -> Optional[float]:
    if prior and prior != 0:
        return round((current - prior) / prior * 100, 1)
    return None


@app.get("/api/company")
async def get_company(db: AsyncSession = Depends(get_db)):
    r = await db.execute(select(Company).limit(1))
    company = r.scalar_one_or_none()
    if not company:
        return {"name": "Dazos", "fiscal_year_end_month": 12}
    return {"name": company.name, "fiscal_year_end_month": company.fiscal_year_end_month}


@app.get("/api/kpi", response_model=KPISummary)
async def get_kpi(
    as_of: Optional[date] = Query(None, description="Date for KPI snapshot; latest if omitted"),
    db: AsyncSession = Depends(get_db),
):
    q = select(KPI).order_by(KPI.as_of_date.desc())
    if as_of:
        q = q.where(KPI.as_of_date <= as_of)
    r = await db.execute(q.limit(1))
    row = r.scalar_one_or_none()
    if not row:
        return KPISummary(
            as_of_date=date.today(),
            cash_balance=0,
            monthly_burn=0,
            runway_months=None,
            revenue_ytd=0,
            revenue_prior_ytd=0,
            revenue_growth_pct=None,
            gross_margin_pct=0,
            ebitda_ytd=0,
            ar_days=0,
            ap_days=0,
        )
    return KPISummary(
        as_of_date=row.as_of_date,
        cash_balance=row.cash_balance,
        monthly_burn=row.monthly_burn,
        runway_months=_runway_months(row.cash_balance, row.monthly_burn),
        revenue_ytd=row.revenue_ytd,
        revenue_prior_ytd=row.revenue_prior_ytd,
        revenue_growth_pct=_growth_pct(row.revenue_ytd, row.revenue_prior_ytd),
        gross_margin_pct=row.gross_margin_pct,
        ebitda_ytd=row.ebitda_ytd,
        ar_days=row.ar_days,
        ap_days=row.ap_days,
    )


@app.get("/api/pnl/periods")
async def get_pnl_periods(db: AsyncSession = Depends(get_db)):
    """Return list of available P&L periods, newest first."""
    r = await db.execute(
        select(PnLLine.period_end).distinct().order_by(PnLLine.period_end.desc())
    )
    periods = [str(row) for row in r.scalars().all()]
    return {"periods": periods}


@app.get("/api/pnl/observations")
async def get_pnl_observations(
    period_end: date = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """Generate brief FP&A observations for the selected month and YTD."""
    # Fetch YTD data: all months in the same fiscal year up to selected period
    fiscal_year_start = date(period_end.year, 1, 1)
    r = await db.execute(
        select(PnLLine)
        .where(PnLLine.period_end >= fiscal_year_start)
        .where(PnLLine.period_end <= period_end)
        .order_by(PnLLine.period_end, PnLLine.sort_order)
    )
    all_rows = r.scalars().all()
    if not all_rows:
        return {"observations": None, "period_end": str(period_end)}

    # Build compact text for the LLM
    periods = sorted(set(r.period_end for r in all_rows))
    month_rows = [r for r in all_rows if r.period_end == period_end]

    def _fmt_amt(v):
        if v is None:
            return "—"
        return f"${v/1000:.0f}k" if abs(v) < 1_000_000 else f"${v/1_000_000:.2f}M"

    lines_block = []
    for row in sorted(month_rows, key=lambda x: x.sort_order):
        act = _fmt_amt(row.amount)
        plan = _fmt_amt(row.plan_amount) if row.plan_amount is not None else "—"
        var = _fmt_amt(row.amount - row.plan_amount) if row.plan_amount is not None else "—"
        prefix = "**" if row.is_subtotal else "  "
        lines_block.append(f"{prefix}{row.category}: Actual={act} Plan={plan} Var={var}")
    month_text = "\n".join(lines_block)

    # YTD aggregation
    from collections import defaultdict
    ytd_actual: dict = defaultdict(float)
    ytd_plan: dict = defaultdict(float)
    ytd_has_plan: dict = defaultdict(bool)
    sort_map: dict = {}
    subtype_map: dict = {}
    for row in all_rows:
        ytd_actual[row.category] += row.amount
        if row.plan_amount is not None:
            ytd_plan[row.category] += row.plan_amount
            ytd_has_plan[row.category] = True
        sort_map[row.category] = row.sort_order
        subtype_map[row.category] = row.is_subtotal

    ytd_block = []
    for cat in sorted(ytd_actual, key=lambda c: sort_map.get(c, 0)):
        act = _fmt_amt(ytd_actual[cat])
        plan = _fmt_amt(ytd_plan[cat]) if ytd_has_plan.get(cat) else "—"
        var = _fmt_amt(ytd_actual[cat] - ytd_plan[cat]) if ytd_has_plan.get(cat) else "—"
        prefix = "**" if subtype_map.get(cat) else "  "
        ytd_block.append(f"{prefix}{cat}: Actual={act} Plan={plan} Var={var}")
    ytd_text = "\n".join(ytd_block)

    period_label = period_end.strftime("%B %Y")
    ytd_label = f"Jan–{period_end.strftime('%b')} {period_end.year}"

    prompt = f"""You are a CFO-level FP&A analyst. Review the P&L for {period_label} and share 4–6 concise bullet point observations for an executive audience. Focus on: key variances vs plan, trends, risks, and areas of concern or outperformance. Be specific with numbers.

## {period_label} — Month Actuals vs Plan
{month_text}

## {ytd_label} — YTD Actuals vs Plan
{ytd_text}

Respond with bullet points only (use • as bullet). No headers, no preamble."""

    try:
        import anthropic as _anthropic
        _client = _anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))
        msg = _client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=600,
            messages=[{"role": "user", "content": prompt}],
        )
        obs_text = msg.content[0].text.strip()
    except Exception as e:
        logger.exception("P&L observations LLM error")
        obs_text = None

    return {"observations": obs_text, "period_end": str(period_end)}


@app.get("/api/cf/observations")
async def get_cf_observations(
    period_end: date = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """Generate brief FP&A observations for the Cash Flow statement."""
    fiscal_year_start = date(period_end.year, 1, 1)
    r = await db.execute(
        select(CashFlowLine)
        .where(CashFlowLine.period_end >= fiscal_year_start)
        .where(CashFlowLine.period_end <= period_end)
        .order_by(CashFlowLine.period_end, CashFlowLine.sort_order)
    )
    all_rows = r.scalars().all()
    if not all_rows:
        return {"observations": None, "period_end": str(period_end)}

    def _fmt_amt(v):
        if v is None:
            return "—"
        return f"${v/1000:.0f}k" if abs(v) < 1_000_000 else f"${v/1_000_000:.2f}M"

    month_rows = [row for row in all_rows if row.period_end == period_end]
    lines_block = []
    for row in sorted(month_rows, key=lambda x: x.sort_order):
        act = _fmt_amt(row.amount)
        plan = _fmt_amt(row.plan_amount) if row.plan_amount is not None else "—"
        var = _fmt_amt(row.amount - row.plan_amount) if row.plan_amount is not None else "—"
        lines_block.append(f"  [{row.section}] {row.category}: Actual={act} Plan={plan} Var={var}")
    month_text = "\n".join(lines_block)

    from collections import defaultdict
    ytd_actual: dict = defaultdict(float)
    ytd_plan: dict = defaultdict(float)
    ytd_has_plan: dict = defaultdict(bool)
    sort_map: dict = {}
    sec_map: dict = {}
    for row in all_rows:
        ytd_actual[row.category] += row.amount
        if row.plan_amount is not None:
            ytd_plan[row.category] += row.plan_amount
            ytd_has_plan[row.category] = True
        sort_map[row.category] = row.sort_order
        sec_map[row.category] = row.section

    ytd_block = []
    for cat in sorted(ytd_actual, key=lambda c: sort_map.get(c, 0)):
        act = _fmt_amt(ytd_actual[cat])
        plan = _fmt_amt(ytd_plan[cat]) if ytd_has_plan.get(cat) else "—"
        var = _fmt_amt(ytd_actual[cat] - ytd_plan[cat]) if ytd_has_plan.get(cat) else "—"
        ytd_block.append(f"  [{sec_map.get(cat,'?')}] {cat}: Actual={act} Plan={plan} Var={var}")
    ytd_text = "\n".join(ytd_block)

    period_label = period_end.strftime("%B %Y")
    ytd_label = f"Jan–{period_end.strftime('%b')} {period_end.year}"

    prompt = f"""You are a CFO-level FP&A analyst. Review the Cash Flow statement for {period_label} and share 4–6 concise bullet point observations for an executive audience. Focus on: operating cash generation vs plan, key working capital movements, investing activity, liquidity implications. Be specific with numbers.

## {period_label} — Month Actuals vs Plan
{month_text}

## {ytd_label} — YTD Actuals vs Plan
{ytd_text}

Respond with bullet points only (use • as bullet). No headers, no preamble."""

    try:
        import anthropic as _anthropic
        _client = _anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))
        msg = _client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=600,
            messages=[{"role": "user", "content": prompt}],
        )
        obs_text = msg.content[0].text.strip()
    except Exception as e:
        logger.exception("CF observations LLM error")
        obs_text = None

    return {"observations": obs_text, "period_end": str(period_end)}


@app.get("/api/bs/observations")
async def get_bs_observations(
    period_end: date = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """Generate brief FP&A observations for the Balance Sheet."""
    r = await db.execute(
        select(BalanceSheetLine)
        .where(BalanceSheetLine.period_end == period_end)
        .order_by(BalanceSheetLine.sort_order)
    )
    all_rows = r.scalars().all()
    if not all_rows:
        return {"observations": None, "period_end": str(period_end)}

    def _fmt_amt(v):
        if v is None:
            return "—"
        return f"${v/1000:.0f}k" if abs(v) < 1_000_000 else f"${v/1_000_000:.2f}M"

    lines_block = []
    for row in all_rows:
        act = _fmt_amt(row.amount)
        plan = _fmt_amt(row.plan_amount) if row.plan_amount is not None else "—"
        var = _fmt_amt(row.amount - row.plan_amount) if row.plan_amount is not None else "—"
        prefix = "**" if row.is_subtotal else "  "
        lines_block.append(f"{prefix}[{row.section}] {row.category}: Actual={act} Plan={plan} Var={var}")
    bs_text = "\n".join(lines_block)

    period_label = period_end.strftime("%B %Y")

    prompt = f"""You are a CFO-level FP&A analyst. Review the Balance Sheet for {period_label} and share 4–6 concise bullet point observations for an executive audience. Focus on: liquidity position, working capital trends, key variances vs plan, leverage, and any balance sheet risks. Be specific with numbers.

## {period_label} — Balance Sheet Actuals vs Plan
{bs_text}

Respond with bullet points only (use • as bullet). No headers, no preamble."""

    try:
        import anthropic as _anthropic
        _client = _anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))
        msg = _client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=600,
            messages=[{"role": "user", "content": prompt}],
        )
        obs_text = msg.content[0].text.strip()
    except Exception as e:
        logger.exception("BS observations LLM error")
        obs_text = None

    return {"observations": obs_text, "period_end": str(period_end)}


@app.get("/api/dept-detail", response_model=list[DeptDetailLineOut])
async def get_dept_detail(
    period_end: Optional[date] = Query(None),
    months: int = Query(3, ge=1, le=24),
    db: AsyncSession = Depends(get_db),
):
    """Return department detail lines for up to `months` month-ends."""
    anchor = period_end
    if anchor is None:
        r_anchor = await db.execute(select(func.max(DeptDetailLine.period_end)))
        anchor = r_anchor.scalar_one_or_none()
        if anchor is None:
            return []

    r_periods = await db.execute(
        select(DeptDetailLine.period_end)
        .where(DeptDetailLine.period_end <= anchor)
        .distinct()
        .order_by(DeptDetailLine.period_end.desc())
        .limit(months)
    )
    periods = sorted(r_periods.scalars().all())

    if not periods:
        return []

    r = await db.execute(
        select(DeptDetailLine)
        .where(DeptDetailLine.period_end.in_(periods))
        .order_by(DeptDetailLine.period_end, DeptDetailLine.sort_order)
    )
    rows = r.scalars().all()
    return [
        DeptDetailLineOut(
            period_end=row.period_end,
            dept=row.dept,
            category=row.category,
            amount=row.amount,
            plan_amount=row.plan_amount,
            is_subtotal=bool(row.is_subtotal),
            is_plan_only=bool(row.is_plan_only),
            sort_order=row.sort_order,
        )
        for row in rows
    ]


@app.get("/api/overview/observations")
async def get_overview_observations(
    period_end: date = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """Generate YTD executive summary observations across P&L, Cash Flow, and Balance Sheet."""
    # Gather YTD P&L data (all months up to period_end)
    pnl_r = await db.execute(
        select(PnLLine)
        .where(PnLLine.period_end <= period_end)
        .order_by(PnLLine.period_end, PnLLine.sort_order)
    )
    pnl_rows = pnl_r.scalars().all()

    # Latest BS snapshot
    bs_r = await db.execute(
        select(BalanceSheetLine)
        .where(BalanceSheetLine.period_end == period_end)
        .order_by(BalanceSheetLine.sort_order)
    )
    bs_rows = bs_r.scalars().all()

    if not pnl_rows:
        return {"observations": None, "period_end": str(period_end)}

    def _fmt(v):
        if v is None: return "—"
        return f"${v/1000:.0f}k" if abs(v) < 1_000_000 else f"${v/1_000_000:.2f}M"

    # Aggregate YTD P&L by category
    ytd: dict[str, dict] = {}
    for row in pnl_rows:
        if row.category not in ytd:
            ytd[row.category] = {"actual": 0.0, "plan": 0.0, "has_plan": False,
                                  "line_type": row.line_type, "is_subtotal": row.is_subtotal}
        ytd[row.category]["actual"] += row.amount
        if row.plan_amount is not None:
            ytd[row.category]["plan"] += row.plan_amount
            ytd[row.category]["has_plan"] = True

    # Month label for period
    period_label = period_end.strftime("%B %Y")
    ytd_label = f"Jan–{period_end.strftime('%b')} {period_end.year}"

    pnl_lines = []
    for cat, d in ytd.items():
        if not d["is_subtotal"] and d["line_type"] not in ("other",):
            continue  # only show subtotals and 'other' items for brevity
        var = _fmt(d["actual"] - d["plan"]) if d["has_plan"] else "—"
        pnl_lines.append(f"  {cat}: Actual={_fmt(d['actual'])} Plan={_fmt(d['plan']) if d['has_plan'] else '—'} Var={var}")
    pnl_text = "\n".join(pnl_lines)

    bs_lines = [
        f"  {r.category}: {_fmt(r.amount)}" + (f" vs Plan {_fmt(r.plan_amount)}" if r.plan_amount else "")
        for r in bs_rows if r.is_subtotal or r.category.lower() in ("cash", "accounts receivable", "deferred revenue")
    ]
    bs_text = "\n".join(bs_lines)

    prompt = f"""You are a CFO-level FP&A analyst. Based on the {ytd_label} YTD financial data below, provide 5–7 concise executive bullet points covering: revenue performance vs plan, gross margin, OpEx discipline, EBITDA trend, cash position, and any notable risks or highlights. Be specific with dollar amounts and percentages.

## YTD P&L ({ytd_label})
{pnl_text}

## Balance Sheet as of {period_label}
{bs_text}

Respond with bullet points only (use • as bullet). No headers, no preamble."""

    try:
        import anthropic as _anthropic
        _client = _anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))
        msg = _client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=700,
            messages=[{"role": "user", "content": prompt}],
        )
        obs_text = msg.content[0].text.strip()
    except Exception as e:
        logger.exception("Overview observations LLM error")
        obs_text = None

    return {"observations": obs_text, "period_end": str(period_end)}


@app.get("/api/pnl", response_model=list[PnLLineOut])
async def get_pnl(
    period_end: Optional[date] = Query(None),
    months: int = Query(3, ge=1, le=24),
    db: AsyncSession = Depends(get_db),
):
    """
    Return P&L lines for up to ``months`` distinct month-ends, all <= ``period_end`` (newest first in DB, output chronological).

    Uses a two-step query so every month includes **all** categories (avoids the old ``limit(1000)`` truncating mid-month and breaking YTD).
    """
    anchor = period_end
    if anchor is None:
        r_anchor = await db.execute(select(func.max(PnLLine.period_end)))
        anchor = r_anchor.scalar_one_or_none()
        if anchor is None:
            return []

    pr = await db.execute(
        select(PnLLine.period_end)
        .distinct()
        .where(PnLLine.period_end <= anchor)
        .order_by(PnLLine.period_end.desc())
        .limit(months)
    )
    period_list = [t[0] for t in pr.all()]
    if not period_list:
        return []

    r = await db.execute(
        select(PnLLine)
        .where(PnLLine.period_end.in_(period_list))
        .order_by(PnLLine.period_end, PnLLine.sort_order)
    )
    rows = r.scalars().all()
    out: list[PnLLineOut] = []
    for period in sorted(period_list):
        for row in rows:
            if row.period_end != period:
                continue
            out.append(PnLLineOut(
                period_end=row.period_end,
                line_type=row.line_type,
                category=row.category,
                amount=row.amount,
                plan_amount=row.plan_amount,
                is_subtotal=bool(row.is_subtotal),
                is_plan_only=bool(row.is_plan_only),
                sort_order=row.sort_order or 0,
            ))
    return out


@app.get("/api/cashflow", response_model=list[CashFlowLineOut])
async def get_cashflow(
    period_end: Optional[date] = Query(None),
    months: int = Query(3, ge=1, le=12),
    db: AsyncSession = Depends(get_db),
):
    q = select(CashFlowLine).order_by(CashFlowLine.period_end.desc())
    if period_end:
        q = q.where(CashFlowLine.period_end <= period_end)
    r = await db.execute(q.limit(200))
    rows = r.scalars().all()
    periods = sorted(set(row.period_end for row in rows), reverse=True)[:months]
    out = [CashFlowLineOut(
        period_end=row.period_end, section=row.section, category=row.category,
        amount=row.amount, plan_amount=row.plan_amount,
        is_subtotal=bool(row.is_subtotal), sort_order=row.sort_order,
    ) for row in rows if row.period_end in periods]
    return out


@app.get("/api/budget-vs-actual", response_model=list[BudgetVsActualOut])
async def get_budget_vs_actual(
    period_end: Optional[date] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    q = select(BudgetLine).order_by(BudgetLine.period_end.desc())
    if period_end:
        q = q.where(BudgetLine.period_end <= period_end)
    r = await db.execute(q.limit(100))
    rows = r.scalars().all()
    out = []
    for row in rows:
        var = row.actual_amount - row.budget_amount
        pct = round(var / row.budget_amount * 100, 1) if row.budget_amount else None
        out.append(BudgetVsActualOut(period_end=row.period_end, category=row.category, budget_amount=row.budget_amount, actual_amount=row.actual_amount, variance=var, variance_pct=pct))
    return out


_FPA_SYSTEM_PROMPT = """You are Dazos's FP&A agent, embedded in the CFO cockpit. Dazos is a ~$7M ARR, VC/PE-backed behavioral health CRM SaaS company. You serve the CFO as your primary user, with occasional access by other executives (CEO, VP Sales, VP CS, etc.) — calibrate depth and framing to the role when it's known.

You are a sharp, numbers-first financial analyst: precise, candid, and efficient. You never pad responses with filler. Lead with the answer or the number, then support it.

## Company context
- Stage: Series A/B range, investor-backed, growth-oriented
- ARR: ~$7M with an active growth mandate from investors
- Business model: SaaS subscription, behavioral health vertical (mental health, substance use disorder, counseling providers)
- Revenue drivers: seat-based or patient-volume licensing, expansion ARR, new logo acquisition
- Key cost centers: R&D/engineering, sales & marketing, customer success, G&A
- Compliance: customers are HIPAA covered entities — relevant to vendor costs, data handling, and customer success intensity, which affects gross margin and CAC

## Data sources
You have access to the following primary data sources in this cockpit. Always reference the most current available data before answering; flag if data may be stale.

**Google Sheets (primary financial model)**
- Source of truth for P&L, headcount, and operational metrics
- Populated via QuickBooks export (actuals) and manual inputs (budget/forecast)

**QuickBooks (accounting system)**
- Actuals: revenue, COGS, opex by category, AP/AR

**Salesforce (CRM) — source of truth for ARR and subscriptions**
- ARR, CARR, subscription counts, NRR, churn, contraction, expansion
- Pipeline: stages, ACV, close dates, rep ownership, source
- New logo and expansion bookings — all revenue metrics are derived from Salesforce Opportunities

**Chargebee (billing engine) — source of truth for cash and invoicing ONLY**
- Invoices, payments, collections, billing status
- Use for cash-in, overdue invoices, payment failures, billing reconciliation
- Do NOT use Chargebee for ARR, MRR, NRR, subscription metrics, or customer counts — always use Salesforce for those

**Data source routing rule:** ARR questions → Salesforce. Cash/billing questions → Chargebee. P&L/budget questions → Google Sheets / QuickBooks.

When sources conflict, flag the discrepancy and identify which is more likely current. Do not silently average or blend conflicting numbers.

## Core metrics you track and compute
**ARR & revenue**
- ARR = annualized committed recurring revenue
- ARR bridge: new logo + expansion − churn − contraction = net new ARR
- NRR (Net Revenue Retention) = (starting ARR + expansion − churn − contraction) / starting ARR × 100

**Unit economics**
- ACV (Average Contract Value): total ARR / logo count
- LTV = ACV × gross margin % / churn rate
- CAC = total S&M spend / new logos acquired (period-matched)
- LTV:CAC ratio: target ≥ 3x; best-in-class ≥ 5x
- CAC Payback Period = CAC / (ACV × gross margin %); target <18 months

**Efficiency**
- Gross margin = (revenue − COGS) / revenue; SaaS target 70–80%
- Magic number = net new ARR (quarter) / prior quarter S&M spend
- Burn multiple = net cash burned / net new ARR; <1.5x efficient
- Rule of 40 = ARR growth rate % + FCF margin %

**Cash & runway**
- Ending cash balance, monthly burn rate
- Runway in months = cash / avg monthly net burn; board expectation 18–24 months minimum

## Benchmarks (VC-backed SaaS, $5–15M ARR peer group)
| Metric | Concerning | Acceptable | Strong |
|---|---|---|---|
| NRR | <100% | 100–110% | >110% |
| Gross margin | <65% | 65–75% | >75% |
| CAC payback | >24 mo | 12–18 mo | <12 mo |
| LTV:CAC | <2x | 2–4x | >4x |
| Magic number | <0.5 | 0.5–1.0 | >1.0 |
| Burn multiple | >2x | 1.5–2x | <1.5x |
| Rule of 40 | <20 | 20–40 | >40 |
| Pipeline coverage | <2.5x | 2.5–3.5x | >3.5x |

## How you work
- Lead with the number or the answer — not the setup
- Name the driver behind every variance; don't just describe the gap
- Flag risks and opportunities explicitly; never bury them
- If data is missing or ambiguous, ask the single most important clarifying question
- Present tables for comparative or multi-period data; use prose for narratives and commentary
- Always include a "so what" and recommended action when the analysis warrants it
- When asked to build a model or output, produce it — don't ask for permission

## Guardrails
- Never fabricate numbers; if estimating, label it clearly as an estimate
- Do not present a single scenario as certain — offer ranges or sensitivities for forward-looking figures
- Omit disclaimers and caveats unless they are materially important to the decision at hand
- If a request is outside finance (e.g., HR policy, legal), redirect to the appropriate owner"""


_FPA_MODEL_MAP_KEY = "__fpa_model_map__"
_FPA_TAB_SNAPSHOT_PREFIX = "__tab__"

# Priority order for tab inclusion in agent context (higher = included first / more rows)
_TAB_PRIORITY: dict[str, int] = {
    "OVERVIEW": 200,
    "OVERVIEW_2026P": 200,
    "ASSUMPTIONS": 200,
    "P&L": 150,
    "P&L_2026P": 150,
    "ARR_Calculations": 150,
    "ARR_Calculations_2026P": 150,
    "ARR_Actuals": 120,
    "BS": 120,
    "BS_2026P": 120,
    "CF": 120,
    "CF_2026P": 120,
    "Headcount": 120,
    "Headcount_2026P": 120,
    "Hiring plan_2026P": 100,
    "CoGS": 100,
    "CoGS_2026P": 100,
    "Sales & Marketing": 100,
    "Sales & Marketing_2026P": 100,
    "Product & Engineering": 100,
    "Product & Engineering_2026P": 100,
    "General & Administrative": 100,
    "General & Administrative_2026P": 100,
    "Sales and CS capacity": 80,
    "Sales and CS capacity_2026P": 80,
    "ARR_Schedule": 80,
}
_TAB_DEFAULT_PRIORITY = 60
_CONTEXT_TOKEN_BUDGET = 120_000   # ~120K chars ≈ ~30K tokens — well within Claude's window
# Tool-use rounds for FP&A / executive agent (list_sheets + reads can consume several steps)
_AGENT_MAX_TOOL_ROUNDS = 12


def _anthropic_response_text(content) -> str:
    """Concatenate all user-visible text blocks from a Claude Messages API `content` list."""
    parts: list[str] = []
    for b in content:
        if getattr(b, "type", None) == "text":
            t = getattr(b, "text", None)
            if t:
                parts.append(t)
    return "\n\n".join(parts).strip()


def _compact_tab(raw_rows: list[list], max_rows: int = 200, max_cols: int = 180) -> str:
    """Convert raw sheet rows to compact text, skipping empty rows, trimming trailing empties."""
    out = []
    for i, row in enumerate(raw_rows[:max_rows]):
        cells = [str(c) if c != "" else "" for c in row[:max_cols]]
        if not any(c.strip() for c in cells):
            continue
        while cells and not cells[-1].strip():
            cells.pop()
        out.append(f"R{i+1}: {cells}")
    return "\n".join(out)


async def _build_fpa_context(db: AsyncSession) -> str:
    """Build a comprehensive financial data context for the FP&A agent.

    Priority order:
    1. Model map (structural understanding of the spreadsheet)
    2. All stored tab snapshots (actual data from every sheet tab), ordered by priority
    3. Structured DB data (P&L, department OpEx detail, CF, BS from financials sync)
    4. Live ARR from Salesforce
    5. Latest stored monthly close analysis
    """
    sections: list[tuple[int, str, str]] = []  # (priority, heading, content)

    # ── 1. Model map ─────────────────────────────────────────────────────────
    try:
        map_r = await db.execute(
            select(SheetSnapshot)
            .where(SheetSnapshot.range_name == _FPA_MODEL_MAP_KEY)
            .order_by(SheetSnapshot.as_of.desc()).limit(1)
        )
        map_row = map_r.scalar_one_or_none()
        if map_row and map_row.data_json:
            map_data = json.loads(map_row.data_json)
            map_text = map_data.get("text", "")
            if map_text:
                sections.append((1000, "## Financial Model Map", map_text))
    except Exception:
        pass

    # ── 2. All stored tab snapshots ──────────────────────────────────────────
    try:
        snaps_r = await db.execute(
            select(SheetSnapshot)
            .where(SheetSnapshot.range_name.like(f"{_FPA_TAB_SNAPSHOT_PREFIX}%"))
            .order_by(SheetSnapshot.as_of.desc())
        )
        all_snaps = snaps_r.scalars().all()
        # Deduplicate: keep most recent per tab title
        seen_tabs: dict[str, SheetSnapshot] = {}
        for snap in all_snaps:
            title = snap.range_name[len(_FPA_TAB_SNAPSHOT_PREFIX):]
            if title not in seen_tabs:
                seen_tabs[title] = snap

        for title, snap in seen_tabs.items():
            if not snap.data_json:
                continue
            priority = _TAB_PRIORITY.get(title, _TAB_DEFAULT_PRIORITY)
            max_rows = priority  # reuse priority as row budget
            try:
                raw = json.loads(snap.data_json)
                compact = _compact_tab(raw, max_rows=max_rows)
                if compact.strip():
                    as_of = snap.as_of.strftime("%Y-%m-%d") if snap.as_of else "unknown"
                    sections.append((
                        priority,
                        f"### Sheet tab: {title} (synced {as_of})",
                        compact,
                    ))
            except Exception:
                pass
    except Exception:
        pass

    # ── 3. Structured DB data (P&L, CF, BS) ─────────────────────────────────
    try:
        pnl_r = await db.execute(
            select(PnLLine).order_by(PnLLine.period_end.desc(), PnLLine.sort_order).limit(500)
        )
        pnl_rows = pnl_r.scalars().all()
        if pnl_rows:
            periods = sorted(set(r.period_end for r in pnl_rows), reverse=True)[:6]
            header = f"{'Category':<40} " + " | ".join(
                f"{str(p):>12} actual  {str(p):>12} plan" for p in periods
            )
            lines = [header, "-" * len(header)]
            # One cell per (category, period): same merge as Financials UI — plan-only rows must not overwrite actuals
            by_cat: dict = {}
            cats: list[str] = []
            seen_c: set = set()
            for r in sorted(pnl_rows, key=lambda x: (x.period_end, x.sort_order)):
                d = by_cat.setdefault(r.category, {})
                if bool(r.is_plan_only) and r.period_end in d:
                    continue
                d[r.period_end] = r
                if r.category not in seen_c:
                    seen_c.add(r.category)
                    cats.append(r.category)
            for cat in cats:
                cells = []
                for p in periods:
                    row = by_cat[cat].get(p)
                    cells.append(f"${row.amount:>12,.0f}  {('$'+f'{row.plan_amount:,.0f}') if row and row.plan_amount is not None else '—':>12}" if row else f"{'—':>14}  {'—':>12}")
                lines.append(f"{cat:<40} " + " | ".join(cells))
            sections.append((500, "## P&L — structured (last 6 months, actual vs plan)", "\n".join(lines)))
    except Exception:
        pass

    # ── 3b. Department-level OpEx (G&A, S&M, etc.) — same source as app Financials sync ──
    try:
        dept_r = await db.execute(
            select(DeptDetailLine)
            .order_by(DeptDetailLine.period_end.desc(), DeptDetailLine.sort_order)
            .limit(1500)
        )
        dept_rows = dept_r.scalars().all()
        if dept_rows:
            periods = sorted(set(r.period_end for r in dept_rows), reverse=True)[:6]
            period_set = set(periods)
            # One line per (period, dept, category) — matches Financials UI (do not list plan-only duplicates)
            merged_dept: dict[tuple, DeptDetailLine] = {}
            for r in sorted(dept_rows, key=lambda x: (x.period_end, x.sort_order)):
                if r.period_end not in period_set:
                    continue
                k = (r.period_end, r.dept, r.category)
                if bool(r.is_plan_only) and k in merged_dept:
                    continue
                merged_dept[k] = r
            lines_d: list[str] = []
            for r in sorted(merged_dept.values(), key=lambda x: (x.period_end, x.sort_order)):
                plan_str = f" | plan ${r.plan_amount:,.0f}" if r.plan_amount is not None else ""
                sub = " (subtotal)" if r.is_subtotal else ""
                lines_d.append(
                    f"[{r.period_end}] {r.dept} / {r.category}{sub}: ${r.amount:,.0f}{plan_str}"
                )
            if lines_d:
                body = "\n".join(lines_d[:350])
                if len(lines_d) > 350:
                    body += f"\n… and {len(lines_d) - 350} more rows (use google_sheets_query for full detail)"
                sections.append((
                    498,
                    "## Operating expenses by department — structured (from financials sync; last 6 periods; "
                    "one row per line — actuals take precedence over plan-only sheet copies)",
                    body,
                ))
    except Exception:
        pass

    try:
        cf_r = await db.execute(
            select(CashFlowLine).order_by(CashFlowLine.period_end.desc(), CashFlowLine.sort_order).limit(200)
        )
        cf_rows = cf_r.scalars().all()
        if cf_rows:
            periods = sorted(set(r.period_end for r in cf_rows), reverse=True)[:3]
            lines = []
            for r in cf_rows:
                if r.period_end in periods:
                    plan_str = f" | plan ${r.plan_amount:,.0f}" if r.plan_amount is not None else ""
                    lines.append(f"[{r.period_end}] {r.section} / {r.category}: ${r.amount:,.0f}{plan_str}")
            sections.append((490, "## Cash Flow — structured (last 3 months)", "\n".join(lines)))
    except Exception:
        pass

    try:
        bs_r = await db.execute(
            select(BalanceSheetLine).order_by(BalanceSheetLine.period_end.desc(), BalanceSheetLine.sort_order).limit(200)
        )
        bs_rows = bs_r.scalars().all()
        if bs_rows:
            periods = sorted(set(r.period_end for r in bs_rows), reverse=True)[:2]
            lines = []
            for r in bs_rows:
                if r.period_end in periods:
                    plan_str = f" | plan ${r.plan_amount:,.0f}" if r.plan_amount is not None else ""
                    lines.append(f"[{r.period_end}] {r.section} / {r.category}: ${r.amount:,.0f}{plan_str}")
            sections.append((480, "## Balance Sheet — structured (last 2 periods)", "\n".join(lines)))
    except Exception:
        pass

    # ── 4. Live ARR from Salesforce ──────────────────────────────────────────
    try:
        arr_data, _ = await _get_arr_data_for_date(db, None)
        if arr_data:
            grand_total = arr_data.get("grand_total") or 0
            sections.append((470, "## Live ARR (Salesforce)", f"CARR: ${grand_total:,.0f}"))
    except Exception:
        pass

    # ── 5. Latest monthly close analysis ─────────────────────────────────────
    try:
        analyses_r = await db.execute(
            select(FinancialAnalysis).where(FinancialAnalysis.status == "done")
            .order_by(FinancialAnalysis.period_end.desc()).limit(1)
        )
        la = analyses_r.scalar_one_or_none()
        if la and la.executive_summary:
            sections.append((460, f"## Monthly close analysis ({la.period_end})", la.executive_summary))
    except Exception:
        pass

    # ── Assemble: sort by priority desc, respect token budget ────────────────
    sections.sort(key=lambda x: x[0], reverse=True)
    parts = []
    budget = _CONTEXT_TOKEN_BUDGET
    for _, heading, content in sections:
        block = f"{heading}\n\n{content}\n"
        if len(block) > budget:
            # Truncate this block to fit
            block = block[:budget] + "\n[…truncated to fit context budget]"
            parts.append(block)
            break
        parts.append(block)
        budget -= len(block)
        if budget <= 0:
            break

    return "\n---\n".join(parts)


@app.get("/api/financials/balance-sheet", response_model=list[BalanceSheetLineOut])
async def get_balance_sheet(
    period_end: Optional[date] = Query(None),
    months: int = Query(3, ge=1, le=12),
    db: AsyncSession = Depends(get_db),
):
    q = select(BalanceSheetLine).order_by(BalanceSheetLine.period_end.desc(), BalanceSheetLine.sort_order)
    if period_end:
        q = q.where(BalanceSheetLine.period_end <= period_end)
    r = await db.execute(q.limit(500))
    rows = r.scalars().all()
    periods = sorted(set(row.period_end for row in rows), reverse=True)[:months]
    out = [
        BalanceSheetLineOut(
            period_end=row.period_end,
            section=row.section,
            category=row.category,
            amount=row.amount,
            plan_amount=row.plan_amount,
            is_subtotal=bool(row.is_subtotal),
            sort_order=row.sort_order,
        )
        for row in rows if row.period_end in periods
    ]
    return out


@app.get("/api/financials/analyses", response_model=list[FinancialAnalysisOut])
async def get_financial_analyses(db: AsyncSession = Depends(get_db)):
    r = await db.execute(
        select(FinancialAnalysis).order_by(FinancialAnalysis.period_end.desc()).limit(24)
    )
    return r.scalars().all()


@app.get("/api/financials/tab-snapshots")
async def get_tab_snapshots(db: AsyncSession = Depends(get_db)):
    """Return list of all stored tab snapshots with metadata (not the raw data)."""
    r = await db.execute(
        select(SheetSnapshot)
        .where(SheetSnapshot.range_name.like(f"{_FPA_TAB_SNAPSHOT_PREFIX}%"))
        .order_by(SheetSnapshot.as_of.desc())
    )
    all_snaps = r.scalars().all()
    seen: dict[str, dict] = {}
    for snap in all_snaps:
        title = snap.range_name[len(_FPA_TAB_SNAPSHOT_PREFIX):]
        if title in seen:
            continue
        try:
            rows = json.loads(snap.data_json) if snap.data_json else []
            non_empty = sum(1 for row in rows if any(str(c).strip() for c in row))
        except Exception:
            non_empty = 0
        seen[title] = {
            "title": title,
            "synced_at": snap.as_of.isoformat() if snap.as_of else None,
            "non_empty_rows": non_empty,
            "priority": _TAB_PRIORITY.get(title, _TAB_DEFAULT_PRIORITY),
        }
    return sorted(seen.values(), key=lambda x: -x["priority"])


@app.get("/api/financials/model-map")
async def get_model_map(db: AsyncSession = Depends(get_db)):
    """Return the stored FP&A model map (Claude's understanding of the Google Sheet structure)."""
    r = await db.execute(
        select(SheetSnapshot)
        .where(SheetSnapshot.range_name == _FPA_MODEL_MAP_KEY)
        .order_by(SheetSnapshot.as_of.desc())
        .limit(1)
    )
    row = r.scalar_one_or_none()
    if not row:
        return {"map": None, "as_of": None, "message": "No model map yet. Run POST /api/financials/scan-model first."}
    return {"map": json.loads(row.data_json) if row.data_json else None, "as_of": row.as_of.isoformat() if row.as_of else None}


@app.post("/api/financials/scan-model")
async def scan_financial_model(db: AsyncSession = Depends(get_db)):
    """
    Ask Claude to explore the Google Sheet financial model and produce a structured map
    of what lives on each tab (row labels, columns, key data locations).
    Stores result as a SheetSnapshot with range_name='__fpa_model_map__'.
    """
    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured")

    from connectors.google_sheets import GoogleSheetsConnector
    connector = GoogleSheetsConnector()
    connector.set_base_path(Path(__file__).resolve().parent)

    if not connector.is_configured():
        raise HTTPException(status_code=503, detail="Google Sheets not configured. Set GOOGLE_SHEET_ID and credentials in backend/.env.")

    try:
        sheets = await asyncio.to_thread(connector.list_sheets)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not list sheets: {e}")

    # Sample the first ~40 rows of each tab (skip huge raw-data tabs > 5000 rows to stay within token budget)
    tab_samples: list[dict] = []
    for sh in sheets:
        title = sh["title"]
        row_count = sh.get("rowCount", 0)
        col_count = sh.get("columnCount", 0)
        # Skip only truly massive raw-data tabs that would blow the token budget
        if row_count > 20000 and col_count > 300:
            tab_samples.append({"title": title, "rows": row_count, "cols": col_count, "sample": None, "skipped": "too large"})
            continue
        try:
            sample_rows = min(720, row_count or 720)
            # Column 180 = GH in A1 notation
            raw = await asyncio.to_thread(connector.read_range, f"'{title}'!A1:GH{sample_rows}")
            # Truncate each row to first 180 cols and stringify
            sample = [[str(cell) if cell != "" else "" for cell in row[:180]] for row in (raw or [])[:sample_rows]]
            tab_samples.append({"title": title, "rows": row_count, "cols": col_count, "sample": sample, "skipped": None})
        except Exception as e:
            tab_samples.append({"title": title, "rows": row_count, "cols": col_count, "sample": None, "skipped": str(e)})

    # Build the prompt
    tab_descriptions = []
    for tab in tab_samples:
        block = f"\n### Tab: \"{tab['title']}\" ({tab['rows']} rows × {tab['cols']} cols)"
        if tab["skipped"]:
            block += f"\n[Skipped: {tab['skipped']}]"
        elif tab["sample"]:
            lines = []
            for i, row in enumerate(tab["sample"]):
                if any(cell for cell in row):
                    lines.append(f"  Row {i+1}: {row}")
            block += "\n" + "\n".join(lines[:720])
        tab_descriptions.append(block)

    prompt = f"""You are mapping a Google Sheet financial model for Dazos, a ~$7M ARR SaaS company.
The spreadsheet has {len(sheets)} tabs. Below is a sample of the first ~40 rows of each tab (up to 30 columns wide).

{chr(10).join(tab_descriptions)}

Produce a structured **Financial Model Map** with these sections:

## Tab Index
List every tab with a one-line description of what it contains.

## Key Data Locations
For each financially important tab, describe:
- What rows contain headers vs data
- What columns contain what (e.g. "Column A = line item label, columns B–M = Jan–Dec actuals")
- What the key metrics / KPIs are and which rows/cells they live in
- Any plan vs actual structure (which columns are actuals, which are budget/plan)

## P&L Location
Exactly which tab and rows contain the P&L (income statement). Which columns are months, which are YTD, which are plan vs actual.

## Cash Flow Location
Same for cash flow statement.

## Balance Sheet Location
Same for balance sheet.

## ARR / Revenue Schedule Location
Where ARR or recurring revenue data lives.

## Headcount / Opex Detail
Where headcount plan or detailed opex breakdown lives.

## Notes for the FP&A Agent
Any important structural notes: named ranges, helper tabs, how actuals vs budget are distinguished, fiscal year conventions, etc.

Be specific — include tab names, row numbers, and column letters where you can infer them from the sample."""

    try:
        if not _ANTHROPIC_AVAILABLE:
            raise HTTPException(status_code=503, detail="anthropic package not installed on server")
        client = _anthropic_mod.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
        response = await client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=8192,
            system=_FPA_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": prompt}],
        )
        model_map_text = response.content[0].text if response.content else ""
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Claude error: {e}")

    # Store the model map
    stored = SheetSnapshot(
        source="fpa_model_scan",
        range_name=_FPA_MODEL_MAP_KEY,
        data_json=json.dumps({"text": model_map_text, "tabs": [s["title"] for s in tab_samples]}),
    )
    db.add(stored)

    # Store each tab's raw data as an individual snapshot for agent context
    tabs_stored = 0
    for tab in tab_samples:
        if tab.get("sample") is None:
            continue
        snap_key = f"{_FPA_TAB_SNAPSHOT_PREFIX}{tab['title']}"
        # Delete old snapshots for this tab (keep only latest)
        await db.execute(
            delete(SheetSnapshot).where(SheetSnapshot.range_name == snap_key)
        )
        db.add(SheetSnapshot(
            source="fpa_tab_scan",
            range_name=snap_key,
            data_json=json.dumps(tab["sample"]),
        ))
        tabs_stored += 1

    await db.commit()

    return {"ok": True, "tabs_scanned": len(tab_samples), "tabs_stored": tabs_stored, "map_preview": model_map_text[:500] + "…"}


# ── Financial model sync (Google Sheets → DB) ────────────────────────────────

_SHEET_TAB_MAP = {
    "pnl":  {"actuals": "P&L",                        "plan": "P&L_2026P"},
    "bs":   {"actuals": "BS",                         "plan": "BS_2026P"},
    "cf":   {"actuals": "CF",                         "plan": "CF_2026P"},
    "dept": {"actuals": "Sales & Marketing",           "plan": "Sales & Marketing_2026P",           "default_dept": "Sales & Marketing"},
    "pe":   {"actuals": "Product & Engineering",       "plan": "Product & Engineering_2026P",       "default_dept": "Product & Engineering"},
    "ga":   {"actuals": "General & Administrative",    "plan": "General & Administrative_2026P",    "default_dept": "General & Administrative"},
}

_SYNC_STATUS_KEY_PREFIX = "__sync_status__"

# Ordered list of all model tabs to snapshot for agent context
_ALL_MODEL_TABS = [
    "OVERVIEW", "ASSUMPTIONS",
    "P&L", "BS", "CF",
    "Sales and CS capacity", "Headcount",
    "ARR_Calculations", "ARR_Actuals", "ARR_Schedule",
    "CoGS", "Sales & Marketing", "Product & Engineering", "General & Administrative",
    "OVERVIEW_2026P", "P&L_2026P", "BS_2026P", "CF_2026P",
    "Sales and CS capacity_2026P", "Headcount_2026P", "Hiring plan_2026P",
    "ARR_Calculations_2026P", "CoGS_2026P", "Sales & Marketing_2026P",
    "Product & Engineering_2026P", "General & Administrative_2026P",
]


@app.post("/api/financials/sync-model-tabs")
async def sync_model_tabs(db: AsyncSession = Depends(get_db)):
    """
    Read all model tabs from Google Sheets and store as raw snapshots for agent context.
    """
    from connectors.google_sheets import GoogleSheetsConnector
    connector = GoogleSheetsConnector()
    connector.set_base_path(Path(__file__).resolve().parent)
    if not connector.is_configured():
        raise HTTPException(status_code=503, detail="Google Sheets not configured.")

    # Phase 1: list available tabs
    try:
        available = await asyncio.to_thread(connector.list_sheets)
        available_titles = {s["title"] for s in available}
        _logger.info(f"sync_model_tabs: found {len(available)} tabs in spreadsheet")
    except Exception as e:
        _logger.exception("sync_model_tabs: list_sheets failed")
        raise HTTPException(status_code=500, detail=f"Could not list sheets: {e}")

    results: list[dict] = []

    def _transient_sheets_read_error(msg: str) -> bool:
        """True if a retry may help (Google burst / flaky SSL / rate hints)."""
        m = (msg or "").lower()
        return any(
            x in m
            for x in (
                "ssl", "wrong version", "length mismatch", "internal error",
                "connection reset", "broken pipe", "eof", "temporarily",
                "429", "rate", "quota", "timed out", "timeout",
                "remote end closed", "decryption failed",
            )
        )

    async def _read_one_attempt(tab_name: str, per_tab_timeout: float) -> dict:
        """Single read attempt — no DB access."""
        if tab_name not in available_titles:
            return {"tab": tab_name, "ok": False, "error": "Tab not found in spreadsheet"}
        try:
            raw = await asyncio.wait_for(
                asyncio.to_thread(connector.read_range, f"'{tab_name}'!A1:CX500"),
                timeout=per_tab_timeout,
            )
            if not raw:
                return {"tab": tab_name, "ok": False, "error": "Empty or unreadable"}
            lines = []
            for row in raw:
                cells = [str(c) for c in row]
                if any(c.strip() for c in cells):
                    lines.append("\t".join(cells))
            return {"tab": tab_name, "ok": True, "rows": len(lines), "text": "\n".join(lines)}
        except asyncio.TimeoutError:
            return {"tab": tab_name, "ok": False, "error": f"Timed out after {int(per_tab_timeout)}s"}
        except Exception as e:
            return {"tab": tab_name, "ok": False, "error": str(e)}

    async def _read_one(tab_name: str) -> dict:
        """Read with retries; sequential callers avoid Google API SSL / burst issues."""
        per_tab_timeout = 90.0
        max_attempts = 3
        last: dict | None = None
        for attempt in range(1, max_attempts + 1):
            if attempt > 1:
                await asyncio.sleep(0.8 * attempt)
            last = await _read_one_attempt(tab_name, per_tab_timeout)
            if last.get("ok"):
                return last
            err = last.get("error") or ""
            if attempt < max_attempts and _transient_sheets_read_error(err):
                _logger.warning("sync_model_tabs: retry %d/%d for %s: %s", attempt, max_attempts, tab_name, err[:200])
                continue
            _logger.warning("sync_model_tabs: failed %s after %d attempt(s): %s", tab_name, attempt, err[:400])
            return last

    # Phase 1: read tabs one at a time (no parallel Google calls — avoids SSL / rate-limit storms)
    read_results: list[dict] = []
    for idx, tab_name in enumerate(_ALL_MODEL_TABS):
        read_results.append(await _read_one(tab_name))
        if idx + 1 < len(_ALL_MODEL_TABS):
            await asyncio.sleep(0.35)

    # Phase 2: write to DB sequentially (one session, no concurrency issues)
    for r in read_results:
        if not r.get("ok"):
            results.append({"tab": r["tab"], "ok": False, "error": r.get("error")})
            continue
        try:
            snap_key = f"{_FPA_TAB_SNAPSHOT_PREFIX}{r['tab']}"
            await db.execute(delete(SheetSnapshot).where(SheetSnapshot.range_name == snap_key))
            db.add(SheetSnapshot(
                source="model_tab_sync",
                range_name=snap_key,
                data_json=json.dumps({"text": r["text"], "rows": r["rows"]}),
            ))
            results.append({"tab": r["tab"], "ok": True, "rows": r["rows"]})
        except Exception as e:
            _logger.exception(f"sync_model_tabs: DB write error for {r['tab']}")
            results.append({"tab": r["tab"], "ok": False, "error": f"DB error: {e}"})

    await db.commit()

    synced = [r for r in results if r["ok"]]
    failed = [r for r in results if not r["ok"]]
    return {"synced": len(synced), "failed": len(failed), "details": results}


@app.get("/api/financials/model-tabs-status")
async def get_model_tabs_status(db: AsyncSession = Depends(get_db)):
    """Return sync status for each model tab."""
    r = await db.execute(
        select(SheetSnapshot)
        .where(SheetSnapshot.range_name.like(f"{_FPA_TAB_SNAPSHOT_PREFIX}%"))
        .order_by(SheetSnapshot.as_of.desc())
    )
    rows = r.scalars().all()
    # Latest snapshot per tab
    seen: dict[str, SheetSnapshot] = {}
    for row in rows:
        title = row.range_name[len(_FPA_TAB_SNAPSHOT_PREFIX):]
        if title not in seen:
            seen[title] = row
    out = []
    for tab in _ALL_MODEL_TABS:
        snap = seen.get(tab)
        if snap:
            d = json.loads(snap.data_json) if snap.data_json else {}
            out.append({
                "tab": tab,
                "synced": True,
                "synced_at": snap.as_of.isoformat() if snap.as_of else None,
                "rows": d.get("rows"),
            })
        else:
            out.append({"tab": tab, "synced": False, "synced_at": None, "rows": None})
    return {"tabs": out}


def _col_letter(n: int) -> str:
    """Convert 1-based column index to A1 letter (1=A, 26=Z, 27=AA, …)."""
    result = ""
    while n > 0:
        n, rem = divmod(n - 1, 26)
        result = chr(65 + rem) + result
    return result


def _excel_serial_to_month_label(value) -> str | None:
    """
    Convert an Excel date serial number to a 'Mon YYYY' label (e.g. 46051 → 'Feb 2026').
    Returns None if the value doesn't look like a plausible Excel date serial (2000-2040).
    """
    from datetime import date, timedelta
    try:
        n = int(float(str(value)))
    except (ValueError, TypeError):
        return None
    # Excel serials for 2000-01-01 through 2040-12-31 ≈ 36526 – 51910
    if not (36526 <= n <= 51910):
        return None
    try:
        d = date(1899, 12, 30) + timedelta(days=n)
        return d.strftime("%b %Y")  # e.g. "Feb 2026"
    except Exception:
        return None


def _sheet_to_compact_text(rows: list[list], max_rows: int = 500, max_cols: int = 120) -> str:
    """Convert raw sheet rows to a compact text block, skipping fully-empty rows.
    Excel date serial numbers in header rows are converted to readable month labels."""
    lines = []
    for i, row in enumerate(rows[:max_rows]):
        raw_cells = row[:max_cols]
        cells: list[str] = []
        for c in raw_cells:
            s = str(c) if c != "" else ""
            # Replace Excel date serials with readable month labels
            label = _excel_serial_to_month_label(s)
            cells.append(label if label is not None else s)
        # Skip rows where every cell is empty
        if not any(c.strip() for c in cells):
            continue
        # Trim trailing empty cells
        while cells and not cells[-1].strip():
            cells.pop()
        lines.append(f"R{i+1}: {cells}")
    return "\n".join(lines)


_MONTH_LABEL_RE = re.compile(r'^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(20\d{2})$')


def _sheet_to_monthly_compact_text(
    rows: list[list],
    max_rows: int = 500,
    min_year: int = 2024,
    max_year: int = 2026,
) -> str:
    """
    Like _sheet_to_compact_text but keeps only the row-label columns (first 2)
    and monthly period columns whose header matches 'Mon YYYY' within [min_year, max_year].
    This reduces 100+ column sheets to ~40 columns, cutting prompt size by 60-70%.
    Excel date serials in headers are converted first.
    """
    # Build all rows with serial-to-label conversion applied
    all_rows: list[list[str]] = []
    for row in rows[:max_rows]:
        cells: list[str] = []
        for c in row[:200]:
            s = str(c) if c != "" else ""
            lbl = _excel_serial_to_month_label(s)
            cells.append(lbl if lbl is not None else s)
        all_rows.append(cells)

    # Find the header row that contains month labels and collect matching col indices
    month_col_indices: list[int] = []
    for row in all_rows:
        cols = []
        for j, cell in enumerate(row):
            m = _MONTH_LABEL_RE.match(cell.strip())
            if m and min_year <= int(m.group(2)) <= max_year:
                cols.append(j)
        if len(cols) >= 3:
            month_col_indices = cols
            break

    if not month_col_indices:
        # No monthly header found — fall back to standard compact text (limited cols)
        return _sheet_to_compact_text(rows, max_rows=max_rows, max_cols=50)

    lines: list[str] = []
    for i, row in enumerate(all_rows):
        label_cols = [row[j] if j < len(row) else "" for j in range(2)]
        month_vals = [row[j] if j < len(row) else "" for j in month_col_indices]
        combined = label_cols + month_vals
        if not any(c.strip() for c in combined):
            continue
        # Trim trailing empty cells
        while combined and not combined[-1].strip():
            combined.pop()
        if not any(c.strip() for c in combined):
            continue
        lines.append(f"R{i+1}: {combined}")

    return "\n".join(lines)


def _sheet_titles_index(available: list[dict]) -> dict[str, str]:
    """Map lowered tab title → exact title as in Google Sheets (for A1 quoting)."""
    out: dict[str, str] = {}
    for s in available or []:
        t = (s.get("title") or "").strip()
        if t:
            out[t.lower()] = t
    return out


async def _read_tab_live(
    connector,
    exact_title: str,
    max_rows: int = 500,
    max_cols: int = 120,
) -> tuple[list[list], str | None]:
    """Read tab from Google with retries. Returns (rows, None) or ([], error)."""
    last_col = _col_letter(max_cols)
    range_a1 = f"'{exact_title}'!A1:{last_col}{max_rows}"
    last_err: str | None = None
    for attempt in range(1, 4):
        if attempt > 1:
            await asyncio.sleep(0.45 * attempt)
        try:
            raw = await asyncio.to_thread(connector.read_range, range_a1)
            if raw and any(any(str(c).strip() for c in row) for row in raw):
                return raw, None
            last_err = f"Empty or all-blank range for tab '{exact_title}'"
        except Exception as e:
            last_err = str(e)
            _logger.warning("_read_tab_live attempt %s/3 %s: %s", attempt, exact_title, last_err[:220])
    return [], last_err or "read failed"


def _snapshot_text_to_rows(text: str) -> list[list]:
    """Rebuild row matrix from Step-1 sync compact TSV lines."""
    rows: list[list] = []
    for line in (text or "").split("\n"):
        if not line.strip():
            continue
        rows.append(line.split("\t"))
    return rows


async def _load_statement_tab_rows(
    db: AsyncSession,
    connector,
    canonical_tab_name: str,
    titles_by_lower: dict[str, str],
    max_rows: int = 500,
    max_cols: int = 120,
) -> tuple[list[list], str | None]:
    """
    Resolve tab name against spreadsheet metadata, read live with retries,
    then fall back to Step-1 ``SheetSnapshot`` (__tab__…) if Google read fails.
    """
    want = canonical_tab_name.strip()
    exact = titles_by_lower.get(want.lower(), want)
    rows, err = await _read_tab_live(connector, exact, max_rows=max_rows, max_cols=max_cols)
    if rows:
        return rows, None
    snap_key = f"{_FPA_TAB_SNAPSHOT_PREFIX}{want}"
    r = await db.execute(
        select(SheetSnapshot)
        .where(SheetSnapshot.range_name == snap_key)
        .order_by(SheetSnapshot.as_of.desc())
        .limit(1)
    )
    snap = r.scalar_one_or_none()
    if snap and snap.data_json:
        try:
            d = json.loads(snap.data_json)
            t = d.get("text") or ""
            snap_rows = _snapshot_text_to_rows(t)
            if snap_rows:
                _logger.info("sync-from-sheet: using SheetSnapshot for tab %s (%d rows)", want, len(snap_rows))
                return snap_rows, None
        except Exception as ex:
            _logger.warning("sync-from-sheet: snapshot parse failed for %s: %s", want, ex)
    detail = err or "no data"
    return [], (
        f"Tab '{canonical_tab_name}' not available from Google Sheets ({detail}). "
        f"If Step 1 synced this tab, try Parse again; otherwise run Step 1 — Sync all model tabs."
    )


_CLAUDE_FINANCIAL_MODEL = "claude-sonnet-4-5"
# Large extractions need a high ceiling; Anthropic SDK rejects non-streaming when implied time > 10 min.
_CLAUDE_FINANCIAL_MAX_TOKENS = 32768


def _strip_claude_json_fences(text: str) -> str:
    text = (text or "").strip()
    if text.startswith("```"):
        text = "\n".join(text.split("\n")[1:])
    if text.endswith("```"):
        text = "\n".join(text.split("\n")[:-1])
    return text.strip()


async def _anthropic_financial_extraction_text(client, user_prompt: str) -> str:
    """Stream the message body — required for high max_tokens (see anthropic _calculate_nonstreaming_timeout)."""
    async with client.messages.stream(
        model=_CLAUDE_FINANCIAL_MODEL,
        max_tokens=_CLAUDE_FINANCIAL_MAX_TOKENS,
        messages=[{"role": "user", "content": user_prompt}],
    ) as stream:
        return await stream.get_final_text()


import calendar as _calendar

# ─────────────────────────────────────────────────────────────────────────────
# Direct sheet parsers — no LLM needed
# ─────────────────────────────────────────────────────────────────────────────

def _find_monthly_col_map(rows: list[list], year: int = 2026) -> dict[str, int]:
    """Scan header rows for 'Mon YYYY' labels and return {period_end_iso: col_idx}."""
    _MON_ABBR = {'jan':1,'feb':2,'mar':3,'apr':4,'may':5,'jun':6,
                 'jul':7,'aug':8,'sep':9,'oct':10,'nov':11,'dec':12}
    _MON_RE = re.compile(r'^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*[\s.]+(\d{4})$', re.I)
    result: dict[str, int] = {}
    for row in rows[:20]:
        found: dict[str, int] = {}
        for j, cell in enumerate(row[:220]):
            s = str(cell).strip()
            lbl = _excel_serial_to_month_label(s) or s
            m = _MON_RE.match(lbl)
            if m and int(m.group(2)) == year:
                mon = _MON_ABBR.get(m.group(1)[:3].lower(), 0)
                if mon:
                    last = _calendar.monthrange(year, mon)[1]
                    found[f'{year}-{mon:02d}-{last:02d}'] = j
        if found:
            result = found
            break
    return result  # {period_end: col_idx}


def _cell_num(row: list, col: int) -> float | None:
    """Return float from row[col], or None if empty/non-numeric."""
    if col >= len(row):
        return None
    v = row[col]
    if v is None or str(v).strip() == '':
        return None
    try:
        return float(str(v).replace(',', ''))
    except (ValueError, TypeError):
        return None


def _row_lbl(row: list) -> str:
    """Return the best label for a sheet row: prefer col 1, fall back to col 2 (indented detail rows)."""
    c1 = str(row[1]).strip() if len(row) > 1 else ''
    if c1:
        return c1
    return str(row[2]).strip() if len(row) > 2 else ''


def _plan_lookup(plan_rows: list[list]) -> dict[str, list]:
    """Build {lower_label: row} for plan tab rows, keeping the FIRST occurrence per label.

    The first occurrence is the actual balance-sheet / P&L line item.  Later occurrences
    of the same label (e.g. reconciliation section headers in BS_2026P for
    'Accounts receivable', 'Deferred revenue', 'Accounts payable') are section stubs
    without monthly column values and must not overwrite the real plan row.
    """
    out: dict[str, list] = {}
    for row in plan_rows:
        lbl = _row_lbl(row)
        if lbl and lbl.lower() not in out:   # first occurrence wins
            out[lbl.lower()] = row
    return out


def _direct_extract_pnl(actuals_rows: list[list], plan_rows: list[list], year: int = 2026) -> list[dict]:
    """Parse P&L data directly from raw sheet rows — no LLM required."""
    act_cols = _find_monthly_col_map(actuals_rows, year)
    pln_cols = _find_monthly_col_map(plan_rows, year) if plan_rows else {}
    pln_map  = _plan_lookup(plan_rows) if plan_rows else {}
    if not act_cols:
        return []

    # Phase → line_type mapping; phase changes on hitting known section labels
    _PHASE_RE = [
        (re.compile(r'^revenue$', re.I),                         'revenue',    'revenue', True),
        (re.compile(r'^cost of goods', re.I),                    'cogs',       'cogs',    True),
        (re.compile(r'^gross (profit|margin)$', re.I),           'gp',         'other',   True),
        (re.compile(r'(total\s+)?operating exp', re.I),          'opex',       'opex',    True),
        (re.compile(r'^ebitda$', re.I),                          'below_eb',   'other',   True),
        (re.compile(r'^net (income|loss)', re.I),                'below_eb',   'other',   True),
    ]
    _PHASE_TYPE = {'revenue':'revenue','cogs':'cogs','gp':'other','opex':'opex','below_eb':'other'}

    phase = 'revenue'
    items: list[dict] = []
    sort_order = 0
    done = False  # stop after Net Income row

    for row in actuals_rows:
        if done:
            break
        lbl = _row_lbl(row)
        if not lbl:
            continue
        has_data = any(_cell_num(row, c) is not None for c in act_cols.values())
        if not has_data:
            # Still check for phase transitions on blank-value rows
            for pat, new_ph, _, _ in _PHASE_RE:
                if pat.search(lbl):
                    phase = new_ph
            continue

        line_type, is_sub = _PHASE_TYPE.get(phase, 'other'), False
        for pat, new_ph, lt, is_s in _PHASE_RE:
            if pat.search(lbl):
                phase, line_type, is_sub = new_ph, lt, is_s
                break

        pln_row = pln_map.get(lbl.lower())
        periods = []
        for pe in sorted(act_cols):
            actual = _cell_num(row, act_cols[pe])
            plan   = _cell_num(pln_row, pln_cols[pe]) if pln_row and pe in pln_cols else None
            periods.append({'period_end': pe, 'actual': actual or 0.0, 'plan': plan})

        sort_order += 1
        items.append({'line_type': line_type, 'category': lbl,
                      'is_subtotal': is_sub, 'sort_order': sort_order, 'periods': periods})

        # Stop extracting after the Net Income row — everything below is supplemental
        if re.search(r'^net (income|loss)', lbl, re.I):
            done = True

    # ── Plan-only rows for future months (used by the 2026 Forecast view) ─────
    future_pe = sorted(pe for pe in pln_cols if pe not in act_cols)
    if future_pe and plan_rows and pln_cols:
        p_phase = 'revenue'
        for row in plan_rows:
            lbl = _row_lbl(row)
            if not lbl:
                continue
            has_plan = any(_cell_num(row, pln_cols[pe]) is not None for pe in future_pe)
            if not has_plan:
                for pat, new_ph, _, _ in _PHASE_RE:
                    if pat.search(lbl):
                        p_phase = new_ph
                continue
            p_lt, p_sub = _PHASE_TYPE.get(p_phase, 'other'), False
            for pat, new_ph, lt, is_s in _PHASE_RE:
                if pat.search(lbl):
                    p_phase, p_lt, p_sub = new_ph, lt, is_s
                    break
            sort_order += 1
            periods = [{'period_end': pe, 'actual': 0.0, 'plan': _cell_num(row, pln_cols[pe])} for pe in future_pe]
            items.append({'line_type': p_lt, 'category': lbl,
                          'is_subtotal': p_sub, 'sort_order': sort_order,
                          'is_plan_only': True, 'periods': periods})
            if re.search(r'^net (income|loss)', lbl, re.I):
                break

    return items


def _direct_extract_cf(actuals_rows: list[list], plan_rows: list[list], year: int = 2026) -> list[dict]:
    """Parse Cash Flow data directly from raw sheet rows — no LLM required."""
    act_cols = _find_monthly_col_map(actuals_rows, year)
    pln_cols = _find_monthly_col_map(plan_rows, year) if plan_rows else {}
    pln_map  = _plan_lookup(plan_rows) if plan_rows else {}
    if not act_cols:
        return []

    _SEC_RE = [
        (re.compile(r'operating activities', re.I),  'operating'),
        (re.compile(r'investing activities', re.I),  'investing'),
        (re.compile(r'financing activities', re.I),  'financing'),
    ]
    _NET_RE = re.compile(r'^net cash (provided|used|from|increase|generated)', re.I)

    section = 'operating'
    items: list[dict] = []
    sort_order = 0

    for row in actuals_rows:
        lbl = _row_lbl(row)
        if not lbl:
            continue
        has_data = any(_cell_num(row, c) is not None for c in act_cols.values())
        # Update section from header rows (no data) or inline
        for pat, sec in _SEC_RE:
            if pat.search(lbl):
                section = sec
                break
        if not has_data:
            continue

        is_sub = bool(_NET_RE.match(lbl.strip()))
        pln_row = pln_map.get(lbl.lower())
        periods = []
        for pe in sorted(act_cols):
            actual = _cell_num(row, act_cols[pe])
            plan   = _cell_num(pln_row, pln_cols[pe]) if pln_row and pe in pln_cols else None
            periods.append({'period_end': pe, 'actual': actual or 0.0, 'plan': plan})

        sort_order += 1
        items.append({'section': section, 'category': lbl,
                      'is_subtotal': is_sub, 'sort_order': sort_order, 'periods': periods})
    return items


def _direct_extract_bs(actuals_rows: list[list], plan_rows: list[list], year: int = 2026) -> list[dict]:
    """Parse Balance Sheet data directly from raw sheet rows — no LLM required."""
    act_cols = _find_monthly_col_map(actuals_rows, year)
    pln_cols = _find_monthly_col_map(plan_rows, year) if plan_rows else {}
    pln_map  = _plan_lookup(plan_rows) if plan_rows else {}
    if not act_cols:
        return []

    _BS_SUB_RE = re.compile(
        r'^(total (current )?(assets?|liabilities|equity|capital)|'
        r'fixed assets,?\s*net|total liabilities (and equity)?)', re.I
    )
    # Section transitions: row label → next section
    _SEC_TRANS = [
        (re.compile(r'^total assets$', re.I),       'liability'),
        (re.compile(r'^total liabilities$', re.I),  'equity'),
    ]

    section = 'asset'
    items: list[dict] = []
    sort_order = 0

    for row in actuals_rows:
        lbl = _row_lbl(row)
        if not lbl:
            continue
        has_data = any(_cell_num(row, c) is not None for c in act_cols.values())
        if not has_data:
            continue

        is_sub = bool(_BS_SUB_RE.search(lbl.strip()))
        pln_row = pln_map.get(lbl.lower())
        periods = []
        for pe in sorted(act_cols):
            actual = _cell_num(row, act_cols[pe])
            plan   = _cell_num(pln_row, pln_cols[pe]) if pln_row and pe in pln_cols else None
            periods.append({'period_end': pe, 'actual': actual or 0.0, 'plan': plan})

        sort_order += 1
        items.append({'section': section, 'category': lbl,
                      'is_subtotal': is_sub, 'sort_order': sort_order, 'periods': periods})

        # Stop after "Total liabilities and equity" — everything below is supplemental
        if re.search(r'total liabilities and equity', lbl, re.I):
            break

        # Switch section AFTER adding the row
        for pat, new_sec in _SEC_TRANS:
            if pat.search(lbl):
                section = new_sec
                break
    return items


def _direct_extract_dept(
    actuals_rows: list[list],
    plan_rows: list[list],
    year: int = 2026,
    default_dept: str = 'Sales & Marketing',
) -> list[dict]:
    """Parse department detail from raw sheet rows.

    `default_dept` sets the department for rows that appear before any department
    header (e.g. combined total rows at the top of the sheet).
    Department header rows and "Total …" rows are marked is_subtotal=True.

    Plan matching is dept-aware: each (dept, label) pair is matched independently
    so the same label appearing under different departments (e.g. "Salaries" under
    Sales, Marketing, and CS) maps to the correct plan row for that department.
    """
    act_cols = _find_monthly_col_map(actuals_rows, year)
    pln_cols = _find_monthly_col_map(plan_rows, year) if plan_rows else {}
    if not act_cols:
        return []

    # Department header patterns → canonical dept name (used in both actuals + plan passes)
    _DEPT_RE = [
        (re.compile(r'^sales$', re.I),                              'Sales'),
        (re.compile(r'^marketing$', re.I),                          'Marketing'),
        (re.compile(r'^customer success$', re.I),                   'Customer Success'),
        (re.compile(r'^product\s*(&|and)\s*engineering$', re.I),    'Product & Engineering'),
        (re.compile(r'^general\s*(&|and)\s*administrative$', re.I), 'General & Administrative'),
    ]

    def _detect_dept(lbl: str, current: str) -> str:
        for pat, name in _DEPT_RE:
            if pat.match(lbl.strip()):
                return name
        return current

    # Build dept-aware plan map: (dept, lower_label) → row
    # Keep the FIRST occurrence per key so the aggregate section wins over per-dept duplicates.
    dept_plan_map: dict[tuple[str, str], list] = {}
    if plan_rows and pln_cols:
        pln_dept = default_dept
        for row in plan_rows:
            lbl = _row_lbl(row)
            if not lbl:
                continue
            pln_dept = _detect_dept(lbl, pln_dept)
            key = (pln_dept, lbl.lower())
            if key not in dept_plan_map:
                dept_plan_map[key] = row

    dept = default_dept
    items: list[dict] = []
    sort_order = 0

    for row in actuals_rows:
        lbl = _row_lbl(row)
        if not lbl:
            continue
        has_data = any(_cell_num(row, c) is not None for c in act_cols.values())
        if not has_data:
            dept = _detect_dept(lbl, dept)
            continue

        dept = _detect_dept(lbl, dept)

        # Mark department header rows and "Total …" rows as subtotals
        is_sub = any(pat.match(lbl.strip()) for pat, _ in _DEPT_RE)
        if not is_sub and re.match(r'^total\s+', lbl, re.I):
            is_sub = True

        pln_row = dept_plan_map.get((dept, lbl.lower()))
        periods = []
        for pe in sorted(act_cols):
            actual = _cell_num(row, act_cols[pe])
            plan   = _cell_num(pln_row, pln_cols[pe]) if pln_row and pe in pln_cols else None
            periods.append({'period_end': pe, 'actual': actual or 0.0, 'plan': plan})

        sort_order += 1
        items.append({'dept': dept, 'category': lbl,
                      'is_subtotal': is_sub, 'sort_order': sort_order, 'periods': periods})

    # ── Plan-only rows for future months ──────────────────────────────────────
    future_pe = sorted(pe for pe in pln_cols if pe not in act_cols)
    if future_pe and plan_rows and pln_cols:
        pln_dept2 = default_dept
        for row in plan_rows:
            lbl = _row_lbl(row)
            if not lbl:
                continue
            pln_dept2 = _detect_dept(lbl, pln_dept2)
            has_plan = any(_cell_num(row, pln_cols[pe]) is not None for pe in future_pe)
            if not has_plan:
                continue
            is_sub = any(pat.match(lbl.strip()) for pat, _ in _DEPT_RE)
            if not is_sub and re.match(r'^total\s+', lbl, re.I):
                is_sub = True
            sort_order += 1
            periods = [{'period_end': pe, 'actual': 0.0, 'plan': _cell_num(row, pln_cols[pe])} for pe in future_pe]
            items.append({'dept': pln_dept2, 'category': lbl,
                          'is_subtotal': is_sub, 'sort_order': sort_order,
                          'is_plan_only': True, 'periods': periods})

    return items


async def _claude_extract_pnl(client, actuals_text: str, plan_text: str, period: str) -> list[dict]:
    """Ask Claude to extract P&L line items from raw sheet text, returning structured JSON."""
    prompt = f"""Below are two raw Google Sheet tabs for Dazos's P&L.
TAB 1 = ACTUALS (QuickBooks export). TAB 2 = PLAN (2026 budget model).

CRITICAL: Each tab has THREE column sections in this order:
  1. Annual totals (headers: "2023", "2024", "2025", "2026", "2027", "2028") — SKIP these
  2. Quarterly periods (headers: "Q1'23", "Q2'23", ..., "Q4'28") — SKIP these
  3. Monthly periods (headers: "Jan 2023", "Feb 2023", ..., "Mar 2026", etc.) — USE ONLY THESE

You MUST extract data ONLY from the monthly columns (section 3). Ignore annual and quarterly columns entirely.

ACTUALS:
{actuals_text}

PLAN:
{plan_text}

Extract ALL financial line items (from the monthly section only). For each, return a JSON array of objects:
{{
  "line_type": "revenue" | "cogs" | "opex" | "other",
  "category": "<exact row label>",
  "is_subtotal": true | false,
  "sort_order": <integer, preserving original row order>,
  "periods": [
    {{"period_end": "YYYY-MM-DD", "actual": <number or null>, "plan": <number or null>}}
  ]
}}

Rules:
- period_end must be the last day of the month (e.g. Jan 2026 → "2026-01-31", Feb 2026 → "2026-02-28", Mar 2026 → "2026-03-31")
- Extract EVERY monthly column present — do NOT skip any month, even if it is between two other months or has some zero values
- Costs/expenses should be NEGATIVE numbers (as they appear in a P&L)
- Skip only columns that are explicitly labelled as totals/YTD/full-year (e.g. "Total", "YTD", "FY2026") — never skip a named month column
- Match plan amounts to the same period_end as actuals; if plan has no corresponding month, set plan to null
- Skip rows that are purely formatting (blank, separator lines, repeating headers)
- line_type: revenue = top-line revenue; cogs = cost of goods sold / cost of revenue; opex = operating expenses (S&M, R&D, G&A, etc.); other = EBITDA, net income, interest, etc.
- is_subtotal = true for any row that summarizes other rows (Total Revenue, Gross Profit, Total Opex, EBITDA, Net Income, etc.)

Return ONLY the JSON array, no commentary."""

    raw = await _anthropic_financial_extraction_text(client, prompt)
    text = _strip_claude_json_fences(raw) or "[]"
    return json.loads(text)


async def _claude_extract_cf(client, actuals_text: str, plan_text: str) -> list[dict]:
    """Ask Claude to extract Cash Flow line items."""
    prompt = f"""Below are two raw Google Sheet tabs for Dazos's Cash Flow Statement.
TAB 1 = ACTUALS. TAB 2 = PLAN.

CRITICAL: Each tab has THREE column sections in this order:
  1. Annual totals (headers: "2023", "2024", "2025", "2026", "2027", "2028") — SKIP these
  2. Quarterly periods (headers: "Q1'23", "Q2'23", ..., "Q4'28") — SKIP these
  3. Monthly periods (headers: "Jan 2023", "Feb 2023", ..., "Mar 2026", etc.) — USE ONLY THESE

You MUST extract data ONLY from the monthly columns (section 3). Ignore annual and quarterly columns entirely.
Extract only months that have actual data up to the latest available month (skip future projections beyond the latest actual).

ACTUALS:
{actuals_text}

PLAN:
{plan_text}

Extract ALL cash flow line items (from the monthly section only). Return a JSON array:
{{
  "section": "operating" | "investing" | "financing",
  "category": "<exact row label>",
  "sort_order": <integer>,
  "periods": [
    {{"period_end": "YYYY-MM-DD", "actual": <number or null>, "plan": <number or null>}}
  ]
}}

Rules:
- period_end = last day of month (e.g. "2026-01-31", "2026-02-28", "2026-03-31")
- Extract EVERY monthly column present — do NOT skip any month
- Cash outflows should be NEGATIVE
- Skip blank/separator/header-only rows
- Assign section based on standard cash flow statement sections
- Match actual and plan by the same month label (e.g. "Jan 2026")

Return ONLY the JSON array."""

    raw = await _anthropic_financial_extraction_text(client, prompt)
    text = _strip_claude_json_fences(raw) or "[]"
    return json.loads(text)


async def _claude_extract_bs(client, actuals_text: str, plan_text: str) -> list[dict]:
    """Ask Claude to extract Balance Sheet line items."""
    prompt = f"""Below are two raw Google Sheet tabs for Dazos's Balance Sheet.
TAB 1 = ACTUALS. TAB 2 = PLAN.

CRITICAL: Each tab has THREE column sections in this order:
  1. Annual totals (headers: "2023", "2024", "2025", "2026", "2027", "2028") — SKIP these
  2. Quarterly periods (headers: "Q1'23", "Q2'23", ..., "Q4'28") — SKIP these
  3. Monthly periods (headers: "Jan 2023", "Feb 2023", ..., "Mar 2026", etc.) — USE ONLY THESE

You MUST extract data ONLY from the monthly columns (section 3). Ignore annual and quarterly columns entirely.
Extract only months that have actual data up to the latest available month (skip future projections beyond the latest actual).

ACTUALS:
{actuals_text}

PLAN:
{plan_text}

Extract ALL balance sheet line items (from the monthly section only). Return a JSON array:
{{
  "section": "asset" | "liability" | "equity",
  "category": "<exact row label>",
  "is_subtotal": true | false,
  "sort_order": <integer>,
  "periods": [
    {{"period_end": "YYYY-MM-DD", "actual": <number or null>, "plan": <number or null>}}
  ]
}}

Rules:
- period_end = last day of month (e.g. "2026-01-31", "2026-02-28", "2026-03-31")
- Extract EVERY monthly column present — do NOT skip any month
- Assets are positive; liabilities and equity are typically positive in a balance sheet
- is_subtotal = true for Total Assets, Total Current Liabilities, Total Equity, etc.
- Skip blank/separator/header-only rows
- Match actual and plan by the same month label (e.g. "Jan 2026")

Return ONLY the JSON array."""

    raw = await _anthropic_financial_extraction_text(client, prompt)
    text = _strip_claude_json_fences(raw) or "[]"
    return json.loads(text)


@app.get("/api/financials/parse-preview")
async def parse_preview(
    statement: str = Query("cf", description="pnl | bs | cf"),
    db: AsyncSession = Depends(get_db),
):
    """Debug: run the direct parser and return extracted items without writing to DB."""
    from connectors.google_sheets import GoogleSheetsConnector
    connector = GoogleSheetsConnector()
    connector.set_base_path(Path(__file__).resolve().parent)
    if not connector.is_configured():
        raise HTTPException(status_code=503, detail="Google Sheets not configured.")
    tabs = _SHEET_TAB_MAP.get(statement)
    if not tabs:
        raise HTTPException(status_code=400, detail="Unknown statement")
    available_tabs = await asyncio.to_thread(connector.list_sheets)
    titles_by_lower = _sheet_titles_index(available_tabs)
    actuals_raw, _ = await _load_statement_tab_rows(db, connector, tabs["actuals"], titles_by_lower)
    plan_raw, _    = await _load_statement_tab_rows(db, connector, tabs["plan"],    titles_by_lower)
    act_col_map = _find_monthly_col_map(actuals_raw or [], 2026)
    pln_col_map = _find_monthly_col_map(plan_raw or [],   2026)
    # Sample labels from plan tab (first 60 non-empty)
    plan_labels = [str(r[1]).strip() for r in (plan_raw or []) if len(r) > 1 and str(r[1]).strip()][:60]
    if statement == "cf":
        items = _direct_extract_cf(actuals_raw or [], plan_raw or [], 2026)
    elif statement == "pnl":
        items = _direct_extract_pnl(actuals_raw or [], plan_raw or [], 2026)
    else:
        items = _direct_extract_bs(actuals_raw or [], plan_raw or [], 2026)
    return {
        "actuals_col_map": act_col_map,
        "plan_col_map": pln_col_map,
        "plan_labels_sample": plan_labels,
        "item_count": len(items),
        "items": [{"category": x["category"], "section": x.get("section",""), "is_subtotal": x.get("is_subtotal", False), "periods_with_plan": sum(1 for p in x["periods"] if p["plan"] is not None)} for x in items],
    }


@app.get("/api/financials/sync-status")
async def get_sync_status(db: AsyncSession = Depends(get_db)):
    """Return last sync timestamps for each financial statement."""
    result = {}
    for stmt in ["pnl", "bs", "cf"]:
        key = f"{_SYNC_STATUS_KEY_PREFIX}{stmt}"
        r = await db.execute(
            select(SheetSnapshot).where(SheetSnapshot.range_name == key)
            .order_by(SheetSnapshot.as_of.desc()).limit(1)
        )
        row = r.scalar_one_or_none()
        if row and row.data_json:
            d = json.loads(row.data_json)
            # SQLite strips tz info on write; re-attach UTC so the browser converts correctly
            as_of_utc = row.as_of.replace(tzinfo=timezone.utc).isoformat() if row.as_of else None
            result[stmt] = {"synced_at": as_of_utc, **d}
        else:
            result[stmt] = None
    return result


@app.post("/api/financials/sync-from-sheet")
async def sync_financials_from_sheet(
    statement: str = Query("all", description="pnl | bs | cf | all"),
    db: AsyncSession = Depends(get_db),
):
    """
    Read actuals + plan tabs from Google Sheets and parse them directly
    into structured DB records (no LLM required).
    """
    from connectors.google_sheets import GoogleSheetsConnector
    connector = GoogleSheetsConnector()
    connector.set_base_path(Path(__file__).resolve().parent)
    if not connector.is_configured():
        raise HTTPException(status_code=503, detail="Google Sheets not configured.")

    statements = ["pnl", "bs", "cf", "dept", "pe", "ga"] if statement == "all" else [statement]
    if any(s not in _SHEET_TAB_MAP for s in statements):
        raise HTTPException(status_code=400, detail=f"Unknown statement. Use: pnl, bs, cf, dept, pe, ga, all")

    results = {}

    available_tabs = await asyncio.to_thread(connector.list_sheets)
    titles_by_lower = _sheet_titles_index(available_tabs)

    for stmt in statements:
        tabs = _SHEET_TAB_MAP[stmt]
        try:
            # Sequential reads + retries reduce Google API SSL errors; snapshot fallback uses Step-1 data.
            actuals_raw, a_err = await _load_statement_tab_rows(
                db, connector, tabs["actuals"], titles_by_lower,
            )
            await asyncio.sleep(0.25)
            plan_raw, _p_err = await _load_statement_tab_rows(
                db, connector, tabs["plan"], titles_by_lower,
            )

            if not actuals_raw:
                results[stmt] = {"ok": False, "error": a_err or f"Tab '{tabs['actuals']}' not found or empty"}
                continue

            # Direct parser — no LLM needed
            if stmt == "pnl":
                items = _direct_extract_pnl(actuals_raw, plan_raw or [], year=2026)
            elif stmt == "cf":
                items = _direct_extract_cf(actuals_raw, plan_raw or [], year=2026)
            elif stmt in ("dept", "pe", "ga"):
                default_dept = tabs.get("default_dept", "Sales & Marketing")
                items = _direct_extract_dept(actuals_raw, plan_raw or [], year=2026, default_dept=default_dept)
            else:
                items = _direct_extract_bs(actuals_raw, plan_raw or [], year=2026)

            if not items:
                results[stmt] = {"ok": False, "error": "Direct parser found no line items — check sheet tab names and data"}
                continue

            # Collect all period_end dates returned
            all_periods: set[date] = set()
            for item in items:
                for p in item.get("periods", []):
                    try:
                        all_periods.add(date.fromisoformat(p["period_end"]))
                    except Exception:
                        pass

            # Delete existing rows for those periods then re-insert
            if stmt == "pnl":
                for pd_ in all_periods:
                    await db.execute(delete(PnLLine).where(PnLLine.period_end == pd_))
                await db.flush()
                for item in items:
                    for p in item.get("periods", []):
                        try:
                            pd_ = date.fromisoformat(p["period_end"])
                        except Exception:
                            continue
                        db.add(PnLLine(
                            period_end=pd_,
                            line_type=item.get("line_type", "other"),
                            category=item.get("category", ""),
                            amount=float(p.get("actual") or 0),
                            plan_amount=float(p["plan"]) if p.get("plan") is not None else None,
                            is_subtotal=1 if item.get("is_subtotal") else 0,
                            is_plan_only=1 if item.get("is_plan_only") else 0,
                            sort_order=item.get("sort_order", 0),
                        ))

            elif stmt == "cf":
                for pd_ in all_periods:
                    await db.execute(delete(CashFlowLine).where(CashFlowLine.period_end == pd_))
                await db.flush()
                for item in items:
                    for p in item.get("periods", []):
                        try:
                            pd_ = date.fromisoformat(p["period_end"])
                        except Exception:
                            continue
                        db.add(CashFlowLine(
                            period_end=pd_,
                            section=item.get("section", "operating"),
                            category=item.get("category", ""),
                            amount=float(p.get("actual") or 0),
                            plan_amount=float(p["plan"]) if p.get("plan") is not None else None,
                            is_subtotal=1 if item.get("is_subtotal") else 0,
                            sort_order=item.get("sort_order", 0),
                        ))

            elif stmt == "bs":
                for pd_ in all_periods:
                    await db.execute(delete(BalanceSheetLine).where(BalanceSheetLine.period_end == pd_))
                await db.flush()
                for item in items:
                    for p in item.get("periods", []):
                        try:
                            pd_ = date.fromisoformat(p["period_end"])
                        except Exception:
                            continue
                        db.add(BalanceSheetLine(
                            period_end=pd_,
                            section=item.get("section", "asset"),
                            category=item.get("category", ""),
                            amount=float(p.get("actual") or 0),
                            plan_amount=float(p["plan"]) if p.get("plan") is not None else None,
                            is_subtotal=1 if item.get("is_subtotal") else 0,
                            sort_order=item.get("sort_order", 0),
                        ))

            elif stmt in ("dept", "pe", "ga"):
                # Determine which dept names this sheet can produce, so we only delete those rows
                _DEPT_SCOPE = {
                    "dept": ["Sales & Marketing", "Sales", "Marketing", "Customer Success"],
                    "pe":   ["Product & Engineering"],
                    "ga":   ["General & Administrative"],
                }
                dept_names = _DEPT_SCOPE[stmt]
                for pd_ in all_periods:
                    await db.execute(
                        delete(DeptDetailLine)
                        .where(DeptDetailLine.period_end == pd_)
                        .where(DeptDetailLine.dept.in_(dept_names))
                    )
                await db.flush()
                for item in items:
                    for p in item.get("periods", []):
                        try:
                            pd_ = date.fromisoformat(p["period_end"])
                        except Exception:
                            continue
                        db.add(DeptDetailLine(
                            period_end=pd_,
                            dept=item.get("dept", ""),
                            category=item.get("category", ""),
                            amount=float(p.get("actual") or 0),
                            plan_amount=float(p["plan"]) if p.get("plan") is not None else None,
                            is_subtotal=1 if item.get("is_subtotal") else 0,
                            is_plan_only=1 if item.get("is_plan_only") else 0,
                            sort_order=item.get("sort_order", 0),
                        ))

            await db.commit()

            # Save sync status
            status_key = f"{_SYNC_STATUS_KEY_PREFIX}{stmt}"
            existing_status = await db.execute(
                select(SheetSnapshot).where(SheetSnapshot.range_name == status_key).limit(1)
            )
            status_row = existing_status.scalar_one_or_none()
            status_data = json.dumps({
                "rows_synced": len(items),
                "periods_synced": len(all_periods),
                "actuals_tab": tabs["actuals"],
                "plan_tab": tabs["plan"],
            })
            if status_row:
                status_row.data_json = status_data
                status_row.as_of = datetime.now(timezone.utc)
            else:
                db.add(SheetSnapshot(source="financials_sync", range_name=status_key, data_json=status_data))
            await db.commit()

            results[stmt] = {"ok": True, "rows_synced": len(items), "periods_synced": len(all_periods)}

        except json.JSONDecodeError as e:
            results[stmt] = {"ok": False, "error": f"Claude returned invalid JSON: {e}"}
        except Exception as e:
            results[stmt] = {"ok": False, "error": str(e)}
            try:
                await db.rollback()
            except Exception:
                pass

    return {"results": results}


@app.post("/api/financials/monthly-close")
async def trigger_monthly_close(
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    """Trigger Claude to generate a monthly close variance analysis for a given period."""
    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured")

    period_str = body.get("period_end")
    if not period_str:
        raise HTTPException(status_code=400, detail="period_end required (YYYY-MM-DD)")
    try:
        period = date.fromisoformat(period_str)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid period_end format")

    # Upsert FinancialAnalysis row
    existing_r = await db.execute(
        select(FinancialAnalysis).where(FinancialAnalysis.period_end == period)
    )
    analysis = existing_r.scalar_one_or_none()
    if analysis is None:
        analysis = FinancialAnalysis(period_end=period, status="running")
        db.add(analysis)
    else:
        analysis.status = "running"
        analysis.error_msg = None
    await db.commit()
    await db.refresh(analysis)

    try:
        if not _ANTHROPIC_AVAILABLE:
            raise HTTPException(status_code=503, detail="anthropic package not installed on server")
        client = _anthropic_mod.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)

        # Gather P&L data for the period and YTD
        fiscal_year_start = date(period.year, 1, 1)
        pnl_r = await db.execute(
            select(PnLLine)
            .where(PnLLine.period_end >= fiscal_year_start)
            .where(PnLLine.period_end <= period)
            .order_by(PnLLine.period_end, PnLLine.sort_order)
        )
        pnl_rows = pnl_r.scalars().all()

        cf_r = await db.execute(
            select(CashFlowLine)
            .where(CashFlowLine.period_end >= fiscal_year_start)
            .where(CashFlowLine.period_end <= period)
            .order_by(CashFlowLine.period_end, CashFlowLine.sort_order)
        )
        cf_rows = cf_r.scalars().all()

        bs_r = await db.execute(
            select(BalanceSheetLine).where(BalanceSheetLine.period_end == period)
            .order_by(BalanceSheetLine.sort_order)
        )
        bs_rows = bs_r.scalars().all()

        # Format data for Claude
        def fmt_pnl(rows, label="P&L"):
            periods = sorted(set(r.period_end for r in rows))
            month_period = period
            ytd_categories: dict = {}
            month_categories: dict = {}
            all_cats = []
            seen: set = set()
            for r in rows:
                if r.category not in seen:
                    seen.add(r.category)
                    all_cats.append(r.category)
                ytd_categories.setdefault(r.category, {"actual": 0, "plan": 0})
                ytd_categories[r.category]["actual"] += r.amount
                if r.plan_amount is not None:
                    ytd_categories[r.category]["plan"] += r.plan_amount
                if r.period_end == month_period:
                    month_categories[r.category] = {"actual": r.amount, "plan": r.plan_amount, "line_type": r.line_type, "is_subtotal": r.is_subtotal}

            out = [f"\n### {label} — {month_period.strftime('%B %Y')}\n"]
            out.append(f"{'Category':<35} {'Month Actual':>14} {'Month Plan':>12} {'Month Var':>12} {'YTD Actual':>12} {'YTD Plan':>10} {'YTD Var':>10}")
            out.append("-" * 110)
            for cat in all_cats:
                m = month_categories.get(cat, {})
                m_actual = m.get("actual")
                m_plan = m.get("plan")
                ytd = ytd_categories.get(cat, {})
                y_actual = ytd.get("actual")
                y_plan = ytd.get("plan") if ytd.get("plan") else None
                m_var = (m_actual - m_plan) if m_actual is not None and m_plan is not None else None
                y_var = (y_actual - y_plan) if y_actual is not None and y_plan is not None else None
                out.append(
                    f"{cat:<35} "
                    f"{('$' + f'{m_actual:,.0f}') if m_actual is not None else '—':>14} "
                    f"{('$' + f'{m_plan:,.0f}') if m_plan is not None else '—':>12} "
                    f"{('$' + f'{m_var:,.0f}') if m_var is not None else '—':>12} "
                    f"{('$' + f'{y_actual:,.0f}') if y_actual is not None else '—':>12} "
                    f"{('$' + f'{y_plan:,.0f}') if y_plan is not None else '—':>10} "
                    f"{('$' + f'{y_var:,.0f}') if y_var is not None else '—':>10}"
                )
            return "\n".join(out)

        def fmt_cf(rows):
            out = [f"\n### Cash Flow — {period.strftime('%B %Y')}\n"]
            month_rows = [r for r in rows if r.period_end == period]
            for r in month_rows:
                var = (r.amount - r.plan_amount) if r.plan_amount is not None else None
                out.append(f"- [{r.section}] {r.category}: actual ${r.amount:,.0f}" +
                           (f" | plan ${r.plan_amount:,.0f} | var ${var:,.0f}" if var is not None else ""))
            return "\n".join(out)

        def fmt_bs(rows):
            out = [f"\n### Balance Sheet — {period.strftime('%B %Y')}\n"]
            for r in rows:
                var = (r.amount - r.plan_amount) if r.plan_amount is not None else None
                out.append(f"- [{r.section}] {r.category}: actual ${r.amount:,.0f}" +
                           (f" | plan ${r.plan_amount:,.0f} | var ${var:,.0f}" if var is not None else ""))
            return "\n".join(out)

        data_block = fmt_pnl(pnl_rows) + "\n" + fmt_cf(cf_rows) + "\n" + fmt_bs(bs_rows)

        pnl_prompt = f"""You are generating the P&L variance analysis section for the {period.strftime('%B %Y')} monthly close report.

{data_block}

Write a concise P&L variance analysis (3–5 paragraphs) covering:
1. Revenue: month and YTD performance vs plan, key drivers
2. Gross margin: trend and drivers
3. Opex: major variances by category, flag anything >5% from plan
4. Net/EBITDA: month and YTD position vs plan
Lead with the headline number. Be specific about amounts. Include a "So what" with one recommended action."""

        cf_prompt = f"""You are generating the Cash Flow variance analysis for the {period.strftime('%B %Y')} monthly close.

{data_block}

Write a concise cash flow analysis (2–3 paragraphs) covering:
1. Operating cash flow: actual vs plan, working capital movements
2. Investing and financing activities
3. Net cash change and ending position
Flag anything materially off-plan. Include a "So what" with one recommended action."""

        bs_prompt = f"""You are generating the Balance Sheet commentary for the {period.strftime('%B %Y')} monthly close.

{data_block}

Write a concise balance sheet analysis (2–3 paragraphs) covering:
1. Key asset movements (cash, AR, other)
2. Liabilities and working capital position
3. Any items materially different from plan
Be precise with numbers."""

        exec_prompt = f"""You are generating the executive summary for the {period.strftime('%B %Y')} monthly close.

{data_block}

Write 5–7 concise bullet points (executive-ready) covering the most important financial developments this month:
- Lead each bullet with the number
- Flag risks and opportunities explicitly
- Include one forward-looking action item
Format as a markdown bullet list. No headers, no preamble."""

        async def ask_claude(prompt: str) -> str:
            msg = await client.messages.create(
                model="claude-sonnet-4-5",
                max_tokens=1024,
                system=_FPA_SYSTEM_PROMPT,
                messages=[{"role": "user", "content": prompt}],
            )
            return msg.content[0].text if msg.content else ""

        pnl_analysis, cf_analysis, bs_analysis, exec_summary = await asyncio.gather(
            ask_claude(pnl_prompt),
            ask_claude(cf_prompt),
            ask_claude(bs_prompt),
            ask_claude(exec_prompt),
        )

        analysis.pnl_analysis = pnl_analysis
        analysis.cashflow_analysis = cf_analysis
        analysis.balance_sheet_analysis = bs_analysis
        analysis.executive_summary = exec_summary
        analysis.status = "done"
        await db.commit()
        return {"ok": True, "period_end": str(period)}

    except Exception as e:
        analysis.status = "error"
        analysis.error_msg = str(e)
        await db.commit()
        raise HTTPException(status_code=500, detail=f"Analysis failed: {e}")


# ── Chargebee tool (shared between FP&A chat and unified agent chat) ──────────

_CHARGEBEE_TOOL: dict = {
    "name": "chargebee_query",
    "description": (
        "Fetch live billing data from Chargebee. Use ONLY for cash and billing questions: "
        "invoices, payments, collections, overdue balances, payment failures, billing status. "
        "Do NOT use for ARR, MRR, NRR, subscription counts, churn, expansion, or any revenue metric — "
        "those always come from Salesforce. "
        "Amounts are in cents — divide by 100 for dollars."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "resource": {
                "type": "string",
                "enum": ["subscriptions", "invoices", "customers", "transactions"],
                "description": "Which Chargebee resource to fetch.",
            },
            "filters": {
                "type": "object",
                "description": (
                    "Optional filters. Supported keys: "
                    "status (subscriptions: active/cancelled/non_renewing; "
                    "invoices: paid/payment_due/not_paid; transactions: success/failure), "
                    "date_after (YYYY-MM-DD — filters by invoice or transaction date), "
                    "date_before (YYYY-MM-DD), "
                    "type (transactions only: payment/refund)."
                ),
                "additionalProperties": True,
            },
            "limit": {
                "type": "integer",
                "description": "Max records to return (default 50, max 100).",
                "default": 50,
            },
        },
        "required": ["resource"],
    },
}


async def _execute_chargebee_tool(resource: str, filters: dict | None = None, limit: int = 50) -> str:
    """Execute a Chargebee resource fetch and return compact text result."""
    import datetime as _dt
    from connectors.chargebee import ChargebeeConnector

    connector = ChargebeeConnector()
    if not connector.is_configured():
        return "ERROR: Chargebee is not configured (CHARGEBEE_SITE / CHARGEBEE_API_KEY missing)."

    filters = filters or {}
    limit = min(100, max(1, limit))

    def _to_ts(date_str: str) -> int | None:
        try:
            d = _dt.date.fromisoformat(str(date_str))
            return int(_dt.datetime(d.year, d.month, d.day, tzinfo=_dt.timezone.utc).timestamp())
        except Exception:
            return None

    try:
        status = filters.get("status")
        date_after = _to_ts(filters["date_after"]) if "date_after" in filters else None
        date_before = _to_ts(filters["date_before"]) if "date_before" in filters else None
        txn_type = filters.get("type")

        if resource == "subscriptions":
            resp = await asyncio.to_thread(connector.list_subscriptions, limit=limit, status=status)
            items = [item.get("subscription", item) for item in (resp.get("list") or [])]
        elif resource == "invoices":
            resp = await asyncio.to_thread(
                connector.list_invoices,
                limit=limit,
                status=status,
                date_after_ts=date_after,
                date_before_ts=date_before,
            )
            items = [item.get("invoice", item) for item in (resp.get("list") or [])]
        elif resource == "customers":
            resp = await asyncio.to_thread(connector.list_customers, limit=limit)
            items = [item.get("customer", item) for item in (resp.get("list") or [])]
        elif resource == "transactions":
            resp = await asyncio.to_thread(
                connector.list_transactions,
                limit=limit,
                type=txn_type,
                status=status,
                date_after_ts=date_after,
                date_before_ts=date_before,
            )
            items = [item.get("transaction", item) for item in (resp.get("list") or [])]
        else:
            return f"ERROR: Unknown resource '{resource}'. Use: subscriptions, invoices, customers, transactions."

        if not items:
            return f"0 {resource} returned."
        result_json = json.dumps(items, default=str, indent=2)
        if len(result_json) > 20000:
            result_json = result_json[:20000] + "\n...(truncated)"
        return f"{len(items)} {resource} returned:\n{result_json}"
    except Exception as exc:
        return f"ERROR: {exc}"


# ── Google Sheets tool (shared between FP&A chat and unified agent chat) ──────

_SHEETS_TOOL: dict = {
    "name": "google_sheets_query",
    "description": (
        "Read live data directly from the Dazos Google Sheets financial model. "
        "Use this when the pre-loaded context doesn't have the specific detail needed — "
        "e.g. individual G&A line items, a specific row or range, custom formulas, or data "
        "from a tab not included in the snapshot. "
        "Call list_sheets first if you're unsure which tab or range to read. "
        "When a tab has separate **actual** vs **plan / forecast** month columns, use the actual column "
        "for closed months — do not add plan + actual for the same line and month."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["read_range", "list_sheets"],
                "description": (
                    "read_range: fetch cell data from a specific A1 range (e.g. 'P&L!A1:Z100'). "
                    "list_sheets: list all available sheet tabs with their dimensions."
                ),
            },
            "range": {
                "type": "string",
                "description": (
                    "A1 notation range to read. Required for read_range. "
                    "Examples: 'P&L!A1:Z100', 'OVERVIEW_2026P!A1:ZZ50', 'G&A Detail!A:Z'."
                ),
            },
            "reason": {
                "type": "string",
                "description": "Brief explanation of what data this fetches and why.",
            },
        },
        "required": ["action"],
    },
}


async def _execute_sheets_tool(action: str, range_a1: str | None = None) -> str:
    """Read live data from the Google Sheets financial model."""
    from connectors.google_sheets import GoogleSheetsConnector

    connector = GoogleSheetsConnector()
    connector.set_base_path(Path(__file__).resolve().parent)

    if not connector.sheet_id:
        return "ERROR: Google Sheets not configured (GOOGLE_SHEET_ID not set in .env)."

    try:
        if action == "list_sheets":
            sheets = await asyncio.to_thread(connector.list_sheets)
            if not sheets:
                return "No sheet tabs found."
            lines = ["Available sheet tabs:"]
            for s in sheets:
                lines.append(
                    f"- {s['title']}  ({s.get('rowCount', '?')} rows × {s.get('columnCount', '?')} cols)"
                )
            return "\n".join(lines)

        if action == "read_range":
            if not range_a1:
                return "ERROR: 'range' parameter is required for read_range."
            rows = await asyncio.to_thread(connector.read_range, range_a1)
            if not rows:
                return f"Range '{range_a1}' returned no data."
            lines = []
            for row in rows[:300]:
                lines.append("\t".join("" if cell is None else str(cell) for cell in row))
            text = "\n".join(lines)
            if len(text) > 25000:
                text = text[:25000] + "\n...(truncated)"
            return f"{len(rows)} rows from '{range_a1}':\n{text}"

        return f"ERROR: Unknown action '{action}'. Use read_range or list_sheets."

    except Exception as exc:
        return f"ERROR reading sheet: {exc}"


@app.post("/api/financials/fpa-chat", response_model=FPAChatResponse)
async def fpa_chat(body: FPAChatRequest, db: AsyncSession = Depends(get_db)):
    """Chat with the FP&A analyst agent (Claude). Can query Chargebee live via tool use."""
    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured — add it to backend/.env")
    if not _ANTHROPIC_AVAILABLE:
        raise HTTPException(status_code=503, detail="anthropic package not installed on server")

    client = _anthropic_mod.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
    context = await _build_fpa_context(db)
    system = (
        _FPA_SYSTEM_PROMPT
        + "\n\n"
        + context
        + (
            "\n\n---\n\n## Live Data Tools\n\n"
            "You have two live-data tools:\n"
            "1. `google_sheets_query` — read live data from the Dazos Google Sheets financial model. "
            "Use this for any financial detail not in the pre-loaded context: specific P&L line items, "
            "G&A breakdown, budget vs actuals rows, custom ranges. "
            "Call list_sheets first if unsure which tab to use. "
            "The pre-loaded context already includes **P&L** and **operating expenses by department** from the same "
            "sync as the Financials app; legal and similar fees are usually under **General & Administrative**.\n"
            "2. `chargebee_query` — live billing data: invoices, payments, collections, overdue balances. "
            "Use ONLY for cash/billing questions — never for ARR or revenue metrics (those come from Salesforce context)."
        )
    )

    messages = [{"role": m["role"], "content": m["content"]} for m in body.messages]
    if not messages:
        raise HTTPException(status_code=400, detail="messages required")

    answer = ""
    # Agentic loop — Sheets often needs list_sheets + one or more read_range calls
    for _round in range(_AGENT_MAX_TOOL_ROUNDS):
        response = await client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=4096,
            system=system,
            tools=[_SHEETS_TOOL, _CHARGEBEE_TOOL],
            messages=messages,
        )

        tool_use_blocks = [b for b in response.content if b.type == "tool_use"]

        if not tool_use_blocks or response.stop_reason == "end_turn":
            answer = _anthropic_response_text(response.content) or answer
            if not answer and response.stop_reason == "max_tokens":
                answer = "The reply was cut off (token limit). Please ask a narrower question or split it into parts."
            break

        messages.append({"role": "assistant", "content": response.content})

        tool_results = []
        for block in tool_use_blocks:
            if block.name == "google_sheets_query":
                action = block.input.get("action", "")
                range_a1 = block.input.get("range")
                _logger.info("FP&A Sheets query [round %d]: action=%s range=%s", _round + 1, action, range_a1)
                result = await _execute_sheets_tool(action, range_a1)
            elif block.name == "chargebee_query":
                resource = block.input.get("resource", "")
                filters = block.input.get("filters", {})
                limit = block.input.get("limit", 50)
                _logger.info("FP&A CB query [round %d]: %s filters=%s", _round + 1, resource, filters)
                result = await _execute_chargebee_tool(resource, filters, limit)
            else:
                result = f"ERROR: Unknown tool '{block.name}'."
            tool_results.append({"type": "tool_result", "tool_use_id": block.id, "content": result})

        messages.append({"role": "user", "content": tool_results})

    if not answer.strip():
        _logger.warning("fpa_chat: empty answer after %d tool rounds", _AGENT_MAX_TOOL_ROUNDS)
        answer = (
            "I could not finish a reply — often this means the maximum number of data-fetch steps was reached "
            "without a final answer, or the model returned no text. Please try again. "
            "For legal or G&A spend, the **Operating expenses by department** section in context (or the "
            "`General & Administrative` sheet tab via google_sheets_query) usually has the line items."
        )

    return FPAChatResponse(answer=answer)


@app.post("/api/copilot", response_model=CopilotResponse)
async def copilot(body: CopilotRequest, db: AsyncSession = Depends(get_db)):
    """Answer ARR-related questions using live data or past EOD snapshots."""
    q = body.question.strip()
    q_lower = q.lower()
    today_est = datetime.now(EST).date()

    # How did CARR/ARR change (today / vs last snapshot)
    if ("arr" in q_lower or "carr" in q_lower) and ("change" in q_lower or "diff" in q_lower or "compared" in q_lower or "vs " in q_lower):
        data_now, _ = await _get_arr_data_for_date(db, None)
        current_arr = data_now.get("grand_total") or 0
        r = await db.execute(
            select(SalesforceEODSnapshot)
            .where(SalesforceEODSnapshot.snapshot_date < today_est)
            .order_by(SalesforceEODSnapshot.snapshot_date.desc())
            .limit(1)
        )
        snap = r.scalar_one_or_none()
        if snap and snap.data_json:
            payload = json.loads(snap.data_json)
            data_prev = _arr_from_snapshot_payload(payload)
            prev_arr = data_prev.get("grand_total") or 0
            prev_rows = len(data_prev.get("rows") or [])
            # Snapshot may show $0 if it was taken before sync (e.g. manual run or first deploy)
            if prev_arr == 0 and prev_rows == 0 and current_arr > 1000:
                return CopilotResponse(
                    answer=f"**Total CARR** today is **${current_arr:,.0f}**. The EOD snapshot for {snap.snapshot_date.isoformat()} shows **$0** with no accounts—it was likely taken before data was synced (e.g. right after deploy). For accurate day-over-day comparison, ensure the daily snapshot runs at **23:59 EST** after the hourly sync, or trigger **Sync from Salesforce** then **Take EOD snapshot** so future snapshots have data.",
                    sources=["Customer overview (open renewals)", f"EOD snapshot ({snap.snapshot_date.isoformat()})"],
                )
            delta = round(current_arr - prev_arr, 2)
            pct = round((delta / prev_arr * 100), 1) if prev_arr else None
            if delta > 0:
                change = f"up **${delta:,.0f}**" + (f" ({pct:+.1f}%)" if pct is not None else "")
            elif delta < 0:
                change = f"down **${abs(delta):,.0f}**" + (f" ({pct:.1f}%)" if pct is not None else "")
            else:
                change = "unchanged"
            return CopilotResponse(
                answer=f"**Total CARR** is **${current_arr:,.0f}** now (was **${prev_arr:,.0f}** in the EOD snapshot for {snap.snapshot_date.isoformat()}). CARR has **{change}** since then.",
                sources=["Customer overview (open renewals)", f"EOD snapshot ({snap.snapshot_date.isoformat()})"],
            )
        return CopilotResponse(
            answer=f"**Total CARR** today is **${current_arr:,.0f}**. There’s no earlier EOD snapshot to compare; run the app so it can save daily snapshots (23:59 EST).",
            sources=["Customer overview (open renewals)"],
        )

    as_of_date = _parse_date_from_question(q)
    data, source_label = await _get_arr_data_for_date(db, as_of_date)
    rows = data.get("rows") or []
    grand_total = data.get("grand_total") or 0
    date_note = f" (as of {as_of_date})" if as_of_date else ""

    # Total CARR / how much CARR
    if any(phrase in q_lower for phrase in ("total arr", "total carr", "how much arr", "how much carr", "what's our arr", "what's our carr", "what is our arr", "what is our carr", "total recurring", "arr as of", "carr as of", "arr on ", "carr on ")):
        return CopilotResponse(
            answer=f"**Total CARR**{date_note} is **${grand_total:,.0f}** (Live ARR on the schedule plus Closed Won New Business and Expansion ARR with service start after today).",
            sources=[source_label],
        )

    # Largest / biggest / top customer by ARR
    if any(phrase in q_lower for phrase in ("largest customer", "biggest customer", "top customer", "who is our largest", "largest account", "biggest account")):
        if rows:
            rows_by_carr = sorted(
                rows,
                key=lambda x: -float(x.get("contracted_arr") or x.get("total_arr") or 0),
            )
            top = rows_by_carr[0]
            name = top.get("account_name") or "—"
            arr = float(top.get("contracted_arr") or top.get("total_arr") or 0)
            return CopilotResponse(
                answer=f"Your **largest customer** among renewal accounts by CARR{date_note} is **{name}** with **${arr:,.0f}** (column = Live ARR + future Closed Won NB/Exp for that account).",
                sources=[source_label],
            )
        return CopilotResponse(
            answer="No customer ARR data available for that period. Sync from Salesforce and ensure EOD snapshots exist for past dates.",
            sources=[],
        )

    # CARR/ARR up for renewal in a given month
    if ("renewal" in q_lower or "arr" in q_lower or "carr" in q_lower) and _parse_renewal_month_from_question(q):
        ym = _parse_renewal_month_from_question(q)
        if ym:
            year, month = ym
            in_month = []
            for row in rows:
                end_str = row.get("subscription_end_date")
                if not end_str:
                    continue
                try:
                    d = datetime.fromisoformat(end_str.replace("Z", "+00:00")).date()
                    if d.year == year and d.month == month:
                        in_month.append(row)
                except (ValueError, TypeError):
                    continue
            total_arr = round(sum(r.get("total_arr") or 0 for r in in_month), 2)
            month_name = next((k for k, v in _MONTH_NAMES.items() if v == month and len(k) > 3), str(month))
            month_label = month_name.capitalize() if month_name.isalpha() else f"{month_name} {year}"
            if total_arr > 0:
                accounts_list = ", ".join((r.get("account_name") or "—") for r in in_month[:10])
                if len(in_month) > 10:
                    accounts_list += f" and {len(in_month) - 10} more"
                return CopilotResponse(
                    answer=f"**${total_arr:,.0f} CARR** is up for renewal in **{month_label} {year}** ({len(in_month)} account(s)). Accounts include: {accounts_list}.",
                    sources=[source_label],
                )
            return CopilotResponse(
                answer=f"No CARR is currently up for renewal in **{month_label} {year}**. Subscription end dates are from open renewal opportunities.",
                sources=[source_label],
            )

    return CopilotResponse(
        answer="I only answer **CARR-related** questions (contracted ARR). You can ask about current data or past dates (e.g. 'Total CARR as of March 2025' or 'Largest customer last month') when EOD snapshots exist. Try: 'What's our total CARR?' or 'How did CARR change today?' or 'What CARR is up for renewal in March '26?'",
        sources=[],
    )


# ----- Google Sheets sync (Phase 1a) -----

@app.get("/api/sheet-snapshots/latest")
async def get_latest_sheet_snapshot(
    range_name: str = Query(..., description="A1 range, e.g. Plan!A1:Z50"),
    db: AsyncSession = Depends(get_db),
):
    """Return the most recent snapshot for the given range, if any."""
    r = await db.execute(
        select(SheetSnapshot)
        .where(SheetSnapshot.range_name == range_name)
        .order_by(SheetSnapshot.as_of.desc())
        .limit(1)
    )
    row = r.scalar_one_or_none()
    if not row:
        return {"range_name": range_name, "as_of": None, "data": None, "message": "No snapshot yet. Run POST /api/sync/google-sheets first."}
    data = json.loads(row.data_json) if row.data_json else []
    return {"range_name": range_name, "as_of": row.as_of.isoformat() if row.as_of else None, "data": data}


@app.post("/api/sync/google-sheets")
async def sync_google_sheets(
    range_name: str = Query(..., description="A1 range to sync, e.g. Plan!A1:Z50"),
    db: AsyncSession = Depends(get_db),
):
    """
    Fetch the given range from the configured Google Sheet and store it as a snapshot.
    Requires GOOGLE_SHEET_ID and credentials (see README).
    """
    from connectors.google_sheets import GoogleSheetsConnector

    connector = GoogleSheetsConnector()
    if not connector.is_configured():
        return {
            "ok": False,
            "error": "Google Sheets not configured. Set GOOGLE_SHEET_ID and GOOGLE_APPLICATION_CREDENTIALS (or GOOGLE_SHEETS_CREDENTIALS_JSON) in backend/.env.",
        }
    try:
        # Run the blocking Google API call in a thread so we don't block the event loop
        data = await asyncio.to_thread(connector.read_range, range_name)
        data = await asyncio.to_thread(_merge_arr_2026p_bu35_from_direct_cell, connector, range_name, data)
    except Exception as e:
        err_msg = str(e)
        # Common Google Sheets misconfigurations → turn into actionable guidance instead of raw HttpError
        if "403" in err_msg or "does not have permission" in err_msg.lower():
            sa_email = connector.get_service_account_email()
            err_msg = (
                "Google Sheets: permission denied. Share your financial model sheet with the service account as **Editor**: "
                + (sa_email or "see client_email in your JSON key")
                + "."
            )
        elif "404" in err_msg or "Unable to parse range" in err_msg or "not found" in err_msg.lower():
            err_msg = (
                "Google Sheets: could not read range "
                f"\"{range_name}\". Check that the spreadsheet referenced by GOOGLE_SHEET_ID has a tab "
                "matching the sheet name in the range (e.g. `BS_2026P` for `BS_2026P!A1:ZZ1000`). "
                "Raw error: " + err_msg[:200]
            )
        return {"ok": False, "error": err_msg}
    snapshot = SheetSnapshot(source="google_sheets", range_name=range_name, data_json=json.dumps(data))
    db.add(snapshot)
    await db.commit()
    return {"ok": True, "range_name": range_name, "rows": len(data), "message": "Snapshot saved. Use GET /api/sheet-snapshots/latest?range_name=... to read it."}


# ----- Salesforce sync (Phase 1b) -----

# Default SOQL for opportunities (ARR / pipeline). RecordType.Name for ARR (renewals only). MRR from Finance Details.
# If your MRR field has a different API name, set SALESFORCE_MRR_FIELD in .env (e.g. MRR__c).
_SALESFORCE_MRR_FIELD = os.getenv("SALESFORCE_MRR_FIELD", "MRR__c").strip() or "MRR__c"
# Optional: custom Renewal Date field on Opportunity (e.g. Renewal_Date__c). When set, renewals overview uses it instead of Close Date.
_SALESFORCE_RENEWAL_DATE_FIELD = (os.getenv("SALESFORCE_RENEWAL_DATE_FIELD") or "").strip()
# ARR up for renewal (UFR baseline) field on Opportunity.
# NOTE: Hard-coded to remove env-loading ambiguity during debugging.
_SALESFORCE_UFR_ARR_FIELD = "Original_ARR__c"

# Positive renewal expansion uplift to include in bookings.
# NOTE: Hard-coded to remove env-loading ambiguity during debugging.
_SALESFORCE_EXPANSION_ARR_FIELD = "Expansion_ARR__c"
# Optional: Contract Start/End on Opportunity for New Business (e.g. Contract_Start_Date__c, Contract_End_Date__c). Used for subscription start/end in Active ARR.
_SALESFORCE_CONTRACT_START_DATE_FIELD = (os.getenv("SALESFORCE_CONTRACT_START_DATE_FIELD") or "Contract_Start_Date__c").strip() or ""
_SALESFORCE_CONTRACT_END_DATE_FIELD = (os.getenv("SALESFORCE_CONTRACT_END_DATE_FIELD") or "Contract_End_Date__c").strip() or ""
# Optional: Midterm Cancellation on Opportunity (e.g. Midterm_Cancellation__c). When true on a Closed Lost renewal, subscription end = that opp's contract_end_date.
_SALESFORCE_MIDTERM_CANCELLATION_FIELD = (os.getenv("SALESFORCE_MIDTERM_CANCELLATION_FIELD") or "Midterm_Cancellation__c").strip() or ""
# AI-agent enrichment fields on Opportunity (set to empty string to disable)
_SF_LEAD_TYPE_FIELD       = (os.getenv("SALESFORCE_LEAD_TYPE_FIELD",       "Lead_Type__c")).strip()
_SF_CURRENT_CRM_FIELD     = (os.getenv("SALESFORCE_CURRENT_CRM_FIELD",     "Current_CRM__c")).strip()
_SF_CURRENT_VOIP_FIELD    = (os.getenv("SALESFORCE_CURRENT_VOIP_FIELD",    "Current_VOIP__c")).strip()
_SF_DEAL_TIER_FIELD       = (os.getenv("SALESFORCE_DEAL_TIER_FIELD",       "Deal_Tier__c")).strip()

# Account health / risk fields (synced from Salesforce; configurable via env vars)
_SF_ACC_HEALTH_SCORE_FIELD      = (os.getenv("SF_ACCOUNT_HEALTH_SCORE_FIELD",       "Master_Health_Score_Calc__c")).strip()
_SF_ACC_RISK_SCORE_FIELD        = (os.getenv("SF_ACCOUNT_RISK_SCORE_FIELD",         "Risk_Score__c")).strip()
_SF_ACC_PRODUCT_USAGE_FIELD     = (os.getenv("SF_ACCOUNT_PRODUCT_USAGE_SCORE_FIELD","Product_Usage_Score__c")).strip()
_SF_ACC_FINANCIAL_SCORE_FIELD   = (os.getenv("SF_ACCOUNT_FINANCIAL_SCORE_FIELD",    "Financial_Score__c")).strip()
_SF_ACC_ENGAGEMENT_SCORE_FIELD  = (os.getenv("SF_ACCOUNT_ENGAGEMENT_SCORE_FIELD",   "Customer_Engagement_Score__c")).strip()
_SF_ACC_SUPPORT_SCORE_FIELD     = (os.getenv("SF_ACCOUNT_SUPPORT_SCORE_FIELD",      "Support_Score__c")).strip()
_SF_ACC_JOURNEY_PHASE_FIELD     = (os.getenv("SF_ACCOUNT_JOURNEY_PHASE_FIELD",      "Customer_Journey_Phase__c")).strip()
_SF_ACC_PAYMENT_STATUS_FIELD    = (os.getenv("SF_ACCOUNT_PAYMENT_STATUS_FIELD",     "Payment_Status__c")).strip()
_SF_ACC_OUTSTANDING_BAL_FIELD   = (os.getenv("SF_ACCOUNT_OUTSTANDING_BAL_FIELD",    "Outstanding_Balance__c")).strip()
_SF_ACC_OVERDUE_INV_FIELD       = (os.getenv("SF_ACCOUNT_OVERDUE_INV_FIELD",        "Overdue_Invoice_Count__c")).strip()

_ALL_ACC_HEALTH_FIELDS = [
    _SF_ACC_HEALTH_SCORE_FIELD, _SF_ACC_RISK_SCORE_FIELD, _SF_ACC_PRODUCT_USAGE_FIELD,
    _SF_ACC_FINANCIAL_SCORE_FIELD, _SF_ACC_ENGAGEMENT_SCORE_FIELD, _SF_ACC_SUPPORT_SCORE_FIELD,
    _SF_ACC_JOURNEY_PHASE_FIELD, _SF_ACC_PAYMENT_STATUS_FIELD,
    _SF_ACC_OUTSTANDING_BAL_FIELD, _SF_ACC_OVERDUE_INV_FIELD,
]


def _account_soql_health_fields() -> str:
    """Extra Account fields for customer health data (optional; graceful fallback if absent in org)."""
    parts = [f for f in _ALL_ACC_HEALTH_FIELDS if f]
    return (", " + ", ".join(parts)) if parts else ""

# Authoritative line-item ARR field (ARR__c) — the maintained ARR per line, already net of partner
# revenue-share for Alleva accounts. Used directly so line-item ARR ties to the opportunity ARR__c
# (and the board ARR basis) instead of our MRR×12 annualization. Configurable for other orgs.
_SALESFORCE_LINE_ITEM_ARR_FIELD = (os.getenv("SALESFORCE_LINE_ITEM_ARR_FIELD") or "ARR__c").strip()
# Optional: line item term (months) and dates for period-weighted ARR (e.g. 3 mo @ $650 + 21 mo @ $1300 -> ARR = (3*650+21*1300)/24*12).
_SALESFORCE_LINE_ITEM_TERM_FIELD = (os.getenv("SALESFORCE_LINE_ITEM_TERM_FIELD") or "").strip()  # e.g. Term__c
# Try these by default so period-weighted ARR works without config; sync falls back if field doesn't exist in org
_LINE_ITEM_TERM_FIELD_TRY = _SALESFORCE_LINE_ITEM_TERM_FIELD or "Term__c"
# Start/End date on OpportunityLineItem — used for subscription date fallback when Opportunity has no Contract Start/End. Default ServiceDate (standard); End Date often custom (e.g. End_Date__c).
_SALESFORCE_LINE_ITEM_SERVICE_START_FIELD = (os.getenv("SALESFORCE_LINE_ITEM_SERVICE_START_FIELD") or "ServiceDate").strip() or ""
_SALESFORCE_LINE_ITEM_SERVICE_END_FIELD = (os.getenv("SALESFORCE_LINE_ITEM_SERVICE_END_FIELD") or "EndDate").strip() or ""


def _opp_soql_extra_fields() -> str:
    parts = []
    if _SALESFORCE_RENEWAL_DATE_FIELD:
        parts.append(_SALESFORCE_RENEWAL_DATE_FIELD)
    if _SALESFORCE_UFR_ARR_FIELD:
        parts.append(_SALESFORCE_UFR_ARR_FIELD)
    if _SALESFORCE_EXPANSION_ARR_FIELD:
        parts.append(_SALESFORCE_EXPANSION_ARR_FIELD)
    if _SALESFORCE_CONTRACT_START_DATE_FIELD:
        parts.append(_SALESFORCE_CONTRACT_START_DATE_FIELD)
    if _SALESFORCE_CONTRACT_END_DATE_FIELD:
        parts.append(_SALESFORCE_CONTRACT_END_DATE_FIELD)
    if _SALESFORCE_MIDTERM_CANCELLATION_FIELD:
        parts.append(_SALESFORCE_MIDTERM_CANCELLATION_FIELD)
    # Include ARR__c when present in org so we can fall back to it for opps without products
    parts.append("ARR__c")
    parts.append("Forecast__c")
    # AI-agent enrichment (standard NextStep always safe; custom fields only when configured)
    parts.append("NextStep")
    if _SF_LEAD_TYPE_FIELD:
        parts.append(_SF_LEAD_TYPE_FIELD)
    if _SF_CURRENT_CRM_FIELD:
        parts.append(_SF_CURRENT_CRM_FIELD)
    if _SF_CURRENT_VOIP_FIELD:
        parts.append(_SF_CURRENT_VOIP_FIELD)
    if _SF_DEAL_TIER_FIELD:
        parts.append(_SF_DEAL_TIER_FIELD)
    return ", " + ", ".join(parts) if parts else ""


def _opp_soql_extra_fields_no_renewal_date() -> str:
    """Same as `_opp_soql_extra_fields()` but intentionally excludes renewal date field.

    Used for the fallback SOQL when SALESFORCE_RENEWAL_DATE_FIELD is invalid in the org.
    """
    parts = []
    if _SALESFORCE_UFR_ARR_FIELD:
        parts.append(_SALESFORCE_UFR_ARR_FIELD)
    if _SALESFORCE_EXPANSION_ARR_FIELD:
        parts.append(_SALESFORCE_EXPANSION_ARR_FIELD)
    if _SALESFORCE_CONTRACT_START_DATE_FIELD:
        parts.append(_SALESFORCE_CONTRACT_START_DATE_FIELD)
    if _SALESFORCE_CONTRACT_END_DATE_FIELD:
        parts.append(_SALESFORCE_CONTRACT_END_DATE_FIELD)
    if _SALESFORCE_MIDTERM_CANCELLATION_FIELD:
        parts.append(_SALESFORCE_MIDTERM_CANCELLATION_FIELD)
    # Include ARR__c when present in org so we can fall back to it for opps without products
    parts.append("ARR__c")
    parts.append("Forecast__c")
    # AI-agent enrichment
    parts.append("NextStep")
    if _SF_LEAD_TYPE_FIELD:
        parts.append(_SF_LEAD_TYPE_FIELD)
    if _SF_CURRENT_CRM_FIELD:
        parts.append(_SF_CURRENT_CRM_FIELD)
    if _SF_CURRENT_VOIP_FIELD:
        parts.append(_SF_CURRENT_VOIP_FIELD)
    if _SF_DEAL_TIER_FIELD:
        parts.append(_SF_DEAL_TIER_FIELD)
    return ", " + ", ".join(parts) if parts else ""
DEFAULT_OPPORTUNITY_SOQL = (
    "SELECT Id, Name, Amount, CloseDate, StageName, Type, RecordType.Name, "
    "Account.Id, Account.Name, Owner.Name, CreatedDate, " + _SALESFORCE_MRR_FIELD
    + _opp_soql_extra_fields()
    + " FROM Opportunity ORDER BY CloseDate DESC NULLS LAST"
)
# Fallback SOQL without renewal date field (used if that field is invalid in org). Still includes UFR (Original ACV) when set.
DEFAULT_OPPORTUNITY_SOQL_NO_RENEWAL = (
    "SELECT Id, Name, Amount, CloseDate, StageName, Type, RecordType.Name, "
    "Account.Id, Account.Name, Owner.Name, CreatedDate, " + _SALESFORCE_MRR_FIELD
    + _opp_soql_extra_fields_no_renewal_date()
    + " FROM Opportunity ORDER BY CloseDate DESC NULLS LAST"
)
# Opportunity products: TotalPrice = MRR; ARR = MRR * 12. Product2.Name (or Name) for product columns.
# When SALESFORCE_LINE_ITEM_TERM_FIELD (or ServiceDate/EndDate) is set, same product with multiple segments uses period-weighted ARR.
def _line_item_soql_extra_fields(include_try_term: bool = True, include_service_dates: bool = True) -> str:
    parts = []
    if include_try_term and _LINE_ITEM_TERM_FIELD_TRY:
        parts.append(_LINE_ITEM_TERM_FIELD_TRY)
    if _SALESFORCE_LINE_ITEM_TERM_FIELD and _SALESFORCE_LINE_ITEM_TERM_FIELD != _LINE_ITEM_TERM_FIELD_TRY:
        if _SALESFORCE_LINE_ITEM_TERM_FIELD not in parts:
            parts.append(_SALESFORCE_LINE_ITEM_TERM_FIELD)
    if include_service_dates and _SALESFORCE_LINE_ITEM_SERVICE_START_FIELD:
        parts.append(_SALESFORCE_LINE_ITEM_SERVICE_START_FIELD)
    if include_service_dates and _SALESFORCE_LINE_ITEM_SERVICE_END_FIELD:
        parts.append(_SALESFORCE_LINE_ITEM_SERVICE_END_FIELD)
    return ", " + ", ".join(parts) if parts else ""

def _line_item_soql(include_optional_term: bool = True, include_service_dates: bool = True) -> str:
    arr_field = f", {_SALESFORCE_LINE_ITEM_ARR_FIELD}" if _SALESFORCE_LINE_ITEM_ARR_FIELD else ""
    return (
        "SELECT Id, OpportunityId, Name, Product2.Name, Quantity, UnitPrice, TotalPrice"
        + arr_field
        + _line_item_soql_extra_fields(include_try_term=include_optional_term, include_service_dates=include_service_dates)
        + " FROM OpportunityLineItem"
    )

DEFAULT_OPPORTUNITY_LINE_ITEM_SOQL = _line_item_soql(include_optional_term=True, include_service_dates=True)
ARR_MULTIPLIER = 12  # MRR -> ARR
# If set (1/true/yes), TotalPrice is treated as already annual: ARR = sum(TotalPrice). Otherwise ARR = sum(TotalPrice) * 12.
_ARR_TOTAL_PRICE_IS_ANNUAL = os.getenv("ARR_TOTAL_PRICE_IS_ANNUAL", "").strip().lower() in ("1", "true", "yes")
# If set (1/true/yes), use UnitPrice × Quantity as MRR instead of TotalPrice. Use when CRM "Sales Price" matches UnitPrice but TotalPrice in SF is different (e.g. discounted or annual).
_USE_UNIT_PRICE_TIMES_QUANTITY_AS_MRR = os.getenv("USE_UNIT_PRICE_TIMES_QUANTITY_AS_MRR", "").strip().lower() in ("1", "true", "yes")


def _use_unit_price_times_quantity_as_mrr() -> bool:
    """Read at runtime so .env changes take effect after restart (and we can debug current value)."""
    return os.getenv("USE_UNIT_PRICE_TIMES_QUANTITY_AS_MRR", "").strip().lower() in ("1", "true", "yes")


PIPELINE_ARR_MULTIPLIER = 1 if _ARR_TOTAL_PRICE_IS_ANNUAL else ARR_MULTIPLIER

# Products excluded from ARR (not counted in totals or shown as columns). Case-insensitive match.
# Recurring but excluded: iVerify Monthly Credits, Kipu API.
# One-time (ProServ): Implementation, Data Migration, Kipu API Set Up, Customer Integration Development — out of scope for ARR.
ARR_PRODUCT_EXCLUDE = frozenset({
    "iverify monthly credits",
    "verify monthly credits",
    "kipu api",
    # One-time / non-recurring (ProServ)
    "crm implementation services",
    "iq implementation services",
    "icampaign implementation services",
    "data migration services",
    "kipu api set up",
    "customer integration development",
    "agent implementation fee",
})

# Canonical ARR product columns: order = display order (Account, Segment, then these, then Other).
# One-time products (Implementation, Data Migration, Kipu API Set Up, etc.) are not in ARR.
# Display names: "CRM Platform" = Legacy + Includes 5 Seats; "CRM Billing Platform" = Billing Company CRM...
ARR_PRODUCT_COLUMNS = [
    "CRM Platform",
    "CRM Billing Platform",
    "Add. CRM Seats",
    "MR Platform",
    "IQ Platform",
    "Add. MR/ IQ Locations",
    "iCampaign Platform",
]
# Products purchased page only: no Add. CRM Seats / Add. MR/ IQ Locations.
PRODUCTS_PURCHASED_SKIP_CANONICAL = frozenset({"Add. CRM Seats", "Add. MR/ IQ Locations"})
PRODUCTS_PURCHASED_COLUMNS = [
    "CRM Platform",
    "CRM Billing Platform",
    "MR Platform",
    "IQ Platform",
    "iCampaign Platform",
]
_ARR_PRODUCT_NORMALIZED = {p.strip().lower(): p for p in ARR_PRODUCT_COLUMNS}
# Map raw Salesforce product names to canonical display names (view-only; calculation unchanged)
_ARR_SF_TO_CANONICAL = {
    "dazos crm platform (legacy)": "CRM Platform",
    "dazos crm platform (includes 5 seats)": "CRM Platform",
    "billing company crm platform (includes 5 seats)": "CRM Billing Platform",
    "additional crm seats": "Add. CRM Seats",
    "marketing reports platform fee (includes 1 ein)": "MR Platform",
    "iq platform fee (includes 1 ein)": "IQ Platform",
    "additional iq/mr eins": "Add. MR/ IQ Locations",
    "additional iqmr eins": "Add. MR/ IQ Locations",
    "icampaign (email only) tier 1": "iCampaign Platform",
    "icampaign (email & sms) tier 1": "iCampaign Platform",
}


def _normalized_product_name(product_name: str | None) -> str:
    """For ARR: use product part after last ' - ' if present (e.g. 'Account - Renewal - Date Kipu API' -> 'Kipu API')."""
    if not product_name or not (s := product_name.strip()):
        return ""
    if " - " in s:
        s = s.rsplit(" - ", 1)[-1].strip() or s
    return s


def _is_arr_excluded_product(product_name: str | None) -> bool:
    """True if this product should be excluded from ARR (e.g. iVerify Monthly Credits, Kipu API)."""
    if not product_name or not product_name.strip():
        return False
    # Normalize: collapse whitespace, lower; match exact or if any exclude phrase is contained
    key = " ".join((product_name or "").split()).strip().lower()
    if not key:
        return False
    if key in ARR_PRODUCT_EXCLUDE:
        return True
    return any(exc in key for exc in ARR_PRODUCT_EXCLUDE)


def _include_line_item_in_arr(normalized_name: str | None, raw_product_name: str | None) -> bool:
    """True if this line item should count toward ARR. Known ARR products (IQ Platform, Add. MR/IQ, etc.) are always included even if the name contains an exclude phrase (e.g. 'iq implementation')."""
    if _match_arr_product(normalized_name) is not None or _match_arr_product(raw_product_name) is not None:
        return True
    if _is_arr_excluded_product(normalized_name) or _is_arr_excluded_product(raw_product_name):
        return False
    return True


def _arr_product_key(name: str | None) -> str:
    """Normalize product name for matching: collapse whitespace, normalize slashes, lower."""
    if not name or not name.strip():
        return ""
    s = " ".join(name.split()).strip().lower()
    s = s.replace(" / ", "/").replace(" /", "/").replace("/ ", "/")
    return s


def _is_additional_crm_seats(product_name: str | None) -> bool:
    """True if this line item is an 'Additional CRM Seats' SKU where quantity ≈ seats."""
    if not product_name or not product_name.strip():
        return False
    key = _arr_product_key(product_name)
    return "additional crm seats" in key


def _is_crm_platform_includes_5_seats(product_name: str | None) -> bool:
    """True if this is 'Dazos CRM Platform (Includes 5 Seats)' — count 5 seats per opp."""
    if not product_name or not product_name.strip():
        return False
    key = _arr_product_key(product_name)
    return "crm platform" in key and "includes 5 seats" in key


def _is_crm_platform_legacy(product_name: str | None) -> bool:
    """True if this is 'Dazos CRM Platform (Legacy)' — CRM ARR without explicit seats."""
    if not product_name or not product_name.strip():
        return False
    key = _arr_product_key(product_name)
    return "crm platform" in key and "legacy" in key


# ── Product-family SKU predicates for per-product ARR bridges ──────────────────
# Each predicate takes the raw Salesforce product name. Lines are pre-filtered by
# _include_line_item_in_arr (so excluded SKUs like implementation services never reach here).

def _is_premium_support(product_name: str | None) -> bool:
    """True if this is a 'Premium Support' SKU (recurring ARR; grouped under the CRM family)."""
    if not product_name or not product_name.strip():
        return False
    return "premium support" in _arr_product_key(product_name)


def _is_crm_product(product_name: str | None) -> bool:
    """CRM family: CRM Platform Legacy + Includes-5-Seats + Additional CRM Seats, plus Premium Support."""
    return (
        _is_additional_crm_seats(product_name)
        or _is_crm_platform_includes_5_seats(product_name)
        or _is_crm_platform_legacy(product_name)
        or _is_premium_support(product_name)
    )


def _is_icampaign_product(product_name: str | None) -> bool:
    """iCampaign family: any iCampaign SKU (Platform, Email Only/SMS tiers, legacy tiers, Enterprise)."""
    return "icampaign" in _arr_product_key(product_name)


def _is_additional_iqmr_eins(product_name: str | None) -> bool:
    """Shared 'Additional IQ/MR EINs' add-on (allocated to IQ per CFO decision)."""
    key = _arr_product_key(product_name)
    return "additional" in key and "ein" in key and ("iq" in key or "mr" in key)


def _is_iq_product(product_name: str | None) -> bool:
    """IQ family: IQ Platform Fee + the shared Additional IQ/MR EINs add-on (allocated to IQ)."""
    key = _arr_product_key(product_name)
    return "iq platform" in key or _is_additional_iqmr_eins(product_name)


def _is_marketing_reports_product(product_name: str | None) -> bool:
    """Marketing Reports family: MR Platform Fee only (EIN add-on allocated to IQ)."""
    return "marketing reports platform" in _arr_product_key(product_name)


def _is_iq_mr_product(product_name: str | None) -> bool:
    """Combined IQ & Marketing Reports family: IQ Platform + MR Platform + shared Additional IQ/MR EINs."""
    return _is_iq_product(product_name) or _is_marketing_reports_product(product_name)


def _is_other_product(product_name: str | None) -> bool:
    """'Other' family: any ARR-included SKU not in CRM / iCampaign / IQ&MR / RVK
    (e.g. Billing Company CRM Platform). Lines are pre-filtered by _include_line_item_in_arr."""
    return not (
        _is_crm_product(product_name)
        or _is_icampaign_product(product_name)
        or _is_iq_mr_product(product_name)
        or _is_rvk_agent_product(product_name)
    )


_RVK_AGENT_KEYS = frozenset({
    "dazos iconnect", "dazos iscreen", "dazos iassist", "dazos irecover", "dazos idirect",
})


def _is_rvk_agent_product(product_name: str | None) -> bool:
    """RVK agents: the recurring Dazos i* agent SKUs (excludes one-time Agent Implementation Fee)."""
    return _arr_product_key(product_name) in _RVK_AGENT_KEYS


# Group key → SKU predicate. Used to compute per-account month-end ARR per product family.
_PRODUCT_GROUP_PREDICATES: dict[str, Callable[[str | None], bool]] = {
    "crm": _is_crm_product,
    "icampaign": _is_icampaign_product,
    "iq": _is_iq_product,
    "marketing_reports": _is_marketing_reports_product,
    "iq_mr": _is_iq_mr_product,
    "rvk": _is_rvk_agent_product,
    "other": _is_other_product,
}


def _product_group_arr_by_opp(lines: list, predicate) -> dict[str, float]:
    """ARR per opportunity for the subset of line items matching ``predicate``, used as a product-mix
    weight (ARR__c-preferred, MRR×12 fallback when ARR__c is blank — see _arr_mix_contribution_for_line_group)."""
    groups: dict[tuple[str, str], list] = {}
    for li in lines:
        raw = _normalized_product_name(li.product_name)
        if not _include_line_item_in_arr(raw, li.product_name):
            continue
        if not predicate(li.product_name):
            continue
        pk = _arr_product_key(raw) or _arr_product_key(li.product_name) or "other"
        groups.setdefault(((li.opportunity_sf_id or "").strip(), pk), []).append(li)
    out: dict[str, float] = {}
    for (opp_id, _pk), items in groups.items():
        if not opp_id:
            continue
        out[opp_id] = out.get(opp_id, 0.0) + _arr_mix_contribution_for_line_group(items)
    return out


def _crm_seats_for_opportunity_lines(opp_sf_id: str, lines: list) -> int:
    """Additional CRM Seats quantities + 5 if any 'CRM Platform (Includes 5 Seats)' line (same rules as schedule)."""
    oid = (opp_sf_id or "").strip()
    seats = 0
    has_platform_5 = False
    for li in lines:
        if (li.opportunity_sf_id or "").strip() != oid:
            continue
        if _is_additional_crm_seats(li.product_name):
            try:
                qty = int(float(li.quantity or 0))
            except (TypeError, ValueError):
                qty = 0
            if qty:
                seats += qty
        elif _is_crm_platform_includes_5_seats(li.product_name):
            has_platform_5 = True
    if has_platform_5:
        seats += 5
    return seats


def _match_arr_product(sf_product_name: str | None) -> str | None:
    """Map Salesforce product name to canonical ARR column, or None -> 'Other'. Uses SF-to-canonical map, then exact then contains match."""
    if not sf_product_name or not sf_product_name.strip():
        return None
    key = _arr_product_key(sf_product_name)
    if not key:
        return None
    # Check display-name overrides first (e.g. "Dazos CRM Platform (Legacy)" -> "CRM Platform")
    if key in _ARR_SF_TO_CANONICAL:
        return _ARR_SF_TO_CANONICAL[key]
    for sf_key, canonical in _ARR_SF_TO_CANONICAL.items():
        if sf_key in key or key in sf_key:
            return canonical
    if key in _ARR_PRODUCT_NORMALIZED:
        return _ARR_PRODUCT_NORMALIZED[key]
    for norm, canonical in _ARR_PRODUCT_NORMALIZED.items():
        if norm in key or key in norm:
            return canonical
    return None


# Stages that count as "closed" (excluded from pipeline and from renewal ARR).
CLOSED_STAGES = frozenset({"Closed Won", "Closed Lost"})
# Active ARR is built only from Closed Won (never from open or Closed Lost).
CLOSED_WON_STAGE = "Closed Won"


def _is_closed_won_stage(stage_name: str | None) -> bool:
    """True if stage is Closed Won (case-insensitive, any whitespace/dash/underscore normalized)."""
    if not stage_name:
        return False
    s = re.sub(r"[\s\u00A0\-_]+", " ", (stage_name or "").strip()).strip().lower()
    if s == "closed won":
        return True
    # Fallback: "Closed Won" with odd characters or spelling
    if "closed" in s and "won" in s and "lost" not in s:
        return True
    return False


def _is_closed_lost_stage(stage_name: str | None) -> bool:
    """True if stage is Closed Lost (case-insensitive, whitespace normalized). Prefer over exact ``==`` for SF variants."""
    if not stage_name:
        return False
    s = re.sub(r"[\s\u00A0\-_]+", " ", (stage_name or "").strip()).strip().lower()
    if s == "closed lost":
        return True
    if "closed" in s and "lost" in s and "won" not in s:
        return True
    return False


def _canonical_stage_name(raw: Optional[str]) -> str:
    """Normalize stage name so chart grouping is consistent (e.g. Feb vs Mar). Returns canonical display name."""
    if not raw or not isinstance(raw, str):
        return "—"
    s = raw.strip()
    if not s:
        return "—"
    # Collapse all whitespace and normalize "and" / "&"
    s = re.sub(r"[\s\u00A0\u2000-\u200A\u202F\u205F\u3000]+", " ", s)
    s = re.sub(r"\s+and\s+", " & ", s, flags=re.IGNORECASE)
    s = re.sub(r"\s*&\s*", " & ", s)
    s = s.strip()
    # Key = letters only (lowercase) for matching variants
    key = re.sub(r"[^a-z]", "", s.lower())
    KEY_TO_CANONICAL = {
        "pricingnegotiation": "Pricing & Negotiation",
        "contractclose": "Contract & Close",
        "demosolutioning": "Demo & Solutioning",
        "discoveryapplicationoverview": "Discovery & Application Overview",
        "qualification": "Qualification",
        "qualif": "Qualification",
        "proposal": "Proposal",
        "internal": "Internal",
    }
    if key in KEY_TO_CANONICAL:
        return KEY_TO_CANONICAL[key]
    # Fallback: title-case normalized string
    return s or "—"


def _line_item_effective_total(li) -> float:
    """Use total_price for ARR; when 0 or null, use unit_price * quantity (e.g. closed-opp line items from SF).
    If USE_UNIT_PRICE_TIMES_QUANTITY_AS_MRR=1, always use unit_price * quantity as MRR (matches CRM 'Sales Price × Quantity')."""
    if _use_unit_price_times_quantity_as_mrr():
        try:
            uq = float(li.unit_price or 0) * float(li.quantity or 0)
            if uq != 0:
                return uq
        except (TypeError, ValueError, AttributeError):
            pass
    total = float(li.total_price or 0)
    if total != 0:
        return total
    try:
        return float(li.unit_price or 0) * float(li.quantity or 0)
    except (TypeError, ValueError, AttributeError):
        return 0.0


def _arr_contribution_for_line_group(items: list) -> float:
    """
    ARR for a group of line items (same opp + same product).

    Primary source: the Salesforce line-item ``ARR__c`` field (``li.arr``) — the maintained ARR per
    line, already net of partner revenue-share. When every item in the group has it, ARR = sum(arr),
    so line-item ARR ties to the opportunity ARR__c / board basis.

    Fallback (only when ARR__c is missing on any item): the legacy period-weighted MRR×12 math —
    ARR = (sum(term_i * monthly_price_i) / sum(term_i)) * 12.
    """
    arr_vals = [getattr(li, "arr", None) for li in items]
    if items and all(a is not None for a in arr_vals):
        return round(sum(float(a) for a in arr_vals), 2)
    return _legacy_period_weighted_arr(items)


def _legacy_period_weighted_arr(items: list) -> float:
    """Legacy period-weighted MRR×12 ARR: (Σ term_i × monthly_i) / (Σ term_i) × 12.

    Used as a fallback when the Salesforce ARR__c field isn't populated. ``total_price`` is monthly.
    """
    total_revenue = 0.0
    total_months = 0.0
    for li in items:
        m = _line_item_effective_total(li)
        term = getattr(li, "term_months", None)
        if (term is None or term <= 0) and hasattr(li, "service_start_date") and hasattr(li, "service_end_date"):
            start = getattr(li, "service_start_date", None)
            end = getattr(li, "service_end_date", None)
            if start and end and end >= start:
                try:
                    term = (end - start).days / 30.44
                except (TypeError, ValueError):
                    term = None
        if term is not None and term > 0:
            total_revenue += term * m
            total_months += term
        else:
            # No term: treat this line as 12 months so group average is (sum of monthly) / n × 12
            total_revenue += 12 * m
            total_months += 12
    if total_months <= 0:
        return sum(_line_item_effective_total(li) for li in items) * ARR_MULTIPLIER
    return (total_revenue / total_months) * 12


def _arr_mix_contribution_for_line_group(items: list) -> float:
    """ARR for a line group used **only as a product-mix weight** in the reconciled product bridges.

    Prefers the ARR__c field, but falls back to period-weighted MRR×12 whenever ARR__c sums to 0
    (e.g. the contract active at a given month-end has a blank ARR__c, while the populated value lives
    on a future renewal opp). The mix only needs relative weights, and ``total_price`` (MRR) is always
    present, so this keeps a product signal for those accounts instead of dumping them into 'Other'.
    """
    arr_sum = sum(float(getattr(li, "arr", 0.0) or 0.0) for li in items)
    if arr_sum > 0:
        return round(arr_sum, 2)
    return _legacy_period_weighted_arr(items)


def _arr_contribution_and_math_for_line_group(items: list) -> tuple[float, list[dict], str, float]:
    """
    Same logic as _arr_contribution_for_line_group but returns (arr, segments_math, formula_text, total_term_months).
    segments_math: list of { monthly, term_months, term_times_monthly }.
    """
    arr_vals = [getattr(li, "arr", None) for li in items]
    if items and all(a is not None for a in arr_vals):
        arr = round(sum(float(a) for a in arr_vals), 2)
        seg = [{"monthly": round(_line_item_effective_total(li), 2),
                "term_months": getattr(li, "term_months", None),
                "line_arr": round(float(getattr(li, "arr", 0.0) or 0.0), 2)} for li in items]
        return arr, seg, "Σ line-item ARR__c (Salesforce field, net of partner share)", 0.0
    segments_math = []
    total_revenue = 0.0
    total_months = 0.0
    has_term = False
    for li in items:
        m = _line_item_effective_total(li)
        term = getattr(li, "term_months", None)
        if (term is None or term <= 0) and hasattr(li, "service_start_date") and hasattr(li, "service_end_date"):
            start = getattr(li, "service_start_date", None)
            end = getattr(li, "service_end_date", None)
            if start and end and end >= start:
                try:
                    term = (end - start).days / 30.44
                except (TypeError, ValueError):
                    term = None
        if term is not None and term > 0:
            has_term = True
            total_revenue += term * m
            total_months += term
            segments_math.append({
                "monthly": round(m, 2),
                "term_months": round(term, 2),
                "term_times_monthly": round(term * m, 2),
            })
        else:
            total_revenue += 12 * m
            total_months += 12
            segments_math.append({
                "monthly": round(m, 2),
                "term_months": 12,
                "term_times_monthly": round(12 * m, 2),
            })
    if total_months <= 0:
        arr = sum(_line_item_effective_total(li) for li in items) * ARR_MULTIPLIER
        return arr, segments_math, "sum(monthly) × 12 (no term)", 0.0
    arr = (total_revenue / total_months) * 12
    formula = f"(Σ term_i × monthly_i) / (Σ term_i) × 12 = {total_revenue:.2f} / {total_months:.2f} × 12 = {arr:.2f}"
    return arr, segments_math, formula, total_months


def _line_items_to_arr_by_group(lines: list) -> list[tuple[str, str, float]]:
    """
    Group line items by (opportunity_sf_id, product_key), compute ARR per group (period-weighted when term_months present).
    Returns list of (opp_sf_id, canonical_product, arr_contribution). Caller filters by _include_line_item_in_arr before passing.
    """
    groups: dict[tuple[str, str], list] = {}
    for li in lines:
        raw = _normalized_product_name(li.product_name)
        if not _include_line_item_in_arr(raw, li.product_name):
            continue
        pk = _arr_product_key(raw) or _arr_product_key(li.product_name) or "other"
        key = (li.opportunity_sf_id, pk)
        groups.setdefault(key, []).append(li)
    out = []
    for (opp_sf_id, _pk), items in groups.items():
        arr = _arr_contribution_for_line_group(items)
        canonical = _match_arr_product(items[0].product_name) or _match_arr_product(_normalized_product_name(items[0].product_name)) or "Other"
        out.append((opp_sf_id, canonical, arr))
    return out


def _products_purchased_line_bucket(li) -> str | None:
    """Canonical column for Products purchased grid only; None = omit line."""
    raw = _normalized_product_name(li.product_name)
    full = li.product_name or ""
    if not _include_line_item_in_arr(raw, full):
        return None
    canonical = _match_arr_product(full) or _match_arr_product(raw)
    if canonical is None:
        canonical = "Other"
    if canonical in PRODUCTS_PURCHASED_SKIP_CANONICAL:
        return None
    return canonical


def _line_items_to_products_purchased_by_group(lines: list) -> list[tuple[str, str, float]]:
    """Like _line_items_to_arr_by_group but Products purchased columns (skips two add-on columns)."""
    groups: dict[tuple[str, str], list] = {}
    for li in lines:
        bucket = _products_purchased_line_bucket(li)
        if bucket is None:
            continue
        raw = _normalized_product_name(li.product_name)
        pk = _arr_product_key(raw) or _arr_product_key(li.product_name) or bucket.lower().replace(".", "").replace(" ", "_")
        key = (li.opportunity_sf_id, pk)
        groups.setdefault(key, []).append(li)
    out: list[tuple[str, str, float]] = []
    for (opp_sf_id, _pk), items in groups.items():
        b = _products_purchased_line_bucket(items[0])
        if b is None:
            continue
        arr = _arr_contribution_for_line_group(items)
        out.append((opp_sf_id, b, arr))
    return out


def _line_item_effective_total_dict(li: dict) -> float:
    """Same for line item dict (e.g. from EOD snapshot JSON). Respects USE_UNIT_PRICE_TIMES_QUANTITY_AS_MRR."""
    if _use_unit_price_times_quantity_as_mrr():
        try:
            uq = float(li.get("unit_price") or 0) * float(li.get("quantity") or 0)
            if uq != 0:
                return uq
        except (TypeError, ValueError):
            pass
    total = float(li.get("total_price") or 0)
    if total != 0:
        return total
    try:
        return float(li.get("unit_price") or 0) * float(li.get("quantity") or 0)
    except (TypeError, ValueError):
        return 0.0


async def _compute_arr_from_line_items(db: AsyncSession, opportunity_sf_ids: set[str]) -> dict[str, float]:
    """
    Single source of truth: ARR per opportunity from product line items.
    Uses period-weighted ARR when same product has multiple segments with term_months (e.g. 3 mo @ $650 + 21 mo @ $1300 -> $14,625).
    Returns dict opportunity_sf_id -> ARR (rounded).
    """
    if not opportunity_sf_ids:
        return {}
    q = select(OpportunityLineItem).where(
        OpportunityLineItem.opportunity_sf_id.in_(opportunity_sf_ids)
    )
    r = await db.execute(q)
    lines = r.scalars().all()
    contributions = _line_items_to_arr_by_group(lines)
    out: dict[str, float] = {}
    for opp_sf_id, _canonical, arr in contributions:
        out[opp_sf_id] = out.get(opp_sf_id, 0) + arr
    return {k: round(v, 2) for k, v in out.items()}
# Default SOQL for accounts. Add custom fields to the SELECT if needed.
# Default segment when Salesforce Segment__c is empty.
DEFAULT_SEGMENT = "SMB/ MM"

# Account Status = Account_Status__c; Segment = Segment__c (add Sub_Segment__c or other segment field here if your org has it).
DEFAULT_ACCOUNT_SOQL = (
    "SELECT Id, Name, Type, Account_Status__c, Industry, AnnualRevenue, NumberOfEmployees, "
    "BillingCountry, BillingCity, BillingState, Phone, Website, Segment__c, Customer_Success_Manager__c, Customer_Success_Manager__r.Name, Account_Executive__c, "
    "Partner_Affiliate_Revenue_Share__c, Owner.Name, CreatedDate"
    + _account_soql_health_fields()
    + " FROM Account ORDER BY Name"
)
# Fallback without health fields (used when any health field is invalid in the org)
DEFAULT_ACCOUNT_SOQL_NO_HEALTH = (
    "SELECT Id, Name, Type, Account_Status__c, Industry, AnnualRevenue, NumberOfEmployees, "
    "BillingCountry, BillingCity, BillingState, Phone, Website, Segment__c, Customer_Success_Manager__c, Customer_Success_Manager__r.Name, Account_Executive__c, "
    "Partner_Affiliate_Revenue_Share__c, Owner.Name, CreatedDate "
    "FROM Account ORDER BY Name"
)

# Account status values that mean churned; these accounts show Active ARR = 0 (case-insensitive).
CHURNED_ACCOUNT_STATUSES = frozenset({"churned", "churn", "lost", "inactive"})


# Month name -> number for Copilot "renewal in March '26" parsing
_MONTH_NAMES = {
    "january": 1, "jan": 1, "february": 2, "feb": 2, "march": 3, "mar": 3,
    "april": 4, "apr": 4, "may": 5, "june": 6, "jun": 6, "july": 7, "jul": 7,
    "august": 8, "aug": 8, "september": 9, "sep": 9, "sept": 9, "october": 10, "oct": 10,
    "november": 11, "nov": 11, "december": 12, "dec": 12,
}


def _parse_renewal_month_from_question(q: str) -> tuple[int, int] | None:
    """If question mentions a month/year (e.g. 'March 2026', 'March \\'26', 'Mar 26'), return (year, month)."""
    q_lower = q.lower()
    for name, month in _MONTH_NAMES.items():
        if name not in q_lower:
            continue
        # Look for 4-digit year (2026) or 2-digit (26 or '26)
        for m in re.finditer(re.escape(name), q_lower, re.IGNORECASE):
            start, end = m.start(), m.end()
            rest = q_lower[end:end + 15].strip()
            # 2026, 2025, ...
            four = re.match(r"[\s'\-]*(\d{4})\b", rest)
            if four:
                y = int(four.group(1))
                if 2020 <= y <= 2040:
                    return (y, month)
            # '26, 26
            two = re.match(r"[\s'\-]*'?(\d{2})\b", rest)
            if two:
                yy = int(two.group(1))
                y = 2000 + yy if yy < 50 else 1900 + yy
                if 2020 <= y <= 2040:
                    return (y, month)
    return None


def _parse_date_from_question(q: str, today: date | None = None) -> date | None:
    """If question asks about a specific date (e.g. 'as of March 2025', 'last month'), return that date for snapshot lookup."""
    if today is None:
        today = datetime.now(EST).date()
    q_lower = q.lower()
    # "last month" -> last day of previous month
    if "last month" in q_lower:
        first_this = today.replace(day=1)
        from calendar import monthrange
        last_prev = first_this - timedelta(days=1)
        return last_prev
    # ISO-style YYYY-MM-DD
    iso = re.search(r"\b(202[0-9])-(\d{1,2})-(\d{1,2})\b", q)
    if iso:
        try:
            return date(int(iso.group(1)), int(iso.group(2)), int(iso.group(3)))
        except ValueError:
            pass
    # "as of March 2025" / "in March 2025" / "on March 2025"
    ym = _parse_renewal_month_from_question(q)
    if ym and ("as of" in q_lower or "on " in q_lower or " in " in q_lower or re.search(r"\b(as of|on|in)\s+", q_lower)):
        year, month = ym
        from calendar import monthrange
        _, last_day = monthrange(year, month)
        return date(year, month, last_day)
    return None


def _parse_date(s: Optional[str]) -> Optional[date]:
    if not s:
        return None
    try:
        return date.fromisoformat(s[:10])
    except (ValueError, TypeError):
        return None


def _parse_datetime(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def _float_or_none(x) -> Optional[float]:
    if x is None:
        return None
    if isinstance(x, dict):
        x = x.get("value", x.get("amount"))
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _opportunity_arr_c_from_record(rec: dict) -> Optional[float]:
    """Salesforce Opportunity.ARR__c (renewed ARR for closed-won renewals)."""
    if rec.get("ARR__c") is not None:
        return _float_or_none(rec.get("ARR__c"))
    for key, value in rec.items():
        if key and key.lower() == "arr__c" and value is not None:
            return _float_or_none(value)
    return None


def _original_acv_from_record(rec: dict) -> Optional[float]:
    """Get contracted ARR (UFR baseline) for an opportunity from Salesforce.
    Priority:
    1) configured `_SALESFORCE_UFR_ARR_FIELD` (default: Original_ARR__c)
    2) ARR__c (legacy fallback)
    """
    if _SALESFORCE_UFR_ARR_FIELD:
        direct = rec.get(_SALESFORCE_UFR_ARR_FIELD)
        if direct is not None:
            return _float_or_none(direct)
        # Fallback for flattened keys / case differences from connector output
        ufr_key_l = _SALESFORCE_UFR_ARR_FIELD.lower()
        for key, value in rec.items():
            if key and key.lower() == ufr_key_l and value is not None:
                return _float_or_none(value)
    # Explicit fallback aliases used across org history/migrations.
    for alias in ("Original_ARR__c", "Original_ACV__c"):
        if rec.get(alias) is not None:
            return _float_or_none(rec.get(alias))
        alias_l = alias.lower()
        for key, value in rec.items():
            if key and key.lower() == alias_l and value is not None:
                return _float_or_none(value)
    if rec.get("ARR__c") is not None:
        return _float_or_none(rec.get("ARR__c"))
    for key, value in rec.items():
        if key and key.lower() == "arr__c" and value is not None:
            return _float_or_none(value)
    return None


async def _salesforce_query_with_retry(connector, soql: str, max_attempts: int = 3):
    """Run a Salesforce SOQL query with retries on connection errors (e.g. Remote end closed connection)."""
    last_error = None
    for attempt in range(max_attempts):
        try:
            return await asyncio.to_thread(connector.query, soql)
        except Exception as e:
            last_error = e
            if attempt < max_attempts - 1:
                await asyncio.sleep(2 + attempt)  # 2s, then 3s before next try
    raise last_error


async def _run_salesforce_sync(db: AsyncSession) -> dict:
    """Run full Salesforce sync (accounts, opportunities, opportunity line items). Caller must commit. Uses EST for any timestamps."""
    from connectors.salesforce import SalesforceConnector

    connector = SalesforceConnector()
    if not connector.is_configured():
        return {
            "ok": False,
            "error": "Salesforce not configured. Set SALESFORCE_USERNAME, SALESFORCE_PASSWORD, and SALESFORCE_SECURITY_TOKEN in backend/.env.",
        }

    use_health_fields = bool(_account_soql_health_fields())
    try:
        account_records = await _salesforce_query_with_retry(connector, DEFAULT_ACCOUNT_SOQL)
    except Exception as e:
        err_str = str(e)
        if use_health_fields and ("INVALID_FIELD" in err_str or "No such column" in err_str.lower() or "invalid field" in err_str.lower()):
            try:
                account_records = await _salesforce_query_with_retry(connector, DEFAULT_ACCOUNT_SOQL_NO_HEALTH)
                use_health_fields = False
            except Exception as e2:
                return {"ok": False, "error": f"Accounts sync failed: {e2}"}
        else:
            return {"ok": False, "error": f"Accounts sync failed: {e}"}

    # Resolve CSM user names for records where only Customer_Success_Manager__c (Id) is present.
    csm_user_name_by_id: dict[str, str] = {}
    csm_user_ids = {
        (rec.get("Customer_Success_Manager__c") or "").strip()
        for rec in account_records
        if (rec.get("Customer_Success_Manager__c") or "").strip()
    }
    if csm_user_ids:
        user_ids = sorted(csm_user_ids)
        chunk_size = 200
        for i in range(0, len(user_ids), chunk_size):
            chunk = user_ids[i:i + chunk_size]
            ids_list = ",".join(f"'{uid}'" for uid in chunk)
            soql_users = f"SELECT Id, Name FROM User WHERE Id IN ({ids_list})"
            try:
                user_records = await _salesforce_query_with_retry(connector, soql_users)
                for u in user_records:
                    uid = (u.get("Id") or "").strip()
                    uname = (u.get("Name") or "").strip()
                    if uid and uname:
                        csm_user_name_by_id[uid] = uname
            except Exception:
                # Non-fatal: fallback remains Id when name can't be resolved.
                pass

    await db.execute(delete(Account))
    for rec in account_records:
        sf_id = rec.get("Id")
        if not sf_id:
            continue
        try:
            employees = int(rec["NumberOfEmployees"]) if rec.get("NumberOfEmployees") is not None else None
        except (TypeError, ValueError):
            employees = None
        owner_obj = rec.get("Owner")
        owner_name = None
        if isinstance(owner_obj, dict):
            owner_name = (owner_obj.get("Name") or owner_obj.get("name") or None)
        # Fallbacks in case SalesforceConnector flattens fields
        owner_name = owner_name or rec.get("Owner.Name") or rec.get("Owner_Name")
        csm_id = (rec.get("Customer_Success_Manager__c") or "").strip() or None
        csm_name = (
            rec.get("Customer_Success_Manager__r_Name")
            or rec.get("Customer_Success_Manager__r.Name")
            or (csm_user_name_by_id.get(csm_id) if csm_id else None)
            or csm_id
        )

        def _rec_float(field: str):
            v = rec.get(field)
            return float(v) if v is not None else None

        def _rec_int(field: str):
            v = rec.get(field)
            try:
                return int(v) if v is not None else None
            except (TypeError, ValueError):
                return None

        acc = Account(
            sf_id=sf_id,
            name=rec.get("Name"),
            type=rec.get("Type"),
            status=rec.get("Account_Status__c"),
            industry=rec.get("Industry"),
            annual_revenue=float(rec["AnnualRevenue"]) if rec.get("AnnualRevenue") is not None else None,
            number_of_employees=employees,
            billing_country=rec.get("BillingCountry"),
            billing_city=rec.get("BillingCity"),
            billing_state=rec.get("BillingState"),
            phone=rec.get("Phone"),
            website=rec.get("Website"),
            segment=rec.get("Segment__c"),
            customer_success_manager=csm_name,
            ae_owner=rec.get("Account_Executive__c"),
            partner_affiliate_revenue_share=(
                float(rec.get("Partner_Affiliate_Revenue_Share__c"))
                if rec.get("Partner_Affiliate_Revenue_Share__c") is not None
                else None
            ),
            owner_name=owner_name,
            created_date=_parse_datetime(rec.get("CreatedDate")),
            # Customer health fields (only populated when use_health_fields=True)
            health_score=_rec_float(_SF_ACC_HEALTH_SCORE_FIELD) if use_health_fields and _SF_ACC_HEALTH_SCORE_FIELD else None,
            risk_score=_rec_float(_SF_ACC_RISK_SCORE_FIELD) if use_health_fields and _SF_ACC_RISK_SCORE_FIELD else None,
            product_usage_score=_rec_float(_SF_ACC_PRODUCT_USAGE_FIELD) if use_health_fields and _SF_ACC_PRODUCT_USAGE_FIELD else None,
            financial_score=_rec_float(_SF_ACC_FINANCIAL_SCORE_FIELD) if use_health_fields and _SF_ACC_FINANCIAL_SCORE_FIELD else None,
            customer_engagement_score=_rec_float(_SF_ACC_ENGAGEMENT_SCORE_FIELD) if use_health_fields and _SF_ACC_ENGAGEMENT_SCORE_FIELD else None,
            support_score=_rec_float(_SF_ACC_SUPPORT_SCORE_FIELD) if use_health_fields and _SF_ACC_SUPPORT_SCORE_FIELD else None,
            customer_journey_phase=rec.get(_SF_ACC_JOURNEY_PHASE_FIELD) if use_health_fields and _SF_ACC_JOURNEY_PHASE_FIELD else None,
            payment_status=rec.get(_SF_ACC_PAYMENT_STATUS_FIELD) if use_health_fields and _SF_ACC_PAYMENT_STATUS_FIELD else None,
            outstanding_balance=_rec_float(_SF_ACC_OUTSTANDING_BAL_FIELD) if use_health_fields and _SF_ACC_OUTSTANDING_BAL_FIELD else None,
            overdue_invoice_count=_rec_int(_SF_ACC_OVERDUE_INV_FIELD) if use_health_fields and _SF_ACC_OVERDUE_INV_FIELD else None,
        )
        db.add(acc)

    opp_records = None
    use_renewal_date_field = bool(_SALESFORCE_RENEWAL_DATE_FIELD)
    try:
        opp_records = await _salesforce_query_with_retry(connector, DEFAULT_OPPORTUNITY_SOQL)
    except Exception as e:
        err_str = str(e)
        if _SALESFORCE_RENEWAL_DATE_FIELD and ("INVALID_FIELD" in err_str or "No such column" in err_str):
            try:
                opp_records = await _salesforce_query_with_retry(connector, DEFAULT_OPPORTUNITY_SOQL_NO_RENEWAL)
                use_renewal_date_field = False
            except Exception as e2:
                await db.rollback()
                return {"ok": False, "error": f"Opportunities sync failed: {e2}"}
        else:
            await db.rollback()
            return {"ok": False, "error": f"Opportunities sync failed: {e}"}
    await db.execute(delete(Opportunity))
    for rec in opp_records:
        sf_id = rec.get("Id")
        if not sf_id:
            continue
        rt = rec.get("RecordType_Name")
        if rt is None and isinstance(rec.get("RecordType"), dict):
            rt = (rec.get("RecordType") or {}).get("Name") or (rec.get("RecordType") or {}).get("name")
        if rt is None and isinstance(rec.get("RecordType"), str):
            rt = rec.get("RecordType")
        if rt is None:
            for k, v in rec.items():
                if k and v and isinstance(v, str) and (k == "RecordType.Name" or k.replace("_", ".").lower() == "recordtype.name"):
                    rt = v
                    break
        record_type_name = (rt or "").strip() or None
        renewal_dt = _parse_date(rec.get(_SALESFORCE_RENEWAL_DATE_FIELD)) if use_renewal_date_field else None
        original_acv_val = _original_acv_from_record(rec)
        opportunity_arr_val = _opportunity_arr_c_from_record(rec)
        expansion_arr_val = None
        if _SALESFORCE_EXPANSION_ARR_FIELD:
            direct = rec.get(_SALESFORCE_EXPANSION_ARR_FIELD)
            expansion_arr_val = _float_or_none(direct) if direct is not None else None
            if expansion_arr_val is None:
                # Fallback for flattened keys / case differences
                exp_l = _SALESFORCE_EXPANSION_ARR_FIELD.lower()
                for k, v in rec.items():
                    if k and k.lower() == exp_l and v is not None:
                        expansion_arr_val = _float_or_none(v)
                        break
        contract_start_dt = _parse_date(rec.get(_SALESFORCE_CONTRACT_START_DATE_FIELD)) if _SALESFORCE_CONTRACT_START_DATE_FIELD else None
        contract_end_dt = _parse_date(rec.get(_SALESFORCE_CONTRACT_END_DATE_FIELD)) if _SALESFORCE_CONTRACT_END_DATE_FIELD else None
        midterm_val = rec.get(_SALESFORCE_MIDTERM_CANCELLATION_FIELD) if _SALESFORCE_MIDTERM_CANCELLATION_FIELD else None
        midterm_cancellation = 1 if midterm_val in (True, "true", "1", 1) or (isinstance(midterm_val, str) and midterm_val.strip().lower() == "true") else 0
        forecast_cat = (rec.get("Forecast__c") or "").strip() or None
        opp = Opportunity(
            sf_id=sf_id,
            name=rec.get("Name"),
            amount=float(rec.get("Amount") or 0),
            close_date=_parse_date(rec.get("CloseDate")),
            renewal_date=renewal_dt,
            original_acv=original_acv_val,
            opportunity_arr=opportunity_arr_val,
            expansion_arr=expansion_arr_val,
            stage_name=rec.get("StageName"),
            type=rec.get("Type"),
            record_type_name=record_type_name,
            account_id=rec.get("Account_Id"),
            account_name=rec.get("Account_Name"),
            owner_name=rec.get("Owner_Name"),
            mrr=_float_or_none(rec.get(_SALESFORCE_MRR_FIELD)),
            contract_start_date=contract_start_dt,
            contract_end_date=contract_end_dt,
            midterm_cancellation=midterm_cancellation,
            forecast_category=forecast_cat,
            created_date=_parse_datetime(rec.get("CreatedDate")),
            next_step=(rec.get("NextStep") or "").strip() or None,
            lead_type=(rec.get(_SF_LEAD_TYPE_FIELD) or "").strip() or None if _SF_LEAD_TYPE_FIELD else None,
            current_crm=(rec.get(_SF_CURRENT_CRM_FIELD) or "").strip() or None if _SF_CURRENT_CRM_FIELD else None,
            current_voip=(rec.get(_SF_CURRENT_VOIP_FIELD) or "").strip() or None if _SF_CURRENT_VOIP_FIELD else None,
            deal_tier=(rec.get(_SF_DEAL_TIER_FIELD) or "").strip() or None if _SF_DEAL_TIER_FIELD else None,
        )
        db.add(opp)

    try:
        line_soql = _line_item_soql(include_optional_term=True, include_service_dates=True)
        term_field_used = _LINE_ITEM_TERM_FIELD_TRY or _SALESFORCE_LINE_ITEM_TERM_FIELD or None
        line_item_term_fallback = False
        line_item_dates_fallback = False
        try:
            line_records = await _salesforce_query_with_retry(connector, line_soql)
        except Exception as line_err:
            err_str = str(line_err)
            if "INVALID_FIELD" not in err_str and "No such column" not in err_str:
                raise
            # Retry without service date fields (Start/End may not exist in org)
            if _SALESFORCE_LINE_ITEM_SERVICE_START_FIELD or _SALESFORCE_LINE_ITEM_SERVICE_END_FIELD:
                try:
                    line_soql = _line_item_soql(include_optional_term=True, include_service_dates=False)
                    line_records = await _salesforce_query_with_retry(connector, line_soql)
                    line_item_dates_fallback = True
                except Exception as line_err2:
                    err_str2 = str(line_err2)
                    if "INVALID_FIELD" not in err_str2 and "No such column" not in err_str2:
                        raise
                    if not term_field_used:
                        raise
                    line_soql = _line_item_soql(include_optional_term=False, include_service_dates=False)
                    line_records = await _salesforce_query_with_retry(connector, line_soql)
                    term_field_used = None
                    line_item_term_fallback = True
            else:
                if not term_field_used:
                    raise
                line_soql = _line_item_soql(include_optional_term=False, include_service_dates=False)
                line_records = await _salesforce_query_with_retry(connector, line_soql)
                term_field_used = None
                line_item_term_fallback = True
    except Exception as e:
        await db.rollback()
        return {"ok": False, "error": f"OpportunityLineItem sync failed: {e}"}
    await db.execute(delete(OpportunityLineItem))
    for rec in line_records:
        opp_sf_id = rec.get("OpportunityId")
        if not opp_sf_id:
            continue
        total = rec.get("TotalPrice")
        if total is not None:
            total = float(total)
        if total is None or total == 0:
            try:
                computed = float(rec.get("UnitPrice") or 0) * float(rec.get("Quantity") or 0)
                if computed != 0:
                    total = computed
                elif total is None:
                    total = 0
            except (TypeError, ValueError):
                if total is None:
                    total = 0
        product_name = (
            rec.get("Product2_Name")
            or rec.get("Product2.Name")
            or ((rec.get("Product2") or {}).get("Name") if isinstance(rec.get("Product2"), dict) else None)
        )
        if product_name:
            product_name = str(product_name).strip() or None
        if not product_name and rec.get("Name"):
            raw = (str(rec.get("Name")) or "").strip()
            if " - " in raw:
                raw = raw.rsplit(" - ", 1)[-1].strip() or raw
            if raw:
                product_name = raw
        term_months = None
        if term_field_used:
            try:
                t = rec.get(term_field_used)
                if t is None and isinstance(rec, dict):
                    for k, v in rec.items():
                        if k and (k.lower() == term_field_used.lower() or k.replace("_", "").lower() == term_field_used.replace("_", "").lower()):
                            t = v
                            break
                if t is not None:
                    term_months = float(t)
            except (TypeError, ValueError):
                pass
        if term_months is None and _SALESFORCE_LINE_ITEM_TERM_FIELD and _SALESFORCE_LINE_ITEM_TERM_FIELD != term_field_used:
            try:
                t = rec.get(_SALESFORCE_LINE_ITEM_TERM_FIELD)
                if t is None and isinstance(rec, dict):
                    for k, v in rec.items():
                        if k and k.lower() == _SALESFORCE_LINE_ITEM_TERM_FIELD.lower():
                            t = v
                            break
                if t is not None:
                    term_months = float(t)
            except (TypeError, ValueError):
                pass
        service_start_date = None
        service_end_date = None
        if _SALESFORCE_LINE_ITEM_SERVICE_START_FIELD:
            service_start_date = _parse_date(rec.get(_SALESFORCE_LINE_ITEM_SERVICE_START_FIELD))
        if _SALESFORCE_LINE_ITEM_SERVICE_END_FIELD:
            service_end_date = _parse_date(rec.get(_SALESFORCE_LINE_ITEM_SERVICE_END_FIELD))
        if term_months is None and service_start_date and service_end_date:
            try:
                delta = (service_end_date - service_start_date).days
                if delta > 0:
                    term_months = round(delta / 30.44, 2)
            except (TypeError, ValueError):
                pass
        line_arr = None
        if _SALESFORCE_LINE_ITEM_ARR_FIELD:
            _arr_raw = rec.get(_SALESFORCE_LINE_ITEM_ARR_FIELD)
            if _arr_raw is None and isinstance(rec, dict):
                for k, v in rec.items():
                    if k and k.lower() == _SALESFORCE_LINE_ITEM_ARR_FIELD.lower():
                        _arr_raw = v
                        break
            if _arr_raw is not None:
                try:
                    line_arr = float(_arr_raw)
                except (TypeError, ValueError):
                    line_arr = None
        db.add(OpportunityLineItem(
            opportunity_sf_id=opp_sf_id,
            product_name=product_name,
            quantity=float(rec.get("Quantity") or 0),
            unit_price=float(rec.get("UnitPrice") or 0),
            total_price=total,
            arr=line_arr,
            term_months=term_months,
            service_start_date=service_start_date,
            service_end_date=service_end_date,
        ))

    q_renewal_count = select(Opportunity).where(
        Opportunity.stage_name.isnot(None),
        ~Opportunity.stage_name.in_(CLOSED_STAGES),
    )
    r_count = await db.execute(q_renewal_count)
    all_open = r_count.scalars().all()
    renewal_count = sum(1 for o in all_open if _is_renewal_record_type(o.record_type_name))

    # ── OpportunityFieldHistory sync ──────────────────────────────────────────
    # Fetch stage, close-date, and amount changes for all opportunities.
    # Used by the AI forecast scoring agent.
    synced_field_history = 0
    field_history_error: Optional[str] = None
    try:
        hist_soql = (
            "SELECT OpportunityId, Field, OldValue, NewValue, CreatedDate "
            "FROM OpportunityFieldHistory "
            "WHERE Field IN ('StageName', 'CloseDate', 'Amount') "
            "ORDER BY CreatedDate ASC"
        )
        hist_records = await _salesforce_query_with_retry(connector, hist_soql)
        await db.execute(delete(OppFieldHistory))
        seen_fh: set[tuple] = set()
        for hrec in hist_records:
            opp_id = hrec.get("OpportunityId")
            field = hrec.get("Field")
            changed_at = _parse_datetime(hrec.get("CreatedDate"))
            if not opp_id or not field or changed_at is None:
                continue
            dedup_key = (opp_id, field, changed_at)
            if dedup_key in seen_fh:
                continue
            seen_fh.add(dedup_key)
            db.add(OppFieldHistory(
                sf_opp_id=opp_id,
                field=field,
                old_value=str(hrec.get("OldValue")) if hrec.get("OldValue") is not None else None,
                new_value=str(hrec.get("NewValue")) if hrec.get("NewValue") is not None else None,
                changed_at=changed_at,
            ))
        synced_field_history = len(seen_fh)
    except Exception as hist_err:
        # Non-fatal: field history is used only by the AI agent, not core sync.
        field_history_error = str(hist_err)

    # ── Sync Opportunity Notes ────────────────────────────────────────────────
    synced_notes = 0
    notes_error: Optional[str] = None
    try:
        notes_soql = (
            "SELECT Id, ParentId, Title, Body, CreatedDate "
            "FROM Note ORDER BY CreatedDate DESC"
        )
        note_records = await _salesforce_query_with_retry(connector, notes_soql)
        await db.execute(delete(OppNote))
        seen_notes: set[str] = set()
        for nrec in note_records:
            note_id = nrec.get("Id")
            parent_id = nrec.get("ParentId")
            if not note_id or not parent_id or note_id in seen_notes:
                continue
            seen_notes.add(note_id)
            db.add(OppNote(
                sf_note_id=note_id,
                sf_opp_id=parent_id,
                title=(nrec.get("Title") or "").strip() or None,
                body=(nrec.get("Body") or "").strip() or None,
                created_date=_parse_datetime(nrec.get("CreatedDate")),
            ))
        synced_notes = len(seen_notes)
    except Exception as notes_err:
        notes_error = str(notes_err)

    # ── Sync Opportunity Activities (Tasks) ───────────────────────────────────
    synced_activities = 0
    activities_error: Optional[str] = None
    try:
        activity_soql = (
            "SELECT Id, WhatId, Subject, Description, ActivityDate, TaskSubtype "
            "FROM Task WHERE WhatId != null AND ActivityDate >= LAST_N_DAYS:365 "
            "ORDER BY ActivityDate DESC NULLS LAST"
        )
        activity_records = await _salesforce_query_with_retry(connector, activity_soql)
        await db.execute(delete(OppActivity))
        seen_tasks: set[str] = set()
        for arec in activity_records:
            task_id = arec.get("Id")
            what_id = arec.get("WhatId")
            if not task_id or not what_id or task_id in seen_tasks:
                continue
            seen_tasks.add(task_id)
            db.add(OppActivity(
                sf_task_id=task_id,
                sf_opp_id=what_id,
                subject=(arec.get("Subject") or "").strip() or None,
                description=(arec.get("Description") or "").strip() or None,
                activity_date=_parse_date(arec.get("ActivityDate")),
                activity_type=(arec.get("TaskSubtype") or "").strip() or None,
            ))
        synced_activities = len(seen_tasks)
    except Exception as act_err:
        activities_error = str(act_err)

    msg = "Accounts, opportunities, and opportunity products synced."
    if _SALESFORCE_RENEWAL_DATE_FIELD and not use_renewal_date_field:
        msg += " Renewal Date field not found in Salesforce; renewals use Close Date. Check Setup → Opportunity → Fields for the correct API name, or remove SALESFORCE_RENEWAL_DATE_FIELD from .env."
    if field_history_error:
        msg += f" OpportunityFieldHistory sync skipped: {field_history_error}"
    if notes_error:
        msg += f" Notes sync skipped: {notes_error}"
    if activities_error:
        msg += f" Activities sync skipped: {activities_error}"
    return {
        "ok": True,
        "synced_accounts": len(account_records),
        "synced_opportunities": len(opp_records),
        "synced_line_items": len(line_records),
        "synced_field_history": synced_field_history,
        "synced_notes": synced_notes,
        "synced_activities": synced_activities,
        "line_item_term_field_used": term_field_used,
        "line_item_term_fallback": line_item_term_fallback,
        "renewal_opportunities_count": renewal_count,
        "message": msg,
        "renewal_date_field_used": use_renewal_date_field,
        "renewal_date_field_configured": bool(_SALESFORCE_RENEWAL_DATE_FIELD),
    }


@app.post("/api/sync/salesforce")
async def sync_salesforce():
    """
    Salesforce-only sync (for scripts / debugging). From the app UI use **POST /api/dataset/refresh** on the Dashboard instead.
    Requires SALESFORCE_USERNAME, SALESFORCE_PASSWORD, and SALESFORCE_SECURITY_TOKEN in .env.
    Uses a dedicated session and commits inside the sync lock so SQLite is not mid-transaction when the next sync starts.
    """
    try:
        async with _salesforce_sync_lock:
            async with AsyncSessionLocal() as db:
                result = await _run_salesforce_sync(db)
                if result.get("ok"):
                    await db.commit()
                else:
                    await db.rollback()
                return result
    except Exception as e:
        return JSONResponse(
            status_code=200,
            content={"ok": False, "error": f"Sync failed: {e}"},
        )


@app.get("/api/salesforce/eod-snapshots")
async def list_eod_snapshots(db: AsyncSession = Depends(get_db)):
    """
    List EOD snapshot dates. Daily EOD runs at 23:59:59 EST when the scheduler is enabled (ENABLE_SCHEDULED_EOD_SNAPSHOT, default on).
    Each snapshot reflects SQLite state at that time (CRM data from last manual app refresh unless hourly SF sync is on).
    """
    r = await db.execute(
        select(SalesforceEODSnapshot.snapshot_date, SalesforceEODSnapshot.snapshot_utc)
        .order_by(SalesforceEODSnapshot.snapshot_date.desc())
    )
    rows = r.all()
    return {
        "count": len(rows),
        "snapshots": [{"snapshot_date": d.isoformat(), "snapshot_utc": (t.isoformat() if t else None)} for d, t in rows],
        "message": "EOD snapshots run daily at 23:59:59 EST (unless ENABLE_SCHEDULED_EOD_SNAPSHOT=0). They capture current DB state—refresh CRM data from the Dashboard before EOD if you rely on manual sync only.",
    }


@app.get("/api/arr-schedule/schedule-breakdown")
@app.get("/api/admin/arr-schedule-breakdown")
async def arr_schedule_breakdown(
    q: str = Query("12 south", description="Case-insensitive substring of Salesforce account name"),
    db: AsyncSession = Depends(get_db),
):
    """
    Step-by-step Active ARR vs Contracted ARR for accounts whose name contains `q`.
    Contracted = schedule Active as-of today + 12 calendar months (EST); Alleva share applies when enabled.

    Registered at both `/api/arr-schedule/schedule-breakdown` (next to other schedule APIs) and
    `/api/admin/arr-schedule-breakdown` for convenience.
    """
    needle = (q or "").strip()
    if not needle:
        return {"query": "", "matches": [], "message": "Pass a non-empty q= substring."}
    diagnostic: list = []
    await _compute_active_arr_rows(
        db,
        apply_alleva_retained_arr_adjustment=True,
        diagnostic_account_name_substring=needle,
        diagnostic_out=diagnostic,
    )
    return {"query": needle, "match_count": len(diagnostic), "matches": diagnostic}


def _add_calendar_months(d: date, months: int) -> date:
    """Add calendar months to d (day clamped to last valid day of target month)."""
    m0 = d.month - 1 + months
    y = d.year + m0 // 12
    mo = m0 % 12 + 1
    last = calendar.monthrange(y, mo)[1]
    return date(y, mo, min(d.day, last))


def _schedule_active_arr_as_of(
    periods_with_arr: list[dict],
    sub_start: Optional[date],
    sub_end: Optional[date],
    as_of: date,
    anchor_arr: float,
    expansions: list[dict],
) -> float:
    """Schedule Active ARR using the same closed-won period / anchor+expansion rules, on calendar date ``as_of`` (EST)."""
    if periods_with_arr:
        period_hit = next(
            (p for p in periods_with_arr if p["start"] <= as_of <= p["end"]),
            None,
        )
        if period_hit is not None:
            return float(period_hit["arr"])
        if sub_start is not None and as_of < sub_start:
            return 0.0
        if sub_end is not None and as_of > sub_end:
            return 0.0
        expansion_sum = sum(
            float(exp["arr"])
            for exp in expansions
            if exp.get("close_date") and date.fromisoformat(exp["close_date"]) <= as_of
        )
        return round(float(anchor_arr) + expansion_sum, 2)
    if sub_start is not None and as_of < sub_start:
        return 0.0
    if sub_end is not None and as_of > sub_end:
        return 0.0
    expansion_sum = sum(
        float(exp["arr"])
        for exp in expansions
        if exp.get("close_date") and date.fromisoformat(exp["close_date"]) <= as_of
    )
    return round(float(anchor_arr) + expansion_sum, 2)


async def _compute_active_arr_rows(
    db: AsyncSession,
    apply_alleva_retained_arr_adjustment: bool = False,
    diagnostic_account_name_substring: Optional[str] = None,
    diagnostic_out: Optional[list] = None,
    crm_month_keys: Optional[list[str]] = None,
    product_month_groups: Optional[list[str]] = None,
) -> tuple[list[dict], Optional[str]]:
    """Compute active ARR rows (subscription start/end, ARR per account).

    **contracted_arr** uses the same schedule rules as **active_arr** but with as-of date = today + 12 calendar months (EST).
    Used by active-arr and active-arr-by-month. The optional Alleva retained-ARR adjustment is applied only when
    the schedule should reflect partner-retained revenue; other endpoints should keep the original math.
    """
    global _ascension_ascend_cleanup_done
    if not _ascension_ascend_cleanup_done:
        await _remove_ascension_ascend_overrides()
        await _remove_ascension_ascend_record_type_overrides()
        _ascension_ascend_cleanup_done = True
    overrides = await _get_record_type_overrides(db)
    active_arr_use_open_renewal = await _get_active_arr_account_overrides(db)
    _diag_sub = (diagnostic_account_name_substring or "").strip().lower()
    _want_diag = bool(_diag_sub and diagnostic_out is not None)

    def _account_matches_diagnostic(name: str | None) -> bool:
        return _want_diag and _diag_sub in (name or "").lower()

    def _opp_type(o) -> str:
        key = (o.sf_id or "").strip()
        override = overrides.get(key) or (overrides.get(key[:15]) if len(key) >= 15 else None)
        return (override or o.record_type_name or "").strip() or "—"

    def _is_renewal(o) -> bool:
        return _is_renewal_record_type(_opp_type(o))

    def _is_nb(o) -> bool:
        return _is_new_business_record_type(_opp_type(o))

    def _is_expansion(o) -> bool:
        return _is_expansion_record_type(_opp_type(o))

    q_cw = select(Opportunity).where(
        or_(
            Opportunity.stage_name.in_(CLOSED_STAGES),
            func.lower(func.trim(Opportunity.stage_name)) == "closed won",
        )
    )
    r_cw = await db.execute(q_cw)
    closed_won_opps = [o for o in r_cw.scalars().all() if _is_closed_won_stage(o.stage_name)]
    q_open = select(Opportunity).where(
        Opportunity.stage_name.isnot(None),
        ~Opportunity.stage_name.in_(CLOSED_STAGES),
    )
    r_open = await db.execute(q_open)
    open_opps = [
        o for o in r_open.scalars().all()
        if not _is_closed_won_stage(o.stage_name)
        and (o.stage_name or "").strip().lower() != "closed lost"
    ]

    account_keys = set()
    for o in closed_won_opps:
        if _is_renewal(o) or _is_nb(o):
            account_keys.add((o.account_id, o.account_name or None))
    for o in open_opps:
        if _is_renewal(o):
            account_keys.add((o.account_id, o.account_name or None))

    if not account_keys:
        return ([], None)

    account_included: dict[tuple[str | None, str | None], set[str]] = {}
    account_anchor: dict[tuple[str | None, str | None], str | None] = {}
    account_sub_start: dict[tuple[str | None, str | None], date | None] = {}
    account_sub_end: dict[tuple[str | None, str | None], date | None] = {}
    account_note: dict[tuple[str | None, str | None], str | None] = {}
    anchors_missing_start: set[str] = set()
    anchors_missing_end: set[str] = set()
    anchors_missing_start: set[str] = set()
    anchors_missing_end: set[str] = set()
    # All closed-won renewal/NB periods per account (for schedule: both past NB and renewals).
    # Each entry: list of {"opp": Opportunity, "start": date, "end": date} sorted by start.
    account_period_opps: dict[tuple[str | None, str | None], list[dict]] = {}
    # Optional earlier New Business term before the latest renewal/NB anchor (kept for backward compat / fallback)
    pre_anchor_start: dict[tuple[str | None, str | None], date] = {}
    pre_anchor_end: dict[tuple[str | None, str | None], date] = {}
    pre_anchor_arr: dict[tuple[str | None, str | None], float] = {}
    pre_anchor_base_arr: dict[tuple[str | None, str | None], float] = {}
    pre_anchor_expansions: dict[tuple[str | None, str | None], list[dict]] = {}

    for key in account_keys:
        cw_for_account = [o for o in closed_won_opps if (o.account_id, o.account_name or None) == key]
        open_for_account = [o for o in open_opps if (o.account_id, o.account_name or None) == key]
        closed_renewal_or_nb = [o for o in cw_for_account if _is_renewal(o) or _is_nb(o)]
        closed_expansions = [o for o in cw_for_account if _is_expansion(o)]
        open_renewals = [o for o in open_for_account if _is_renewal(o)]

        # Build all closed-won renewal/NB periods (both new business and renewals), sorted by period start.
        # This reflects ex-post-added old NB opps and all renewals (e.g. Rockland-style).
        def _period_start(o) -> date:
            return o.contract_start_date or o.close_date or date.max

        def _period_end(o) -> date:
            return o.contract_end_date or o.renewal_date or o.close_date or date.min

        period_opps_sorted = sorted(
            closed_renewal_or_nb,
            key=lambda o: (_period_start(o), _period_end(o)),
        )
        periods_for_key: list[dict] = []
        for o in period_opps_sorted:
            p_start = o.contract_start_date or o.close_date
            p_end = o.contract_end_date or o.renewal_date or o.close_date
            if p_start and p_end and p_start <= p_end:
                periods_for_key.append({"opp": o, "start": p_start, "end": p_end})
        account_period_opps[key] = periods_for_key

        if periods_for_key:
            # Include all period opps and expansions that fall within any period
            included = set()
            for p in periods_for_key:
                p_start, p_end = p["start"], p["end"]
                included.add(p["opp"].sf_id)
                for o in closed_expansions:
                    if o.sf_id and o.close_date and p_start <= o.close_date <= p_end:
                        included.add(o.sf_id)
            account_included[key] = included
            # Anchor = latest period's opp (for backward compat and product breakdown)
            anchor_opp = periods_for_key[-1]["opp"]
            account_anchor[key] = anchor_opp.sf_id
            if anchor_opp.contract_start_date is None:
                anchors_missing_start.add(anchor_opp.sf_id)
            if anchor_opp.contract_end_date is None:
                anchors_missing_end.add(anchor_opp.sf_id)
            account_sub_start[key] = min(p["start"] for p in periods_for_key)
            account_sub_end[key] = max(p["end"] for p in periods_for_key)
            account_note[key] = None
            # Pre-anchor: earliest period if different from anchor (for backward compat)
            if len(periods_for_key) >= 2:
                earliest = periods_for_key[0]
                nb_start = earliest["start"]
                nb_end = earliest["end"]
                anchor_start = periods_for_key[-1]["start"]
                pre_end = min(nb_end, anchor_start - timedelta(days=1)) if anchor_start > nb_end else nb_end
                if nb_start <= pre_end:
                    pre_anchor_start[key] = nb_start
                    pre_anchor_end[key] = pre_end
        elif open_renewals:
            open_anchor = max(open_renewals, key=lambda o: o.close_date or date.min)
            account_included[key] = {open_anchor.sf_id}
            account_anchor[key] = open_anchor.sf_id
            account_sub_start[key] = None
            account_sub_end[key] = open_anchor.close_date
            account_note[key] = "ren only"
        else:
            account_included[key] = set()
            account_anchor[key] = None
            account_sub_start[key] = None
            account_sub_end[key] = None
            account_note[key] = "No closed renewal/NB; no open renewal"

    opp_to_account_arr: dict[str, tuple[str | None, str | None]] = {}
    for key, included in account_included.items():
        for sf_id in included:
            opp_to_account_arr[sf_id] = key

    if not opp_to_account_arr:
        return ([], None)

    # For ARR calculations we need line items for **all** closed-won opps (NB, renewals, expansions),
    # not just the post-anchor ones included in account_included.
    all_closed_sf_ids = {o.sf_id for o in closed_won_opps if o.sf_id}
    q_lines = select(OpportunityLineItem).where(
        OpportunityLineItem.opportunity_sf_id.in_(all_closed_sf_ids)
    )
    r_lines = await db.execute(q_lines)
    lines = r_lines.scalars().all()

    # Fallback: when opportunity has no contract_start_date/contract_end_date, use Dazos CRM Platform line item dates
    DAZOS_CRM_PLATFORM = "dazos crm platform"
    platform_dates_by_opp: dict[str, tuple[date | None, date | None]] = {}
    for li in lines:
        if not li.opportunity_sf_id:
            continue
        name = (li.product_name or "").strip().lower()
        if DAZOS_CRM_PLATFORM not in name:
            continue
        existing = platform_dates_by_opp.get(li.opportunity_sf_id, (None, None))
        # Use first line that provides each date (don't overwrite with null)
        start = li.service_start_date if li.service_start_date is not None else existing[0]
        end = li.service_end_date if li.service_end_date is not None else existing[1]
        platform_dates_by_opp[li.opportunity_sf_id] = (start, end)
    # Second pass: for opps still missing start or end, use first line item (any product) that has those dates
    for li in lines:
        if not li.opportunity_sf_id or (not li.service_start_date and not li.service_end_date):
            continue
        existing = platform_dates_by_opp.get(li.opportunity_sf_id, (None, None))
        start = li.service_start_date if li.service_start_date is not None else existing[0]
        end = li.service_end_date if li.service_end_date is not None else existing[1]
        if start is not None or end is not None:
            platform_dates_by_opp[li.opportunity_sf_id] = (start, end)
    # Patch period start/end from line items for any opp missing contract dates
    for key in account_keys:
        for p in account_period_opps.get(key, []):
            opp = p["opp"]
            sf_id = opp.sf_id
            if not sf_id:
                continue
            platform = platform_dates_by_opp.get(sf_id)
            if not platform:
                continue
            if (opp.contract_start_date is None and platform[0]) or (opp.contract_end_date is None and platform[1]):
                p["start"] = platform[0] or p["start"]
                p["end"] = platform[1] or p["end"]
        # Recompute account_sub_start/end from patched periods (min/max of all NB + renewal periods)
        periods = account_period_opps.get(key, [])
        if periods:
            account_sub_start[key] = min(p["start"] for p in periods)
            account_sub_end[key] = max(p["end"] for p in periods)

    # Midterm cancellation: Closed Lost renewal with Midterm Cancellation = true → subscription end = that opp's contract_end_date.
    # This also ends any previously closed NB/renewal periods (truncate all periods at mid-term end).
    q_midterm = select(Opportunity).where(
        func.lower(func.trim(Opportunity.stage_name)) == "closed lost",
        Opportunity.midterm_cancellation == 1,
        Opportunity.contract_end_date.isnot(None),
    )
    r_midterm = await db.execute(q_midterm)
    midterm_opps = [o for o in r_midterm.scalars().all() if _is_renewal(o) and (o.account_id, o.account_name or None) in account_keys]
    for key in account_keys:
        for_account = [o for o in midterm_opps if (o.account_id, o.account_name or None) == key]
        if not for_account:
            continue
        # Use the latest by close_date to get the defining midterm cancellation
        best = max(for_account, key=lambda o: o.close_date or date.min)
        if best.contract_end_date:
            midterm_end = best.contract_end_date
            account_sub_end[key] = midterm_end
            # Truncate every period (including prior closed-won NB) at mid-term end so schedule reflects correct end.
            for p in account_period_opps.get(key, []):
                if p["end"] > midterm_end:
                    p["end"] = midterm_end

    opp_to_arr: dict[str, float] = {}
    for opp_sf_id, _canonical, arr in _line_items_to_arr_by_group(lines):
        opp_to_arr[opp_sf_id] = opp_to_arr.get(opp_sf_id, 0.0) + arr

    # Only use original_acv when the opp has no line items. If it has line items but they're all excluded (e.g. Premium Support), keep ARR at 0.
    opp_sf_ids_with_any_line_item = {li.opportunity_sf_id for li in lines if li.opportunity_sf_id}
    all_opps = closed_won_opps + open_opps
    opp_to_close_date: dict[str, date | None] = {o.sf_id: o.close_date for o in all_opps}

    # Fallback: for opportunities with no product lines, use their ARR/ACV from Opportunity.original_acv (which may come from ARR__c).
    for o in all_opps:
        if o.sf_id and opp_to_arr.get(o.sf_id, 0.0) == 0 and o.original_acv is not None:
            if o.sf_id in opp_sf_ids_with_any_line_item:
                # Has line items but all excluded (e.g. only Premium Support) — do not use original_acv so ARR stays 0.
                continue
            try:
                opp_to_arr[o.sf_id] = round(float(o.original_acv), 2)
            except (TypeError, ValueError):
                continue

    open_renewal_opps = [o for o in open_opps if _is_renewal(o)]
    open_renewal_sf_ids = {o.sf_id for o in open_renewal_opps}
    opp_to_account_open_renewal = {o.sf_id: (o.account_id, o.account_name or None) for o in open_renewal_opps}
    renewal_arr_by_account: dict[tuple[str | None, str | None], float] = {}
    if open_renewal_sf_ids:
        q_lines_open = select(OpportunityLineItem).where(
            OpportunityLineItem.opportunity_sf_id.in_(open_renewal_sf_ids)
        )
        r_lines_open = await db.execute(q_lines_open)
        open_lines = r_lines_open.scalars().all()
        for opp_sf_id, _canonical, arr in _line_items_to_arr_by_group(open_lines):
            acc = opp_to_account_open_renewal.get(opp_sf_id)
            if acc:
                renewal_arr_by_account[acc] = renewal_arr_by_account.get(acc, 0.0) + arr

    products = list(ARR_PRODUCT_COLUMNS) + ["Other"]
    by_account_product: dict[tuple[str | None, str | None], dict[str, float]] = {}
    for opp_sf_id, canonical, arr in _line_items_to_arr_by_group(lines):
        acc = opp_to_account_arr.get(opp_sf_id)
        if not acc:
            continue
        if acc not in by_account_product:
            by_account_product[acc] = {p: 0.0 for p in products}
        by_account_product[acc][canonical] = by_account_product[acc].get(canonical, 0) + arr

    for key in account_keys:
        if key not in by_account_product:
            by_account_product[key] = {p: 0.0 for p in products}

    account_ids = {aid for (aid, _) in account_keys if aid}
    account_segment: dict[str, str | None] = {}
    account_status: dict[str, str | None] = {}
    account_type_map: dict[str, str | None] = {}
    account_owner_name_map: dict[str, str | None] = {}
    account_partner_affiliate_share_map: dict[str, float | None] = {}
    if account_ids:
        q_acc = select(
            Account.sf_id,
            Account.segment,
            Account.status,
            Account.type,
            Account.owner_name,
            Account.partner_affiliate_revenue_share,
        ).where(Account.sf_id.in_(account_ids))
        r_acc = await db.execute(q_acc)
        for (sf_id, seg, st, typ, owner_name, share_val) in r_acc.all():
            account_segment[sf_id] = seg
            account_status[sf_id] = st
            account_type_map[sf_id] = typ
            account_owner_name_map[sf_id] = owner_name
            account_partner_affiliate_share_map[sf_id] = share_val

    today_est = datetime.now(EST).date()

    # Build ARR per period for each account (closed-won NB + renewal periods). Used for by_month and active_arr.
    account_periods_with_arr: dict[tuple[str | None, str | None], list[dict]] = {}
    for key in account_keys:
        periods = account_period_opps.get(key, [])
        cw_for_account = [o for o in closed_won_opps if (o.account_id, o.account_name or None) == key]
        closed_expansions_key = [o for o in cw_for_account if _is_expansion(o)]
        arr_periods: list[dict] = []
        for p in periods:
            start, end = p["start"], p["end"]
            base = float(opp_to_arr.get(p["opp"].sf_id, 0.0) or 0.0)
            exp_arr = sum(
                float(opp_to_arr.get(o.sf_id, 0.0) or 0.0)
                for o in closed_expansions_key
                if o.sf_id and o.close_date and start <= o.close_date <= end
            )
            arr_periods.append({"start": start, "end": end, "arr": round(base + exp_arr, 2)})
        account_periods_with_arr[key] = arr_periods

    # By-product only for the period that is active today (do not add all periods together).
    current_period_opp_sf_ids: dict[tuple[str | None, str | None], set[str]] = {}
    for key in account_keys:
        periods = account_period_opps.get(key, [])
        cw_for_account = [o for o in closed_won_opps if (o.account_id, o.account_name or None) == key]
        closed_expansions_key = [o for o in cw_for_account if _is_expansion(o)]
        for p in periods:
            if p["start"] <= today_est <= p["end"]:
                s: set[str] = {p["opp"].sf_id} if p["opp"].sf_id else set()
                for o in closed_expansions_key:
                    if o.sf_id and o.close_date and p["start"] <= o.close_date <= p["end"]:
                        s.add(o.sf_id)
                current_period_opp_sf_ids[key] = s
                break

    by_account_product_active: dict[tuple[str | None, str | None], dict[str, float]] = {}
    for opp_sf_id, canonical, arr in _line_items_to_arr_by_group(lines):
        acc = opp_to_account_arr.get(opp_sf_id)
        if not acc:
            continue
        current_ids = current_period_opp_sf_ids.get(acc)
        # Only include ARR from opps in the period that contains today (do not add all periods).
        if current_ids is not None and opp_sf_id not in current_ids:
            continue
        if current_ids is None and account_periods_with_arr.get(acc):
            # Has periods but today is not in any period → active ARR is 0, no product breakdown.
            continue
        if acc not in by_account_product_active:
            by_account_product_active[acc] = {p: 0.0 for p in products}
        by_account_product_active[acc][canonical] = by_account_product_active[acc].get(canonical, 0) + arr

    # CRM seats per opportunity: Additional CRM Seats (quantity) + 5 seats per CRM Platform (Includes 5 Seats) opp.
    seats_by_opp: dict[str, int] = {}
    opp_ids_with_platform_5: set[str] = set()
    for li in lines:
        opp_id = (li.opportunity_sf_id or "").strip()
        if not opp_id:
            continue
        if _is_additional_crm_seats(li.product_name):
            try:
                qty = int(float(li.quantity or 0))
            except (TypeError, ValueError):
                qty = 0
            if qty:
                seats_by_opp[opp_id] = seats_by_opp.get(opp_id, 0) + qty
        elif _is_crm_platform_includes_5_seats(li.product_name):
            opp_ids_with_platform_5.add(opp_id)
    for oid in opp_ids_with_platform_5:
        seats_by_opp[oid] = seats_by_opp.get(oid, 0) + 5

    crm_seats_by_account: dict[tuple[str | None, str | None], int] = {}
    for key, opp_ids in current_period_opp_sf_ids.items():
        crm_seats_by_account[key] = sum(seats_by_opp.get(oid, 0) for oid in opp_ids)

    # CRM ARR from CRM SKUs only: Additional CRM Seats, CRM Platform (Includes 5 Seats), CRM Platform (Legacy).
    crm_sku_groups: dict[tuple[str, str], list] = {}
    for li in lines:
        opp_id = (li.opportunity_sf_id or "").strip()
        if not opp_id:
            continue
        if _is_additional_crm_seats(li.product_name):
            crm_sku_groups.setdefault((opp_id, "seats"), []).append(li)
        elif _is_crm_platform_includes_5_seats(li.product_name):
            crm_sku_groups.setdefault((opp_id, "platform_5"), []).append(li)
        elif _is_crm_platform_legacy(li.product_name):
            crm_sku_groups.setdefault((opp_id, "legacy"), []).append(li)

    crm_arr_by_opp: dict[str, float] = {}
    for (opp_id, _kind), items in crm_sku_groups.items():
        arr = _arr_mix_contribution_for_line_group(items)
        crm_arr_by_opp[opp_id] = crm_arr_by_opp.get(opp_id, 0.0) + arr

    crm_arr_by_account: dict[tuple[str | None, str | None], float] = {}
    for key, opp_ids in current_period_opp_sf_ids.items():
        total_arr = sum(crm_arr_by_opp.get(oid, 0.0) for oid in opp_ids)
        if total_arr:
            crm_arr_by_account[key] = round(total_arr, 2)

    # CRM ARR and CRM seats as of each month-end (true point-in-time snapshot). Same period logic as
    # current_period_opp_sf_ids, but evaluated at each month-end instead of today: take the closed-won
    # period (NB/renewal term) that contains the month-end, plus expansions that closed on/before that
    # month-end and within the period. Powers the Seat Pricing "previous month end" view.
    _schedule_months = crm_month_keys if crm_month_keys else _default_schedule_by_month_keys()
    _month_end_dates: list[tuple[str, date]] = []
    for _mk in _schedule_months:
        _y, _m = int(_mk[:4]), int(_mk[5:7])
        _month_end_dates.append((_mk, date(_y, _m, calendar.monthrange(_y, _m)[1])))

    # Per-product ARR per opportunity for each requested product family (for per-product ARR bridges).
    _req_groups = [g for g in (product_month_groups or []) if g in _PRODUCT_GROUP_PREDICATES]
    product_arr_by_opp: dict[str, dict[str, float]] = {
        g: _product_group_arr_by_opp(lines, _PRODUCT_GROUP_PREDICATES[g]) for g in _req_groups
    }
    # product_arr_by_account_by_month[group][account_key][month_key] = arr
    product_arr_by_account_by_month: dict[str, dict[tuple[str | None, str | None], dict[str, float]]] = {
        g: {} for g in _req_groups
    }

    crm_seats_by_account_by_month: dict[tuple[str | None, str | None], dict[str, int]] = {}
    crm_arr_by_account_by_month: dict[tuple[str | None, str | None], dict[str, float]] = {}
    for key in account_keys:
        periods = account_period_opps.get(key, [])
        cw_for_account = [o for o in closed_won_opps if (o.account_id, o.account_name or None) == key]
        closed_expansions_key = [o for o in cw_for_account if _is_expansion(o)]
        seats_bm: dict[str, int] = {}
        arr_bm: dict[str, float] = {}
        prod_bm: dict[str, dict[str, float]] = {g: {} for g in _req_groups}
        for _mk, _me in _month_end_dates:
            p_hit = next((p for p in periods if p["start"] <= _me <= p["end"]), None)
            if p_hit is None:
                seats_bm[_mk] = 0
                arr_bm[_mk] = 0.0
                for g in _req_groups:
                    prod_bm[g][_mk] = 0.0
                continue
            opp_ids_me: set[str] = {p_hit["opp"].sf_id} if p_hit["opp"].sf_id else set()
            for o in closed_expansions_key:
                if (
                    o.sf_id
                    and o.close_date
                    and p_hit["start"] <= o.close_date <= p_hit["end"]
                    and o.close_date <= _me
                ):
                    opp_ids_me.add(o.sf_id)
            seats_bm[_mk] = sum(seats_by_opp.get(oid, 0) for oid in opp_ids_me)
            arr_bm[_mk] = round(sum(crm_arr_by_opp.get(oid, 0.0) for oid in opp_ids_me), 2)
            # Product mix uses each expansion's OWN contract window (the same basis as the snapshot
            # Total) rather than close-date, so the per-product split always reflects what is actually
            # live at month-end. This prevents (a) a superseded mid-term line being carried past a
            # renewal that already reflects the change (e.g. a negative ARR contraction double-counted,
            # which otherwise inverts the proportional mix), and (b) a future-start expansion leaking
            # into the mix before its term begins. Seats/CRM totals above are intentionally left on the
            # original close-date basis to avoid disturbing Seat Pricing.
            opp_ids_me_prod: set[str] = {p_hit["opp"].sf_id} if p_hit["opp"].sf_id else set()
            for o in closed_expansions_key:
                if not o.sf_id:
                    continue
                cs = o.contract_start_date
                ce = o.contract_end_date
                if cs is not None:
                    if cs <= _me and (ce is None or _me <= ce):
                        opp_ids_me_prod.add(o.sf_id)
                elif (
                    o.close_date
                    and p_hit["start"] <= o.close_date <= p_hit["end"]
                    and o.close_date <= _me
                ):
                    opp_ids_me_prod.add(o.sf_id)
            for g in _req_groups:
                gmap = product_arr_by_opp[g]
                prod_bm[g][_mk] = round(sum(gmap.get(oid, 0.0) for oid in opp_ids_me_prod), 2)
        crm_seats_by_account_by_month[key] = seats_bm
        crm_arr_by_account_by_month[key] = arr_bm
        for g in _req_groups:
            product_arr_by_account_by_month[g][key] = prod_bm[g]

    out_rows = []
    for (aid, aname), by_product in by_account_product.items():
        key = (aid, aname)
        # Use only the period active today for product breakdown and total (do not add all periods together).
        if key in account_periods_with_arr:
            if key in by_account_product_active:
                by_product_arr = {p: round(by_account_product_active[key].get(p, 0), 2) for p in products}
                total_arr = round(sum(by_product_arr.values()), 2)
            else:
                by_product_arr = {p: 0.0 for p in products}
                total_arr = 0.0
        else:
            by_product_arr = {p: round(by_product.get(p, 0), 2) for p in products}
            total_arr = round(sum(by_product_arr.values()), 2)
        renewal_arr_val = round(renewal_arr_by_account.get(key, 0.0), 2)
        anchor_sf_id = account_anchor.get(key)
        included_sf_ids = account_included.get(key) or set()
        anchor_arr = round(opp_to_arr.get(anchor_sf_id, 0.0), 2) if anchor_sf_id else 0.0
        expansions_raw = [
            {"close_date": (opp_to_close_date.get(sf_id) or date.min).isoformat(), "arr": round(opp_to_arr.get(sf_id, 0.0), 2)}
            for sf_id in included_sf_ids
            if sf_id != anchor_sf_id and opp_to_close_date.get(sf_id)
        ]
        expansions = sorted(expansions_raw, key=lambda x: x["close_date"])
        if (aname or "").strip().lower() in active_arr_use_open_renewal:
            total_arr = renewal_arr_val
            by_product_arr = {p: 0.0 for p in products}
            by_product_arr["Other"] = renewal_arr_val
            anchor_arr = renewal_arr_val
            expansions = []
        seg = (account_segment.get(aid) if aid else None) or ""
        seg = (seg or "").strip() or DEFAULT_SEGMENT
        status = (account_status.get(aid) if aid else None) or ""
        status = (status or "").strip() or None
        is_churned = status and (status.strip().lower() in CHURNED_ACCOUNT_STATUSES)
        if is_churned:
            # Churned accounts: keep historical ARR (anchor_arr + expansions) for by-month history,
            # but treat current Active ARR and product breakdown as zero.
            total_arr = 0.0
            by_product_arr = {p: 0.0 for p in products}
        sub_start = account_sub_start.get(key)
        sub_end = account_sub_end.get(key)

        # If we captured a pre-anchor NB term, now that opp_to_arr is available, compute its ARR
        if key in pre_anchor_start and key in pre_anchor_end:
            nb_start = pre_anchor_start[key]
            nb_end = pre_anchor_end[key]
            cw_for_account = [o for o in closed_won_opps if (o.account_id, o.account_name or None) == key]
            nb_opps = [o for o in cw_for_account if _is_nb(o)]
            earliest_nb_local = min(nb_opps, key=lambda o: o.close_date or date.max) if nb_opps else None
            nb_base = 0.0
            pre_exp_list: list[dict] = []
            if earliest_nb_local:
                nb_base = float(opp_to_arr.get(earliest_nb_local.sf_id, 0.0) or 0.0)
                # Include any other non-renewal Closed Won opps (expansions / add-ons) whose close_date
                # falls on or before the end of this NB term, even if they predate the NB close.
                pre_others = [
                    o for o in cw_for_account
                    if o.sf_id
                    and o.sf_id != earliest_nb_local.sf_id
                    and not _is_renewal(o)
                    and o.close_date
                    and o.close_date <= nb_end
                ]
                for o in pre_others:
                    amt = float(opp_to_arr.get(o.sf_id, 0.0) or 0.0)
                    if amt:
                        pre_exp_list.append(
                            {
                                "close_date": (o.close_date or nb_start).isoformat(),
                                "arr": round(amt, 2),
                            }
                        )
            pre_anchor_base_arr[key] = round(nb_base, 2)
            pre_anchor_expansions[key] = pre_exp_list
            pre_anchor_arr[key] = round(nb_base + sum(e["arr"] for e in pre_exp_list), 2)
        # Active ARR as of today (EST): closed-won NB + renewal schedule, or anchor + expansions (same rules as before).
        periods_with_arr = account_periods_with_arr.get(key, [])
        period_containing_today = (
            next((p for p in periods_with_arr if p["start"] <= today_est <= p["end"]), None)
            if periods_with_arr
            else None
        )
        active_arr_today = _schedule_active_arr_as_of(
            periods_with_arr, sub_start, sub_end, today_est, anchor_arr, expansions
        )
        active_schedule_branch = "closed-won schedule / anchor+expansions evaluated as of today (America/New_York)"

        expansion_arr_for_diag = sum(
            float(exp["arr"])
            for exp in expansions
            if exp.get("close_date") and date.fromisoformat(exp["close_date"]) <= today_est
        )
        active_after_schedule = float(active_arr_today)
        name_lower = (aname or "").strip().lower()
        in_open_renewal_override = name_lower in active_arr_use_open_renewal
        open_renewal_override_applied = in_open_renewal_override and not is_churned
        # Manual override: Active ARR = open renewal line ARR.
        if open_renewal_override_applied:
            active_arr_today = renewal_arr_val
        # Contracted ARR = same schedule definition as Active, but evaluated 12 calendar months after today (EST).
        # Open-renewal override applies only to Active, not to Contracted (Contracted stays pure +12mo schedule view).
        future_est = _add_calendar_months(today_est, 12)
        contracted_arr_today = _schedule_active_arr_as_of(
            periods_with_arr, sub_start, sub_end, future_est, anchor_arr, expansions
        )
        contracted_branch = (
            f"same schedule rules as Active, as-of date +12 months ({future_est.isoformat()} EST)"
        )
        future_period_hit = (
            next((p for p in periods_with_arr if p["start"] <= future_est <= p["end"]), None)
            if periods_with_arr
            else None
        )
        future_contract_period: dict | None = (
            {
                "start": future_period_hit["start"].isoformat(),
                "end": future_period_hit["end"].isoformat(),
                "arr": future_period_hit["arr"],
                "as_of_plus_12mo": future_est.isoformat(),
            }
            if future_period_hit
            else {"as_of_plus_12mo": future_est.isoformat(), "note": "no period contains the +12mo as-of date"}
        )
        # Serialize periods for by-month and export (both closed-won NB and renewal terms)
        periods_serialized = [
            {"start": p["start"].isoformat(), "end": p["end"].isoformat(), "arr": p["arr"]}
            for p in periods_with_arr
        ]
        active_before_churn = float(active_arr_today)
        contracted_before_churn = float(contracted_arr_today)
        if is_churned:
            active_arr_today = 0.0
            contracted_arr_today = 0.0
        active_before_alleva = float(active_arr_today)
        contracted_before_alleva = float(contracted_arr_today)
        # Alleva Customer adjustment:
        # For these accounts, a portion of the revenue stays with the partner (Alleva).
        # We apply this factor to both:
        # - schedule Active ARR (today)
        # - schedule Contracted ARR (today)
        # - schedule monthly ARR (by_month)
        acct_type_norm = ((account_type_map.get(aid) if aid else None) or '').strip().lower()
        alleva_retained_factor: float | None = None
        if apply_alleva_retained_arr_adjustment and acct_type_norm == 'alleva customer':
            share_raw = account_partner_affiliate_share_map.get(aid)
            share_val: float | None = None
            if share_raw is not None:
                try:
                    if isinstance(share_raw, str):
                        s = share_raw.strip().replace('%', '')
                        share_val = float(s) if s else None
                    else:
                        share_val = float(share_raw)
                except (TypeError, ValueError):
                    share_val = None
            share_factor: float | None = None
            if share_val is not None:
                # Accept both 0-1 (e.g. 0.8) and 0-100 (e.g. 80).
                share_factor = share_val / 100.0 if share_val > 1.0 else share_val
                share_factor = max(0.0, min(1.0, share_factor))
            if share_factor is not None:
                # ARR now derives from the line-item ARR__c field, which is already net of the
                # partner revenue-share for Alleva accounts, so we no longer scale by the factor
                # here (doing so would double-count the partner share). Kept for transparency only.
                alleva_retained_factor = share_factor
        note = account_note.get(key)
        if _account_matches_diagnostic(aname) and diagnostic_out is not None:
            diagnostic_out.append(
                {
                    "as_of_date_est": today_est.isoformat(),
                    "timezone": "America/New_York",
                    "apply_alleva_retained_arr_adjustment": apply_alleva_retained_arr_adjustment,
                    "account_id": aid,
                    "account_name": aname or "—",
                    "account_type": (account_type_map.get(aid) if aid else None),
                    "status": status,
                    "is_churned": is_churned,
                    "schedule_note": note,
                    "in_open_renewal_override_list": in_open_renewal_override,
                    "open_renewal_line_arr": renewal_arr_val,
                    "anchor_opportunity_arr": anchor_arr,
                    "expansions_closed_won": expansions,
                    "expansion_arr_sum_close_on_or_before_today": round(expansion_arr_for_diag, 2),
                    "subscription_window": {
                        "start": sub_start.isoformat() if sub_start else None,
                        "end": sub_end.isoformat() if sub_end else None,
                    },
                    "closed_won_periods_with_arr": periods_serialized,
                    "period_containing_today": (
                        {
                            "start": period_containing_today["start"].isoformat(),
                            "end": period_containing_today["end"].isoformat(),
                            "arr": period_containing_today["arr"],
                        }
                        if period_containing_today
                        else None
                    ),
                    "active_arr_explanation": {
                        "schedule_branch": active_schedule_branch,
                        "value_after_schedule_only": round(active_after_schedule, 2),
                        "open_renewal_override_applied": open_renewal_override_applied,
                        "value_after_override_before_churn": round(active_before_churn, 2),
                        "value_after_churn_before_alleva": round(active_before_alleva, 2),
                        "alleva_retained_factor_applied": alleva_retained_factor,
                        "final_active_arr": active_arr_today,
                    },
                    "contracted_arr_explanation": {
                        "branch": contracted_branch,
                        "future_period_used": future_contract_period,
                        "value_before_churn": round(contracted_before_churn, 2),
                        "value_after_churn_before_alleva": round(contracted_before_alleva, 2),
                        "alleva_retained_factor_applied": alleva_retained_factor,
                        "final_contracted_arr": round(contracted_arr_today, 2),
                    },
                    "products_purchased_note": (
                        "Products purchased: Active ARR / Contracted ARR columns use this schedule row. "
                        "Total / by-product $ come from open Renewal opps' line items only (not this breakdown)."
                    ),
                }
            )
        crm_seats = crm_seats_by_account.get(key)
        crm_arr_val = crm_arr_by_account.get(key)
        # Per-month CRM snapshot. ARR comes from the line-item ARR__c field (already net of partner
        # share), so no Alleva factor is applied here. Seats are raw counts.
        crm_seats_bm = crm_seats_by_account_by_month.get(key, {})
        crm_arr_bm = dict(crm_arr_by_account_by_month.get(key, {}))
        # Per-product month-end ARR (already net via ARR__c), for per-product ARR bridges.
        product_arr_bm: dict[str, dict[str, float]] = {}
        for g in _req_groups:
            product_arr_bm[g] = dict(product_arr_by_account_by_month.get(g, {}).get(key, {}))
        out_rows.append({
            "account_id": aid,
            "account_name": aname or "—",
            "owner_name": account_owner_name_map.get(aid) if aid else None,
            "status": status,
            "type": (account_type_map.get(aid) if aid else None),
            "segment": seg,
            "active_arr": active_arr_today,
            "contracted_arr": round(contracted_arr_today, 2),
            "alleva_retained_factor": alleva_retained_factor,
            "crm_seats": crm_seats,
            "crm_arr": crm_arr_val,
            "crm_seats_by_month": crm_seats_bm,
            "crm_arr_by_month": crm_arr_bm,
            "product_arr_by_month": product_arr_bm,
            "anchor_arr": anchor_arr,
            "expansions": expansions,
            "by_product": {p: by_product_arr.get(p, 0) for p in products},
            "subscription_start_date": sub_start.isoformat() if sub_start else None,
            "subscription_end_date": sub_end.isoformat() if sub_end else None,
            "periods": periods_serialized,
            "pre_anchor_start": pre_anchor_start.get(key).isoformat() if key in pre_anchor_start else None,
            "pre_anchor_end": pre_anchor_end.get(key).isoformat() if key in pre_anchor_end else None,
            "pre_anchor_arr": pre_anchor_arr.get(key) if key in pre_anchor_arr else None,
            "pre_anchor_base_arr": pre_anchor_base_arr.get(key) if key in pre_anchor_base_arr else None,
            "pre_anchor_expansions": pre_anchor_expansions.get(key) if key in pre_anchor_expansions else None,
            "note": note,
            "no_new_business": bool(note and (note == "ren only" or "Open renewal only" in (note or ""))),
        })
    base = os.getenv("SALESFORCE_BASE_URL", "").strip().rstrip("/")
    if base and ("salesforce.com" in base or "lightning.force.com" in base):
        return (out_rows, base)
    return (out_rows, None)


async def _active_arr_by_account_id(db: AsyncSession) -> dict[str, float]:
    """
    Map Salesforce account_id -> Active ARR as of today (EST), using the same definition as the
    Schedule (anchor + expansions within subscription window).
    """
    rows, _ = await _compute_active_arr_rows(db)
    out: dict[str, float] = {}
    for row in rows:
        aid = row.get("account_id")
        if aid:
            try:
                out[aid] = float(row.get("active_arr") or 0.0)
            except (TypeError, ValueError):
                continue
    return out


def _norm_sf_account_id(aid: str | None) -> str | None:
    if not aid or not isinstance(aid, str):
        return None
    s = aid.strip()
    return s or None


def _norm_account_name_match(name: str | None) -> str | None:
    """Lowercase, strip, collapse whitespace; None if missing or placeholder."""
    if name is None or not isinstance(name, str):
        return None
    t = name.strip()
    if not t or t == "—":
        return None
    return " ".join(t.split()).lower()


def _sf_account_ids_match(a: str | None, b: str | None) -> bool:
    aa = _norm_sf_account_id(a)
    bb = _norm_sf_account_id(b)
    if not aa or not bb:
        return False
    if aa == bb:
        return True
    if len(aa) >= 15 and len(bb) >= 15 and aa[:15] == bb[:15]:
        return True
    return False


def _schedule_row_active_arr_value(sr: dict) -> float:
    try:
        return float(sr.get("active_arr") or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _schedule_row_contracted_arr_value(sr: dict) -> float:
    try:
        v = sr.get("contracted_arr")
        if v is not None:
            return float(v)
    except (TypeError, ValueError):
        pass
    return _schedule_row_active_arr_value(sr)


def _pick_schedule_row_for_account(
    schedule_rows: list[dict],
    account_id: str | None,
    account_name: str | None,
    *,
    official_account_name_norm: str | None = None,
) -> dict | None:
    """
    Single schedule row for Products purchased / lookups. When multiple rows match by name, pick the one
    with highest active_arr so active_arr and contracted_arr are read from the same row (not max(active) vs max(contracted)).
    """
    pid = _norm_sf_account_id(account_id)
    pname = _norm_account_name_match(account_name)

    if pid:
        for sr in schedule_rows:
            if _sf_account_ids_match(pid, sr.get("account_id")):
                return sr

    names_to_try = [n for n in (pname, official_account_name_norm) if n]
    for try_name in names_to_try:
        matches = [sr for sr in schedule_rows if _norm_account_name_match(sr.get("account_name")) == try_name]
        if len(matches) == 1:
            return matches[0]
        for sr in matches:
            if pid and _sf_account_ids_match(pid, sr.get("account_id")):
                return sr
        if matches:
            return max(matches, key=lambda m: _schedule_row_active_arr_value(m))
    return None


def _active_arr_from_schedule_rows(
    schedule_rows: list[dict],
    account_id: str | None,
    account_name: str | None,
    *,
    official_account_name_norm: str | None = None,
) -> float:
    """
    Products purchased: use the exact same `rows` list as GET /api/arr-schedule/active-arr
    (from _compute_active_arr_rows with Alleva adjustment). Scan that list — no separate index.
    """
    sr = _pick_schedule_row_for_account(
        schedule_rows, account_id, account_name, official_account_name_norm=official_account_name_norm
    )
    return _schedule_row_active_arr_value(sr) if sr else 0.0


def _contracted_arr_from_schedule_rows(
    schedule_rows: list[dict],
    account_id: str | None,
    account_name: str | None,
    *,
    official_account_name_norm: str | None = None,
) -> float:
    """Products purchased: Contracted ARR from same schedule row as active (+12 month as-of date vs today)."""
    sr = _pick_schedule_row_for_account(
        schedule_rows, account_id, account_name, official_account_name_norm=official_account_name_norm
    )
    return _schedule_row_contracted_arr_value(sr) if sr else 0.0


async def _arr_total_by_account_as_of(db: AsyncSession, as_of: date | None) -> dict[str, float]:
    """
    Map Salesforce account_id -> ARR as of a specific date based on the ARR schedule:
    - When as_of is None: uses current ARR (open renewals view).
    - When as_of is a date: uses the latest EOD snapshot on or before that date.
    """
    data, _ = await _get_arr_data_for_date(db, as_of)
    rows = data.get("rows") or []
    out: dict[str, float] = {}
    for row in rows:
        aid = row.get("account_id")
        if aid:
            try:
                out[aid] = float(row.get("total_arr") or 0.0)
            except (TypeError, ValueError):
                continue
    return out


class ArrBreakdownPostBody(BaseModel):
    """Admin ARR breakdown: JSON body so proxies cannot drop query params."""

    q: str = Field(min_length=1, max_length=500, description="Substring of Salesforce account name (case-insensitive)")


async def _arr_schedule_breakdown_payload(db: AsyncSession, needle: str) -> dict:
    diagnostic: list = []
    await _compute_active_arr_rows(
        db,
        apply_alleva_retained_arr_adjustment=True,
        diagnostic_account_name_substring=needle.strip(),
        diagnostic_out=diagnostic,
    )
    return {"query": needle.strip(), "match_count": len(diagnostic), "matches": diagnostic, "breakdown_only": True}


@app.post("/api/arr-schedule/arr-breakdown")
async def post_arr_schedule_arr_breakdown(
    body: ArrBreakdownPostBody,
    db: AsyncSession = Depends(get_db),
):
    """Admin: same response as GET active-arr?breakdown_q= (POST avoids caches/proxies dropping query strings)."""
    return await _arr_schedule_breakdown_payload(db, body.q)


@app.get("/api/arr-schedule/active-arr")
async def get_arr_schedule_active_arr(
    breakdown_q: Optional[str] = Query(
        None,
        description=(
            "Admin only: if set, returns only step-by-step Active/Contracted breakdown for accounts "
            "whose name contains this substring (same payload as /api/arr-schedule/schedule-breakdown)."
        ),
    ),
    db: AsyncSession = Depends(get_db),
):
    """
    Active ARR by account. Simplified logic:
    - Regular: Active ARR = ARR of most recent closed-won renewal or new business + expansions since then.
      Subscription start/end from that most recent closed-won renewal or NB opp.
    - If no closed renewal/NB (only an open renewal): note flags it; Active ARR = ARR from that open renewal;
      subscription start = null, subscription end = close date of that open renewal.
    Each row also includes **contracted_arr**: **same schedule rules as Active ARR**, evaluated on a date
    **12 calendar months after today** (America/New_York), with no open-renewal override applied to Contracted.
    Response also includes **crm_seats_live_total** and **contracted_crm_seats_total** (live seats + CRM seats on
    future Closed Won NB/Expansion, same cohort as Products purchased Contracted ARR).
    Classification: Opportunity Record Type (RecordType.Name → o.record_type_name). Overrides applied to Active only. Renewal ARR = open renewal opps only. Delta = Active ARR − Renewal ARR.

    When **breakdown_q** is non-empty, skips the full table and returns only **{ query, match_count, matches }**
    for the Admin ARR breakdown tool (reuses this stable route so proxies/old deploys without schedule-breakdown still work).
    """
    needle = (breakdown_q or "").strip()
    if needle:
        return await _arr_schedule_breakdown_payload(db, needle)
    out_rows, base_url = await _compute_active_arr_rows(db, apply_alleva_retained_arr_adjustment=True)
    out_rows.sort(key=lambda x: -x["active_arr"])
    grand_total = round(sum(r["active_arr"] for r in out_rows), 2)
    live_crm_seats_total = sum(int(r.get("crm_seats") or 0) for r in out_rows)
    today_est = datetime.now(EST).date()
    future_seats, _ = await _future_start_closed_won_nb_exp_crm_seats_by_account(db, today_est)
    contracted_crm_seats_total = int(live_crm_seats_total) + int(future_seats)
    return {
        "rows": out_rows,
        "grand_total": grand_total,
        "crm_seats_live_total": live_crm_seats_total,
        "contracted_crm_seats_total": contracted_crm_seats_total,
        "salesforce_base_url": base_url,
    }


@app.get("/api/arr-schedule/active-arr-by-month")
async def get_arr_schedule_active_arr_by_month(db: AsyncSession = Depends(get_db)):
    """
    Contracted ARR as of the end of every month from end of Dec 2024 through end of Dec 2026.
    For each account, ARR is active in a given month if that month-end falls within the
    subscription term (subscription_start_date .. subscription_end_date).
    Returns: months (YYYY-MM), totals_by_month, and rows (each with by_month: { month_key: arr }).
    """
    out_rows, months, totals_by_month, base_url = await _get_active_arr_by_month_data(db)
    out: dict = {"months": months, "totals_by_month": totals_by_month, "rows": out_rows}
    if base_url:
        out["salesforce_base_url"] = base_url
    return out


@app.get("/api/arr-schedule/new-schedule-accounts")
async def get_new_schedule_accounts(db: AsyncSession = Depends(get_db)):
    """
    Distinct accounts that have **at least one** Closed Won **New Business** opportunity (record type, with
    overrides). Used by the NEW SCHEDULE view: Account name, **type** and **status** from ``Account`` (same as
    Schedule), **subscription_start_date** = ``contract_start_date`` on the **first** such opportunity by
    ``close_date`` (earliest closed-won NB); **subscription_end_date** = latest ``contract_end_date`` among
    closed-won **New Business or Renewal** opportunities — unless there is a **Closed Lost Renewal** with
    ``Midterm_Cancellation__c`` true (``midterm_cancellation`` = 1), in which case use that opportunity’s
    **close_date** (latest if several) instead of contract ends from closed-won opps;     **live_arr** = sum of
    ``ARR__c`` on Closed Won New Business / Renewal / Expansion opps whose contract window contains **today**
    (America/New_York), **unless** there is a Closed Lost Renewal with midterm cancellation whose
    ``contract_end_date`` is **before** today — then **live_arr** = **0**; plus 18-digit SFDC Account Id.
    **contracted_arr** = **live_arr** + sum of ``ARR__c`` on **all** Closed Won opportunities whose
    ``contract_start_date`` is strictly **after** today (America/New_York calendar date).
    **arr_by_month** maps ``YYYY-MM`` (``month_columns``) to the same **Live ARR** definition as **live_arr**,
    evaluated on the **last calendar day** of that month (America/New_York date context): sum of ``ARR__c`` on
    Closed Won New Business / Renewal / Expansion opps whose contract window contains that day, **unless** the
    midterm closed-lost renewal rule zeros ARR for that ``as_of`` date (same as **live_arr** with ``today`` =
    month-end).
    **Bookings owner exclusion** (``BOOKINGS_EXCLUDED_OWNER_NAMES``) does **not** apply anywhere on this endpoint.
    """
    overrides = await _get_record_type_overrides(db)

    def _effective_record_type(o: Opportunity) -> str:
        key = (o.sf_id or "").strip()
        override = overrides.get(key) or (overrides.get(key[:15]) if len(key) >= 15 else None)
        return (override or o.record_type_name or "").strip() or "—"

    def _first_nb_subscription_start_iso(opps: list[Opportunity]) -> str | None:
        """Contract Start Date from the closed-won NB opportunity with the earliest ``close_date`` (nulls last)."""
        if not opps:
            return None

        def sort_key(o: Opportunity) -> tuple:
            cd = o.close_date
            return (cd is None, cd or date.max, (o.sf_id or ""))

        first = sorted(opps, key=sort_key)[0]
        cs = first.contract_start_date
        return cs.isoformat() if cs else None

    def _furthest_nb_renewal_contract_end_iso(opps: list[Opportunity]) -> str | None:
        """Latest ``contract_end_date`` among closed-won NB + Renewal opps (nulls ignored)."""
        ends = [o.contract_end_date for o in opps if o.contract_end_date is not None]
        if not ends:
            return None
        return max(ends).isoformat()

    def _midterm_lost_renewal_close_iso(
        opps: list[Opportunity],
    ) -> str | None:
        """
        Latest ``close_date`` among Closed Lost Renewal opps with ``midterm_cancellation`` = 1
        (``Midterm_Cancellation__c``). None if no qualifying opportunity with a close date.
        Does **not** apply bookings owner exclusion.
        """
        candidates: list[date] = []
        for o in opps:
            if not _is_closed_lost_stage(o.stage_name):
                continue
            if getattr(o, "midterm_cancellation", 0) != 1:
                continue
            if not _is_renewal_record_type(_effective_record_type(o)):
                continue
            if o.close_date is not None:
                candidates.append(o.close_date)
        if not candidates:
            return None
        return max(candidates).isoformat()

    def _live_arr_sum_arr_c_as_of(opps: list[Opportunity], as_of: date) -> float:
        """
        Sum of ``ARR__c`` (``opportunity_arr``) for Closed Won New Business, Renewal, or Expansion opps where
        ``contract_start_date`` and ``contract_end_date`` are set and ``as_of`` lies in that window (inclusive).
        Does **not** apply bookings owner exclusion.
        """
        total = 0.0
        for o in opps:
            if not _is_closed_won_stage(o.stage_name):
                continue
            rt = _effective_record_type(o)
            if not (
                _is_new_business_record_type(rt)
                or _is_renewal_record_type(rt)
                or _is_expansion_record_type(rt)
            ):
                continue
            cs = o.contract_start_date
            ce = o.contract_end_date
            if cs is None or ce is None:
                continue
            if not (cs <= as_of <= ce):
                continue
            if o.opportunity_arr is not None:
                total += float(o.opportunity_arr)
        return round(total, 2)

    def _live_arr_zero_after_midterm_lost_renewal_end(opps: list[Opportunity], as_of: date) -> bool:
        """
        True when **any** Closed Lost **Renewal** with ``midterm_cancellation`` = 1 (Midterm_Cancellation__c) has a
        ``contract_end_date`` and ``as_of`` is **strictly after** that date — Live ARR for the account is **0**
        (overrides the closed-won sum). Does **not** apply bookings owner exclusion.
        """
        for o in opps:
            if not _is_closed_lost_stage(o.stage_name):
                continue
            if getattr(o, "midterm_cancellation", 0) != 1:
                continue
            if not _is_renewal_record_type(_effective_record_type(o)):
                continue
            ce = o.contract_end_date
            if ce is None:
                continue
            if as_of > ce:
                return True
        return False

    def _cw_future_contract_start_arr_sum(opps: list[Opportunity], today: date) -> float:
        """
        Sum of ``Expansion_ARR__c`` (``expansion_arr``) for Closed Won opportunities whose
        ``contract_start_date`` is strictly after ``today``. All record types; does **not** apply
        bookings owner exclusion.
        """
        total = 0.0
        for o in opps:
            if not _is_closed_won_stage(o.stage_name):
                continue
            cs = o.contract_start_date
            if cs is None or cs <= today:
                continue
            val = getattr(o, "expansion_arr", None)
            if val is not None:
                total += float(val)
        return round(total, 2)

    q_cw = select(Opportunity).where(
        or_(
            Opportunity.stage_name.in_(CLOSED_STAGES),
            func.lower(func.trim(Opportunity.stage_name)) == "closed won",
        )
    )
    r = await db.execute(q_cw)
    all_closed_opps = list(r.scalars().all())
    closed_won_opps = [o for o in all_closed_opps if _is_closed_won_stage(o.stage_name)]

    # All accounts with ≥1 Closed Won opp (any record type); NB opps tracked separately for sub_start.
    by_account: dict[str, str] = {}
    nb_opps_by_account: dict[str, list[Opportunity]] = {}
    for o in closed_won_opps:
        aid = (o.account_id or "").strip()
        if not aid:
            continue
        name = (o.account_name or "").strip() or "—"
        if aid not in by_account:
            by_account[aid] = name
        elif by_account[aid] == "—" and name != "—":
            by_account[aid] = name
        if _is_new_business_record_type(_effective_record_type(o)):
            nb_opps_by_account.setdefault(aid, []).append(o)

    nb_renewal_opps_by_account: dict[str, list[Opportunity]] = {}
    for o in closed_won_opps:
        rt = _effective_record_type(o)
        if not (_is_new_business_record_type(rt) or _is_renewal_record_type(rt)):
            continue
        aid = (o.account_id or "").strip()
        if not aid or aid not in by_account:
            continue
        nb_renewal_opps_by_account.setdefault(aid, []).append(o)

    midterm_lost_opps_by_account: dict[str, list[Opportunity]] = {}
    for o in all_closed_opps:
        aid = (o.account_id or "").strip()
        if not aid or aid not in by_account:
            continue
        midterm_lost_opps_by_account.setdefault(aid, []).append(o)

    account_ids_list = list(by_account.keys())
    account_type_map: dict[str, str | None] = {}
    account_status_raw: dict[str, str | None] = {}
    if account_ids_list:
        q_acc = select(Account.sf_id, Account.type, Account.status).where(Account.sf_id.in_(account_ids_list))
        r_acc = await db.execute(q_acc)
        for sf_id, typ, st in r_acc.all():
            account_type_map[sf_id] = typ
            account_status_raw[sf_id] = st

    today_est = datetime.now(EST).date()
    month_keys = _new_schedule_month_keys()
    month_end_dates: dict[str, date] = {}
    for mk in month_keys:
        y, mo = int(mk[:4]), int(mk[5:7])
        _, last_d = calendar.monthrange(y, mo)
        month_end_dates[mk] = date(y, mo, last_d)

    rows: list[dict] = []
    for aid, nm in by_account.items():
        typ = account_type_map.get(aid) if aid else None
        status = (account_status_raw.get(aid) if aid else None) or ""
        status = (status or "").strip() or None
        nb_list = nb_opps_by_account.get(aid) or []
        sub_start = _first_nb_subscription_start_iso(nb_list)
        if sub_start is None:
            # No NB opp: fall back to earliest CW opp of any type
            sub_start = _first_nb_subscription_start_iso(
                [o for o in closed_won_opps if (o.account_id or "").strip() == aid]
            )
        nb_ren_list = nb_renewal_opps_by_account.get(aid) or []
        midterm_iso = _midterm_lost_renewal_close_iso(midterm_lost_opps_by_account.get(aid) or [])
        sub_end = midterm_iso if midterm_iso is not None else _furthest_nb_renewal_contract_end_iso(nb_ren_list)
        account_opps = [o for o in all_closed_opps if (o.account_id or "").strip() == aid]
        live_arr = _live_arr_sum_arr_c_as_of(account_opps, today_est)
        if _live_arr_zero_after_midterm_lost_renewal_end(account_opps, today_est):
            live_arr = 0.0
        future_start_arr = _cw_future_contract_start_arr_sum(account_opps, today_est)
        contracted_arr = round(live_arr + future_start_arr, 2)
        arr_by_month: dict[str, float] = {}
        for mk in month_keys:
            as_of_m = month_end_dates[mk]
            v = _live_arr_sum_arr_c_as_of(account_opps, as_of_m)
            if _live_arr_zero_after_midterm_lost_renewal_end(account_opps, as_of_m):
                v = 0.0
            arr_by_month[mk] = v
        rows.append(
            {
                "account_id": aid,
                "account_name": nm,
                "type": typ,
                "status": status,
                "subscription_start_date": sub_start,
                "subscription_end_date": sub_end,
                "live_arr": live_arr,
                "contracted_arr": contracted_arr,
                "arr_by_month": arr_by_month,
            }
        )
    rows.sort(key=lambda x: (x["account_name"].lower(), x["account_id"]))

    base = os.getenv("SALESFORCE_BASE_URL", "").strip().rstrip("/")
    sf_url = base if base and ("salesforce.com" in base or "lightning.force.com" in base) else None
    return {"rows": rows, "month_columns": month_keys, "salesforce_base_url": sf_url}


async def _build_arr_history_data(db: AsyncSession) -> dict:
    """
    Core data-builder shared by /api/arr-history and /api/arr-cohort-churn.

    Returns dict with keys:
      - ``month_columns``: list[str] of YYYY-MM from Jan 2022 → current month
      - ``rows``: list[{account_name, arr_by_month}]
      - ``sheet_snapshot_as_of``: ISO string or None
      - ``message``: warning string or None
    """
    # ── constants ────────────────────────────────────────────────────────────────
    HIST_RANGE = "ARR_Schedule!A1:ZZ2000"
    HIST_ROW_START = 184   # row 185, 0-indexed
    COL_NAME = 1           # col B = account name
    COL_SF_ID = 2          # col C = 18-digit Salesforce account ID
    COL_AQ = 42            # col AQ = Jan 2022 (0-indexed; A=1…AQ=43 → index 42)
    # col CK = Nov 2025 (0-indexed; CK=89 → index 88). Verified: CK-AQ+1=47 months = Jan22..Nov25 ✓

    # ── 1. Historical months Jan '22 – Nov '25 ───────────────────────────────────
    historical_months: list[str] = []
    _m = date(2022, 1, 1)
    _end_hist = date(2025, 11, 1)
    while _m <= _end_hist:
        historical_months.append(_m.strftime("%Y-%m"))
        _m = date(_m.year + 1, 1, 1) if _m.month == 12 else date(_m.year, _m.month + 1, 1)

    # ── 2. Load sheet snapshot ────────────────────────────────────────────────────
    r_snap = await db.execute(
        select(SheetSnapshot)
        .where(SheetSnapshot.range_name == HIST_RANGE)
        .order_by(SheetSnapshot.as_of.desc())
        .limit(1)
    )
    snap = r_snap.scalar_one_or_none()
    sheet_as_of: Optional[str] = snap.as_of.isoformat() if snap else None

    # Keyed by 18-digit SF account ID where available; fall back to name for rows without an ID.
    sheet_by_sf_id: dict[str, dict[str, float]] = {}   # sf_id  → monthly arr
    sheet_id_to_name: dict[str, str] = {}              # sf_id  → sheet display name
    sheet_by_name_no_id: dict[str, dict[str, float]] = {}  # name → monthly arr (no ID rows)

    if snap and snap.data_json:
        _data = json.loads(snap.data_json)
        for _row in _data[HIST_ROW_START:]:
            if not _row or len(_row) <= COL_NAME:
                continue
            _name = str(_row[COL_NAME]).strip() if len(_row) > COL_NAME else ""
            if not _name:
                continue
            _sf_id_raw = str(_row[COL_SF_ID]).strip() if len(_row) > COL_SF_ID else ""
            # Accept 15- or 18-char alphanumeric SF IDs starting with "001"
            _has_id = len(_sf_id_raw) in (15, 18) and _sf_id_raw.startswith("001")

            _monthly: dict[str, float] = {}
            for _i, _mk in enumerate(historical_months):
                _ci = COL_AQ + _i
                if _ci < len(_row):
                    _v = _to_float_sheet(_row[_ci])
                    if _v is not None and _v != 0.0:
                        _monthly[_mk] = _v

            if not _monthly:
                continue

            if _has_id:
                sheet_id_to_name[_sf_id_raw] = _name
                existing = sheet_by_sf_id.get(_sf_id_raw, {})
                for _mk, _v in _monthly.items():
                    existing[_mk] = round(existing.get(_mk, 0.0) + _v, 2)
                sheet_by_sf_id[_sf_id_raw] = existing
            else:
                # No valid SF ID — fall back to name keying (handles legacy/unnamed rows)
                existing = sheet_by_name_no_id.get(_name, {})
                for _mk, _v in _monthly.items():
                    existing[_mk] = round(existing.get(_mk, 0.0) + _v, 2)
                sheet_by_name_no_id[_name] = existing

    # ── 3. Salesforce months Dec '25 – current month ─────────────────────────────
    today_est = datetime.now(EST).date()
    sf_months: list[str] = []
    _m = date(2025, 12, 1)
    _ceil = date(today_est.year, today_est.month, 1)
    while _m <= _ceil:
        sf_months.append(_m.strftime("%Y-%m"))
        _m = date(_m.year + 1, 1, 1) if _m.month == 12 else date(_m.year, _m.month + 1, 1)

    month_end_dates: dict[str, date] = {}
    for _mk in sf_months:
        _y, _mo = int(_mk[:4]), int(_mk[5:])
        month_end_dates[_mk] = date(_y, _mo, calendar.monthrange(_y, _mo)[1])

    # record-type overrides
    overrides = await _get_record_type_overrides(db)

    def _eff_rt(o: Opportunity) -> str:
        _key = (o.sf_id or "").strip()
        _ov = overrides.get(_key) or (overrides.get(_key[:15]) if len(_key) >= 15 else None)
        return (_ov or o.record_type_name or "").strip()

    # fetch all closed opps (CW + CL needed for midterm-cancellation zero-out)
    _q = select(Opportunity).where(
        or_(
            Opportunity.stage_name.in_(CLOSED_STAGES),
            func.lower(func.trim(Opportunity.stage_name)) == "closed won",
        )
    )
    _r = await db.execute(_q)
    _all_closed = list(_r.scalars().all())

    # group by account_id
    _sf_accounts: dict[str, str] = {}   # account_id -> account_name
    _opps_by_aid: dict[str, list[Opportunity]] = {}
    for _o in _all_closed:
        _aid = (_o.account_id or "").strip()
        if not _aid:
            continue
        if _aid not in _sf_accounts:
            _sf_accounts[_aid] = (_o.account_name or "").strip() or "—"
        _opps_by_aid.setdefault(_aid, []).append(_o)

    def _live_arr_as_of(opps: list[Opportunity], as_of: date) -> float:
        _total = 0.0
        for _o in opps:
            if not _is_closed_won_stage(_o.stage_name):
                continue
            _rt = _eff_rt(_o)
            if not (
                _is_new_business_record_type(_rt)
                or _is_renewal_record_type(_rt)
                or _is_expansion_record_type(_rt)
            ):
                continue
            _cs, _ce = _o.contract_start_date, _o.contract_end_date
            if _cs is None or _ce is None:
                continue
            if not (_cs <= as_of <= _ce):
                continue
            if _o.opportunity_arr is not None:
                _total += float(_o.opportunity_arr)
        return round(_total, 2)

    def _zero_after_midterm(opps: list[Opportunity], as_of: date) -> bool:
        for _o in opps:
            if not _is_closed_lost_stage(_o.stage_name):
                continue
            if getattr(_o, "midterm_cancellation", 0) != 1:
                continue
            if not _is_renewal_record_type(_eff_rt(_o)):
                continue
            _ce = _o.contract_end_date
            if _ce is not None and as_of > _ce:
                return True
        return False

    # compute per account, per SF month — keyed by account_id
    sf_by_id: dict[str, dict[str, float]] = {}   # account_id → monthly arr
    for _aid, _name in _sf_accounts.items():
        _acct_opps = _opps_by_aid.get(_aid, [])
        _monthly: dict[str, float] = {}
        for _mk in sf_months:
            _eom = month_end_dates[_mk]
            _v = _live_arr_as_of(_acct_opps, _eom)
            if _zero_after_midterm(_acct_opps, _eom):
                _v = 0.0
            if _v != 0.0:
                _monthly[_mk] = _v
        if _monthly:
            existing = sf_by_id.get(_aid, {})
            for _mk, _v in _monthly.items():
                existing[_mk] = round(existing.get(_mk, 0.0) + _v, 2)
            sf_by_id[_aid] = existing

    # ── 4. Merge sheet + Salesforce rows by account ID ───────────────────────────
    # Primary key = SF account ID.  SF account name is the canonical display name.
    # Sheet-only rows (churned before Dec '25 with no SF match) use the sheet name.
    rows: list[dict] = []

    # All account IDs that appear in either source
    all_ids: set[str] = set(sheet_by_sf_id.keys()) | set(sf_by_id.keys())
    used_names: set[str] = set()

    for _aid in all_ids:
        _sf_name = _sf_accounts.get(_aid, "")
        _sheet_name = sheet_id_to_name.get(_aid, "")
        # Canonical name: prefer SF name (system of record), fall back to sheet name
        _canon = _sf_name or _sheet_name
        if not _canon:
            continue
        _arr: dict[str, float] = {}
        _arr.update(sheet_by_sf_id.get(_aid, {}))   # historical (Jan 22 – Nov 25)
        _arr.update(sf_by_id.get(_aid, {}))           # Dec 25 onwards
        if _arr:
            rows.append({"account_name": _canon, "arr_by_month": _arr})
            used_names.add(_canon)

    # Sheet rows that had no SF ID — include as-is (legacy / churned accounts)
    for _name, _monthly in sheet_by_name_no_id.items():
        if _name not in used_names:
            rows.append({"account_name": _name, "arr_by_month": _monthly})

    rows.sort(key=lambda r: r["account_name"].lower())

    return {
        "month_columns": historical_months + sf_months,
        "rows": rows,
        "sheet_snapshot_as_of": sheet_as_of,
        "message": (
            None
            if snap
            else "ARR_Schedule sheet snapshot not found. Run 'Refresh app data' to sync it."
        ),
    }


@app.get("/api/arr-history")
async def get_arr_history(db: AsyncSession = Depends(get_db)):
    """
    Historical end-of-month live ARR per account, covering Jan 2022 through the current calendar month.
    Sheet source (Jan 2022 – Nov 2025) + Salesforce source (Dec 2025 onwards).
    """
    data = await _build_arr_history_data(db)
    rows = data["rows"]
    all_months: list[str] = data["month_columns"]
    totals_by_month: dict[str, float] = {
        _mk: round(sum(_r["arr_by_month"].get(_mk, 0.0) for _r in rows), 2)
        for _mk in all_months
    }
    return {
        "month_columns": all_months,
        "rows": rows,
        "totals_by_month": totals_by_month,
        "sheet_snapshot_as_of": data["sheet_snapshot_as_of"],
        "message": data["message"],
    }


@app.get("/api/arr-cohort-churn")
async def get_arr_cohort_churn(db: AsyncSession = Depends(get_db)):
    """
    Monthly cohort ARR retention analysis.

    Each cohort = all accounts whose **first month with ARR > 0** (in the combined sheet+Salesforce
    history) falls in that calendar month.

    For each cohort, tracks total ARR at **Month 0** (the cohort month), **Month 1**, **Month 2**, …
    and expresses each period as a % of Month 0 ARR (NRR-style — can exceed 100% if the cohort expands).

    Useful for reading churn patterns, expansion trends, and cohort quality over time.
    """
    data = await _build_arr_history_data(db)
    rows = data["rows"]
    all_months: list[str] = data["month_columns"]
    month_to_idx: dict[str, int] = {mk: i for i, mk in enumerate(all_months)}

    # ── 1. Assign each account to its cohort (first month with ARR > 0) ──────────
    cohort_accounts: dict[str, list[str]] = {}   # cohort_month -> [account_names]
    arr_lookup: dict[str, dict[str, float]] = {r["account_name"]: r["arr_by_month"] for r in rows}

    for row in rows:
        name = row["account_name"]
        abm = row["arr_by_month"]
        cohort_month: Optional[str] = None
        for mk in all_months:
            if abm.get(mk, 0.0) > 0:
                cohort_month = mk
                break
        if cohort_month is None:
            continue
        cohort_accounts.setdefault(cohort_month, []).append(name)

    # ── 2. Build retention matrix per cohort ─────────────────────────────────────
    result_cohorts: list[dict] = []
    max_offset = 0

    for cohort_month in sorted(cohort_accounts.keys()):
        names = cohort_accounts[cohort_month]
        cohort_idx = month_to_idx[cohort_month]
        num_periods = len(all_months) - cohort_idx

        # Sum ARR for all cohort members at each subsequent month
        monthly_arr: list[float] = []
        for offset in range(num_periods):
            target_mk = all_months[cohort_idx + offset]
            total = round(sum(arr_lookup[n].get(target_mk, 0.0) for n in names), 2)
            monthly_arr.append(total)

        starting_arr = monthly_arr[0] if monthly_arr else 0.0
        max_offset = max(max_offset, num_periods - 1)

        months_list = []
        for offset, arr in enumerate(monthly_arr):
            pct = round(arr / starting_arr * 100, 1) if starting_arr > 0 else None
            months_list.append({
                "offset": offset,
                "arr": arr,
                "pct": pct,
                "calendar_month": all_months[cohort_idx + offset],
            })

        result_cohorts.append({
            "cohort_month": cohort_month,
            "starting_arr": round(starting_arr, 2),
            "account_count": len(names),
            "months": months_list,
        })

    return {
        "cohorts": result_cohorts,
        "max_offset": max_offset,
        "sheet_snapshot_as_of": data["sheet_snapshot_as_of"],
        "message": data["message"],
    }


async def _refresh_monthly_arr_snapshot(db: AsyncSession) -> dict:
    """
    Full-replace of ``monthly_arr_snapshots``.
    Called at the end of every dataset refresh so the table stays current.
    """
    from sqlalchemy import delete as _sa_delete
    try:
        data = await _build_arr_history_data(db)
        rows = data["rows"]
        await db.execute(_sa_delete(MonthlyArrSnapshot))
        new_rows = [
            MonthlyArrSnapshot(account_name=row["account_name"], month_key=mk, arr=arr)
            for row in rows
            for mk, arr in row["arr_by_month"].items()
            if arr and arr != 0.0
        ]
        db.add_all(new_rows)
        await db.commit()
        return {"ok": True, "rows_written": len(new_rows)}
    except Exception as e:
        await db.rollback()
        return {"ok": False, "error": str(e)[:200]}


def _mk_offset(mk: str, months: int) -> str:
    """Return the YYYY-MM key that is ``months`` calendar months before (negative) or after (positive) ``mk``."""
    y, mo = int(mk[:4]), int(mk[5:])
    total = y * 12 + (mo - 1) + months
    return f"{total // 12}-{(total % 12) + 1:02d}"


# ── Forecast weights ─────────────────────────────────────────────────────────
_FC_NB_EXP_WEIGHTS: dict[str, float] = {
    "Commit":     0.90,
    "Best Case":  0.60,
    "Upside":     0.25,
}
_TIER_WEIGHTS: dict[str, float] = {
    "tier 1": 0.90,
    "tier 2": 0.50,
    "tier 3": 0.25,
    "tier 4": 0.10,
}
_FC_RENEWAL_WEIGHTS: dict[str, float] = {
    "Commit":           0.90,
    "Best Case":        0.70,
    "Positive Outlook": 0.90,
    "Neutral":          0.70,
    "At Risk":          0.10,
    "Intent to Churn":  0.00,
}

# Sheet target config: Jan 2026 = column index 72 (BU)
_FORECAST_SHEET_RANGE  = "ARR_Calculations_2026P!A1:ZZ1000"
_FORECAST_COL_JAN2026  = 72   # BU = 0-indexed (column BU = Jan 2026)
_FORECAST_ROW_NB         = 10  # row 11 (1-indexed) = New Business ARR target
_FORECAST_ROW_EXP        = 11  # row 12 (1-indexed) = Expansion ARR target
_FORECAST_ROW_RENEW_RATE = 51  # row 52 (1-indexed) = ARR renewal rate target

# Number of historical quarters to average for in-quarter pipeline estimate
_IQ_LOOKBACK_QUARTERS = 6


def _quarter_bounds(year: int, q: int) -> tuple[date, date]:
    """Return (first_day, last_day) for the given quarter."""
    start_month = (q - 1) * 3 + 1
    end_month = start_month + 2
    last_day = calendar.monthrange(year, end_month)[1]
    return date(year, start_month, 1), date(year, end_month, last_day)


async def _compute_in_quarter_rates(db: AsyncSession) -> dict:
    """Compute average historical in-quarter pipeline contribution per month-of-quarter position.

    For each past quarter (up to _IQ_LOOKBACK_QUARTERS), calculate:
      - Total closed won NB ARR that closed in month M of the quarter AND was created in the same quarter
      - Same for Expansion

    Returns:
      {
        "nb":  [avg_m1, avg_m2, avg_m3],   # absolute ARR, not rates
        "exp": [avg_m1, avg_m2, avg_m3],
        "quarters_used": N,
      }
    """
    today = datetime.now(EST).date()
    # Current quarter — exclude it (partial, biases the estimate)
    cur_q = (today.month - 1) // 3 + 1
    cur_q_start, _ = _quarter_bounds(today.year, cur_q)

    # Load all closed won NB + Expansion opps with both dates
    result = await db.execute(select(Opportunity))
    all_opps: list[Opportunity] = list(result.scalars().all())
    rt_overrides = await _get_record_type_overrides(db)

    def _eff_rt_iq(o: Opportunity) -> str:
        _key = (o.sf_id or "").strip()
        _ov = rt_overrides.get(_key) or (rt_overrides.get(_key[:15]) if len(_key) >= 15 else None)
        return (_ov or o.record_type_name or "").strip()

    closed_opps = [
        o for o in all_opps
        if _is_closed_won_stage(o.stage_name)
        and o.close_date is not None
        and o.created_date is not None
        and not _is_renewal_record_type(_eff_rt_iq(o))
        and o.close_date < cur_q_start  # completed quarters only
    ]

    from collections import defaultdict
    buckets: dict[tuple, dict] = defaultdict(lambda: {"nb": 0.0, "exp": 0.0})

    for o in closed_opps:
        cd = o.close_date  # type: ignore[assignment]
        q = (cd.month - 1) // 3 + 1
        q_start, _ = _quarter_bounds(cd.year, q)
        month_pos = (cd.month - q_start.month)  # 0, 1, or 2

        created = o.created_date.date() if hasattr(o.created_date, "date") else o.created_date  # type: ignore[union-attr]
        _q_end = _quarter_bounds(q_start.year, q)[1]
        if not (q_start <= created <= _q_end):
            continue  # not in-quarter

        rt = _eff_rt_iq(o)
        if _is_new_business_record_type(rt):
            arr = max(0.0, float(o.opportunity_arr or 0))
            buckets[(cd.year, q, month_pos)]["nb"] += arr
        elif _is_expansion_record_type(rt) or _is_amendment_record_type(rt):
            arr = _booking_arr_expansion_or_arr_c(o)
            buckets[(cd.year, q, month_pos)]["exp"] += arr

    # Group by quarter, collect per-month-position values
    quarters_seen: set[tuple[int, int]] = set()
    for (yr, q, _mp) in buckets:
        quarters_seen.add((yr, q))

    # Sort quarters descending, take up to _IQ_LOOKBACK_QUARTERS
    sorted_quarters = sorted(quarters_seen, reverse=True)[:_IQ_LOOKBACK_QUARTERS]
    if not sorted_quarters:
        return {"nb": [0.0, 0.0, 0.0], "exp": [0.0, 0.0, 0.0], "quarters_used": 0}

    nb_by_pos: dict[int, list[float]] = {0: [], 1: [], 2: []}
    exp_by_pos: dict[int, list[float]] = {0: [], 1: [], 2: []}

    for (yr, q) in sorted_quarters:
        for pos in range(3):
            key = (yr, q, pos)
            nb_by_pos[pos].append(buckets[key]["nb"])
            exp_by_pos[pos].append(buckets[key]["exp"])

    def _avg(vals: list[float]) -> float:
        return round(sum(vals) / len(vals), 2) if vals else 0.0

    return {
        "nb":  [_avg(nb_by_pos[0]),  _avg(nb_by_pos[1]),  _avg(nb_by_pos[2])],
        "exp": [_avg(exp_by_pos[0]), _avg(exp_by_pos[1]), _avg(exp_by_pos[2])],
        "quarters_used": len(sorted_quarters),
    }


@app.get("/api/forecast/current-quarter")
async def get_forecast_current_quarter(db: AsyncSession = Depends(get_db)):
    """
    Quarter forecast for Bookings (NB + Expansion) and Renewals.
    Actuals = Closed Won opps.  Pipeline = open opps weighted by Forecast__c.
    Targets from ARR_Calculations_2026P sheet.
    """
    today_est = datetime.now(EST).date()
    q_start_mo = ((today_est.month - 1) // 3) * 3 + 1
    q_year = today_est.year
    months: list[str] = [
        f"{q_year}-{(q_start_mo + i):02d}" for i in range(3)
    ]
    q_label = f"Q{(q_start_mo - 1) // 3 + 1} '{str(q_year)[2:]}"

    def _mk_to_date_range(mk: str) -> tuple[date, date]:
        y, m = int(mk[:4]), int(mk[5:])
        return date(y, m, 1), date(y, m, calendar.monthrange(y, m)[1])

    # ── fetch all opps ──────────────────────────────────────────────────────
    _q = select(Opportunity)
    _r = await db.execute(_q)
    all_opps: list[Opportunity] = list(_r.scalars().all())

    overrides = await _get_record_type_overrides(db)

    def _eff_rt(o: Opportunity) -> str:
        _key = (o.sf_id or "").strip()
        _ov = overrides.get(_key) or (overrides.get(_key[:15]) if len(_key) >= 15 else None)
        return (_ov or o.record_type_name or "").strip()

    def _booking_arr(o: Opportunity) -> float:
        """Booking ARR for closed won opps — matches _closed_overview_arr_from_opportunity."""
        rt = _eff_rt(o)
        if _is_renewal_record_type(rt) or _is_amendment_record_type(rt) or _is_expansion_record_type(rt):
            return _booking_arr_expansion_or_arr_c(o)
        if _is_new_business_record_type(rt):
            return max(0.0, float(o.opportunity_arr or 0))
        return 0.0

    # Build line-item ARR map for all open opps (same logic as pipeline overview)
    open_sf_ids = {
        o.sf_id for o in all_opps
        if not _is_closed_won_stage(o.stage_name)
        and not _is_closed_lost_stage(o.stage_name)
        and o.sf_id
    }
    opp_to_line_arr = await _line_item_arr_for_opportunities(db, open_sf_ids)

    def _pipeline_arr(o: Opportunity) -> float:
        """Pipeline ARR — MRR×multiplier when set, else line-item ARR. Matches pipeline-overview."""
        if o.mrr is not None and o.mrr != 0:
            return round(float(o.mrr) * PIPELINE_ARR_MULTIPLIER, 2)
        return opp_to_line_arr.get(o.sf_id, 0.0)

    def _weighted(o: Opportunity, weights: dict[str, float]) -> float:
        fc = (o.forecast_category or "").strip()
        w = weights.get(fc, 0.0)
        return _pipeline_arr(o) * w

    # ── sheet targets ────────────────────────────────────────────────────────
    snap_r = await db.execute(
        select(SheetSnapshot)
        .where(SheetSnapshot.range_name == _FORECAST_SHEET_RANGE)
        .order_by(SheetSnapshot.as_of.desc())
        .limit(1)
    )
    snap = snap_r.scalar_one_or_none()
    sheet_data = json.loads(snap.data_json) if snap and snap.data_json else []

    def _sheet_target(row_idx: int, mk: str) -> Optional[float]:
        if not sheet_data:
            return None
        y, m = int(mk[:4]), int(mk[5:])
        # Months since Jan 2026
        col = _FORECAST_COL_JAN2026 + (y - 2026) * 12 + (m - 1)
        row = sheet_data[row_idx] if row_idx < len(sheet_data) else []
        v = row[col] if col < len(row) else None
        return _to_float_sheet(v)

    # ── load latest AI scores for pipeline weighting ─────────────────────────
    latest_ai_at_r = await db.execute(select(func.max(DealAIScore.scored_at)))
    latest_ai_at = latest_ai_at_r.scalar_one_or_none()
    ai_prob_map: dict[str, float] = {}
    if latest_ai_at:
        ai_scores_r = await db.execute(
            select(DealAIScore).where(DealAIScore.scored_at == latest_ai_at)
        )
        for s in ai_scores_r.scalars().all():
            ai_prob_map[s.sf_opp_id] = s.probability

    def _ai_weighted(o: Opportunity, weights: dict[str, float]) -> float:
        """ARR × AI probability if scored, else fall back to Forecast__c categorical weight."""
        sf_id = o.sf_id or ""
        if sf_id in ai_prob_map:
            return _pipeline_arr(o) * ai_prob_map[sf_id]
        fc = (o.forecast_category or "").strip()
        return _pipeline_arr(o) * weights.get(fc, 0.0)

    def _tier_weighted(o: Opportunity, fc_weights: dict[str, float]) -> float:
        """ARR × tier floor probability; falls back to Forecast__c weight when no tier is set."""
        tier = (o.deal_tier or "").lower()
        for key, prob in _TIER_WEIGHTS.items():
            if key in tier:
                return _pipeline_arr(o) * prob
        fc = (o.forecast_category or "").strip()
        return _pipeline_arr(o) * fc_weights.get(fc, 0.0)

    # ── in-quarter pipeline estimate ─────────────────────────────────────────
    iq_rates = await _compute_in_quarter_rates(db)
    # month_pos: 0=first month of quarter, 1=second, 2=third
    q_start_mk = months[0]

    def _iq_est(rates_list: list, mk: str, actuals: float, pipe_weighted: float) -> float:
        """Expected additional ARR from deals yet to enter the pipeline this quarter.
        Only applied to future months or to the portion of current month not yet captured.
        For months where we have substantial actuals+pipeline vs. the historical average,
        we floor at 0 (no double-counting)."""
        pos = months.index(mk)
        hist_avg = rates_list[pos]
        already_captured = actuals + pipe_weighted
        # In-quarter estimate = max(0, historical average - what's already captured)
        return max(0.0, round(hist_avg - already_captured, 2))

    # ── build per-month data ─────────────────────────────────────────────────
    nb_months, exp_months, renewal_months = [], [], []

    for mk in months:
        d_start, d_end = _mk_to_date_range(mk)
        is_current = mk == today_est.strftime("%Y-%m")
        # For current month, actuals run up to today; for past months use full month
        actuals_end = today_est if is_current else d_end

        # ── New Business ──────────────────────────────────────────────────
        # Use same logic as _closed_won_arr_in_range for consistency with bookings view
        _nb_total, nb_actual, _nb_exp = await _closed_won_arr_in_range(db, d_start, actuals_end)

        nb_open = [
            o for o in all_opps
            if not _is_closed_won_stage(o.stage_name)
            and not _is_closed_lost_stage(o.stage_name)
            and _is_new_business_record_type(_eff_rt(o))
            and not _is_excluded_from_bookings_nb_only(o, _eff_rt(o))
            and o.close_date and d_start <= o.close_date <= d_end
        ]
        nb_pipe_weighted      = sum(_weighted(o, _FC_NB_EXP_WEIGHTS) for o in nb_open)
        nb_pipe_ai_weighted   = sum(_ai_weighted(o, _FC_NB_EXP_WEIGHTS) for o in nb_open)
        nb_pipe_tier_weighted = sum(_tier_weighted(o, _FC_NB_EXP_WEIGHTS) for o in nb_open)
        nb_pipe_raw           = sum(_pipeline_arr(o) for o in nb_open)

        nb_forecast_val      = round(nb_actual + nb_pipe_weighted, 2)
        nb_forecast_ai_val   = round(nb_actual + nb_pipe_ai_weighted, 2)
        nb_iq = _iq_est(iq_rates["nb"], mk, nb_actual, nb_pipe_ai_weighted)
        nb_forecast_tier_val = round(nb_actual + nb_pipe_tier_weighted + nb_iq, 2)
        nb_months.append({
            "month": mk,
            "actuals": round(nb_actual, 2),
            "pipeline_weighted": round(nb_pipe_weighted, 2),
            "pipeline_ai_weighted": round(nb_pipe_ai_weighted, 2),
            "pipeline_tier_weighted": round(nb_pipe_tier_weighted, 2),
            "pipeline_raw": round(nb_pipe_raw, 2),
            "forecast": nb_forecast_val,
            "forecast_ai": nb_forecast_ai_val,
            "forecast_tier": nb_forecast_tier_val,
            "in_quarter_est": nb_iq,
            "adjusted_forecast": round(nb_forecast_ai_val + nb_iq, 2),
            "target": _sheet_target(_FORECAST_ROW_NB, mk),
            "has_ai_scores": len(ai_prob_map) > 0,
        })

        # ── Expansion ─────────────────────────────────────────────────────
        # _closed_won_arr_in_range returns (total, nb, expansion_mid_term)
        # Expansion "upon renewal" is separate; match bookings view by adding both
        _exp_total, _exp_nb, exp_mid = await _closed_won_arr_in_range(db, d_start, actuals_end)
        exp_upon_renewal = await _closed_won_renewal_expansion_arr_in_range(db, d_start, actuals_end)
        exp_actual = round(exp_mid + exp_upon_renewal, 2)

        exp_open = [
            o for o in all_opps
            if not _is_closed_won_stage(o.stage_name)
            and not _is_closed_lost_stage(o.stage_name)
            and _is_expansion_record_type(_eff_rt(o))
            and o.close_date and d_start <= o.close_date <= d_end
        ]
        exp_pipe_weighted      = sum(_weighted(o, _FC_NB_EXP_WEIGHTS) for o in exp_open)
        exp_pipe_ai_weighted   = sum(_ai_weighted(o, _FC_NB_EXP_WEIGHTS) for o in exp_open)
        exp_pipe_tier_weighted = sum(_tier_weighted(o, _FC_NB_EXP_WEIGHTS) for o in exp_open)
        exp_pipe_raw           = sum(_pipeline_arr(o) for o in exp_open)

        exp_forecast_val      = round(exp_actual + exp_pipe_weighted, 2)
        exp_forecast_ai_val   = round(exp_actual + exp_pipe_ai_weighted, 2)
        exp_iq = _iq_est(iq_rates["exp"], mk, exp_actual, exp_pipe_ai_weighted)
        exp_forecast_tier_val = round(exp_actual + exp_pipe_tier_weighted + exp_iq, 2)
        exp_months.append({
            "month": mk,
            "actuals": round(exp_actual, 2),
            "pipeline_weighted": round(exp_pipe_weighted, 2),
            "pipeline_ai_weighted": round(exp_pipe_ai_weighted, 2),
            "pipeline_tier_weighted": round(exp_pipe_tier_weighted, 2),
            "pipeline_raw": round(exp_pipe_raw, 2),
            "forecast": exp_forecast_val,
            "forecast_ai": exp_forecast_ai_val,
            "forecast_tier": exp_forecast_tier_val,
            "in_quarter_est": exp_iq,
            "adjusted_forecast": round(exp_forecast_ai_val + exp_iq, 2),
            "target": _sheet_target(_FORECAST_ROW_EXP, mk),
            "has_ai_scores": len(ai_prob_map) > 0,
        })

        # ── Renewals ──────────────────────────────────────────────────────
        # Use _aggregate_renewals_actuals for actuals (matches dashboard exactly).
        # Pipeline weights original_acv (same unit as UFR).

        # All renewal opps for record-type override + exclusion already applied via _eff_rt
        renewal_opps_all = [
            o for o in all_opps
            if _is_renewal_record_type(_eff_rt(o))
        ]

        # Full month UFR — all renewal opps whose renewal_date falls this month
        ufr_full, _, _, _, _, _, _ = _aggregate_renewals_actuals(
            renewal_opps_all,
            lambda rd: d_start <= rd <= d_end,
        )
        due_arr = ufr_full

        # Actuals: CW/CL renewal opps bucketed to this month by renewal_date,
        # but use close_date <= actuals_end so already-closed deals count even if
        # their renewal_date is later in the month (e.g. renewal_date=Apr 15, close_date=Mar 27).
        actuals_opps = [
            o for o in renewal_opps_all
            if _is_renewal_effective_date_in_range(o, d_start, d_end)
            and getattr(o, "midterm_cancellation", 0) != 1
            and (_is_closed_won_stage(o.stage_name) or _is_closed_lost_stage(o.stage_name))
            and (o.close_date is None or o.close_date <= actuals_end)
        ]
        ufr_closed = sum(float(o.original_acv or 0) for o in actuals_opps)
        churn_a_val = sum(float(o.original_acv or 0) for o in actuals_opps if _is_closed_lost_stage(o.stage_name))
        contr_a_val = sum(
            max(0.0, float(o.original_acv or 0) - float(o.opportunity_arr or 0))
            for o in actuals_opps
            if _is_closed_won_stage(o.stage_name)
            and float(o.opportunity_arr or 0) < float(o.original_acv or 0)
        )
        won_arr = round(max(0.0, ufr_closed - churn_a_val - contr_a_val), 2)
        # Use full-month UFR as denominator so partial-month rates aren't inflated
        # (e.g. 1 closed deal that renewed = 100% is misleading; use total due instead)
        rate_a = round(won_arr / due_arr, 6) if due_arr > 0 else None

        # Open pipeline for this month, weighted by Forecast__c using original_acv
        renew_open = [
            o for o in renewal_opps_all
            if not _is_closed_won_stage(o.stage_name)
            and not _is_closed_lost_stage(o.stage_name)
            and getattr(o, "midterm_cancellation", 0) != 1
            and _is_renewal_effective_date_in_range(o, d_start, d_end)
        ]
        def _renew_weighted(o: Opportunity) -> float:
            fc = (o.forecast_category or "").strip()
            w = _FC_RENEWAL_WEIGHTS.get(fc, 0.0)
            return float(o.original_acv or 0) * w

        renew_pipe_weighted = sum(_renew_weighted(o) for o in renew_open)
        renew_pipe_raw      = sum(float(o.original_acv or 0) for o in renew_open)
        forecast_arr = round(won_arr + renew_pipe_weighted, 2)
        # rate_actual: use _aggregate result (denominator = closed UFR only, matching dashboard)
        rate_actual   = round(rate_a * 100, 1) if rate_a is not None else None
        # rate_forecast: (won + weighted pipeline) / full month UFR
        rate_forecast = round(forecast_arr / due_arr * 100, 1) if due_arr > 0 else None
        rate_target_raw = _sheet_target(_FORECAST_ROW_RENEW_RATE, mk)
        rate_target   = round(rate_target_raw * 100, 1) if rate_target_raw is not None else None
        renewal_months.append({
            "month": mk,
            "due_arr": round(due_arr, 2),
            "won_arr": round(won_arr, 2),
            "pipeline_weighted": round(renew_pipe_weighted, 2),
            "pipeline_raw": round(renew_pipe_raw, 2),
            "forecast_arr": forecast_arr,
            "rate_actual": rate_actual,
            "rate_forecast": rate_forecast,
            "rate_target": rate_target,
        })

    # ── quarter totals ───────────────────────────────────────────────────────
    def _sum(arr: list[dict], key: str) -> float:
        return round(sum(m[key] for m in arr if m[key] is not None), 2)

    def _avg(arr: list[dict], key: str) -> Optional[float]:
        vals = [m[key] for m in arr if m[key] is not None]
        return round(sum(vals) / len(vals), 1) if vals else None

    base = os.getenv("SALESFORCE_BASE_URL", "").strip().rstrip("/")
    ai_backtest = await _compute_ai_backtest_against_snapshots(db)
    return {
        "quarter": q_label,
        "months": months,
        "new_business": nb_months,
        "expansion": exp_months,
        "renewals": renewal_months,
        "ai_backtest": ai_backtest,
        "quarter_totals": {
            "nb_actuals":              _sum(nb_months,  "actuals"),
            "nb_forecast":             _sum(nb_months,  "forecast"),
            "nb_forecast_ai":          _sum(nb_months,  "forecast_ai"),
            "nb_forecast_tier":        _sum(nb_months,  "forecast_tier"),
            "nb_in_quarter_est":       _sum(nb_months,  "in_quarter_est"),
            "nb_adjusted_forecast":    _sum(nb_months,  "adjusted_forecast"),
            "nb_target":               _sum(nb_months,  "target") if all(m["target"] for m in nb_months) else None,
            "exp_actuals":             _sum(exp_months, "actuals"),
            "exp_forecast":            _sum(exp_months, "forecast"),
            "exp_forecast_ai":         _sum(exp_months, "forecast_ai"),
            "exp_forecast_tier":       _sum(exp_months, "forecast_tier"),
            "exp_in_quarter_est":      _sum(exp_months, "in_quarter_est"),
            "exp_adjusted_forecast":   _sum(exp_months, "adjusted_forecast"),
            "exp_target":              _sum(exp_months, "target") if all(m["target"] for m in exp_months) else None,
            "total_actuals":           round(_sum(nb_months, "actuals") + _sum(exp_months, "actuals"), 2),
            "total_forecast":          round(_sum(nb_months, "forecast") + _sum(exp_months, "forecast"), 2),
            "total_forecast_ai":       round(_sum(nb_months, "forecast_ai") + _sum(exp_months, "forecast_ai"), 2),
            "total_forecast_tier":     round(_sum(nb_months, "forecast_tier") + _sum(exp_months, "forecast_tier"), 2),
            "total_in_quarter_est":    round(_sum(nb_months, "in_quarter_est") + _sum(exp_months, "in_quarter_est"), 2),
            "total_adjusted_forecast": round(_sum(nb_months, "adjusted_forecast") + _sum(exp_months, "adjusted_forecast"), 2),
            "has_ai_scores":           len(ai_prob_map) > 0,
            "renewal_due":           _sum(renewal_months, "due_arr"),
            "renewal_won":           _sum(renewal_months, "won_arr"),
            "renewal_forecast":      _sum(renewal_months, "forecast_arr"),
            "rate_actual":           _avg(renewal_months, "rate_actual"),
            "rate_forecast":         _avg(renewal_months, "rate_forecast"),
            "rate_target":           _avg(renewal_months, "rate_target"),
        },
        "in_quarter_quarters_used": iq_rates["quarters_used"],
        "salesforce_base_url": base or None,
    }


@app.get("/api/forecast/ai-current-quarter")
async def get_ai_forecast_current_quarter(db: AsyncSession = Depends(get_db)):
    """
    AI-powered deal forecast for the current quarter.
    Uses LLM-generated win-probability scores (DealAIScore) to compute a per-month and quarterly
    AI forecast for NB + Expansion opportunities. Complements the weighted-pipeline forecast.
    Returns last_scored_at so the UI can show data freshness.
    Returns empty scores if no AI scoring has run yet (ENABLE_AI_FORECAST_SCORING=1 in .env).
    """
    now_est = datetime.now(EST)
    q_num = (now_est.month - 1) // 3 + 1
    q_start_month = (q_num - 1) * 3 + 1
    months = [
        f"{now_est.year}-{str(q_start_month + i).zfill(2)}"
        for i in range(3)
    ]
    q_label = f"Q{q_num} '{str(now_est.year)[2:]}"

    # ── Latest DealAIScore per opportunity (most recent scored_at) ─────────────
    latest_scored_at_r = await db.execute(
        select(func.max(DealAIScore.scored_at))
    )
    last_scored_at = latest_scored_at_r.scalar_one_or_none()

    scores_map: dict[str, DealAIScore] = {}
    observations: list[str] = []
    if last_scored_at is not None:
        # Get scores from the most recent scoring run
        scores_r = await db.execute(
            select(DealAIScore).where(DealAIScore.scored_at == last_scored_at)
        )
        for s in scores_r.scalars().all():
            scores_map[s.sf_opp_id] = s
        # Load observations for this run
        try:
            obs_r = await db.execute(
                select(AIForecastObservations).where(AIForecastObservations.scored_at == last_scored_at)
            )
            obs_row = obs_r.scalars().first()
            if obs_row and obs_row.observations_json:
                import json as _json_obs
                observations = _json_obs.loads(obs_row.observations_json)
        except Exception:
            pass

    # ── Load open NB + Expansion opportunities ────────────────────────────────
    result = await db.execute(select(Opportunity))
    all_opps: list[Opportunity] = list(result.scalars().all())
    rt_overrides = await _get_record_type_overrides(db)

    def _eff_rt_ai_fcst(o: Opportunity) -> str:
        _key = (o.sf_id or "").strip()
        _ov = rt_overrides.get(_key) or (rt_overrides.get(_key[:15]) if len(_key) >= 15 else None)
        return (_ov or o.record_type_name or "").strip()

    # Use the same NB+Expansion filters as get_forecast_current_quarter so numbers align exactly
    open_sf_ids_fcst = {
        o.sf_id for o in all_opps
        if not _is_closed_won_stage(o.stage_name)
        and not _is_closed_lost_stage(o.stage_name)
        and o.sf_id
    }
    opp_to_line_arr_fcst = await _line_item_arr_for_opportunities(db, open_sf_ids_fcst)

    def _pipeline_arr(o: Opportunity) -> float:
        if o.mrr is not None and o.mrr != 0:
            return round(float(o.mrr) * PIPELINE_ARR_MULTIPLIER, 2)
        return opp_to_line_arr_fcst.get(o.sf_id, 0.0)

    def _tomonthkey(d: Optional[date]) -> Optional[str]:
        if not d:
            return None
        return f"{d.year}-{str(d.month).zfill(2)}"

    # ── Per-month roll-up — same NB+Exp filters as main forecast endpoint ─────
    month_data = []
    for mk in months:
        y, m_int = int(mk[:4]), int(mk[5:])
        import calendar as _cal
        d_start = date(y, m_int, 1)
        d_end = date(y, m_int, _cal.monthrange(y, m_int)[1])

        nb_opps_m = [
            o for o in all_opps
            if not _is_closed_won_stage(o.stage_name)
            and not _is_closed_lost_stage(o.stage_name)
            and _is_new_business_record_type(_eff_rt_ai_fcst(o))
            and not _is_excluded_from_bookings_nb_only(o, _eff_rt_ai_fcst(o))
            and o.close_date and d_start <= o.close_date <= d_end
        ]
        exp_opps_m = [
            o for o in all_opps
            if not _is_closed_won_stage(o.stage_name)
            and not _is_closed_lost_stage(o.stage_name)
            and _is_expansion_record_type(_eff_rt_ai_fcst(o))
            and o.close_date and d_start <= o.close_date <= d_end
        ]
        month_opps = nb_opps_m + exp_opps_m

        ai_forecast = 0.0
        top_deals = []
        for o in month_opps:
            arr = _pipeline_arr(o)
            score = scores_map.get(o.sf_id or "")
            prob = score.probability if score else None
            # Mirror _ai_weighted from main forecast: use AI prob if scored, else Forecast__c fallback
            if prob is not None:
                effective_weight = prob
            else:
                fc = (o.forecast_category or "").strip()
                effective_weight = _FC_NB_EXP_WEIGHTS.get(fc, 0.0)
            ai_contribution = arr * effective_weight
            ai_forecast += ai_contribution
            top_deals.append({
                "sf_opp_id": o.sf_id,
                "account_name": o.account_name,
                "opportunity_name": o.name,
                "arr": round(arr, 0),
                "probability": round(prob, 3) if prob is not None else None,
                "effective_weight": round(effective_weight, 3),
                "ai_contribution": round(ai_contribution, 0),
                "reasoning": score.reasoning if score else None,
                "stage": o.stage_name,
                "forecast_category": o.forecast_category,
                "record_type": _eff_rt_ai_fcst(o),
            })
        top_deals.sort(key=lambda x: -(x["arr"] or 0))
        month_data.append({
            "month": mk,
            "ai_forecast": round(ai_forecast, 2),
            "deal_count": len(month_opps),
            "scored_deal_count": sum(1 for d in top_deals if d["probability"] is not None),
            "top_deals": top_deals[:10],
        })

    total_ai_forecast = sum(m["ai_forecast"] for m in month_data)

    base = os.getenv("SALESFORCE_BASE_URL", "").strip().rstrip("/")
    return {
        "quarter": q_label,
        "months": months,
        "month_data": month_data,
        "total_ai_forecast": round(total_ai_forecast, 2),
        "last_scored_at": last_scored_at.isoformat() if last_scored_at else None,
        "total_scored_deals": len(scores_map),
        "salesforce_base_url": base or None,
        "observations": observations,
    }


@app.post("/api/forecast/snapshot")
async def post_forecast_snapshot(db: AsyncSession = Depends(get_db)):
    """Save a forecast snapshot for today. Called automatically on 1st of each month by the scheduler.
    Can also be triggered on-demand via this endpoint."""
    saved = await _take_forecast_snapshot(db)
    await db.commit()
    return {"ok": True, "months_saved": saved, "snapshot_date": datetime.now(EST).date().isoformat()}


@app.get("/api/forecast/observations")
async def get_forecast_observations(
    type: str = "forecast",
    db: AsyncSession = Depends(get_db),
):
    """Return the most recent AI observations. type='forecast' (default) or 'pipeline'."""
    import json as _json_obs2

    # Most recent scoring run timestamp (regardless of observation type)
    last_score_row = (await db.execute(
        select(DealAIScore.scored_at).order_by(DealAIScore.scored_at.desc()).limit(1)
    )).scalar_one_or_none()
    last_ai_run_at = last_score_row.isoformat() if last_score_row else None

    row = (await db.execute(
        select(AIForecastObservations)
        .where(AIForecastObservations.obs_type == type)
        .order_by(AIForecastObservations.scored_at.desc())
        .limit(1)
    )).scalars().first()
    if not row:
        return {
            "observations": [],
            "scored_at": None,
            "quarter_label": None,
            "obs_type": type,
            "last_ai_run_at": last_ai_run_at,
        }
    obs = []
    if row.observations_json:
        try:
            obs = _json_obs2.loads(row.observations_json)
        except Exception:
            obs = []
    return {
        "observations": obs,
        "scored_at": row.scored_at.isoformat() if row.scored_at else None,
        "quarter_label": row.quarter_label,
        "obs_type": type,
        "last_ai_run_at": last_ai_run_at,
    }


def _earliest_backtest_snapshot_for_month(month_snaps: list[ForecastSnapshot]) -> Optional[ForecastSnapshot]:
    """Chronological first snapshot; prefer the first with total_ai_adjusted_forecast (matches UI Forecast (AI))."""
    if not month_snaps:
        return None
    sn = sorted(month_snaps, key=lambda s: s.snapshot_date)
    for s in sn:
        if s.total_ai_adjusted_forecast is not None:
            return s
    return sn[0]


async def _bookings_total_closed_won_for_month(
    db: AsyncSession, d_start: date, actuals_end: date
) -> tuple[float, float, float]:
    """NB ARR, Expansion ARR (incl. upon-renewal), and total — same as forecast `current-quarter` actuals."""
    _total, nb_actual, _exp = await _closed_won_arr_in_range(db, d_start, actuals_end)
    _exp_total, _nb2, exp_mid = await _closed_won_arr_in_range(db, d_start, actuals_end)
    exp_upon = await _closed_won_renewal_expansion_arr_in_range(db, d_start, actuals_end)
    exp_actual = round(exp_mid + exp_upon, 2)
    return round(nb_actual, 2), exp_actual, round(nb_actual + exp_actual, 2)


async def _compute_ai_backtest_against_snapshots(db: AsyncSession) -> dict:
    """
    For each completed month: earliest DB snapshot with total_ai_adjusted_forecast (when present)
    vs final Closed Won NB+Expansion. Used for deal-level LLM calibration and Current Quarter UI.
    """
    today = datetime.now(EST).date()
    snaps_r = await db.execute(select(ForecastSnapshot).order_by(ForecastSnapshot.snapshot_date))
    all_snaps: list[ForecastSnapshot] = list(snaps_r.scalars().all())
    if not all_snaps:
        return {"n": 0, "mean_signed_error_pct": None, "mean_abs_error_pct": None, "rows": []}
    by_t: dict[str, list[ForecastSnapshot]] = {}
    for s in all_snaps:
        by_t.setdefault(s.target_month, []).append(s)
    completed: list[str] = []
    for mk in by_t:
        y, m = int(mk[:4]), int(mk[5:])
        d_e = date(y, m, calendar.monthrange(y, m)[1])
        if d_e < today:
            completed.append(mk)
    completed.sort(reverse=True)
    signed: list[float] = []
    abs_e: list[float] = []
    rows: list[dict] = []
    for mk in completed[:12]:
        earliest = _earliest_backtest_snapshot_for_month(by_t[mk])
        if not earliest or earliest.total_ai_adjusted_forecast is None:
            continue
        pred = float(earliest.total_ai_adjusted_forecast)
        if pred <= 0:
            continue
        y, m = int(mk[:4]), int(mk[5:])
        d_s = date(y, m, 1)
        d_e = date(y, m, calendar.monthrange(y, m)[1])
        _nb, _ex, tot = await _bookings_total_closed_won_for_month(db, d_s, d_e)
        err_pct = (tot - pred) / pred * 100.0
        signed.append(err_pct)
        abs_e.append(abs(err_pct))
        rows.append(
            {
                "month": mk,
                "predicted": round(pred, 2),
                "actual": tot,
                "error_pct": round(err_pct, 1),
                "earliest_snapshot": earliest.snapshot_date.isoformat(),
            }
        )
    n = len(signed)
    return {
        "n": n,
        "mean_signed_error_pct": round(sum(signed) / n, 1) if n else None,
        "mean_abs_error_pct": round(sum(abs_e) / n, 1) if n else None,
        "rows": rows,
    }


async def _ai_forecast_calibration_block(db: AsyncSession) -> str:
    """Markdown for the deal-scoring LLM: recent AI-adjusted month forecast vs realized bookings."""
    d = await _compute_ai_backtest_against_snapshots(db)
    if d["n"] == 0:
        return ""
    lines = [
        "## Out-of-sample AI forecast (bookings) vs realized closes",
        "Each line compares the **earliest** saved *Forecast (AI) — adjusted* in our DB for that month to **final** Closed Won NB+Expansion ARR. "
        "If mean signed error is **negative**, we have been **over-forecasting** on average; if positive, **under-forecasting**.",
    ]
    for r in d["rows"][:8]:
        lines.append(
            f"- {r['month']}: AI adjusted ${r['predicted']:,.0f} → closed ${r['actual']:,.0f} "
            f"({r['error_pct']:+.0f}% vs forecast); first snapshot {r['earliest_snapshot']}"
        )
    bias = d.get("mean_signed_error_pct")
    mae = d.get("mean_abs_error_pct")
    lines.append(
        f"**Blended mean signed error:** {bias:+.0f}%  ·  **MAE:** {mae:.0f}%  (n={d['n']} completed month(s) with data)."
    )
    lines.append(
        "**Use as a prior on win-probability** — if we over-forecast, reduce confidence on shaky *Best Case* / high-category deals; "
        "if we under-forecast, avoid crushing implied probability on well-supported late-stage opps. "
        "Staleness, close-date pushes, and few activities must still lower scores."
    )
    return "\n".join(lines)


@app.get("/api/forecast/accuracy")
async def get_forecast_accuracy(db: AsyncSession = Depends(get_db)):
    """
    Forecast accuracy analysis: compare historical snapshots to final actuals.
    For each past month with a snapshot, shows forecast (at start of month, start of quarter)
    vs. actual bookings. Also shows AI forecast accuracy where available.
    """
    today = datetime.now(EST).date()

    # Load all snapshots
    snaps_r = await db.execute(
        select(ForecastSnapshot).order_by(ForecastSnapshot.snapshot_date, ForecastSnapshot.target_month)
    )
    all_snaps: list[ForecastSnapshot] = list(snaps_r.scalars().all())

    if not all_snaps:
        return {"rows": [], "message": "No forecast snapshots yet. Snapshots are taken automatically on the 1st of each month."}

    # Get all unique target months that have snapshots
    target_months = sorted({s.target_month for s in all_snaps})

    # For each target month, get actuals (final closed won ARR)
    rows = []
    for mk in target_months:
        y, m = int(mk[:4]), int(mk[5:])
        d_start = date(y, m, 1)
        d_end = date(y, m, calendar.monthrange(y, m)[1])

        # Is this month complete?
        is_complete = d_end < today
        actuals_end = d_end if is_complete else today

        nb_actual, exp_actual, total_actual = await _bookings_total_closed_won_for_month(db, d_start, actuals_end)

        # Group snapshots for this month by snapshot_date
        month_snaps = [s for s in all_snaps if s.target_month == mk]
        month_snaps.sort(key=lambda s: s.snapshot_date)

        snap_entries = []
        for s in month_snaps:
            snap_entries.append({
                "snapshot_date": s.snapshot_date.isoformat(),
                "nb_forecast": s.nb_forecast,
                "nb_adjusted_forecast": s.nb_adjusted_forecast,
                "nb_ai_forecast": s.nb_ai_forecast,
                "exp_forecast": s.exp_forecast,
                "exp_adjusted_forecast": s.exp_adjusted_forecast,
                "exp_ai_forecast": s.exp_ai_forecast,
                "total_forecast": s.total_forecast,
                "total_adjusted_forecast": s.total_adjusted_forecast,
                "total_ai_adjusted_forecast": s.total_ai_adjusted_forecast,
            })

        # Accuracy vs. earliest snapshot (chronological first; prefer one with full AI total)
        earliest = _earliest_backtest_snapshot_for_month(month_snaps) if month_snaps else None
        acc_weighted = round(total_actual / earliest.total_forecast * 100, 1) if (earliest and earliest.total_forecast and earliest.total_forecast > 0 and is_complete) else None
        acc_adjusted = round(total_actual / earliest.total_adjusted_forecast * 100, 1) if (earliest and earliest.total_adjusted_forecast and earliest.total_adjusted_forecast > 0 and is_complete) else None
        pred_ai: float | None = None
        if earliest and earliest.total_ai_adjusted_forecast is not None:
            pred_ai = float(earliest.total_ai_adjusted_forecast)
        elif earliest and (earliest.nb_ai_forecast is not None or earliest.exp_ai_forecast is not None):
            pred_ai = (earliest.nb_ai_forecast or 0) + (earliest.exp_ai_forecast or 0)
        acc_ai = round(total_actual / pred_ai * 100, 1) if (pred_ai and pred_ai > 0 and is_complete) else None

        rows.append({
            "month": mk,
            "is_complete": is_complete,
            "nb_actual": round(nb_actual, 2),
            "exp_actual": round(exp_actual, 2),
            "total_actual": total_actual,
            "snapshots": snap_entries,
            "earliest_snapshot_date": earliest.snapshot_date.isoformat() if earliest else None,
            "weighted_forecast_at_snap": earliest.total_forecast if earliest else None,
            "adjusted_forecast_at_snap": earliest.total_adjusted_forecast if earliest else None,
            "ai_adjusted_forecast_at_snap": earliest.total_ai_adjusted_forecast if earliest else None,
            "accuracy_weighted_pct": acc_weighted,
            "accuracy_adjusted_pct": acc_adjusted,
            "accuracy_ai_pct": acc_ai,
        })

    return {
        "rows": rows,
        "snapshot_count": len(all_snaps),
        "message": "Snapshots are taken on the 1st of each month. Accuracy % shown only for complete months.",
    }


@app.post("/api/forecast/ai-rescore")
async def post_ai_rescore():
    """
    On-demand trigger for AI forecast scoring. Returns immediately; scoring runs in background.
    Poll GET /api/jobs/active to track progress.
    Requires ANTHROPIC_API_KEY in .env. Does NOT require ENABLE_AI_FORECAST_SCORING.
    """
    job_id = f"rescore_{int(time.time())}"
    _bg_job_start(job_id, "ai_rescore", "AI Scoring")

    async def _run() -> None:
        try:
            async with AsyncSessionLocal() as session:
                result = await _run_ai_forecast_scoring(session)
                if result.get("ok"):
                    await session.commit()
                else:
                    await session.rollback()
                scored = result.get("scored", 0)
                _bg_job_done(job_id, bool(result.get("ok")), f"Scored {scored} deals")
        except Exception as exc:
            _logger.exception("Background AI rescore failed: %s", exc)
            _bg_job_done(job_id, False, str(exc))

    asyncio.create_task(_run())
    return {"ok": True, "job_id": job_id, "status": "started", "message": "AI scoring started in background"}


@app.get("/api/briefing/weekly")
async def get_weekly_briefing(db: AsyncSession = Depends(get_db)):
    """Return the most recent weekly executive briefing."""
    result = await db.execute(
        select(WeeklyBriefing).order_by(WeeklyBriefing.generated_at.desc()).limit(1)
    )
    row: WeeklyBriefing | None = result.scalar_one_or_none()
    if row is None:
        return WeeklyBriefingResponse()
    return WeeklyBriefingResponse(
        week_of=str(row.week_of),
        generated_at=row.generated_at.isoformat() if row.generated_at else None,
        briefing_text=row.briefing_text,
        model_used=row.model_used,
        error=row.error,
    )


@app.post("/api/briefing/generate")
async def post_generate_weekly_briefing(db: AsyncSession = Depends(get_db)):
    """On-demand trigger for weekly executive briefing generation."""
    result = await _generate_weekly_briefing(db)
    return result


# ── Agent conversation memory ─────────────────────────────────────────────────

_MEMORY_STOPWORDS = frozenset(
    "a an the is are was were be been being have has had do does did will would could should "
    "may might shall can i we you he she it they them their our your my his her its "
    "in on at of to for with by from as into about over under between through after before "
    "what how why when who where which that this these those and or but not no if so than "
    "how many what's our we're i'm the's it's don't doesn't didn't can't won't isn't aren't "
    "just tell show me get us give please".split()
)


def _extract_keywords(text: str, max_kw: int = 20) -> str:
    """Extract meaningful lowercase keywords from a message for lightweight indexing."""
    words = re.findall(r"[a-z]{3,}", text.lower())
    kw = [w for w in words if w not in _MEMORY_STOPWORDS]
    return " ".join(dict.fromkeys(kw[:max_kw]))  # dedup, preserve order


async def _save_conversation_turn(
    db: AsyncSession, session_id: str, user_msg: str, assistant_msg: str
) -> None:
    """Persist a user+assistant exchange to the conversation memory store."""
    if not session_id:
        return
    try:
        db.add(ConversationMessage(
            session_id=session_id, role="user", content=user_msg,
            keywords=_extract_keywords(user_msg),
        ))
        db.add(ConversationMessage(
            session_id=session_id, role="assistant", content=assistant_msg,
            keywords=_extract_keywords(assistant_msg),
        ))
        await db.commit()
    except Exception:
        await db.rollback()


async def _get_memory_context(
    db: AsyncSession, session_id: str, current_message: str, max_chars: int = 4000
) -> str:
    """
    Retrieve relevant past exchanges for the current question.
    Strategy:
    1. Most-recent exchanges from *other* sessions (always included — recency matters)
    2. Keyword-matched exchanges from any past session (topical relevance)
    Returns a formatted string to inject into the system prompt, or "" if nothing found.
    """
    if not session_id:
        return ""
    try:
        # Fetch up to 120 past messages excluding current session, newest first
        result = await db.execute(
            select(ConversationMessage)
            .where(ConversationMessage.session_id != session_id)
            .order_by(ConversationMessage.created_at.desc())
            .limit(120)
        )
        past: list[ConversationMessage] = list(result.scalars().all())

        if not past:
            return ""

        # Pair up user+assistant turns (messages are stored in order; walk pairs)
        pairs: list[tuple[ConversationMessage, ConversationMessage | None]] = []
        i = 0
        while i < len(past):
            msg = past[i]
            if msg.role == "user":
                nxt = past[i + 1] if i + 1 < len(past) and past[i + 1].role == "assistant" else None
                pairs.append((msg, nxt))
                i += 2 if nxt else 1
            else:
                i += 1

        # Score pairs: keyword overlap with current question
        current_kw = set(_extract_keywords(current_message).split())
        scored: list[tuple[float, ConversationMessage, ConversationMessage | None]] = []
        for u_msg, a_msg in pairs:
            pair_kw = set((u_msg.keywords or "").split())
            overlap = len(current_kw & pair_kw) if current_kw else 0
            # Boost by recency: newer = higher base score
            scored.append((overlap, u_msg, a_msg))

        # Sort: keyword overlap desc, then implicitly by position (newest first from query)
        scored.sort(key=lambda x: x[0], reverse=True)

        # Always include the 3 most recent, then top keyword matches (deduplicated)
        recent_ids = {id(u) for _, u, _ in scored[:3]}
        top_relevant = [t for t in scored if t[0] > 0 and id(t[1]) not in recent_ids][:5]
        selected = scored[:3] + top_relevant

        if not selected:
            return ""

        lines = ["## Memory — Relevant past conversations (for context only, not current session)"]
        char_budget = max_chars
        for _, u_msg, a_msg in selected:
            when = u_msg.created_at.strftime("%b %d, %Y") if u_msg.created_at else "unknown date"
            entry = f"\n[{when}]\nYou asked: {u_msg.content[:400]}"
            if a_msg:
                entry += f"\nAgent answered: {a_msg.content[:600]}"
            if len(entry) > char_budget:
                break
            lines.append(entry)
            char_budget -= len(entry)

        return "\n".join(lines) if len(lines) > 1 else ""

    except Exception as exc:
        _logger.warning("Memory retrieval failed: %s", exc)
        return ""


@app.post("/api/agent/chat")
async def post_agent_chat(body: AgentChatRequest, db: AsyncSession = Depends(get_db)):
    """Unified executive assistant chat with live Salesforce query capability.
    Uses Anthropic tool use so the agent can run SOQL SELECT queries when the
    pre-loaded context doesn't have the data needed to answer the question."""
    if not _ANTHROPIC_AVAILABLE or _anthropic_mod is None:
        raise HTTPException(status_code=503, detail="anthropic package not available")
    anthropic_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    if not anthropic_key:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not set")
    if not body.message.strip():
        raise HTTPException(status_code=400, detail="message cannot be empty")

    try:
        fpa_ctx = await _build_fpa_context(db)
    except Exception:
        fpa_ctx = "*(FP&A context unavailable)*"
    try:
        revops_ctx = await _build_revops_context(db)
    except Exception:
        revops_ctx = "*(RevOps context unavailable)*"

    # Load cross-session memory relevant to this question
    memory_ctx = await _get_memory_context(db, body.session_id, body.message)

    full_system = (
        _EXEC_ASSISTANT_SYSTEM_PROMPT
        + "\n\n---\n\n## Current Data\n\n"
        + fpa_ctx
        + "\n\n---\n\n"
        + revops_ctx
        + (("\n\n---\n\n" + memory_ctx) if memory_ctx else "")
        + (
            "\n\n---\n\n## Live Data Tools\n\n"
            "You have three live-data tools:\n"
            "1. `salesforce_query` — SOQL SELECT for ARR, subscriptions, opportunities, accounts, activity, pipeline. "
            "Use for ALL revenue metrics: ARR, MRR, NRR, churn, expansion, bookings, subscription counts.\n"
            "2. `chargebee_query` — live billing data: invoices, payments, collections, overdue balances, payment failures. "
            "Use ONLY for cash and billing questions — never for ARR or subscription metrics.\n"
            "3. `google_sheets_query` — read live data from the Dazos Google Sheets financial model. "
            "Use for any financial detail not in the pre-loaded context: specific P&L line items, G&A breakdown, "
            "budget rows, headcount, or any tab/range. Call list_sheets first if unsure which tab to read.\n\n"
            "Pre-loaded context already includes **P&L** and **operating expenses by department** (same database as the "
            "Financials app after sync). Line items such as legal or professional fees are usually under "
            "`General & Administrative` in that section or on that sheet tab — search there before calling tools.\n\n"
            "Always answer from the pre-loaded context first; only call a tool when the context lacks the data. "
            "Salesforce: include a LIMIT clause. Chargebee: amounts are in cents (÷100 for dollars)."
        )
    )

    # Tools: live Salesforce SOQL queries + Chargebee billing + Google Sheets financial model
    sf_tools = [
        {
            "name": "salesforce_query",
            "description": (
                "Run a live SOQL SELECT query against Salesforce. Only SELECT statements are allowed. "
                "Results are capped at 200 records. Include a LIMIT clause for large objects."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "soql": {
                        "type": "string",
                        "description": "A SOQL SELECT query. Must start with SELECT.",
                    },
                    "reason": {
                        "type": "string",
                        "description": "Brief explanation of what data this fetches and why it's needed.",
                    },
                },
                "required": ["soql"],
            },
        },
        _CHARGEBEE_TOOL,
        _SHEETS_TOOL,
    ]

    async def _execute_sf_query(soql: str) -> str:
        """Run a SOQL query with safety guardrails; return a compact text result."""
        soql = soql.strip()
        if not soql.upper().startswith("SELECT"):
            return "ERROR: Only SELECT queries are permitted."
        if "LIMIT" not in soql.upper():
            soql += " LIMIT 200"
        try:
            from connectors.salesforce import SalesforceConnector
            connector = SalesforceConnector()
            records = await asyncio.to_thread(connector.query, soql)
            if not records:
                return "Query returned 0 records."
            result_json = json.dumps(records[:200], default=str, indent=2)
            if len(result_json) > 20000:
                result_json = result_json[:20000] + "\n...(truncated)"
            return f"{len(records)} record(s):\n{result_json}"
        except Exception as exc:
            return f"ERROR: {exc}"

    # Build message history + new user message
    messages: list = []
    for h in body.history:
        role = h.get("role", "user")
        content = h.get("content", "")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": body.message})

    try:
        client = _anthropic_mod.AsyncAnthropic(api_key=anthropic_key)
        answer = "No response from agent."
        last_stop: str | None = None
        last_content_types: list[str] = []

        # Agentic loop — SF + Sheets can need many steps (list_sheets + multiple reads)
        for _round in range(_AGENT_MAX_TOOL_ROUNDS):
            response = await client.messages.create(
                model="claude-sonnet-4-5",
                max_tokens=4096,
                system=full_system,
                tools=sf_tools,
                messages=messages,
            )
            last_stop = getattr(response, "stop_reason", None)
            last_content_types = [getattr(b, "type", "?") for b in response.content]

            tool_use_blocks = [b for b in response.content if b.type == "tool_use"]

            if not tool_use_blocks or response.stop_reason == "end_turn":
                # Final answer — concatenate all text blocks (some models split across blocks)
                answer = _anthropic_response_text(response.content) or answer
                if (not answer or answer == "No response from agent.") and response.stop_reason == "max_tokens":
                    answer = "The reply was cut off (token limit). Please ask a narrower question or split it into parts."
                break

            # Append assistant turn (may include text + tool_use blocks)
            messages.append({"role": "assistant", "content": response.content})

            # Execute each tool call and collect results
            tool_results = []
            for block in tool_use_blocks:
                if block.name == "salesforce_query":
                    soql = block.input.get("soql", "")
                    _logger.info("Agent SF query [round %d]: %s", _round + 1, soql[:200])
                    result = await _execute_sf_query(soql)
                elif block.name == "chargebee_query":
                    resource = block.input.get("resource", "")
                    filters = block.input.get("filters", {})
                    limit = block.input.get("limit", 50)
                    _logger.info("Agent CB query [round %d]: %s filters=%s", _round + 1, resource, filters)
                    result = await _execute_chargebee_tool(resource, filters, limit)
                elif block.name == "google_sheets_query":
                    action = block.input.get("action", "")
                    range_a1 = block.input.get("range")
                    _logger.info("Agent Sheets query [round %d]: action=%s range=%s", _round + 1, action, range_a1)
                    result = await _execute_sheets_tool(action, range_a1)
                else:
                    result = f"ERROR: Unknown tool '{block.name}'."
                tool_results.append(
                    {"type": "tool_result", "tool_use_id": block.id, "content": result}
                )

            messages.append({"role": "user", "content": tool_results})

        if not answer or answer == "No response from agent.":
            _logger.warning(
                "post_agent_chat: no assistant text after loop (stop=%s content_types=%s)",
                last_stop,
                last_content_types,
            )
            answer = (
                "I could not finish a reply — this usually means the step limit for reading data was hit "
                "without a final answer, or the model returned no text. Please try again. "
                "Financials from your app sync are in context (P&L and **operating expenses by department**); "
                "legal-type spend is usually under **General & Administrative**. I can also read the live "
                "sheet via google_sheets_query if a line is missing from context."
            )

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Agent error: {e}")

    # Persist this exchange to long-term memory
    await _save_conversation_turn(db, body.session_id, body.message, answer)

    return {"answer": answer, "memory_used": bool(memory_ctx)}


@app.post("/api/arr-snapshot/refresh")
async def post_arr_snapshot_refresh(db: AsyncSession = Depends(get_db)):
    """Rebuild MonthlyArrSnapshot from current ARR history data (lightweight, no external API calls)."""
    result = await _refresh_monthly_arr_snapshot(db)
    return result


@app.get("/api/arr-bridge/accounts")
async def get_arr_bridge_accounts(
    month: str = Query(..., description="YYYY-MM"),
    component: str = Query(..., description="new_business | expansion | contraction | churn"),
    db: AsyncSession = Depends(get_db),
):
    """
    Returns the individual accounts that make up a bridge component for a given month.
    Used for drill-down from the Monthly ARR Movement chart.
    """
    prior_mk = _mk_offset(month, -1)

    snap_r = await db.execute(
        select(MonthlyArrSnapshot).where(
            MonthlyArrSnapshot.month_key.in_([month, prior_mk])
        )
    )
    snaps = snap_r.scalars().all()

    curr:  dict[str, float] = {s.account_name: s.arr for s in snaps if s.month_key == month}
    prior: dict[str, float] = {s.account_name: s.arr for s in snaps if s.month_key == prior_mk}
    all_names = set(curr.keys()) | set(prior.keys())

    accounts: list[dict] = []
    for name in all_names:
        a_curr  = curr.get(name, 0.0)
        a_prior = prior.get(name, 0.0)
        if component == "new_business" and a_prior == 0.0 and a_curr > 0.0:
            accounts.append({"account_name": name, "arr": a_curr, "arr_change": round(a_curr, 2)})
        elif component == "expansion" and a_prior > 0.0 and a_curr > a_prior:
            accounts.append({"account_name": name, "arr": a_curr, "arr_change": round(a_curr - a_prior, 2)})
        elif component == "contraction" and a_prior > 0.0 and 0.0 < a_curr < a_prior:
            accounts.append({"account_name": name, "arr": a_curr, "arr_change": round(a_curr - a_prior, 2)})
        elif component == "churn" and a_prior > 0.0 and a_curr == 0.0:
            accounts.append({"account_name": name, "arr": 0.0, "arr_change": round(-a_prior, 2)})

    # Look up SF account IDs from the opportunities table
    if accounts:
        names = [a["account_name"] for a in accounts]
        id_r = await db.execute(
            select(Opportunity.account_id, Opportunity.account_name)
            .where(Opportunity.account_name.in_(names))
            .distinct()
        )
        id_map: dict[str, str] = {}
        for row in id_r:
            if row.account_name not in id_map and row.account_id:
                id_map[row.account_name] = row.account_id
        for a in accounts:
            a["sf_account_id"] = id_map.get(a["account_name"])

    accounts.sort(key=lambda x: abs(x["arr_change"]), reverse=True)

    base = os.getenv("SALESFORCE_BASE_URL", "").strip().rstrip("/")
    return {
        "accounts": accounts,
        "month": month,
        "component": component,
        "salesforce_base_url": base or None,
    }


@app.get("/api/arr-bridge")
async def get_arr_bridge(db: AsyncSession = Depends(get_db)):
    """
    ARR bridge (waterfall) and trailing-12M GRR / NRR for the last 13 calendar months.

    Bridge components (each month M vs prior month M-1):
    - **New Business**: accounts with $0 ARR in M-1 and >$0 in M
    - **Expansion**: increase in ARR for accounts active in both months (arr_M > arr_M1 > 0)
    - **Contraction**: decrease in ARR for accounts active in both months (0 < arr_M < arr_M1)
    - **Churn**: ARR of accounts that had >$0 in M-1 and $0 in M

    Trailing-12M NRR / GRR (as of month M):
    - Cohort = all accounts with ARR > 0 in M-12
    - Denominator = sum of their ARR in M-12
    - NRR = sum of their current ARR in M (0 if churned) / denominator
    - GRR = sum of min(arr_M, arr_M-12) per account / denominator  (capped, no expansion credit)
    """
    today_est = datetime.now(EST).date()
    current_mk = today_est.strftime("%Y-%m")

    # 13 displayed months (oldest first)
    display_months: list[str] = []
    _m = date(today_est.year, today_est.month, 1)
    for _ in range(13):
        display_months.insert(0, _m.strftime("%Y-%m"))
        _m = date(_m.year - 1 if _m.month == 1 else _m.year, 12 if _m.month == 1 else _m.month - 1, 1)

    # Fetch range: need M-12 of earliest shown month for NRR/GRR, plus M-1 for beginning ARR
    fetch_from = _mk_offset(display_months[0], -13)   # 13 months before earliest shown
    fetch_to = current_mk

    # Check snapshot is populated
    count_r = await db.execute(
        select(func.count(MonthlyArrSnapshot.id)).where(MonthlyArrSnapshot.month_key <= fetch_to)
    )
    row_count = count_r.scalar_one()
    if row_count == 0:
        return {
            "bridge": [], "retention": [], "display_months": display_months,
            "message": "Monthly ARR snapshot not yet built. Run 'Refresh app data' to populate it.",
        }

    # Load all relevant rows
    snap_r = await db.execute(
        select(MonthlyArrSnapshot)
        .where(MonthlyArrSnapshot.month_key >= fetch_from)
        .where(MonthlyArrSnapshot.month_key <= fetch_to)
    )
    snap_rows = snap_r.scalars().all()

    # arr_map[account_name][month_key] = arr
    arr_map: dict[str, dict[str, float]] = {}
    for s in snap_rows:
        arr_map.setdefault(s.account_name, {})[s.month_key] = s.arr

    all_accounts = list(arr_map.keys())

    def get_arr(account: str, mk: str) -> float:
        return arr_map.get(account, {}).get(mk, 0.0)

    def total_arr(mk: str) -> float:
        return round(sum(arr_map.get(a, {}).get(mk, 0.0) for a in all_accounts), 2)

    bridge: list[dict] = []
    retention: list[dict] = []

    for mk in display_months:
        prior_mk = _mk_offset(mk, -1)

        beg = total_arr(prior_mk)
        new_biz = exp = ctr = churn = 0.0

        for acc in all_accounts:
            a_prior = get_arr(acc, prior_mk)
            a_curr  = get_arr(acc, mk)
            if a_prior == 0.0 and a_curr > 0.0:
                new_biz += a_curr
            elif a_prior > 0.0 and a_curr > a_prior:
                exp += a_curr - a_prior
            elif a_prior > 0.0 and 0.0 < a_curr < a_prior:
                ctr += a_prior - a_curr
            elif a_prior > 0.0 and a_curr == 0.0:
                churn += a_prior

        end = total_arr(mk)
        bridge.append({
            "month": mk,
            "beginning_arr": round(beg, 2),
            "new_business": round(new_biz, 2),
            "expansion": round(exp, 2),
            "contraction": round(ctr, 2),
            "churn": round(churn, 2),
            "net_change": round(new_biz + exp - ctr - churn, 2),
            "ending_arr": round(end, 2),
        })

        # Trailing 12M retention
        m12 = _mk_offset(mk, -12)
        cohort = [a for a in all_accounts if get_arr(a, m12) > 0.0]
        if cohort:
            denom = round(sum(get_arr(a, m12) for a in cohort), 2)
            nrr_num = round(sum(get_arr(a, mk) for a in cohort), 2)
            grr_num = round(sum(min(get_arr(a, mk), get_arr(a, m12)) for a in cohort), 2)
            retention.append({
                "month": mk,
                "nrr_trailing_12m": round(nrr_num / denom * 100, 1) if denom > 0 else None,
                "grr_trailing_12m": round(grr_num / denom * 100, 1) if denom > 0 else None,
                "cohort_arr": denom,
                "cohort_size": len(cohort),
            })
        else:
            retention.append({
                "month": mk,
                "nrr_trailing_12m": None,
                "grr_trailing_12m": None,
                "cohort_arr": None,
                "cohort_size": 0,
            })

    # ── YoY ARR growth — all available months ───────────────────────────────────
    month_totals_r = await db.execute(
        select(MonthlyArrSnapshot.month_key, func.sum(MonthlyArrSnapshot.arr).label("total"))
        .group_by(MonthlyArrSnapshot.month_key)
        .order_by(MonthlyArrSnapshot.month_key)
    )
    month_totals: dict[str, float] = {
        row.month_key: round(row.total, 2) for row in month_totals_r
    }
    yoy: list[dict] = []
    sorted_months = sorted(month_totals.keys())
    for mk in sorted_months:
        m12 = _mk_offset(mk, -12)
        m1 = _mk_offset(mk, -1)
        if m12 in month_totals:
            prior = month_totals[m12]
            pct = round((month_totals[mk] - prior) / prior * 100, 1) if prior > 0 else None
            net_new = round(month_totals[mk] - month_totals.get(m1, 0.0), 2)
            yoy.append({
                "month": mk,
                "ending_arr": month_totals[mk],
                "net_new_arr": net_new,
                "yoy_pct": pct,
            })

    return {
        "bridge": bridge,
        "retention": retention,
        "yoy": yoy,
        "display_months": display_months,
        "message": None,
    }


def _build_bridge_from_arr_map(
    arr_map: dict[str, dict[str, float]],
    display_months: list[str],
    yoy_months: list[str],
    logo_totals: Optional[dict[str, dict[str, float]]] = None,
) -> dict:
    """Shared ARR-bridge / retention / YoY math, given arr_map[account][YYYY-MM] = arr.

    Components for month M vs M-1: New Business, Expansion, Contraction, Churn. Trailing-12M NRR/GRR
    use the M-12 cohort.

    ``logo_totals`` (account → month → total account ARR) drives New-Business-vs-Expansion at the
    product level: a product increase counts as New Business only when the *account* was new
    (total ARR 0 in M-1); otherwise it's Expansion (e.g. cross-sell of a new product into an existing
    account). On the down side, a product decrease is Churn only when the account fully churned
    (total ARR 0 in M); otherwise it's Contraction. When ``logo_totals`` is None, the product's own
    presence is used (legacy behaviour).
    """
    all_accounts = list(arr_map.keys())

    def get_arr(account: str, mk: str) -> float:
        return arr_map.get(account, {}).get(mk, 0.0)

    def total_arr(mk: str) -> float:
        return round(sum(arr_map.get(a, {}).get(mk, 0.0) for a in all_accounts), 2)

    def logo_arr(account: str, mk: str) -> float:
        if logo_totals is None:
            return get_arr(account, mk)
        return logo_totals.get(account, {}).get(mk, 0.0)

    bridge: list[dict] = []
    retention: list[dict] = []
    for mk in display_months:
        prior_mk = _mk_offset(mk, -1)
        beg = total_arr(prior_mk)
        new_biz = exp = ctr = churn = 0.0
        for acc in all_accounts:
            a_prior = get_arr(acc, prior_mk)
            a_curr = get_arr(acc, mk)
            if a_curr > a_prior:
                # Increase: New Business only for brand-new logos, else Expansion (incl. cross-sell).
                if logo_arr(acc, prior_mk) <= 0.0:
                    new_biz += a_curr - a_prior
                else:
                    exp += a_curr - a_prior
            elif a_curr < a_prior:
                # Decrease: Churn only when the whole logo churned, else Contraction.
                if logo_arr(acc, mk) <= 0.0:
                    churn += a_prior - a_curr
                else:
                    ctr += a_prior - a_curr
        end = total_arr(mk)
        bridge.append({
            "month": mk,
            "beginning_arr": round(beg, 2),
            "new_business": round(new_biz, 2),
            "expansion": round(exp, 2),
            "contraction": round(ctr, 2),
            "churn": round(churn, 2),
            "net_change": round(new_biz + exp - ctr - churn, 2),
            "ending_arr": round(end, 2),
        })

        m12 = _mk_offset(mk, -12)
        cohort = [a for a in all_accounts if get_arr(a, m12) > 0.0]
        if cohort:
            denom = round(sum(get_arr(a, m12) for a in cohort), 2)
            nrr_num = round(sum(get_arr(a, mk) for a in cohort), 2)
            grr_num = round(sum(min(get_arr(a, mk), get_arr(a, m12)) for a in cohort), 2)
            retention.append({
                "month": mk,
                "nrr_trailing_12m": round(nrr_num / denom * 100, 1) if denom > 0 else None,
                "grr_trailing_12m": round(grr_num / denom * 100, 1) if denom > 0 else None,
                "cohort_arr": denom,
                "cohort_size": len(cohort),
            })
        else:
            retention.append({"month": mk, "nrr_trailing_12m": None, "grr_trailing_12m": None, "cohort_arr": None, "cohort_size": 0})

    month_totals = {mk: total_arr(mk) for mk in yoy_months}
    yoy: list[dict] = []
    for mk in yoy_months:
        m12 = _mk_offset(mk, -12)
        m1 = _mk_offset(mk, -1)
        if m12 in month_totals:
            prior = month_totals[m12]
            pct = round((month_totals[mk] - prior) / prior * 100, 1) if prior > 0 else None
            net_new = round(month_totals[mk] - month_totals.get(m1, total_arr(m1)), 2)
            yoy.append({"month": mk, "ending_arr": month_totals[mk], "net_new_arr": net_new, "yoy_pct": pct})

    return {"bridge": bridge, "retention": retention, "yoy": yoy}


# Per-product ARR bridges. Group key → display label. CRM = Seat-Pricing 'CRM ARR'
# (CRM Platform Legacy + Includes-5-Seats + Additional CRM Seats; excludes Billing CRM).
# Order here is the display/export order.
# Product families for the reconciled bridges. These cover ALL ARR-included SKUs, so the
# product bridges sum exactly to the Total bridge each month. Order = display/export order.
_PRODUCT_BRIDGE_DEFS: dict[str, str] = {
    "crm": "CRM",
    "icampaign": "iCampaign",
    "iq_mr": "IQ & Marketing Reports",
    "rvk": "RVK Agents",
    "other": "Other",
}

# Per-product bridges start from this year-end anchor (Dec 2025 = opening balance), then build
# forward month by month. 2025 product-level cleanup is out of scope; the Total bridge keeps 2025.
_PRODUCT_BRIDGE_ANCHOR_MK = "2025-12"


async def _product_arr_map(db: AsyncSession, group_key: str, month_keys: list[str]) -> dict[str, dict[str, float]]:
    """Per-account month-end ARR for one product family: arr_map[account][YYYY-MM] = arr (Alleva-scaled).

    CRM reads the always-computed ``crm_arr_by_month``; other families compute ``product_arr_by_month[group]``.
    """
    use_crm_field = group_key == "crm"
    rows, _msg = await _compute_active_arr_rows(
        db,
        apply_alleva_retained_arr_adjustment=True,
        crm_month_keys=month_keys,
        product_month_groups=None if use_crm_field else [group_key],
    )
    arr_map: dict[str, dict[str, float]] = {}
    for r in rows:
        if use_crm_field:
            bm = r.get("crm_arr_by_month") or {}
        else:
            bm = (r.get("product_arr_by_month") or {}).get(group_key) or {}
        if not bm:
            continue
        name = r.get("account_name") or "—"
        d = arr_map.setdefault(name, {})
        for mk, v in bm.items():
            fv = float(v or 0.0)
            if fv:
                d[mk] = round(d.get(mk, 0.0) + fv, 2)
    return arr_map


async def _reconciled_product_alloc(
    db: AsyncSession,
    *,
    month_keys: list[str],
    snap_from: str,
    snap_to: str,
    named_groups: list[str],
) -> tuple[dict[str, dict[str, float]], dict[str, dict[str, dict[str, float]]]]:
    """Per-account reconciled product allocation shared by the ARR bridges and the product-line
    analytics so both tell the same story.

    Returns ``(snap, alloc)``:
      • ``snap[account][month_key]``         = authoritative Total ARR (MonthlyArrSnapshot, same source
                                               as /api/arr-bridge — includes every account incl. Alleva).
      • ``alloc[group][account][month_key]`` = that Total split across ``named_groups`` plus ``"other"``
                                               by the account's Salesforce line-item mix. Σ groups =
                                               snap each month (Other absorbs the unmapped share + the
                                               rounding residue). Negative line signals are clamped so a
                                               superseded mid-term line can't invert the split.
    """
    groups = list(named_groups) + ["other"]
    snap_rows = (
        await db.execute(
            select(MonthlyArrSnapshot)
            .where(MonthlyArrSnapshot.month_key >= snap_from)
            .where(MonthlyArrSnapshot.month_key <= snap_to)
        )
    ).scalars().all()
    snap: dict[str, dict[str, float]] = {}
    for s in snap_rows:
        snap.setdefault(s.account_name, {})[s.month_key] = float(s.arr or 0.0)

    rows, _msg = await _compute_active_arr_rows(
        db, apply_alleva_retained_arr_adjustment=True, crm_month_keys=month_keys, product_month_groups=groups
    )
    li: dict[str, dict[str, dict[str, float]]] = {}
    for r in rows:
        name = r.get("account_name") or "—"
        pbm = r.get("product_arr_by_month") or {}
        acc_li = li.setdefault(name, {})
        for g in groups:
            gm = pbm.get(g) or {}
            if not gm:
                continue
            dst = acc_li.setdefault(g, {})
            for mk, v in gm.items():
                fv = float(v or 0.0)
                if fv:
                    dst[mk] = round(dst.get(mk, 0.0) + fv, 2)

    alloc: dict[str, dict[str, dict[str, float]]] = {g: {} for g in groups}
    for acc, months in snap.items():
        acc_li = li.get(acc, {})
        for mk, tot in months.items():
            if not tot:
                continue
            # Clamp negative line-group signals to 0 before weighting: a net-negative group would be a
            # mid-term removal whose offsetting base sits on a superseded opp; allowing it through would
            # invert the proportional split. The snapshot Total already reflects the reduced ARR, so the
            # drop is captured by the product's level falling toward 0.
            li_g = {g: max(0.0, acc_li.get(g, {}).get(mk, 0.0)) for g in groups}
            li_total = sum(li_g.values())
            parts: dict[str, float] = {}
            if li_total > 0:
                assigned = 0.0
                for g in named_groups:
                    val = round(tot * li_g[g] / li_total, 2)
                    parts[g] = val
                    assigned += val
                parts["other"] = round(tot - assigned, 2)  # Other's mix share + rounding residue
            else:
                for g in named_groups:
                    parts[g] = 0.0
                parts["other"] = round(float(tot), 2)
            for g in groups:
                if parts.get(g):
                    alloc[g].setdefault(acc, {})[mk] = parts[g]
    return snap, alloc


async def _compute_all_product_bridges(db: AsyncSession) -> dict:
    """Reconciled per-product ARR bridges that sum exactly to the Total bridge each month.

    Method: take the authoritative per-account monthly Total ARR (the same MonthlyArrSnapshot that
    powers /api/arr-bridge) and split it across product families using each account's Salesforce
    line-item product mix for that month-end. Families cover every ARR-included SKU (CRM, iCampaign,
    IQ & Marketing Reports, RVK Agents, and an 'Other' catch-all), and rounding residue lands in
    'Other', so Σ products = Total to the cent. New Business vs Expansion is logo-based (a product
    increase is New Business only for a brand-new account; otherwise Expansion, incl. cross-sell).
    """
    today_est = datetime.now(EST).date()
    current_mk = today_est.strftime("%Y-%m")
    display_months: list[str] = []
    _m = date(today_est.year, today_est.month, 1)
    for _ in range(13):
        display_months.insert(0, _m.strftime("%Y-%m"))
        _m = date(_m.year - 1 if _m.month == 1 else _m.year, 12 if _m.month == 1 else _m.month - 1, 1)
    fetch_from = _mk_offset(display_months[0], -13)
    month_keys: list[str] = []
    _cur = fetch_from
    while _cur <= current_mk:
        month_keys.append(_cur)
        _cur = _mk_offset(_cur, 1)

    groups = list(_PRODUCT_BRIDGE_DEFS.keys())  # crm, icampaign, iq_mr, rvk, other
    named_groups = [g for g in groups if g != "other"]

    # Authoritative per-account Total ARR (snapshot) split by line-item mix — shared with the
    # product-line analytics so both reconcile to the Total bridge.
    snap, alloc = await _reconciled_product_alloc(
        db, month_keys=month_keys, snap_from=fetch_from, snap_to=current_mk, named_groups=named_groups
    )

    # Per-product bridges anchor at the Dec-2025 year-end ARR and build forward; 2025 product-level
    # cleanup is out of scope (the Total bridge keeps full 2025 history). Dec 2025 is shown as an
    # opening balance (no movement breakdown); Jan 2026 onward are real monthly bridges.
    product_anchor_mk = _PRODUCT_BRIDGE_ANCHOR_MK
    product_display_months = [mk for mk in display_months if mk >= product_anchor_mk] or list(display_months)

    # Reclassification-aware components: classify each account's movement at the ACCOUNT level (like the
    # Total), so within-account product swaps (e.g. CRM→IQ in a flat account) become a 'reclassification'
    # that nets to $0 across products instead of phantom expansion+contraction. With this, Σ products'
    # New Business / Expansion / Contraction / Churn equal the Total exactly, every per-product row still
    # balances (Beginning + moves + reclassification = Ending), and reclassification sums to $0.
    comp = _product_bridge_components(alloc, snap, groups, product_display_months)

    products_out: list[dict] = []
    for g in groups:
        built = _build_bridge_from_arr_map(alloc[g], product_display_months, month_keys, logo_totals=snap)
        bridge_rows = built["bridge"]
        for row in bridge_rows:
            c = comp.get(g, {}).get(row["month"])
            if c is None:
                continue
            row["new_business"] = c["new_business"]
            row["expansion"] = c["expansion"]
            row["contraction"] = c["contraction"]
            row["churn"] = c["churn"]
            row["reclassification"] = c["reclassification"]
            row["net_change"] = round(
                c["new_business"] + c["expansion"] - c["contraction"] - c["churn"] + c["reclassification"], 2
            )
        if bridge_rows and bridge_rows[0]["month"] == product_anchor_mk:
            anchor = bridge_rows[0]
            anchor["beginning_arr"] = anchor["ending_arr"]
            anchor["new_business"] = anchor["expansion"] = anchor["contraction"] = anchor["churn"] = 0.0
            anchor["reclassification"] = 0.0
            anchor["net_change"] = 0.0
        products_out.append({
            "product": g,
            "product_label": _PRODUCT_BRIDGE_DEFS[g],
            "bridge": bridge_rows,
            "retention": built["retention"],
            "yoy": built["yoy"],
        })
    return {"display_months": product_display_months, "products": products_out, "has_data": bool(snap)}


def _product_bridge_components(
    alloc: dict[str, dict[str, dict[str, float]]],
    snap: dict[str, dict[str, float]],
    groups: list[str],
    display_months: list[str],
) -> dict[str, dict[str, dict[str, float]]]:
    """Reconciled per-product bridge components keyed comp[group][month] = {new_business, expansion,
    contraction, churn, reclassification}.

    Each account's month-over-month movement is classified at the account (logo) level — exactly like
    the Total bridge — and then attributed to products:
      • New logo  → New Business per product (current product ARR).
      • Churned   → Churn per product (prior product ARR).
      • Existing, net up   → account net is Expansion, allocated across products that grew.
      • Existing, net down → account net is Contraction, allocated across products that shrank.
    The leftover within-account offset (a product up while another is down) is 'Reclassification',
    which sums to $0 across products so the Total is untouched and Σ products = Total for every
    component. Per-product: Beginning + NB + Exp − Ctr − Churn + Reclassification = Ending.
    """
    accounts = set(snap.keys())
    for g in groups:
        accounts.update(alloc.get(g, {}).keys())

    def aval(g: str, acc: str, mk: str) -> float:
        return alloc.get(g, {}).get(acc, {}).get(mk, 0.0)

    def logo(acc: str, mk: str) -> float:
        return snap.get(acc, {}).get(mk, 0.0)

    comp: dict[str, dict[str, dict[str, float]]] = {
        g: {mk: {"new_business": 0.0, "expansion": 0.0, "contraction": 0.0, "churn": 0.0, "reclassification": 0.0}
            for mk in display_months}
        for g in groups
    }

    for mk in display_months:
        prior = _mk_offset(mk, -1)
        for acc in accounts:
            lp, lc = logo(acc, prior), logo(acc, mk)
            deltas = {g: round(aval(g, acc, mk) - aval(g, acc, prior), 2) for g in groups}
            if lp <= 0.0 and lc > 0.0:
                for g in groups:
                    v = aval(g, acc, mk)
                    if v:
                        comp[g][mk]["new_business"] += v
                continue
            if lc <= 0.0 and lp > 0.0:
                for g in groups:
                    v = aval(g, acc, prior)
                    if v:
                        comp[g][mk]["churn"] += v
                continue
            # Existing account both months: classify by account net, reclass holds the offset.
            net = round(lc - lp, 2)
            pos = sum(d for d in deltas.values() if d > 0)
            neg = -sum(d for d in deltas.values() if d < 0)
            if net >= 0:
                for g, d in deltas.items():
                    exp_g = round(net * d / pos, 2) if (d > 0 and pos > 0) else 0.0
                    comp[g][mk]["expansion"] += exp_g
                    comp[g][mk]["reclassification"] += round(d - exp_g, 2)
            else:
                for g, d in deltas.items():
                    ctr_g = round((-net) * (-d) / neg, 2) if (d < 0 and neg > 0) else 0.0
                    comp[g][mk]["contraction"] += ctr_g
                    comp[g][mk]["reclassification"] += round(d + ctr_g, 2)

    for g in groups:
        for mk in display_months:
            for k in comp[g][mk]:
                comp[g][mk][k] = round(comp[g][mk][k], 2)
    return comp


@app.get("/api/arr-bridge/products")
async def get_arr_bridge_products(db: AsyncSession = Depends(get_db)):
    """All reconciled per-product ARR bridges (CRM, iCampaign, IQ & Marketing Reports, RVK Agents,
    Other) in one call. Product Ending ARR sums exactly to the Total bridge each month."""
    result = await _compute_all_product_bridges(db)
    if not result.get("has_data"):
        return {"display_months": result["display_months"], "products": [],
                "message": "Monthly ARR snapshot not yet built. Run 'Refresh app data' to populate it."}
    return {"display_months": result["display_months"], "products": result["products"], "message": None}


@app.get("/api/arr-bridge/by-product")
async def get_arr_bridge_by_product(
    product: str = Query("crm", description="Product family key: crm | icampaign | iq_mr | rvk | other."),
    db: AsyncSession = Depends(get_db),
):
    """Reconciled ARR bridge for a single product family (see /api/arr-bridge/products)."""
    key = (product or "").strip().lower()
    label = _PRODUCT_BRIDGE_DEFS.get(key)
    if not label:
        return {"bridge": [], "retention": [], "yoy": [], "display_months": [],
                "message": f"Unknown product '{product}'. Available: {', '.join(_PRODUCT_BRIDGE_DEFS)}."}
    result = await _compute_all_product_bridges(db)
    match = next((p for p in result["products"] if p["product"] == key), None)
    if not match:
        return {"bridge": [], "retention": [], "yoy": [], "display_months": result["display_months"],
                "message": f"No {label} ARR found. Run 'Refresh app data' first."}
    return {**match, "display_months": result["display_months"], "message": None}


# ── ARR bridge for a single month + Contracted ARR (for board-deck slide) ──────
# Plan ARR bridge lives in ARR_Calculations_2026P rows 10–15 (top "blended" section):
# row 15 (0-based 14) = "ARR EoP" plan series. Columns are 2026 months (BU = Jan 2026).
_ARR_PLAN_EOP_ROW_IDX = 14
_ARR_PLAN_SHEET_RANGE = "ARR_Calculations_2026P!A1:ZZ1000"


async def _eop_arr_plan_for_month(db: AsyncSession, month_key: str) -> Optional[float]:
    """End-of-period ARR plan for a 2026 month from ARR_Calculations_2026P row 15 ('ARR EoP').

    Returns None if the month is outside 2026 or the sheet snapshot is unavailable.
    """
    try:
        y, m = int(month_key[:4]), int(month_key[5:7])
    except (TypeError, ValueError):
        return None
    if y != 2026 or not (1 <= m <= 12):
        return None
    snap = (
        await db.execute(
            select(SheetSnapshot)
            .where(SheetSnapshot.range_name == _ARR_PLAN_SHEET_RANGE)
            .order_by(SheetSnapshot.as_of.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if not snap or not snap.data_json:
        return None
    try:
        data = json.loads(snap.data_json)
        row = data[_ARR_PLAN_EOP_ROW_IDX] if len(data) > _ARR_PLAN_EOP_ROW_IDX else []
        col_idx = _a1_col_to_index(ARR_2026P_MONTH_COLUMNS[m - 1])
        return _to_float_sheet(row[col_idx] if col_idx < len(row) else None)
    except (TypeError, ValueError, IndexError):
        return None


async def _arr_bridge_month_data(db: AsyncSession, month_key: str) -> dict:
    """Single-month ARR bridge + Contracted ARR, matching the board-deck 'ARR bridge and contracted ARR' slide.

    Bars: BoP ARR, New business, Expansion, Churn, Contraction, EoP ARR actual (= movement of MonthlyArrSnapshot),
    Future start date (closed-won NB/Expansion starting after month-end), EoP CARR actual (= EoP ARR + future start),
    Delta (= EoP ARR plan − EoP CARR actual), EoP ARR plan (ARR_Calculations_2026P 'ARR EoP').
    """
    prior_mk = _mk_offset(month_key, -1)
    snap_rows = (
        await db.execute(
            select(MonthlyArrSnapshot).where(MonthlyArrSnapshot.month_key.in_([prior_mk, month_key]))
        )
    ).scalars().all()
    arr_map: dict[str, dict[str, float]] = {}
    for s in snap_rows:
        arr_map.setdefault(s.account_name, {})[s.month_key] = s.arr
    accounts = list(arr_map.keys())

    def ga(acc: str, mk: str) -> float:
        return arr_map.get(acc, {}).get(mk, 0.0)

    beg = round(sum(ga(a, prior_mk) for a in accounts), 2)
    end = round(sum(ga(a, month_key) for a in accounts), 2)
    new_biz = exp = ctr = churn = 0.0
    for acc in accounts:
        p, c = ga(acc, prior_mk), ga(acc, month_key)
        if p == 0.0 and c > 0.0:
            new_biz += c
        elif p > 0.0 and c > p:
            exp += c - p
        elif p > 0.0 and 0.0 < c < p:
            ctr += p - c
        elif p > 0.0 and c == 0.0:
            churn += p

    y, m = int(month_key[:4]), int(month_key[5:7])
    month_end = date(y, m, calendar.monthrange(y, m)[1])
    future_start_total, _ = await _future_start_closed_won_nb_exp_arr_by_account(db, month_end)
    eop_plan = await _eop_arr_plan_for_month(db, month_key)
    carr = round(end + future_start_total, 2)

    return {
        "month": month_key,
        "month_end": month_end.isoformat(),
        "month_label": _short_month_label(month_key),
        "beginning_arr": beg,
        "new_business": round(new_biz, 2),
        "expansion": round(exp, 2),
        "churn": round(churn, 2),
        "contraction": round(ctr, 2),
        "ending_arr_actual": end,
        "future_start_arr": round(future_start_total, 2),
        "ending_carr_actual": carr,
        "ending_arr_plan": round(eop_plan, 2) if eop_plan is not None else None,
        "delta_plan_vs_carr": round(eop_plan - carr, 2) if eop_plan is not None else None,
        "has_data": len(snap_rows) > 0,
    }


@app.get("/api/slides/arr-bridge-month")
async def get_slides_arr_bridge_month(
    month: Optional[str] = Query(
        None,
        description="Target month YYYY-MM. Defaults to the previous calendar month (EST).",
    ),
    db: AsyncSession = Depends(get_db),
):
    """ARR bridge + contracted ARR for one month, used by the board-deck slide preview/export."""
    if not month:
        today = datetime.now(EST).date()
        y, m = today.year, today.month
        if m == 1:
            y, m = y - 1, 12
        else:
            m -= 1
        month = f"{y}-{m:02d}"
    data = await _arr_bridge_month_data(db, month)
    if not data.get("has_data"):
        data["message"] = "Monthly ARR snapshot not yet built for this month. Run 'Refresh app data' to populate it."
    return data


# ── Render the ARR-bridge slide into the Google Slides board deck ──────────────
_SLIDE_COLORS = {
    "total": "#1f9bd6",  # BoP / EoP actual / EoP CARR
    "up": "#7ac043",     # New business / Expansion / Future start
    "down": "#f5c542",   # Churn / Contraction
    "delta": "#e0584b",  # Delta vs plan
    "plan": "#c7ccd1",   # EoP ARR plan
    "title": "#1f9bd6",
}
_EMU_PER_INCH = 914400


def _hex_to_rgb01(hexstr: str) -> dict:
    h = hexstr.lstrip("#")
    return {
        "red": int(h[0:2], 16) / 255.0,
        "green": int(h[2:4], 16) / 255.0,
        "blue": int(h[4:6], 16) / 255.0,
    }


def _arr_bridge_waterfall_bars(data: dict) -> tuple[list[tuple], float, float]:
    """Return (bars, y_min, y_max) in $K. Each bar = (name, base, value, color_hex, label, is_total)."""
    K = 1000.0
    bop = data["beginning_arr"] / K
    nb = data["new_business"] / K
    exp = data["expansion"] / K
    churn = data["churn"] / K
    ctr = data["contraction"] / K
    eop = data["ending_arr_actual"] / K
    fs = data["future_start_arr"] / K
    carr = data["ending_carr_actual"] / K
    has_plan = data.get("ending_arr_plan") is not None
    plan = (data.get("ending_arr_plan") or 0) / K
    delta = (data.get("delta_plan_vs_carr") or 0) / K

    r1 = bop + nb
    r2 = r1 + exp
    r3 = r2 - churn
    r4 = r3 - ctr

    bars: list[tuple] = [
        ("BoP ARR", 0.0, bop, _SLIDE_COLORS["total"], bop, True),
        ("New business", bop, nb, _SLIDE_COLORS["up"], nb, False),
        ("Expansion", r1, exp, _SLIDE_COLORS["up"], exp, False),
        ("Churn", r3, churn, _SLIDE_COLORS["down"], churn, False),
        ("Contraction", r4, ctr, _SLIDE_COLORS["down"], ctr, False),
        ("EoP ARR actual", 0.0, eop, _SLIDE_COLORS["total"], eop, True),
        ("Future start date", eop, fs, _SLIDE_COLORS["up"], fs, False),
        ("EoP CARR actual", 0.0, carr, _SLIDE_COLORS["total"], carr, True),
    ]
    if has_plan:
        if delta >= 0:
            bars.append(("Delta", carr, delta, _SLIDE_COLORS["delta"], delta, False))
        else:
            bars.append(("Delta", plan, -delta, _SLIDE_COLORS["delta"], -delta, False))
        bars.append(("EoP ARR plan", 0.0, plan, _SLIDE_COLORS["plan"], plan, True))

    tops = [b[1] + b[2] for b in bars]
    max_top = max(tops + [1.0])
    totals = [b[2] for b in bars if b[5]]
    min_total = min(totals) if totals else 0.0
    y_min = max(0.0, float(int((min_total - 1200) // 500) * 500))
    y_max = float(int((max_top + 300 + 499) // 500) * 500)
    if y_max <= y_min:
        y_max = y_min + 500
    return bars, y_min, y_max


# Object-id prefixes for slides this app generates (used to keep generated slides as a contiguous block).
_GENERATED_SLIDE_PREFIXES = ("arrbridge_",)


def _arr_bridge_slide_requests(
    page_id: str, page_w: int, page_h: int, data: dict, insertion_index: Optional[int] = None
) -> list[dict]:
    """Build Slides batchUpdate requests that create a blank slide and draw the ARR-bridge waterfall on it."""
    bars, y_min, y_max = _arr_bridge_waterfall_bars(data)
    n = len(bars)
    create_slide: dict = {"objectId": page_id, "slideLayoutReference": {"predefinedLayout": "BLANK"}}
    if insertion_index is not None:
        create_slide["insertionIndex"] = insertion_index
    reqs: list[dict] = [{"createSlide": create_slide}]

    def text_box(obj_id: str, x: int, y: int, w: int, h: int, text: str,
                 size_pt: float, color_hex: str | None = None, bold: bool = False,
                 align: str = "CENTER") -> None:
        reqs.append({
            "createShape": {
                "objectId": obj_id,
                "shapeType": "TEXT_BOX",
                "elementProperties": {
                    "pageObjectId": page_id,
                    "size": {"height": {"magnitude": h, "unit": "EMU"}, "width": {"magnitude": w, "unit": "EMU"}},
                    "transform": {"scaleX": 1, "scaleY": 1, "translateX": x, "translateY": y, "unit": "EMU"},
                },
            }
        })
        reqs.append({"insertText": {"objectId": obj_id, "insertionIndex": 0, "text": text}})
        style: dict = {"fontSize": {"magnitude": size_pt, "unit": "PT"}, "bold": bold}
        fields = "fontSize,bold"
        if color_hex:
            style["foregroundColor"] = {"opaqueColor": {"rgbColor": _hex_to_rgb01(color_hex)}}
            fields += ",foregroundColor"
        reqs.append({"updateTextStyle": {"objectId": obj_id, "style": style, "fields": fields, "textRange": {"type": "ALL"}}})
        reqs.append({"updateParagraphStyle": {"objectId": obj_id, "style": {"alignment": align}, "fields": "alignment", "textRange": {"type": "ALL"}}})

    margin = int(0.55 * _EMU_PER_INCH)
    # Title + APPENDIX
    text_box(f"{page_id}_title", margin, int(0.32 * _EMU_PER_INCH), page_w - 2 * margin, int(0.6 * _EMU_PER_INCH),
             f"{data['month_label']} ARR bridge and contracted ARR", 22, _SLIDE_COLORS["title"], bold=True, align="START")
    text_box(f"{page_id}_appendix", page_w - margin - int(1.6 * _EMU_PER_INCH), int(0.34 * _EMU_PER_INCH),
             int(1.6 * _EMU_PER_INCH), int(0.3 * _EMU_PER_INCH), "APPENDIX", 10, _SLIDE_COLORS["title"], bold=True, align="END")

    # Chart geometry
    chart_left = int(0.7 * _EMU_PER_INCH)
    chart_top = int(1.35 * _EMU_PER_INCH)
    chart_right = page_w - int(0.5 * _EMU_PER_INCH)
    bottom_reserve = int(1.05 * _EMU_PER_INCH)
    chart_w = chart_right - chart_left
    chart_h = page_h - chart_top - bottom_reserve
    span = (y_max - y_min) or 1.0

    def y_emu(val_k: float) -> int:
        return int(chart_top + (y_max - val_k) / span * chart_h)

    slot_w = chart_w / n
    bar_w = int(slot_w * 0.62)
    chart_bottom = chart_top + chart_h

    # Horizontal gridlines + y-axis tick labels (every 500K), drawn before bars so bars sit on top.
    gi = 0
    v = y_min
    while v <= y_max + 1e-6:
        gy = y_emu(v)
        grid_id = f"{page_id}_grid{gi}"
        reqs.append({
            "createShape": {
                "objectId": grid_id,
                "shapeType": "RECTANGLE",
                "elementProperties": {
                    "pageObjectId": page_id,
                    "size": {"height": {"magnitude": int(0.008 * _EMU_PER_INCH), "unit": "EMU"}, "width": {"magnitude": chart_w, "unit": "EMU"}},
                    "transform": {"scaleX": 1, "scaleY": 1, "translateX": chart_left, "translateY": gy, "unit": "EMU"},
                },
            }
        })
        reqs.append({
            "updateShapeProperties": {
                "objectId": grid_id,
                "fields": "shapeBackgroundFill.solidFill.color,outline.propertyState",
                "shapeProperties": {
                    "shapeBackgroundFill": {"solidFill": {"color": {"rgbColor": _hex_to_rgb01("#e8eaed")}}},
                    "outline": {"propertyState": "NOT_RENDERED"},
                },
            }
        })
        text_box(f"{page_id}_yt{gi}", chart_left - int(0.72 * _EMU_PER_INCH), gy - int(0.09 * _EMU_PER_INCH),
                 int(0.62 * _EMU_PER_INCH), int(0.2 * _EMU_PER_INCH), f"{int(v):,}", 7, "#999999", bold=False, align="END")
        v += 500
        gi += 1

    for i, (name, base, value, color_hex, label, _is_total) in enumerate(bars):
        slot_x = chart_left + int(i * slot_w)
        bar_x = slot_x + int((slot_w - bar_w) / 2)
        top_val = base + value
        y_top = max(y_emu(top_val), chart_top)
        y_bot = min(y_emu(base), chart_bottom)  # totals start at value 0 → clamp to the axis floor
        bar_h = max(y_bot - y_top, int(0.02 * _EMU_PER_INCH))  # min visible sliver
        # Rectangle
        rect_id = f"{page_id}_bar{i}"
        reqs.append({
            "createShape": {
                "objectId": rect_id,
                "shapeType": "RECTANGLE",
                "elementProperties": {
                    "pageObjectId": page_id,
                    "size": {"height": {"magnitude": bar_h, "unit": "EMU"}, "width": {"magnitude": bar_w, "unit": "EMU"}},
                    "transform": {"scaleX": 1, "scaleY": 1, "translateX": bar_x, "translateY": y_top, "unit": "EMU"},
                },
            }
        })
        reqs.append({
            "updateShapeProperties": {
                "objectId": rect_id,
                "fields": "shapeBackgroundFill.solidFill.color,outline.propertyState",
                "shapeProperties": {
                    "shapeBackgroundFill": {"solidFill": {"color": {"rgbColor": _hex_to_rgb01(color_hex)}}},
                    "outline": {"propertyState": "NOT_RENDERED"},
                },
            }
        })
        # Value label above the bar
        text_box(f"{page_id}_lbl{i}", slot_x, y_top - int(0.26 * _EMU_PER_INCH), int(slot_w), int(0.24 * _EMU_PER_INCH),
                 f"{round(label):,}", 9, "#333333", bold=True, align="CENTER")
        # X-axis label below the chart
        text_box(f"{page_id}_xlbl{i}", slot_x, chart_top + chart_h + int(0.05 * _EMU_PER_INCH), int(slot_w), int(0.5 * _EMU_PER_INCH),
                 name, 8, "#555555", bold=False, align="CENTER")

    # Source footnote
    text_box(f"{page_id}_src", margin, page_h - int(0.4 * _EMU_PER_INCH), int(4 * _EMU_PER_INCH), int(0.25 * _EMU_PER_INCH),
             "Source: SFDC and Alleva reporting", 7, "#999999", bold=False, align="START")
    return reqs


@app.post("/api/slides/generate-arr-bridge")
async def generate_arr_bridge_slide(
    month: Optional[str] = Query(None, description="Target month YYYY-MM. Defaults to previous calendar month (EST)."),
    deck_id: Optional[str] = Query(None, description="Override the target Google Slides deck id (else GOOGLE_SLIDE_DECK_ID)."),
    db: AsyncSession = Depends(get_db),
):
    """Create/replace the ARR-bridge slide for a month in the board-deck Google Slides presentation (native shapes)."""
    if not month:
        today = datetime.now(EST).date()
        y, m = today.year, today.month
        if m == 1:
            y, m = y - 1, 12
        else:
            m -= 1
        month = f"{y}-{m:02d}"

    presentation_id = (deck_id or os.getenv("GOOGLE_SLIDE_DECK_ID") or "").strip()
    if not presentation_id:
        return {"ok": False, "error": "GOOGLE_SLIDE_DECK_ID is not set. Add the Google Slides deck id to the backend env."}

    data = await _arr_bridge_month_data(db, month)
    if not data.get("has_data"):
        return {"ok": False, "error": "No monthly ARR snapshot for this month. Run 'Refresh app data' first."}

    backend_dir = os.path.dirname(os.path.abspath(__file__))
    connector = GoogleSheetsConnector()
    connector.set_base_path(backend_dir)
    if not connector.is_configured():
        return {"ok": False, "error": "Google credentials not configured on the server."}

    page_id = f"arrbridge_{month.replace('-', '_')}"
    try:
        pres = connector.get_presentation(presentation_id)
        page_w = ((pres.get("pageSize") or {}).get("width") or {}).get("magnitude") or (10 * _EMU_PER_INCH)
        page_h = ((pres.get("pageSize") or {}).get("height") or {}).get("magnitude") or int(5.625 * _EMU_PER_INCH)
        page_w, page_h = int(page_w), int(page_h)

        slides_list = pres.get("slides") or []
        existing_ids = [s.get("objectId") for s in slides_list]
        existing_idx = existing_ids.index(page_id) if page_id in existing_ids else None

        if existing_idx is not None:
            # Regenerate in place: delete then reinsert at the same position.
            connector.slides_batch_update(presentation_id, [{"deleteObject": {"objectId": page_id}}])
            insertion_index = existing_idx
        else:
            # New slide: keep generated slides as a contiguous block starting at page 2 (index 1).
            generated_indices = [
                i for i, oid in enumerate(existing_ids)
                if oid and oid.startswith(_GENERATED_SLIDE_PREFIXES)
            ]
            insertion_index = (max(generated_indices) + 1) if generated_indices else 1
            insertion_index = min(insertion_index, len(existing_ids))

        reqs = _arr_bridge_slide_requests(page_id, page_w, page_h, data, insertion_index=insertion_index)
        connector.slides_batch_update(presentation_id, reqs)

        thumbnail_url = None
        try:
            thumbnail_url = connector.get_slide_thumbnail_url(presentation_id, page_id)
        except Exception:
            thumbnail_url = None

        deck_url = f"https://docs.google.com/presentation/d/{presentation_id}/edit#slide=id.{page_id}"
        return {
            "ok": True,
            "deck_url": deck_url,
            "slide_object_id": page_id,
            "thumbnail_url": thumbnail_url,
            "month": month,
            "replaced": existing_idx is not None,
        }
    except Exception as e:
        detail = str(e)
        low = detail.lower()
        sa_email = connector.get_service_account_email() or "the service account"
        if "403" in detail or "permission" in low or "forbidden" in low:
            msg = (
                f"Permission denied. Share the deck with {sa_email} as Editor, and make sure the "
                f"Google Slides API is enabled in the project. {detail[:240]}"
            )
        elif ("not supported" in low or "not a google" in low) or ("400" in detail and "presentation" in low):
            msg = (
                "This file may not be a native Google Slides deck (e.g. an uploaded .pptx). "
                f"Convert it via File → Save as Google Slides. {detail[:240]}"
            )
        elif "has not been used" in low or "is disabled" in low or "slides.googleapis.com" in low:
            msg = f"The Google Slides API is not enabled for this project yet. Enable it, then retry. {detail[:240]}"
        else:
            msg = f"Failed to generate slide: {detail[:280]}"
        return {"ok": False, "error": msg}


@app.get("/api/analytics/active-arr-by-product")
async def get_active_arr_by_product(
    as_of: Optional[date] = Query(
        None,
        description="As-of date (YYYY-MM-DD). Defaults to the last day of the previous month in EST.",
    ),
    db: AsyncSession = Depends(get_db),
):
    """
    Active ARR by product line, using the **same reconciled split as the ARR bridges** so the numbers
    tie to the Total ARR bridge.

    For the requested month-end it takes each account's authoritative Total ARR (MonthlyArrSnapshot) and
    splits it across the bridge product families — CRM, iCampaign, IQ & Marketing Reports, RVK Agents,
    and an Other catch-all — by the account's Salesforce line-item mix. Σ families = the Total bridge
    that month. Includes every account (Alleva included) and returns per-account family ARR for the
    product-penetration / white-space panels. Defaults to the previous month-end.
    """
    # Default as-of = last day of previous month in EST (e.g. end of February when today is in March).
    if as_of is None:
        now_est = datetime.now(EST)
        year, month = now_est.year, now_est.month
        if month == 1:
            year -= 1
            month = 12
        else:
            month -= 1
        last_day = calendar.monthrange(year, month)[1]
        as_of = date(year, month, last_day)

    month_key = f"{as_of.year}-{as_of.month:02d}"

    groups_keys = list(_PRODUCT_BRIDGE_DEFS.keys())          # crm, icampaign, iq_mr, rvk, other
    named_groups = [g for g in groups_keys if g != "other"]

    # Same reconciled per-account product split that powers the ARR bridges, taken at this month-end,
    # so the product-line totals tie to the Total ARR bridge, include RVK, and include Alleva.
    snap, alloc = await _reconciled_product_alloc(
        db, month_keys=[month_key], snap_from=month_key, snap_to=month_key, named_groups=named_groups
    )

    acc_total: dict[str, float] = {
        acc: round(months.get(month_key, 0.0), 2)
        for acc, months in snap.items()
        if months.get(month_key, 0.0)
    }
    if not acc_total:
        return JSONResponse(content={
            "as_of": as_of.isoformat(), "month_key": month_key,
            "groups": [], "accounts": [], "grand_total": 0.0,
        })

    grand_total = round(sum(acc_total.values()), 2)

    group_arr: dict[str, float] = {
        g: round(sum(alloc.get(g, {}).get(acc, {}).get(month_key, 0.0) for acc in acc_total), 2)
        for g in groups_keys
    }
    group_list = [
        {
            "key": g,
            "label": _PRODUCT_BRIDGE_DEFS[g],
            "arr": group_arr[g],
            "mix": round(group_arr[g] / grand_total * 100, 1) if grand_total > 0 else 0.0,
        }
        for g in groups_keys
    ]

    # Salesforce account-id map for deep links on the penetration panels.
    id_map: dict[str, str] = {}
    id_r = await db.execute(
        select(Opportunity.account_id, Opportunity.account_name)
        .where(Opportunity.account_name.in_(list(acc_total.keys())))
        .distinct()
    )
    for row in id_r:
        if row.account_name and row.account_name not in id_map and row.account_id:
            id_map[row.account_name] = row.account_id

    # Per-account family ARR for the product-penetration / white-space panels (RVK + Alleva included).
    accounts_out = [
        {
            "account_id": id_map.get(acc),
            "account_name": acc,
            "arr": tot,
            "by_group": {g: round(alloc.get(g, {}).get(acc, {}).get(month_key, 0.0), 2) for g in groups_keys},
        }
        for acc, tot in acc_total.items()
    ]
    accounts_out.sort(key=lambda x: -x["arr"])

    base = os.getenv("SALESFORCE_BASE_URL", "").strip().rstrip("/")
    resp: dict = {
        "as_of": as_of.isoformat(),
        "month_key": month_key,
        "groups": group_list,
        "grand_total": grand_total,
        "accounts": accounts_out,
    }
    if base:
        resp["salesforce_base_url"] = base
    return JSONResponse(content=resp)


def _default_schedule_by_month_keys() -> list[str]:
    """Month columns for the original Schedule view: Dec '24 through Dec '26."""
    months: list[str] = []
    for year in (2024, 2025, 2026):
        for month in range(1, 13):
            if year == 2024 and month < 12:
                continue
            if year == 2026 and month > 12:
                break
            months.append(f"{year}-{month:02d}")
    return months


def _new_schedule_month_keys() -> list[str]:
    """Month columns for NEW SCHEDULE: Dec '25 through Dec '26 (active ARR on each month-end)."""
    return ["2025-12"] + [f"2026-{m:02d}" for m in range(1, 13)]


def _apply_active_arr_by_month(out_rows: list[dict], months: list[str]) -> dict[str, float]:
    """
    Mutates each row with ``by_month`` for the given month keys. Same rules as the Schedule export.
    Returns ``totals_by_month`` (sum across rows).
    """
    totals_by_month: dict[str, float] = {m: 0.0 for m in months}
    for row in out_rows:
        sub_start_s = row.get("subscription_start_date")
        sub_end_s = row.get("subscription_end_date")
        sub_start = date.fromisoformat(sub_start_s) if sub_start_s else None
        sub_end = date.fromisoformat(sub_end_s) if sub_end_s else None
        anchor_arr = row.get("anchor_arr") or 0.0
        expansions = row.get("expansions") or []
        acct_type_norm = ((row.get("type") or None) or "").strip().lower()
        alleva_factor: float | None = None
        if acct_type_norm == "alleva customer":
            raw_factor = row.get("alleva_retained_factor")
            if raw_factor is not None:
                try:
                    alleva_factor = float(raw_factor)
                except (TypeError, ValueError):
                    alleva_factor = None
        periods = row.get("periods") or []
        pre_start_s = row.get("pre_anchor_start")
        pre_end_s = row.get("pre_anchor_end")
        pre_base = float(row.get("pre_anchor_base_arr") or 0.0)
        pre_exps = row.get("pre_anchor_expansions") or []
        pre_start = date.fromisoformat(pre_start_s) if pre_start_s else None
        pre_end = date.fromisoformat(pre_end_s) if pre_end_s else None

        by_month: dict[str, float] = {}
        for month_key in months:
            y, m = int(month_key[:4]), int(month_key[5:7])
            _, last_day = calendar.monthrange(y, m)
            month_end = date(y, m, last_day)

            val = 0.0
            if periods:
                for p in periods:
                    try:
                        p_start = date.fromisoformat(p["start"]) if isinstance(p.get("start"), str) else p.get("start")
                        p_end_val = date.fromisoformat(p["end"]) if isinstance(p.get("end"), str) else p.get("end")
                    except (TypeError, ValueError):
                        continue
                    if p_start is not None and p_end_val is not None and p_start <= month_end <= p_end_val:
                        try:
                            val = float(p.get("arr") or 0.0)
                        except (TypeError, ValueError):
                            val = 0.0
                        break
            elif pre_start is not None and pre_end is not None and pre_base > 0 and pre_start <= month_end <= pre_end:
                pre_exp_sum = 0.0
                for exp in pre_exps:
                    cd = exp.get("close_date")
                    try:
                        cd_date = date.fromisoformat(cd) if cd else None
                    except (TypeError, ValueError):
                        cd_date = None
                    if cd_date and cd_date <= month_end:
                        try:
                            pre_exp_sum += float(exp.get("arr") or 0.0)
                        except (TypeError, ValueError):
                            continue
                val = round(pre_base + pre_exp_sum, 2)
            else:
                if sub_start is not None and month_end < sub_start:
                    val = 0.0
                elif sub_end is not None and month_end > sub_end:
                    val = 0.0
                else:
                    expansion_arr = sum(
                        exp["arr"] for exp in expansions
                        if exp.get("close_date") and date.fromisoformat(exp["close_date"]) <= month_end
                    )
                    val = round(anchor_arr + expansion_arr, 2)

            if alleva_factor is not None:
                val = round(val * alleva_factor, 2)

            by_month[month_key] = val
            totals_by_month[month_key] = round(totals_by_month[month_key] + val, 2)
        row["by_month"] = by_month
    return totals_by_month


async def _get_active_arr_by_month_data(
    db: AsyncSession,
) -> tuple[list[dict], list[str], dict[str, float], Optional[str]]:
    """
    Returns (rows with by_month filled, months list, totals_by_month, base_url) for the ARR schedule.
    Used by active-arr-by-month GET and by the Copilot ARR export to Google Sheet.
    """
    out_rows, base_url = await _compute_active_arr_rows(db, apply_alleva_retained_arr_adjustment=True)
    months = _default_schedule_by_month_keys()
    totals_by_month = _apply_active_arr_by_month(out_rows, months)
    return (out_rows, months, totals_by_month, base_url)


def _short_month_label(month_key: str) -> str:
    """e.g. 2024-12 -> Dec '24"""
    parts = month_key.split("-")
    if len(parts) != 2:
        return month_key
    y, m = int(parts[0]), int(parts[1])
    names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    return f"{names[m - 1]} '{str(y)[2:]}"


def _fmt_money_export(n: float):
    """Format for spreadsheet export: same as Schedule view — US currency with 2 decimals (e.g. $52,705.44, $0.00)."""
    try:
        val = float(n) if n is not None else 0.0
    except (TypeError, ValueError):
        val = 0.0
    return f"${val:,.2f}"


# ── Churn Analysis ────────────────────────────────────────────────────────────

_CHURN_REPORT_ID = "00OVq00000Bg05JMAR"


def _month_key_to_period(month_key: str) -> Optional[date]:
    """Convert 'YYYY-MM' to last day of that month as a date."""
    try:
        y, m = int(month_key[:4]), int(month_key[5:7])
        last_day = calendar.monthrange(y, m)[1]
        return date(y, m, last_day)
    except Exception:
        return None


@app.get("/api/churn/records")
async def get_churn_records(db: AsyncSession = Depends(get_db)):
    """Return all churned account records with SF attributes."""
    r = await db.execute(
        select(ChurnRecord).order_by(ChurnRecord.churn_month.desc(), ChurnRecord.churn_arr.desc())
    )
    records = r.scalars().all()
    out = []
    for rec in records:
        attrs = json.loads(rec.sf_attributes_json) if rec.sf_attributes_json else {}
        out.append({
            "id": rec.id,
            "account_name": rec.account_name,
            "sf_account_id": rec.sf_account_id,
            "churn_month": rec.churn_month,
            "churn_arr": rec.churn_arr,
            "tenure_months": rec.tenure_months,
            "first_arr_month": rec.first_arr_month,
            "industry": rec.industry,
            "segment": rec.segment,
            "region": rec.region,
            "account_type": rec.account_type,
            "churn_reason": rec.churn_reason,
            "health_score": rec.health_score,
            "synced_at": rec.synced_at.isoformat() if rec.synced_at else None,
            "sf_attributes": attrs,
        })
    return out


@app.get("/api/churn/observations")
async def get_churn_observations(db: AsyncSession = Depends(get_db)):
    """Return the latest AI-generated churn observations."""
    r = await db.execute(
        select(ChurnObservations).order_by(ChurnObservations.generated_at.desc()).limit(1)
    )
    obs = r.scalar_one_or_none()
    if not obs:
        return {"observations": [], "summary": None, "patterns": {}, "total_churned": 0, "total_churn_arr": 0, "generated_at": None}
    return {
        "observations": json.loads(obs.observations_json) if obs.observations_json else [],
        "summary": obs.summary,
        "patterns": json.loads(obs.patterns_json) if obs.patterns_json else {},
        "total_churned": obs.total_churned,
        "total_churn_arr": obs.total_churn_arr,
        "generated_at": obs.generated_at.isoformat() if obs.generated_at else None,
    }


@app.get("/api/churn/summary")
async def get_churn_summary(db: AsyncSession = Depends(get_db)):
    """Return churn summary stats and pattern breakdowns from the stored records."""
    r = await db.execute(select(ChurnRecord).order_by(ChurnRecord.churn_month.desc()))
    records = r.scalars().all()
    if not records:
        return {"total": 0, "total_arr": 0, "synced_at": None, "by_industry": {}, "by_segment": {}, "by_tenure_bucket": {}, "by_arr_bucket": {}, "by_month": {}}

    synced_at = max((rec.synced_at for rec in records if rec.synced_at), default=None)

    by_industry: dict[str, dict] = {}
    by_segment: dict[str, dict] = {}
    by_tenure: dict[str, dict] = {}
    by_arr: dict[str, dict] = {}
    by_month: dict[str, dict] = {}

    def _add(bucket: dict, key: str, arr: float):
        key = key or "Unknown"
        if key not in bucket:
            bucket[key] = {"count": 0, "arr": 0.0}
        bucket[key]["count"] += 1
        bucket[key]["arr"] = round(bucket[key]["arr"] + arr, 2)

    for rec in records:
        arr = rec.churn_arr or 0
        _add(by_industry, rec.industry or "Unknown", arr)
        _add(by_segment, rec.segment or "Unknown", arr)
        _add(by_month, rec.churn_month or "Unknown", arr)

        # Tenure buckets
        t = rec.tenure_months
        if t is None:
            tbkt = "Unknown"
        elif t < 6:
            tbkt = "<6 months"
        elif t < 12:
            tbkt = "6–12 months"
        elif t < 24:
            tbkt = "1–2 years"
        else:
            tbkt = "2+ years"
        _add(by_tenure, tbkt, arr)

        # ARR size buckets
        if arr < 10_000:
            abkt = "<$10K"
        elif arr < 25_000:
            abkt = "$10–25K"
        elif arr < 50_000:
            abkt = "$25–50K"
        elif arr < 100_000:
            abkt = "$50–100K"
        else:
            abkt = "$100K+"
        _add(by_arr, abkt, arr)

    total_arr = sum(rec.churn_arr or 0 for rec in records)
    return {
        "total": len(records),
        "total_arr": round(total_arr, 2),
        "synced_at": synced_at.isoformat() if synced_at else None,
        "by_industry": dict(sorted(by_industry.items(), key=lambda x: -x[1]["arr"])),
        "by_segment": dict(sorted(by_segment.items(), key=lambda x: -x[1]["arr"])),
        "by_tenure_bucket": by_tenure,
        "by_arr_bucket": by_arr,
        "by_month": dict(sorted(by_month.items())),
    }


@app.post("/api/churn/sync")
async def sync_churn_data(db: AsyncSession = Depends(get_db)):
    """
    1. Identify churned accounts from MonthlyArrSnapshot (ARR → 0).
    2. Fetch the Salesforce churn report for account attributes.
    3. Join by account name, upsert ChurnRecord rows.
    """
    from connectors.salesforce import SalesforceConnector

    connector = SalesforceConnector()
    if not connector.is_configured():
        raise HTTPException(status_code=503, detail="Salesforce not configured.")

    # ── Step 1: build full ARR history and identify churned accounts ──────────
    # Use _build_arr_history_data directly — it merges Google Sheet + Salesforce
    # and includes all months (with zeros) so we can detect when ARR dropped to 0.
    try:
        history = await _build_arr_history_data(db)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not build ARR history: {e}")

    history_rows = history.get("rows", [])
    all_months = history.get("month_columns", [])

    if not history_rows:
        return {
            "ok": False,
            "churned_found": 0,
            "sf_rows": 0,
            "message": (
                "No ARR history data found. "
                "Please sync your Google Sheet (ARR_Schedule tab) and/or Salesforce data first, "
                "then try again. You can do this from the Admin page → Refresh app data."
            ),
        }

    # Note: arr_by_month only contains non-zero months (zeros are stripped when stored).
    # Churn is detected by: account had ARR > 0 in the past but their last active month
    # is before the current month, meaning they are no longer an active customer.
    today_mk = datetime.now(EST).strftime("%Y-%m")
    # Use the most recent month in the history as the "data as-of" marker
    data_as_of = max(all_months) if all_months else today_mk
    churned: list[dict] = []

    for row in history_rows:
        account_name = row.get("account_name", "")
        if not account_name:
            continue
        arr_by_month: dict[str, float] = row.get("arr_by_month", {})
        active_months = sorted(m for m, v in arr_by_month.items() if (v or 0) > 0)
        if not active_months:
            continue

        first_arr_month = active_months[0]
        last_arr_month = active_months[-1]

        # An account has churned if its last ARR month is before the latest data period.
        # We allow a 1-month lag (since ARR schedule may not be 100% up to date).
        if last_arr_month >= _mk_offset(data_as_of, -1):
            continue  # still active

        churn_month = _mk_offset(last_arr_month, 1)  # first month with $0 ARR
        churn_arr = arr_by_month.get(last_arr_month, 0.0)

        tenure = None
        try:
            fy, fm = int(first_arr_month[:4]), int(first_arr_month[5:7])
            cy, cm = int(churn_month[:4]), int(churn_month[5:7])
            tenure = (cy - fy) * 12 + (cm - fm)
        except Exception:
            pass

        churned.append({
            "account_name": account_name,
            "churn_month": churn_month,
            "churn_arr": churn_arr,
            "first_arr_month": first_arr_month,
            "tenure_months": tenure,
        })

    if not churned:
        return {
            "ok": True,
            "churned_found": 0,
            "sf_rows": 0,
            "message": (
                f"No churned accounts identified from {len(history_rows)} accounts in ARR history "
                f"({len(all_months)} months). All accounts appear to still be active."
            ),
        }

    # ── Step 2: fetch Salesforce report ──────────────────────────────────────
    sf_rows_by_name: dict[str, dict] = {}
    sf_error = None
    try:
        report_result = await asyncio.to_thread(connector.run_report, _CHURN_REPORT_ID)
        sf_rows = connector.extract_report_rows(report_result)
        # Index by Account Name (try several common column names)
        for row in sf_rows:
            name_key = next((k for k in row if "account" in k.lower() and "name" in k.lower()), None) or next((k for k in row if "name" in k.lower()), None)
            if name_key and row.get(name_key):
                sf_rows_by_name[str(row[name_key]).strip().lower()] = row
    except Exception as e:
        sf_error = str(e)

    # ── Step 3: upsert ChurnRecord rows ──────────────────────────────────────
    # Clear existing records
    await db.execute(delete(ChurnRecord))
    await db.flush()

    def _extract(row: dict, *keys: str) -> Optional[str]:
        for k in keys:
            for col, val in row.items():
                if col.lower().replace(" ", "_") == k.lower().replace(" ", "_") or k.lower() in col.lower():
                    return str(val).strip() if val else None
        return None

    inserted = 0
    for c in churned:
        sf_row = sf_rows_by_name.get(c["account_name"].strip().lower(), {})
        db.add(ChurnRecord(
            account_name=c["account_name"],
            churn_month=c["churn_month"],
            churn_arr=c["churn_arr"],
            first_arr_month=c["first_arr_month"],
            tenure_months=c["tenure_months"],
            sf_attributes_json=json.dumps(sf_row) if sf_row else None,
            industry=_extract(sf_row, "industry", "vertical"),
            segment=_extract(sf_row, "segment", "tier", "account_tier"),
            region=_extract(sf_row, "region", "territory", "state"),
            account_type=_extract(sf_row, "type", "account_type"),
            churn_reason=_extract(sf_row, "churn_reason", "lost_reason", "cancellation_reason", "reason"),
            health_score=None,
        ))
        inserted += 1

    await db.commit()

    return {
        "ok": True,
        "churned_found": inserted,
        "sf_rows": len(sf_rows_by_name),
        "sf_error": sf_error,
        "message": f"Synced {inserted} churned accounts." + (f" SF report error: {sf_error}" if sf_error else ""),
    }


@app.post("/api/churn/ai-analyze")
async def churn_ai_analyze(db: AsyncSession = Depends(get_db)):
    """Use Claude to analyze churn patterns and generate observations."""
    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured")

    r = await db.execute(
        select(ChurnRecord).order_by(ChurnRecord.churn_month.desc())
    )
    records = r.scalars().all()
    if not records:
        raise HTTPException(status_code=400, detail="No churn records. Run sync first.")

    # Build a rich context block for Claude
    total_arr = sum(rec.churn_arr or 0 for rec in records)
    context_lines = [
        f"Total churned accounts: {len(records)}",
        f"Total churn ARR: ${total_arr:,.0f}",
        "",
        "Churned account details (sorted by ARR lost, most recent first):",
        "Account | Churn Month | ARR Lost | Tenure (mo) | Industry | Segment | Region | Type | Reason | SF Attributes",
        "---",
    ]
    for rec in sorted(records, key=lambda r: (r.churn_month or "", -(r.churn_arr or 0)), reverse=True)[:80]:
        attrs = json.loads(rec.sf_attributes_json) if rec.sf_attributes_json else {}
        # Include all SF attributes as key=value pairs
        attr_str = " | ".join(f"{k}: {v}" for k, v in attrs.items() if v and str(v).strip() and v != "None")
        context_lines.append(
            f"{rec.account_name} | {rec.churn_month} | ${rec.churn_arr:,.0f} | "
            f"{rec.tenure_months or '?'} | {rec.industry or '?'} | {rec.segment or '?'} | "
            f"{rec.region or '?'} | {rec.account_type or '?'} | {rec.churn_reason or '?'} | {attr_str}"
        )

    prompt = f"""You are analyzing churn data for Dazos, a ~$7M ARR behavioral health CRM SaaS company.
Below is the full list of churned/cancelled accounts from the ARR schedule, enriched with Salesforce attributes.

{chr(10).join(context_lines)}

Produce a comprehensive churn analysis with these sections:

## Executive Summary
2–3 sentences: headline churn picture, most important driver, what it means for the business.

## Key Patterns
Identify the 4–6 most statistically significant patterns in this churn data. For each pattern:
- Lead with the data point (e.g. "67% of churn ARR came from accounts with < 12 months tenure")
- Explain the likely root cause
- Assign a risk level: High / Medium / Low

## Breakdown by Dimension
For each dimension where you see a meaningful signal, provide a ranked table:
- By industry/vertical
- By segment or account size
- By tenure cohort
- By churn reason (if available)
- By time period (any acceleration or deceleration?)

## Early Warning Indicators
Based on the patterns, what are the 3–5 leading indicators that predict churn risk? Frame as: "Accounts that [characteristic] are X× more likely to churn."

## Recommended Actions
3–5 specific, prioritized actions for the CS and leadership team. Be concrete — name the segment, the intervention, and the expected impact.

Be specific with numbers throughout. If data is limited or patterns are unclear, say so explicitly."""

    try:
        if not _ANTHROPIC_AVAILABLE:
            raise HTTPException(status_code=503, detail="anthropic package not installed on server")
        client = _anthropic_mod.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
        response = await client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=4096,
            system=_FPA_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": prompt}],
        )
        analysis_text = response.content[0].text if response.content else ""
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Claude error: {e}")

    # Parse into bullet observations (extract bullet lines for the observations list)
    obs_bullets = [
        line.lstrip("•-– ").strip()
        for line in analysis_text.split("\n")
        if line.strip().startswith(("-", "•", "–")) and len(line.strip()) > 10
    ][:15]

    # Build pattern summary for quick stats
    summary_r = await db.execute(select(ChurnRecord))
    all_recs = summary_r.scalars().all()
    by_industry: dict[str, float] = {}
    by_segment: dict[str, float] = {}
    for rec in all_recs:
        k = rec.industry or "Unknown"
        by_industry[k] = by_industry.get(k, 0) + (rec.churn_arr or 0)
        k2 = rec.segment or "Unknown"
        by_segment[k2] = by_segment.get(k2, 0) + (rec.churn_arr or 0)

    patterns = {
        "by_industry": dict(sorted(by_industry.items(), key=lambda x: -x[1])[:8]),
        "by_segment": dict(sorted(by_segment.items(), key=lambda x: -x[1])[:6]),
    }

    # Save
    await db.execute(delete(ChurnObservations))
    db.add(ChurnObservations(
        observations_json=json.dumps(obs_bullets),
        summary=analysis_text[:600],  # first ~600 chars as preview
        patterns_json=json.dumps(patterns),
        total_churned=len(records),
        total_churn_arr=total_arr,
    ))
    await db.commit()

    return {"ok": True, "observations": len(obs_bullets), "analysis_length": len(analysis_text)}


@app.get("/api/salesforce/eod-snapshots/{snapshot_date}")
async def get_eod_snapshot_contents(
    snapshot_date: str,
    db: AsyncSession = Depends(get_db),
    full: Optional[bool] = Query(False, description="Include full payload (accounts, opportunities, line items)"),
):
    """
    Return contents of the EOD snapshot for a given date (YYYY-MM-DD).
    By default returns a summary (counts + CARR). Use ?full=1 to get the full JSON payload.
    """
    date_str = snapshot_date.strip()
    try:
        target = date.fromisoformat(date_str)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date; use YYYY-MM-DD")
    r = await db.execute(
        select(SalesforceEODSnapshot).where(SalesforceEODSnapshot.snapshot_date == target).limit(1)
    )
    row = r.scalar_one_or_none()
    # Fallback: some DBs store dates differently; find by matching date string
    if not row:
        r2 = await db.execute(
            select(SalesforceEODSnapshot).order_by(SalesforceEODSnapshot.snapshot_date.desc())
        )
        for candidate in r2.scalars().all():
            if candidate.snapshot_date and candidate.snapshot_date.isoformat() == date_str:
                row = candidate
                break
    if not row or not row.data_json:
        raise HTTPException(status_code=404, detail=f"No EOD snapshot found for {snapshot_date}")
    payload = json.loads(row.data_json)
    accounts = payload.get("accounts") or []
    opportunities = payload.get("opportunities") or []
    line_items = payload.get("opportunity_line_items") or []
    arr_data = _arr_from_snapshot_payload(payload)
    out = {
        "snapshot_date": row.snapshot_date.isoformat(),
        "snapshot_utc": row.snapshot_utc.isoformat() if row.snapshot_utc else None,
        "counts": {"accounts": len(accounts), "opportunities": len(opportunities), "opportunity_line_items": len(line_items)},
        "carr_summary": {"grand_total": arr_data.get("grand_total"), "accounts_with_arr": len(arr_data.get("rows") or [])},
    }
    if full:
        out["payload"] = payload
    return out


@app.post("/api/salesforce/eod-snapshots/take")
async def take_eod_snapshot_now(db: AsyncSession = Depends(get_db)):
    """
    Capture an EOD snapshot from current SQLite CRM state (same shape as the scheduled 23:59 job).
    Requires X-App-Password if APP_PASSWORD is set.
    """
    try:
        await _take_salesforce_eod_snapshot(db)
        await db.commit()
        return {"ok": True, "message": "EOD snapshot saved. Check GET /api/salesforce/eod-snapshots to verify."}
    except Exception as e:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/arr-schedule/backfill")
async def backfill_arr_schedule(db: AsyncSession = Depends(get_db)):
    """
    Backfill arr_schedule_daily from existing EOD snapshots. Run once to populate historical ARR-by-account-by-date.
    """
    r = await db.execute(
        select(SalesforceEODSnapshot.snapshot_date, SalesforceEODSnapshot.data_json).order_by(SalesforceEODSnapshot.snapshot_date.asc())
    )
    rows = r.all()
    if not rows:
        return {"ok": True, "message": "No EOD snapshots to backfill.", "dates_processed": 0}
    try:
        for snapshot_date, data_json in rows:
            if not data_json:
                continue
            payload = json.loads(data_json)
            await _materialize_arr_schedule_daily(db, payload, snapshot_date)
        await db.commit()
        return {"ok": True, "message": f"Backfilled arr_schedule_daily from {len(rows)} EOD snapshot(s).", "dates_processed": len(rows)}
    except Exception as e:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


async def _take_salesforce_eod_snapshot(db: AsyncSession) -> None:
    """Store end-of-day snapshot of CRM tables as they exist in SQLite (EST calendar date, UTC timestamp). Caller must commit.
    Data matches whatever was last loaded into the DB (Dashboard → Refresh app data), not a live Salesforce pull in this call.
    Captures applicable Salesforce IDs: account_sf_id for accounts, opportunity_sf_id and account_sf_id for opportunities, opportunity_sf_id for line items."""
    from datetime import timezone

    now_utc = datetime.now(timezone.utc)
    today_est = datetime.fromtimestamp(now_utc.timestamp(), tz=EST).date()

    r_acc = await db.execute(select(Account))
    accounts = [
        {
            "sf_id": a.sf_id,
            "account_sf_id": a.sf_id,
            "name": a.name,
            "type": a.type,
            "status": a.status,
            "segment": (a.segment or "").strip() or DEFAULT_SEGMENT,
            "industry": a.industry,
            "annual_revenue": a.annual_revenue,
            "number_of_employees": a.number_of_employees,
            "billing_country": a.billing_country,
            "billing_city": a.billing_city,
            "billing_state": a.billing_state,
            "phone": a.phone,
            "website": a.website,
            "created_date": a.created_date.isoformat() if a.created_date else None,
            "synced_at": a.synced_at.isoformat() if a.synced_at else None,
        }
        for a in r_acc.scalars().all()
    ]
    r_opp = await db.execute(select(Opportunity))
    opportunities = [
        {
            "sf_id": o.sf_id,
            "opportunity_sf_id": o.sf_id,
            "account_id": o.account_id,
            "account_sf_id": o.account_id,
            "name": o.name,
            "amount": o.amount,
            "close_date": o.close_date.isoformat() if o.close_date else None,
            "renewal_date": o.renewal_date.isoformat() if o.renewal_date else None,
            "stage_name": o.stage_name,
            "type": o.type,
            "record_type_name": o.record_type_name,
            "account_name": o.account_name,
            "mrr": o.mrr,
            "original_acv": o.original_acv,
            "created_date": o.created_date.isoformat() if o.created_date else None,
            "synced_at": o.synced_at.isoformat() if o.synced_at else None,
        }
        for o in r_opp.scalars().all()
    ]
    r_li = await db.execute(select(OpportunityLineItem))
    line_items = [
        {
            "opportunity_sf_id": li.opportunity_sf_id,
            "product_name": li.product_name,
            "quantity": li.quantity,
            "unit_price": li.unit_price,
            "total_price": li.total_price,
            "synced_at": li.synced_at.isoformat() if li.synced_at else None,
        }
        for li in r_li.scalars().all()
    ]

    payload = {"accounts": accounts, "opportunities": opportunities, "opportunity_line_items": line_items}
    await db.execute(delete(SalesforceEODSnapshot).where(SalesforceEODSnapshot.snapshot_date == today_est))
    snapshot = SalesforceEODSnapshot(
        snapshot_date=today_est,
        snapshot_utc=now_utc.replace(tzinfo=None),
        data_json=json.dumps(payload),
    )
    db.add(snapshot)
    await _materialize_arr_schedule_daily(db, payload, today_est)


async def _take_forecast_snapshot(db: AsyncSession) -> int:
    """Save a point-in-time snapshot of the current quarter forecast.
    Called automatically on the 1st of each month and via POST /api/forecast/snapshot.
    Returns the number of month rows saved."""
    from sqlalchemy.dialects.sqlite import insert as sqlite_insert

    today = datetime.now(EST).date()
    q_start_mo = ((today.month - 1) // 3) * 3 + 1
    q_year = today.year
    months = [f"{q_year}-{(q_start_mo + i):02d}" for i in range(3)]

    # Get the current forecast data by calling the same logic inline
    # We re-use the endpoint's DB session — just call the core helper
    # Build a minimal version: load actuals + pipeline + in-quarter estimates

    def _mk_to_date_range(mk: str) -> tuple[date, date]:
        y, m = int(mk[:4]), int(mk[5:])
        return date(y, m, 1), date(y, m, calendar.monthrange(y, m)[1])

    _q = select(Opportunity)
    _r = await db.execute(_q)
    all_opps: list[Opportunity] = list(_r.scalars().all())
    overrides = await _get_record_type_overrides(db)

    def _eff_rt_snap(o: Opportunity) -> str:
        _key = (o.sf_id or "").strip()
        _ov = overrides.get(_key) or (overrides.get(_key[:15]) if len(_key) >= 15 else None)
        return (_ov or o.record_type_name or "").strip()

    open_sf_ids = {o.sf_id for o in all_opps if not _is_closed_won_stage(o.stage_name) and not _is_closed_lost_stage(o.stage_name) and o.sf_id}
    opp_to_line_arr = await _line_item_arr_for_opportunities(db, open_sf_ids)

    def _pipeline_arr_snap(o: Opportunity) -> float:
        if o.mrr is not None and o.mrr != 0:
            return round(float(o.mrr) * PIPELINE_ARR_MULTIPLIER, 2)
        return opp_to_line_arr.get(o.sf_id, 0.0)

    iq_rates = await _compute_in_quarter_rates(db)

    # Latest AI scores
    latest_ai_r = await db.execute(select(func.max(DealAIScore.scored_at)))
    latest_ai_at = latest_ai_r.scalar_one_or_none()
    ai_scores: dict[str, float] = {}
    if latest_ai_at:
        ai_r = await db.execute(select(DealAIScore).where(DealAIScore.scored_at == latest_ai_at))
        for s in ai_r.scalars().all():
            ai_scores[s.sf_opp_id] = s.probability

    saved = 0
    for mk in months:
        d_start, d_end = _mk_to_date_range(mk)
        actuals_end = today if mk == today.strftime("%Y-%m") else d_end

        _nb_total, nb_actual, _nb_exp = await _closed_won_arr_in_range(db, d_start, actuals_end)
        _exp_total, _exp_nb, exp_mid = await _closed_won_arr_in_range(db, d_start, actuals_end)
        exp_upon = await _closed_won_renewal_expansion_arr_in_range(db, d_start, actuals_end)
        exp_actual = round(exp_mid + exp_upon, 2)

        def _weighted_snap(o: Opportunity) -> float:
            fc = (o.forecast_category or "").strip()
            w = _FC_NB_EXP_WEIGHTS.get(fc, 0.0)
            return _pipeline_arr_snap(o) * w

        nb_open = [o for o in all_opps if not _is_closed_won_stage(o.stage_name) and not _is_closed_lost_stage(o.stage_name) and _is_new_business_record_type(_eff_rt_snap(o)) and not _is_excluded_from_bookings_nb_only(o, _eff_rt_snap(o)) and o.close_date and d_start <= o.close_date <= d_end]
        exp_open = [o for o in all_opps if not _is_closed_won_stage(o.stage_name) and not _is_closed_lost_stage(o.stage_name) and _is_expansion_record_type(_eff_rt_snap(o)) and o.close_date and d_start <= o.close_date <= d_end]

        nb_pipe_w = sum(_weighted_snap(o) for o in nb_open)
        exp_pipe_w = sum(_weighted_snap(o) for o in exp_open)

        nb_forecast = round(nb_actual + nb_pipe_w, 2)
        exp_forecast = round(exp_actual + exp_pipe_w, 2)

        pos = months.index(mk)
        nb_iq = max(0.0, round(iq_rates["nb"][pos] - nb_actual - nb_pipe_w, 2))
        exp_iq = max(0.0, round(iq_rates["exp"][pos] - exp_actual - exp_pipe_w, 2))

        nb_ai_pipe = sum(_pipeline_arr_snap(o) * ai_scores.get(o.sf_id or "", 0.0) for o in nb_open)
        exp_ai_pipe = sum(_pipeline_arr_snap(o) * ai_scores.get(o.sf_id or "", 0.0) for o in exp_open)

        # Tier-weighted pipeline (same _TIER_WEIGHTS logic)
        def _tier_w_snap(o: Opportunity) -> float:
            tier = (o.deal_tier or "").lower()
            for key, prob in _TIER_WEIGHTS.items():
                if key in tier:
                    return _pipeline_arr_snap(o) * prob
            fc = (o.forecast_category or "").strip()
            return _pipeline_arr_snap(o) * _FC_NB_EXP_WEIGHTS.get(fc, 0.0)

        nb_pipe_tier = sum(_tier_w_snap(o) for o in nb_open)
        exp_pipe_tier = sum(_tier_w_snap(o) for o in exp_open)

        snap_row = ForecastSnapshot(
            snapshot_date=today,
            target_month=mk,
            nb_actuals=round(nb_actual, 2),
            nb_pipeline_weighted=round(nb_pipe_w, 2),
            nb_in_quarter_est=nb_iq,
            nb_forecast=nb_forecast,
            nb_adjusted_forecast=round(nb_forecast + nb_iq, 2),
            nb_target=None,
            exp_actuals=round(exp_actual, 2),
            exp_pipeline_weighted=round(exp_pipe_w, 2),
            exp_in_quarter_est=exp_iq,
            exp_forecast=exp_forecast,
            exp_adjusted_forecast=round(exp_forecast + exp_iq, 2),
            exp_target=None,
            total_forecast=round(nb_forecast + exp_forecast, 2),
            total_adjusted_forecast=round(nb_forecast + nb_iq + exp_forecast + exp_iq, 2),
            total_target=None,
            # Legacy AI (actuals + AI pipeline, no IQ)
            nb_ai_forecast=round(nb_actual + nb_ai_pipe, 2) if ai_scores else None,
            exp_ai_forecast=round(exp_actual + exp_ai_pipe, 2) if ai_scores else None,
            # Full AI forecast: actuals + AI pipeline + IQ (matches UI "Forecast (AI)")
            nb_ai_adjusted_forecast=round(nb_actual + nb_ai_pipe + nb_iq, 2) if ai_scores else None,
            exp_ai_adjusted_forecast=round(exp_actual + exp_ai_pipe + exp_iq, 2) if ai_scores else None,
            total_ai_adjusted_forecast=round(nb_actual + nb_ai_pipe + nb_iq + exp_actual + exp_ai_pipe + exp_iq, 2) if ai_scores else None,
            # Tier-weighted forecast: actuals + tier pipeline + IQ (matches UI "Forecast (Tier)")
            nb_pipeline_tier_weighted=round(nb_pipe_tier, 2),
            exp_pipeline_tier_weighted=round(exp_pipe_tier, 2),
            nb_tier_forecast=round(nb_actual + nb_pipe_tier + nb_iq, 2),
            exp_tier_forecast=round(exp_actual + exp_pipe_tier + exp_iq, 2),
            total_tier_forecast=round(nb_actual + nb_pipe_tier + nb_iq + exp_actual + exp_pipe_tier + exp_iq, 2),
        )
        # Upsert: replace existing snapshot for same date + month
        await db.execute(
            delete(ForecastSnapshot).where(
                ForecastSnapshot.snapshot_date == today,
                ForecastSnapshot.target_month == mk,
            )
        )
        db.add(snap_row)
        saved += 1

    return saved


_REVOPS_AGENT_MODEL = os.getenv("REVOPS_AGENT_MODEL", "claude-sonnet-4-5")
_AI_SCORING_MAX_BATCH = 10  # max deals per LLM call — reduced from 20 to fit richer context (notes, activity)

_REVOPS_AGENT_SYSTEM_PROMPT = os.getenv(
    "REVOPS_AGENT_SYSTEM_PROMPT",
    """You are Dazos's RevOps agent, embedded in the executive cockpit. Dazos is a ~$7M ARR, VC/PE-backed behavioral health CRM SaaS company. Your primary users are the CEO and exec team (CFO, VP Sales, VP Marketing, VP CS). You are the connective tissue across the revenue organization — you see the full funnel from first marketing touch through renewal and expansion.

You are process-oriented, metric-driven, and direct. Your job is to give executives a clear, unified view of revenue performance, identify where the funnel is leaking, and surface actionable fixes. You do not editorialize; you diagnose and recommend.""",
)

# Combined system prompt for the unified Executive Assistant (used in /api/agent/chat and weekly briefings)
_EXEC_ASSISTANT_SYSTEM_PROMPT = (
    _FPA_SYSTEM_PROMPT
    + "\n\n---\n\n"
    + _REVOPS_AGENT_SYSTEM_PROMPT
    + """\n\n## Your role as the Dazos Executive Agent
You are a single unified agent with full access to both FP&A (financials, P&L, cash, budget) and \
RevOps (pipeline, ARR, renewals, Salesforce, Chargebee billing) data. \
Answer from whichever domain is most relevant; synthesize across both when the question spans them. \
Do NOT label your answers as coming from "FP&A" or "RevOps" — just answer directly as the Executive Agent. \
Be direct, specific with numbers, and lead with the answer."""
)


async def _build_revops_context(db: AsyncSession) -> str:
    """Build a markdown RevOps context string for agent chat and weekly briefings.
    Covers: current-quarter open pipeline summary, AI probability snapshot,
    latest AI observations (forecast / pipeline / renewals), and renewal risk snapshot."""
    import json as _rjson
    import calendar as _rcal
    lines: list[str] = ["# RevOps Context\n"]

    try:
        now_est = datetime.now(EST)
        q_num = (now_est.month - 1) // 3 + 1
        q_start_m = (q_num - 1) * 3 + 1
        q_end_m = q_start_m + 2
        q_start = date(now_est.year, q_start_m, 1)
        q_end = date(now_est.year, q_end_m, _rcal.monthrange(now_est.year, q_end_m)[1])
        q_label = f"Q{q_num} '{str(now_est.year)[2:]}"

        # ── Open pipeline summary ──────────────────────────────────────────────
        opp_result = await db.execute(select(Opportunity))
        all_opps: list[Opportunity] = list(opp_result.scalars().all())

        open_opps = [
            o for o in all_opps
            if not _is_closed_won_stage(o.stage_name) and not _is_closed_lost_stage(o.stage_name)
        ]

        def _opp_arr(o: Opportunity) -> float:
            return float(o.mrr * 12) if o.mrr else float(o.amount or 0)

        nb_opps = [o for o in open_opps if not _is_renewal_record_type(o.record_type_name or "")]
        ren_opps = [o for o in open_opps if _is_renewal_record_type(o.record_type_name or "")]

        nb_q = [o for o in nb_opps if o.close_date and q_start <= o.close_date <= q_end]
        ren_q = [o for o in ren_opps if o.close_date and q_start <= o.close_date <= q_end]

        nb_arr = sum(_opp_arr(o) for o in nb_q)
        ren_arr = sum(_opp_arr(o) for o in ren_q)

        # Latest AI scores
        scores_result = await db.execute(
            select(DealAIScore).order_by(DealAIScore.scored_at.desc())
        )
        score_rows: list[DealAIScore] = list(scores_result.scalars().all())
        latest_scored_at = score_rows[0].scored_at if score_rows else None
        if latest_scored_at:
            run_scores = [s for s in score_rows if s.scored_at == latest_scored_at]
            score_map = {s.sf_opp_id: s.probability for s in run_scores}
            avg_prob = sum(score_map.values()) / len(score_map) if score_map else 0
            weighted_nb = sum(_opp_arr(o) * score_map.get(o.sf_id or "", 0) for o in nb_q if o.sf_id in score_map)
            scored_at_str = latest_scored_at.strftime("%b %d %Y %H:%M")
        else:
            avg_prob = 0
            weighted_nb = 0
            scored_at_str = "not yet scored"

        lines.append(f"## Pipeline — {q_label}")
        lines.append(f"- Open NB/Expansion deals in quarter: {len(nb_q)} | Total ARR: ${nb_arr:,.0f}")
        lines.append(f"- AI-weighted NB pipeline: ${weighted_nb:,.0f} (avg probability: {avg_prob*100:.0f}%)")
        lines.append(f"- Open renewal deals in quarter: {len(ren_q)} | Total ARR at risk: ${ren_arr:,.0f}")
        lines.append(f"- AI scores last run: {scored_at_str}\n")

        # Top 5 open deals by ARR
        top5 = sorted(nb_q, key=lambda o: -_opp_arr(o))[:5]
        if top5:
            lines.append("### Top 5 Open NB Deals (by ARR)")
            for o in top5:
                prob = score_map.get(o.sf_id or "", None) if latest_scored_at else None
                prob_str = f" | AI prob: {prob*100:.0f}%" if prob is not None else ""
                lines.append(f"- {o.account_name}: ${_opp_arr(o):,.0f} | Stage: {o.stage_name} | Close: {o.close_date}{prob_str}")
            lines.append("")

        # ── Active customer base & product penetration ────────────────────────
        try:
            today_ctx = now_est.date()
            closed_won_opps = [o for o in all_opps if _is_closed_won_stage(o.stage_name)]

            # Live ARR accounts: closed-won accounts whose most recent CW opp is not followed by a lost renewal
            # Approximation: account has at least one CW opp with close_date <= today
            live_accts: dict[str, str] = {}  # sf_account_id -> account_name
            for o in closed_won_opps:
                if o.account_id and (o.close_date is None or o.close_date <= today_ctx):
                    live_accts[o.account_id] = o.account_name or ""

            lines.append("## Active Customer Base")
            lines.append(f"- Total accounts with at least one Closed Won opportunity: {len(live_accts)}")

            # Product penetration via OpportunityLineItem on closed-won opps
            cw_sf_ids = {o.sf_id for o in closed_won_opps if o.sf_id}
            if cw_sf_ids:
                li_result = await db.execute(
                    select(OpportunityLineItem).where(OpportunityLineItem.opportunity_sf_id.in_(cw_sf_ids))
                )
                line_items: list[OpportunityLineItem] = list(li_result.scalars().all())

                # Map opp sf_id -> account_id for de-duplication
                opp_to_acct = {o.sf_id: o.account_id for o in closed_won_opps if o.sf_id and o.account_id}

                # Count distinct accounts per product (normalized name)
                product_accts: dict[str, set[str]] = {}
                for li in line_items:
                    pname = _normalized_product_name(li.product_name) or (li.product_name or "").strip()
                    if not pname:
                        continue
                    acct_id = opp_to_acct.get(li.opportunity_sf_id or "", "")
                    if acct_id:
                        product_accts.setdefault(pname, set()).add(acct_id)

                # Also tally total quantity (seats/units) per product
                product_qty: dict[str, float] = {}
                for li in line_items:
                    pname = _normalized_product_name(li.product_name) or (li.product_name or "").strip()
                    if not pname:
                        continue
                    product_qty[pname] = product_qty.get(pname, 0.0) + (li.quantity or 0.0)

                if product_accts:
                    total_accts = max(len(live_accts), 1)
                    lines.append("### Product Penetration (accounts & seats/units from Closed Won line items)")
                    for pname, accts in sorted(product_accts.items(), key=lambda x: -len(x[1])):
                        pct = round(len(accts) / total_accts * 100)
                        qty = product_qty.get(pname, 0)
                        qty_str = f" | {qty:,.0f} seats/units total" if qty else ""
                        lines.append(f"- {pname}: {len(accts)} accounts ({pct}% of customer base){qty_str}")
            lines.append("")
        except Exception as prod_err:
            lines.append(f"*(Product penetration unavailable: {prod_err})*\n")

        # ── AI observations ────────────────────────────────────────────────────
        obs_result = await db.execute(
            select(AIForecastObservations).order_by(AIForecastObservations.scored_at.desc())
        )
        obs_rows = list(obs_result.scalars().all())
        seen_types: set[str] = set()
        for obs in obs_rows:
            if obs.obs_type in seen_types:
                continue
            seen_types.add(obs.obs_type)
            try:
                bullets: list[str] = _rjson.loads(obs.observations_json or "[]")
                if bullets:
                    lines.append(f"### Agent Observations — {obs.obs_type.title()} ({obs.quarter_label or ''})")
                    for b in bullets:
                        lines.append(f"- {b}")
                    lines.append("")
            except Exception:
                pass

    except Exception as e:
        lines.append(f"*(RevOps context unavailable: {e})*\n")

    return "\n".join(lines)


async def _generate_weekly_briefing(db: AsyncSession) -> dict:
    """Generate a weekly executive briefing combining FP&A and RevOps context.
    Upserts a WeeklyBriefing row for the current week_of (Monday). Returns summary dict."""
    if not _ANTHROPIC_AVAILABLE or _anthropic_mod is None:
        return {"ok": False, "error": "anthropic package not available"}
    anthropic_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    if not anthropic_key:
        return {"ok": False, "error": "ANTHROPIC_API_KEY not set"}

    logger = logging.getLogger(__name__)

    # Determine week_of = most recent Monday
    now_est = datetime.now(EST)
    days_since_monday = now_est.weekday()  # 0 = Monday
    week_of = (now_est - timedelta(days=days_since_monday)).date()

    # Previous week Mon–Sun for "last week" framing
    prev_monday = week_of - timedelta(days=7)
    prev_sunday = week_of - timedelta(days=1)

    try:
        fpa_context = await _build_fpa_context(db)
    except Exception as e:
        fpa_context = f"*(FP&A context unavailable: {e})*"

    try:
        revops_context = await _build_revops_context(db)
    except Exception as e:
        revops_context = f"*(RevOps context unavailable: {e})*"

    combined_context = (
        "## Financial Context (FP&A)\n\n" + fpa_context
        + "\n\n---\n\n" + revops_context
    )

    briefing_prompt = (
        f"Today is {now_est.strftime('%A, %B %d, %Y')}. "
        f"Last week ran {prev_monday.strftime('%b %d')}–{prev_sunday.strftime('%b %d, %Y')}.\n\n"
        "Using the financial and RevOps data provided, write a concise weekly executive briefing in markdown. "
        "Structure it with exactly these four sections:\n\n"
        "## Last Week Highlights\n"
        "3–5 bullets on what happened: bookings vs plan, pipeline changes, renewals activity, cash/financial movements.\n\n"
        "## Key Metrics\n"
        "A compact table or bullets showing the 5–7 most important current metrics with actuals and vs-plan deltas.\n\n"
        "## Pipeline & Renewals Watch\n"
        "3–5 bullets: deals that moved, at-risk renewals, AI confidence changes, anything the exec team must watch.\n\n"
        "## This Week's Focus\n"
        "Top 3–5 prioritized actions for the CFO and exec team this week. Be specific — name accounts, amounts, decisions.\n\n"
        "Be direct. No filler. Targeted for a CFO/CEO audience."
    )

    generated_at = datetime.now(EST)
    briefing_text: str | None = None
    error_text: str | None = None

    try:
        client = _anthropic_mod.AsyncAnthropic(api_key=anthropic_key)
        response = await client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=2000,
            system=_EXEC_ASSISTANT_SYSTEM_PROMPT,
            messages=[
                {"role": "user", "content": combined_context + "\n\n---\n\n" + briefing_prompt},
            ],
        )
        briefing_text = response.content[0].text if response.content else None
    except Exception as e:
        error_text = str(e)
        logger.exception("Weekly briefing generation failed: %s", e)

    # Upsert: replace any existing briefing for this week_of
    await db.execute(
        delete(WeeklyBriefing).where(WeeklyBriefing.week_of == week_of)
    )
    db.add(WeeklyBriefing(
        week_of=week_of,
        generated_at=generated_at,
        briefing_text=briefing_text,
        model_used="claude-sonnet-4-5",
        error=error_text,
    ))
    await db.commit()

    return {
        "ok": briefing_text is not None,
        "week_of": str(week_of),
        "generated_at": generated_at.isoformat(),
        "error": error_text,
    }


async def _run_ai_forecast_scoring(db: AsyncSession) -> dict:
    """Score all open NB + Expansion opportunities with an LLM using field history as context.
    Upserts results into DealAIScore. Returns a summary dict. Non-fatal on LLM errors."""
    anthropic_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    if not anthropic_key:
        return {"ok": False, "error": "ANTHROPIC_API_KEY not set — AI scoring skipped."}
    if not _ANTHROPIC_AVAILABLE or _anthropic_mod is None:
        return {"ok": False, "error": "anthropic package not installed — run: pip install anthropic"}

    anth_client = _anthropic_mod.AsyncAnthropic(api_key=anthropic_key)

    async def _anth_json(system_task: str, user_content: str, max_tokens: int = 2000, temperature: float = 0.1) -> str:
        """Make an Anthropic call that returns JSON. Uses assistant prefill to force valid JSON output."""
        full_system = _REVOPS_AGENT_SYSTEM_PROMPT + "\n\n" + system_task
        resp = await anth_client.messages.create(
            model=_REVOPS_AGENT_MODEL,
            max_tokens=max_tokens,
            temperature=temperature,
            system=full_system,
            messages=[
                {"role": "user", "content": user_content},
                {"role": "assistant", "content": "{"},
            ],
        )
        return "{" + (resp.content[0].text if resp.content else "}")

    # ── Load open NB + Expansion opportunities ────────────────────────────────
    result = await db.execute(select(Opportunity))
    all_opps: list[Opportunity] = list(result.scalars().all())
    rt_overrides = await _get_record_type_overrides(db)

    def _eff_rt_ai(o: Opportunity) -> str:
        _key = (o.sf_id or "").strip()
        _ov = rt_overrides.get(_key) or (rt_overrides.get(_key[:15]) if len(_key) >= 15 else None)
        return (_ov or o.record_type_name or "").strip()

    open_opps = [
        o for o in all_opps
        if not _is_closed_won_stage(o.stage_name)
        and not _is_closed_lost_stage(o.stage_name)
        and not _is_renewal_record_type(_eff_rt_ai(o))
    ]
    if not open_opps:
        return {"ok": True, "scored": 0, "message": "No open NB/Expansion opportunities to score."}

    # ── Load field history keyed by opp sf_id ─────────────────────────────────
    hist_result = await db.execute(
        select(OppFieldHistory).order_by(OppFieldHistory.changed_at)
    )
    hist_rows: list[OppFieldHistory] = list(hist_result.scalars().all())
    hist_by_opp: dict[str, list[OppFieldHistory]] = {}
    for h in hist_rows:
        hist_by_opp.setdefault(h.sf_opp_id, []).append(h)

    # Load notes and activities (non-fatal if tables don't exist yet)
    notes_by_opp: dict[str, list[OppNote]] = {}
    try:
        notes_result = await db.execute(select(OppNote).order_by(OppNote.created_date.desc()))
        for n in notes_result.scalars().all():
            notes_by_opp.setdefault(n.sf_opp_id, []).append(n)
    except Exception:
        pass

    activities_by_opp: dict[str, list[OppActivity]] = {}
    try:
        acts_result = await db.execute(select(OppActivity).order_by(OppActivity.activity_date.desc()))
        for a in acts_result.scalars().all():
            activities_by_opp.setdefault(a.sf_opp_id, []).append(a)
    except Exception:
        pass

    open_sf_ids_ai = {o.sf_id for o in open_opps if o.sf_id}
    opp_to_line_arr_ai = await _line_item_arr_for_opportunities(db, open_sf_ids_ai)

    def _pipeline_arr(o: Opportunity) -> float:
        if o.mrr is not None and o.mrr != 0:
            return round(float(o.mrr) * PIPELINE_ARR_MULTIPLIER, 2)
        return opp_to_line_arr_ai.get(o.sf_id, 0.0)

    today_est = datetime.now(EST).date()

    def _build_deal_context(o: Opportunity) -> dict:
        history = hist_by_opp.get(o.sf_id or "", [])

        # Stage progression
        stage_hist = [h for h in history if h.field == "StageName"]
        stage_progression = []
        for i, h in enumerate(stage_hist):
            next_change = stage_hist[i + 1].changed_at if i + 1 < len(stage_hist) else datetime.now(EST)
            diff = (next_change.date() if hasattr(next_change, "date") else next_change) - \
                   (h.changed_at.date() if hasattr(h.changed_at, "date") else h.changed_at)
            days = max(0, diff.days)
            stage_progression.append({"stage": h.new_value, "days_in_stage": days})

        # Close date pushes
        close_hist = [h for h in history if h.field == "CloseDate"]
        close_date_pushes = 0
        total_days_pushed = 0
        for h in close_hist:
            try:
                old_d = date.fromisoformat(str(h.old_value)[:10]) if h.old_value else None
                new_d = date.fromisoformat(str(h.new_value)[:10]) if h.new_value else None
                if old_d and new_d:
                    diff = (new_d - old_d).days
                    if diff > 0:
                        close_date_pushes += 1
                        total_days_pushed += diff
            except (ValueError, TypeError):
                pass

        # Amount changes
        amount_hist = [h for h in history if h.field == "Amount"]
        amount_changes = []
        for h in amount_hist:
            try:
                old_a = float(h.old_value) if h.old_value else None
                new_a = float(h.new_value) if h.new_value else None
                if old_a is not None and new_a is not None:
                    amount_changes.append({"from": round(old_a, 0), "to": round(new_a, 0)})
            except (ValueError, TypeError):
                pass

        # Notes (most recent 3, title + first 300 chars of body)
        opp_notes = notes_by_opp.get(o.sf_id or "", [])
        notes_summary = [
            {
                "title": n.title,
                "excerpt": (n.body or "")[:300],
                "date": str(n.created_date.date()) if n.created_date and hasattr(n.created_date, "date") else str(n.created_date) if n.created_date else None,
            }
            for n in opp_notes[:3]
        ]

        # Recent activity (last 10 tasks)
        opp_acts = activities_by_opp.get(o.sf_id or "", [])
        recent_activity = [
            {
                "type": a.activity_type or "Task",
                "subject": a.subject,
                "date": str(a.activity_date) if a.activity_date else None,
            }
            for a in opp_acts[:10]
        ]
        days_since_last_activity = None
        if opp_acts and opp_acts[0].activity_date:
            days_since_last_activity = (today_est - opp_acts[0].activity_date).days

        arr = _pipeline_arr(o)
        days_until_close = (o.close_date - today_est).days if o.close_date else None
        days_since_created = None
        if o.created_date:
            cd = o.created_date.date() if hasattr(o.created_date, "date") else o.created_date
            days_since_created = (today_est - cd).days

        ctx: dict = {
            "sf_opp_id": o.sf_id,
            "name": o.name,
            "account": o.account_name,
            "owner": o.owner_name,
            "stage": o.stage_name,
            "forecast_category": o.forecast_category,
            "arr": round(arr, 0),
            "close_date": str(o.close_date) if o.close_date else None,
            "days_until_close": days_until_close,
            "days_since_created": days_since_created,
            "stage_progression": stage_progression[-10:],
            "close_date_pushes": close_date_pushes,
            "total_days_pushed": total_days_pushed,
            "amount_changes": amount_changes[-5:],
            "next_step": o.next_step,
            "days_since_last_activity": days_since_last_activity,
            "recent_activity": recent_activity,
            "notes": notes_summary,
        }
        # Include prospect context fields only when available
        if o.lead_type:
            ctx["lead_type"] = o.lead_type
        if o.current_crm:
            ctx["current_crm"] = o.current_crm
        if o.current_voip:
            ctx["current_voip"] = o.current_voip
        return ctx

    scored_total = 0
    scored_at = datetime.now(EST)
    logger = logging.getLogger(__name__)
    cal_block = await _ai_forecast_calibration_block(db)

    # ── Process in batches ────────────────────────────────────────────────────
    for batch_start in range(0, len(open_opps), _AI_SCORING_MAX_BATCH):
        batch = open_opps[batch_start: batch_start + _AI_SCORING_MAX_BATCH]
        contexts = [_build_deal_context(o) for o in batch]
        import json as _json

        scoring_task = (
            "You will receive a list of open sales opportunities "
            "with stage history, close-date changes, deal size, next steps, recent activity, and notes. "
            "For each deal, assign a win probability (0.0 to 1.0) representing the likelihood "
            "the deal closes as Closed Won within 90 days of its current close date. "
            "These probabilities × ARR roll up to the **Current Quarter Forecast (AI)** in the app; "
            "calibrate against the backtest section below when it is present. "
            "Consider: stage velocity, close-date stability (penalize repeated pushes), "
            "forecast category vs. evidence (empty *Best Case* pipeline = lower), days until close, "
            "recency of activity (stale = lower), next-step specificity, and note tone. "
            "Return ONLY valid JSON in this exact schema with no extra text:\n"
            '"scores": [{"sf_opp_id": "<id>", "probability": <float 0-1>, "reasoning": "<1-2 sentences>"}]}'
        )
        if cal_block:
            scoring_task = scoring_task + "\n\n" + cal_block

        user_content = _json.dumps({"opportunities": contexts}, default=str)

        try:
            raw = await _anth_json(scoring_task, user_content, max_tokens=6000, temperature=0.1)
            parsed = _json.loads(raw)
            scores_list: list[dict] = parsed.get("scores", [])
        except Exception as llm_err:
            logger.exception("AI scoring LLM call failed for batch starting at %d: %s", batch_start, llm_err)
            continue

        score_map = {s["sf_opp_id"]: s for s in scores_list if "sf_opp_id" in s}

        for o, ctx in zip(batch, contexts):
            sf_id = o.sf_id
            score_entry = score_map.get(sf_id)
            if not score_entry:
                continue
            try:
                prob = float(score_entry.get("probability", 0.5))
                prob = max(0.0, min(1.0, prob))
            except (TypeError, ValueError):
                prob = 0.5
            reasoning = str(score_entry.get("reasoning", ""))[:1000]

            # Upsert: delete previous score for this opp from same run date, insert new
            await db.execute(
                delete(DealAIScore).where(
                    DealAIScore.sf_opp_id == sf_id,
                    DealAIScore.scored_at >= datetime.combine(today_est, datetime.min.time()),
                )
            )
            db.add(DealAIScore(
                sf_opp_id=sf_id,
                scored_at=scored_at,
                probability=prob,
                reasoning=reasoning,
                model_used=_REVOPS_AGENT_MODEL,
                input_snapshot_json=_json.dumps(ctx, default=str)[:8000],
            ))
            scored_total += 1

    # ── Quarter label (shared by both observation blocks) ────────────────────
    import json as _json2
    _now_obs = datetime.now(EST)
    _q_num_obs = (_now_obs.month - 1) // 3 + 1
    _q_start_obs = (_q_num_obs - 1) * 3 + 1
    months2 = [f"{_now_obs.year}-{(_q_start_obs + i):02d}" for i in range(3)]
    q_label2 = f"Q{_q_num_obs} '{str(_now_obs.year)[2:]}"

    # ── Generate executive observations ──────────────────────────────────────
    _obs_status: dict[str, str] = {}  # track success/failure of each obs type for return value
    observations: list[str] = []
    try:

        # Load freshly written scores for this run
        scores_r2 = await db.execute(
            select(DealAIScore).where(DealAIScore.scored_at == scored_at)
        )
        run_scores: list[DealAIScore] = list(scores_r2.scalars().all())
        score_prob_by_id = {s.sf_opp_id: s.probability for s in run_scores}

        month_summaries = []
        for mk in months2:
            y2, m2 = int(mk[:4]), int(mk[5:])
            import calendar as _cal2
            d_s = date(y2, m2, 1)
            d_e = date(y2, m2, _cal2.monthrange(y2, m2)[1])
            month_opps = [
                o for o in open_opps
                if o.close_date and d_s <= o.close_date <= d_e
            ]
            month_scored = [(o, score_prob_by_id[o.sf_id]) for o in month_opps if o.sf_id in score_prob_by_id]
            total_arr = sum(_pipeline_arr(o) for o in month_opps)
            weighted_arr = sum(_pipeline_arr(o) * p for o, p in month_scored)
            avg_prob = (sum(p for _, p in month_scored) / len(month_scored)) if month_scored else 0
            high_conf = [(o.account_name, round(_pipeline_arr(o)), round(p * 100)) for o, p in month_scored if p >= 0.7][:3]
            at_risk = [(o.account_name, round(_pipeline_arr(o)), round(p * 100)) for o, p in month_scored if p < 0.3 and _pipeline_arr(o) > 10000][:3]
            close_pushes = sum(
                len([h for h in hist_by_opp.get(o.sf_id or "", []) if h.field == "CloseDate"])
                for o in month_opps
            )
            month_summaries.append({
                "month": mk,
                "total_pipeline_arr": round(total_arr),
                "ai_weighted_arr": round(weighted_arr),
                "avg_probability_pct": round(avg_prob * 100, 1),
                "deals_total": len(month_opps),
                "deals_scored": len(month_scored),
                "high_confidence_deals": high_conf,
                "at_risk_deals": at_risk,
                "total_close_date_pushes": close_pushes,
            })

        obs_task = (
            f"Generate a forecast health briefing for the executive team for {q_label2}. "
            "Based on the AI-scored pipeline and `ai_forecast_backtest` (snapshots vs final closed won), write 4-6 bullet points. "
            "When backtest has n>0, mention whether the team has been over- or under-forecasting vs realized bookings and what that "
            "implies for confidence in the current quarter AI number. Also cover: month risk, large-deal concentration, "
            "velocity, and at-risk / high-confidence deals. Be specific with numbers. No fluff. "
            "Return ONLY valid JSON: \"observations\": [\"bullet 1\", \"bullet 2\", ...]}"
        )
        _bt = await _compute_ai_backtest_against_snapshots(db)
        obs_payload = {
            "quarter": q_label2,
            "months": month_summaries,
            "ai_forecast_backtest": {
                "n": _bt["n"],
                "mean_signed_error_pct": _bt["mean_signed_error_pct"],
                "mean_abs_error_pct": _bt["mean_abs_error_pct"],
                "recent_months": _bt["rows"][:6],
            },
        }
        obs_raw = await _anth_json(obs_task, _json2.dumps(obs_payload, default=str), max_tokens=1000, temperature=0.3)
        observations = _json2.loads(obs_raw).get("observations", [])

        # Replace forecast observations (keep only the latest run)
        await db.execute(
            delete(AIForecastObservations).where(
                AIForecastObservations.obs_type == "forecast",
            )
        )
        db.add(AIForecastObservations(
            scored_at=scored_at,
            obs_type="forecast",
            quarter_label=q_label2,
            observations_json=_json2.dumps(observations),
        ))
        _obs_status["forecast"] = f"ok ({len(observations)} bullets)"
    except Exception as obs_err:
        _obs_status["forecast"] = f"error: {obs_err}"
        logger.exception("Failed to generate forecast observations: %s", obs_err)

    # Commit DealAIScore inserts + forecast observations before isolated sessions.
    # SQLite allows only one writer at a time — the main session must release its
    # write lock so the isolated AsyncSessionLocal() calls below can acquire it.
    await db.commit()

    # ── Generate pipeline-health observations (stage/tier/velocity focus) ────
    # Uses its own DB session so any failure cannot corrupt the main session (DealAIScore inserts).
    try:
        import json as _json3

        today_est3 = datetime.now(EST).date()

        def _pipe_arr(o: Opportunity) -> float:
            """ARR for pipeline obs: MRR×12 when set, else Amount."""
            if o.mrr is not None and o.mrr != 0:
                return float(o.mrr) * 12
            return float(o.amount or 0)

        # Build pipeline summary: per-tier and per-stage breakdown + velocity signals
        tier_bucket: dict[str, dict] = {}
        stage_bucket: dict[str, dict] = {}
        stale_deals: list[dict] = []   # no activity in 21+ days
        tier_change_deals: list[str] = []  # deals where Deal_Tier changed recently

        for o in open_opps:
            arr = _pipe_arr(o)
            tier = o.deal_tier or "No Tier"
            stage = o.stage_name or "Unknown"

            # Tier bucket
            b = tier_bucket.setdefault(tier, {"count": 0, "total_arr": 0.0, "close_pushes": 0, "stage_changes": 0})
            b["count"] += 1
            b["total_arr"] += arr

            # Stage bucket
            s = stage_bucket.setdefault(stage, {"count": 0, "total_arr": 0.0})
            s["count"] += 1
            s["total_arr"] += arr

            # Field history signals
            fh = hist_by_opp.get(o.sf_id or "", [])
            close_pushes = len([h for h in fh if h.field == "CloseDate"])
            stage_changes = len([h for h in fh if h.field == "StageName"])
            tier_changes = len([h for h in fh if h.field == "Deal_Tier__c"])
            b["close_pushes"] += close_pushes
            b["stage_changes"] += stage_changes
            if tier_changes > 0:
                tier_change_deals.append(f"{o.account_name} ({tier_changes}x, now {tier})")

            # Activity recency
            opp_acts3 = activities_by_opp.get(o.sf_id or "", [])
            if opp_acts3 and opp_acts3[0].activity_date:
                days_inactive = (today_est3 - opp_acts3[0].activity_date).days
            else:
                days_inactive = 999
            if days_inactive >= 21 and arr > 5000:
                stale_deals.append({
                    "account": o.account_name,
                    "arr": round(arr),
                    "tier": tier,
                    "stage": stage,
                    "days_inactive": days_inactive if days_inactive < 999 else None,
                })

        # Sort tier buckets by total ARR descending
        tier_summary = [
            {
                "tier": t,
                "count": v["count"],
                "total_arr": round(v["total_arr"]),
                "avg_arr": round(v["total_arr"] / v["count"]) if v["count"] else 0,
                "close_pushes": v["close_pushes"],
                "stage_changes": v["stage_changes"],
            }
            for t, v in sorted(tier_bucket.items(), key=lambda x: -x[1]["total_arr"])
        ]
        stage_summary = [
            {"stage": s, "count": v["count"], "total_arr": round(v["total_arr"])}
            for s, v in sorted(stage_bucket.items(), key=lambda x: -x[1]["total_arr"])
        ]
        stale_deals.sort(key=lambda x: -(x["arr"] or 0))

        pipeline_summary = {
            "quarter": q_label2,
            "total_open_deals": len(open_opps),
            "total_open_arr": round(sum(_pipe_arr(o) for o in open_opps)),
            "by_tier": tier_summary,
            "by_stage": stage_summary,
            "stale_deals_21d": stale_deals[:8],
            "tier_changed_recently": tier_change_deals[:6],
        }

        pipe_task = (
            f"Generate a pipeline health briefing for {q_label2}. "
            "Analyze the open pipeline data below and write 4-6 concise bullet-point observations. "
            "Focus on: deal tier distribution and concentration risk, stage velocity and bottlenecks, "
            "close-date push frequency by tier, stale deals (no recent activity) that are material ARR risks, "
            "tier changes as a signal of deal momentum, and any patterns that suggest pipeline quality issues. "
            "Be specific with deal counts and ARR amounts. Write for a CFO/CEO/VP Sales audience — direct, no fluff. "
            "Return ONLY valid JSON: \"observations\": [\"bullet 1\", \"bullet 2\", ...]}"
        )
        pipe_obs_raw = await _anth_json(pipe_task, _json3.dumps(pipeline_summary, default=str), max_tokens=900, temperature=0.3)
        pipeline_observations: list[str] = _json3.loads(pipe_obs_raw).get("observations", [])

        await db.execute(
            delete(AIForecastObservations).where(
                AIForecastObservations.obs_type == "pipeline",
            )
        )
        db.add(AIForecastObservations(
            scored_at=scored_at,
            obs_type="pipeline",
            quarter_label=q_label2,
            observations_json=_json3.dumps(pipeline_observations),
        ))
        await db.commit()
        _obs_status["pipeline"] = f"ok ({len(pipeline_observations)} bullets)"
    except Exception as pipe_obs_err:
        _obs_status["pipeline"] = f"error: {pipe_obs_err}"
        logger.exception("Failed to generate pipeline observations: %s", pipe_obs_err)

    # ── Generate renewals health observations ─────────────────────────────────
    # Analyzes open Q renewal opps with account health, risk, activity data.
    try:
        import json as _json4
        import calendar as _cal4

        today_ren = datetime.now(EST).date()
        _q_num_ren = (today_ren.month - 1) // 3 + 1
        _q_start_month_ren = (_q_num_ren - 1) * 3 + 1
        _q_end_month_ren = _q_start_month_ren + 2
        _q_start_date_ren = date(today_ren.year, _q_start_month_ren, 1)
        _q_end_day_ren = _cal4.monthrange(today_ren.year, _q_end_month_ren)[1]
        _q_end_date_ren = date(today_ren.year, _q_end_month_ren, _q_end_day_ren)
        q_label_ren = f"Q{_q_num_ren} '{str(today_ren.year)[2:]}"

        def _ren_arr(o: Opportunity) -> float:
            if o.mrr is not None and o.mrr != 0:
                return float(o.mrr) * 12
            return float(o.amount or 0)

        # Open renewal opps closing in the current quarter
        ren_opps_all = [
            o for o in all_opps
            if _is_renewal_record_type(_eff_rt_ai(o))
            and not _is_closed_won_stage(o.stage_name)
            and not _is_closed_lost_stage(o.stage_name)
        ]
        ren_opps_q = [
            o for o in ren_opps_all
            if o.close_date and _q_start_date_ren <= o.close_date <= _q_end_date_ren
        ]

        # Load account health data keyed by sf_id
        acc_ids_ren = {o.account_id for o in ren_opps_q if o.account_id}
        acc_health: dict[str, dict] = {}
        if acc_ids_ren:
            acc_rows_r = await db.execute(select(Account).where(Account.sf_id.in_(acc_ids_ren)))
            for acc in acc_rows_r.scalars().all():
                acc_health[acc.sf_id] = {
                    "health_score": acc.health_score,
                    "risk_score": acc.risk_score,
                    "product_usage_score": acc.product_usage_score,
                    "financial_score": acc.financial_score,
                    "customer_engagement_score": acc.customer_engagement_score,
                    "support_score": acc.support_score,
                    "customer_journey_phase": acc.customer_journey_phase,
                    "payment_status": acc.payment_status,
                    "outstanding_balance": acc.outstanding_balance,
                    "overdue_invoice_count": acc.overdue_invoice_count,
                    "csm": acc.customer_success_manager,
                    "segment": acc.segment,
                }

        # Build per-opp context for LLM
        ren_deal_contexts: list[dict] = []
        for o in sorted(ren_opps_q, key=lambda x: -_ren_arr(x)):
            arr = _ren_arr(o)
            health = acc_health.get(o.account_id or "", {})
            opp_acts_ren = activities_by_opp.get(o.sf_id or "", [])
            if opp_acts_ren and opp_acts_ren[0].activity_date:
                days_since_act = (today_ren - opp_acts_ren[0].activity_date).days
                last_activity = str(opp_acts_ren[0].activity_date)
            else:
                days_since_act = None
                last_activity = None

            opp_notes_ren = notes_by_opp.get(o.sf_id or "", [])
            recent_notes = [
                {"date": str(n.created_date)[:10] if n.created_date else None, "body": (n.body or "")[:300]}
                for n in opp_notes_ren[:2]
            ]

            fh_ren = hist_by_opp.get(o.sf_id or "", [])
            close_pushes = len([h for h in fh_ren if h.field == "CloseDate"])
            stage_changes = len([h for h in fh_ren if h.field == "StageName"])

            ctx = {
                "account": o.account_name,
                "arr": round(arr),
                "stage": o.stage_name,
                "close_date": str(o.close_date) if o.close_date else None,
                "forecast_category": o.forecast_category,
                "next_step": (o.next_step or "")[:200] or None,
                "close_date_pushes": close_pushes,
                "stage_changes": stage_changes,
                "days_since_last_activity": days_since_act,
                "last_activity_date": last_activity,
                "recent_notes": recent_notes or None,
                # Account health
                "health_score": health.get("health_score"),
                "risk_score": health.get("risk_score"),
                "product_usage_score": health.get("product_usage_score"),
                "financial_score": health.get("financial_score"),
                "customer_engagement_score": health.get("customer_engagement_score"),
                "support_score": health.get("support_score"),
                "customer_journey_phase": health.get("customer_journey_phase"),
                "payment_status": health.get("payment_status"),
                "outstanding_balance": health.get("outstanding_balance"),
                "overdue_invoice_count": health.get("overdue_invoice_count"),
                "csm": health.get("csm"),
                "segment": health.get("segment"),
            }
            # Drop None values to keep context compact
            ren_deal_contexts.append({k: v for k, v in ctx.items() if v is not None})

        total_ren_arr = sum(_ren_arr(o) for o in ren_opps_q)
        ren_payload = {
            "quarter": q_label_ren,
            "total_open_renewal_deals": len(ren_opps_q),
            "total_open_renewal_arr": round(total_ren_arr),
            "deals": ren_deal_contexts[:20],  # cap to 20 for token budget
        }

        ren_task = (
            f"Generate a renewal risk briefing for {q_label_ren}. "
            "Analyze the open renewal opportunities below (including account health scores, risk flags, "
            "product usage, financial standing, and recent activity) and write 4-6 concise bullet-point observations. "
            "Focus on: high-risk accounts (low health/high risk scores), accounts with engagement or product usage concerns, "
            "financial red flags (overdue invoices, outstanding balance), deals with no recent activity, "
            "close-date push history as a churn signal, and any patterns that need CS or executive attention. "
            "Be specific with ARR amounts and account names where relevant. "
            "Write for a CFO/CEO/VP CS audience — direct, no fluff. "
            "Return ONLY valid JSON: \"observations\": [\"bullet 1\", \"bullet 2\", ...]}"
        )
        ren_obs_raw = await _anth_json(ren_task, _json4.dumps(ren_payload, default=str), max_tokens=900, temperature=0.3)
        renewals_observations: list[str] = _json4.loads(ren_obs_raw).get("observations", [])

        await db.execute(
            delete(AIForecastObservations).where(
                AIForecastObservations.obs_type == "renewals",
            )
        )
        db.add(AIForecastObservations(
            scored_at=scored_at,
            obs_type="renewals",
            quarter_label=q_label_ren,
            observations_json=_json4.dumps(renewals_observations),
        ))
        await db.commit()
        _obs_status["renewals"] = f"ok ({len(renewals_observations)} bullets)"
    except Exception as ren_obs_err:
        _obs_status["renewals"] = f"error: {ren_obs_err}"
        logger.exception("Failed to generate renewals observations: %s", ren_obs_err)

    return {"ok": True, "scored": scored_total, "scored_at": scored_at.isoformat(), "observations": _obs_status}


async def _scheduled_salesforce_jobs() -> None:
    """Hourly Salesforce sync only if ENABLE_SCHEDULED_BACKGROUND_SYNC; daily EOD at 23:59:59 EST if ENABLE_SCHEDULED_EOD_SNAPSHOT (default on).
    EOD snapshots whatever is already in SQLite (typically last Dashboard → Refresh app data)."""
    scheduled_eod = os.getenv("ENABLE_SCHEDULED_EOD_SNAPSHOT", "1").lower() not in ("0", "false", "no")
    scheduled_hourly_sf = os.getenv("ENABLE_SCHEDULED_BACKGROUND_SYNC", "").lower() in ("1", "true", "yes")
    scheduled_ai_scoring = os.getenv("ENABLE_AI_FORECAST_SCORING", "").lower() in ("1", "true", "yes")
    last_sync_hour: Optional[tuple[date, int]] = None  # (date_est, hour_est)
    last_eod_date: Optional[date] = None
    last_ai_score_date: Optional[date] = None
    last_forecast_snapshot_date: Optional[date] = None
    last_weekly_briefing_date: Optional[date] = None

    while True:
        try:
            now_est = datetime.now(EST)
            today_est = now_est.date()
            run_hourly = scheduled_hourly_sf and now_est.minute == 59 and now_est.second >= 59
            run_eod = scheduled_eod and now_est.hour == 23 and now_est.minute == 59
            # AI scoring runs nightly at 00:30 EST (after midnight, giving SF sync time to finish)
            run_ai = scheduled_ai_scoring and now_est.hour == 0 and now_est.minute == 30
            # Daily forecast snapshot at 01:00 EST (after SF sync + AI scoring)
            run_forecast_snap = now_est.hour == 1 and now_est.minute == 0
            # Weekly briefing every Monday at 07:00 EST
            run_weekly_briefing = (now_est.weekday() == 0 and now_est.hour == 7 and now_est.minute == 0)

            if run_hourly and (last_sync_hour is None or last_sync_hour != (today_est, now_est.hour)):
                async with _salesforce_sync_lock:
                    async with AsyncSessionLocal() as session:
                        result = await _run_salesforce_sync(session)
                        if result.get("ok"):
                            await session.commit()
                            last_sync_hour = (today_est, now_est.hour)
                        else:
                            await session.rollback()

            if run_eod and (last_eod_date is None or last_eod_date != today_est):
                async with _salesforce_sync_lock:
                    async with AsyncSessionLocal() as session:
                        try:
                            await _take_salesforce_eod_snapshot(session)
                            await session.commit()
                            last_eod_date = today_est
                            logging.getLogger(__name__).info(
                                "EOD snapshot taken for %s (SQLite CRM state; use Dashboard refresh for manual sync)",
                                today_est.isoformat(),
                            )
                        except Exception as e:
                            await session.rollback()
                            logging.getLogger(__name__).exception(
                                "EOD snapshot failed for %s: %s", today_est.isoformat(), e
                            )

            if run_forecast_snap and (last_forecast_snapshot_date is None or last_forecast_snapshot_date != today_est):
                async with AsyncSessionLocal() as session:
                    try:
                        saved = await _take_forecast_snapshot(session)
                        await session.commit()
                        last_forecast_snapshot_date = today_est
                        logging.getLogger(__name__).info(
                            "Forecast snapshot taken for %s (%d months saved)", today_est.isoformat(), saved
                        )
                    except Exception as e:
                        await session.rollback()
                        logging.getLogger(__name__).exception("Forecast snapshot failed: %s", e)

            if run_ai and (last_ai_score_date is None or last_ai_score_date != today_est):
                async with AsyncSessionLocal() as session:
                    try:
                        ai_result = await _run_ai_forecast_scoring(session)
                        if ai_result.get("ok"):
                            await session.commit()
                            last_ai_score_date = today_est
                            logging.getLogger(__name__).info(
                                "AI forecast scoring complete: %s deals scored", ai_result.get("scored", 0)
                            )
                        else:
                            await session.rollback()
                            logging.getLogger(__name__).warning(
                                "AI forecast scoring skipped: %s", ai_result.get("error", "unknown")
                            )
                    except Exception as e:
                        await session.rollback()
                        logging.getLogger(__name__).exception("AI forecast scoring failed: %s", e)

            if run_weekly_briefing and (last_weekly_briefing_date is None or last_weekly_briefing_date != today_est):
                async with AsyncSessionLocal() as session:
                    try:
                        briefing_result = await _generate_weekly_briefing(session)
                        last_weekly_briefing_date = today_est
                        logging.getLogger(__name__).info(
                            "Weekly briefing generated for week_of=%s ok=%s",
                            briefing_result.get("week_of"), briefing_result.get("ok")
                        )
                    except Exception as e:
                        logging.getLogger(__name__).exception("Weekly briefing generation failed: %s", e)

        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        await asyncio.sleep(30)


# ----- Dashboard KPI (Phase 2: Salesforce only) -----

def _is_renewal_record_type(name: Optional[str]) -> bool:
    """True if record type is Renewal or variant (e.g. Early Renewal). Case-insensitive, trimmed."""
    n = (name or "").strip().lower()
    return n == "renewal" or "renewal" in n


def _is_new_business_record_type(name: Optional[str]) -> bool:
    """True if Type/record type is New Business, New Customer, or Internal Admin Use (case-insensitive, trimmed)."""
    n = (name or "").strip().lower()
    return (
        n == "new business"
        or "new business" in n
        or "new customer" in n
        or n == "internal admin use"
    )


def _is_amendment_record_type(name: Optional[str]) -> bool:
    """True if record type is Amendment (case-insensitive, trimmed)."""
    return (name or "").strip().lower() == "amendment"


def _is_expansion_record_type(name: Optional[str]) -> bool:
    """True if Type/record type is Expansion or contains 'expansion' (case-insensitive, trimmed)."""
    n = (name or "").strip().lower()
    return n == "expansion" or "expansion" in n


async def _get_record_type_overrides(db: AsyncSession) -> dict[str, str]:
    """Load manual record-type overrides: opportunity_sf_id -> record_type_name.
    Keys stripped. Both 15- and 18-char SF IDs are stored so lookup matches either format."""
    q = select(OpportunityRecordTypeOverride).order_by(OpportunityRecordTypeOverride.id.asc())
    r = await db.execute(q)
    out: dict[str, str] = {}
    for row in r.scalars().all():
        val = (row.record_type_name or "").strip() or "—"
        key = (row.opportunity_sf_id or "").strip()
        out[key] = val
        if len(key) == 18:
            out[key[:15]] = val
        elif len(key) == 15:
            out[key] = val
    return out


async def _get_active_arr_account_overrides(db: AsyncSession) -> set[str]:
    """Load account names that should use open renewal ARR as their Active ARR (manual override log). Match by account name case-insensitive."""
    q = select(ActiveARRAccountOverride).where(ActiveARRAccountOverride.use_open_renewal_arr == 1)
    r = await db.execute(q)
    return {(row.account_name or "").strip().lower() for row in r.scalars().all() if (row.account_name or "").strip()}


@app.get("/api/health")
async def health():
    """No auth. Returns 200 so the frontend can check backend reachability before login."""
    return {
        "ok": True,
        # Admin ARR breakdown: POST /api/arr-schedule/arr-breakdown or GET active-arr?breakdown_q=
        "features": {"arr_breakdown_post": True, "arr_breakdown_query_param": True},
    }


@app.get("/api/auth/check")
async def auth_check():
    """
    No logic—just confirms the request passed the app password middleware.
    Use this for login verification instead of a data endpoint so 500s from DB/Salesforce don't show as "Invalid password."
    """
    return {"ok": True}


@app.get("/api/dashboard/overview-targets")
async def get_dashboard_overview_targets(db: AsyncSession = Depends(get_db)):
    """
    Read annual targets from OVERVIEW_2026P sheet snapshot.
    net_new_carr_ytd_target: H15 (row 15, col H = index 7) — full-year Net New Contracted ARR target.
    Returns null for any value not found / not yet synced.
    """
    RANGE = "OVERVIEW_2026P!A1:ZZ1000"
    r_snap = await db.execute(
        select(SheetSnapshot)
        .where(SheetSnapshot.range_name == RANGE)
        .order_by(SheetSnapshot.as_of.desc())
        .limit(1)
    )
    snap = r_snap.scalar_one_or_none()
    if not snap or not snap.data_json:
        return {"net_new_carr_ytd_target": None, "message": "No OVERVIEW_2026P snapshot. Run Refresh app data first."}
    try:
        data = json.loads(snap.data_json)
        row = data[14] if len(data) > 14 else []  # row 15 = index 14
        val = _to_float_sheet(row[7]) if len(row) > 7 else None  # col H = index 7
        return {"net_new_carr_ytd_target": val, "message": None}
    except Exception as e:
        return {"net_new_carr_ytd_target": None, "message": f"Could not read target: {str(e)[:80]}"}


@app.get("/api/dashboard-kpi", response_model=DashboardKPI)
async def get_dashboard_kpi(db: AsyncSession = Depends(get_db)):
    """
    ARR and Pipeline from Salesforce. ARR = sum(TotalPrice) for product lines on open renewal opportunities.
    Pipeline = sum(Amount) for open opportunities (not Closed Won / Closed Lost).
    On any error (DB, missing table, etc.) returns zeros so the dashboard still loads; the error is logged.
    """
    try:
        # Open opportunities (stage not closed)
        q_open = select(Opportunity).where(
            Opportunity.stage_name.isnot(None),
            ~Opportunity.stage_name.in_(CLOSED_STAGES),
        )
        r = await db.execute(q_open)
        open_opps = r.scalars().all()
        # Renewals = open opportunities with Record Type = Renewal (case-insensitive)
        renewal_sf_ids = {o.sf_id for o in open_opps if _is_renewal_record_type(o.record_type_name)}

        # ARR = sum of line item total_price (MRR) * 12, excluding iVerify Monthly Credits and Kipu API
        mrr = 0.0
        if renewal_sf_ids:
            q_lines = select(OpportunityLineItem).where(
                OpportunityLineItem.opportunity_sf_id.in_(renewal_sf_ids)
            )
            r_lines = await db.execute(q_lines)
            for li in r_lines.scalars().all():
                raw = _normalized_product_name(li.product_name)
                if not _include_line_item_in_arr(raw, li.product_name):
                    continue
                mrr += _line_item_effective_total(li)
        arr = mrr * ARR_MULTIPLIER

        # Pipeline = sum(Amount) for open opportunities
        q_pipeline = select(func.coalesce(func.sum(Opportunity.amount), 0)).where(
            Opportunity.stage_name.isnot(None),
            ~Opportunity.stage_name.in_(CLOSED_STAGES),
        )
        pipeline = (await db.execute(q_pipeline)).scalar() or 0.0

        # Latest sync time (max synced_at from opportunities)
        q_sync = select(func.max(Opportunity.synced_at))
        sync_result = await db.execute(q_sync)
        salesforce_synced_at = sync_result.scalar()

        return DashboardKPI(
            arr=float(arr),
            pipeline=float(pipeline),
            salesforce_synced_at=salesforce_synced_at,
        )
    except Exception as e:
        _logger.exception("dashboard-kpi failed: %s", e)
        return DashboardKPI(arr=0.0, pipeline=0.0, salesforce_synced_at=None)


def _to_float_sheet(x) -> Optional[float]:
    if x is None:
        return None
    if isinstance(x, (int, float)):
        return float(x)
    if isinstance(x, str) and x.strip():
        try:
            return float(x.replace(",", "").strip())
        except ValueError:
            return None
    return None


def _to_float_sheet_pct(x) -> Optional[float]:
    """Like _to_float_sheet but also strips '%' so '60%' or '60' parses; for renewal rate plan cells."""
    if x is None:
        return None
    if isinstance(x, (int, float)):
        return float(x)
    if isinstance(x, str) and x.strip():
        s = x.replace(",", "").strip().rstrip("%").strip()
        if not s:
            return None
        try:
            return float(s)
        except ValueError:
            return None
    return None


def _bookings_row(mtd: float, plan_val: Optional[float]) -> BookingsMTDRow:
    achievement_pct = (mtd / plan_val * 100) if plan_val and plan_val != 0 else None
    delta_k = (mtd - plan_val) / 1000.0 if plan_val is not None else None
    return BookingsMTDRow(mtd=mtd, plan=plan_val, achievement_pct=achievement_pct, delta_k=delta_k)


def _renewals_row_dollars(mtd: float, plan_val: Optional[float]) -> RenewalsMTDRow:
    achievement_pct = (mtd / plan_val * 100) if plan_val is not None and plan_val != 0 else None
    delta_k = (mtd - plan_val) / 1000.0 if plan_val is not None else None
    return RenewalsMTDRow(mtd=mtd, plan=plan_val, achievement_pct=achievement_pct, delta_k=delta_k, is_rate=False)


def _renewals_row_open(mtd: float) -> RenewalsMTDRow:
    return RenewalsMTDRow(mtd=mtd, plan=None, achievement_pct=None, delta_k=None, is_rate=False)


def _renewals_row_rate(mtd: float, plan_val: Optional[float]) -> RenewalsMTDRow:
    achievement_pct = (mtd / plan_val * 100) if plan_val is not None and plan_val != 0 else None
    delta_k = (mtd - plan_val) * 100.0 if plan_val is not None else None  # percentage points
    return RenewalsMTDRow(mtd=mtd, plan=plan_val, achievement_pct=achievement_pct, delta_k=delta_k, is_rate=True)


def _renewals_row_rate_optional(mtd: Optional[float], plan_val: Optional[float]) -> RenewalsMTDRow:
    if mtd is None:
        return RenewalsMTDRow(mtd=0.0, plan=plan_val, achievement_pct=None, delta_k=None, is_rate=True)
    return _renewals_row_rate(mtd, plan_val)


def _sheet_rate_fraction(x: Optional[float]) -> Optional[float]:
    """Sheet may store 0.85 or 85 for renewal rate."""
    if x is None:
        return None
    if x > 1.0:
        return x / 100.0
    return float(x)


def _bu54_percent_to_fraction(x: Optional[float]) -> Optional[float]:
    """
    BU54 (BV54, …) is a **percentage** in the ARR model: ``12`` = 12%, ``-3`` = −3%.
    Google Sheets may also send decimals: ``0.12`` = 12% (already a fraction); leave as-is when |x| ≤ 1.
    """
    if x is None:
        return None
    v = float(x)
    if abs(v) > 1.0:
        return v / 100.0
    return v


def _renewal_effective_date(o: Opportunity) -> Optional[date]:
    return o.renewal_date if o.renewal_date is not None else o.close_date


def _is_renewal_effective_date_in_range(o: Opportunity, d_start: date, d_end: date) -> bool:
    rd = _renewal_effective_date(o)
    return rd is not None and d_start <= rd <= d_end


def _renewal_delta_for_opp(o: Opportunity) -> tuple[Optional[float], Optional[float]]:
    """Up-for-renewal ARR and delta (renewed − UFR) for closed opps; same as renewals-overview."""
    up = float(o.original_acv) if o.original_acv is not None else None
    st = (o.stage_name or "").strip()
    renewed: Optional[float] = None
    delta: Optional[float] = None
    if _is_closed_lost_stage(st):
        renewed = 0.0
        if up is not None:
            delta = round(renewed - float(up), 2)
    elif _is_closed_won_stage(st):
        if o.opportunity_arr is not None:
            renewed = round(float(o.opportunity_arr), 2)
        if up is not None and renewed is not None:
            delta = round(float(renewed) - float(up), 2)
    return up, delta


def _plan_dollars_match_bookings(plan_val: Optional[float], actual: float) -> Optional[float]:
    """Normalize sheet plan units to dollars (same heuristic as dashboard bookings MTD)."""
    if plan_val is None:
        return None
    if actual > 0 and 0 < plan_val < actual / 100:
        return plan_val * 1000.0
    if actual == 0 and 0 < plan_val < 10000:
        return plan_val * 1000.0
    return plan_val


def _sheet_cell_float(data: list, row_0: int, col_idx: int) -> Optional[float]:
    if row_0 < 0 or row_0 >= len(data):
        return None
    row = data[row_0]
    if col_idx < 0 or col_idx >= len(row):
        return None
    return _to_float_sheet(row[col_idx])


def _sheet_cell_a1(data: list, a1: str, *, pct: bool = False) -> Optional[float]:
    """Read one cell from a grid snapshot (Excel row 1 = ``data[0]``). ``a1`` e.g. ``BU52`` = column BU, row 52."""
    m = re.match(r"^([A-Z]+)(\d+)$", (a1 or "").strip().upper())
    if not m:
        return None
    letters, row_s = m.group(1), m.group(2)
    row_0 = int(row_s) - 1
    if row_0 < 0 or row_0 >= len(data):
        return None
    col_0 = _a1_col_to_index(letters)
    row = data[row_0]
    if col_0 < 0 or col_0 >= len(row):
        return None
    raw = row[col_0]
    return _to_float_sheet_pct(raw) if pct else _to_float_sheet(raw)


def _patch_sheet_cell_a1(data: list, a1: str, value: Any) -> list:
    """Write one cell into a grid snapshot (Excel row 1 = ``data[0]``). Mutates and returns ``data``."""
    m = re.match(r"^([A-Z]+)(\d+)$", (a1 or "").strip().upper())
    if not m:
        return data
    letters, row_s = m.group(1), m.group(2)
    row_0 = int(row_s) - 1
    col_0 = _a1_col_to_index(letters)
    while len(data) <= row_0:
        data.append([])
    row = list(data[row_0])
    while len(row) <= col_0:
        row.append(None)
    row[col_0] = value
    data[row_0] = row
    return data


def _merge_arr_2026p_bu35_from_direct_cell(connector: Any, range_name: str, data: list) -> list:
    """
    After a full-tab A1 read, stamp BU35 from a direct ``!BU35:BU35`` fetch (raw cell value;
    cancelled plan applies ``−BU35`` when computing MTD/QTD).
    """
    if "ARR_Calculations_2026P" not in range_name or "!A1" not in range_name.upper():
        return data
    m = re.match(r"^([^!]+)!", range_name)
    if not m:
        return data
    sheet = m.group(1).strip()
    mini = f"{sheet}!BU35:BU35"
    try:
        small = connector.read_range_values_raw(mini)
        if not small or not small[0]:
            return data
        val = small[0][0]
    except Exception:
        return data
    return _patch_sheet_cell_a1(data, "BU35", val)


def _pad_sheet_snapshot_for_renewals_plan(data: list) -> list:
    """
    Google Sheets JSON exports are often **jagged** (short rows omit trailing empty cells).
    Renewals reads need row 35 / column BU (BU35) and rows 33,52,54 through column CF — pad so those cells exist.
    """
    if not isinstance(data, list) or not data:
        return data
    month_cols = ARR_2026P_MONTH_COLUMNS
    max_col = max(_a1_col_to_index(c) for c in month_cols)
    # Excel rows 33 (UFR), 35 (cancelled BU35), 52 (BU52), 54 (BU54) → 0-based indices
    row_indices = (
        ARR_2026P_RENEWALS_UFR_ROW,
        RENEWALS_CANCELLED_PLAN_ROW - 1,
        51,
        53,
    )
    need_len = max(row_indices) + 1
    out = list(data)
    while len(out) < need_len:
        out.append([])
    for row_0 in row_indices:
        if row_0 < len(out):
            r = list(out[row_0])
            while len(r) <= max_col:
                r.append(None)
            out[row_0] = r
    return out


def _renewals_read_month_raw(
    data: list,
    month_idx: int,
) -> tuple[Optional[float], Optional[float], Optional[float], Optional[float]]:
    """UFR from fixed row; BU52/BU54/BU35 (Jan = BU…). BU54 is %; cancelled plan uses −BU35 (Jan = BU35 cell)."""
    col_letters = ARR_2026P_MONTH_COLUMNS[month_idx]
    col_idx = _a1_col_to_index(col_letters)
    ufr = _sheet_cell_float(data, ARR_2026P_RENEWALS_UFR_ROW, col_idx)
    bu52 = _sheet_cell_a1(data, f"{col_letters}52", pct=True)
    bu54 = _sheet_cell_a1(data, f"{col_letters}54", pct=True)
    # Cancelled plan $ = −cell on row 35 (Jan **BU35**; Feb BV35, …).
    if month_idx == 0:
        bu35 = _sheet_cell_a1(data, "BU35", pct=False)
    else:
        bu35 = _sheet_cell_a1(data, f"{col_letters}{RENEWALS_CANCELLED_PLAN_ROW}", pct=False)
    return ufr, bu52, bu54, bu35


def _renewals_qtd_ufr_by_month(
    renewal_opps: list,
    year: int,
    qtd_first: date,
    qtd_last: date,
    month_indices: list[int],
) -> dict[int, float]:
    """Actual UFR per sheet month index (0=Jan..11=Dec) for months in the quarter, renewal date in [qtd_first, qtd_last]."""
    out: dict[int, float] = {}
    for mi in month_indices:
        cal_m = mi + 1

        def _pf(rd: date, cm: int = cal_m) -> bool:
            return rd.year == year and rd.month == cm and qtd_first <= rd <= qtd_last

        ufr, *_ = _aggregate_renewals_actuals(renewal_opps, _pf)
        out[mi] = ufr
    return out


def _renewals_plan_bundle(
    data: list,
    month_idx: int,
    act_ufr: float,
    act_churn: float,
    act_contraction: float,
    act_cancelled: float,
    act_renewed: float,
) -> tuple[
    Optional[float],
    Optional[float],
    Optional[float],
    Optional[float],
    Optional[float],
    Optional[float],
]:
    """Plan values for one month (dollars / rate 0–1). UFR plan = actual UFR; open plan omitted at caller."""
    _, bu52_raw, bu54_raw, bu35_raw = _renewals_read_month_raw(data, month_idx)
    ufr_p = round(float(act_ufr), 2)
    bu52 = _sheet_rate_fraction(bu52_raw)
    bu54 = _bu54_percent_to_fraction(bu54_raw)
    churn_p: Optional[float] = None
    contr_p: Optional[float] = None
    renewed_p: Optional[float] = None
    rate_p: Optional[float] = bu52
    # Cancelled plan $ = −BU35 (sheet cell is signed opposite to how we display plan vs actual).
    canc_p = _plan_dollars_match_bookings(
        -float(bu35_raw) if bu35_raw is not None else None,
        act_cancelled,
    )

    if ufr_p is not None and bu52 is not None:
        churn_p = round((1.0 - bu52) * ufr_p, 2)
    # Contraction plan: model cell BU54 (e.g. Jan = BU54) — plan $ = −BU54 × up for renewal (rate from sheet).
    if ufr_p is not None and bu54 is not None:
        contr_p = round(-bu54 * ufr_p, 2)
    if ufr_p is not None and churn_p is not None and contr_p is not None:
        renewed_p = round(ufr_p - churn_p - contr_p, 2)
    elif ufr_p is not None and churn_p is not None and contr_p is None:
        renewed_p = round(ufr_p - churn_p, 2)
    elif ufr_p is not None and churn_p is None and contr_p is not None:
        renewed_p = round(ufr_p - contr_p, 2)

    return ufr_p, churn_p, contr_p, renewed_p, rate_p, canc_p


def _renewals_plan_bundle_qtd(
    data: list,
    month_indices: list[int],
    act_ufr: float,
    act_churn: float,
    act_contraction: float,
    act_cancelled: float,
    act_renewed: float,
    act_ufr_by_month: dict[int, float],
) -> tuple[
    Optional[float],
    Optional[float],
    Optional[float],
    Optional[float],
    Optional[float],
    Optional[float],
]:
    """QTD plan: UFR plan = actual UFR; churn/contraction per month; cancelled plan $ = −sum of row-35 cells (BV35…); rate UFR-weighted."""
    if not month_indices:
        return None, None, None, None, None, None

    sum_churn_raw = 0.0
    sum_contr_raw = 0.0
    sum_canc_raw = 0.0
    rate_num = 0.0
    rate_den = 0.0

    for mi in month_indices:
        _, bu52_raw, bu54_raw, bu35_raw = _renewals_read_month_raw(data, mi)
        ufr_v = float(act_ufr_by_month.get(mi, 0.0))
        bu52 = _sheet_rate_fraction(bu52_raw)
        bu54 = _bu54_percent_to_fraction(bu54_raw)
        if bu52 is not None:
            sum_churn_raw += (1.0 - bu52) * ufr_v
            rate_num += bu52 * ufr_v
            rate_den += ufr_v
        if bu54 is not None:
            sum_contr_raw += -bu54 * ufr_v
        sum_canc_raw -= bu35_raw or 0.0  # −BU35 per month

    ufr_p = round(float(act_ufr), 2)
    churn_p = _plan_dollars_match_bookings(sum_churn_raw, act_churn)
    contr_p = _plan_dollars_match_bookings(sum_contr_raw, act_contraction)
    canc_p = _plan_dollars_match_bookings(sum_canc_raw, act_cancelled)
    rate_p = round(rate_num / rate_den, 6) if rate_den and rate_den > 0 else None
    renewed_p: Optional[float] = None
    if ufr_p is not None and churn_p is not None and contr_p is not None:
        renewed_p = round(ufr_p - churn_p - contr_p, 2)
    elif ufr_p is not None and churn_p is not None:
        renewed_p = round(ufr_p - churn_p, 2)
    elif ufr_p is not None and contr_p is not None:
        renewed_p = round(ufr_p - contr_p, 2)

    return ufr_p, churn_p, contr_p, renewed_p, rate_p, canc_p


def _aggregate_renewals_actuals(
    renewal_opps: list,
    period_filter,
    expansion_opps: list | None = None,
) -> tuple[float, float, float, float, float, Optional[float], float]:
    """Returns (ufr, open_ufr, churn_ufr, contraction_mag, renewed, rate_or_none, cancelled_ufr). Excludes mid-term from main metrics.

    cancelled_ufr includes:
    - Renewal opps with midterm_cancellation=1 that are Closed Lost (bucketed by renewal_date or close_date).
    - Expansion opps that are Closed Won with negative opportunity_arr / ARR__c (bucketed by close_date).
    """
    ufr = 0.0
    open_ufr = 0.0
    churn_ufr = 0.0
    contraction_mag = 0.0
    cancelled_ufr = 0.0

    for o in renewal_opps:
        rd = _renewal_effective_date(o)
        if rd is None or not period_filter(rd):
            continue
        mid = getattr(o, "midterm_cancellation", 0) == 1
        st = (o.stage_name or "").strip()
        up, delta = _renewal_delta_for_opp(o)

        if mid:
            if _is_closed_lost_stage(st) and up is not None:
                cancelled_ufr += float(up)
            continue

        if up is None:
            continue
        ufr += float(up)

        if _is_closed_lost_stage(st):
            churn_ufr += float(up)
        elif _is_closed_won_stage(st):
            if delta is not None and delta < 0:
                contraction_mag += -float(delta)
        else:
            open_ufr += float(up)

    for o in (expansion_opps or []):
        cd = o.close_date
        if cd is None or not period_filter(cd):
            continue
        if not _is_closed_won_stage((o.stage_name or "").strip()):
            continue
        opp_arr = getattr(o, "opportunity_arr", None)
        if opp_arr is not None and float(opp_arr) < 0:
            cancelled_ufr += -float(opp_arr)

    rate: Optional[float] = None
    if ufr > 0:
        rate = round((ufr - churn_ufr - contraction_mag) / ufr, 6)

    renewed = round(max(0.0, ufr - open_ufr - churn_ufr - contraction_mag), 2)
    return (
        round(ufr, 2),
        round(open_ufr, 2),
        round(churn_ufr, 2),
        round(contraction_mag, 2),
        renewed,
        rate,
        round(cancelled_ufr, 2),
    )


# Owner names to exclude from bookings **for New Business opportunities only** (e.g. internal / admin).
# Case-insensitive match; use ``_is_excluded_from_bookings_nb_only`` in opportunity flows.
BOOKINGS_EXCLUDED_OWNER_NAMES = frozenset({"marcel scheurer"})


def _is_excluded_from_bookings(o: Opportunity) -> bool:
    """True if this opportunity's owner is on ``BOOKINGS_EXCLUDED_OWNER_NAMES`` (case-insensitive)."""
    name = (o.owner_name or "").strip()
    return name.lower() in BOOKINGS_EXCLUDED_OWNER_NAMES


def _is_excluded_from_bookings_nb_only(o: Opportunity, record_type_name: Optional[str]) -> bool:
    """Owner exclusion list applies only to **New Business** opportunities (effective record type)."""
    if not _is_new_business_record_type(record_type_name):
        return False
    return _is_excluded_from_bookings(o)


def _booking_arr_expansion_or_arr_c(o: Opportunity) -> float:
    """Booking slice that uses ``Expansion_ARR__c``; if null after sync, fall back to ``ARR__c`` (often identical on SF). Never derive from MRR × 12."""
    if getattr(o, "expansion_arr", None) is not None:
        return max(0.0, float(o.expansion_arr))
    if o.opportunity_arr is not None:
        return max(0.0, float(o.opportunity_arr))
    return 0.0


def _closed_overview_arr_from_opportunity(o: Opportunity, effective_rt: str) -> float:
    """Booking-style ARR from Salesforce Opportunity fields only (no line-item rollup).

    Shared by ``GET /api/closed-overview`` and dashboard bookings (``_closed_won_arr_in_range``).

    Closed Won **New Business** → ``opportunity_arr`` (``ARR__c``).
    Closed Won **Expansion**, **Renewal**, or **Amendment** → ``Expansion_ARR__c``, else ``ARR__c`` if expansion field missing.
    Closed Lost → 0.
    """
    stage = (o.stage_name or "").strip()
    if _is_closed_lost_stage(stage):
        return 0.0
    if not _is_closed_won_stage(stage):
        return 0.0
    rt = effective_rt
    # Renewal / amendment before expansion so record-type names that include both keywords are unambiguous.
    if _is_renewal_record_type(rt) or _is_amendment_record_type(rt):
        return _booking_arr_expansion_or_arr_c(o)
    if _is_expansion_record_type(rt):
        return _booking_arr_expansion_or_arr_c(o)
    if _is_new_business_record_type(rt):
        val = float(o.opportunity_arr) if o.opportunity_arr is not None else 0.0
        return max(0.0, val)
    return 0.0


async def _closed_won_arr_in_range(
    db: AsyncSession,
    first_day: date,
    last_day: date,
) -> tuple[float, float, float]:
    """Return ``(total, new_business, expansion_mid_term)`` for Closed Won **pipeline** opps in the date window.

    **New Business** → ``opportunity_arr`` (``ARR__c``); **Expansion** → ``expansion_arr`` (``Expansion_ARR__c``).
    Record-type overrides apply. Renewals are excluded here (see ``_closed_won_renewal_expansion_arr_in_range``).
    """
    overrides = await _get_record_type_overrides(db)

    def _effective_record_type(o: Opportunity) -> str:
        key = (o.sf_id or "").strip()
        override = overrides.get(key) or (overrides.get(key[:15]) if len(key) >= 15 else None)
        return (override or o.record_type_name or "").strip() or "—"

    q_closed = select(Opportunity).where(
        Opportunity.stage_name == "Closed Won",
        Opportunity.close_date.isnot(None),
        Opportunity.close_date >= first_day,
        Opportunity.close_date <= last_day,
    )
    r = await db.execute(q_closed)
    closed_opps = [
        o
        for o in r.scalars().all()
        if _is_pipeline_record_type(_effective_record_type(o))
        and not _is_excluded_from_bookings_nb_only(o, _effective_record_type(o))
    ]
    nb, exp = 0.0, 0.0
    for o in closed_opps:
        rt = _effective_record_type(o)
        arr = _closed_overview_arr_from_opportunity(o, rt)
        rt_l = rt.strip().lower()
        if rt_l == "new business":
            nb += arr
        elif rt_l == "expansion":
            exp += arr
    return round(nb + exp, 2), round(nb, 2), round(exp, 2)


def _earliest_included_line_start_for_opp(o, lines: list) -> date | None:
    """Min service_start_date among ARR line items; else opportunity contract_start_date."""
    dates: list[date] = []
    for li in lines:
        if li.opportunity_sf_id != o.sf_id:
            continue
        raw = _normalized_product_name(li.product_name)
        if not _include_line_item_in_arr(raw, li.product_name):
            continue
        if li.service_start_date:
            dates.append(li.service_start_date)
    if dates:
        return min(dates)
    return o.contract_start_date


def _closed_won_pipeline_opp_arr_from_lines(opp_sf_id: str, lines: list) -> float:
    """ARR from product lines (used for future-start / contracted cohort math; dashboard bookings use Opportunity fields)."""
    t = 0.0
    for li in lines:
        if li.opportunity_sf_id != opp_sf_id:
            continue
        raw = _normalized_product_name(li.product_name)
        if not _include_line_item_in_arr(raw, li.product_name):
            continue
        t += _line_item_effective_total(li) * PIPELINE_ARR_MULTIPLIER
    return round(t, 2)


def _future_arr_lookup_for_account(
    future_by_account: dict[tuple[str | None, str | None], float],
    aid: str | None,
    aname: str | None,
) -> float:
    """Match future closed-won ARR to a renewal row by account id / name."""
    if (aid, aname) in future_by_account:
        return float(future_by_account[(aid, aname)])
    for (k_aid, _k_aname), val in future_by_account.items():
        if _sf_account_ids_match(aid, k_aid):
            return float(val)
    return 0.0


async def _future_start_closed_won_nb_exp_arr_by_account(
    db: AsyncSession,
    as_of: date,
) -> tuple[float, dict[tuple[str | None, str | None], float]]:
    """
    Closed Won New Business + Expansion opportunities whose service (earliest included line start,
    else contract_start_date) is strictly after ``as_of`` (America/New_York calendar date).
    Returns (total ARR, per-account map keyed by (account_id, account_name)).
    """
    overrides = await _get_record_type_overrides(db)

    def _effective_record_type(o: Opportunity) -> str:
        key = (o.sf_id or "").strip()
        override = overrides.get(key) or (overrides.get(key[:15]) if len(key) >= 15 else None)
        return (override or o.record_type_name or "").strip() or "—"

    q = select(Opportunity).where(Opportunity.stage_name.isnot(None))
    r = await db.execute(q)
    closed_won_opps = [
        o
        for o in r.scalars().all()
        if _is_closed_won_stage(o.stage_name)
        and _is_pipeline_record_type(_effective_record_type(o))
        and not _is_excluded_from_bookings_nb_only(o, _effective_record_type(o))
    ]
    if not closed_won_opps:
        return 0.0, {}
    sf_ids = {o.sf_id for o in closed_won_opps if o.sf_id}
    if not sf_ids:
        return 0.0, {}
    q_lines = select(OpportunityLineItem).where(OpportunityLineItem.opportunity_sf_id.in_(sf_ids))
    r_lines = await db.execute(q_lines)
    all_lines = list(r_lines.scalars().all())
    by_opp: dict[str, list] = {}
    for li in all_lines:
        oid = li.opportunity_sf_id
        by_opp.setdefault(oid, []).append(li)
    out: dict[tuple[str | None, str | None], float] = {}
    total = 0.0
    for o in closed_won_opps:
        lines = by_opp.get(o.sf_id, [])
        earliest = _earliest_included_line_start_for_opp(o, lines)
        if earliest is None or earliest <= as_of:
            continue
        arr = _closed_won_pipeline_opp_arr_from_lines(o.sf_id, lines)
        if arr <= 0:
            continue
        key = (o.account_id, o.account_name or None)
        out[key] = out.get(key, 0.0) + arr
        total += arr
    rounded = {k: round(v, 2) for k, v in out.items()}
    return round(total, 2), rounded


async def _future_start_closed_won_nb_exp_crm_seats_by_account(
    db: AsyncSession,
    as_of: date,
) -> tuple[int, dict[tuple[str | None, str | None], int]]:
    """
    Same Closed Won New Business + Expansion cohort as future ARR (service start after ``as_of``),
    but sum CRM seats from line items (Additional CRM Seats qty + 5 per Platform Includes 5 Seats).
    """
    overrides = await _get_record_type_overrides(db)

    def _effective_record_type(o: Opportunity) -> str:
        key = (o.sf_id or "").strip()
        override = overrides.get(key) or (overrides.get(key[:15]) if len(key) >= 15 else None)
        return (override or o.record_type_name or "").strip() or "—"

    q = select(Opportunity).where(Opportunity.stage_name.isnot(None))
    r = await db.execute(q)
    closed_won_opps = [
        o
        for o in r.scalars().all()
        if _is_closed_won_stage(o.stage_name)
        and _is_pipeline_record_type(_effective_record_type(o))
        and not _is_excluded_from_bookings_nb_only(o, _effective_record_type(o))
    ]
    if not closed_won_opps:
        return 0, {}
    sf_ids = {o.sf_id for o in closed_won_opps if o.sf_id}
    if not sf_ids:
        return 0, {}
    q_lines = select(OpportunityLineItem).where(OpportunityLineItem.opportunity_sf_id.in_(sf_ids))
    r_lines = await db.execute(q_lines)
    all_lines = list(r_lines.scalars().all())
    by_opp: dict[str, list] = {}
    for li in all_lines:
        oid = li.opportunity_sf_id
        by_opp.setdefault(oid, []).append(li)
    out: dict[tuple[str | None, str | None], int] = {}
    total = 0
    for o in closed_won_opps:
        lines = by_opp.get(o.sf_id, [])
        earliest = _earliest_included_line_start_for_opp(o, lines)
        if earliest is None or earliest <= as_of:
            continue
        seats = _crm_seats_for_opportunity_lines(o.sf_id, lines)
        if seats <= 0:
            continue
        key = (o.account_id, o.account_name or None)
        out[key] = out.get(key, 0) + seats
        total += seats
    return total, out


def _open_pipeline_arr_from_opps(
    open_opps: list, opp_to_arr_from_lines: dict[str, float]
) -> tuple[float, float]:
    """Split ARR by record type (New Business / Expansion). Per-opp ARR: o.mrr when set, else opp_to_arr_from_lines."""
    nb, exp = 0.0, 0.0
    for o in open_opps:
        if o.mrr is not None and o.mrr != 0:
            arr = round(float(o.mrr) * PIPELINE_ARR_MULTIPLIER, 2)
        else:
            arr = opp_to_arr_from_lines.get(o.sf_id, 0)
        rt = (o.record_type_name or "").strip().lower()
        if rt == "new business":
            nb += arr
        elif rt == "expansion":
            exp += arr
    return round(nb, 2), round(exp, 2)


async def _open_pipeline_arr_by_record_type(db: AsyncSession) -> tuple[float, float]:
    """Return (new_business_arr, expansion_arr) for all open pipeline (not Closed Won/Lost). Same logic as pipeline-overview: Opportunity.MRR when set, else line-item ARR."""
    q = select(Opportunity).where(
        Opportunity.stage_name.isnot(None),
        ~Opportunity.stage_name.in_(CLOSED_STAGES),
    )
    r = await db.execute(q)
    open_opps = [o for o in r.scalars().all() if _is_pipeline_record_type(o.record_type_name)]
    if not open_opps:
        return 0.0, 0.0
    sf_ids = {o.sf_id for o in open_opps}
    opp_to_arr_from_lines = await _line_item_arr_for_opportunities(db, sf_ids)
    return _open_pipeline_arr_from_opps(open_opps, opp_to_arr_from_lines)


async def _open_pipeline_arr_by_record_type_in_range(
    db: AsyncSession,
    first_day: date,
    last_day: date,
) -> tuple[float, float]:
    """Return (new_business_arr, expansion_arr) for open pipeline with close_date in [first_day, last_day]. Same ARR logic as pipeline-overview (MRR when set, else line items)."""
    q = select(Opportunity).where(
        Opportunity.stage_name.isnot(None),
        ~Opportunity.stage_name.in_(CLOSED_STAGES),
        Opportunity.close_date.isnot(None),
        Opportunity.close_date >= first_day,
        Opportunity.close_date <= last_day,
    )
    r = await db.execute(q)
    open_opps = [o for o in r.scalars().all() if _is_pipeline_record_type(o.record_type_name)]
    if not open_opps:
        return 0.0, 0.0
    sf_ids = {o.sf_id for o in open_opps}
    opp_to_arr_from_lines = await _line_item_arr_for_opportunities(db, sf_ids)
    return _open_pipeline_arr_from_opps(open_opps, opp_to_arr_from_lines)


async def _line_item_arr_for_opportunities(db: AsyncSession, sf_ids: set) -> dict[str, float]:
    """Build opp_sf_id -> ARR from line items (same product filter as pipeline-overview)."""
    opp_to_arr: dict[str, float] = {}
    q_lines = select(OpportunityLineItem).where(OpportunityLineItem.opportunity_sf_id.in_(sf_ids))
    r_lines = await db.execute(q_lines)
    for li in r_lines.scalars().all():
        raw = _normalized_product_name(li.product_name)
        if not _include_line_item_in_arr(raw, li.product_name):
            continue
        opp_sf_id = li.opportunity_sf_id
        mrr = _line_item_effective_total(li)
        opp_to_arr[opp_sf_id] = opp_to_arr.get(opp_sf_id, 0) + mrr * PIPELINE_ARR_MULTIPLIER
    return {k: round(v, 2) for k, v in opp_to_arr.items()}


async def _closed_won_renewal_expansion_arr_in_range(
    db: AsyncSession,
    first_day: date,
    last_day: date,
) -> float:
    """Return sum of **Upon renewal** booking ARR: Closed Won **renewal** opps in range, using Expansion_ARR__c only.

    Stored as ``Opportunity.expansion_arr`` (Salesforce ``Expansion_ARR__c``). Closed Lost contributes 0 (not queried).
    """
    overrides = await _get_record_type_overrides(db)

    def _effective_record_type(o: Opportunity) -> str:
        key = (o.sf_id or "").strip()
        override = overrides.get(key) or (overrides.get(key[:15]) if len(key) >= 15 else None)
        return (override or o.record_type_name or "").strip() or "—"

    q = select(Opportunity).where(
        Opportunity.stage_name == "Closed Won",
        Opportunity.close_date.isnot(None),
        Opportunity.close_date >= first_day,
        Opportunity.close_date <= last_day,
    )
    r = await db.execute(q)
    closed = [
        o
        for o in r.scalars().all()
        if _is_renewal_record_type(_effective_record_type(o))
        and not _is_excluded_from_bookings_nb_only(o, _effective_record_type(o))
    ]
    if not closed:
        return 0.0
    total = 0.0
    for o in closed:
        total += _booking_arr_expansion_or_arr_c(o)
    return round(total, 2)


@app.get("/api/dashboard/bookings-mtd", response_model=BookingsMTDResponse)
async def get_dashboard_bookings_mtd(
    db: AsyncSession = Depends(get_db),
    fixed_periods: Optional[str] = Query(
        None,
        description="q1_2026 = Jan–Mar; q2_2026 = Apr–Jun; q3_2026 = Jul–Sep; q4_2026 = Oct–Dec (calendar quarters of 2026).",
    ),
):
    """
    Bookings vs plan: Closed Lost = 0. Closed Won **New Business** = ``ARR__c`` (NB row). **Expansion** row actual =
    mid-term + upon renewal (``Expansion_ARR__c`` on Expansion vs Renewal opps). Sub-rows split the two slices.
    **Total** = NB + mid-term + upon renewal. Plan from ARR_Calculations_2026P rows 11–12 (expansion plan vs combined actual).
    On any failure returns 200 + JSON so frontend never sees 500/non-JSON.
    """
    try:
        return await _get_dashboard_bookings_mtd_impl(db, fixed_periods=fixed_periods)
    except Exception as e:
        return JSONResponse(status_code=200, content=_safe_bookings_fallback(f"Error loading bookings: {str(e)[:100]}"))


async def _bookings_mtd_q1_2026(db: AsyncSession) -> BookingsMTDResponse:
    """Fixed columns: Jan 26, Feb 26, Mar 26, Q1 26 — full calendar months and full Q1 2026."""
    jan_first, jan_last = date(2026, 1, 1), date(2026, 1, 31)
    feb_first, feb_last = date(2026, 2, 1), date(2026, 2, 28)
    mar_first, mar_last = date(2026, 3, 1), date(2026, 3, 31)
    qtd_first = date(2026, 1, 1)
    last_day_quarter = date(2026, 3, 31)
    quarter_month = 1

    prev2_label = "Jan 26"
    prev_label = "Feb 26"
    current_label = "Mar 26"
    qtd_label = "Q1 26"

    plan_by_month: list[tuple[Optional[float], Optional[float]]] = [(None, None)] * 12
    plan_source: Optional[str] = None
    plan_message: Optional[str] = None
    sheet_range = "ARR_Calculations_2026P!A1:ZZ1000"
    r_snap = await db.execute(
        select(SheetSnapshot).where(SheetSnapshot.range_name == sheet_range).order_by(SheetSnapshot.as_of.desc()).limit(1)
    )
    snap = r_snap.scalar_one_or_none()
    if snap and snap.data_json:
        data = json.loads(snap.data_json)
        row_11 = data[10] if len(data) > 10 else []
        row_12 = data[11] if len(data) > 11 else []
        try:
            for m in range(12):
                col_idx = _a1_col_to_index(ARR_2026P_MONTH_COLUMNS[m])
                v11 = row_11[col_idx] if col_idx < len(row_11) else None
                v12 = row_12[col_idx] if col_idx < len(row_12) else None
                plan_by_month[m] = (_to_float_sheet(v11), _to_float_sheet(v12))
            plan_source = "ARR_Calculations_2026P"
        except (TypeError, ValueError, IndexError):
            plan_message = "Could not read plan from sheet."
    else:
        plan_message = "No sheet snapshot. Sync ARR_Calculations_2026P first."

    prev2_total, prev2_nb, prev2_exp = await _closed_won_arr_in_range(db, jan_first, jan_last)
    prev_total, prev_nb, prev_exp = await _closed_won_arr_in_range(db, feb_first, feb_last)
    mtd_total, mtd_nb, mtd_exp = await _closed_won_arr_in_range(db, mar_first, mar_last)
    qtd_total, qtd_nb, qtd_exp = await _closed_won_arr_in_range(db, qtd_first, last_day_quarter)
    prev2_renewal_exp = await _closed_won_renewal_expansion_arr_in_range(db, jan_first, jan_last)
    prev_renewal_exp = await _closed_won_renewal_expansion_arr_in_range(db, feb_first, feb_last)
    mtd_renewal_exp = await _closed_won_renewal_expansion_arr_in_range(db, mar_first, mar_last)
    qtd_renewal_exp = await _closed_won_renewal_expansion_arr_in_range(db, qtd_first, last_day_quarter)
    prev2_exp_mid_term, prev2_exp_upon_renewal = prev2_exp, prev2_renewal_exp
    prev_exp_mid_term, prev_exp_upon_renewal = prev_exp, prev_renewal_exp
    mtd_exp_mid_term, mtd_exp_upon_renewal = mtd_exp, mtd_renewal_exp
    qtd_exp_mid_term, qtd_exp_upon_renewal = qtd_exp, qtd_renewal_exp
    prev2_exp_combined = prev2_exp + prev2_renewal_exp
    prev_exp_combined = prev_exp + prev_renewal_exp
    mtd_exp_combined = mtd_exp + mtd_renewal_exp
    qtd_exp_combined = qtd_exp + qtd_renewal_exp
    prev2_total += prev2_renewal_exp
    prev_total += prev_renewal_exp
    mtd_total += mtd_renewal_exp
    qtd_total += qtd_renewal_exp

    p2_nb, p2_exp = plan_by_month[0]
    p2_tot = (p2_nb or 0) + (p2_exp or 0) if (p2_nb is not None or p2_exp is not None) else None
    p_nb, p_exp = plan_by_month[1]
    p_tot = (p_nb or 0) + (p_exp or 0) if (p_nb is not None or p_exp is not None) else None
    c_nb, c_exp = plan_by_month[2]
    c_tot = (c_nb or 0) + (c_exp or 0) if (c_nb is not None or c_exp is not None) else None
    q_nb = sum(plan_by_month[i][0] or 0 for i in range(0, 3))
    q_exp = sum(plan_by_month[i][1] or 0 for i in range(0, 3))
    q_tot = q_nb + q_exp

    first_of_month = mar_first
    last_day_month = mar_last
    pipeline_mtd_nb, pipeline_mtd_exp = await _open_pipeline_arr_by_record_type_in_range(db, first_of_month, last_day_month)
    pipeline_mtd_tot = pipeline_mtd_nb + pipeline_mtd_exp
    pipeline_qtd_nb, pipeline_qtd_exp = await _open_pipeline_arr_by_record_type_in_range(db, qtd_first, last_day_quarter)
    pipeline_qtd_tot = pipeline_qtd_nb + pipeline_qtd_exp

    def _plan_dollars(plan_val: Optional[float], actual: float) -> float:
        if plan_val is None:
            return 0.0
        if actual > 0 and 0 < plan_val < actual / 100:
            return plan_val * 1000.0
        if actual == 0 and 0 < plan_val < 10000:
            return plan_val * 1000.0
        return plan_val

    c_tot_d = _plan_dollars(c_tot, mtd_total)
    c_nb_d = _plan_dollars(c_nb, mtd_nb)
    c_exp_d = _plan_dollars(c_exp, mtd_exp_combined)
    q_tot_d = _plan_dollars(q_tot, qtd_total)
    q_nb_d = _plan_dollars(q_nb, qtd_nb)
    q_exp_d = _plan_dollars(q_exp, qtd_exp_combined)
    shortfall_mtd_tot = max(0, c_tot_d - mtd_total)
    shortfall_mtd_nb = max(0, c_nb_d - mtd_nb)
    shortfall_mtd_exp = max(0, c_exp_d - mtd_exp_combined)
    shortfall_qtd_tot = max(0, q_tot_d - qtd_total)
    shortfall_qtd_nb = max(0, q_nb_d - qtd_nb)
    shortfall_qtd_exp = max(0, q_exp_d - qtd_exp_combined)
    pipe_cov_mtd_tot = round(pipeline_mtd_tot / shortfall_mtd_tot, 2) if shortfall_mtd_tot > 0 else None
    pipe_cov_mtd_nb = round(pipeline_mtd_nb / shortfall_mtd_nb, 2) if shortfall_mtd_nb > 0 else None
    pipe_cov_mtd_exp = round(pipeline_mtd_exp / shortfall_mtd_exp, 2) if shortfall_mtd_exp > 0 else None
    pipe_cov_qtd_tot = round(pipeline_qtd_tot / shortfall_qtd_tot, 2) if shortfall_qtd_tot > 0 else None
    pipe_cov_qtd_nb = round(pipeline_qtd_nb / shortfall_qtd_nb, 2) if shortfall_qtd_nb > 0 else None
    pipe_cov_qtd_exp = round(pipeline_qtd_exp / shortfall_qtd_exp, 2) if shortfall_qtd_exp > 0 else None

    return BookingsMTDResponse(
        two_months_ago=BookingsPeriod(
            period_label=prev2_label,
            total=_bookings_row(prev2_total, p2_tot),
            new_business=_bookings_row(prev2_nb, p2_nb),
            expansion=_bookings_row(prev2_exp_combined, p2_exp),
            expansion_mid_term=prev2_exp_mid_term,
            expansion_upon_renewal=prev2_exp_upon_renewal,
            pipe_coverage_total=None,
            pipe_coverage_new_business=None,
            pipe_coverage_expansion=None,
        ),
        previous_month=BookingsPeriod(
            period_label=prev_label,
            total=_bookings_row(prev_total, p_tot),
            new_business=_bookings_row(prev_nb, p_nb),
            expansion=_bookings_row(prev_exp_combined, p_exp),
            expansion_mid_term=prev_exp_mid_term,
            expansion_upon_renewal=prev_exp_upon_renewal,
            pipe_coverage_total=None,
            pipe_coverage_new_business=None,
            pipe_coverage_expansion=None,
        ),
        current_mtd=BookingsPeriod(
            period_label=current_label,
            total=_bookings_row(mtd_total, c_tot),
            new_business=_bookings_row(mtd_nb, c_nb),
            expansion=_bookings_row(mtd_exp_combined, c_exp),
            expansion_mid_term=mtd_exp_mid_term,
            expansion_upon_renewal=mtd_exp_upon_renewal,
            pipe_coverage_total=pipe_cov_mtd_tot,
            pipe_coverage_new_business=pipe_cov_mtd_nb,
            pipe_coverage_expansion=pipe_cov_mtd_exp,
        ),
        qtd=BookingsPeriod(
            period_label=qtd_label,
            total=_bookings_row(qtd_total, q_tot),
            new_business=_bookings_row(qtd_nb, q_nb),
            expansion=_bookings_row(qtd_exp_combined, q_exp),
            expansion_mid_term=qtd_exp_mid_term,
            expansion_upon_renewal=qtd_exp_upon_renewal,
            pipe_coverage_total=pipe_cov_qtd_tot,
            pipe_coverage_new_business=pipe_cov_qtd_nb,
            pipe_coverage_expansion=pipe_cov_qtd_exp,
        ),
        plan_source=plan_source,
        plan_message=plan_message,
    )


async def _bookings_mtd_q2_2026(db: AsyncSession) -> BookingsMTDResponse:
    """Fixed columns: Apr 26, May 26, Jun 26, Q2 26 — full months; Q2 = calendar Q2 2026 (Apr+May+Jun)."""
    apr_first, apr_last = date(2026, 4, 1), date(2026, 4, 30)
    may_first, may_last = date(2026, 5, 1), date(2026, 5, 31)
    jun_first, jun_last = date(2026, 6, 1), date(2026, 6, 30)
    qtd_first = date(2026, 4, 1)
    last_day_quarter = date(2026, 6, 30)

    prev2_label = "Apr 26"
    prev_label = "May 26"
    current_label = "Jun 26"
    qtd_label = "Q2 26"

    plan_by_month: list[tuple[Optional[float], Optional[float]]] = [(None, None)] * 12
    plan_source: Optional[str] = None
    plan_message: Optional[str] = None
    sheet_range = "ARR_Calculations_2026P!A1:ZZ1000"
    r_snap = await db.execute(
        select(SheetSnapshot).where(SheetSnapshot.range_name == sheet_range).order_by(SheetSnapshot.as_of.desc()).limit(1)
    )
    snap = r_snap.scalar_one_or_none()
    if snap and snap.data_json:
        data = json.loads(snap.data_json)
        row_11 = data[10] if len(data) > 10 else []
        row_12 = data[11] if len(data) > 11 else []
        try:
            for m in range(12):
                col_idx = _a1_col_to_index(ARR_2026P_MONTH_COLUMNS[m])
                v11 = row_11[col_idx] if col_idx < len(row_11) else None
                v12 = row_12[col_idx] if col_idx < len(row_12) else None
                plan_by_month[m] = (_to_float_sheet(v11), _to_float_sheet(v12))
            plan_source = "ARR_Calculations_2026P"
        except (TypeError, ValueError, IndexError):
            plan_message = "Could not read plan from sheet."
    else:
        plan_message = "No sheet snapshot. Sync ARR_Calculations_2026P first."

    prev2_total, prev2_nb, prev2_exp = await _closed_won_arr_in_range(db, apr_first, apr_last)
    prev_total, prev_nb, prev_exp = await _closed_won_arr_in_range(db, may_first, may_last)
    mtd_total, mtd_nb, mtd_exp = await _closed_won_arr_in_range(db, jun_first, jun_last)
    qtd_total, qtd_nb, qtd_exp = await _closed_won_arr_in_range(db, qtd_first, last_day_quarter)
    prev2_renewal_exp = await _closed_won_renewal_expansion_arr_in_range(db, apr_first, apr_last)
    prev_renewal_exp = await _closed_won_renewal_expansion_arr_in_range(db, may_first, may_last)
    mtd_renewal_exp = await _closed_won_renewal_expansion_arr_in_range(db, jun_first, jun_last)
    qtd_renewal_exp = await _closed_won_renewal_expansion_arr_in_range(db, qtd_first, last_day_quarter)
    prev2_exp_mid_term, prev2_exp_upon_renewal = prev2_exp, prev2_renewal_exp
    prev_exp_mid_term, prev_exp_upon_renewal = prev_exp, prev_renewal_exp
    mtd_exp_mid_term, mtd_exp_upon_renewal = mtd_exp, mtd_renewal_exp
    qtd_exp_mid_term, qtd_exp_upon_renewal = qtd_exp, qtd_renewal_exp
    prev2_exp_combined = prev2_exp + prev2_renewal_exp
    prev_exp_combined = prev_exp + prev_renewal_exp
    mtd_exp_combined = mtd_exp + mtd_renewal_exp
    qtd_exp_combined = qtd_exp + qtd_renewal_exp
    prev2_total += prev2_renewal_exp
    prev_total += prev_renewal_exp
    mtd_total += mtd_renewal_exp
    qtd_total += qtd_renewal_exp

    p2_nb, p2_exp = plan_by_month[3]
    p2_tot = (p2_nb or 0) + (p2_exp or 0) if (p2_nb is not None or p2_exp is not None) else None
    p_nb, p_exp = plan_by_month[4]
    p_tot = (p_nb or 0) + (p_exp or 0) if (p_nb is not None or p_exp is not None) else None
    c_nb, c_exp = plan_by_month[5]
    c_tot = (c_nb or 0) + (c_exp or 0) if (c_nb is not None or c_exp is not None) else None
    q_nb = sum(plan_by_month[i][0] or 0 for i in range(3, 6))
    q_exp = sum(plan_by_month[i][1] or 0 for i in range(3, 6))
    q_tot = q_nb + q_exp

    first_of_month = jun_first
    last_day_month = jun_last
    pipeline_mtd_nb, pipeline_mtd_exp = await _open_pipeline_arr_by_record_type_in_range(db, first_of_month, last_day_month)
    pipeline_mtd_tot = pipeline_mtd_nb + pipeline_mtd_exp
    pipeline_qtd_nb, pipeline_qtd_exp = await _open_pipeline_arr_by_record_type_in_range(db, qtd_first, last_day_quarter)
    pipeline_qtd_tot = pipeline_qtd_nb + pipeline_qtd_exp

    def _plan_dollars(plan_val: Optional[float], actual: float) -> float:
        if plan_val is None:
            return 0.0
        if actual > 0 and 0 < plan_val < actual / 100:
            return plan_val * 1000.0
        if actual == 0 and 0 < plan_val < 10000:
            return plan_val * 1000.0
        return plan_val

    c_tot_d = _plan_dollars(c_tot, mtd_total)
    c_nb_d = _plan_dollars(c_nb, mtd_nb)
    c_exp_d = _plan_dollars(c_exp, mtd_exp_combined)
    q_tot_d = _plan_dollars(q_tot, qtd_total)
    q_nb_d = _plan_dollars(q_nb, qtd_nb)
    q_exp_d = _plan_dollars(q_exp, qtd_exp_combined)
    shortfall_mtd_tot = max(0, c_tot_d - mtd_total)
    shortfall_mtd_nb = max(0, c_nb_d - mtd_nb)
    shortfall_mtd_exp = max(0, c_exp_d - mtd_exp_combined)
    shortfall_qtd_tot = max(0, q_tot_d - qtd_total)
    shortfall_qtd_nb = max(0, q_nb_d - qtd_nb)
    shortfall_qtd_exp = max(0, q_exp_d - qtd_exp_combined)
    pipe_cov_mtd_tot = round(pipeline_mtd_tot / shortfall_mtd_tot, 2) if shortfall_mtd_tot > 0 else None
    pipe_cov_mtd_nb = round(pipeline_mtd_nb / shortfall_mtd_nb, 2) if shortfall_mtd_nb > 0 else None
    pipe_cov_mtd_exp = round(pipeline_mtd_exp / shortfall_mtd_exp, 2) if shortfall_mtd_exp > 0 else None
    pipe_cov_qtd_tot = round(pipeline_qtd_tot / shortfall_qtd_tot, 2) if shortfall_qtd_tot > 0 else None
    pipe_cov_qtd_nb = round(pipeline_qtd_nb / shortfall_qtd_nb, 2) if shortfall_qtd_nb > 0 else None
    pipe_cov_qtd_exp = round(pipeline_qtd_exp / shortfall_qtd_exp, 2) if shortfall_qtd_exp > 0 else None

    return BookingsMTDResponse(
        two_months_ago=BookingsPeriod(
            period_label=prev2_label,
            total=_bookings_row(prev2_total, p2_tot),
            new_business=_bookings_row(prev2_nb, p2_nb),
            expansion=_bookings_row(prev2_exp_combined, p2_exp),
            expansion_mid_term=prev2_exp_mid_term,
            expansion_upon_renewal=prev2_exp_upon_renewal,
            pipe_coverage_total=None,
            pipe_coverage_new_business=None,
            pipe_coverage_expansion=None,
        ),
        previous_month=BookingsPeriod(
            period_label=prev_label,
            total=_bookings_row(prev_total, p_tot),
            new_business=_bookings_row(prev_nb, p_nb),
            expansion=_bookings_row(prev_exp_combined, p_exp),
            expansion_mid_term=prev_exp_mid_term,
            expansion_upon_renewal=prev_exp_upon_renewal,
            pipe_coverage_total=None,
            pipe_coverage_new_business=None,
            pipe_coverage_expansion=None,
        ),
        current_mtd=BookingsPeriod(
            period_label=current_label,
            total=_bookings_row(mtd_total, c_tot),
            new_business=_bookings_row(mtd_nb, c_nb),
            expansion=_bookings_row(mtd_exp_combined, c_exp),
            expansion_mid_term=mtd_exp_mid_term,
            expansion_upon_renewal=mtd_exp_upon_renewal,
            pipe_coverage_total=pipe_cov_mtd_tot,
            pipe_coverage_new_business=pipe_cov_mtd_nb,
            pipe_coverage_expansion=pipe_cov_mtd_exp,
        ),
        qtd=BookingsPeriod(
            period_label=qtd_label,
            total=_bookings_row(qtd_total, q_tot),
            new_business=_bookings_row(qtd_nb, q_nb),
            expansion=_bookings_row(qtd_exp_combined, q_exp),
            expansion_mid_term=qtd_exp_mid_term,
            expansion_upon_renewal=qtd_exp_upon_renewal,
            pipe_coverage_total=pipe_cov_qtd_tot,
            pipe_coverage_new_business=pipe_cov_qtd_nb,
            pipe_coverage_expansion=pipe_cov_qtd_exp,
        ),
        plan_source=plan_source,
        plan_message=plan_message,
    )


async def _bookings_mtd_for_quarter(db: AsyncSession, year: int, quarter: int) -> BookingsMTDResponse:
    """Generic fixed-quarter bookings (used by Q3/Q4 2026). Same logic as _bookings_mtd_q2_2026, parametrized by quarter."""
    m0 = (quarter - 1) * 3 + 1
    months = [m0, m0 + 1, m0 + 2]
    firsts = [date(year, m, 1) for m in months]
    lasts = [date(year, m, calendar.monthrange(year, m)[1]) for m in months]
    qtd_first = firsts[0]
    last_day_quarter = lasts[2]
    idx = [m - 1 for m in months]

    mon_names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    yy = str(year)[2:]
    prev2_label = f"{mon_names[months[0] - 1]} {yy}"
    prev_label = f"{mon_names[months[1] - 1]} {yy}"
    current_label = f"{mon_names[months[2] - 1]} {yy}"
    qtd_label = f"Q{quarter} {yy}"

    plan_by_month: list[tuple[Optional[float], Optional[float]]] = [(None, None)] * 12
    plan_source: Optional[str] = None
    plan_message: Optional[str] = None
    sheet_range = "ARR_Calculations_2026P!A1:ZZ1000"
    r_snap = await db.execute(
        select(SheetSnapshot).where(SheetSnapshot.range_name == sheet_range).order_by(SheetSnapshot.as_of.desc()).limit(1)
    )
    snap = r_snap.scalar_one_or_none()
    if snap and snap.data_json:
        data = json.loads(snap.data_json)
        row_11 = data[10] if len(data) > 10 else []
        row_12 = data[11] if len(data) > 11 else []
        try:
            for m in range(12):
                col_idx = _a1_col_to_index(ARR_2026P_MONTH_COLUMNS[m])
                v11 = row_11[col_idx] if col_idx < len(row_11) else None
                v12 = row_12[col_idx] if col_idx < len(row_12) else None
                plan_by_month[m] = (_to_float_sheet(v11), _to_float_sheet(v12))
            plan_source = "ARR_Calculations_2026P"
        except (TypeError, ValueError, IndexError):
            plan_message = "Could not read plan from sheet."
    else:
        plan_message = "No sheet snapshot. Sync ARR_Calculations_2026P first."

    prev2_total, prev2_nb, prev2_exp = await _closed_won_arr_in_range(db, firsts[0], lasts[0])
    prev_total, prev_nb, prev_exp = await _closed_won_arr_in_range(db, firsts[1], lasts[1])
    mtd_total, mtd_nb, mtd_exp = await _closed_won_arr_in_range(db, firsts[2], lasts[2])
    qtd_total, qtd_nb, qtd_exp = await _closed_won_arr_in_range(db, qtd_first, last_day_quarter)
    prev2_renewal_exp = await _closed_won_renewal_expansion_arr_in_range(db, firsts[0], lasts[0])
    prev_renewal_exp = await _closed_won_renewal_expansion_arr_in_range(db, firsts[1], lasts[1])
    mtd_renewal_exp = await _closed_won_renewal_expansion_arr_in_range(db, firsts[2], lasts[2])
    qtd_renewal_exp = await _closed_won_renewal_expansion_arr_in_range(db, qtd_first, last_day_quarter)
    prev2_exp_mid_term, prev2_exp_upon_renewal = prev2_exp, prev2_renewal_exp
    prev_exp_mid_term, prev_exp_upon_renewal = prev_exp, prev_renewal_exp
    mtd_exp_mid_term, mtd_exp_upon_renewal = mtd_exp, mtd_renewal_exp
    qtd_exp_mid_term, qtd_exp_upon_renewal = qtd_exp, qtd_renewal_exp
    prev2_exp_combined = prev2_exp + prev2_renewal_exp
    prev_exp_combined = prev_exp + prev_renewal_exp
    mtd_exp_combined = mtd_exp + mtd_renewal_exp
    qtd_exp_combined = qtd_exp + qtd_renewal_exp
    prev2_total += prev2_renewal_exp
    prev_total += prev_renewal_exp
    mtd_total += mtd_renewal_exp
    qtd_total += qtd_renewal_exp

    p2_nb, p2_exp = plan_by_month[idx[0]]
    p2_tot = (p2_nb or 0) + (p2_exp or 0) if (p2_nb is not None or p2_exp is not None) else None
    p_nb, p_exp = plan_by_month[idx[1]]
    p_tot = (p_nb or 0) + (p_exp or 0) if (p_nb is not None or p_exp is not None) else None
    c_nb, c_exp = plan_by_month[idx[2]]
    c_tot = (c_nb or 0) + (c_exp or 0) if (c_nb is not None or c_exp is not None) else None
    q_nb = sum(plan_by_month[i][0] or 0 for i in range(idx[0], idx[2] + 1))
    q_exp = sum(plan_by_month[i][1] or 0 for i in range(idx[0], idx[2] + 1))
    q_tot = q_nb + q_exp

    first_of_month = firsts[2]
    last_day_month = lasts[2]
    pipeline_mtd_nb, pipeline_mtd_exp = await _open_pipeline_arr_by_record_type_in_range(db, first_of_month, last_day_month)
    pipeline_mtd_tot = pipeline_mtd_nb + pipeline_mtd_exp
    pipeline_qtd_nb, pipeline_qtd_exp = await _open_pipeline_arr_by_record_type_in_range(db, qtd_first, last_day_quarter)
    pipeline_qtd_tot = pipeline_qtd_nb + pipeline_qtd_exp

    def _plan_dollars(plan_val: Optional[float], actual: float) -> float:
        if plan_val is None:
            return 0.0
        if actual > 0 and 0 < plan_val < actual / 100:
            return plan_val * 1000.0
        if actual == 0 and 0 < plan_val < 10000:
            return plan_val * 1000.0
        return plan_val

    c_tot_d = _plan_dollars(c_tot, mtd_total)
    c_nb_d = _plan_dollars(c_nb, mtd_nb)
    c_exp_d = _plan_dollars(c_exp, mtd_exp_combined)
    q_tot_d = _plan_dollars(q_tot, qtd_total)
    q_nb_d = _plan_dollars(q_nb, qtd_nb)
    q_exp_d = _plan_dollars(q_exp, qtd_exp_combined)
    shortfall_mtd_tot = max(0, c_tot_d - mtd_total)
    shortfall_mtd_nb = max(0, c_nb_d - mtd_nb)
    shortfall_mtd_exp = max(0, c_exp_d - mtd_exp_combined)
    shortfall_qtd_tot = max(0, q_tot_d - qtd_total)
    shortfall_qtd_nb = max(0, q_nb_d - qtd_nb)
    shortfall_qtd_exp = max(0, q_exp_d - qtd_exp_combined)
    pipe_cov_mtd_tot = round(pipeline_mtd_tot / shortfall_mtd_tot, 2) if shortfall_mtd_tot > 0 else None
    pipe_cov_mtd_nb = round(pipeline_mtd_nb / shortfall_mtd_nb, 2) if shortfall_mtd_nb > 0 else None
    pipe_cov_mtd_exp = round(pipeline_mtd_exp / shortfall_mtd_exp, 2) if shortfall_mtd_exp > 0 else None
    pipe_cov_qtd_tot = round(pipeline_qtd_tot / shortfall_qtd_tot, 2) if shortfall_qtd_tot > 0 else None
    pipe_cov_qtd_nb = round(pipeline_qtd_nb / shortfall_qtd_nb, 2) if shortfall_qtd_nb > 0 else None
    pipe_cov_qtd_exp = round(pipeline_qtd_exp / shortfall_qtd_exp, 2) if shortfall_qtd_exp > 0 else None

    return BookingsMTDResponse(
        two_months_ago=BookingsPeriod(
            period_label=prev2_label,
            total=_bookings_row(prev2_total, p2_tot),
            new_business=_bookings_row(prev2_nb, p2_nb),
            expansion=_bookings_row(prev2_exp_combined, p2_exp),
            expansion_mid_term=prev2_exp_mid_term,
            expansion_upon_renewal=prev2_exp_upon_renewal,
            pipe_coverage_total=None,
            pipe_coverage_new_business=None,
            pipe_coverage_expansion=None,
        ),
        previous_month=BookingsPeriod(
            period_label=prev_label,
            total=_bookings_row(prev_total, p_tot),
            new_business=_bookings_row(prev_nb, p_nb),
            expansion=_bookings_row(prev_exp_combined, p_exp),
            expansion_mid_term=prev_exp_mid_term,
            expansion_upon_renewal=prev_exp_upon_renewal,
            pipe_coverage_total=None,
            pipe_coverage_new_business=None,
            pipe_coverage_expansion=None,
        ),
        current_mtd=BookingsPeriod(
            period_label=current_label,
            total=_bookings_row(mtd_total, c_tot),
            new_business=_bookings_row(mtd_nb, c_nb),
            expansion=_bookings_row(mtd_exp_combined, c_exp),
            expansion_mid_term=mtd_exp_mid_term,
            expansion_upon_renewal=mtd_exp_upon_renewal,
            pipe_coverage_total=pipe_cov_mtd_tot,
            pipe_coverage_new_business=pipe_cov_mtd_nb,
            pipe_coverage_expansion=pipe_cov_mtd_exp,
        ),
        qtd=BookingsPeriod(
            period_label=qtd_label,
            total=_bookings_row(qtd_total, q_tot),
            new_business=_bookings_row(qtd_nb, q_nb),
            expansion=_bookings_row(qtd_exp_combined, q_exp),
            expansion_mid_term=qtd_exp_mid_term,
            expansion_upon_renewal=qtd_exp_upon_renewal,
            pipe_coverage_total=pipe_cov_qtd_tot,
            pipe_coverage_new_business=pipe_cov_qtd_nb,
            pipe_coverage_expansion=pipe_cov_qtd_exp,
        ),
        plan_source=plan_source,
        plan_message=plan_message,
    )


async def _get_dashboard_bookings_mtd_impl(db: AsyncSession, *, fixed_periods: Optional[str] = None) -> BookingsMTDResponse:
    if fixed_periods == "q1_2026":
        return await _bookings_mtd_q1_2026(db)
    if fixed_periods == "q2_2026":
        return await _bookings_mtd_q2_2026(db)
    if fixed_periods == "q3_2026":
        return await _bookings_mtd_for_quarter(db, 2026, 3)
    if fixed_periods == "q4_2026":
        return await _bookings_mtd_for_quarter(db, 2026, 4)
    now_est = datetime.now(EST)
    year, month = now_est.year, now_est.month
    today = now_est.date()

    # Previous month date range
    if month == 1:
        prev_first = date(year - 1, 12, 1)
        prev_last = date(year - 1, 12, 31)
        prev_label = datetime(year - 1, 12, 1).strftime("%b %y")
    else:
        prev_first = date(year, month - 1, 1)
        prev_last = date(year, month - 1, 1) + timedelta(days=32)
        prev_last = prev_last.replace(day=1) - timedelta(days=1)
        prev_label = datetime(year, month - 1, 1).strftime("%b %y")

    # Two months ago date range
    prev2_month = month - 2
    prev2_year = year
    while prev2_month <= 0:
        prev2_month += 12
        prev2_year -= 1
    prev2_first = date(prev2_year, prev2_month, 1)
    prev2_last = (prev2_first + timedelta(days=32)).replace(day=1) - timedelta(days=1)
    prev2_label = datetime(prev2_year, prev2_month, 1).strftime("%b %y")

    # Current month MTD
    first_of_month = date(year, month, 1)
    current_mtd_last = min(today, first_of_month + timedelta(days=32))
    current_mtd_last = (current_mtd_last.replace(day=1) - timedelta(days=1)) if current_mtd_last.month != month else current_mtd_last
    current_mtd_last = min(today, current_mtd_last)
    current_label = now_est.strftime("%b %y") + " MTD"

    # Quarter to date: first day of quarter through today
    quarter_month = ((month - 1) // 3) * 3 + 1
    qtd_first = date(year, quarter_month, 1)
    qtd_label = f"Q{(quarter_month - 1) // 3 + 1} {str(year)[2:]} QTD"
    last_day_month = (first_of_month + timedelta(days=32)).replace(day=1) - timedelta(days=1)
    last_day_quarter = (date(year, quarter_month + 3, 1) - timedelta(days=1)) if quarter_month <= 9 else date(year, 12, 31)

    # Load sheet once for plan data
    plan_by_month: list[tuple[Optional[float], Optional[float]]] = [(None, None)] * 12  # (nb, exp) per month 1..12
    plan_source: Optional[str] = None
    plan_message: Optional[str] = None
    sheet_range = "ARR_Calculations_2026P!A1:ZZ1000"
    r_snap = await db.execute(
        select(SheetSnapshot).where(SheetSnapshot.range_name == sheet_range).order_by(SheetSnapshot.as_of.desc()).limit(1)
    )
    snap = r_snap.scalar_one_or_none()
    if snap and snap.data_json:
        data = json.loads(snap.data_json)
        row_11 = data[10] if len(data) > 10 else []
        row_12 = data[11] if len(data) > 11 else []
        try:
            for m in range(12):
                col_idx = _a1_col_to_index(ARR_2026P_MONTH_COLUMNS[m])
                v11 = row_11[col_idx] if col_idx < len(row_11) else None
                v12 = row_12[col_idx] if col_idx < len(row_12) else None
                plan_by_month[m] = (_to_float_sheet(v11), _to_float_sheet(v12))
            plan_source = "ARR_Calculations_2026P"
        except (TypeError, ValueError, IndexError):
            plan_message = "Could not read plan from sheet."
    else:
        plan_message = "No sheet snapshot. Sync ARR_Calculations_2026P first."

    # Actuals: NB + expansion mid-term + upon renewal. Expansion **row** mtd = mid-term + upon renewal (same components as Total − NB).
    prev_total, prev_nb, prev_exp = await _closed_won_arr_in_range(db, prev_first, prev_last)
    prev2_total, prev2_nb, prev2_exp = await _closed_won_arr_in_range(db, prev2_first, prev2_last)
    mtd_total, mtd_nb, mtd_exp = await _closed_won_arr_in_range(db, first_of_month, today)
    qtd_total, qtd_nb, qtd_exp = await _closed_won_arr_in_range(db, qtd_first, today)
    prev_renewal_exp = await _closed_won_renewal_expansion_arr_in_range(db, prev_first, prev_last)
    prev2_renewal_exp = await _closed_won_renewal_expansion_arr_in_range(db, prev2_first, prev2_last)
    mtd_renewal_exp = await _closed_won_renewal_expansion_arr_in_range(db, first_of_month, today)
    qtd_renewal_exp = await _closed_won_renewal_expansion_arr_in_range(db, qtd_first, today)
    prev_exp_mid_term, prev_exp_upon_renewal = prev_exp, prev_renewal_exp
    prev2_exp_mid_term, prev2_exp_upon_renewal = prev2_exp, prev2_renewal_exp
    mtd_exp_mid_term, mtd_exp_upon_renewal = mtd_exp, mtd_renewal_exp
    qtd_exp_mid_term, qtd_exp_upon_renewal = qtd_exp, qtd_renewal_exp
    prev_exp_combined = prev_exp + prev_renewal_exp
    prev2_exp_combined = prev2_exp + prev2_renewal_exp
    mtd_exp_combined = mtd_exp + mtd_renewal_exp
    qtd_exp_combined = qtd_exp + qtd_renewal_exp
    prev_total += prev_renewal_exp
    prev2_total += prev2_renewal_exp
    mtd_total += mtd_renewal_exp
    qtd_total += qtd_renewal_exp

    # Plan for previous month (month index 0-based)
    prev_m = (month - 2 + 12) % 12
    p_nb, p_exp = plan_by_month[prev_m]
    p_tot = (p_nb or 0) + (p_exp or 0) if (p_nb is not None or p_exp is not None) else None

    # Plan for two months ago
    prev2_m = (month - 3 + 12) % 12
    p2_nb, p2_exp = plan_by_month[prev2_m]
    p2_tot = (p2_nb or 0) + (p2_exp or 0) if (p2_nb is not None or p2_exp is not None) else None

    # Plan for current month
    c_nb, c_exp = plan_by_month[month - 1]
    c_tot = (c_nb or 0) + (c_exp or 0) if (c_nb is not None or c_exp is not None) else None

    # Plan for quarter = sum of plans for the three months in the quarter
    q_nb = sum(plan_by_month[i][0] or 0 for i in range(quarter_month - 1, min(quarter_month + 2, 12)))
    q_exp = sum(plan_by_month[i][1] or 0 for i in range(quarter_month - 1, min(quarter_month + 2, 12)))
    q_tot = q_nb + q_exp

    # Pipe coverage = (open pipeline ARR) / (shortfall to plan). MTD = open pipe with close_date in current month; QTD = close_date in current quarter. Same ARR logic as pipeline-overview (MRR when set else line items).
    pipeline_mtd_nb, pipeline_mtd_exp = await _open_pipeline_arr_by_record_type_in_range(db, first_of_month, last_day_month)
    pipeline_mtd_tot = pipeline_mtd_nb + pipeline_mtd_exp
    pipeline_qtd_nb, pipeline_qtd_exp = await _open_pipeline_arr_by_record_type_in_range(db, qtd_first, last_day_quarter)
    pipeline_qtd_tot = pipeline_qtd_nb + pipeline_qtd_exp
    # Shortfall: plan and actuals must be in same unit (dollars). If sheet stores plan in $K, normalize to dollars for shortfall so pipe coverage computes.
    def _plan_dollars(plan_val: Optional[float], actual: float) -> float:
        if plan_val is None:
            return 0.0
        if actual > 0 and 0 < plan_val < actual / 100:
            return plan_val * 1000.0
        if actual == 0 and 0 < plan_val < 10000:
            return plan_val * 1000.0
        return plan_val

    c_tot_d = _plan_dollars(c_tot, mtd_total)
    c_nb_d = _plan_dollars(c_nb, mtd_nb)
    c_exp_d = _plan_dollars(c_exp, mtd_exp_combined)
    q_tot_d = _plan_dollars(q_tot, qtd_total)
    q_nb_d = _plan_dollars(q_nb, qtd_nb)
    q_exp_d = _plan_dollars(q_exp, qtd_exp_combined)
    shortfall_mtd_tot = max(0, c_tot_d - mtd_total)
    shortfall_mtd_nb = max(0, c_nb_d - mtd_nb)
    shortfall_mtd_exp = max(0, c_exp_d - mtd_exp_combined)
    shortfall_qtd_tot = max(0, q_tot_d - qtd_total)
    shortfall_qtd_nb = max(0, q_nb_d - qtd_nb)
    shortfall_qtd_exp = max(0, q_exp_d - qtd_exp_combined)
    pipe_cov_mtd_tot = round(pipeline_mtd_tot / shortfall_mtd_tot, 2) if shortfall_mtd_tot > 0 else None
    pipe_cov_mtd_nb = round(pipeline_mtd_nb / shortfall_mtd_nb, 2) if shortfall_mtd_nb > 0 else None
    pipe_cov_mtd_exp = round(pipeline_mtd_exp / shortfall_mtd_exp, 2) if shortfall_mtd_exp > 0 else None
    pipe_cov_qtd_tot = round(pipeline_qtd_tot / shortfall_qtd_tot, 2) if shortfall_qtd_tot > 0 else None
    pipe_cov_qtd_nb = round(pipeline_qtd_nb / shortfall_qtd_nb, 2) if shortfall_qtd_nb > 0 else None
    pipe_cov_qtd_exp = round(pipeline_qtd_exp / shortfall_qtd_exp, 2) if shortfall_qtd_exp > 0 else None

    return BookingsMTDResponse(
        two_months_ago=BookingsPeriod(
            period_label=prev2_label,
            total=_bookings_row(prev2_total, p2_tot),
            new_business=_bookings_row(prev2_nb, p2_nb),
            expansion=_bookings_row(prev2_exp_combined, p2_exp),
            expansion_mid_term=prev2_exp_mid_term,
            expansion_upon_renewal=prev2_exp_upon_renewal,
            pipe_coverage_total=None,
            pipe_coverage_new_business=None,
            pipe_coverage_expansion=None,
        ),
        previous_month=BookingsPeriod(
            period_label=prev_label,
            total=_bookings_row(prev_total, p_tot),
            new_business=_bookings_row(prev_nb, p_nb),
            expansion=_bookings_row(prev_exp_combined, p_exp),
            expansion_mid_term=prev_exp_mid_term,
            expansion_upon_renewal=prev_exp_upon_renewal,
            pipe_coverage_total=None,
            pipe_coverage_new_business=None,
            pipe_coverage_expansion=None,
        ),
        current_mtd=BookingsPeriod(
            period_label=current_label,
            total=_bookings_row(mtd_total, c_tot),
            new_business=_bookings_row(mtd_nb, c_nb),
            expansion=_bookings_row(mtd_exp_combined, c_exp),
            expansion_mid_term=mtd_exp_mid_term,
            expansion_upon_renewal=mtd_exp_upon_renewal,
            pipe_coverage_total=pipe_cov_mtd_tot,
            pipe_coverage_new_business=pipe_cov_mtd_nb,
            pipe_coverage_expansion=pipe_cov_mtd_exp,
        ),
        qtd=BookingsPeriod(
            period_label=qtd_label,
            total=_bookings_row(qtd_total, q_tot),
            new_business=_bookings_row(qtd_nb, q_nb),
            expansion=_bookings_row(qtd_exp_combined, q_exp),
            expansion_mid_term=qtd_exp_mid_term,
            expansion_upon_renewal=qtd_exp_upon_renewal,
            pipe_coverage_total=pipe_cov_qtd_tot,
            pipe_coverage_new_business=pipe_cov_qtd_nb,
            pipe_coverage_expansion=pipe_cov_qtd_exp,
        ),
        plan_source=plan_source,
        plan_message=plan_message,
    )


@app.get("/api/dashboard/renewals-mtd", response_model=RenewalsMTDResponse)
async def get_dashboard_renewals_mtd(
    db: AsyncSession = Depends(get_db),
    fixed_periods: Optional[str] = Query(None, description="q1_2026 / q2_2026 / q3_2026 / q4_2026 fixed quarter columns (same pattern as Bookings)."),
):
    """
    Renewals vs plan: four periods aligned with Bookings labels. **Current MTD** uses the **full**
    ongoing calendar month; **QTD** uses the **full** calendar quarter (renewal date from quarter start through
    quarter end, not truncated to today). **Up for renewal plan** = actual UFR for that period; other plan rows
    use ARR_Calculations_2026P (BU35/BU52/BU54). On failure returns 200 + JSON.
    """
    try:
        return await _get_dashboard_renewals_mtd_impl(db, fixed_periods=fixed_periods)
    except Exception as e:
        return JSONResponse(
            status_code=200,
            content=_safe_renewals_fallback(f"Error loading renewals: {str(e)[:100]}"),
        )


async def _renewals_mtd_q1_2026(db: AsyncSession) -> RenewalsMTDResponse:
    """Fixed columns: Jan 26, Feb 26, Mar 26, Q1 26 — full months / full Q1 2026."""
    jan_first, jan_last = date(2026, 1, 1), date(2026, 1, 31)
    feb_first, feb_last = date(2026, 2, 1), date(2026, 2, 28)
    mar_first, mar_last = date(2026, 3, 1), date(2026, 3, 31)
    qtd_first = date(2026, 1, 1)
    last_day_quarter = date(2026, 3, 31)
    prev2_label = "Jan 26"
    prev_label = "Feb 26"
    current_label = "Mar 26"
    qtd_label = "Q1 26"
    prev2_first, prev2_last = jan_first, jan_last
    prev_first, prev_last = feb_first, feb_last
    first_of_month = mar_first
    last_of_month = mar_last
    prev2_m = 0
    prev_m = 1
    cur_m = 2
    q_month_indices = [0, 1, 2]
    year = 2026

    overrides = await _get_record_type_overrides(db)

    def _effective_record_type(o: Opportunity) -> str:
        key = (o.sf_id or "").strip()
        override = overrides.get(key) or (overrides.get(key[:15]) if len(key) >= 15 else None)
        return (override or o.record_type_name or "").strip() or "—"

    q = select(Opportunity).where(Opportunity.stage_name.isnot(None))
    r = await db.execute(q)
    all_opps = [o for o in r.scalars().all() if not _is_excluded_from_bookings_nb_only(o, _effective_record_type(o))]
    renewal_opps = [o for o in all_opps if _is_renewal_record_type(_effective_record_type(o))]
    expansion_opps = [o for o in all_opps if _is_expansion_record_type(_effective_record_type(o))]

    def _pf_prev2(rd: date) -> bool:
        return prev2_first <= rd <= prev2_last

    def _pf_prev(rd: date) -> bool:
        return prev_first <= rd <= prev_last

    def _pf_mtd(rd: date) -> bool:
        return first_of_month <= rd <= last_of_month

    def _pf_qtd(rd: date) -> bool:
        return qtd_first <= rd <= last_day_quarter

    a_prev2 = _aggregate_renewals_actuals(renewal_opps, _pf_prev2, expansion_opps)
    a_prev = _aggregate_renewals_actuals(renewal_opps, _pf_prev, expansion_opps)
    a_mtd = _aggregate_renewals_actuals(renewal_opps, _pf_mtd, expansion_opps)
    a_qtd = _aggregate_renewals_actuals(renewal_opps, _pf_qtd, expansion_opps)

    sheet_range = "ARR_Calculations_2026P!A1:ZZ1000"
    r_snap = await db.execute(
        select(SheetSnapshot).where(SheetSnapshot.range_name == sheet_range).order_by(SheetSnapshot.as_of.desc()).limit(1)
    )
    snap = r_snap.scalar_one_or_none()
    plan_source: Optional[str] = None
    plan_message: Optional[str] = None
    data: list = []
    if snap and snap.data_json:
        try:
            data = json.loads(snap.data_json)
            data = _pad_sheet_snapshot_for_renewals_plan(data)
            plan_source = "ARR_Calculations_2026P"
        except (TypeError, ValueError, json.JSONDecodeError):
            plan_message = "Could not read renewals plan from sheet."
    else:
        plan_message = "No sheet snapshot. Sync ARR_Calculations_2026P first."

    def _period(
        label: str,
        tup: tuple,
        month_idx: Optional[int],
        q_indices: Optional[list[int]],
    ) -> RenewalsPeriod:
        ufr, o_open, churn, contr, renewed, rate, canc = tup
        if not data:
            p_ufr = p_ch = p_co = p_re = p_ra = p_ca = None
        elif q_indices is not None:
            by_m = _renewals_qtd_ufr_by_month(renewal_opps, year, qtd_first, last_day_quarter, q_indices)
            p_ufr, p_ch, p_co, p_re, p_ra, p_ca = _renewals_plan_bundle_qtd(
                data,
                q_indices,
                ufr,
                churn,
                contr,
                canc,
                renewed,
                by_m,
            )
        elif month_idx is not None:
            p_ufr, p_ch, p_co, p_re, p_ra, p_ca = _renewals_plan_bundle(
                data,
                month_idx,
                ufr,
                churn,
                contr,
                canc,
                renewed,
            )
        else:
            p_ufr = p_ch = p_co = p_re = p_ra = p_ca = None

        return RenewalsPeriod(
            period_label=label,
            up_for_renewal=_renewals_row_dollars(ufr, p_ufr),
            renewed=_renewals_row_dollars(renewed, p_re),
            open=_renewals_row_open(o_open),
            churn=_renewals_row_dollars(churn, p_ch),
            contraction=_renewals_row_dollars(contr, p_co),
            renewal_rate=_renewals_row_rate_optional(rate, p_ra),
            cancelled=_renewals_row_dollars(canc, p_ca),
        )

    return RenewalsMTDResponse(
        two_months_ago=_period(prev2_label, a_prev2, prev2_m, None),
        previous_month=_period(prev_label, a_prev, prev_m, None),
        current_mtd=_period(current_label, a_mtd, cur_m, None),
        qtd=_period(qtd_label, a_qtd, None, q_month_indices),
        plan_source=plan_source,
        plan_message=plan_message,
    )


async def _renewals_mtd_q2_2026(db: AsyncSession) -> RenewalsMTDResponse:
    """Fixed columns: Apr 26, May 26, Jun 26, Q2 26 — full months; Q2 = calendar Q2 2026 (Apr+May+Jun)."""
    apr_first, apr_last = date(2026, 4, 1), date(2026, 4, 30)
    may_first, may_last = date(2026, 5, 1), date(2026, 5, 31)
    jun_first, jun_last = date(2026, 6, 1), date(2026, 6, 30)
    qtd_first = date(2026, 4, 1)
    last_day_quarter = date(2026, 6, 30)
    prev2_label = "Apr 26"
    prev_label = "May 26"
    current_label = "Jun 26"
    qtd_label = "Q2 26"
    prev2_first, prev2_last = apr_first, apr_last
    prev_first, prev_last = may_first, may_last
    first_of_month = jun_first
    last_of_month = jun_last
    prev2_m = 3
    prev_m = 4
    cur_m = 5
    q_month_indices = [3, 4, 5]
    year = 2026

    overrides = await _get_record_type_overrides(db)

    def _effective_record_type(o: Opportunity) -> str:
        key = (o.sf_id or "").strip()
        override = overrides.get(key) or (overrides.get(key[:15]) if len(key) >= 15 else None)
        return (override or o.record_type_name or "").strip() or "—"

    q = select(Opportunity).where(Opportunity.stage_name.isnot(None))
    r = await db.execute(q)
    all_opps = [o for o in r.scalars().all() if not _is_excluded_from_bookings_nb_only(o, _effective_record_type(o))]
    renewal_opps = [o for o in all_opps if _is_renewal_record_type(_effective_record_type(o))]
    expansion_opps = [o for o in all_opps if _is_expansion_record_type(_effective_record_type(o))]

    def _pf_prev2(rd: date) -> bool:
        return prev2_first <= rd <= prev2_last

    def _pf_prev(rd: date) -> bool:
        return prev_first <= rd <= prev_last

    def _pf_mtd(rd: date) -> bool:
        return first_of_month <= rd <= last_of_month

    def _pf_qtd(rd: date) -> bool:
        return qtd_first <= rd <= last_day_quarter

    a_prev2 = _aggregate_renewals_actuals(renewal_opps, _pf_prev2, expansion_opps)
    a_prev = _aggregate_renewals_actuals(renewal_opps, _pf_prev, expansion_opps)
    a_mtd = _aggregate_renewals_actuals(renewal_opps, _pf_mtd, expansion_opps)
    a_qtd = _aggregate_renewals_actuals(renewal_opps, _pf_qtd, expansion_opps)

    sheet_range = "ARR_Calculations_2026P!A1:ZZ1000"
    r_snap = await db.execute(
        select(SheetSnapshot).where(SheetSnapshot.range_name == sheet_range).order_by(SheetSnapshot.as_of.desc()).limit(1)
    )
    snap = r_snap.scalar_one_or_none()
    plan_source: Optional[str] = None
    plan_message: Optional[str] = None
    data: list = []
    if snap and snap.data_json:
        try:
            data = json.loads(snap.data_json)
            data = _pad_sheet_snapshot_for_renewals_plan(data)
            plan_source = "ARR_Calculations_2026P"
        except (TypeError, ValueError, json.JSONDecodeError):
            plan_message = "Could not read renewals plan from sheet."
    else:
        plan_message = "No sheet snapshot. Sync ARR_Calculations_2026P first."

    def _period(
        label: str,
        tup: tuple,
        month_idx: Optional[int],
        q_indices: Optional[list[int]],
    ) -> RenewalsPeriod:
        ufr, o_open, churn, contr, renewed, rate, canc = tup
        if not data:
            p_ufr = p_ch = p_co = p_re = p_ra = p_ca = None
        elif q_indices is not None:
            by_m = _renewals_qtd_ufr_by_month(renewal_opps, year, qtd_first, last_day_quarter, q_indices)
            p_ufr, p_ch, p_co, p_re, p_ra, p_ca = _renewals_plan_bundle_qtd(
                data,
                q_indices,
                ufr,
                churn,
                contr,
                canc,
                renewed,
                by_m,
            )
        elif month_idx is not None:
            p_ufr, p_ch, p_co, p_re, p_ra, p_ca = _renewals_plan_bundle(
                data,
                month_idx,
                ufr,
                churn,
                contr,
                canc,
                renewed,
            )
        else:
            p_ufr = p_ch = p_co = p_re = p_ra = p_ca = None

        return RenewalsPeriod(
            period_label=label,
            up_for_renewal=_renewals_row_dollars(ufr, p_ufr),
            renewed=_renewals_row_dollars(renewed, p_re),
            open=_renewals_row_open(o_open),
            churn=_renewals_row_dollars(churn, p_ch),
            contraction=_renewals_row_dollars(contr, p_co),
            renewal_rate=_renewals_row_rate_optional(rate, p_ra),
            cancelled=_renewals_row_dollars(canc, p_ca),
        )

    return RenewalsMTDResponse(
        two_months_ago=_period(prev2_label, a_prev2, prev2_m, None),
        previous_month=_period(prev_label, a_prev, prev_m, None),
        current_mtd=_period(current_label, a_mtd, cur_m, None),
        qtd=_period(qtd_label, a_qtd, None, q_month_indices),
        plan_source=plan_source,
        plan_message=plan_message,
    )


async def _renewals_mtd_for_quarter(db: AsyncSession, year: int, quarter: int) -> RenewalsMTDResponse:
    """Generic fixed-quarter renewals (used by Q3/Q4 2026). Same logic as _renewals_mtd_q2_2026, parametrized by quarter."""
    m0 = (quarter - 1) * 3 + 1
    months = [m0, m0 + 1, m0 + 2]
    firsts = [date(year, m, 1) for m in months]
    lasts = [date(year, m, calendar.monthrange(year, m)[1]) for m in months]
    qtd_first = firsts[0]
    last_day_quarter = lasts[2]

    mon_names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    yy = str(year)[2:]
    prev2_label = f"{mon_names[months[0] - 1]} {yy}"
    prev_label = f"{mon_names[months[1] - 1]} {yy}"
    current_label = f"{mon_names[months[2] - 1]} {yy}"
    qtd_label = f"Q{quarter} {yy}"
    prev2_first, prev2_last = firsts[0], lasts[0]
    prev_first, prev_last = firsts[1], lasts[1]
    first_of_month = firsts[2]
    last_of_month = lasts[2]
    prev2_m = months[0] - 1
    prev_m = months[1] - 1
    cur_m = months[2] - 1
    q_month_indices = [months[0] - 1, months[1] - 1, months[2] - 1]

    overrides = await _get_record_type_overrides(db)

    def _effective_record_type(o: Opportunity) -> str:
        key = (o.sf_id or "").strip()
        override = overrides.get(key) or (overrides.get(key[:15]) if len(key) >= 15 else None)
        return (override or o.record_type_name or "").strip() or "—"

    q = select(Opportunity).where(Opportunity.stage_name.isnot(None))
    r = await db.execute(q)
    all_opps = [o for o in r.scalars().all() if not _is_excluded_from_bookings_nb_only(o, _effective_record_type(o))]
    renewal_opps = [o for o in all_opps if _is_renewal_record_type(_effective_record_type(o))]
    expansion_opps = [o for o in all_opps if _is_expansion_record_type(_effective_record_type(o))]

    def _pf_prev2(rd: date) -> bool:
        return prev2_first <= rd <= prev2_last

    def _pf_prev(rd: date) -> bool:
        return prev_first <= rd <= prev_last

    def _pf_mtd(rd: date) -> bool:
        return first_of_month <= rd <= last_of_month

    def _pf_qtd(rd: date) -> bool:
        return qtd_first <= rd <= last_day_quarter

    a_prev2 = _aggregate_renewals_actuals(renewal_opps, _pf_prev2, expansion_opps)
    a_prev = _aggregate_renewals_actuals(renewal_opps, _pf_prev, expansion_opps)
    a_mtd = _aggregate_renewals_actuals(renewal_opps, _pf_mtd, expansion_opps)
    a_qtd = _aggregate_renewals_actuals(renewal_opps, _pf_qtd, expansion_opps)

    sheet_range = "ARR_Calculations_2026P!A1:ZZ1000"
    r_snap = await db.execute(
        select(SheetSnapshot).where(SheetSnapshot.range_name == sheet_range).order_by(SheetSnapshot.as_of.desc()).limit(1)
    )
    snap = r_snap.scalar_one_or_none()
    plan_source: Optional[str] = None
    plan_message: Optional[str] = None
    data: list = []
    if snap and snap.data_json:
        try:
            data = json.loads(snap.data_json)
            data = _pad_sheet_snapshot_for_renewals_plan(data)
            plan_source = "ARR_Calculations_2026P"
        except (TypeError, ValueError, json.JSONDecodeError):
            plan_message = "Could not read renewals plan from sheet."
    else:
        plan_message = "No sheet snapshot. Sync ARR_Calculations_2026P first."

    def _period(
        label: str,
        tup: tuple,
        month_idx: Optional[int],
        q_indices: Optional[list[int]],
    ) -> RenewalsPeriod:
        ufr, o_open, churn, contr, renewed, rate, canc = tup
        if not data:
            p_ufr = p_ch = p_co = p_re = p_ra = p_ca = None
        elif q_indices is not None:
            by_m = _renewals_qtd_ufr_by_month(renewal_opps, year, qtd_first, last_day_quarter, q_indices)
            p_ufr, p_ch, p_co, p_re, p_ra, p_ca = _renewals_plan_bundle_qtd(
                data,
                q_indices,
                ufr,
                churn,
                contr,
                canc,
                renewed,
                by_m,
            )
        elif month_idx is not None:
            p_ufr, p_ch, p_co, p_re, p_ra, p_ca = _renewals_plan_bundle(
                data,
                month_idx,
                ufr,
                churn,
                contr,
                canc,
                renewed,
            )
        else:
            p_ufr = p_ch = p_co = p_re = p_ra = p_ca = None

        return RenewalsPeriod(
            period_label=label,
            up_for_renewal=_renewals_row_dollars(ufr, p_ufr),
            renewed=_renewals_row_dollars(renewed, p_re),
            open=_renewals_row_open(o_open),
            churn=_renewals_row_dollars(churn, p_ch),
            contraction=_renewals_row_dollars(contr, p_co),
            renewal_rate=_renewals_row_rate_optional(rate, p_ra),
            cancelled=_renewals_row_dollars(canc, p_ca),
        )

    return RenewalsMTDResponse(
        two_months_ago=_period(prev2_label, a_prev2, prev2_m, None),
        previous_month=_period(prev_label, a_prev, prev_m, None),
        current_mtd=_period(current_label, a_mtd, cur_m, None),
        qtd=_period(qtd_label, a_qtd, None, q_month_indices),
        plan_source=plan_source,
        plan_message=plan_message,
    )


async def _get_dashboard_renewals_mtd_impl(db: AsyncSession, *, fixed_periods: Optional[str] = None) -> RenewalsMTDResponse:
    if fixed_periods == "q1_2026":
        return await _renewals_mtd_q1_2026(db)
    if fixed_periods == "q2_2026":
        return await _renewals_mtd_q2_2026(db)
    if fixed_periods == "q3_2026":
        return await _renewals_mtd_for_quarter(db, 2026, 3)
    if fixed_periods == "q4_2026":
        return await _renewals_mtd_for_quarter(db, 2026, 4)
    now_est = datetime.now(EST)
    year, month = now_est.year, now_est.month
    today = now_est.date()

    if month == 1:
        prev_first = date(year - 1, 12, 1)
        prev_last = date(year - 1, 12, 31)
        prev_label = datetime(year - 1, 12, 1).strftime("%b %y")
    else:
        prev_first = date(year, month - 1, 1)
        prev_last = date(year, month - 1, 1) + timedelta(days=32)
        prev_last = prev_last.replace(day=1) - timedelta(days=1)
        prev_label = datetime(year, month - 1, 1).strftime("%b %y")

    prev2_month = month - 2
    prev2_year = year
    while prev2_month <= 0:
        prev2_month += 12
        prev2_year -= 1
    prev2_first = date(prev2_year, prev2_month, 1)
    prev2_last = (prev2_first + timedelta(days=32)).replace(day=1) - timedelta(days=1)
    prev2_label = datetime(prev2_year, prev2_month, 1).strftime("%b %y")

    first_of_month = date(year, month, 1)
    last_of_month = (first_of_month + timedelta(days=32)).replace(day=1) - timedelta(days=1)
    current_label = now_est.strftime("%b %y") + " MTD"

    quarter_month = ((month - 1) // 3) * 3 + 1
    qtd_first = date(year, quarter_month, 1)
    last_day_quarter = (date(year, quarter_month + 3, 1) - timedelta(days=1)) if quarter_month <= 9 else date(year, 12, 31)
    qtd_label = f"Q{(quarter_month - 1) // 3 + 1} {str(year)[2:]} QTD"

    prev_m = (month - 2 + 12) % 12
    prev2_m = (month - 3 + 12) % 12
    cur_m = month - 1
    q_month_indices = list(range(quarter_month - 1, min(quarter_month + 2, 12)))

    overrides = await _get_record_type_overrides(db)

    def _effective_record_type(o: Opportunity) -> str:
        key = (o.sf_id or "").strip()
        override = overrides.get(key) or (overrides.get(key[:15]) if len(key) >= 15 else None)
        return (override or o.record_type_name or "").strip() or "—"

    q = select(Opportunity).where(Opportunity.stage_name.isnot(None))
    r = await db.execute(q)
    all_opps = [o for o in r.scalars().all() if not _is_excluded_from_bookings_nb_only(o, _effective_record_type(o))]
    renewal_opps = [o for o in all_opps if _is_renewal_record_type(_effective_record_type(o))]
    expansion_opps = [o for o in all_opps if _is_expansion_record_type(_effective_record_type(o))]

    def _pf_prev2(rd: date) -> bool:
        return prev2_first <= rd <= prev2_last

    def _pf_prev(rd: date) -> bool:
        return prev_first <= rd <= prev_last

    def _pf_mtd(rd: date) -> bool:
        # Renewals: full ongoing calendar month (all opps with renewal in this month), not truncated to today.
        return first_of_month <= rd <= last_of_month

    def _pf_qtd(rd: date) -> bool:
        return qtd_first <= rd <= last_day_quarter

    a_prev2 = _aggregate_renewals_actuals(renewal_opps, _pf_prev2, expansion_opps)
    a_prev = _aggregate_renewals_actuals(renewal_opps, _pf_prev, expansion_opps)
    a_mtd = _aggregate_renewals_actuals(renewal_opps, _pf_mtd, expansion_opps)
    a_qtd = _aggregate_renewals_actuals(renewal_opps, _pf_qtd, expansion_opps)

    sheet_range = "ARR_Calculations_2026P!A1:ZZ1000"
    r_snap = await db.execute(
        select(SheetSnapshot).where(SheetSnapshot.range_name == sheet_range).order_by(SheetSnapshot.as_of.desc()).limit(1)
    )
    snap = r_snap.scalar_one_or_none()
    plan_source: Optional[str] = None
    plan_message: Optional[str] = None
    data: list = []
    if snap and snap.data_json:
        try:
            data = json.loads(snap.data_json)
            data = _pad_sheet_snapshot_for_renewals_plan(data)
            plan_source = "ARR_Calculations_2026P"
        except (TypeError, ValueError, json.JSONDecodeError):
            plan_message = "Could not read renewals plan from sheet."
    else:
        plan_message = "No sheet snapshot. Sync ARR_Calculations_2026P first."

    def _period(
        label: str,
        tup: tuple,
        month_idx: Optional[int],
        q_indices: Optional[list[int]],
    ) -> RenewalsPeriod:
        ufr, o_open, churn, contr, renewed, rate, canc = tup
        if not data:
            p_ufr = p_ch = p_co = p_re = p_ra = p_ca = None
        elif q_indices is not None:
            by_m = _renewals_qtd_ufr_by_month(renewal_opps, year, qtd_first, last_day_quarter, q_indices)
            p_ufr, p_ch, p_co, p_re, p_ra, p_ca = _renewals_plan_bundle_qtd(
                data,
                q_indices,
                ufr,
                churn,
                contr,
                canc,
                renewed,
                by_m,
            )
        elif month_idx is not None:
            p_ufr, p_ch, p_co, p_re, p_ra, p_ca = _renewals_plan_bundle(
                data,
                month_idx,
                ufr,
                churn,
                contr,
                canc,
                renewed,
            )
        else:
            p_ufr = p_ch = p_co = p_re = p_ra = p_ca = None

        return RenewalsPeriod(
            period_label=label,
            up_for_renewal=_renewals_row_dollars(ufr, p_ufr),
            renewed=_renewals_row_dollars(renewed, p_re),
            open=_renewals_row_open(o_open),
            churn=_renewals_row_dollars(churn, p_ch),
            contraction=_renewals_row_dollars(contr, p_co),
            renewal_rate=_renewals_row_rate_optional(rate, p_ra),
            cancelled=_renewals_row_dollars(canc, p_ca),
        )

    return RenewalsMTDResponse(
        two_months_ago=_period(prev2_label, a_prev2, prev2_m, None),
        previous_month=_period(prev_label, a_prev, prev_m, None),
        current_mtd=_period(current_label, a_mtd, cur_m, None),
        qtd=_period(qtd_label, a_qtd, None, q_month_indices),
        plan_source=plan_source,
        plan_message=plan_message,
    )


def _safe_renewals_fallback(plan_message: str) -> dict:
    """Minimal valid renewals JSON for exception handler so frontend never gets 500/non-JSON."""
    now_est = datetime.now(EST)
    y, m = now_est.year, now_est.month
    tm2 = m - 2
    ty2 = y
    while tm2 <= 0:
        tm2 += 12
        ty2 -= 1
    prev2 = datetime(ty2, tm2, 1).strftime("%b %y")
    prev = datetime(y - 1, 12, 1).strftime("%b %y") if m == 1 else datetime(y, m - 1, 1).strftime("%b %y")
    cur = now_est.strftime("%b %y") + " MTD"
    qm = ((m - 1) // 3) * 3 + 1
    qtd = f"Q{(qm - 1) // 3 + 1} {str(y)[2:]} QTD"
    row = {"mtd": 0.0, "plan": None, "achievement_pct": None, "delta_k": None, "is_rate": False}
    row_r = {"mtd": 0.0, "plan": None, "achievement_pct": None, "delta_k": None, "is_rate": True}
    per = lambda label: {
        "period_label": label,
        "up_for_renewal": row.copy(),
        "renewed": row.copy(),
        "open": row.copy(),
        "churn": row.copy(),
        "contraction": row.copy(),
        "renewal_rate": row_r.copy(),
        "cancelled": row.copy(),
    }
    return {
        "two_months_ago": per(prev2),
        "previous_month": per(prev),
        "current_mtd": per(cur),
        "qtd": per(qtd),
        "plan_source": None,
        "plan_message": plan_message,
    }


def _safe_cash_fallback(plan_message: str) -> dict:
    """Minimal valid cash JSON for exception handler so frontend never gets 500/non-JSON."""
    now_est = datetime.now(EST)
    y, m = now_est.year, now_est.month
    tm2 = m - 2
    ty2 = y
    while tm2 <= 0:
        tm2 += 12
        ty2 -= 1
    prev2 = datetime(ty2, tm2, 1).strftime("%b %y")
    prev = datetime(y - 1, 12, 1).strftime("%b %y") if m == 1 else datetime(y, m - 1, 1).strftime("%b %y")
    cur = now_est.strftime("%b %y") + " MTD"
    qm = ((m - 1) // 3) * 3 + 1
    qtd = f"Q{(qm - 1) // 3 + 1} {str(y)[2:]} QTD"
    empty = {"period_label": "", "billings_plan": None, "collections_plan": None, "billings_actual": None, "collections_actual": None, "billings_achievement_pct": None, "billings_delta_k": None, "collections_achievement_pct": None, "collections_delta_k": None}
    return {
        "two_months_ago": {**empty, "period_label": prev2},
        "previous_month": {**empty, "period_label": prev},
        "current_mtd": {**empty, "period_label": cur},
        "qtd": {**empty, "period_label": qtd},
        "plan_source": None,
        "plan_message": plan_message,
        "chargebee_message": None,
    }


def _safe_bookings_fallback(plan_message: str) -> dict:
    """Minimal valid bookings JSON for exception handler so frontend never gets 500/non-JSON."""
    now_est = datetime.now(EST)
    y, m = now_est.year, now_est.month
    tm2 = m - 2
    ty2 = y
    while tm2 <= 0:
        tm2 += 12
        ty2 -= 1
    prev2 = datetime(ty2, tm2, 1).strftime("%b %y")
    prev = datetime(y - 1, 12, 1).strftime("%b %y") if m == 1 else datetime(y, m - 1, 1).strftime("%b %y")
    cur = now_est.strftime("%b %y") + " MTD"
    qm = ((m - 1) // 3) * 3 + 1
    qtd = f"Q{(qm - 1) // 3 + 1} {str(y)[2:]} QTD"
    row = {"mtd": 0.0, "plan": None, "achievement_pct": None, "delta_k": None}
    per = lambda label: {
        "period_label": label,
        "total": row,
        "new_business": row,
        "expansion": row,
        "expansion_mid_term": 0.0,
        "expansion_upon_renewal": 0.0,
        "pipe_coverage_total": None,
        "pipe_coverage_new_business": None,
        "pipe_coverage_expansion": None,
    }
    return {
        "two_months_ago": per(prev2),
        "previous_month": per(prev),
        "current_mtd": per(cur),
        "qtd": per(qtd),
        "plan_source": None,
        "plan_message": plan_message,
    }


# BS_2026P: Billings row 45 (index 44); Collections = sum rows 64,65,66 (indices 63,64,65). Same month columns as ARR (BU..CF = Jan..Dec).
BS_2026P_BILLINGS_ROW = 44
BS_2026P_COLLECTIONS_ROWS = (63, 64, 65)


def _chargebee_cash_fetch_bounds(now_est: datetime) -> tuple[int, int]:
    """Start/end unix timestamps for Chargebee cash fetches. Matches dashboard Cash MTD (prev2 month → now)."""
    if now_est.tzinfo is None:
        now_est = now_est.replace(tzinfo=EST)
    year, month = now_est.year, now_est.month
    prev2_month = month - 2
    prev2_year = year
    while prev2_month <= 0:
        prev2_month += 12
        prev2_year -= 1
    prev2_first = datetime(prev2_year, prev2_month, 1, 0, 0, 0, tzinfo=EST)
    return int(prev2_first.timestamp()), int(now_est.timestamp())


@app.get("/api/dashboard/cash-mtd", response_model=CashMTDResponse)
async def get_dashboard_cash_mtd(
    db: AsyncSession = Depends(get_db),
    fixed_periods: Optional[str] = Query(None, description="q1_2026 / q2_2026 / q3_2026 / q4_2026 fixed quarter columns."),
):
    """
    Cash KPIs: Billings and Collections. Same layout as Bookings: previous month, MTD, QTD.
    Plan from sheet BS_2026P: row 45 = Billings by month (BU..CF = Jan..Dec), rows 64–66 sum = Collections by month.
    Actuals from Chargebee (invoices = billings, payments = collections). Uses SQLite cash_invoices/cash_payments snapshots from Refresh app data when present; otherwise calls the Chargebee API once.
    On any failure returns 200 + JSON with plan_message set so the frontend never sees 500 or non-JSON.
    """
    def _empty_period(label: str) -> CashPeriod:
        return CashPeriod(
            period_label=label,
            billings_plan=None,
            collections_plan=None,
            billings_actual=None,
            collections_actual=None,
            billings_achievement_pct=None,
            billings_delta_k=None,
            collections_achievement_pct=None,
            collections_delta_k=None,
        )

    def _safe_cash_body(plan_message: Optional[str]) -> dict:
        now_est = datetime.now(EST)
        year, month = now_est.year, now_est.month
        prev2_month = month - 2
        prev2_year = year
        while prev2_month <= 0:
            prev2_month += 12
            prev2_year -= 1
        prev2_label = datetime(prev2_year, prev2_month, 1).strftime("%b %y")
        if month == 1:
            prev_label = datetime(year - 1, 12, 1).strftime("%b %y")
        else:
            prev_label = datetime(year, month - 1, 1).strftime("%b %y")
        current_label = now_est.strftime("%b %y") + " MTD"
        quarter_month = ((month - 1) // 3) * 3 + 1
        qtd_label = f"Q{(quarter_month - 1) // 3 + 1} {str(year)[2:]} QTD"
        p2 = _empty_period(prev2_label)
        p = _empty_period(prev_label)
        c = _empty_period(current_label)
        q = _empty_period(qtd_label)
        return {
            "two_months_ago": p2.model_dump(),
            "previous_month": p.model_dump(),
            "current_mtd": c.model_dump(),
            "qtd": q.model_dump(),
            "plan_source": None,
            "plan_message": plan_message,
            "chargebee_message": None,
        }

    try:
        return await _get_dashboard_cash_mtd_impl(db, fixed_periods=fixed_periods)
    except Exception as e:
        err_msg = str(e)[:120]
        try:
            body = _safe_cash_body(f"Error loading cash data: {err_msg}")
            return JSONResponse(status_code=200, content=body)
        except Exception:
            # Fallback: minimal dict so frontend always gets valid JSON
            now_est = datetime.now(EST)
            y, m = now_est.year, now_est.month
            tm2 = m - 2
            ty2 = y
            while tm2 <= 0:
                tm2 += 12
                ty2 -= 1
            prev2 = datetime(ty2, tm2, 1).strftime("%b %y")
            prev = datetime(y - 1, 12, 1).strftime("%b %y") if m == 1 else datetime(y, m - 1, 1).strftime("%b %y")
            cur = now_est.strftime("%b %y") + " MTD"
            qm = ((m - 1) // 3) * 3 + 1
            qtd = f"Q{(qm - 1) // 3 + 1} {str(y)[2:]} QTD"
            empty = {"period_label": "", "billings_plan": None, "collections_plan": None, "billings_actual": None, "collections_actual": None, "billings_achievement_pct": None, "billings_delta_k": None, "collections_achievement_pct": None, "collections_delta_k": None}
            return JSONResponse(status_code=200, content={
                "two_months_ago": {**empty, "period_label": prev2},
                "previous_month": {**empty, "period_label": prev},
                "current_mtd": {**empty, "period_label": cur},
                "qtd": {**empty, "period_label": qtd},
                "plan_source": None,
                "plan_message": "Error loading cash data.",
                "chargebee_message": None,
            })


async def _load_latest_chargebee_cash_from_cache(db: AsyncSession) -> Optional[tuple[list, list, Optional[datetime]]]:
    """Latest cash_invoices + cash_payments snapshots from Refresh app data. Returns (invoices, payments, as_of)."""
    r1 = await db.execute(
        select(ChargebeeSnapshot)
        .where(ChargebeeSnapshot.report_type == "cash_invoices")
        .order_by(ChargebeeSnapshot.as_of.desc())
        .limit(1)
    )
    r2 = await db.execute(
        select(ChargebeeSnapshot)
        .where(ChargebeeSnapshot.report_type == "cash_payments")
        .order_by(ChargebeeSnapshot.as_of.desc())
        .limit(1)
    )
    ci = r1.scalar_one_or_none()
    cp = r2.scalar_one_or_none()
    if not ci or not cp or not ci.data_json or not cp.data_json:
        return None
    try:
        jd_i = json.loads(ci.data_json)
        jd_p = json.loads(cp.data_json)
        invoices = jd_i.get("invoices") or []
        payments = jd_p.get("payments") or []
    except (json.JSONDecodeError, TypeError):
        return None
    return (invoices, payments, ci.as_of)


async def _cash_mtd_q1_2026(db: AsyncSession) -> CashMTDResponse:
    """Fixed columns: Jan 26, Feb 26, Mar 26, Q1 26 — full months / full Q1 2026; Chargebee QTD through Mar 31."""
    prev2_label = "Jan 26"
    prev_label = "Feb 26"
    current_label = "Mar 26"
    qtd_label = "Q1 26"
    quarter_month = 1

    sheet_range = "BS_2026P!A1:ZZ1000"
    plan_source: Optional[str] = None
    plan_message: Optional[str] = None
    billings_by_month: list[Optional[float]] = [None] * 12
    collections_by_month: list[Optional[float]] = [None] * 12

    r_snap = await db.execute(
        select(SheetSnapshot).where(SheetSnapshot.range_name == sheet_range).order_by(SheetSnapshot.as_of.desc()).limit(1)
    )
    snap = r_snap.scalar_one_or_none()
    if snap and snap.data_json:
        data = json.loads(snap.data_json)
        try:
            row_billings = data[BS_2026P_BILLINGS_ROW] if len(data) > BS_2026P_BILLINGS_ROW else []
            for m in range(12):
                col_idx = _a1_col_to_index(ARR_2026P_MONTH_COLUMNS[m])
                v = row_billings[col_idx] if col_idx < len(row_billings) else None
                billings_by_month[m] = _to_float_sheet(v)
            for m in range(12):
                col_idx = _a1_col_to_index(ARR_2026P_MONTH_COLUMNS[m])
                coll = 0.0
                for ri in BS_2026P_COLLECTIONS_ROWS:
                    if len(data) > ri:
                        row = data[ri]
                        if col_idx < len(row):
                            v = _to_float_sheet(row[col_idx])
                            if v is not None:
                                coll += v
                collections_by_month[m] = coll if coll else None
            plan_source = "BS_2026P"
        except (TypeError, ValueError, IndexError):
            plan_message = "Could not read Cash plan from sheet."
    else:
        plan_message = "No sheet snapshot. Sync BS_2026P first."

    prev2_m = 0
    prev_m = 1
    c_m = 2
    prev_b = billings_by_month[prev_m]
    prev_c = collections_by_month[prev_m]
    prev2_b = billings_by_month[prev2_m]
    prev2_c = collections_by_month[prev2_m]
    curr_b = billings_by_month[c_m]
    curr_c = collections_by_month[c_m]
    q_b = sum(billings_by_month[i] or 0 for i in range(0, 3))
    q_c = sum(collections_by_month[i] or 0 for i in range(0, 3))

    prev2_first = datetime(2026, 1, 1, 0, 0, 0, tzinfo=EST)
    prev2_last = datetime(2026, 1, 31, 23, 59, 59, tzinfo=EST)
    prev_first = datetime(2026, 2, 1, 0, 0, 0, tzinfo=EST)
    prev_last = datetime(2026, 2, 28, 23, 59, 59, tzinfo=EST)
    curr_first = datetime(2026, 3, 1, 0, 0, 0, tzinfo=EST)
    curr_last = datetime(2026, 3, 31, 23, 59, 59, tzinfo=EST)
    qtd_first_dt = datetime(2026, 1, 1, 0, 0, 0, tzinfo=EST)
    qtd_end_dt = datetime(2026, 3, 31, 23, 59, 59, tzinfo=EST)
    prev_start_ts = int(prev_first.timestamp())
    prev_end_ts = int(prev_last.timestamp())
    prev2_start_ts = int(prev2_first.timestamp())
    prev2_end_ts = int(prev2_last.timestamp())
    curr_start_ts = int(curr_first.timestamp())
    curr_end_ts = int(curr_last.timestamp())
    qtd_start_ts = int(qtd_first_dt.timestamp())
    qtd_end_ts_int = int(qtd_end_dt.timestamp())

    from connectors.chargebee import ChargebeeConnector
    connector = ChargebeeConnector()
    chargebee_message: Optional[str] = None
    prev_billings_act: Optional[float] = None
    prev_coll_act: Optional[float] = None
    prev2_billings_act: Optional[float] = None
    prev2_coll_act: Optional[float] = None
    mtd_billings_act: Optional[float] = None
    mtd_coll_act: Optional[float] = None
    qtd_billings_act: Optional[float] = None
    qtd_coll_act: Optional[float] = None
    if connector.is_configured():
        def _in_range(ts: Optional[int], start: int, end: int) -> bool:
            if ts is None:
                return False
            return start <= ts <= end

        invoices: list[Any] = []
        payments: list[Any] = []
        fetch_end = qtd_end_ts_int + 86400

        # Do not use cash_invoices/cash_payments snapshots: sync uses _chargebee_cash_fetch_bounds
        # (two months ago → now), so e.g. in April the cache starts in February and has no January
        # rows. This view always needs full Jan–Mar; fetch that window from Chargebee directly.
        try:
            invoices = await asyncio.to_thread(
                connector.fetch_invoices_in_date_range,
                prev2_start_ts,
                fetch_end,
            )
        except Exception as e:
            chargebee_message = f"Chargebee: {str(e)[:80]}"
        try:
            payments = await asyncio.to_thread(
                connector.fetch_payments_in_date_range,
                prev2_start_ts,
                fetch_end,
            )
        except Exception as e:
            if not chargebee_message:
                chargebee_message = f"Chargebee payments: {str(e)[:80]}"

        for inv in invoices:
            inv_date = inv.get("date")
            try:
                inv_ts = int(inv_date) if inv_date is not None else None
            except (TypeError, ValueError):
                inv_ts = None
            total = inv.get("total")
            try:
                total_f = float(total) if total is not None else 0.0
            except (TypeError, ValueError):
                total_f = 0.0
            total_f = total_f / 100.0
            if inv_ts is not None:
                if _in_range(inv_ts, prev2_start_ts, prev2_end_ts):
                    prev2_billings_act = (prev2_billings_act or 0) + total_f
                if _in_range(inv_ts, prev_start_ts, prev_end_ts):
                    prev_billings_act = (prev_billings_act or 0) + total_f
                if _in_range(inv_ts, curr_start_ts, curr_end_ts):
                    mtd_billings_act = (mtd_billings_act or 0) + total_f
                if inv_ts >= qtd_start_ts and inv_ts <= qtd_end_ts_int:
                    qtd_billings_act = (qtd_billings_act or 0) + total_f

        for txn in payments:
            txn_date = txn.get("date")
            try:
                txn_ts = int(txn_date) if txn_date is not None else None
            except (TypeError, ValueError):
                txn_ts = None
            amount = txn.get("amount")
            try:
                amount_f = float(amount) if amount is not None else 0.0
            except (TypeError, ValueError):
                amount_f = 0.0
            amount_f = amount_f / 100.0
            if txn_ts is not None and amount_f:
                if _in_range(txn_ts, prev2_start_ts, prev2_end_ts):
                    prev2_coll_act = (prev2_coll_act or 0) + amount_f
                if _in_range(txn_ts, prev_start_ts, prev_end_ts):
                    prev_coll_act = (prev_coll_act or 0) + amount_f
                if _in_range(txn_ts, curr_start_ts, curr_end_ts):
                    mtd_coll_act = (mtd_coll_act or 0) + amount_f
                if txn_ts >= qtd_start_ts and txn_ts <= qtd_end_ts_int:
                    qtd_coll_act = (qtd_coll_act or 0) + amount_f

        if not chargebee_message and not invoices and not payments:
            chargebee_message = "Chargebee: no invoices or payments in date range (check site/timezone)."
    else:
        chargebee_message = "Chargebee not configured (set CHARGEBEE_SITE and CHARGEBEE_API_KEY)."

    def _cash_period(
        label: str,
        plan_b: Optional[float],
        plan_c: Optional[float],
        act_b: Optional[float],
        act_c: Optional[float],
    ) -> CashPeriod:
        ach_b = (act_b / plan_b * 100) if plan_b and plan_b != 0 and act_b is not None else None
        d_b = (act_b - plan_b) / 1000.0 if plan_b is not None and act_b is not None else None
        ach_c = (act_c / plan_c * 100) if plan_c and plan_c != 0 and act_c is not None else None
        d_c = (act_c - plan_c) / 1000.0 if plan_c is not None and act_c is not None else None
        return CashPeriod(
            period_label=label,
            billings_plan=plan_b,
            collections_plan=plan_c,
            billings_actual=act_b,
            collections_actual=act_c,
            billings_achievement_pct=ach_b,
            billings_delta_k=d_b,
            collections_achievement_pct=ach_c,
            collections_delta_k=d_c,
        )

    return CashMTDResponse(
        two_months_ago=_cash_period(prev2_label, prev2_b, prev2_c, prev2_billings_act, prev2_coll_act),
        previous_month=_cash_period(prev_label, prev_b, prev_c, prev_billings_act, prev_coll_act),
        current_mtd=_cash_period(current_label, curr_b, curr_c, mtd_billings_act, mtd_coll_act),
        qtd=_cash_period(qtd_label, q_b if q_b else None, q_c if q_c else None, qtd_billings_act, qtd_coll_act),
        plan_source=plan_source,
        plan_message=plan_message,
        chargebee_message=chargebee_message,
    )


async def _cash_mtd_q2_2026(db: AsyncSession) -> CashMTDResponse:
    """Fixed columns: Apr 26, May 26, Jun 26, Q2 26 — full months; Chargebee QTD through Jun 30."""
    prev2_label = "Apr 26"
    prev_label = "May 26"
    current_label = "Jun 26"
    qtd_label = "Q2 26"

    sheet_range = "BS_2026P!A1:ZZ1000"
    plan_source: Optional[str] = None
    plan_message: Optional[str] = None
    billings_by_month: list[Optional[float]] = [None] * 12
    collections_by_month: list[Optional[float]] = [None] * 12

    r_snap = await db.execute(
        select(SheetSnapshot).where(SheetSnapshot.range_name == sheet_range).order_by(SheetSnapshot.as_of.desc()).limit(1)
    )
    snap = r_snap.scalar_one_or_none()
    if snap and snap.data_json:
        data = json.loads(snap.data_json)
        try:
            row_billings = data[BS_2026P_BILLINGS_ROW] if len(data) > BS_2026P_BILLINGS_ROW else []
            for m in range(12):
                col_idx = _a1_col_to_index(ARR_2026P_MONTH_COLUMNS[m])
                v = row_billings[col_idx] if col_idx < len(row_billings) else None
                billings_by_month[m] = _to_float_sheet(v)
            for m in range(12):
                col_idx = _a1_col_to_index(ARR_2026P_MONTH_COLUMNS[m])
                coll = 0.0
                for ri in BS_2026P_COLLECTIONS_ROWS:
                    if len(data) > ri:
                        row = data[ri]
                        if col_idx < len(row):
                            v = _to_float_sheet(row[col_idx])
                            if v is not None:
                                coll += v
                collections_by_month[m] = coll if coll else None
            plan_source = "BS_2026P"
        except (TypeError, ValueError, IndexError):
            plan_message = "Could not read Cash plan from sheet."
    else:
        plan_message = "No sheet snapshot. Sync BS_2026P first."

    prev2_m = 3
    prev_m = 4
    c_m = 5
    prev_b = billings_by_month[prev_m]
    prev_c = collections_by_month[prev_m]
    prev2_b = billings_by_month[prev2_m]
    prev2_c = collections_by_month[prev2_m]
    curr_b = billings_by_month[c_m]
    curr_c = collections_by_month[c_m]
    q_b = sum(billings_by_month[i] or 0 for i in range(3, 6))
    q_c = sum(collections_by_month[i] or 0 for i in range(3, 6))

    prev2_first = datetime(2026, 4, 1, 0, 0, 0, tzinfo=EST)
    prev2_last = datetime(2026, 4, 30, 23, 59, 59, tzinfo=EST)
    prev_first = datetime(2026, 5, 1, 0, 0, 0, tzinfo=EST)
    prev_last = datetime(2026, 5, 31, 23, 59, 59, tzinfo=EST)
    curr_first = datetime(2026, 6, 1, 0, 0, 0, tzinfo=EST)
    curr_last = datetime(2026, 6, 30, 23, 59, 59, tzinfo=EST)
    qtd_first_dt = datetime(2026, 4, 1, 0, 0, 0, tzinfo=EST)
    qtd_end_dt = datetime(2026, 6, 30, 23, 59, 59, tzinfo=EST)
    prev_start_ts = int(prev_first.timestamp())
    prev_end_ts = int(prev_last.timestamp())
    prev2_start_ts = int(prev2_first.timestamp())
    prev2_end_ts = int(prev2_last.timestamp())
    curr_start_ts = int(curr_first.timestamp())
    curr_end_ts = int(curr_last.timestamp())
    qtd_start_ts = int(qtd_first_dt.timestamp())
    qtd_end_ts_int = int(qtd_end_dt.timestamp())

    from connectors.chargebee import ChargebeeConnector
    connector = ChargebeeConnector()
    chargebee_message: Optional[str] = None
    prev_billings_act: Optional[float] = None
    prev_coll_act: Optional[float] = None
    prev2_billings_act: Optional[float] = None
    prev2_coll_act: Optional[float] = None
    mtd_billings_act: Optional[float] = None
    mtd_coll_act: Optional[float] = None
    qtd_billings_act: Optional[float] = None
    qtd_coll_act: Optional[float] = None
    if connector.is_configured():
        def _in_range(ts: Optional[int], start: int, end: int) -> bool:
            if ts is None:
                return False
            return start <= ts <= end

        invoices: list[Any] = []
        payments: list[Any] = []
        fetch_end = qtd_end_ts_int + 86400

        try:
            invoices = await asyncio.to_thread(
                connector.fetch_invoices_in_date_range,
                prev2_start_ts,
                fetch_end,
            )
        except Exception as e:
            chargebee_message = f"Chargebee: {str(e)[:80]}"
        try:
            payments = await asyncio.to_thread(
                connector.fetch_payments_in_date_range,
                prev2_start_ts,
                fetch_end,
            )
        except Exception as e:
            if not chargebee_message:
                chargebee_message = f"Chargebee payments: {str(e)[:80]}"

        for inv in invoices:
            inv_date = inv.get("date")
            try:
                inv_ts = int(inv_date) if inv_date is not None else None
            except (TypeError, ValueError):
                inv_ts = None
            total = inv.get("total")
            try:
                total_f = float(total) if total is not None else 0.0
            except (TypeError, ValueError):
                total_f = 0.0
            total_f = total_f / 100.0
            if inv_ts is not None:
                if _in_range(inv_ts, prev2_start_ts, prev2_end_ts):
                    prev2_billings_act = (prev2_billings_act or 0) + total_f
                if _in_range(inv_ts, prev_start_ts, prev_end_ts):
                    prev_billings_act = (prev_billings_act or 0) + total_f
                if _in_range(inv_ts, curr_start_ts, curr_end_ts):
                    mtd_billings_act = (mtd_billings_act or 0) + total_f
                if inv_ts >= qtd_start_ts and inv_ts <= qtd_end_ts_int:
                    qtd_billings_act = (qtd_billings_act or 0) + total_f

        for txn in payments:
            txn_date = txn.get("date")
            try:
                txn_ts = int(txn_date) if txn_date is not None else None
            except (TypeError, ValueError):
                txn_ts = None
            amount = txn.get("amount")
            try:
                amount_f = float(amount) if amount is not None else 0.0
            except (TypeError, ValueError):
                amount_f = 0.0
            amount_f = amount_f / 100.0
            if txn_ts is not None and amount_f:
                if _in_range(txn_ts, prev2_start_ts, prev2_end_ts):
                    prev2_coll_act = (prev2_coll_act or 0) + amount_f
                if _in_range(txn_ts, prev_start_ts, prev_end_ts):
                    prev_coll_act = (prev_coll_act or 0) + amount_f
                if _in_range(txn_ts, curr_start_ts, curr_end_ts):
                    mtd_coll_act = (mtd_coll_act or 0) + amount_f
                if txn_ts >= qtd_start_ts and txn_ts <= qtd_end_ts_int:
                    qtd_coll_act = (qtd_coll_act or 0) + amount_f

        if not chargebee_message and not invoices and not payments:
            chargebee_message = "Chargebee: no invoices or payments in date range (check site/timezone)."
    else:
        chargebee_message = "Chargebee not configured (set CHARGEBEE_SITE and CHARGEBEE_API_KEY)."

    def _cash_period(
        label: str,
        plan_b: Optional[float],
        plan_c: Optional[float],
        act_b: Optional[float],
        act_c: Optional[float],
    ) -> CashPeriod:
        ach_b = (act_b / plan_b * 100) if plan_b and plan_b != 0 and act_b is not None else None
        d_b = (act_b - plan_b) / 1000.0 if plan_b is not None and act_b is not None else None
        ach_c = (act_c / plan_c * 100) if plan_c and plan_c != 0 and act_c is not None else None
        d_c = (act_c - plan_c) / 1000.0 if plan_c is not None and act_c is not None else None
        return CashPeriod(
            period_label=label,
            billings_plan=plan_b,
            collections_plan=plan_c,
            billings_actual=act_b,
            collections_actual=act_c,
            billings_achievement_pct=ach_b,
            billings_delta_k=d_b,
            collections_achievement_pct=ach_c,
            collections_delta_k=d_c,
        )

    return CashMTDResponse(
        two_months_ago=_cash_period(prev2_label, prev2_b, prev2_c, prev2_billings_act, prev2_coll_act),
        previous_month=_cash_period(prev_label, prev_b, prev_c, prev_billings_act, prev_coll_act),
        current_mtd=_cash_period(current_label, curr_b, curr_c, mtd_billings_act, mtd_coll_act),
        qtd=_cash_period(qtd_label, q_b if q_b else None, q_c if q_c else None, qtd_billings_act, qtd_coll_act),
        plan_source=plan_source,
        plan_message=plan_message,
        chargebee_message=chargebee_message,
    )


async def _cash_mtd_for_quarter(db: AsyncSession, year: int, quarter: int) -> CashMTDResponse:
    """Generic fixed-quarter cash (used by Q3/Q4 2026). Same logic as _cash_mtd_q2_2026, parametrized by quarter."""
    m0 = (quarter - 1) * 3 + 1
    months = [m0, m0 + 1, m0 + 2]
    last_days = [calendar.monthrange(year, m)[1] for m in months]

    mon_names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    yy = str(year)[2:]
    prev2_label = f"{mon_names[months[0] - 1]} {yy}"
    prev_label = f"{mon_names[months[1] - 1]} {yy}"
    current_label = f"{mon_names[months[2] - 1]} {yy}"
    qtd_label = f"Q{quarter} {yy}"

    sheet_range = "BS_2026P!A1:ZZ1000"
    plan_source: Optional[str] = None
    plan_message: Optional[str] = None
    billings_by_month: list[Optional[float]] = [None] * 12
    collections_by_month: list[Optional[float]] = [None] * 12

    r_snap = await db.execute(
        select(SheetSnapshot).where(SheetSnapshot.range_name == sheet_range).order_by(SheetSnapshot.as_of.desc()).limit(1)
    )
    snap = r_snap.scalar_one_or_none()
    if snap and snap.data_json:
        data = json.loads(snap.data_json)
        try:
            row_billings = data[BS_2026P_BILLINGS_ROW] if len(data) > BS_2026P_BILLINGS_ROW else []
            for m in range(12):
                col_idx = _a1_col_to_index(ARR_2026P_MONTH_COLUMNS[m])
                v = row_billings[col_idx] if col_idx < len(row_billings) else None
                billings_by_month[m] = _to_float_sheet(v)
            for m in range(12):
                col_idx = _a1_col_to_index(ARR_2026P_MONTH_COLUMNS[m])
                coll = 0.0
                for ri in BS_2026P_COLLECTIONS_ROWS:
                    if len(data) > ri:
                        row = data[ri]
                        if col_idx < len(row):
                            v = _to_float_sheet(row[col_idx])
                            if v is not None:
                                coll += v
                collections_by_month[m] = coll if coll else None
            plan_source = "BS_2026P"
        except (TypeError, ValueError, IndexError):
            plan_message = "Could not read Cash plan from sheet."
    else:
        plan_message = "No sheet snapshot. Sync BS_2026P first."

    prev2_m = months[0] - 1
    prev_m = months[1] - 1
    c_m = months[2] - 1
    prev_b = billings_by_month[prev_m]
    prev_c = collections_by_month[prev_m]
    prev2_b = billings_by_month[prev2_m]
    prev2_c = collections_by_month[prev2_m]
    curr_b = billings_by_month[c_m]
    curr_c = collections_by_month[c_m]
    q_b = sum(billings_by_month[i] or 0 for i in range(prev2_m, c_m + 1))
    q_c = sum(collections_by_month[i] or 0 for i in range(prev2_m, c_m + 1))

    prev2_first = datetime(year, months[0], 1, 0, 0, 0, tzinfo=EST)
    prev2_last = datetime(year, months[0], last_days[0], 23, 59, 59, tzinfo=EST)
    prev_first = datetime(year, months[1], 1, 0, 0, 0, tzinfo=EST)
    prev_last = datetime(year, months[1], last_days[1], 23, 59, 59, tzinfo=EST)
    curr_first = datetime(year, months[2], 1, 0, 0, 0, tzinfo=EST)
    curr_last = datetime(year, months[2], last_days[2], 23, 59, 59, tzinfo=EST)
    qtd_first_dt = datetime(year, months[0], 1, 0, 0, 0, tzinfo=EST)
    qtd_end_dt = datetime(year, months[2], last_days[2], 23, 59, 59, tzinfo=EST)
    prev_start_ts = int(prev_first.timestamp())
    prev_end_ts = int(prev_last.timestamp())
    prev2_start_ts = int(prev2_first.timestamp())
    prev2_end_ts = int(prev2_last.timestamp())
    curr_start_ts = int(curr_first.timestamp())
    curr_end_ts = int(curr_last.timestamp())
    qtd_start_ts = int(qtd_first_dt.timestamp())
    qtd_end_ts_int = int(qtd_end_dt.timestamp())

    from connectors.chargebee import ChargebeeConnector
    connector = ChargebeeConnector()
    chargebee_message: Optional[str] = None
    prev_billings_act: Optional[float] = None
    prev_coll_act: Optional[float] = None
    prev2_billings_act: Optional[float] = None
    prev2_coll_act: Optional[float] = None
    mtd_billings_act: Optional[float] = None
    mtd_coll_act: Optional[float] = None
    qtd_billings_act: Optional[float] = None
    qtd_coll_act: Optional[float] = None
    if connector.is_configured():
        def _in_range(ts: Optional[int], start: int, end: int) -> bool:
            if ts is None:
                return False
            return start <= ts <= end

        invoices: list[Any] = []
        payments: list[Any] = []
        fetch_end = qtd_end_ts_int + 86400

        try:
            invoices = await asyncio.to_thread(
                connector.fetch_invoices_in_date_range,
                prev2_start_ts,
                fetch_end,
            )
        except Exception as e:
            chargebee_message = f"Chargebee: {str(e)[:80]}"
        try:
            payments = await asyncio.to_thread(
                connector.fetch_payments_in_date_range,
                prev2_start_ts,
                fetch_end,
            )
        except Exception as e:
            if not chargebee_message:
                chargebee_message = f"Chargebee payments: {str(e)[:80]}"

        for inv in invoices:
            inv_date = inv.get("date")
            try:
                inv_ts = int(inv_date) if inv_date is not None else None
            except (TypeError, ValueError):
                inv_ts = None
            total = inv.get("total")
            try:
                total_f = float(total) if total is not None else 0.0
            except (TypeError, ValueError):
                total_f = 0.0
            total_f = total_f / 100.0
            if inv_ts is not None:
                if _in_range(inv_ts, prev2_start_ts, prev2_end_ts):
                    prev2_billings_act = (prev2_billings_act or 0) + total_f
                if _in_range(inv_ts, prev_start_ts, prev_end_ts):
                    prev_billings_act = (prev_billings_act or 0) + total_f
                if _in_range(inv_ts, curr_start_ts, curr_end_ts):
                    mtd_billings_act = (mtd_billings_act or 0) + total_f
                if inv_ts >= qtd_start_ts and inv_ts <= qtd_end_ts_int:
                    qtd_billings_act = (qtd_billings_act or 0) + total_f

        for txn in payments:
            txn_date = txn.get("date")
            try:
                txn_ts = int(txn_date) if txn_date is not None else None
            except (TypeError, ValueError):
                txn_ts = None
            amount = txn.get("amount")
            try:
                amount_f = float(amount) if amount is not None else 0.0
            except (TypeError, ValueError):
                amount_f = 0.0
            amount_f = amount_f / 100.0
            if txn_ts is not None and amount_f:
                if _in_range(txn_ts, prev2_start_ts, prev2_end_ts):
                    prev2_coll_act = (prev2_coll_act or 0) + amount_f
                if _in_range(txn_ts, prev_start_ts, prev_end_ts):
                    prev_coll_act = (prev_coll_act or 0) + amount_f
                if _in_range(txn_ts, curr_start_ts, curr_end_ts):
                    mtd_coll_act = (mtd_coll_act or 0) + amount_f
                if txn_ts >= qtd_start_ts and txn_ts <= qtd_end_ts_int:
                    qtd_coll_act = (qtd_coll_act or 0) + amount_f

        if not chargebee_message and not invoices and not payments:
            chargebee_message = "Chargebee: no invoices or payments in date range (check site/timezone)."
    else:
        chargebee_message = "Chargebee not configured (set CHARGEBEE_SITE and CHARGEBEE_API_KEY)."

    def _cash_period(
        label: str,
        plan_b: Optional[float],
        plan_c: Optional[float],
        act_b: Optional[float],
        act_c: Optional[float],
    ) -> CashPeriod:
        ach_b = (act_b / plan_b * 100) if plan_b and plan_b != 0 and act_b is not None else None
        d_b = (act_b - plan_b) / 1000.0 if plan_b is not None and act_b is not None else None
        ach_c = (act_c / plan_c * 100) if plan_c and plan_c != 0 and act_c is not None else None
        d_c = (act_c - plan_c) / 1000.0 if plan_c is not None and act_c is not None else None
        return CashPeriod(
            period_label=label,
            billings_plan=plan_b,
            collections_plan=plan_c,
            billings_actual=act_b,
            collections_actual=act_c,
            billings_achievement_pct=ach_b,
            billings_delta_k=d_b,
            collections_achievement_pct=ach_c,
            collections_delta_k=d_c,
        )

    return CashMTDResponse(
        two_months_ago=_cash_period(prev2_label, prev2_b, prev2_c, prev2_billings_act, prev2_coll_act),
        previous_month=_cash_period(prev_label, prev_b, prev_c, prev_billings_act, prev_coll_act),
        current_mtd=_cash_period(current_label, curr_b, curr_c, mtd_billings_act, mtd_coll_act),
        qtd=_cash_period(qtd_label, q_b if q_b else None, q_c if q_c else None, qtd_billings_act, qtd_coll_act),
        plan_source=plan_source,
        plan_message=plan_message,
        chargebee_message=chargebee_message,
    )


async def _get_dashboard_cash_mtd_impl(db: AsyncSession, *, fixed_periods: Optional[str] = None) -> CashMTDResponse:
    if fixed_periods == "q1_2026":
        return await _cash_mtd_q1_2026(db)
    if fixed_periods == "q2_2026":
        return await _cash_mtd_q2_2026(db)
    if fixed_periods == "q3_2026":
        return await _cash_mtd_for_quarter(db, 2026, 3)
    if fixed_periods == "q4_2026":
        return await _cash_mtd_for_quarter(db, 2026, 4)
    now_est = datetime.now(EST)
    year, month = now_est.year, now_est.month
    if month == 1:
        prev_label = datetime(year - 1, 12, 1).strftime("%b %y")
    else:
        prev_label = datetime(year, month - 1, 1).strftime("%b %y")
    prev2_month = month - 2
    prev2_year = year
    while prev2_month <= 0:
        prev2_month += 12
        prev2_year -= 1
    prev2_label = datetime(prev2_year, prev2_month, 1).strftime("%b %y")
    current_label = now_est.strftime("%b %y") + " MTD"
    quarter_month = ((month - 1) // 3) * 3 + 1
    qtd_label = f"Q{(quarter_month - 1) // 3 + 1} {str(year)[2:]} QTD"

    sheet_range = "BS_2026P!A1:ZZ1000"
    plan_source: Optional[str] = None
    plan_message: Optional[str] = None
    billings_by_month: list[Optional[float]] = [None] * 12
    collections_by_month: list[Optional[float]] = [None] * 12

    r_snap = await db.execute(
        select(SheetSnapshot).where(SheetSnapshot.range_name == sheet_range).order_by(SheetSnapshot.as_of.desc()).limit(1)
    )
    snap = r_snap.scalar_one_or_none()
    if snap and snap.data_json:
        data = json.loads(snap.data_json)
        try:
            row_billings = data[BS_2026P_BILLINGS_ROW] if len(data) > BS_2026P_BILLINGS_ROW else []
            for m in range(12):
                col_idx = _a1_col_to_index(ARR_2026P_MONTH_COLUMNS[m])
                v = row_billings[col_idx] if col_idx < len(row_billings) else None
                billings_by_month[m] = _to_float_sheet(v)
            for m in range(12):
                col_idx = _a1_col_to_index(ARR_2026P_MONTH_COLUMNS[m])
                coll = 0.0
                for ri in BS_2026P_COLLECTIONS_ROWS:
                    if len(data) > ri:
                        row = data[ri]
                        if col_idx < len(row):
                            v = _to_float_sheet(row[col_idx])
                            if v is not None:
                                coll += v
                collections_by_month[m] = coll if coll else None
            plan_source = "BS_2026P"
        except (TypeError, ValueError, IndexError):
            plan_message = "Could not read Cash plan from sheet."
    else:
        plan_message = "No sheet snapshot. Sync BS_2026P first."

    prev_m = (month - 2 + 12) % 12
    prev2_m = (month - 3 + 12) % 12
    c_m = month - 1
    prev_b = billings_by_month[prev_m]
    prev_c = collections_by_month[prev_m]
    prev2_b = billings_by_month[prev2_m]
    prev2_c = collections_by_month[prev2_m]
    curr_b = billings_by_month[c_m]
    curr_c = collections_by_month[c_m]
    q_b = sum(billings_by_month[i] or 0 for i in range(quarter_month - 1, min(quarter_month + 2, 12)))
    q_c = sum(collections_by_month[i] or 0 for i in range(quarter_month - 1, min(quarter_month + 2, 12)))

    # Actuals from Chargebee: billings = invoice total by invoice date; collections = payment transactions by date (matches Total Payments export)
    prev_billings_act: Optional[float] = None
    prev_coll_act: Optional[float] = None
    prev2_billings_act: Optional[float] = None
    prev2_coll_act: Optional[float] = None
    mtd_billings_act: Optional[float] = None
    mtd_coll_act: Optional[float] = None
    qtd_billings_act: Optional[float] = None
    qtd_coll_act: Optional[float] = None
    if month == 1:
        prev_first = datetime(year - 1, 12, 1, 0, 0, 0, tzinfo=EST)
        prev_last = datetime(year - 1, 12, 31, 23, 59, 59, tzinfo=EST)
    else:
        prev_first = datetime(year, month - 1, 1, 0, 0, 0, tzinfo=EST)
        next_month_first = (prev_first + timedelta(days=32)).replace(day=1)
        prev_last = next_month_first - timedelta(seconds=1)
    # Two months ago range for "previous previous month" block
    prev2_first = datetime(prev2_year, prev2_month, 1, 0, 0, 0, tzinfo=EST)
    prev2_next_month_first = (prev2_first + timedelta(days=32)).replace(day=1)
    prev2_last = prev2_next_month_first - timedelta(seconds=1)
    curr_first = datetime(year, month, 1, 0, 0, 0, tzinfo=EST)
    curr_last = now_est
    qtd_first_dt = datetime(year, quarter_month, 1, 0, 0, 0, tzinfo=EST)
    prev_start_ts = int(prev_first.timestamp())
    prev_end_ts = int(prev_last.timestamp())
    prev2_start_ts = int(prev2_first.timestamp())
    prev2_end_ts = int(prev2_last.timestamp())
    curr_start_ts = int(curr_first.timestamp())
    curr_end_ts = int(curr_last.timestamp())
    qtd_start_ts = int(qtd_first_dt.timestamp())

    from connectors.chargebee import ChargebeeConnector
    connector = ChargebeeConnector()
    chargebee_message: Optional[str] = None
    if connector.is_configured():
        def _in_range(ts: Optional[int], start: int, end: int) -> bool:
            if ts is None:
                return False
            return start <= ts <= end

        invoices: list[Any] = []
        payments: list[Any] = []

        cached = await _load_latest_chargebee_cash_from_cache(db)
        if cached is not None:
            invoices, payments, _cash_as_of = cached
        else:
            # Billings: from invoices by invoice date
            try:
                invoices = await asyncio.to_thread(
                    connector.fetch_invoices_in_date_range,
                    prev2_start_ts,
                    curr_end_ts + 86400,
                )
            except Exception as e:
                chargebee_message = f"Chargebee: {str(e)[:80]}"

            # Collections: payment transactions by transaction date
            try:
                payments = await asyncio.to_thread(
                    connector.fetch_payments_in_date_range,
                    prev2_start_ts,
                    curr_end_ts + 86400,
                )
            except Exception as e:
                if not chargebee_message:
                    chargebee_message = f"Chargebee payments: {str(e)[:80]}"
            if not chargebee_message:
                chargebee_message = (
                    "Live Chargebee API (no cash cache). Run Dashboard → Refresh app data to cache billings/collections."
                )

        for inv in invoices:
            inv_date = inv.get("date")
            try:
                inv_ts = int(inv_date) if inv_date is not None else None
            except (TypeError, ValueError):
                inv_ts = None
            total = inv.get("total")
            try:
                total_f = float(total) if total is not None else 0.0
            except (TypeError, ValueError):
                total_f = 0.0
            total_f = total_f / 100.0  # cents to dollars
            if inv_ts is not None:
                if _in_range(inv_ts, prev2_start_ts, prev2_end_ts):
                    prev2_billings_act = (prev2_billings_act or 0) + total_f
                if _in_range(inv_ts, prev_start_ts, prev_end_ts):
                    prev_billings_act = (prev_billings_act or 0) + total_f
                if _in_range(inv_ts, curr_start_ts, curr_end_ts):
                    mtd_billings_act = (mtd_billings_act or 0) + total_f
                if inv_ts >= qtd_start_ts and inv_ts <= curr_end_ts:
                    qtd_billings_act = (qtd_billings_act or 0) + total_f

        # Collections: from payment transactions by transaction date (matches Chargebee Total Payments export)
        for txn in payments:
            txn_date = txn.get("date")
            try:
                txn_ts = int(txn_date) if txn_date is not None else None
            except (TypeError, ValueError):
                txn_ts = None
            amount = txn.get("amount")
            try:
                amount_f = float(amount) if amount is not None else 0.0
            except (TypeError, ValueError):
                amount_f = 0.0
            amount_f = amount_f / 100.0  # cents to dollars
            if txn_ts is not None and amount_f:
                if _in_range(txn_ts, prev2_start_ts, prev2_end_ts):
                    prev2_coll_act = (prev2_coll_act or 0) + amount_f
                if _in_range(txn_ts, prev_start_ts, prev_end_ts):
                    prev_coll_act = (prev_coll_act or 0) + amount_f
                if _in_range(txn_ts, curr_start_ts, curr_end_ts):
                    mtd_coll_act = (mtd_coll_act or 0) + amount_f
                if txn_ts >= qtd_start_ts and txn_ts <= curr_end_ts:
                    qtd_coll_act = (qtd_coll_act or 0) + amount_f

        if not chargebee_message and not invoices and not payments:
            chargebee_message = "Chargebee: no invoices or payments in date range (check site/timezone)."
    else:
        chargebee_message = "Chargebee not configured (set CHARGEBEE_SITE and CHARGEBEE_API_KEY)."

    def _cash_period(
        label: str,
        plan_b: Optional[float],
        plan_c: Optional[float],
        act_b: Optional[float],
        act_c: Optional[float],
    ) -> CashPeriod:
        ach_b = (act_b / plan_b * 100) if plan_b and plan_b != 0 and act_b is not None else None
        d_b = (act_b - plan_b) / 1000.0 if plan_b is not None and act_b is not None else None
        ach_c = (act_c / plan_c * 100) if plan_c and plan_c != 0 and act_c is not None else None
        d_c = (act_c - plan_c) / 1000.0 if plan_c is not None and act_c is not None else None
        return CashPeriod(
            period_label=label,
            billings_plan=plan_b,
            collections_plan=plan_c,
            billings_actual=act_b,
            collections_actual=act_c,
            billings_achievement_pct=ach_b,
            billings_delta_k=d_b,
            collections_achievement_pct=ach_c,
            collections_delta_k=d_c,
        )

    return CashMTDResponse(
        two_months_ago=_cash_period(prev2_label, prev2_b, prev2_c, prev2_billings_act, prev2_coll_act),
        previous_month=_cash_period(prev_label, prev_b, prev_c, prev_billings_act, prev_coll_act),
        current_mtd=_cash_period(current_label, curr_b, curr_c, mtd_billings_act, mtd_coll_act),
        qtd=_cash_period(qtd_label, q_b if q_b else None, q_c if q_c else None, qtd_billings_act, qtd_coll_act),
        plan_source=plan_source,
        plan_message=plan_message,
        chargebee_message=chargebee_message,
    )


@app.get("/api/dashboard-kpi/arr-examples")
async def get_arr_examples(
    limit: int = Query(10, ge=1, le=50, description="Max examples per bucket"),
    db: AsyncSession = Depends(get_db),
):
    """
    ARR breakdown and examples: open renewals vs closed-won renewals.
    Current dashboard ARR = open only. Total contracted ARR often includes closed-won renewals (~$7M).
    """
    # All renewal opportunities
    q_renewals = select(Opportunity).where(
        Opportunity.record_type_name.isnot(None),
    )
    r = await db.execute(q_renewals)
    all_renewals = [o for o in r.scalars().all() if _is_renewal_record_type(o.record_type_name)]
    renewal_sf_ids = {o.sf_id for o in all_renewals}

    # Per-opp line item total (MRR), excluding iVerify Monthly Credits and Kipu API
    opp_to_total = {}
    if renewal_sf_ids:
        q_lines = select(OpportunityLineItem).where(
            OpportunityLineItem.opportunity_sf_id.in_(renewal_sf_ids)
        )
        r_lines = await db.execute(q_lines)
        for li in r_lines.scalars().all():
            raw = _normalized_product_name(li.product_name)
            if not _include_line_item_in_arr(raw, li.product_name):
                continue
            opp_sf_id = li.opportunity_sf_id
            opp_to_total[opp_sf_id] = opp_to_total.get(opp_sf_id, 0) + _line_item_effective_total(li)

    open_mrr = 0.0
    closed_won_mrr = 0.0
    open_examples = []
    closed_won_examples = []

    for o in all_renewals:
        line_total = opp_to_total.get(o.sf_id) or 0  # MRR
        stage = (o.stage_name or "").strip()
        arr_val = line_total * ARR_MULTIPLIER
        if stage in CLOSED_STAGES:
            if stage == "Closed Won":
                closed_won_mrr += line_total
                if len(closed_won_examples) < limit:
                    closed_won_examples.append({
                        "name": o.name,
                        "stage_name": o.stage_name,
                        "line_item_total": round(arr_val, 2),  # ARR
                        "sf_id": o.sf_id,
                    })
        else:
            open_mrr += line_total
            if len(open_examples) < limit:
                open_examples.append({
                    "name": o.name,
                    "stage_name": o.stage_name,
                    "line_item_total": round(arr_val, 2),  # ARR
                    "sf_id": o.sf_id,
                })

    # Sort examples by line_item_total descending
    open_examples.sort(key=lambda x: -x["line_item_total"])
    closed_won_examples.sort(key=lambda x: -x["line_item_total"])

    open_arr = open_mrr * ARR_MULTIPLIER
    closed_won_arr = closed_won_mrr * ARR_MULTIPLIER
    return {
        "open_renewal_arr": round(open_arr, 2),
        "closed_won_renewal_arr": round(closed_won_arr, 2),
        "total_renewal_arr": round(open_arr + closed_won_arr, 2),
        "open_examples": open_examples,
        "closed_won_examples": closed_won_examples,
        "note": "Dashboard ARR currently shows open_renewal_arr only. total_renewal_arr (open + closed won) is often the ~$7M contracted ARR.",
    }


@app.get("/api/dashboard-kpi/arr-by-account")
async def get_arr_by_account(db: AsyncSession = Depends(get_db)):
    """
    List all accounts that have at least one open renewal opportunity, with each account's ARR
    (sum of product line totals for those open renewals). Sorted by ARR descending.
    """
    # Open opportunities (stage not closed)
    q_open = select(Opportunity).where(
        Opportunity.stage_name.isnot(None),
        ~Opportunity.stage_name.in_(CLOSED_STAGES),
    )
    r = await db.execute(q_open)
    open_opps = r.scalars().all()
    renewal_opps = [o for o in open_opps if _is_renewal_record_type(o.record_type_name)]
    renewal_sf_ids = {o.sf_id for o in renewal_opps}

    # Per-opp line item total (MRR), excluding iVerify Monthly Credits and Kipu API
    opp_to_total = {}
    if renewal_sf_ids:
        q_lines = select(OpportunityLineItem).where(
            OpportunityLineItem.opportunity_sf_id.in_(renewal_sf_ids)
        )
        r_lines = await db.execute(q_lines)
        lines_renewal = r_lines.scalars().all()
        for opp_sf_id, _c, arr in _line_items_to_arr_by_group(lines_renewal):
            opp_to_total[opp_sf_id] = opp_to_total.get(opp_sf_id, 0) + arr

    # Group by account: (account_id, account_name) -> { count, arr }
    by_account: dict[tuple[str | None, str | None], tuple[int, float]] = {}
    for o in renewal_opps:
        key = (o.account_id, o.account_name or None)
        line_arr = opp_to_total.get(o.sf_id) or 0  # ARR (period-weighted when term_months present)
        if key not in by_account:
            by_account[key] = (0, 0.0)
        cnt, arr_sum = by_account[key]
        by_account[key] = (cnt + 1, arr_sum + line_arr)

    rows = [
        {"account_id": aid, "account_name": (aname or "—"), "open_renewal_count": cnt, "arr": round(arr_sum, 2)}
        for (aid, aname), (cnt, arr_sum) in by_account.items()
    ]
    rows.sort(key=lambda x: -x["arr"])
    return {"accounts": rows, "total_arr": round(sum(r["arr"] for r in rows), 2)}


async def _get_arr_by_account_product_data(db: AsyncSession) -> dict:
    """Compute ARR by account and product (open renewals for product columns). CARR (grand_total, contracted_arr) = Live ARR + future NB/Exp Closed Won."""
    products = list(PRODUCTS_PURCHASED_COLUMNS) + ["Other"]
    today_est = datetime.now(EST).date()

    schedule_rows, _ = await _compute_active_arr_rows(db, apply_alleva_retained_arr_adjustment=True)
    live_grand = round(sum(float(r.get("active_arr") or 0) for r in schedule_rows), 2)
    future_total, future_by_account = await _future_start_closed_won_nb_exp_arr_by_account(db, today_est)
    carr_grand = round(live_grand + future_total, 2)

    q_open = select(Opportunity).where(
        Opportunity.stage_name.isnot(None),
        ~Opportunity.stage_name.in_(CLOSED_STAGES),
    )
    r = await db.execute(q_open)
    open_opps = r.scalars().all()
    renewal_opps = [o for o in open_opps if _is_renewal_record_type(o.record_type_name)]
    renewal_sf_ids = {o.sf_id for o in renewal_opps}
    opp_to_account = {o.sf_id: (o.account_id, o.account_name or None) for o in renewal_opps}

    if not renewal_sf_ids:
        return {
            "products": products,
            "rows": [],
            "total_by_product": {p: 0.0 for p in products},
            "grand_total": carr_grand,
        }

    q_lines = select(OpportunityLineItem).where(
        OpportunityLineItem.opportunity_sf_id.in_(renewal_sf_ids)
    )
    r_lines = await db.execute(q_lines)
    lines = r_lines.scalars().all()

    by_account_product: dict[tuple[str | None, str | None], dict[str, float]] = {}
    for opp_sf_id, canonical, arr in _line_items_to_products_purchased_by_group(lines):
        acc = opp_to_account.get(opp_sf_id)
        if not acc:
            continue
        if acc not in by_account_product:
            by_account_product[acc] = {p: 0.0 for p in products}
        by_account_product[acc][canonical] = by_account_product[acc].get(canonical, 0) + arr
    # Per-account subscription end date = latest close_date among renewal opps for that account
    account_end_date: dict[tuple[str | None, str | None], date | None] = {}
    for o in renewal_opps:
        key = (o.account_id, o.account_name or None)
        if key not in account_end_date or (o.close_date and (not account_end_date[key] or o.close_date > account_end_date[key])):
            account_end_date[key] = o.close_date

    # Load segment + CSM per account for rows
    account_ids = {aid for (aid, _) in by_account_product.keys() if aid}
    account_meta: dict[str, tuple[str | None, str | None]] = {}
    if account_ids:
        q_acc = select(Account.sf_id, Account.segment, Account.customer_success_manager).where(Account.sf_id.in_(account_ids))
        r_acc = await db.execute(q_acc)
        for (sf_id, seg, csm) in r_acc.all():
            account_meta[sf_id] = (seg, csm)

    # Fail-safe only for Customer overview:
    # if CSM values are still Salesforce User IDs, resolve to User.Name live.
    csm_name_by_id: dict[str, str] = {}
    sf_user_id_re = re.compile(r"^005[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$")
    csm_ids_to_resolve = sorted({
        (csm or "").strip()
        for (_seg, csm) in account_meta.values()
        if (csm or "").strip() and sf_user_id_re.match((csm or "").strip())
    })
    if csm_ids_to_resolve:
        try:
            connector = SalesforceConnector()
            chunk_size = 200
            for i in range(0, len(csm_ids_to_resolve), chunk_size):
                chunk = csm_ids_to_resolve[i:i + chunk_size]
                ids_list = ",".join(f"'{uid}'" for uid in chunk)
                soql_users = f"SELECT Id, Name FROM User WHERE Id IN ({ids_list})"
                user_records = await asyncio.to_thread(connector.query, soql_users)
                for u in user_records:
                    uid = (u.get("Id") or "").strip()
                    uname = (u.get("Name") or "").strip()
                    if uid and uname:
                        csm_name_by_id[uid] = uname
        except Exception:
            # Non-fatal: keep original csm values if live lookup fails.
            pass

    # Resolve opp Account Id / name vs synced Account (renewals may omit Id or use a different opp name string).
    name_lower_to_account_sf_id: dict[str, str] = {}
    sf_id_to_official_name_norm: dict[str, str] = {}
    r_names = await db.execute(select(Account.sf_id, Account.name))
    for acc_sf_id, acc_nm in r_names.all():
        aid_k = _norm_sf_account_id(acc_sf_id)
        nk = _norm_account_name_match(acc_nm)
        if nk:
            if nk not in name_lower_to_account_sf_id:
                name_lower_to_account_sf_id[nk] = acc_sf_id
            if aid_k:
                sf_id_to_official_name_norm[aid_k] = nk
                if len(aid_k) == 18:
                    sf_id_to_official_name_norm[aid_k[:15]] = nk

    total_by_product: dict[str, float] = {p: 0.0 for p in products}
    rows = []
    for (aid, aname), by_product in by_account_product.items():
        by_product_arr = {p: round(by_product.get(p, 0), 2) for p in products}  # already ARR (period-weighted when term_months present)
        for p in products:
            total_by_product[p] = total_by_product.get(p, 0) + by_product_arr.get(p, 0)
        total_arr = round(sum(by_product_arr.values()), 2)
        seg = account_meta.get(aid)[0] if aid and aid in account_meta else None
        seg = (seg or "").strip() or DEFAULT_SEGMENT
        csm = account_meta.get(aid)[1] if aid and aid in account_meta else None
        csm = (csm or "").strip() or "—"
        csm = csm_name_by_id.get(csm, csm)
        end_d = account_end_date.get((aid, aname))
        lookup_aid = aid
        if not _norm_sf_account_id(lookup_aid) and aname:
            nk_acc = _norm_account_name_match(aname)
            if nk_acc and nk_acc in name_lower_to_account_sf_id:
                lookup_aid = name_lower_to_account_sf_id[nk_acc]
        la = _norm_sf_account_id(lookup_aid)
        official_nm = None
        if la:
            official_nm = sf_id_to_official_name_norm.get(la)
            if official_nm is None and len(la) == 18:
                official_nm = sf_id_to_official_name_norm.get(la[:15])
        active_val = round(
            _active_arr_from_schedule_rows(
                schedule_rows,
                lookup_aid,
                aname,
                official_account_name_norm=official_nm,
            ),
            2,
        )
        fut_part = _future_arr_lookup_for_account(future_by_account, lookup_aid or aid, aname)
        rows.append({
            "account_id": aid,
            "account_name": aname or "—",
            "segment": seg,
            "csm": csm,
            "subscription_end_date": end_d.isoformat() if end_d else None,
            "active_arr": active_val,
            "contracted_arr": round(active_val + fut_part, 2),
            "by_product": {p: by_product_arr.get(p, 0) for p in products},
            "total_arr": total_arr,
        })
    rows.sort(key=lambda x: -x["total_arr"])
    total_by_product = {p: round(total_by_product[p], 2) for p in products}
    return {
        "products": products,
        "rows": rows,
        "total_by_product": total_by_product,
        "grand_total": carr_grand,
    }


def _arr_from_snapshot_payload(payload: dict) -> dict:
    """Compute ARR by account/product from EOD snapshot JSON (same shape as _get_arr_by_account_product_data)."""
    opportunities = payload.get("opportunities") or []
    line_items = payload.get("opportunity_line_items") or []
    accounts_list = payload.get("accounts") or []
    open_opps = [o for o in opportunities if (o.get("stage_name") or "") not in CLOSED_STAGES]
    renewal_opps = [o for o in open_opps if (o.get("record_type_name") or "").strip().lower() == "renewal"]
    renewal_sf_ids = {o["sf_id"] for o in renewal_opps}
    opp_to_account = {o["sf_id"]: (o.get("account_id"), o.get("account_name") or None) for o in renewal_opps}

    if not renewal_sf_ids:
        products = list(ARR_PRODUCT_COLUMNS) + ["Other"]
        return {"products": products, "rows": [], "total_by_product": {}, "grand_total": 0.0}

    account_segment = {a["sf_id"]: (a.get("segment") or "").strip() or DEFAULT_SEGMENT for a in accounts_list}
    products = list(ARR_PRODUCT_COLUMNS) + ["Other"]
    by_account_product: dict[tuple[str | None, str | None], dict[str, float]] = {}
    for li in line_items:
        if li.get("opportunity_sf_id") not in renewal_sf_ids:
            continue
        acc = opp_to_account.get(li["opportunity_sf_id"])
        if not acc:
            continue
        raw = _normalized_product_name(li.get("product_name"))
        if not _include_line_item_in_arr(raw, li.get("product_name")):
            continue
        if not raw:
            continue
        if acc not in by_account_product:
            by_account_product[acc] = {p: 0.0 for p in products}
        canonical = _match_arr_product(raw) if raw else None
        canonical = canonical or "Other"
        by_account_product[acc][canonical] = by_account_product[acc].get(canonical, 0) + _line_item_effective_total_dict(li)

    account_end_date: dict[tuple[str | None, str | None], date | None] = {}
    for o in renewal_opps:
        key = (o.get("account_id"), o.get("account_name") or None)
        close_str = o.get("close_date")
        try:
            end_d = datetime.fromisoformat(close_str.replace("Z", "+00:00")).date() if close_str else None
        except (ValueError, TypeError):
            end_d = None
        if key not in account_end_date or (end_d and (not account_end_date[key] or end_d > account_end_date[key])):
            account_end_date[key] = end_d

    total_by_product = {p: 0.0 for p in products}
    rows = []
    grand_total = 0.0
    for (aid, aname), by_product in by_account_product.items():
        by_product_arr = {p: round((mrr * ARR_MULTIPLIER), 2) for p, mrr in by_product.items()}
        for p in products:
            total_by_product[p] = total_by_product.get(p, 0) + by_product_arr.get(p, 0)
        total_arr = round(sum(by_product_arr.values()), 2)
        grand_total += total_arr
        seg = account_segment.get(aid) if aid else DEFAULT_SEGMENT
        end_d = account_end_date.get((aid, aname))
        rows.append({
            "account_id": aid,
            "account_name": aname or "—",
            "segment": seg,
            "subscription_end_date": end_d.isoformat() if end_d else None,
            "by_product": {p: by_product_arr.get(p, 0) for p in products},
            "total_arr": total_arr,
        })
    rows.sort(key=lambda x: -x["total_arr"])
    total_by_product = {p: round(total_by_product[p], 2) for p in products}
    return {
        "products": products,
        "rows": rows,
        "total_by_product": total_by_product,
        "grand_total": round(grand_total, 2),
    }


async def _materialize_arr_schedule_daily(db: AsyncSession, payload: dict, snapshot_date: date) -> None:
    """Write ARR-by-account for this snapshot date to arr_schedule_daily (for ARR bridge, retention, NRR)."""
    data = _arr_from_snapshot_payload(payload)
    await db.execute(delete(ARRScheduleDaily).where(ARRScheduleDaily.snapshot_date == snapshot_date))
    for row in data.get("rows") or []:
        sub_end = None
        if row.get("subscription_end_date"):
            try:
                sub_end = datetime.fromisoformat(row["subscription_end_date"].replace("Z", "+00:00")).date()
            except (ValueError, TypeError):
                pass
        db.add(ARRScheduleDaily(
            snapshot_date=snapshot_date,
            account_id=row.get("account_id"),
            account_name=(row.get("account_name") or "—")[:255],
            segment=(row.get("segment") or "")[:128] or None,
            subscription_end_date=sub_end,
            total_arr=float(row.get("total_arr") or 0),
            by_product_json=json.dumps(row.get("by_product") or {}),
        ))


async def _get_arr_data_for_date(db: AsyncSession, as_of_date: date | None) -> tuple[dict, str]:
    """Get ARR data: live if as_of_date is None, else from latest EOD snapshot on or before that date. Returns (data, source_label)."""
    if as_of_date is None:
        data = await _get_arr_by_account_product_data(db)
        return data, "Customer overview (open renewals)"
    r = await db.execute(
        select(SalesforceEODSnapshot)
        .where(SalesforceEODSnapshot.snapshot_date <= as_of_date)
        .order_by(SalesforceEODSnapshot.snapshot_date.desc())
        .limit(1)
    )
    snap = r.scalar_one_or_none()
    if not snap or not snap.data_json:
        data = await _get_arr_by_account_product_data(db)
        return data, "Customer overview (no snapshot for that date; showing current)"
    payload = json.loads(snap.data_json)
    data = _arr_from_snapshot_payload(payload)
    return data, f"EOD snapshot ({snap.snapshot_date.isoformat()})"


@app.get("/api/arr-by-account-product")
async def get_arr_by_account_product(db: AsyncSession = Depends(get_db)):
    """
    ARR by account with product columns (open renewals only). total_price from SF = MRR; ARR = MRR * 12.
    Returns: products (column order), rows (account_name, by_product, total_arr, active_arr, contracted_arr),
    total_by_product, grand_total.
    **Contracted ARR (CARR) per row** = Live ARR (schedule) + Closed Won New Business/Expansion ARR whose
    service start is **after today** (EST). **grand_total** = sum of Live ARR across all accounts on the schedule
    plus that future closed-won ARR (company total).
    Optional salesforce_base_url when SALESFORCE_BASE_URL is set (for account links).
    """
    data = await _get_arr_by_account_product_data(db)
    base = os.getenv("SALESFORCE_BASE_URL", "").strip().rstrip("/")
    if base and ("salesforce.com" in base or "lightning.force.com" in base):
        data["salesforce_base_url"] = base
    # Avoid stale grids when a CDN/browser caches GET (Products purchased columns come from this payload).
    return JSONResponse(content=data, headers={"Cache-Control": "no-store, must-revalidate"})


@app.post("/api/salesforce/users/by-ids")
async def get_salesforce_users_by_ids(payload: dict):
    """
    Resolve Salesforce User IDs to names (table-level UI fallback).
    Body: { "ids": ["005...", ...] }
    """
    raw_ids = payload.get("ids") if isinstance(payload, dict) else None
    if not isinstance(raw_ids, list):
        return {"ok": False, "error": "ids must be a list", "users": {}}

    sf_user_id_re = re.compile(r"^005[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$")
    ids = sorted({str(i).strip() for i in raw_ids if str(i).strip() and sf_user_id_re.match(str(i).strip())})
    if not ids:
        return {"ok": True, "users": {}}

    try:
        connector = SalesforceConnector()
    except Exception as e:
        return {"ok": False, "error": f"Salesforce connector not available: {e}", "users": {}}

    users: dict[str, str] = {}
    chunk_size = 200
    for i in range(0, len(ids), chunk_size):
        chunk = ids[i:i + chunk_size]
        ids_list = ",".join(f"'{uid}'" for uid in chunk)
        soql = f"SELECT Id, Name FROM User WHERE Id IN ({ids_list})"
        try:
            recs = await asyncio.to_thread(connector.query, soql)
            for rec in recs:
                uid = (rec.get("Id") or "").strip()
                name = (rec.get("Name") or "").strip()
                if uid and name:
                    users[uid] = name
        except Exception:
            continue
    return {"ok": True, "users": users}


@app.post("/api/export/arr-to-google-sheet")
async def export_arr_to_google_sheet(db: AsyncSession = Depends(get_db)):
    """
    Export the ARR-by-account-product table to a new Google Sheet. Creates a new spreadsheet each time
    (owned by the service account, so no sharing required) and returns its URL.
    """
    from connectors.google_sheets import GoogleSheetsConnector

    data = await _get_arr_by_account_product_data(db)
    products = data["products"]
    rows_data = data["rows"]
    total_by_product = data["total_by_product"]
    grand_total = data["grand_total"]

    # Build sheet rows: header (Account, Segment, products..., Contracted ARR), data rows, total row
    header = ["Account", "Segment"] + products + ["Contracted ARR"]
    # CARR total = Live ARR + future Closed Won NB/Exp (global); footer matches API grand_total).
    contracted_sum = round(float(grand_total or 0), 2)
    values = [header]
    for r in rows_data:
        values.append(
            [r["account_name"], (r.get("segment") or "").strip() or DEFAULT_SEGMENT]
            + [r["by_product"].get(p, 0) for p in products]
            + [round(float(r.get("contracted_arr") or r.get("total_arr") or 0), 2)]
        )
    values.append(
        ["Total", ""] + [total_by_product.get(p, 0) for p in products] + [contracted_sum]
    )

    backend_dir = Path(__file__).resolve().parent
    cred_env = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    cred_path = cred_env
    if cred_path and not os.path.isabs(cred_path):
        cred_path = str(backend_dir / cred_path)
    connector = GoogleSheetsConnector(credentials_path=cred_path or cred_env)
    connector.set_base_path(backend_dir)
    if not connector.is_configured():
        return {"ok": False, "error": "Google Sheets not configured. Set GOOGLE_APPLICATION_CREDENTIALS (or GOOGLE_SHEETS_CREDENTIALS_JSON) in .env."}
    export_as_user = (os.getenv("GOOGLE_EXPORT_AS_USER") or "").strip()
    range_a1 = "Sheet1!A1:Z200"
    if export_as_user:
        # Create a new sheet in the user's Drive (domain-wide delegation); uses their quota.
        now_est = datetime.now(EST)
        title = f"Dazos ARR Export {now_est.strftime('%Y-%m-%d %H:%M')} EST"
        try:
            created = await asyncio.to_thread(
                connector.create_spreadsheet_in_user_drive, title, export_as_user
            )
            spreadsheet_id = created["spreadsheet_id"]
            spreadsheet_url = created["spreadsheet_url"]
            delegated_creds = created.get("_delegated_creds")
        except Exception as e:
            err_msg = str(e)
            if "403" in err_msg or "invalid_grant" in err_msg.lower() or "delegation" in err_msg.lower():
                err_msg = (
                    "Domain-wide delegation failed. In Google Workspace Admin: Security → API Controls → "
                    "Domain-wide delegation → Add your service account Client ID with scopes "
                    "https://www.googleapis.com/auth/drive.file and https://www.googleapis.com/auth/spreadsheets. "
                    "Raw: " + err_msg[:250]
                )
            return {"ok": False, "error": err_msg}
        try:
            await asyncio.to_thread(
                connector.update_range,
                range_a1,
                values,
                spreadsheet_id=spreadsheet_id,
                credentials_override=delegated_creds,
            )
        except Exception as e:
            return {"ok": False, "error": "Created sheet but failed to write data: " + str(e)[:200]}
        return {"ok": True, "spreadsheet_url": spreadsheet_url, "rows_written": len(values)}
    # Fallback: write to existing sheet (GOOGLE_SHEET_ID)
    sheet_id = os.getenv("GOOGLE_SHEET_ID")
    range_a1 = os.getenv("GOOGLE_SHEET_ARR_EXPORT_RANGE", "ARR!A1:Z200")
    if not sheet_id:
        return {
            "ok": False,
            "error": "Set GOOGLE_EXPORT_AS_USER=marcel@dazos.com in .env to create a new sheet in your Drive each time (requires domain-wide delegation). Or set GOOGLE_SHEET_ID to write to one existing sheet.",
        }
    try:
        await asyncio.to_thread(connector.update_range, range_a1, values, spreadsheet_id=sheet_id)
    except Exception as e:
        err_msg = str(e)
        if "403" in err_msg or "does not have permission" in err_msg.lower():
            sa_email = connector.get_service_account_email()
            err_msg = (
                "Permission denied. Share your Google Sheet with the service account as **Editor**: "
                + (sa_email or "see client_email in your JSON key")
                + " — then try again. "
                + err_msg[:200]
            )
        elif "404" in err_msg or "Unable to parse range" in err_msg:
            err_msg = f"{err_msg} Use a tab name that exists (e.g. 'ARR' for range ARR!A1:Z200)."
        return {"ok": False, "error": err_msg}
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
    return {"ok": True, "spreadsheet_url": url, "rows_written": len(values)}


COPILOT_ARR_EXPORT_SHEET = "Copilot ARR export"
COPILOT_ARR_EXPORT_RANGE_ENV = "GOOGLE_SHEET_COPILOT_ARR_EXPORT_RANGE"


@app.post("/api/export/copilot-arr-schedule-to-google-sheet")
async def export_copilot_arr_schedule_to_google_sheet(db: AsyncSession = Depends(get_db)):
    """
    Export the same Schedule table shown on the frontend: Account, 18 Digit SFDC Acct ID,
    Status, Segment, Subscription start/end, Active ARR (today), and monthly ARR columns.
    Writes to the "Copilot ARR export" tab in the financial model (GOOGLE_SHEET_ID).
    Layout: header row, then Total row, then one row per account, then Total row again.
    """
    from connectors.google_sheets import GoogleSheetsConnector

    out_rows, months, totals_by_month, _ = await _get_active_arr_by_month_data(db)
    header = (
        ["Account", "18 Digit SFDC Acct ID", "Status", "Segment", "Subscription start", "Subscription end", "Active ARR (today)"]
        + [_short_month_label(m) for m in months]
    )
    values = [header]

    grand_total = sum(r.get("active_arr") or 0 for r in out_rows)
    # Total row (same position as frontend: right after header)
    total_row = (
        ["Total", "", "", "", "", "", _fmt_money_export(grand_total)]
        + [_fmt_money_export(totals_by_month.get(m, 0)) for m in months]
    )
    values.append(total_row)

    for r in out_rows:
        by_month = r.get("by_month") or {}
        values.append(
            [
                r.get("account_name") or "",
                r.get("account_id") or "",
                (r.get("status") or "").strip() or "",
                (r.get("segment") or "").strip() or "",
                r.get("subscription_start_date") or "",
                r.get("subscription_end_date") or "",
                _fmt_money_export(r.get("active_arr") or 0),
            ]
            + [_fmt_money_export(by_month.get(m, 0)) for m in months]
        )

    # Total row again at end (matches frontend tfoot)
    values.append(total_row)

    sheet_id = os.getenv("GOOGLE_SHEET_ID")
    if not sheet_id:
        return {
            "ok": False,
            "error": "GOOGLE_SHEET_ID is not set. Set it in backend/.env to the financial model spreadsheet ID.",
        }
    backend_dir = Path(__file__).resolve().parent
    cred_env = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    cred_path = cred_env
    if cred_path and not os.path.isabs(cred_path):
        cred_path = str(backend_dir / cred_path)
    connector = GoogleSheetsConnector(credentials_path=cred_path or cred_env)
    connector.set_base_path(backend_dir)
    if not connector.is_configured():
        return {"ok": False, "error": "Google Sheets not configured. Set GOOGLE_APPLICATION_CREDENTIALS (or GOOGLE_SHEETS_CREDENTIALS_JSON) in .env."}
    try:
        await asyncio.to_thread(connector.ensure_sheet_exists, COPILOT_ARR_EXPORT_SHEET, spreadsheet_id=sheet_id)
        exact_title = await asyncio.to_thread(connector.get_sheet_exact_title, COPILOT_ARR_EXPORT_SHEET, sheet_id)
        if not exact_title:
            return {"ok": False, "error": f"Tab \"{COPILOT_ARR_EXPORT_SHEET}\" not found after ensure. Check the spreadsheet."}
        # A1 range: quote sheet name (escape single quotes by doubling)
        sheet_ref = "'" + exact_title.replace("'", "''") + "'"
        num_cols = len(header)
        num_rows = len(values)
        end_col = _index_to_a1_col(num_cols - 1)
        range_a1 = os.getenv(COPILOT_ARR_EXPORT_RANGE_ENV) or f"{sheet_ref}!A1:{end_col}{num_rows}"
        await asyncio.to_thread(connector.update_range, range_a1, values, spreadsheet_id=sheet_id)
        # Read back first cells to verify write and return to user
        # Read back a larger slice (first ~400 rows) so we can inspect exported values for debugging.
        # This does not affect what is written, only what the API returns.
        read_back_range = f"{sheet_ref}!A1:G400"
        read_back = await asyncio.to_thread(connector.read_range, read_back_range, sheet_id)
    except Exception as e:
        err_msg = str(e)
        if "403" in err_msg or "does not have permission" in err_msg.lower():
            sa_email = connector.get_service_account_email()
            err_msg = (
                "Permission denied. Share the Google Sheet with the service account as **Editor**: "
                + (sa_email or "see client_email in your JSON key")
                + ". "
                + err_msg[:200]
            )
        elif "404" in err_msg or "Unable to parse range" in err_msg or "not found" in err_msg.lower():
            err_msg = f"Sheet tab not found. Create a tab named \"{COPILOT_ARR_EXPORT_SHEET}\" in your financial model. " + err_msg[:200]
        return {"ok": False, "error": err_msg}
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
    sheet_gid = await asyncio.to_thread(connector.get_sheet_gid_by_title, COPILOT_ARR_EXPORT_SHEET, sheet_id)
    if sheet_gid is not None:
        url = f"{url}#gid={sheet_gid}"
    num_accounts = len(out_rows)
    read_back_empty = not (read_back and any(row for row in read_back if row))
    return {
        "ok": True,
        "spreadsheet_url": url,
        "spreadsheet_id": sheet_id,
        "sheet_gid": sheet_gid,
        "rows_written": len(values),
        "account_count": num_accounts,
        "range_used": range_a1,
        "read_back": read_back,
        "read_back_empty": read_back_empty,
        "message": f"Exported {len(values)} rows (header, Total, {num_accounts} accounts, Total) to \"Copilot ARR export\" tab."
        + (" No account data yet—sync from Salesforce first if you expect data." if num_accounts == 0 else "")
        + (" Verification read was empty — check the tab name and that the sheet is shared with the service account." if read_back_empty else ""),
    }


ARR_BRIDGE_EXPORT_SHEET = "ARR_Bridge export"


def _fmt_pct_export(p) -> str:
    """Percent for spreadsheet export, e.g. 78.2 -> '78.2%'; None -> ''."""
    if p is None:
        return ""
    try:
        return f"{float(p):.1f}%"
    except (TypeError, ValueError):
        return ""


@app.post("/api/export/arr-bridge-to-google-sheet")
async def export_arr_bridge_to_google_sheet(db: AsyncSession = Depends(get_db)):
    """Export the Total ARR bridge and every per-product bridge (CRM, iCampaign, IQ,
    Marketing Reports, RVK Agents) to the "ARR_Bridge export" tab in the financial model
    (GOOGLE_SHEET_ID). Each bridge is one block (title, header, the 6 component rows +
    YoY / NRR / GRR), stacked vertically with a spacer row between blocks."""
    from connectors.google_sheets import GoogleSheetsConnector

    total = await get_arr_bridge(db)
    if not total.get("bridge"):
        return {"ok": False, "error": total.get("message") or "No ARR bridge data. Run 'Refresh app data' first."}
    display_months: list[str] = total["display_months"]

    blocks: list[tuple[str, dict]] = [("Bridge: Total", total)]
    product_result = await _compute_all_product_bridges(db)
    for p in product_result.get("products", []):
        blocks.append((f"Bridge: {p['product_label']}", p))

    month_labels = [_short_month_label(m) for m in display_months]
    header = ["Component"] + month_labels
    num_cols = len(header)
    values: list[list] = []

    def _pad(row: list) -> list:
        return row + [""] * (num_cols - len(row))

    for title, data in blocks:
        bmap = {x["month"]: x for x in (data.get("bridge") or [])}
        ret = {r["month"]: r for r in (data.get("retention") or [])}
        yoy = {y["month"]: y for y in (data.get("yoy") or [])}
        values.append(_pad([title]))
        values.append(header)

        def money_row(label_: str, field: str) -> list:
            return [label_] + [_fmt_money_export(bmap.get(m, {}).get(field) or 0) for m in display_months]

        values.append(money_row("Beginning ARR", "beginning_arr"))
        values.append(money_row("New Business", "new_business"))
        values.append(money_row("Expansion", "expansion"))
        values.append(money_row("Contraction", "contraction"))
        values.append(money_row("Churn", "churn"))
        values.append(money_row("Reclassification", "reclassification"))
        values.append(money_row("Ending ARR", "ending_arr"))
        values.append(["YoY Growth"] + [_fmt_pct_export(yoy.get(m, {}).get("yoy_pct")) for m in display_months])
        values.append(["NRR (T12M)"] + [_fmt_pct_export(ret.get(m, {}).get("nrr_trailing_12m")) for m in display_months])
        values.append(["GRR (T12M)"] + [_fmt_pct_export(ret.get(m, {}).get("grr_trailing_12m")) for m in display_months])
        values.append(_pad([""]))

    sheet_id = os.getenv("GOOGLE_SHEET_ID")
    if not sheet_id:
        return {"ok": False, "error": "GOOGLE_SHEET_ID is not set. Set it in backend/.env to the financial model spreadsheet ID."}
    backend_dir = Path(__file__).resolve().parent
    cred_env = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    cred_path = cred_env
    if cred_path and not os.path.isabs(cred_path):
        cred_path = str(backend_dir / cred_path)
    connector = GoogleSheetsConnector(credentials_path=cred_path or cred_env)
    connector.set_base_path(backend_dir)
    if not connector.is_configured():
        return {"ok": False, "error": "Google Sheets not configured. Set GOOGLE_APPLICATION_CREDENTIALS (or GOOGLE_SHEETS_CREDENTIALS_JSON) in .env."}
    try:
        await asyncio.to_thread(connector.ensure_sheet_exists, ARR_BRIDGE_EXPORT_SHEET, spreadsheet_id=sheet_id)
        exact_title = await asyncio.to_thread(connector.get_sheet_exact_title, ARR_BRIDGE_EXPORT_SHEET, sheet_id)
        if not exact_title:
            return {"ok": False, "error": f"Tab \"{ARR_BRIDGE_EXPORT_SHEET}\" not found after ensure. Check the spreadsheet."}
        sheet_ref = "'" + exact_title.replace("'", "''") + "'"
        # Clear a generous range first so a shorter export doesn't leave stale rows behind.
        end_col = _index_to_a1_col(num_cols - 1)
        await asyncio.to_thread(connector.update_range, f"{sheet_ref}!A1:{end_col}400",
                                [["" for _ in range(num_cols)] for _ in range(400)], spreadsheet_id=sheet_id)
        range_a1 = f"{sheet_ref}!A1:{end_col}{len(values)}"
        await asyncio.to_thread(connector.update_range, range_a1, values, spreadsheet_id=sheet_id)
    except Exception as e:
        err_msg = str(e)
        if "403" in err_msg or "does not have permission" in err_msg.lower():
            sa_email = connector.get_service_account_email()
            err_msg = (
                "Permission denied. Share the Google Sheet with the service account as **Editor**: "
                + (sa_email or "see client_email in your JSON key") + ". " + err_msg[:200]
            )
        elif "404" in err_msg or "Unable to parse range" in err_msg or "not found" in err_msg.lower():
            err_msg = f"Sheet tab not found. Create a tab named \"{ARR_BRIDGE_EXPORT_SHEET}\" in your financial model. " + err_msg[:200]
        return {"ok": False, "error": err_msg}

    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
    sheet_gid = await asyncio.to_thread(connector.get_sheet_gid_by_title, ARR_BRIDGE_EXPORT_SHEET, sheet_id)
    if sheet_gid is not None:
        url = f"{url}#gid={sheet_gid}"
    return {
        "ok": True,
        "spreadsheet_url": url,
        "sheet_gid": sheet_gid,
        "rows_written": len(values),
        "blocks": [t for t, _ in blocks],
        "message": f"Exported {len(blocks)} bridges to \"{ARR_BRIDGE_EXPORT_SHEET}\".",
    }


NEW_SCHEDULE_EXPORT_SHEET = "ARR_Cockpit export"
NEW_SCHEDULE_EXPORT_RANGE_ENV = "GOOGLE_SHEET_NEW_SCHEDULE_EXPORT_RANGE"

COHORT_RETENTION_EXPORT_SHEET = "ARR_Cohort retention export"
COHORT_RETENTION_EXPORT_RANGE_ENV = "GOOGLE_SHEET_COHORT_RETENTION_EXPORT_RANGE"


@app.post("/api/export/new-schedule-to-google-sheet")
async def export_new_schedule_to_google_sheet(db: AsyncSession = Depends(get_db)):
    """
    Export the NEW SCHEDULE table to the "ARR_Cockpit export" tab in the financial model
    (GOOGLE_SHEET_ID). Columns: Account, 18 Digit SFDC Acct ID, Status, Type,
    Subscription start, Subscription end, Live ARR, Contracted ARR, then one column per
    month (Dec '25 … Dec '26). Header row, then Total row, then one row per account.
    """
    from connectors.google_sheets import GoogleSheetsConnector

    # ---- data ----
    result = await get_new_schedule_accounts(db)
    out_rows = result.get("rows", []) if isinstance(result, dict) else []
    month_keys = _new_schedule_month_keys()

    static_headers = [
        "Account",
        "18 Digit SFDC Acct ID",
        "Status",
        "Type",
        "Subscription start",
        "Subscription end",
        "Live ARR",
        "Contracted ARR",
    ]
    header = static_headers + [_short_month_label(m) for m in month_keys]

    grand_live_arr = sum(float(r.get("live_arr") or 0) for r in out_rows)
    grand_contracted_arr = sum(float(r.get("contracted_arr") or 0) for r in out_rows)
    totals_by_month: dict[str, float] = {m: 0.0 for m in month_keys}
    for r in out_rows:
        bm = r.get("arr_by_month") or {}
        for m in month_keys:
            totals_by_month[m] += float(bm.get(m) or 0)

    total_row = (
        ["Total", "", "", "", "", "",
         _fmt_money_export(grand_live_arr),
         _fmt_money_export(grand_contracted_arr)]
        + [_fmt_money_export(totals_by_month.get(m, 0)) for m in month_keys]
    )

    values = [header, total_row]
    for r in out_rows:
        bm = r.get("arr_by_month") or {}
        values.append(
            [
                r.get("account_name") or "",
                r.get("account_id") or "",
                (r.get("status") or "").strip(),
                (r.get("type") or "").strip(),
                r.get("subscription_start_date") or "",
                r.get("subscription_end_date") or "",
                _fmt_money_export(float(r.get("live_arr") or 0)),
                _fmt_money_export(float(r.get("contracted_arr") or 0)),
            ]
            + [_fmt_money_export(float(bm.get(m) or 0)) for m in month_keys]
        )

    # ---- sheet write ----
    sheet_id = os.getenv("GOOGLE_SHEET_ID")
    if not sheet_id:
        return {
            "ok": False,
            "error": "GOOGLE_SHEET_ID is not set. Set it in backend/.env to the financial model spreadsheet ID.",
        }
    backend_dir = Path(__file__).resolve().parent
    cred_env = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    cred_path = cred_env
    if cred_path and not os.path.isabs(cred_path):
        cred_path = str(backend_dir / cred_path)
    connector = GoogleSheetsConnector(credentials_path=cred_path or cred_env)
    connector.set_base_path(backend_dir)
    if not connector.is_configured():
        return {
            "ok": False,
            "error": "Google Sheets not configured. Set GOOGLE_APPLICATION_CREDENTIALS (or GOOGLE_SHEETS_CREDENTIALS_JSON) in .env.",
        }
    try:
        await asyncio.to_thread(connector.ensure_sheet_exists, NEW_SCHEDULE_EXPORT_SHEET, spreadsheet_id=sheet_id)
        exact_title = await asyncio.to_thread(connector.get_sheet_exact_title, NEW_SCHEDULE_EXPORT_SHEET, sheet_id)
        if not exact_title:
            return {"ok": False, "error": f'Tab "{NEW_SCHEDULE_EXPORT_SHEET}" not found after ensure. Check the spreadsheet.'}
        sheet_ref = "'" + exact_title.replace("'", "''") + "'"
        num_cols = len(header)
        num_rows = len(values)
        end_col = _index_to_a1_col(num_cols - 1)
        range_a1 = os.getenv(NEW_SCHEDULE_EXPORT_RANGE_ENV) or f"{sheet_ref}!A1:{end_col}{num_rows}"
        await asyncio.to_thread(connector.update_range, range_a1, values, spreadsheet_id=sheet_id)
    except Exception as e:
        err_msg = str(e)
        if "403" in err_msg or "does not have permission" in err_msg.lower():
            sa_email = connector.get_service_account_email()
            err_msg = (
                f"Permission denied. Share the Google Sheet with the service account as Editor: "
                + (sa_email or "see client_email in your JSON key")
                + ". "
                + err_msg[:200]
            )
        elif "404" in err_msg or "Unable to parse range" in err_msg or "not found" in err_msg.lower():
            err_msg = f'Sheet tab not found. Create a tab named "{NEW_SCHEDULE_EXPORT_SHEET}" in your financial model. ' + err_msg[:200]
        return {"ok": False, "error": err_msg}

    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
    sheet_gid = await asyncio.to_thread(connector.get_sheet_gid_by_title, NEW_SCHEDULE_EXPORT_SHEET, sheet_id)
    if sheet_gid is not None:
        url = f"{url}#gid={sheet_gid}"
    account_count = len(out_rows)
    return {
        "ok": True,
        "spreadsheet_url": url,
        "spreadsheet_id": sheet_id,
        "sheet_gid": sheet_gid,
        "rows_written": len(values),
        "account_count": account_count,
        "range_used": range_a1,
        "message": (
            f'Exported {len(values)} rows (header, Total, {account_count} accounts) to "{NEW_SCHEDULE_EXPORT_SHEET}" tab.'
            + (" No account data yet — sync from Salesforce first." if account_count == 0 else "")
        ),
    }


@app.post("/api/export/cohort-retention-to-google-sheet")
async def export_cohort_retention_to_google_sheet(db: AsyncSession = Depends(get_db)):
    """
    Export the ARR Cohort Retention table to the "ARR_Cohort retention export" tab in the
    financial model (GOOGLE_SHEET_ID).
    Layout: header row (Cohort, Accounts, Start ARR, M0, M1, …), then one row per cohort.
    Percentage values are plain numbers (e.g. 87.5), not "87.5%" strings, so the model can
    use them directly. Start ARR is dollar-formatted (matches other exports).
    """
    from connectors.google_sheets import GoogleSheetsConnector

    # ── rebuild cohort data (same logic as GET /api/arr-cohort-churn) ────────────
    history_data = await _build_arr_history_data(db)
    rows = history_data["rows"]
    all_months: list[str] = history_data["month_columns"]
    month_to_idx: dict[str, int] = {mk: i for i, mk in enumerate(all_months)}
    arr_lookup: dict[str, dict[str, float]] = {r["account_name"]: r["arr_by_month"] for r in rows}

    cohort_accounts: dict[str, list[str]] = {}
    for row in rows:
        name = row["account_name"]
        abm = row["arr_by_month"]
        cohort_month: Optional[str] = None
        for mk in all_months:
            if abm.get(mk, 0.0) > 0:
                cohort_month = mk
                break
        if cohort_month is None:
            continue
        cohort_accounts.setdefault(cohort_month, []).append(name)

    result_cohorts: list[dict] = []
    max_offset = 0
    for _cm in sorted(cohort_accounts.keys()):
        _names = cohort_accounts[_cm]
        _cidx = month_to_idx[_cm]
        _num_periods = len(all_months) - _cidx
        _monthly_arr: list[float] = []
        for _offset in range(_num_periods):
            _tmk = all_months[_cidx + _offset]
            _monthly_arr.append(round(sum(arr_lookup[n].get(_tmk, 0.0) for n in _names), 2))
        _starting_arr = _monthly_arr[0] if _monthly_arr else 0.0
        max_offset = max(max_offset, _num_periods - 1)
        _months_list = []
        for _offset, _arr in enumerate(_monthly_arr):
            _pct = round(_arr / _starting_arr * 100, 1) if _starting_arr > 0 else None
            _months_list.append({"offset": _offset, "arr": _arr, "pct": _pct})
        result_cohorts.append({
            "cohort_month": _cm,
            "starting_arr": round(_starting_arr, 2),
            "account_count": len(_names),
            "months": _months_list,
        })

    # ── build sheet rows ──────────────────────────────────────────────────────────
    header = ["Cohort", "Accounts", "Start ARR"] + [f"M{i}" for i in range(max_offset + 1)]
    values: list[list] = [header]
    for c in result_cohorts:
        pct_by_offset = {m["offset"]: m["pct"] for m in c["months"]}
        values.append(
            [
                _short_month_label(c["cohort_month"]),
                c["account_count"],
                # Dollar, no decimal (e.g. $214,850)
                f"${int(round(float(c['starting_arr'] or 0))):,}",
            ]
            + [
                # Divide by 100 so Sheets % format (0.0%) displays correctly (1.0 → 100.0%)
                (round(pct_by_offset[i] / 100, 5) if pct_by_offset.get(i) is not None else "")
                for i in range(max_offset + 1)
            ]
        )

    # ── write to sheet ────────────────────────────────────────────────────────────
    sheet_id = os.getenv("GOOGLE_SHEET_ID")
    if not sheet_id:
        return {"ok": False, "error": "GOOGLE_SHEET_ID is not set. Set it in backend/.env to the financial model spreadsheet ID."}
    backend_dir = Path(__file__).resolve().parent
    cred_env = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    cred_path = cred_env
    if cred_path and not os.path.isabs(cred_path):
        cred_path = str(backend_dir / cred_path)
    connector = GoogleSheetsConnector(credentials_path=cred_path or cred_env)
    connector.set_base_path(backend_dir)
    if not connector.is_configured():
        return {"ok": False, "error": "Google Sheets not configured. Set GOOGLE_APPLICATION_CREDENTIALS (or GOOGLE_SHEETS_CREDENTIALS_JSON) in .env."}
    try:
        await asyncio.to_thread(connector.ensure_sheet_exists, COHORT_RETENTION_EXPORT_SHEET, spreadsheet_id=sheet_id)
        exact_title = await asyncio.to_thread(connector.get_sheet_exact_title, COHORT_RETENTION_EXPORT_SHEET, sheet_id)
        if not exact_title:
            return {"ok": False, "error": f'Tab "{COHORT_RETENTION_EXPORT_SHEET}" not found after ensure. Check the spreadsheet.'}
        sheet_ref = "'" + exact_title.replace("'", "''") + "'"
        num_cols = len(header)
        num_rows = len(values)
        end_col = _index_to_a1_col(num_cols - 1)
        range_a1 = os.getenv(COHORT_RETENTION_EXPORT_RANGE_ENV) or f"{sheet_ref}!A1:{end_col}{num_rows}"
        await asyncio.to_thread(connector.update_range, range_a1, values, spreadsheet_id=sheet_id)
    except Exception as e:
        err_msg = str(e)
        if "403" in err_msg or "does not have permission" in err_msg.lower():
            sa_email = connector.get_service_account_email()
            err_msg = (
                "Permission denied. Share the Google Sheet with the service account as Editor: "
                + (sa_email or "see client_email in your JSON key")
                + ". "
                + err_msg[:200]
            )
        elif "404" in err_msg or "Unable to parse range" in err_msg or "not found" in err_msg.lower():
            err_msg = f'Sheet tab not found. Create a tab named "{COHORT_RETENTION_EXPORT_SHEET}" in your financial model. ' + err_msg[:200]
        return {"ok": False, "error": err_msg}

    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
    sheet_gid = await asyncio.to_thread(connector.get_sheet_gid_by_title, COHORT_RETENTION_EXPORT_SHEET, sheet_id)
    if sheet_gid is not None:
        url = f"{url}#gid={sheet_gid}"

    # ── apply formatting (mirrors frontend retentionBg / retentionColor) ─────────
    if sheet_gid is not None:
        def _hex_rgb(h: str) -> dict:
            h = h.lstrip("#")
            return {
                "red":   round(int(h[0:2], 16) / 255, 4),
                "green": round(int(h[2:4], 16) / 255, 4),
                "blue":  round(int(h[4:6], 16) / 255, 4),
            }

        def _ret_colors(pct: float) -> tuple[str, str]:
            """(bg_hex, text_hex) matching frontend retentionBg / retentionColor."""
            if pct >= 110: return "#1a4a2a", "#7ee8a0"
            if pct >= 100: return "#1e5c30", "#7ee8a0"
            if pct >= 90:  return "#1a4020", "#7ee8a0"
            if pct >= 75:  return "#3a3a10", "#d4d46a"
            if pct >= 50:  return "#4a2a08", "#e0a060"
            return "#4a1010", "#e07070"

        _WHITE = {"red": 1.0, "green": 1.0, "blue": 1.0}
        _HEADER_BG = _hex_rgb("#1e1e2e")
        _M0_BG     = _hex_rgb("#2a2a3a")
        _MUTED_TXT = _hex_rgb("#a0a0b8")   # muted for Accounts / non-M columns

        fmt_requests: list[dict] = []

        # 1. Clear all existing formatting in the used range first
        fmt_requests.append({
            "repeatCell": {
                "range": {
                    "sheetId": sheet_gid,
                    "startRowIndex": 0,
                    "endRowIndex": num_rows,
                    "startColumnIndex": 0,
                    "endColumnIndex": num_cols,
                },
                "cell": {"userEnteredFormat": {}},
                "fields": "userEnteredFormat",
            }
        })

        # 2. Header row: dark bg, white bold text, centred
        fmt_requests.append({
            "repeatCell": {
                "range": {
                    "sheetId": sheet_gid,
                    "startRowIndex": 0,
                    "endRowIndex": 1,
                    "startColumnIndex": 0,
                    "endColumnIndex": num_cols,
                },
                "cell": {
                    "userEnteredFormat": {
                        "backgroundColor": _HEADER_BG,
                        "textFormat": {"bold": True, "foregroundColor": _WHITE},
                        "horizontalAlignment": "CENTER",
                    }
                },
                "fields": "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
            }
        })
        # Header col A left-aligned (matches Cohort column)
        fmt_requests.append({
            "repeatCell": {
                "range": {
                    "sheetId": sheet_gid,
                    "startRowIndex": 0,
                    "endRowIndex": 1,
                    "startColumnIndex": 0,
                    "endColumnIndex": 1,
                },
                "cell": {
                    "userEnteredFormat": {
                        "backgroundColor": _HEADER_BG,
                        "textFormat": {"bold": True, "foregroundColor": _WHITE},
                        "horizontalAlignment": "LEFT",
                    }
                },
                "fields": "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
            }
        })

        # 3. Data rows: per-cell formatting
        body_rows = []
        for _c in result_cohorts:
            _pct_by_offset = {_m["offset"]: _m["pct"] for _m in _c["months"]}
            _cells: list[dict] = []

            # Col A – Cohort label: bold, left-aligned
            _cells.append({"userEnteredFormat": {
                "textFormat": {"bold": True, "foregroundColor": _WHITE},
                "horizontalAlignment": "LEFT",
            }})
            # Col B – Accounts: muted, right-aligned
            _cells.append({"userEnteredFormat": {
                "textFormat": {"foregroundColor": _MUTED_TXT},
                "horizontalAlignment": "RIGHT",
            }})
            # Col C – Start ARR: muted, right-aligned
            _cells.append({"userEnteredFormat": {
                "textFormat": {"foregroundColor": _MUTED_TXT},
                "horizontalAlignment": "RIGHT",
            }})
            _PCT_FMT = {"type": "PERCENT", "pattern": "0.0%"}
            # Col D – M0: dark bg, white bold, centred, % format
            _cells.append({"userEnteredFormat": {
                "backgroundColor": _M0_BG,
                "textFormat": {"bold": True, "foregroundColor": _WHITE},
                "horizontalAlignment": "CENTER",
                "numberFormat": _PCT_FMT,
            }})
            # Cols E+ – M1…Mn: heatmap based on pct + % format
            for _i in range(1, max_offset + 1):
                _pct = _pct_by_offset.get(_i)
                if _pct is not None:
                    _bg_h, _fg_h = _ret_colors(_pct)
                    _cells.append({"userEnteredFormat": {
                        "backgroundColor": _hex_rgb(_bg_h),
                        "textFormat": {"foregroundColor": _hex_rgb(_fg_h)},
                        "horizontalAlignment": "CENTER",
                        "numberFormat": _PCT_FMT,
                    }})
                else:
                    # No data yet for this cohort/period — neutral empty cell
                    _cells.append({"userEnteredFormat": {
                        "horizontalAlignment": "CENTER",
                        "numberFormat": _PCT_FMT,
                    }})

            body_rows.append({"values": _cells})

        if body_rows:
            fmt_requests.append({
                "updateCells": {
                    "rows": body_rows,
                    "fields": "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,numberFormat)",
                    "range": {
                        "sheetId": sheet_gid,
                        "startRowIndex": 1,
                        "endRowIndex": 1 + len(result_cohorts),
                        "startColumnIndex": 0,
                        "endColumnIndex": num_cols,
                    },
                }
            })

        # 4. Freeze header row + Cohort column
        fmt_requests.append({
            "updateSheetProperties": {
                "properties": {
                    "sheetId": sheet_gid,
                    "gridProperties": {"frozenRowCount": 1, "frozenColumnCount": 1},
                },
                "fields": "gridProperties(frozenRowCount,frozenColumnCount)",
            }
        })

        try:
            await asyncio.to_thread(connector.batch_update, fmt_requests, sheet_id)
        except Exception:
            pass  # formatting is best-effort; the data write already succeeded

    cohort_count = len(result_cohorts)
    return {
        "ok": True,
        "spreadsheet_url": url,
        "spreadsheet_id": sheet_id,
        "sheet_gid": sheet_gid,
        "rows_written": len(values),
        "cohort_count": cohort_count,
        "range_used": range_a1,
        "message": f'Exported {len(values)} rows ({cohort_count} cohorts) to "{COHORT_RETENTION_EXPORT_SHEET}" tab.',
    }


PP_PROJECT_EXPORT_SHEET = "P&P project export_May '26"
PP_PROJECT_EXPORT_MONTH = "2026-05"


def _export_quantity_for_line_items(items: list) -> float | None:
    """Usage metric per SKU row: seats, IQ/MR locations, or RVK agents; blank for iCampaign."""
    if not items:
        return None
    pname = items[0].product_name
    if _is_icampaign_product(pname):
        return None
    if _is_rvk_agent_product(pname):
        qty = sum(float(li.quantity or 0) for li in items)
        return round(qty, 2) if qty else None
    if _is_additional_iqmr_eins(pname):
        qty = sum(float(li.quantity or 0) for li in items)
        return round(qty, 2) if qty else None
    if _is_additional_crm_seats(pname):
        qty = sum(float(li.quantity or 0) for li in items)
        return round(qty, 2) if qty else None
    if _is_crm_platform_includes_5_seats(pname):
        return 5.0
    return None


def _display_sku_name(items: list) -> str:
    if not items:
        return "Other"
    li = items[0]
    canonical = _match_arr_product(li.product_name) or _match_arr_product(_normalized_product_name(li.product_name))
    if canonical:
        return canonical
    return (li.product_name or "Other").strip()


async def _build_pp_project_export_data(
    db: AsyncSession,
    month_key: str = PP_PROJECT_EXPORT_MONTH,
) -> dict:
    """May-end (or month_key-end) investor snapshot: one row per customer × active SKU."""
    month_end = _month_key_to_period(month_key)
    if month_end is None:
        return {"month_key": month_key, "as_of": None, "rows": [], "account_count": 0, "line_count": 0}

    overrides = await _get_record_type_overrides(db)

    def _opp_type(o: Opportunity) -> str:
        key = (o.sf_id or "").strip()
        override = overrides.get(key) or (overrides.get(key[:15]) if len(key) >= 15 else None)
        return (override or o.record_type_name or "").strip() or "—"

    def _is_renewal(o: Opportunity) -> bool:
        return _is_renewal_record_type(_opp_type(o))

    def _is_nb(o: Opportunity) -> bool:
        return _is_new_business_record_type(_opp_type(o))

    def _is_expansion(o: Opportunity) -> bool:
        return _is_expansion_record_type(_opp_type(o))

    q_cw = select(Opportunity).where(
        or_(
            Opportunity.stage_name.in_(CLOSED_STAGES),
            func.lower(func.trim(Opportunity.stage_name)) == "closed won",
        )
    )
    closed_won_opps = [o for o in (await db.execute(q_cw)).scalars().all() if _is_closed_won_stage(o.stage_name)]
    q_open = select(Opportunity).where(
        Opportunity.stage_name.isnot(None),
        ~Opportunity.stage_name.in_(CLOSED_STAGES),
    )
    open_opps = [
        o for o in (await db.execute(q_open)).scalars().all()
        if not _is_closed_won_stage(o.stage_name) and (o.stage_name or "").strip().lower() != "closed lost"
    ]

    account_keys: set[tuple[str | None, str | None]] = set()
    for o in closed_won_opps:
        if _is_renewal(o) or _is_nb(o):
            account_keys.add((o.account_id, o.account_name or None))
    for o in open_opps:
        if _is_renewal(o):
            account_keys.add((o.account_id, o.account_name or None))

    account_period_opps: dict[tuple[str | None, str | None], list[dict]] = {}
    for key in account_keys:
        cw_for_account = [o for o in closed_won_opps if (o.account_id, o.account_name or None) == key]
        closed_renewal_or_nb = [o for o in cw_for_account if _is_renewal(o) or _is_nb(o)]

        def _period_start(o: Opportunity) -> date:
            return o.contract_start_date or o.close_date or date.max

        period_opps_sorted = sorted(closed_renewal_or_nb, key=lambda o: (_period_start(o), o.contract_end_date or date.min))
        periods_for_key: list[dict] = []
        for o in period_opps_sorted:
            p_start = o.contract_start_date or o.close_date
            p_end = o.contract_end_date or o.renewal_date or o.close_date
            if p_start and p_end and p_start <= p_end:
                periods_for_key.append({"opp": o, "start": p_start, "end": p_end})
        account_period_opps[key] = periods_for_key

    all_closed_sf_ids = {o.sf_id for o in closed_won_opps if o.sf_id}
    lines = (
        await db.execute(
            select(OpportunityLineItem).where(OpportunityLineItem.opportunity_sf_id.in_(all_closed_sf_ids))
        )
    ).scalars().all() if all_closed_sf_ids else []

    # Cohort = first month with ARR > 0
    history_data = await _build_arr_history_data(db)
    all_months: list[str] = history_data["month_columns"]
    cohort_by_name: dict[str, str] = {}
    for row in history_data["rows"]:
        name = row["account_name"]
        for mk in all_months:
            if row["arr_by_month"].get(mk, 0.0) > 0:
                cohort_by_name[name] = mk
                break

    snap_rows = (
        await db.execute(select(MonthlyArrSnapshot).where(MonthlyArrSnapshot.month_key == month_key))
    ).scalars().all()
    snap_by_name = {s.account_name: round(float(s.arr or 0), 2) for s in snap_rows if (s.arr or 0) > 0}

    schedule_rows, _ = await _compute_active_arr_rows(db, crm_month_keys=[month_key])
    name_to_key: dict[str, tuple[str | None, str | None]] = {}
    account_id_by_name: dict[str, str | None] = {}
    for r in schedule_rows:
        aname = r.get("account_name") or "—"
        aid = r.get("account_id")
        name_to_key[aname] = (aid, aname if aname != "—" else None)
        account_id_by_name[aname] = aid

    def _opp_ids_at_month_end(key: tuple[str | None, str | None]) -> tuple[dict | None, set[str]]:
        periods = account_period_opps.get(key, [])
        cw_for_account = [o for o in closed_won_opps if (o.account_id, o.account_name or None) == key]
        closed_expansions_key = [o for o in cw_for_account if _is_expansion(o)]
        p_hit = next((p for p in periods if p["start"] <= month_end <= p["end"]), None)
        if p_hit is None:
            return None, set()
        opp_ids: set[str] = {p_hit["opp"].sf_id} if p_hit["opp"].sf_id else set()
        for o in closed_expansions_key:
            if (
                o.sf_id
                and o.close_date
                and p_hit["start"] <= o.close_date <= p_hit["end"]
                and o.close_date <= month_end
            ):
                opp_ids.add(o.sf_id)
        return p_hit, opp_ids

    export_rows: list[dict] = []
    for aname in sorted(snap_by_name.keys()):
        total_arr = snap_by_name[aname]
        key = name_to_key.get(aname)
        if key is None:
            # Try fuzzy match on account keys
            for k in account_keys:
                if (k[1] or "").strip() == aname.strip():
                    key = k
                    break
        cohort_month = cohort_by_name.get(aname, "")
        account_id = account_id_by_name.get(aname)
        p_hit, opp_ids = _opp_ids_at_month_end(key) if key else (None, set())
        sub_start = p_hit["start"].isoformat() if p_hit else ""
        sub_end = p_hit["end"].isoformat() if p_hit else ""

        sku_groups: dict[str, list] = {}
        for li in lines:
            if li.opportunity_sf_id not in opp_ids:
                continue
            raw = _normalized_product_name(li.product_name)
            if not _include_line_item_in_arr(raw, li.product_name):
                continue
            pk = _arr_product_key(raw) or _arr_product_key(li.product_name) or "other"
            canonical = _match_arr_product(li.product_name) or _match_arr_product(raw) or pk
            sku_groups.setdefault(canonical, []).append(li)

        if not sku_groups:
            export_rows.append({
                "customer_name": aname,
                "account_id": account_id,
                "total_customer_arr": total_arr,
                "cohort_month": cohort_month,
                "subscription_start": sub_start,
                "subscription_end": sub_end,
                "product_sku": "",
                "sku_arr": None,
                "quantity": None,
            })
            continue

        for _pk, items in sorted(sku_groups.items(), key=lambda x: _display_sku_name(x[1])):
            by_opp: dict[str, list] = {}
            for li in items:
                by_opp.setdefault(li.opportunity_sf_id or "", []).append(li)
            arr = round(sum(_arr_contribution_for_line_group(g) for g in by_opp.values() if g), 2)
            if not arr:
                continue
            export_rows.append({
                "customer_name": aname,
                "account_id": account_id,
                "total_customer_arr": total_arr,
                "cohort_month": cohort_month,
                "subscription_start": sub_start,
                "subscription_end": sub_end,
                "product_sku": _display_sku_name(items),
                "sku_arr": arr,
                "quantity": _export_quantity_for_line_items(items),
            })

    account_count = len(snap_by_name)
    return {
        "month_key": month_key,
        "as_of": month_end.isoformat(),
        "rows": export_rows,
        "account_count": account_count,
        "line_count": len(export_rows),
        "grand_total": round(sum(snap_by_name.values()), 2),
    }


def _pp_project_export_sheet_values(data: dict) -> list[list]:
    header = [
        "Customer name",
        "SFDC Account ID",
        "Total customer ARR",
        "Cohort month (first ARR)",
        "Subscription start",
        "Subscription end",
        "Product SKU",
        "SKU ARR",
        "Quantity",
    ]
    values = [header]
    for r in data.get("rows") or []:
        qty = r.get("quantity")
        values.append([
            r.get("customer_name") or "",
            r.get("account_id") or "",
            round(float(r.get("total_customer_arr") or 0), 2),
            r.get("cohort_month") or "",
            r.get("subscription_start") or "",
            r.get("subscription_end") or "",
            r.get("product_sku") or "",
            round(float(r["sku_arr"]), 2) if r.get("sku_arr") is not None else "",
            qty if qty is not None else "",
        ])
    return values


@app.get("/api/analyses/pp-project-export")
async def get_pp_project_export(
    month: Optional[str] = Query(None, description="Month key YYYY-MM (default May 2026)"),
    db: AsyncSession = Depends(get_db),
):
    """Preview the P&P / investor customer snapshot (one row per customer × SKU)."""
    data = await _build_pp_project_export_data(db, month_key=(month or PP_PROJECT_EXPORT_MONTH).strip())
    base = os.getenv("SALESFORCE_BASE_URL", "").strip().rstrip("/")
    if base:
        data["salesforce_base_url"] = base
    return JSONResponse(content=data, headers={"Cache-Control": "no-store, must-revalidate"})


@app.post("/api/export/pp-project-to-google-sheet")
async def export_pp_project_to_google_sheet(
    month: Optional[str] = Query(None, description="Month key YYYY-MM (default May 2026)"),
    db: AsyncSession = Depends(get_db),
):
    """Export the P&P investor snapshot to tab 'P&P project export_May '26' in the financial model."""
    from connectors.google_sheets import GoogleSheetsConnector

    month_key = (month or PP_PROJECT_EXPORT_MONTH).strip()
    data = await _build_pp_project_export_data(db, month_key=month_key)
    values = _pp_project_export_sheet_values(data)

    sheet_id = os.getenv("GOOGLE_SHEET_ID")
    if not sheet_id:
        return {"ok": False, "error": "GOOGLE_SHEET_ID is not set. Set it in backend/.env to the financial model spreadsheet ID."}
    backend_dir = Path(__file__).resolve().parent
    cred_env = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    cred_path = cred_env if not cred_env or os.path.isabs(cred_env) else str(backend_dir / cred_env)
    connector = GoogleSheetsConnector(credentials_path=cred_path or cred_env)
    connector.set_base_path(backend_dir)
    if not connector.is_configured():
        return {
            "ok": False,
            "error": "Google Sheets not configured. Set GOOGLE_APPLICATION_CREDENTIALS (or GOOGLE_SHEETS_CREDENTIALS_JSON) in .env.",
        }
    try:
        await asyncio.to_thread(connector.ensure_sheet_exists, PP_PROJECT_EXPORT_SHEET, spreadsheet_id=sheet_id)
        exact_title = await asyncio.to_thread(connector.get_sheet_exact_title, PP_PROJECT_EXPORT_SHEET, sheet_id)
        if not exact_title:
            return {"ok": False, "error": f'Tab "{PP_PROJECT_EXPORT_SHEET}" not found after ensure. Check the spreadsheet.'}
        sheet_ref = "'" + exact_title.replace("'", "''") + "'"
        num_cols = len(values[0]) if values else 9
        num_rows = len(values)
        end_col = _index_to_a1_col(num_cols - 1)
        range_a1 = f"{sheet_ref}!A1:{end_col}{max(num_rows, 1)}"
        await asyncio.to_thread(connector.update_range, range_a1, values, spreadsheet_id=sheet_id)
    except Exception as e:
        err_msg = str(e)
        if "403" in err_msg or "does not have permission" in err_msg.lower():
            sa_email = connector.get_service_account_email()
            err_msg = (
                f"Permission denied. Share the Google Sheet with the service account as Editor: "
                f"{sa_email or 'see client_email in your JSON key'}. {err_msg[:200]}"
            )
        elif "404" in err_msg or "Unable to parse range" in err_msg or "not found" in err_msg.lower():
            err_msg = f'Sheet tab not found. Create or allow auto-create of "{PP_PROJECT_EXPORT_SHEET}". {err_msg[:200]}'
        return {"ok": False, "error": err_msg}

    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
    sheet_gid = await asyncio.to_thread(connector.get_sheet_gid_by_title, PP_PROJECT_EXPORT_SHEET, sheet_id)
    if sheet_gid is not None:
        url = f"{url}#gid={sheet_gid}"
    return {
        "ok": True,
        "spreadsheet_url": url,
        "spreadsheet_id": sheet_id,
        "sheet_gid": sheet_gid,
        "rows_written": len(values),
        "account_count": data.get("account_count", 0),
        "line_count": data.get("line_count", 0),
        "range_used": range_a1,
        "message": (
            f'Exported {len(values) - 1} data rows ({data.get("account_count", 0)} accounts) '
            f'to "{PP_PROJECT_EXPORT_SHEET}" as of {data.get("as_of", month_key)}.'
        ),
    }


@app.post("/api/export/test-write-to-sheet")
async def test_write_to_sheet():
    """
    Write a single test row to the "Copilot ARR export" tab (cells Z1:AA1) to verify the app can write to your
    spreadsheet. Does not overwrite A1:B1 so the export table header stays intact.
    """
    from connectors.google_sheets import GoogleSheetsConnector

    sheet_id = os.getenv("GOOGLE_SHEET_ID")
    if not sheet_id:
        return {"ok": False, "error": "GOOGLE_SHEET_ID is not set in backend/.env"}
    now_est = datetime.now(EST).strftime("%Y-%m-%d %H:%M:%S EST")
    values = [["Test write from Dazos CFO Cockpit", now_est]]
    backend_dir = Path(__file__).resolve().parent
    cred_env = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    cred_path = cred_env
    if cred_path and not os.path.isabs(cred_path):
        cred_path = str(backend_dir / cred_path)
    connector = GoogleSheetsConnector(credentials_path=cred_path or cred_env)
    connector.set_base_path(backend_dir)
    if not connector.is_configured():
        return {"ok": False, "error": "Google Sheets not configured. Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SHEETS_CREDENTIALS_JSON in .env."}
    try:
        await asyncio.to_thread(connector.ensure_sheet_exists, COPILOT_ARR_EXPORT_SHEET, spreadsheet_id=sheet_id)
        exact_title = await asyncio.to_thread(connector.get_sheet_exact_title, COPILOT_ARR_EXPORT_SHEET, sheet_id)
        if not exact_title:
            return {"ok": False, "error": f"Tab \"{COPILOT_ARR_EXPORT_SHEET}\" not found after ensure."}
        sheet_ref = "'" + exact_title.replace("'", "''") + "'"
        range_a1 = f"{sheet_ref}!Z1:AA1"
        await asyncio.to_thread(connector.update_range, range_a1, values, spreadsheet_id=sheet_id)
        read_back = await asyncio.to_thread(connector.read_range, range_a1, sheet_id)
        sheet_gid = await asyncio.to_thread(connector.get_sheet_gid_by_title, COPILOT_ARR_EXPORT_SHEET, sheet_id)
    except Exception as e:
        err_msg = str(e)
        if "403" in err_msg or "does not have permission" in err_msg.lower():
            sa_email = connector.get_service_account_email()
            err_msg = f"Permission denied. Share the spreadsheet with the service account as Editor: {sa_email or 'see client_email in your JSON key'}. {err_msg[:200]}"
        elif "404" in err_msg or "Unable to parse range" in err_msg:
            err_msg = f"Sheet tab not found or wrong spreadsheet. {err_msg[:200]}"
        return {"ok": False, "error": err_msg}
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
    if sheet_gid is not None:
        url = f"{url}#gid={sheet_gid}"
    a1 = (read_back[0][0] if read_back and len(read_back[0]) > 0 else "") if read_back else ""
    b1 = (read_back[0][1] if read_back and len(read_back[0]) > 1 else "") if read_back else ""
    if a1 == "" and b1 == "":
        sa_email = connector.get_service_account_email()
        msg = f"Read-back was empty — share the spreadsheet with this account as Editor: {sa_email or 'see client_email in credentials JSON'}. Then try again."
    else:
        msg = f"Wrote and read back. Z1='{a1}' AA1='{b1}'. Use the link below to open the exact tab."
    return {
        "ok": True,
        "spreadsheet_url": url,
        "spreadsheet_id": sheet_id,
        "sheet_gid": sheet_gid,
        "read_back_a1": a1,
        "read_back_b1": b1,
        "message": msg,
    }


@app.get("/api/accounts")
async def get_accounts(
    limit: int = Query(500, ge=1, le=5000),
    db: AsyncSession = Depends(get_db),
):
    """Return synced accounts (from last Salesforce sync)."""
    r = await db.execute(select(Account).order_by(Account.name).limit(limit))
    rows = r.scalars().all()
    return [
        {
            "sf_id": a.sf_id,
            "name": a.name,
            "type": a.type,
            "status": a.status,
            "industry": a.industry,
            "annual_revenue": a.annual_revenue,
            "number_of_employees": a.number_of_employees,
            "billing_country": a.billing_country,
            "billing_city": a.billing_city,
            "billing_state": a.billing_state,
            "phone": a.phone,
            "website": a.website,
            "segment": (a.segment or "").strip() or DEFAULT_SEGMENT,
            "created_date": a.created_date.isoformat() if a.created_date else None,
            "synced_at": a.synced_at.isoformat() if a.synced_at else None,
        }
        for a in rows
    ]


@app.get("/api/opportunities")
async def get_opportunities(
    limit: int = Query(500, ge=1, le=2000),
    stage: Optional[str] = Query(None, description="Filter by StageName"),
    db: AsyncSession = Depends(get_db),
):
    """Return synced opportunities (from last Salesforce sync). For ARR and pipeline."""
    q = select(Opportunity).order_by(Opportunity.close_date.desc().nullslast(), Opportunity.id.desc())
    if stage:
        q = q.where(Opportunity.stage_name == stage)
    r = await db.execute(q.limit(limit))
    rows = r.scalars().all()
    return [
        {
            "sf_id": o.sf_id,
            "name": o.name,
            "amount": o.amount,
            "close_date": o.close_date.isoformat() if o.close_date else None,
            "stage_name": o.stage_name,
            "type": o.type,
            "record_type_name": o.record_type_name,
            "account_name": o.account_name,
            "synced_at": o.synced_at.isoformat() if o.synced_at else None,
        }
        for o in rows
    ]


# Pipeline and Closed data: only these record types (case-insensitive).
PIPELINE_RECORD_TYPES = frozenset({"new business", "expansion"})


def _is_pipeline_record_type(record_type_name: Optional[str]) -> bool:
    return (record_type_name or "").strip().lower() in PIPELINE_RECORD_TYPES


def _a1_col_to_index(col_letters: str) -> int:
    """Convert A1 column letters to 0-based index (A=0, B=1, ..., Z=25, AA=26, BV=73)."""
    n = 0
    for c in (col_letters or "").strip().upper():
        n = n * 26 + (ord(c) - ord("A") + 1)
    return n - 1 if n else 0


def _index_to_a1_col(i: int) -> str:
    """Convert 0-based column index to A1 letters (0=A, 1=B, ..., 26=AA)."""
    if i < 0:
        return "A"
    letters = []
    n = i + 1
    while n > 0:
        n, r = divmod(n - 1, 26)
        letters.append(chr(65 + r))
    return "".join(reversed(letters))


# ARR_Calculations_2026P: row 11 = new business plan, row 12 = expansion plan; Feb = BV (user-specified).
ARR_2026P_MONTH_COLUMNS = [
    "BU", "BV", "BW", "BX", "BY", "BZ", "CA", "CB", "CC", "CD", "CE", "CF",
]  # Jan..Dec

# Renewals plan: ARR_Calculations_2026P month columns BU..CF (Jan..Dec).
# UFR plan: fixed row below; renewal rate / contraction use BU52/BU54; **cancelled plan $** = **−**row 35 (Jan = **−BU35**).
ARR_2026P_RENEWALS_UFR_ROW = 32  # Excel row 33 — adjust if sheet layout differs
RENEWALS_CANCELLED_PLAN_ROW = 35


def _pipeline_from_snapshot_payload(
    payload: dict,
    filter_segment_list: Optional[List[str]] = None,
    filter_stage_list: Optional[List[str]] = None,
    filter_record_type_list: Optional[List[str]] = None,
) -> dict:
    """Build pipeline-overview response from EOD snapshot payload (accounts, opportunities, opportunity_line_items)."""
    accounts = payload.get("accounts") or []
    opportunities = payload.get("opportunities") or []
    line_items = payload.get("opportunity_line_items") or []
    account_segment = {a["sf_id"]: (a.get("segment") or "").strip() or DEFAULT_SEGMENT for a in accounts if a.get("sf_id")}
    open_opps_all = [
        o for o in opportunities
        if (o.get("stage_name") or "").strip() not in CLOSED_STAGES
        and _is_pipeline_record_type(o.get("record_type_name"))
    ]
    segments_set = set()
    stages_set = set()
    record_types_set = set()
    for o in open_opps_all:
        seg = account_segment.get(o.get("account_id")) if o.get("account_id") else DEFAULT_SEGMENT
        segments_set.add(seg)
        stages_set.add(_canonical_stage_name(o.get("stage_name")))
        record_types_set.add(o.get("record_type_name") or "—")
    def _norm(s: str) -> str:
        return (s or "").strip().lower()
    filter_segments = {_norm(s) for s in (filter_segment_list or [])}
    filter_stages = {_norm(s) for s in (filter_stage_list or [])}
    filter_record_types = {_norm(s) for s in (filter_record_type_list or [])}

    def _keep(o: dict) -> bool:
        seg = account_segment.get(o.get("account_id")) if o.get("account_id") else DEFAULT_SEGMENT
        if filter_segments and _norm(seg) not in filter_segments:
            return False
        canonical_stage = _canonical_stage_name(o.get("stage_name"))
        if filter_stages and _norm(canonical_stage) not in filter_stages:
            return False
        if filter_record_types and _norm(o.get("record_type_name") or "") not in filter_record_types:
            return False
        return True

    open_opps = [o for o in open_opps_all if _keep(o)]
    pipeline_sf_ids = {o["sf_id"] for o in open_opps}
    opp_to_arr_from_lines: dict[str, float] = {}
    for li in line_items:
        opp_sf_id = li.get("opportunity_sf_id")
        if opp_sf_id not in pipeline_sf_ids:
            continue
        raw = _normalized_product_name(li.get("product_name"))
        if not _include_line_item_in_arr(raw, li.get("product_name")):
            continue
        mrr = _line_item_effective_total_dict(li)
        opp_to_arr_from_lines[opp_sf_id] = opp_to_arr_from_lines.get(opp_sf_id, 0) + mrr * PIPELINE_ARR_MULTIPLIER
    opp_to_arr_from_lines = {k: round(v, 2) for k, v in opp_to_arr_from_lines.items()}
    rows = []
    grand_total = 0.0
    for o in open_opps:
        mrr_val = o.get("mrr")
        if mrr_val is not None and mrr_val != 0:
            arr = round(float(mrr_val) * PIPELINE_ARR_MULTIPLIER, 2)
        else:
            arr = opp_to_arr_from_lines.get(o["sf_id"], 0)
        grand_total += arr
        seg = account_segment.get(o.get("account_id")) if o.get("account_id") else DEFAULT_SEGMENT
        rows.append({
            "account_id": o.get("account_id"),
            "account_name": o.get("name") or "—",
            "segment": seg,
            "opportunity_sf_id": o["sf_id"],
            "opportunity_name": o.get("name") or "—",
            "stage_name": _canonical_stage_name(o.get("stage_name")),
            "record_type_name": o.get("record_type_name") or "—",
            "close_date": o.get("close_date"),
            "arr": arr,
        })
    rows.sort(key=lambda x: -x["arr"])
    return {
        "rows": rows,
        "grand_total": round(grand_total, 2),
        "segments": sorted(segments_set),
        "stages": sorted(stages_set),
        "record_types": sorted(record_types_set),
    }


@app.get("/api/pipeline-overview")
async def get_pipeline_overview(
    db: AsyncSession = Depends(get_db),
    segment: Optional[List[str]] = Query(None, description="Filter by segment (e.g. Enterprise)"),
    stage: Optional[List[str]] = Query(None, description="Filter by stage name"),
    record_type: Optional[List[str]] = Query(None, description="Filter by record type (e.g. Expansion)"),
    as_of: Optional[date] = Query(None, description="Pipeline as of date (uses latest EOD snapshot on or before this date)"),
):
    """
    Open opportunities (pipeline): not Closed Won / Closed Lost; record type = New Business or Expansion only.
    ARR = Opportunity.MRR (Finance Details) × 12 per opportunity.
    Live data comes from SQLite after Dashboard → Refresh app data (or optional hourly background sync).
    Optional as_of uses a stored EOD snapshot if one exists for that date (daily EOD at 23:59 EST snapshots DB state).
    Optional filters: segment, stage, record_type.
    """
    if as_of is not None:
        r_snap = await db.execute(
            select(SalesforceEODSnapshot)
            .where(SalesforceEODSnapshot.snapshot_date <= as_of)
            .order_by(SalesforceEODSnapshot.snapshot_date.desc())
            .limit(1)
        )
        snap = r_snap.scalar_one_or_none()
        if snap and snap.data_json:
            payload = json.loads(snap.data_json)
            out = _pipeline_from_snapshot_payload(payload, segment, stage, record_type)
            out["snapshot_date"] = snap.snapshot_date.isoformat()
            base = os.getenv("SALESFORCE_BASE_URL", "").strip().rstrip("/")
            if base and ("salesforce.com" in base or "lightning.force.com" in base):
                out["salesforce_base_url"] = base
            return out
        out = {
            "rows": [],
            "grand_total": 0,
            "segments": [],
            "stages": [],
            "record_types": [],
            "snapshot_date": None,
            "message": "No EOD snapshot for that date. Use live data without as_of, or ensure daily EOD has run after data was refreshed.",
        }
        base = os.getenv("SALESFORCE_BASE_URL", "").strip().rstrip("/")
        if base and ("salesforce.com" in base or "lightning.force.com" in base):
            out["salesforce_base_url"] = base
        return out

    q_open = select(Opportunity).where(
        Opportunity.stage_name.isnot(None),
        ~Opportunity.stage_name.in_(CLOSED_STAGES),
    )
    r = await db.execute(q_open)
    open_opps_all = [o for o in r.scalars().all() if _is_pipeline_record_type(o.record_type_name)]
    account_ids = {o.account_id for o in open_opps_all if o.account_id}
    account_segment: dict[str, str] = {}
    if account_ids:
        q_acc = select(Account.sf_id, Account.segment).where(Account.sf_id.in_(account_ids))
        r_acc = await db.execute(q_acc)
        for (sf_id, seg) in r_acc.all():
            account_segment[sf_id] = (seg or "").strip() or DEFAULT_SEGMENT
    # Distinct values for filter dropdowns (from New Business + Expansion open opps)
    segments_set: set[str] = set()
    stages_set: set[str] = set()
    record_types_set: set[str] = set()
    deal_tiers_set: set[str] = set()
    for o in open_opps_all:
        seg = account_segment.get(o.account_id) if o.account_id else DEFAULT_SEGMENT
        segments_set.add(seg)
        stages_set.add(_canonical_stage_name(o.stage_name))
        record_types_set.add(o.record_type_name or "—")
        if o.deal_tier:
            deal_tiers_set.add(o.deal_tier)
    # Apply filters (case-insensitive match)
    def _norm(s: str) -> str:
        return (s or "").strip().lower()

    filter_segments = {_norm(s) for s in (segment or [])}
    filter_stages = {_norm(s) for s in (stage or [])}
    filter_record_types = {_norm(s) for s in (record_type or [])}

    def _keep(o) -> bool:
        seg = account_segment.get(o.account_id) if o.account_id else DEFAULT_SEGMENT
        if filter_segments and _norm(seg) not in filter_segments:
            return False
        canonical_stage = _canonical_stage_name(o.stage_name or "")
        if filter_stages and _norm(canonical_stage) not in filter_stages:
            return False
        if filter_record_types and _norm(o.record_type_name or "") not in filter_record_types:
            return False
        return True

    open_opps = [o for o in open_opps_all if _keep(o)]
    pipeline_sf_ids = {o.sf_id for o in open_opps}
    # Fallback: when Opportunity.MRR is null/zero, use sum(OpportunityLineItem.TotalPrice)×12
    opp_to_arr_from_lines: dict[str, float] = {}
    if pipeline_sf_ids:
        q_lines = select(OpportunityLineItem).where(
            OpportunityLineItem.opportunity_sf_id.in_(pipeline_sf_ids)
        )
        r_lines = await db.execute(q_lines)
        for li in r_lines.scalars().all():
            raw = _normalized_product_name(li.product_name)
            if not _include_line_item_in_arr(raw, li.product_name):
                continue
            opp_sf_id = li.opportunity_sf_id
            mrr = _line_item_effective_total(li)
            opp_to_arr_from_lines[opp_sf_id] = opp_to_arr_from_lines.get(opp_sf_id, 0) + mrr * PIPELINE_ARR_MULTIPLIER
        opp_to_arr_from_lines = {k: round(v, 2) for k, v in opp_to_arr_from_lines.items()}
    # ── Latest AI scores ──────────────────────────────────────────────────────
    latest_ai_r = await db.execute(select(func.max(DealAIScore.scored_at)))
    latest_ai_at = latest_ai_r.scalar_one_or_none()
    ai_scores: dict[str, DealAIScore] = {}
    if latest_ai_at is not None:
        ai_r = await db.execute(
            select(DealAIScore).where(DealAIScore.scored_at == latest_ai_at)
        )
        for s in ai_r.scalars().all():
            ai_scores[s.sf_opp_id] = s

    rows = []
    grand_total = 0.0
    for o in open_opps:
        if o.mrr is not None and o.mrr != 0:
            arr = round(float(o.mrr) * PIPELINE_ARR_MULTIPLIER, 2)
        else:
            arr = opp_to_arr_from_lines.get(o.sf_id, 0)
        grand_total += arr
        seg = account_segment.get(o.account_id) if o.account_id else DEFAULT_SEGMENT
        ai_score = ai_scores.get(o.sf_id or "")
        rows.append({
            "account_id": o.account_id,
            "account_name": o.account_name or "—",
            "segment": seg,
            "opportunity_sf_id": o.sf_id,
            "opportunity_name": o.name or "—",
            "stage_name": _canonical_stage_name(o.stage_name),
            "forecast_category": (o.forecast_category or "").strip() or None,
            "deal_tier": (o.deal_tier or "").strip() or None,
            "record_type_name": o.record_type_name or "—",
            "close_date": o.close_date.isoformat() if o.close_date else None,
            "arr": arr,
            "ai_probability": round(ai_score.probability, 3) if ai_score else None,
            "ai_reasoning": ai_score.reasoning if ai_score else None,
        })
    rows.sort(key=lambda x: -x["arr"])
    out = {
        "rows": rows,
        "grand_total": round(grand_total, 2),
        "segments": sorted(segments_set),
        "stages": sorted(stages_set),
        "record_types": sorted(record_types_set),
        "deal_tiers": sorted(deal_tiers_set),
    }
    base = os.getenv("SALESFORCE_BASE_URL", "").strip().rstrip("/")
    if base and ("salesforce.com" in base or "lightning.force.com" in base):
        out["salesforce_base_url"] = base
    return out


@app.get("/api/closed-overview")
async def get_closed_overview(
    db: AsyncSession = Depends(get_db),
    segment: Optional[List[str]] = Query(None, description="Filter by segment"),
    stage: Optional[List[str]] = Query(None, description="Filter by stage (e.g. Closed Won)"),
    record_type: Optional[List[str]] = Query(None, description="Filter by record type"),
    months: Optional[List[str]] = Query(None, description="Filter by close-date month(s), e.g. 2026-02, 2026-03"),
):
    """
    Closed opportunities (Closed Won + Closed Lost). List includes New Business, Expansion, Renewal, and Amendment (for display).
    Optional filters: segment, stage, record_type, months.
    ARR = ``ARR__c`` (New Business) or ``Expansion_ARR__c`` (Expansion / Renewal / Amendment) on the Opportunity — no line-item rollup.
    """
    overrides = await _get_record_type_overrides(db)

    def _effective_record_type(o: Opportunity) -> str:
        key = (o.sf_id or "").strip()
        override = overrides.get(key) or (overrides.get(key[:15]) if len(key) >= 15 else None)
        return (override or o.record_type_name or "").strip() or "—"

    def _in_bookings_list(o: Opportunity) -> bool:
        rt = _effective_record_type(o)
        return _is_pipeline_record_type(rt) or _is_renewal_record_type(rt) or _is_amendment_record_type(rt)

    q_closed = select(Opportunity).where(
        Opportunity.stage_name.in_(CLOSED_STAGES),
        Opportunity.close_date.isnot(None),
    ).order_by(Opportunity.close_date.desc())
    r = await db.execute(q_closed)
    closed_opps_all = [
        o
        for o in r.scalars().all()
        if _in_bookings_list(o) and not _is_excluded_from_bookings_nb_only(o, _effective_record_type(o))
    ]
    account_ids_all = {o.account_id for o in closed_opps_all if o.account_id}
    account_segment: dict[str, str] = {}
    if account_ids_all:
        q_acc = select(Account.sf_id, Account.segment).where(Account.sf_id.in_(account_ids_all))
        r_acc = await db.execute(q_acc)
        for (sf_id, seg) in r_acc.all():
            account_segment[sf_id] = (seg or "").strip() or DEFAULT_SEGMENT
    # Distinct values for filter dropdowns
    segments_set: set[str] = set()
    stages_set: set[str] = set()
    record_types_set: set[str] = set()
    available_months_set: set[str] = set()
    for o in closed_opps_all:
        seg = account_segment.get(o.account_id) if o.account_id else DEFAULT_SEGMENT
        segments_set.add(seg)
        stages_set.add(o.stage_name or "—")
        record_types_set.add(_effective_record_type(o))
        if o.close_date:
            available_months_set.add(o.close_date.strftime("%Y-%m"))
    # Apply filters (case-insensitive)
    def _norm(s: str) -> str:
        return (s or "").strip().lower()

    filter_segments = {_norm(s) for s in (segment or [])}
    filter_stages = {_norm(s) for s in (stage or [])}
    filter_record_types = {_norm(s) for s in (record_type or [])}

    def _keep(o) -> bool:
        seg = account_segment.get(o.account_id) if o.account_id else DEFAULT_SEGMENT
        if filter_segments and _norm(seg) not in filter_segments:
            return False
        if filter_stages and _norm(o.stage_name or "") not in filter_stages:
            return False
        if filter_record_types and _norm(_effective_record_type(o)) not in filter_record_types:
            return False
        return True

    # Month filter
    if months:
        month_ranges: list[tuple[date, date]] = []
        for yyyy_mm in months:
            parts = (yyyy_mm or "").strip().split("-")
            if len(parts) != 2:
                continue
            try:
                y, m = int(parts[0]), int(parts[1])
                if 1 <= m <= 12:
                    first = date(y, m, 1)
                    if m == 12:
                        last = date(y, 12, 31)
                    else:
                        last = date(y, m + 1, 1) - timedelta(days=1)
                    month_ranges.append((first, last))
            except (ValueError, TypeError):
                continue
        if month_ranges:
            def _in_selected(d: date) -> bool:
                return any(first <= d <= last for first, last in month_ranges)
            closed_opps = [o for o in closed_opps_all if _keep(o) and o.close_date and _in_selected(o.close_date)]
        else:
            closed_opps = [o for o in closed_opps_all if _keep(o)]
    else:
        closed_opps = [o for o in closed_opps_all if _keep(o)]
    rows = []
    grand_total = 0.0
    for o in closed_opps:
        arr = _closed_overview_arr_from_opportunity(o, _effective_record_type(o))
        grand_total += arr
        seg = account_segment.get(o.account_id) if o.account_id else DEFAULT_SEGMENT
        rows.append({
            "account_id": o.account_id,
            "account_name": o.account_name or "—",
            "segment": seg,
            "opportunity_sf_id": o.sf_id,
            "opportunity_name": o.name or "—",
            "stage_name": o.stage_name or "—",
            "record_type_name": _effective_record_type(o),
            "close_date": o.close_date.isoformat() if o.close_date else None,
            "arr": arr,
            "forecast_category": (o.forecast_category or "").strip() or None,
        })
    rows.sort(key=lambda x: (-(date.fromisoformat(x["close_date"]) if x["close_date"] else date.min).toordinal(), -x["arr"]))
    out = {
        "rows": rows,
        "grand_total": round(grand_total, 2),
        "available_months": sorted(available_months_set, reverse=True),
        "segments": sorted(segments_set),
        "stages": sorted(stages_set),
        "record_types": sorted(record_types_set),
    }
    base = os.getenv("SALESFORCE_BASE_URL", "").strip().rstrip("/")
    if base and ("salesforce.com" in base or "lightning.force.com" in base):
        out["salesforce_base_url"] = base
    return out


def _renewal_chart_month_keys() -> list[str]:
    """Six renewal months (YYYY-MM), oldest first: 3 before current, current, 2 after (server local date)."""
    today = date.today()
    anchor = date(today.year, today.month, 1)
    out: list[str] = []
    for off in range(-3, 3):
        d = _add_calendar_months(anchor, off)
        out.append(f"{d.year}-{d.month:02d}")
    return out


def _build_renewals_chart_series(renewal_opps: list) -> list[RenewalsChartMonth]:
    """
    Stacked ARR chart (per month): excludes mid-term cancellation = Yes.
    Months shown: three before the current calendar month, the current month, then two ahead (six bars, ``date.today()``).

    - **Churned/contracted** = sum of ``delta`` over opps where ``delta < 0``; API exposes the
      **positive** magnitude (``-`` that sum) for stacking and for Renewed math.
    - **Open** = sum of up-for-renewal ARR (``original_acv``) for open (non-closed) opps.
    - **Renewed** = total up-for-renewal ARR for the month minus churned/contracted minus open
      (residual; floored at 0).
    - **ARR renewal rate** = (UFR on **closed** opps + sum of ``delta`` where ``delta < 0``) / UFR on **closed**
      opps — open pipeline UFR is excluded.
    - **Mid-term cancellation** row (separate): sum of UFR and opp count for ``midterm_cancellation`` = Yes (excluded from the stack).
    """
    agg: dict[str, dict[str, float | int]] = {}
    agg_mid: dict[str, dict[str, float | int]] = {}

    def _month_key(o: Opportunity) -> Optional[str]:
        rd = o.renewal_date if o.renewal_date is not None else o.close_date
        if not rd:
            return None
        return f"{rd.year}-{rd.month:02d}"

    for o in renewal_opps:
        if getattr(o, "midterm_cancellation", 0) == 1:
            continue
        mk = _month_key(o)
        if not mk:
            continue
        if mk not in agg:
            agg[mk] = {
                "ufr_open": 0.0,
                "neg_delta_sum": 0.0,
                "ufr_total": 0.0,
                "ufr_closed": 0.0,
                "count_open": 0,
                "count_won": 0,
                "count_lost": 0,
                "opp_total": 0,
            }
        a = agg[mk]
        st = (o.stage_name or "").strip()
        up = float(o.original_acv) if o.original_acv is not None else None

        renewed: Optional[float] = None
        delta: Optional[float] = None
        if _is_closed_lost_stage(st):
            renewed = 0.0
            if up is not None:
                delta = round(renewed - float(up), 2)
        elif _is_closed_won_stage(st):
            if o.opportunity_arr is not None:
                renewed = round(float(o.opportunity_arr), 2)
            if up is not None and renewed is not None:
                delta = round(float(renewed) - float(up), 2)

        if up is not None:
            a["ufr_total"] = float(a["ufr_total"]) + float(up)

        a["opp_total"] = int(a["opp_total"]) + 1

        if _is_closed_lost_stage(st):
            a["count_lost"] = int(a["count_lost"]) + 1
            if up is not None:
                a["ufr_closed"] = float(a["ufr_closed"]) + float(up)
        elif _is_closed_won_stage(st):
            a["count_won"] = int(a["count_won"]) + 1
            if up is not None:
                a["ufr_closed"] = float(a["ufr_closed"]) + float(up)
        else:
            a["count_open"] = int(a["count_open"]) + 1
            if up is not None:
                a["ufr_open"] = float(a["ufr_open"]) + float(up)

        if delta is not None and delta < 0:
            a["neg_delta_sum"] = float(a["neg_delta_sum"]) + float(delta)

    for o in renewal_opps:
        if getattr(o, "midterm_cancellation", 0) != 1:
            continue
        mk = _month_key(o)
        if not mk:
            continue
        if mk not in agg_mid:
            agg_mid[mk] = {"ufr_sum": 0.0, "count": 0}
        am = agg_mid[mk]
        upm = float(o.original_acv) if o.original_acv is not None else None
        if upm is not None:
            am["ufr_sum"] = float(am["ufr_sum"]) + float(upm)
        am["count"] = int(am["count"]) + 1

    def _empty_month_agg() -> dict[str, float | int]:
        return {
            "ufr_open": 0.0,
            "neg_delta_sum": 0.0,
            "ufr_total": 0.0,
            "ufr_closed": 0.0,
            "count_open": 0,
            "count_won": 0,
            "count_lost": 0,
            "opp_total": 0,
        }

    month_keys = _renewal_chart_month_keys()
    out: list[RenewalsChartMonth] = []
    for mk in month_keys:
        if mk not in agg and mk not in agg_mid:
            continue
        raw = agg[mk] if mk in agg else _empty_month_agg()
        mid_raw = agg_mid.get(mk, {"ufr_sum": 0.0, "count": 0})
        ufr = float(raw["ufr_total"])
        ufr_closed = float(raw["ufr_closed"])
        neg_sum = float(raw["neg_delta_sum"])  # sum of delta where delta < 0 (≤ 0)
        arr_churned = round(-neg_sum if neg_sum < 0 else 0.0, 2)
        arr_open_v = round(float(raw["ufr_open"]), 2)
        arr_renewed_v = round(max(0.0, ufr - arr_churned - arr_open_v), 2)
        arr_rate: Optional[float] = None
        if ufr_closed > 0:
            arr_rate = round((ufr_closed + neg_sum) / ufr_closed, 4)
        cw = int(raw["count_won"])
        cl = int(raw["count_lost"])
        opp_rate: Optional[float] = None
        closed_denom = cw + cl
        if closed_denom > 0:
            opp_rate = round(cw / closed_denom, 4)
        arr_midterm_v = round(float(mid_raw["ufr_sum"]), 2)
        count_midterm = int(mid_raw["count"])
        out.append(
            RenewalsChartMonth(
                month=mk,
                arr_open=arr_open_v,
                arr_renewed=arr_renewed_v,
                arr_churned=arr_churned,
                count_open=int(raw["count_open"]),
                count_renewed=int(raw["count_won"]),
                count_lost=cl,
                arr_renewal_rate=arr_rate,
                opp_renewal_rate=opp_rate,
                arr_midterm_cancellation=arr_midterm_v,
                count_midterm_cancellation=count_midterm,
            )
        )
    return out


@app.get("/api/renewals-overview", response_model=RenewalsOverviewResponse)
async def get_renewals_overview(
    db: AsyncSession = Depends(get_db),
    stage: Optional[List[str]] = Query(None, description="Filter by stage"),
    months: Optional[List[str]] = Query(None, description="Filter by renewal month (YYYY-MM); uses renewal date or close date"),
    midterm: Optional[List[str]] = Query(
        None,
        description="Filter by mid-term cancellation: yes (Midterm_Cancellation__c true), no (false or unset)",
    ),
):
    """
    All **Renewal** opportunities from local DB (fast). Uses record-type overrides like closed-overview.

    **Up for renewal ARR** = ``Original_ARR__c`` (``original_acv``). **Renewed ARR** = ``ARR__c`` (``opportunity_arr``)
    when **Closed Won**, **0** when **Closed Lost**; open pipeline = null.

    **Renewal date** column = dedicated ``renewal_date`` when set, else ``close_date``.
    **Mid-term cancellation** = ``"Yes"`` when ``Midterm_Cancellation__c`` is true (synced as ``midterm_cancellation``); otherwise null.
    Optional query ``midterm=yes`` / ``midterm=no`` filters rows (both = no filter).

    **renewals_chart** (3 months before through 2 months after current month, excluding mid-term cancellation) powers the stacked charts: ARR stacks
    (churn = positive magnitude of sum of negative deltas; Renewed = UFR total − churn − open; Open = UFR on open opps — open on top) and opportunity counts (Lost / Won / Open — open on top),     plus renewal rates
    (ARR-style on closed UFR only; and won / (won + lost) among closed opps).
    """
    overrides = await _get_record_type_overrides(db)

    def _effective_record_type(o: Opportunity) -> str:
        key = (o.sf_id or "").strip()
        override = overrides.get(key) or (overrides.get(key[:15]) if len(key) >= 15 else None)
        return (override or o.record_type_name or "").strip() or "—"

    def _renewal_month_key(o: Opportunity) -> Optional[str]:
        rd = o.renewal_date if o.renewal_date is not None else o.close_date
        if not rd:
            return None
        return f"{rd.year}-{rd.month:02d}"

    q = select(Opportunity).where(Opportunity.stage_name.isnot(None))
    r = await db.execute(q)
    all_opps = [o for o in r.scalars().all() if not _is_excluded_from_bookings_nb_only(o, _effective_record_type(o))]
    renewal_opps = [o for o in all_opps if _is_renewal_record_type(_effective_record_type(o))]

    stages_set: set[str] = set()
    available_months_set: set[str] = set()
    for o in renewal_opps:
        stages_set.add((o.stage_name or "—").strip() or "—")
        mk = _renewal_month_key(o)
        if mk:
            available_months_set.add(mk)

    filter_stages = {(s or "").strip().lower() for s in (stage or [])}
    filter_months = set(months) if months else None
    filter_midterm: Optional[set[str]] = None
    if midterm:
        fm = {(m or "").strip().lower() for m in midterm if (m or "").strip()}
        if fm:
            filter_midterm = fm

    def _keep_stage(o: Opportunity) -> bool:
        if not filter_stages:
            return True
        return ((o.stage_name or "").strip().lower() or "—") in filter_stages

    def _keep_month(o: Opportunity) -> bool:
        if not filter_months:
            return True
        mk = _renewal_month_key(o)
        return mk is not None and mk in filter_months

    def _keep_midterm(o: Opportunity) -> bool:
        if not filter_midterm:
            return True
        if filter_midterm >= {"yes", "no"}:
            return True
        is_yes = getattr(o, "midterm_cancellation", 0) == 1
        if "yes" in filter_midterm and is_yes:
            return True
        if "no" in filter_midterm and not is_yes:
            return True
        return False

    rows_out: list[RenewalsOverviewRow] = []
    for o in renewal_opps:
        if not _keep_stage(o) or not _keep_month(o) or not _keep_midterm(o):
            continue
        st = (o.stage_name or "").strip()
        renewal_dt = o.renewal_date if o.renewal_date is not None else o.close_date
        renewal_iso = renewal_dt.isoformat() if renewal_dt else None

        if o.original_acv is not None:
            up = round(float(o.original_acv), 2)
        else:
            up = None

        renewed: Optional[float] = None
        delta: Optional[float] = None
        if _is_closed_lost_stage(st):
            renewed = 0.0
            if up is not None:
                delta = round(renewed - up, 2)
        elif _is_closed_won_stage(st):
            if o.opportunity_arr is not None:
                renewed = round(float(o.opportunity_arr), 2)
            if up is not None and renewed is not None:
                delta = round(renewed - up, 2)

        midterm_after = "Yes" if getattr(o, "midterm_cancellation", 0) == 1 else None

        rows_out.append(
            RenewalsOverviewRow(
                account_id=o.account_id,
                account_name=o.account_name or "—",
                opportunity_sf_id=o.sf_id,
                opportunity_name=o.name or "—",
                stage_name=st or "—",
                forecast_category=(o.forecast_category or "").strip() or None,
                renewal_date=renewal_iso,
                midterm_cancellation_after_stage=midterm_after,
                up_for_renewal_arr=up,
                renewed_arr=renewed,
                delta=delta,
            )
        )

    def _sort_key(rw: RenewalsOverviewRow):
        d = date.fromisoformat(rw.renewal_date) if rw.renewal_date else date.min
        return (-d.toordinal(), rw.account_name or "", rw.opportunity_name or "")

    rows_out.sort(key=_sort_key)

    grand_up = round(sum(float(r.up_for_renewal_arr) for r in rows_out if r.up_for_renewal_arr is not None), 2)
    grand_renewed = round(sum(float(r.renewed_arr) for r in rows_out if r.renewed_arr is not None), 2)
    grand_delta = round(sum(float(r.delta) for r in rows_out if r.delta is not None), 2)

    base = os.getenv("SALESFORCE_BASE_URL", "").strip().rstrip("/")
    sf_url: Optional[str] = None
    if base and ("salesforce.com" in base or "lightning.force.com" in base):
        sf_url = base

    renewals_chart = _build_renewals_chart_series(renewal_opps)

    return RenewalsOverviewResponse(
        rows=rows_out,
        grand_up_for_renewal_arr=grand_up,
        grand_renewed_arr=grand_renewed,
        grand_delta=grand_delta,
        stages=sorted(stages_set),
        available_months=sorted(available_months_set, reverse=True),
        renewals_chart=renewals_chart,
        salesforce_base_url=sf_url,
    )


@app.get("/api/manual-overwrites")
async def list_manual_overwrites(db: AsyncSession = Depends(get_db)):
    """List all manual overrides (log): record-type overrides and Active ARR account overrides."""
    q_rt = select(OpportunityRecordTypeOverride).order_by(OpportunityRecordTypeOverride.created_at.desc())
    r_rt = await db.execute(q_rt)
    rt_rows = r_rt.scalars().all()
    q_arr = select(ActiveARRAccountOverride).order_by(ActiveARRAccountOverride.created_at.desc())
    r_arr = await db.execute(q_arr)
    arr_rows = r_arr.scalars().all()
    return {
        "record_type_overrides": [
            {
                "opportunity_sf_id": row.opportunity_sf_id,
                "record_type_name": row.record_type_name,
                "note": row.note,
                "created_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in rt_rows
        ],
        "active_arr_overrides": [
            {
                "account_name": row.account_name,
                "use_open_renewal_arr": bool(row.use_open_renewal_arr),
                "note": row.note,
                "created_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in arr_rows
        ],
    }


@app.post("/api/manual-overwrites")
async def create_manual_overwrite(
    db: AsyncSession = Depends(get_db),
    opportunity_sf_id: str = Query(..., description="18-digit Salesforce Opportunity Id"),
    record_type_name: str = Query(..., description="Override record type, e.g. Amendment"),
    note: Optional[str] = Query(None, description="Optional note for the log"),
):
    """Add or update a manual record-type override for an opportunity."""
    opportunity_sf_id = (opportunity_sf_id or "").strip()
    record_type_name = (record_type_name or "").strip() or "—"
    if not opportunity_sf_id:
        raise HTTPException(status_code=400, detail="opportunity_sf_id is required")
    existing = await db.execute(
        select(OpportunityRecordTypeOverride).where(
            OpportunityRecordTypeOverride.opportunity_sf_id == opportunity_sf_id
        )
    )
    row = existing.scalars().one_or_none()
    if row:
        row.record_type_name = record_type_name
        row.note = (note or "").strip() or None
    else:
        db.add(OpportunityRecordTypeOverride(
            opportunity_sf_id=opportunity_sf_id,
            record_type_name=record_type_name,
            note=(note or "").strip() or None,
        ))
    await db.commit()
    return {"ok": True, "opportunity_sf_id": opportunity_sf_id, "record_type_name": record_type_name}


@app.delete("/api/manual-overwrites/{opportunity_sf_id}")
async def delete_manual_overwrite(
    opportunity_sf_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Remove the manual record-type override for an opportunity."""
    r = await db.execute(
        select(OpportunityRecordTypeOverride).where(
            OpportunityRecordTypeOverride.opportunity_sf_id == opportunity_sf_id.strip()
        )
    )
    row = r.scalars().one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Override not found")
    await db.delete(row)
    await db.commit()
    return {"ok": True, "opportunity_sf_id": opportunity_sf_id}


@app.get("/api/arr-schedule/active-arr-overrides")
async def list_active_arr_overrides(db: AsyncSession = Depends(get_db)):
    """List all Active ARR account overrides (accounts where Active ARR = open renewal ARR)."""
    q = select(ActiveARRAccountOverride).where(ActiveARRAccountOverride.use_open_renewal_arr == 1)
    r = await db.execute(q)
    rows = r.scalars().all()
    return {
        "active_arr_overrides": [
            {
                "account_name": row.account_name,
                "use_open_renewal_arr": bool(row.use_open_renewal_arr),
                "note": row.note,
                "created_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in rows
        ],
        "count": len(rows),
    }


@app.post("/api/arr-schedule/active-arr-overrides")
async def create_active_arr_override(
    db: AsyncSession = Depends(get_db),
    account_name: str = Query(..., description="Account name"),
    note: Optional[str] = Query(None, description="Optional note for the log"),
):
    """Add or update an Active ARR account override: for this account, Active ARR = open renewal ARR."""
    account_name = (account_name or "").strip()
    if not account_name:
        raise HTTPException(status_code=400, detail="account_name is required")
    r = await db.execute(
        select(ActiveARRAccountOverride).where(
            func.lower(ActiveARRAccountOverride.account_name) == account_name.lower()
        )
    )
    row = r.scalar_one_or_none()
    if row:
        row.use_open_renewal_arr = 1
        row.note = (note or "").strip() or None
    else:
        db.add(ActiveARRAccountOverride(
            account_name=account_name,
            use_open_renewal_arr=1,
            note=(note or "").strip() or None,
        ))
    await db.commit()
    return {"ok": True, "account_name": account_name, "use_open_renewal_arr": True}


@app.delete("/api/arr-schedule/active-arr-overrides/{account_name:path}")
async def delete_active_arr_override(
    account_name: str,
    db: AsyncSession = Depends(get_db),
):
    """Remove the Active ARR override for an account."""
    r = await db.execute(
        select(ActiveARRAccountOverride).where(
            func.lower(ActiveARRAccountOverride.account_name) == account_name.strip().lower()
        )
    )
    row = r.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Override not found")
    await db.delete(row)
    await db.commit()
    return {"ok": True, "account_name": account_name}


def _collect_route_paths(routes) -> list[str]:
    """Flatten Starlette/FastAPI route trees so nested routers (e.g. Mount) appear in debug output."""
    out: list[str] = []
    for r in routes:
        p = getattr(r, "path", None)
        if p:
            out.append(p)
        sub = getattr(r, "routes", None)
        if sub:
            out.extend(_collect_route_paths(sub))
    return out


@app.get("/api/debug/routes")
async def debug_routes():
    """Return list of registered route paths (for debugging 404s) and whether app password is required."""
    paths = _collect_route_paths(app.routes)
    return {
        "paths": sorted(set(p for p in paths if p)),
        "dashboard_routes": [p for p in paths if p and "dashboard" in p],
        "app_password_required": bool(APP_PASSWORD),
        "source": "backend/.env or APP_PASSWORD env var; if both unset, no password required",
    }


@app.get("/api/debug/app-password-status")
async def debug_app_password_status():
    """
    No auth required. Shows whether the backend requires an app password (so you can confirm .env vs what you type).
    Does not reveal the actual password.
    """
    return {
        "app_password_required": bool(APP_PASSWORD),
        "source": "backend/.env or APP_PASSWORD env var; if both unset, no password required",
    }


@app.get("/api/debug/arr-mrr-source")
async def debug_arr_mrr_source(db: AsyncSession = Depends(get_db)):
    """
    No auth. Shows whether USE_UNIT_PRICE_TIMES_QUANTITY_AS_MRR is active and current Active ARR for Prosperity Haven
    (so you can confirm .env is loaded and the Schedule will use UnitPrice×Quantity).
    """
    raw_env = os.getenv("USE_UNIT_PRICE_TIMES_QUANTITY_AS_MRR", "")
    use_uq = _use_unit_price_times_quantity_as_mrr()
    # Get Active ARR for Prosperity Haven from the same logic as the Schedule
    rows, _ = await _compute_active_arr_rows(db, apply_alleva_retained_arr_adjustment=True)
    ph = next((r for r in rows if (r.get("account_name") or "").strip().lower() == "prosperity haven"), None)
    return {
        "USE_UNIT_PRICE_TIMES_QUANTITY_AS_MRR_env_raw": raw_env,
        "USE_UNIT_PRICE_TIMES_QUANTITY_AS_MRR_active": use_uq,
        "prosperity_haven_active_arr": round(ph["active_arr"], 2) if ph else None,
        "expected_if_uq_used": 12696.0,
    }


@app.post("/api/debug/remove-ascension-ascend-overrides")
async def debug_remove_ascension_ascend_overrides(db: AsyncSession = Depends(get_db)):
    """
    Run the same cleanup as on startup: remove Ascension and Ascend Active ARR overrides and record-type (Amendment) overrides from the DB.
    Use this on the deployed backend to clear overrides without restarting (so Contracted ARR and dashboard match local).
    """
    r = await db.execute(select(ActiveARRAccountOverride))
    rows = r.scalars().all()
    removed_arr = 0
    for row in rows:
        name_lower = (row.account_name or "").strip().lower()
        if name_lower == "ascension recovery services" or "ascend" in name_lower:
            await db.delete(row)
            removed_arr += 1
    # Record-type: find opps by account name pattern (ascension/ascend), then delete overrides for those sf_ids
    q_opps = select(Opportunity.sf_id).where(
        or_(
            func.lower(Opportunity.account_name).like("%ascension%"),
            func.lower(Opportunity.account_name).like("%ascend%"),
        )
    )
    r_opps = await db.execute(q_opps)
    target_sf_ids = set((row[0] or "").strip() for row in r_opps.all() if (row[0] or "").strip())
    expand = set(target_sf_ids)
    for i in target_sf_ids:
        if len(i) == 18:
            expand.add(i[:15])
    target_sf_ids = expand
    removed_rt = 0
    if target_sf_ids:
        q_rt = select(OpportunityRecordTypeOverride)
        r_rt = await db.execute(q_rt)
        for row in r_rt.scalars().all():
            sf_id = (row.opportunity_sf_id or "").strip()
            if sf_id in target_sf_ids or (len(sf_id) == 18 and sf_id[:15] in target_sf_ids):
                await db.delete(row)
                removed_rt += 1
    await db.commit()
    return {"ok": True, "removed_active_arr_overrides": removed_arr, "removed_record_type_overrides": removed_rt}


@app.get("/api/debug/ascension-ascend-override-status")
async def debug_ascension_ascend_override_status(db: AsyncSession = Depends(get_db)):
    """
    No auth. Shows whether any Ascension or Ascend overrides still exist (Active ARR or record-type).
    Use on deployed backend to verify cleanup ran. If you see any listed, call POST /api/debug/remove-ascension-ascend-overrides.
    """
    r_arr = await db.execute(select(ActiveARRAccountOverride))
    arr_rows = [row for row in r_arr.scalars().all() if _is_ascension_or_ascend_account(row.account_name)]
    q_rt = select(OpportunityRecordTypeOverride)
    r_rt = await db.execute(q_rt)
    rt_all = r_rt.scalars().all()
    opp_sf_ids = list({(o.opportunity_sf_id or "").strip() for o in rt_all if (o.opportunity_sf_id or "").strip()})
    expand = list(opp_sf_ids)
    for i in opp_sf_ids:
        if len(i) == 18:
            expand.append(i[:15])
    opps = {}
    if expand:
        q_opps = select(Opportunity).where(Opportunity.sf_id.in_(set(expand)))
        r_opps = await db.execute(q_opps)
        for o in r_opps.scalars().all():
            k = (o.sf_id or "").strip()
            opps[k] = o
            if len(k) == 18:
                opps[k[:15]] = o
    rt_rows = []
    for row in rt_all:
        sf_id = (row.opportunity_sf_id or "").strip()
        opp = opps.get(sf_id)
        if opp and _is_ascension_or_ascend_account(opp.account_name):
            rt_rows.append({"opportunity_sf_id": sf_id, "account_name": opp.account_name, "record_type_name": row.record_type_name})
    return {
        "active_arr_overrides": [{"account_name": r.account_name} for r in arr_rows],
        "record_type_overrides": rt_rows,
        "message": "Empty lists mean cleanup has run. If not empty, call POST /api/debug/remove-ascension-ascend-overrides (with X-App-Password).",
    }


@app.get("/api/debug/renewal-date-config")
async def debug_renewal_date_config(db: AsyncSession = Depends(get_db)):
    """
    Debug: check if SALESFORCE_RENEWAL_DATE_FIELD is set and how many opportunities have renewal_date populated.
    Call after adding the variable and running Sync to verify it worked.
    """
    configured = bool(_SALESFORCE_RENEWAL_DATE_FIELD)
    field_name = _SALESFORCE_RENEWAL_DATE_FIELD or "(not set)"
    q_total = select(func.count(Opportunity.id))
    r_total = await db.execute(q_total)
    total = r_total.scalar() or 0
    q_with_date = select(func.count(Opportunity.id)).where(Opportunity.renewal_date.isnot(None))
    r_with = await db.execute(q_with_date)
    with_date = r_with.scalar() or 0
    return {
        "renewal_date_field_configured": configured,
        "renewal_date_field_name": field_name,
        "opportunities_total": total,
        "opportunities_with_renewal_date": with_date,
        "hint": "Set SALESFORCE_RENEWAL_DATE_FIELD (e.g. Renewal_Date__c) in Railway, redeploy/restart, then Sync from Salesforce."
    }


@app.get("/api/debug/salesforce-opportunity-fields")
async def debug_salesforce_opportunity_fields():
    """
    Debug: run the same Opportunity SOQL used for sync and return the first record's keys and ACV-related values.
    Use to verify the exact API name of Original ACV (e.g. namespaced or different casing).
    """
    from connectors.salesforce import SalesforceConnector

    try:
        connector = SalesforceConnector()
        if not connector.is_configured():
            return {"error": "Salesforce not configured (SALESFORCE_USERNAME/PASSWORD)."}
        soql = DEFAULT_OPPORTUNITY_SOQL
        opp_records = await _salesforce_query_with_retry(connector, soql)
        if not opp_records:
            return {"soql": soql, "record_count": 0, "message": "No opportunities returned."}
        rec = opp_records[0]
        all_keys = sorted(rec.keys())
        acv_like = {k: rec.get(k) for k in all_keys if "acv" in (k or "").lower() or "original" in (k or "").lower()}
        renewal_like = {k: rec.get(k) for k in all_keys if "renewal" in (k or "").lower() or "renewal_date" in (k or "").lower()}
        return {
            "soql": soql,
            "record_count": len(opp_records),
            "first_record_keys": all_keys,
            "acv_related_fields": acv_like,
            "renewal_related_fields": renewal_like,
            "configured_expansion_field": _SALESFORCE_EXPANSION_ARR_FIELD,
            "server_main_file": __file__,
            "configured_ufr_field": _SALESFORCE_UFR_ARR_FIELD,
            "configured_renewal_date_field": _SALESFORCE_RENEWAL_DATE_FIELD or "(not set)",
        }
    except Exception as e:
        return {"error": str(e)}


@app.get("/api/debug/renewal-line-items")
async def debug_renewal_line_items(
    db: AsyncSession = Depends(get_db),
    account_name: Optional[str] = Query(None, description="Filter by account name (contains, case-insensitive)"),
    opportunity_sf_id: Optional[str] = Query(None, description="Specific opportunity Salesforce Id"),
):
    """
    Debug: list line items for renewal opportunity/opportunities and show whether each is included in ARR.
    Use ?account_name=Sierra or ?opportunity_sf_id=xxx to inspect why ARR might be wrong.
    """
    q = select(Opportunity).where(Opportunity.record_type_name.isnot(None))
    r = await db.execute(q)
    renewal_opps = [o for o in r.scalars().all() if _is_renewal_record_type(o.record_type_name)]
    if account_name:
        want = (account_name or "").strip().lower()
        renewal_opps = [o for o in renewal_opps if (o.account_name or "").lower().find(want) >= 0]
    if opportunity_sf_id:
        renewal_opps = [o for o in renewal_opps if o.sf_id == opportunity_sf_id.strip()]
    if not renewal_opps:
        return {"opportunities": [], "message": "No renewal opportunities matched."}
    sf_ids = {o.sf_id for o in renewal_opps}
    arr_by_opp = await _compute_arr_from_line_items(db, sf_ids)
    q_li = select(OpportunityLineItem).where(OpportunityLineItem.opportunity_sf_id.in_(sf_ids))
    r_li = await db.execute(q_li)
    line_items = r_li.scalars().all()
    by_opp: dict[str, list] = {sf_id: [] for sf_id in sf_ids}
    for li in line_items:
        raw = _normalized_product_name(li.product_name)
        included = _include_line_item_in_arr(raw, li.product_name)
        canonical = _match_arr_product(raw) or _match_arr_product(li.product_name)
        arr_contribution = (_line_item_effective_total(li) * ARR_MULTIPLIER) if included else 0
        by_opp.setdefault(li.opportunity_sf_id, []).append({
            "product_name": li.product_name,
            "unit_price": li.unit_price,
            "quantity": li.quantity,
            "unit_price_times_quantity": round((float(li.unit_price or 0) * float(li.quantity or 0)), 2),
            "total_price": li.total_price,
            "normalized": raw,
            "canonical": canonical,
            "included": included,
            "arr_contribution": round(arr_contribution, 2),
        })
    opportunities = []
    for o in renewal_opps:
        opportunities.append({
            "sf_id": o.sf_id,
            "name": o.name,
            "account_name": o.account_name,
            "stage_name": o.stage_name,
            "arr_from_line_items": arr_by_opp.get(o.sf_id, 0),
            "line_items": by_opp.get(o.sf_id, []),
        })
    return {"opportunities": opportunities}


@app.get("/api/debug/renewal-arr-for-account")
async def debug_renewal_arr_for_account(
    db: AsyncSession = Depends(get_db),
    account_name: str = Query(..., description="Account name (e.g. Power of Recovery)"),
):
    """
    Get the exact Renewal ARR value for one account and how it's built.
    Renewal ARR = sum of ARR from line items on *open* renewal opportunities only (same logic as Active ARR table).
    Returns the value plus the list of open renewal opps and their line-item ARR (period-weighted when term_months present).
    """
    want = (account_name or "").strip().lower()
    if not want:
        raise HTTPException(status_code=400, detail="account_name is required")
    q_open = select(Opportunity).where(
        Opportunity.stage_name.isnot(None),
        ~Opportunity.stage_name.in_(CLOSED_STAGES),
    )
    r_open = await db.execute(q_open)
    open_opps = r_open.scalars().all()
    overrides = await _get_record_type_overrides(db)

    def _opp_type(o) -> str:
        key = (o.sf_id or "").strip()
        override = overrides.get(key) or (overrides.get(key[:15]) if len(key) >= 15 else None)
        return (override or o.record_type_name or "").strip() or "—"

    open_renewal_opps = [o for o in open_opps if _is_renewal_record_type(_opp_type(o))]
    account_renewals = [o for o in open_renewal_opps if (o.account_name or "").lower().find(want) >= 0]
    if not account_renewals:
        return {
            "account_name_filter": account_name,
            "renewal_arr": 0.0,
            "message": "No open renewal opportunities found for this account.",
            "opportunities": [],
        }
    sf_ids = {o.sf_id for o in account_renewals}
    q_li = select(OpportunityLineItem).where(OpportunityLineItem.opportunity_sf_id.in_(sf_ids))
    r_li = await db.execute(q_li)
    lines = r_li.scalars().all()
    contributions = _line_items_to_arr_by_group(lines)
    renewal_arr = 0.0
    by_opp: dict[str, float] = {}
    for opp_sf_id, canonical, arr in contributions:
        if opp_sf_id in sf_ids:
            renewal_arr += arr
            by_opp[opp_sf_id] = by_opp.get(opp_sf_id, 0) + arr
    opportunities = []
    for o in account_renewals:
        opportunities.append({
            "sf_id": o.sf_id,
            "name": o.name,
            "stage_name": o.stage_name,
            "close_date": o.close_date.isoformat() if o.close_date else None,
            "arr_from_line_items": round(by_opp.get(o.sf_id, 0), 2),
        })
    return {
        "account_name_filter": account_name,
        "renewal_arr": round(renewal_arr, 2),
        "opportunities": opportunities,
        "note": "Same value as the 'Renewal ARR' column for this account in the Active ARR table.",
    }


@app.get("/api/debug/opportunities-for-account")
async def debug_opportunities_for_account(
    db: AsyncSession = Depends(get_db),
    account_name: str = Query(..., description="Account name"),
):
    """
    List all synced opportunities for an account (name contains, case-insensitive).
    Use to verify which opps we have and their record_type_name/stage — e.g. why an expected anchor isn't picked.
    """
    want = (account_name or "").strip().lower()
    if not want:
        raise HTTPException(status_code=400, detail="account_name is required")
    q = select(Opportunity).where(
        func.lower(Opportunity.account_name).contains(want)
    ).order_by(Opportunity.close_date.desc().nullslast(), Opportunity.id.desc())
    r = await db.execute(q)
    opps = r.scalars().all()
    return {
        "account_name_filter": account_name,
        "count": len(opps),
        "opportunities": [
            {
                "sf_id": o.sf_id,
                "name": o.name,
                "close_date": o.close_date.isoformat() if o.close_date else None,
                "stage_name": o.stage_name,
                "record_type_name": o.record_type_name,
                "account_id": o.account_id,
                "account_name": o.account_name,
            }
            for o in opps
        ],
    }


@app.get("/api/debug/active-arr-math-for-account")
async def debug_active_arr_math_for_account(
    db: AsyncSession = Depends(get_db),
    account_name: str = Query(..., description="Account name (e.g. Eosis)"),
):
    """
    Show the math for Active ARR for one account: anchor opportunity, subscription dates,
    each product group's line items (monthly, term_months, term×monthly), period-weighted formula, and total.
    Uses the same account-filtered opportunities as opportunities-for-account and applies closed-won in Python
    so we don't miss opps due to DB/SQL stage formatting.
    """
    want = (account_name or "").strip().lower()
    if not want:
        raise HTTPException(status_code=400, detail="account_name is required")

    overrides = await _get_record_type_overrides(db)

    def _opp_type(o) -> str:
        key = (o.sf_id or "").strip()
        override = overrides.get(key) or (overrides.get(key[:15]) if len(key) >= 15 else None)
        return (override or o.record_type_name or "").strip() or "—"

    def _is_renewal(o) -> bool:
        return _is_renewal_record_type(_opp_type(o))

    def _is_nb(o) -> bool:
        return _is_new_business_record_type(_opp_type(o))

    def _is_expansion(o) -> bool:
        return _is_expansion_record_type(_opp_type(o))

    # Load opportunities for this account: by name contains, then also by account_id so we don't miss opps with null account_name
    q = select(Opportunity).where(
        func.lower(Opportunity.account_name).contains(want)
    ).order_by(Opportunity.close_date.desc().nullslast(), Opportunity.id.desc())
    r = await db.execute(q)
    opps_for_account = list(r.scalars().all())
    account_ids_from_name = {o.account_id for o in opps_for_account if o.account_id}
    if account_ids_from_name:
        q2 = select(Opportunity).where(Opportunity.account_id.in_(account_ids_from_name))
        r2 = await db.execute(q2)
        extra = [o for o in r2.scalars().all() if o not in opps_for_account]
        opps_for_account.extend(extra)
        opps_for_account.sort(key=lambda o: (o.close_date or date.min, o.id or 0), reverse=True)
    closed_won_opps = [o for o in opps_for_account if _is_closed_won_stage(o.stage_name)]
    open_opps = [
        o for o in opps_for_account
        if (o.stage_name or "").strip().lower() not in ("closed won", "closed lost")
    ]

    account_keys = set()
    for o in closed_won_opps:
        if _is_renewal(o) or _is_nb(o):
            account_keys.add((o.account_id, o.account_name or None))
    for o in open_opps:
        if _is_renewal(o):
            account_keys.add((o.account_id, o.account_name or None))

    matching_keys = [k for k in account_keys if (k[1] or "").lower().find(want) >= 0]
    if not matching_keys:
        return {
            "account_name_filter": account_name,
            "message": "No account in Active ARR table matches this name.",
            "anchor": None,
            "subscription_start_date": None,
            "subscription_end_date": None,
            "note": None,
            "product_groups": [],
            "active_arr": 0.0,
        }
    # When multiple keys match (e.g. duplicate Account records with same name), pick the one with the most recent anchor
    best_key = None
    best_anchor_close: date = date.min
    for k in matching_keys:
        cw_k = [o for o in closed_won_opps if (o.account_id, o.account_name or None) == k]
        open_k = [o for o in open_opps if (o.account_id, o.account_name or None) == k]
        closed_r_nb_k = [o for o in cw_k if _is_renewal(o) or _is_nb(o)]
        open_r_k = [o for o in open_k if _is_renewal(o)]
        anchor_close = date.min
        if closed_r_nb_k:
            anch = max(closed_r_nb_k, key=lambda o: o.close_date or date.min)
            anchor_close = anch.close_date or date.min
        elif open_r_k:
            anch = max(open_r_k, key=lambda o: o.close_date or date.min)
            anchor_close = anch.close_date or date.min
        if anchor_close > best_anchor_close:
            best_anchor_close = anchor_close
            best_key = k
    key = best_key if best_key is not None else matching_keys[0]
    aid, aname = key

    cw_for_account = [o for o in closed_won_opps if (o.account_id, o.account_name or None) == key]
    open_for_account = [o for o in open_opps if (o.account_id, o.account_name or None) == key]
    closed_renewal_or_nb = [o for o in cw_for_account if _is_renewal(o) or _is_nb(o)]
    closed_expansions = [o for o in cw_for_account if _is_expansion(o)]
    open_renewals = [o for o in open_for_account if _is_renewal(o)]

    anchor = max(closed_renewal_or_nb, key=lambda o: o.close_date or date.min) if closed_renewal_or_nb else None
    included_sf_ids: set[str] = set()
    sub_start: date | None = None
    sub_end: date | None = None
    note: str | None = None
    anchor_opp_info: dict | None = None

    if anchor:
        included_sf_ids = {anchor.sf_id}
        cutoff = anchor.close_date
        if cutoff:
            included_sf_ids |= {o.sf_id for o in closed_expansions if o.close_date and o.close_date > cutoff}
        sub_start = anchor.contract_start_date or anchor.close_date
        sub_end = anchor.contract_end_date or anchor.renewal_date or anchor.close_date
        anchor_opp_info = {
            "sf_id": anchor.sf_id,
            "name": anchor.name,
            "record_type": _opp_type(anchor),
            "stage_name": anchor.stage_name,
            "close_date": anchor.close_date.isoformat() if anchor.close_date else None,
            "expansion_opps_included": [o.name for o in closed_expansions if o.close_date and anchor.close_date and o.close_date > anchor.close_date],
        }
    elif open_renewals:
        open_anchor = max(open_renewals, key=lambda o: o.close_date or date.min)
        included_sf_ids = {open_anchor.sf_id}
        sub_end = open_anchor.close_date
        note = "ren only"
        anchor_opp_info = {
            "sf_id": open_anchor.sf_id,
            "name": open_anchor.name,
            "record_type": _opp_type(open_anchor),
            "stage_name": open_anchor.stage_name,
            "close_date": open_anchor.close_date.isoformat() if open_anchor.close_date else None,
            "expansion_opps_included": [],
        }
    else:
        return {
            "account_name_filter": account_name,
            "account_name": aname or "—",
            "message": "Account has no closed renewal/NB and no open renewal.",
            "anchor": None,
            "subscription_start_date": None,
            "subscription_end_date": None,
            "note": "No closed renewal/NB; no open renewal",
            "product_groups": [],
            "active_arr": 0.0,
        }

    # Midterm cancellation: if this account has a Closed Lost renewal with Midterm Cancellation = true, subscription end = that opp's contract_end_date
    closed_lost_midterm = [
        o for o in opps_for_account
        if (o.stage_name or "").strip().lower() == "closed lost"
        and getattr(o, "midterm_cancellation", 0) == 1
        and _is_renewal(o)
        and (o.account_id, o.account_name or None) == key
        and o.contract_end_date is not None
    ]
    if closed_lost_midterm:
        best = max(closed_lost_midterm, key=lambda o: o.close_date or date.min)
        sub_end = best.contract_end_date

    if not included_sf_ids:
        return {
            "account_name_filter": account_name,
            "account_name": aname or "—",
            "anchor": anchor_opp_info,
            "subscription_start_date": sub_start.isoformat() if sub_start else None,
            "subscription_end_date": sub_end.isoformat() if sub_end else None,
            "note": note,
            "product_groups": [],
            "active_arr": 0.0,
        }

    q_li = select(OpportunityLineItem).where(OpportunityLineItem.opportunity_sf_id.in_(included_sf_ids))
    r_li = await db.execute(q_li)
    lines = r_li.scalars().all()

    # Fallback: when opportunity has no contract start/end, use Dazos CRM Platform line item dates
    if anchor and (anchor.contract_start_date is None or anchor.contract_end_date is None):
        for li in lines:
            if not li.product_name or "dazos crm platform" not in (li.product_name or "").strip().lower():
                continue
            if anchor.contract_start_date is None and li.service_start_date is not None:
                sub_start = li.service_start_date
            if anchor.contract_end_date is None and li.service_end_date is not None:
                sub_end = li.service_end_date
            if sub_start is not None and sub_end is not None:
                break

    groups: dict[tuple[str, str], list] = {}
    for li in lines:
        raw = _normalized_product_name(li.product_name)
        if not _include_line_item_in_arr(raw, li.product_name):
            continue
        pk = _arr_product_key(raw) or _arr_product_key(li.product_name) or "other"
        k = (li.opportunity_sf_id, pk)
        groups.setdefault(k, []).append(li)

    product_groups = []
    total_arr = 0.0
    opp_id_to_name = {o.sf_id: o.name for o in (cw_for_account + open_for_account)}

    for (opp_sf_id, _pk), items in groups.items():
        canonical = _match_arr_product(items[0].product_name) or _match_arr_product(_normalized_product_name(items[0].product_name)) or "Other"
        arr, segments_math, formula, total_term = _arr_contribution_and_math_for_line_group(items)
        total_arr += arr
        product_groups.append({
            "product": canonical,
            "opportunity_sf_id": opp_sf_id,
            "opportunity_name": opp_id_to_name.get(opp_sf_id),
            "segments": segments_math,
            "formula": formula,
            "total_term_months": round(total_term, 2),
            "arr_contribution": round(arr, 2),
        })

    return {
        "account_name_filter": account_name,
        "account_name": aname or "—",
        "anchor": anchor_opp_info,
        "subscription_start_date": sub_start.isoformat() if sub_start else None,
        "subscription_end_date": sub_end.isoformat() if sub_end else None,
        "note": note,
        "product_groups": product_groups,
        "active_arr": round(total_arr, 2),
        "formula_note": "total_price is monthly (MRR). When term_months present: ARR = (Σ term_i × monthly_i) / (Σ term_i) × 12.",
        "debug": {
            "closed_won_renewal_nb": [
                {"name": o.name, "close_date": o.close_date.isoformat() if o.close_date else None, "stage_name": o.stage_name, "record_type": o.record_type_name, "account_id": o.account_id, "account_name": o.account_name}
                for o in closed_won_opps if _is_renewal(o) or _is_nb(o)
            ],
            "matching_keys_count": len(matching_keys),
            "chosen_key_account_id": aid,
            "chosen_key_account_name": aname,
            "all_opps_loaded": [
                {"name": o.name, "close_date": o.close_date.isoformat() if o.close_date else None, "stage_name": o.stage_name, "stage_name_repr": repr(o.stage_name), "is_closed_won": _is_closed_won_stage(o.stage_name), "record_type": o.record_type_name, "account_id": o.account_id}
                for o in opps_for_account
            ],
        },
    }


@app.get("/api/debug/line-item-term-status")
async def debug_line_item_term_status(db: AsyncSession = Depends(get_db)):
    """
    Check if opportunity line items have term (months) synced — required for correct period-weighted ARR
    (e.g. 3 mo @ $650 + 9 mo @ $1125 → $11,812.50 instead of $10,125).
    Tells you what to set in .env if term is missing.
    """
    q_total = select(func.count(OpportunityLineItem.id))
    r_total = await db.execute(q_total)
    total = r_total.scalar() or 0
    q_with_term = select(func.count(OpportunityLineItem.id)).where(
        OpportunityLineItem.term_months.isnot(None),
        OpportunityLineItem.term_months > 0,
    )
    r_with = await db.execute(q_with_term)
    with_term = r_with.scalar() or 0
    # Sample a few line items that have term and a few that don't (same product name pattern)
    q_sample = select(OpportunityLineItem).limit(50)
    r_sample = await db.execute(q_sample)
    samples = r_sample.scalars().all()
    with_term_sample = [{"product_name": li.product_name, "total_price": li.total_price, "term_months": li.term_months} for li in samples if li.term_months]
    without_term_sample = [{"product_name": li.product_name, "total_price": li.total_price, "term_months": li.term_months} for li in samples if not li.term_months][:5]
    return {
        "line_items_total": total,
        "line_items_with_term": with_term,
        "configured_term_field": _SALESFORCE_LINE_ITEM_TERM_FIELD or "Term__c (tried by default)",
        "sample_with_term": with_term_sample[:5],
        "sample_without_term": without_term_sample,
        "what_to_look_for": (
            "In Salesforce: Setup → Object Manager → Opportunity Product (or Opportunity Line Item) → Fields. "
            "Find the field that stores 'Term (Months)' (the number like 3, 9, 12). Note its API Name (e.g. Term__c or SBQQ__Term__c). "
            "In backend/.env add: SALESFORCE_LINE_ITEM_TERM_FIELD=<that API name> "
            "Then restart the backend and run Sync from the app. After sync, line items will have term_months and ARR will be period-weighted."
        ),
    }


# ----- QuickBooks sync (Phase 1c) -----

QB_REPORT_TYPES = ["pl", "balance_sheet", "cash_flow"]
QB_REPORT_API_NAMES = {"pl": "ProfitAndLoss", "balance_sheet": "BalanceSheet", "cash_flow": "CashFlow"}


@app.post("/api/sync/quickbooks")
async def sync_quickbooks(db: AsyncSession = Depends(get_db)):
    """
    Sync P&L, Balance Sheet, and Cash Flow reports from QuickBooks into the app.
    Requires QB_CLIENT_ID, QB_CLIENT_SECRET, QB_REALM_ID, QB_REFRESH_TOKEN in .env.
    """
    from connectors.quickbooks import QuickBooksConnector

    connector = QuickBooksConnector()
    if not connector.is_configured():
        return {
            "ok": False,
            "error": "QuickBooks not configured. Set QB_CLIENT_ID, QB_CLIENT_SECRET, QB_REALM_ID, QB_REFRESH_TOKEN in backend/.env.",
        }
    synced = {}
    for report_type in QB_REPORT_TYPES:
        api_name = QB_REPORT_API_NAMES[report_type]
        try:
            data = await asyncio.to_thread(connector.get_report, api_name)
        except Exception as e:
            return {"ok": False, "error": f"QuickBooks {api_name} failed: {e}"}
        snapshot = QuickBooksReportSnapshot(report_type=report_type, data_json=json.dumps(data))
        db.add(snapshot)
        synced[report_type] = True
    await db.commit()
    return {
        "ok": True,
        "synced": list(synced.keys()),
        "message": "P&L, Balance Sheet, and Cash Flow synced from QuickBooks.",
    }


@app.get("/api/quickbooks/reports/{report_type}")
async def get_quickbooks_report(
    report_type: str,
    db: AsyncSession = Depends(get_db),
):
    """Return the latest QuickBooks report snapshot. report_type: pl, balance_sheet, or cash_flow."""
    if report_type not in QB_REPORT_TYPES:
        return {"error": f"report_type must be one of: {', '.join(QB_REPORT_TYPES)}"}
    r = await db.execute(
        select(QuickBooksReportSnapshot)
        .where(QuickBooksReportSnapshot.report_type == report_type)
        .order_by(QuickBooksReportSnapshot.as_of.desc())
        .limit(1)
    )
    row = r.scalar_one_or_none()
    if not row:
        return {"report_type": report_type, "as_of": None, "data": None, "message": "No snapshot yet. Run POST /api/sync/quickbooks first."}
    data = json.loads(row.data_json) if row.data_json else None
    return {"report_type": report_type, "as_of": row.as_of.isoformat() if row.as_of else None, "data": data}


# ----- Chargebee sync (billing reconciliation) -----

CHARGEBEE_REPORT_TYPES = ["subscriptions", "invoices", "cash_invoices", "cash_payments"]


async def _sync_chargebee_snapshots(db: AsyncSession) -> dict:
    """Store list API pages + full cash-window invoices/payments for dashboard (SQLite reads)."""
    from connectors.chargebee import ChargebeeConnector

    connector = ChargebeeConnector()
    if not connector.is_configured():
        return {"ok": False, "error": "Chargebee not configured."}
    synced: dict[str, Any] = {}
    for report_type in ("subscriptions", "invoices"):
        try:
            if report_type == "subscriptions":
                data = await asyncio.to_thread(connector.list_subscriptions, limit=100)
            else:
                data = await asyncio.to_thread(connector.list_invoices, limit=100)
        except Exception as e:
            return {"ok": False, "error": f"Chargebee {report_type} failed: {e}"}
        snapshot = ChargebeeSnapshot(report_type=report_type, data_json=json.dumps(data))
        db.add(snapshot)
        synced[report_type] = len(data.get("list") or [])

    now_est = datetime.now(EST)
    start_ts, end_ts = _chargebee_cash_fetch_bounds(now_est)
    try:
        cash_invoices = await asyncio.to_thread(
            connector.fetch_invoices_in_date_range,
            start_ts,
            end_ts + 86400,
        )
    except Exception as e:
        return {"ok": False, "error": f"Chargebee cash_invoices failed: {e}"}
    db.add(
        ChargebeeSnapshot(
            report_type="cash_invoices",
            data_json=json.dumps(
                {
                    "invoices": cash_invoices,
                    "window_start_ts": start_ts,
                    "window_end_ts": end_ts,
                }
            ),
        )
    )
    synced["cash_invoices"] = len(cash_invoices)

    try:
        cash_payments = await asyncio.to_thread(
            connector.fetch_payments_in_date_range,
            start_ts,
            end_ts + 86400,
        )
    except Exception as e:
        return {"ok": False, "error": f"Chargebee cash_payments failed: {e}"}
    db.add(
        ChargebeeSnapshot(
            report_type="cash_payments",
            data_json=json.dumps(
                {
                    "payments": cash_payments,
                    "window_start_ts": start_ts,
                    "window_end_ts": end_ts,
                }
            ),
        )
    )
    synced["cash_payments"] = len(cash_payments)
    await db.commit()
    return {"ok": True, "synced": synced}


@app.post("/api/sync/chargebee")
async def sync_chargebee(db: AsyncSession = Depends(get_db)):
    """
    Sync subscriptions, invoices (first page each), and full cash-window billings/collections into SQLite.
    Requires CHARGEBEE_SITE and CHARGEBEE_API_KEY in .env.
    """
    res = await _sync_chargebee_snapshots(db)
    if not res.get("ok"):
        return {
            "ok": False,
            "error": res.get("error", "Chargebee sync failed."),
        }
    return {
        "ok": True,
        "synced": res.get("synced"),
        "message": "Chargebee synced (list pages + cash billings/collections for dashboard cash KPIs).",
    }


@app.get("/api/chargebee/{report_type}")
async def get_chargebee_snapshot(
    report_type: str,
    db: AsyncSession = Depends(get_db),
):
    """Return the latest Chargebee snapshot. report_type: subscriptions, invoices, cash_invoices, cash_payments."""
    if report_type not in CHARGEBEE_REPORT_TYPES:
        return {"error": f"report_type must be one of: {', '.join(CHARGEBEE_REPORT_TYPES)}"}
    r = await db.execute(
        select(ChargebeeSnapshot)
        .where(ChargebeeSnapshot.report_type == report_type)
        .order_by(ChargebeeSnapshot.as_of.desc())
        .limit(1)
    )
    row = r.scalar_one_or_none()
    if not row:
        return {
            "report_type": report_type,
            "as_of": None,
            "data": None,
            "message": "No snapshot yet. Run POST /api/sync/chargebee first.",
        }
    data = json.loads(row.data_json) if row.data_json else None
    return {"report_type": report_type, "as_of": row.as_of.isoformat() if row.as_of else None, "data": data}


# ----- Unified app dataset refresh (Option B: SQLite tables; single UI entry point on Dashboard) -----


def _dataset_sheet_range_list() -> list[str]:
    """Google Sheet A1 ranges pulled during POST /api/dataset/refresh. Override with env DATASET_SHEET_RANGES=comma-separated."""
    raw = (os.getenv("DATASET_SHEET_RANGES") or "").strip()
    if raw:
        return [x.strip() for x in raw.split(",") if x.strip()]
    return [
        "ARR_Calculations_2026P!A1:ZZ1000",
        "BS_2026P!A1:ZZ1000",
        "OVERVIEW_2026P!A1:ZZ1000",
        "ARR_Schedule!A1:ZZ2000",
    ]


async def _sync_google_sheet_range_session(db: AsyncSession, range_name: str, connector) -> dict:
    """Persist one sheet range; caller supplies a configured GoogleSheetsConnector."""
    try:
        data = await asyncio.to_thread(connector.read_range, range_name)
        data = await asyncio.to_thread(_merge_arr_2026p_bu35_from_direct_cell, connector, range_name, data)
    except Exception as e:
        err_msg = str(e)
        if "403" in err_msg or "does not have permission" in err_msg.lower():
            sa_email = connector.get_service_account_email()
            err_msg = (
                "Google Sheets: permission denied. Share your financial model sheet with the service account as **Editor**: "
                + (sa_email or "see client_email in your JSON key")
                + "."
            )
        elif "404" in err_msg or "Unable to parse range" in err_msg or "not found" in err_msg.lower():
            err_msg = (
                "Google Sheets: could not read range "
                f"\"{range_name}\". Check tab name and GOOGLE_SHEET_ID. Raw: " + err_msg[:200]
            )
        return {"ok": False, "error": err_msg}
    snapshot = SheetSnapshot(source="google_sheets", range_name=range_name, data_json=json.dumps(data))
    db.add(snapshot)
    await db.commit()
    return {"ok": True, "range_name": range_name, "rows": len(data)}


async def _sync_chargebee_session(db: AsyncSession) -> dict:
    """Same Chargebee payload as POST /api/sync/chargebee (used by Refresh app data)."""
    return await _sync_chargebee_snapshots(db)


async def _sync_quickbooks_session(db: AsyncSession) -> dict:
    from connectors.quickbooks import QuickBooksConnector

    connector = QuickBooksConnector()
    if not connector.is_configured():
        return {"ok": False, "error": "QuickBooks not configured."}
    synced = {}
    for report_type in QB_REPORT_TYPES:
        api_name = QB_REPORT_API_NAMES[report_type]
        try:
            data = await asyncio.to_thread(connector.get_report, api_name)
        except Exception as e:
            return {"ok": False, "error": f"QuickBooks {api_name} failed: {e}"}
        snapshot = QuickBooksReportSnapshot(report_type=report_type, data_json=json.dumps(data))
        db.add(snapshot)
        synced[report_type] = True
    await db.commit()
    return {"ok": True, "synced": list(synced.keys())}


async def _persist_app_dataset_state(ok: bool, steps: list, err: Optional[str]) -> None:
    async with AsyncSessionLocal() as db:
        row = await db.get(AppDatasetState, 1)
        if not row:
            row = AppDatasetState(id=1)
            db.add(row)
        row.updated_at = datetime.now(timezone.utc)
        row.last_refresh_ok = 1 if ok else 0
        row.last_error = err
        row.steps_json = json.dumps(steps)
        await db.commit()


async def _refresh_app_dataset() -> dict:
    """
    One pipeline: Salesforce → Google Sheet ranges → Chargebee.
    QuickBooks is not part of this flow; use POST /api/sync/quickbooks when configured.
    Skips optional sources when not configured. Stops on first failure.
    """
    steps: list = []
    async with _dataset_refresh_lock:
        async with AsyncSessionLocal() as db:
            try:
                result = await _run_salesforce_sync(db)
                if not result.get("ok"):
                    await db.rollback()
                    steps.append({"step": "salesforce", "ok": False, "detail": result.get("error")})
                    await _persist_app_dataset_state(False, steps, str(result.get("error")))
                    return {"ok": False, "error": result.get("error"), "steps": steps}
                await db.commit()
                steps.append({
                    "step": "salesforce",
                    "ok": True,
                    "detail": {
                        "synced_accounts": result.get("synced_accounts"),
                        "synced_opportunities": result.get("synced_opportunities"),
                        "synced_line_items": result.get("synced_line_items"),
                    },
                })
            except Exception as e:
                await db.rollback()
                steps.append({"step": "salesforce", "ok": False, "detail": str(e)})
                await _persist_app_dataset_state(False, steps, str(e))
                return {"ok": False, "error": str(e), "steps": steps}

        from connectors.google_sheets import GoogleSheetsConnector

        gs = GoogleSheetsConnector()
        ranges = _dataset_sheet_range_list()
        if not gs.is_configured():
            steps.append({"step": "google_sheet", "ok": True, "detail": "skipped (not configured)"})
        elif not ranges:
            steps.append({"step": "google_sheet", "ok": True, "detail": "skipped (no ranges)"})
        else:
            for range_name in ranges:
                async with AsyncSessionLocal() as db:
                    res = await _sync_google_sheet_range_session(db, range_name, gs)
                    entry = {"step": f"google_sheet:{range_name}", "ok": res.get("ok"), "detail": {k: v for k, v in res.items() if k != "ok"}}
                    steps.append(entry)
                    if not res.get("ok"):
                        await _persist_app_dataset_state(False, steps, res.get("error"))
                        return {"ok": False, "error": res.get("error"), "steps": steps}

        from connectors.chargebee import ChargebeeConnector

        cb = ChargebeeConnector()
        if not cb.is_configured():
            steps.append({"step": "chargebee", "ok": True, "detail": "skipped (not configured)"})
        else:
            async with AsyncSessionLocal() as db:
                res = await _sync_chargebee_session(db)
                steps.append({"step": "chargebee", "ok": res.get("ok"), "detail": res})
                if not res.get("ok"):
                    await _persist_app_dataset_state(False, steps, res.get("error"))
                    return {"ok": False, "error": res.get("error"), "steps": steps}

        # Materialize monthly ARR snapshot (used by /api/arr-bridge)
        async with AsyncSessionLocal() as db:
            arr_res = await _refresh_monthly_arr_snapshot(db)
            steps.append({"step": "monthly_arr_snapshot", "ok": arr_res.get("ok"), "detail": arr_res})
            if not arr_res.get("ok"):
                await _persist_app_dataset_state(False, steps, arr_res.get("error"))
                return {"ok": False, "error": arr_res.get("error"), "steps": steps}

    await _persist_app_dataset_state(True, steps, None)
    return {"ok": True, "steps": steps, "message": "Dataset refresh complete."}


@app.get("/api/dataset/status")
async def get_dataset_status(db: AsyncSession = Depends(get_db)):
    """Last unified refresh time and outcome (Dashboard → Refresh app data)."""
    row = await db.get(AppDatasetState, 1)
    if not row:
        return {
            "updated_at": None,
            "updated_at_utc": None,
            "last_refresh_ok": None,
            "last_error": None,
            "steps": [],
            "message": "No refresh yet. Use Refresh app data on the Dashboard.",
        }
    try:
        await _scrub_legacy_quickbooks_from_dataset_state(db, row)
    except Exception:
        logging.getLogger(__name__).exception("dataset status: primary QuickBooks scrub failed")
    row = await db.get(AppDatasetState, 1)
    if not row:
        return {
            "updated_at": None,
            "updated_at_utc": None,
            "last_refresh_ok": None,
            "last_error": None,
            "steps": [],
            "message": "No refresh yet. Use Refresh app data on the Dashboard.",
        }
    try:
        await _force_clear_quickbooks_dataset_error(db, row)
    except Exception:
        logging.getLogger(__name__).exception("dataset status: force QuickBooks error clear failed")
    row = await db.get(AppDatasetState, 1)
    if not row:
        return {
            "updated_at": None,
            "updated_at_utc": None,
            "last_refresh_ok": None,
            "last_error": None,
            "steps": [],
            "message": "No refresh yet. Use Refresh app data on the Dashboard.",
        }
    st: list = []
    if row.steps_json:
        try:
            st = json.loads(row.steps_json)
        except json.JSONDecodeError:
            st = []
    updated_at_iso: Optional[str] = None
    updated_at_utc: Optional[str] = None
    if row.updated_at:
        u_utc = _app_dataset_updated_at_as_utc(row.updated_at)
        updated_at_iso = u_utc.isoformat().replace("+00:00", "Z")
        updated_at_utc = _format_updated_at_utc_display(row.updated_at)

    return {
        "updated_at": updated_at_iso,
        "updated_at_utc": updated_at_utc,
        "last_refresh_ok": bool(row.last_refresh_ok),
        "last_error": row.last_error,
        "steps": st,
    }


@app.post("/api/dataset/refresh")
async def post_dataset_refresh():
    """
    Refresh app data into SQLite: Salesforce, Google Sheets (DATASET_SHEET_RANGES), Chargebee (each if configured).
    Returns immediately; refresh runs in the background. Poll GET /api/jobs/active to track progress.
    QuickBooks is synced separately via POST /api/sync/quickbooks when ready.
    """
    job_id = f"refresh_{int(time.time())}"
    _bg_job_start(job_id, "dataset_refresh", "Data Refresh")

    async def _run() -> None:
        try:
            result = await _refresh_app_dataset()
            _bg_job_done(job_id, bool(result.get("ok")), result.get("error") or "")
        except Exception as exc:
            _logger.exception("Background dataset refresh failed: %s", exc)
            await _persist_app_dataset_state(False, [{"step": "fatal", "ok": False, "detail": str(exc)}], str(exc))
            _bg_job_done(job_id, False, str(exc))

    asyncio.create_task(_run())
    return {"ok": True, "job_id": job_id, "status": "started", "message": "Data refresh started in background"}


@app.get("/api/jobs/active")
async def get_active_jobs():
    """Return all tracked background jobs (running + recently completed). Frontend polls this to show progress."""
    jobs = sorted(_bg_jobs.values(), key=lambda j: j.get("started_at", ""), reverse=True)
    return {"jobs": jobs[:30]}


# ── Frontend static file serving (production single-service Railway deploy) ──────────────────
# When the frontend is built (`npm run build`), Vite outputs to frontend/dist/.
# We serve those files from FastAPI so the app works on a single Railway service
# without needing VITE_API_URL. All /api/* routes above take priority.
_FRONTEND_DIST = Path(__file__).parent.parent / "frontend" / "dist"

if _FRONTEND_DIST.exists():
    from fastapi.staticfiles import StaticFiles as _StaticFiles
    from fastapi.responses import FileResponse as _FileResponse

    _assets_dir = _FRONTEND_DIST / "assets"
    if _assets_dir.exists():
        app.mount("/assets", _StaticFiles(directory=str(_assets_dir)), name="frontend-assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def _serve_frontend(full_path: str):
        """Catch-all: serve React SPA for any non-API route."""
        # Serve specific files if they exist (favicons, manifest, etc.)
        requested = _FRONTEND_DIST / full_path
        if requested.exists() and requested.is_file():
            return _FileResponse(str(requested))
        return _FileResponse(str(_FRONTEND_DIST / "index.html"))
