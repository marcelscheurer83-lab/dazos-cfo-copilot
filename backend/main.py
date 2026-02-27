"""
Dazos CFO Copilot — FastAPI backend.
Dashboard, P&L, cash flow, budget vs actuals, and Copilot Q&A.
All scheduled times (hourly sync, EOD snapshot) use America/New_York (EST/EDT).
"""
import asyncio
import calendar
import json
import logging
import os
import re
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
from typing import Any, List, Optional

from dotenv import load_dotenv, dotenv_values
from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from sqlalchemy import select, delete, func, or_
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db, AsyncSessionLocal
from models import (
    Company,
    KPI,
    PnLLine,
    CashFlowLine,
    BudgetLine,
    SheetSnapshot,
    Account,
    Opportunity,
    OpportunityLineItem,
    OpportunityRecordTypeOverride,
    ActiveARRAccountOverride,
    QuickBooksReportSnapshot,
    ChargebeeSnapshot,
    SalesforceEODSnapshot,
    ARRScheduleDaily,
    ARRSchedulePeriod,
)
from schemas import (
    KPISummary,
    PnLLineOut,
    CashFlowLineOut,
    BudgetVsActualOut,
    CopilotRequest,
    CopilotResponse,
    DashboardKPI,
    BookingsMTDResponse,
    BookingsMTDRow,
    BookingsPeriod,
    RenewalsMTDResponse,
    CashMTDResponse,
    CashPeriod,
    RenewalsMTDPeriod,
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
load_dotenv(Path(__file__).resolve().parent / ".env")

# App password: read from .env file first; if not set there, use system env (for deployed hosts that set APP_PASSWORD in the environment).
_env_path = Path(__file__).resolve().parent / ".env"
_env_dict = dotenv_values(str(_env_path)) if _env_path.exists() else {}
_app_password_raw = _env_dict.get("APP_PASSWORD") or os.getenv("APP_PASSWORD")
APP_PASSWORD = (_app_password_raw or "").strip().strip('"').strip("'") or None

EST = ZoneInfo("America/New_York")

# One-time cleanup of Ascension/Ascend overrides when active-ARR is first requested (in case lifespan didn't run on deploy).
_ascension_ascend_cleanup_done = False


@asynccontextmanager
async def lifespan(app: FastAPI):
    await seed()
    await _remove_ascension_ascend_overrides()
    await _remove_ascension_ascend_record_type_overrides()
    # Background task: hourly Salesforce sync at :59 EST (ARR + pipeline); daily EOD snapshot at 23:59 EST (for historical ARR + pipeline)
    task = asyncio.create_task(_scheduled_salesforce_jobs())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


app = FastAPI(title="Dazos CFO Copilot API", version="1.0.0", lifespan=lifespan)
_cors_origins = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").strip().split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _cors_origins if o.strip()],
    allow_credentials=True,
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


app.add_middleware(RequireAppPasswordMiddleware)

# Ensure dashboard MTD endpoints never return 500/non-JSON (e.g. if get_db or any dependency fails)
_DASHBOARD_MTD_PATHS = frozenset({"/api/dashboard/renewals-mtd", "/api/dashboard/cash-mtd", "/api/dashboard/bookings-mtd"})
_logger = logging.getLogger(__name__)


@app.exception_handler(Exception)
async def _dashboard_mtd_exception_handler(request: Request, exc: Exception):
    """Catch any unhandled exception for dashboard MTD endpoints and return 200 + JSON so frontend never sees 500/non-JSON."""
    if request.url.path not in _DASHBOARD_MTD_PATHS:
        raise exc
    _logger.exception("Dashboard MTD error for %s: %s", request.url.path, exc)
    msg = f"{type(exc).__name__}: {str(exc)[:120]}"
    if request.url.path == "/api/dashboard/renewals-mtd":
        return JSONResponse(status_code=200, content=_safe_renewals_fallback(msg))
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


@app.get("/api/pnl", response_model=list[PnLLineOut])
async def get_pnl(
    period_end: Optional[date] = Query(None),
    months: int = Query(3, ge=1, le=12),
    db: AsyncSession = Depends(get_db),
):
    q = select(PnLLine).order_by(PnLLine.period_end.desc(), PnLLine.id)
    if period_end:
        q = q.where(PnLLine.period_end <= period_end)
    r = await db.execute(q.limit(500))
    rows = r.scalars().all()
    seen = set()
    by_period = {}
    for row in rows:
        if row.period_end not in by_period:
            by_period[row.period_end] = []
        if len(by_period) > months:
            break
        by_period[row.period_end].append(row)
    out = []
    for period in sorted(by_period.keys(), reverse=True)[:months]:
        for row in by_period[period]:
            out.append(PnLLineOut(period_end=row.period_end, line_type=row.line_type, category=row.category, amount=row.amount, is_subtotal=bool(row.is_subtotal)))
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
    out = [CashFlowLineOut(period_end=row.period_end, section=row.section, category=row.category, amount=row.amount) for row in rows if row.period_end in periods]
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
            answer=f"**Total CARR**{date_note} is **${grand_total:,.0f}** across **{len(rows)}** account(s).",
            sources=[source_label],
        )

    # Largest / biggest / top customer by ARR
    if any(phrase in q_lower for phrase in ("largest customer", "biggest customer", "top customer", "who is our largest", "largest account", "biggest account")):
        if rows:
            top = rows[0]
            name = top.get("account_name") or "—"
            arr = top.get("total_arr") or 0
            return CopilotResponse(
                answer=f"Your **largest customer** by CARR{date_note} is **{name}** with **${arr:,.0f} CARR.**",
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
    except Exception as e:
        return {"ok": False, "error": str(e)}
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
# Optional: Original ACV = ARR up for renewal (UFR ARR), e.g. Original_ACV__c.
_SALESFORCE_UFR_ARR_FIELD = (os.getenv("SALESFORCE_UFR_ARR_FIELD") or "Original_ACV__c").strip() or None
# Optional: Contract Start/End on Opportunity for New Business (e.g. Contract_Start_Date__c, Contract_End_Date__c). Used for subscription start/end in Active ARR.
_SALESFORCE_CONTRACT_START_DATE_FIELD = (os.getenv("SALESFORCE_CONTRACT_START_DATE_FIELD") or "Contract_Start_Date__c").strip() or ""
_SALESFORCE_CONTRACT_END_DATE_FIELD = (os.getenv("SALESFORCE_CONTRACT_END_DATE_FIELD") or "Contract_End_Date__c").strip() or ""
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
    if _SALESFORCE_CONTRACT_START_DATE_FIELD:
        parts.append(_SALESFORCE_CONTRACT_START_DATE_FIELD)
    if _SALESFORCE_CONTRACT_END_DATE_FIELD:
        parts.append(_SALESFORCE_CONTRACT_END_DATE_FIELD)
    return ", " + ", ".join(parts) if parts else ""
DEFAULT_OPPORTUNITY_SOQL = (
    "SELECT Id, Name, Amount, CloseDate, StageName, Type, RecordType.Name, "
    "Account.Id, Account.Name, CreatedDate, " + _SALESFORCE_MRR_FIELD
    + _opp_soql_extra_fields()
    + " FROM Opportunity ORDER BY CloseDate DESC NULLS LAST"
)
# Fallback SOQL without renewal date field (used if that field is invalid in org). Still includes UFR (Original ACV) when set.
DEFAULT_OPPORTUNITY_SOQL_NO_RENEWAL = (
    "SELECT Id, Name, Amount, CloseDate, StageName, Type, RecordType.Name, "
    "Account.Id, Account.Name, CreatedDate, " + _SALESFORCE_MRR_FIELD
    + (", " + _SALESFORCE_UFR_ARR_FIELD if _SALESFORCE_UFR_ARR_FIELD else "")
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
    return (
        "SELECT Id, OpportunityId, Name, Product2.Name, Quantity, UnitPrice, TotalPrice"
        + _line_item_soql_extra_fields(include_try_term=include_optional_term, include_service_dates=include_service_dates)
        + " FROM OpportunityLineItem"
    )

DEFAULT_OPPORTUNITY_LINE_ITEM_SOQL = _line_item_soql(include_optional_term=True, include_service_dates=True)
ARR_MULTIPLIER = 12  # MRR -> ARR
# If set (1/true/yes), TotalPrice is treated as already annual: ARR = sum(TotalPrice). Otherwise ARR = sum(TotalPrice) * 12.
_ARR_TOTAL_PRICE_IS_ANNUAL = os.getenv("ARR_TOTAL_PRICE_IS_ANNUAL", "").strip().lower() in ("1", "true", "yes")
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
    "Premium Support",
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
    """Use total_price for ARR; when 0 or null, use unit_price * quantity (e.g. closed-opp line items from SF)."""
    total = float(li.total_price or 0)
    if total != 0:
        return total
    try:
        return float(li.unit_price or 0) * float(li.quantity or 0)
    except (TypeError, ValueError):
        return 0.0


def _arr_contribution_for_line_group(items: list) -> float:
    """
    ARR for a group of line items (same opp + same product). When term is present (term_months or from service dates):
    ARR = (sum(term_i * monthly_price_i) / sum(term_i)) * 12.
    E.g. 3 mo @ $650 + 21 mo @ $1300 -> (3*650 + 21*1300)/24 * 12 = $14,625.
    When no term/dates: fall back to average monthly price × 12 (so multiple segments don't sum to 2x ARR).
    """
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
        else:
            # No term: treat this line as 12 months so group average is (sum of monthly) / n × 12
            total_revenue += 12 * m
            total_months += 12
    if total_months <= 0:
        return sum(_line_item_effective_total(li) for li in items) * ARR_MULTIPLIER
    return (total_revenue / total_months) * 12


def _arr_contribution_and_math_for_line_group(items: list) -> tuple[float, list[dict], str, float]:
    """
    Same logic as _arr_contribution_for_line_group but returns (arr, segments_math, formula_text, total_term_months).
    segments_math: list of { monthly, term_months, term_times_monthly }.
    """
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


def _line_item_effective_total_dict(li: dict) -> float:
    """Same for line item dict (e.g. from EOD snapshot JSON)."""
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
    "BillingCountry, BillingCity, BillingState, Phone, Website, Segment__c, CreatedDate "
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


def _original_acv_from_record(rec: dict) -> Optional[float]:
    """Get Original ACV from a Salesforce opportunity record. Tries configured key, then Original_ACV__c, then case-insensitive match."""
    candidates = []
    if _SALESFORCE_UFR_ARR_FIELD and rec.get(_SALESFORCE_UFR_ARR_FIELD) is not None:
        candidates.append(rec.get(_SALESFORCE_UFR_ARR_FIELD))
    if rec.get("Original_ACV__c") is not None:
        candidates.append(rec.get("Original_ACV__c"))
    for key, value in rec.items():
        if key and key.lower() == "original_acv__c" and value is not None:
            candidates.append(value)
            break
    for v in candidates:
        out = _float_or_none(v)
        if out is not None:
            return out
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

    try:
        account_records = await _salesforce_query_with_retry(connector, DEFAULT_ACCOUNT_SOQL)
    except Exception as e:
        return {"ok": False, "error": f"Accounts sync failed: {e}"}
    await db.execute(delete(Account))
    for rec in account_records:
        sf_id = rec.get("Id")
        if not sf_id:
            continue
        try:
            employees = int(rec["NumberOfEmployees"]) if rec.get("NumberOfEmployees") is not None else None
        except (TypeError, ValueError):
            employees = None
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
            created_date=_parse_datetime(rec.get("CreatedDate")),
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
        contract_start_dt = _parse_date(rec.get(_SALESFORCE_CONTRACT_START_DATE_FIELD)) if _SALESFORCE_CONTRACT_START_DATE_FIELD else None
        contract_end_dt = _parse_date(rec.get(_SALESFORCE_CONTRACT_END_DATE_FIELD)) if _SALESFORCE_CONTRACT_END_DATE_FIELD else None
        opp = Opportunity(
            sf_id=sf_id,
            name=rec.get("Name"),
            amount=float(rec.get("Amount") or 0),
            close_date=_parse_date(rec.get("CloseDate")),
            renewal_date=renewal_dt,
            original_acv=original_acv_val,
            stage_name=rec.get("StageName"),
            type=rec.get("Type"),
            record_type_name=record_type_name,
            account_id=rec.get("Account_Id"),
            account_name=rec.get("Account_Name"),
            mrr=_float_or_none(rec.get(_SALESFORCE_MRR_FIELD)),
            contract_start_date=contract_start_dt,
            contract_end_date=contract_end_dt,
            created_date=_parse_datetime(rec.get("CreatedDate")),
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
        db.add(OpportunityLineItem(
            opportunity_sf_id=opp_sf_id,
            product_name=product_name,
            quantity=float(rec.get("Quantity") or 0),
            unit_price=float(rec.get("UnitPrice") or 0),
            total_price=total,
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
    msg = "Accounts, opportunities, and opportunity products synced."
    if _SALESFORCE_RENEWAL_DATE_FIELD and not use_renewal_date_field:
        msg += " Renewal Date field not found in Salesforce; renewals use Close Date. Check Setup → Opportunity → Fields for the correct API name, or remove SALESFORCE_RENEWAL_DATE_FIELD from .env."
    return {
        "ok": True,
        "synced_accounts": len(account_records),
        "synced_opportunities": len(opp_records),
        "synced_line_items": len(line_records),
        "line_item_term_field_used": term_field_used,
        "line_item_term_fallback": line_item_term_fallback,
        "renewal_opportunities_count": renewal_count,
        "message": msg,
        "renewal_date_field_used": use_renewal_date_field,
        "renewal_date_field_configured": bool(_SALESFORCE_RENEWAL_DATE_FIELD),
    }


@app.post("/api/sync/salesforce")
async def sync_salesforce(db: AsyncSession = Depends(get_db)):
    """
    Sync opportunities and accounts from Salesforce into the app.
    Requires SALESFORCE_USERNAME, SALESFORCE_PASSWORD, and SALESFORCE_SECURITY_TOKEN in .env.
    """
    try:
        result = await _run_salesforce_sync(db)
        return result
    except Exception as e:
        await db.rollback()
        return JSONResponse(
            status_code=200,
            content={"ok": False, "error": f"Sync failed: {e}"},
        )


@app.get("/api/salesforce/eod-snapshots")
async def list_eod_snapshots(db: AsyncSession = Depends(get_db)):
    """
    List all EOD snapshot dates (for verifying the daily 23:59 EST job on Railway).
    Snapshots are stored in the DB table salesforce_eod_snapshots.
    """
    r = await db.execute(
        select(SalesforceEODSnapshot.snapshot_date, SalesforceEODSnapshot.snapshot_utc)
        .order_by(SalesforceEODSnapshot.snapshot_date.desc())
    )
    rows = r.all()
    return {
        "count": len(rows),
        "snapshots": [{"snapshot_date": d.isoformat(), "snapshot_utc": (t.isoformat() if t else None)} for d, t in rows],
        "message": "EOD snapshots are taken daily at 23:59:59 EST when the backend is running.",
    }


async def _compute_active_arr_rows(db: AsyncSession) -> tuple[list[dict], Optional[str]]:
    """Compute active ARR rows (subscription start/end, ARR per account). Used by active-arr and active-arr-by-month."""
    global _ascension_ascend_cleanup_done
    if not _ascension_ascend_cleanup_done:
        await _remove_ascension_ascend_overrides()
        await _remove_ascension_ascend_record_type_overrides()
        _ascension_ascend_cleanup_done = True
    overrides = await _get_record_type_overrides(db)
    active_arr_use_open_renewal = await _get_active_arr_account_overrides(db)

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

    for key in account_keys:
        cw_for_account = [o for o in closed_won_opps if (o.account_id, o.account_name or None) == key]
        open_for_account = [o for o in open_opps if (o.account_id, o.account_name or None) == key]
        closed_renewal_or_nb = [o for o in cw_for_account if _is_renewal(o) or _is_nb(o)]
        closed_expansions = [o for o in cw_for_account if _is_expansion(o)]
        open_renewals = [o for o in open_for_account if _is_renewal(o)]

        anchor = max(closed_renewal_or_nb, key=lambda o: o.close_date or date.min) if closed_renewal_or_nb else None
        if anchor:
            included = {anchor.sf_id}
            cutoff = anchor.close_date
            if cutoff:
                included |= {o.sf_id for o in closed_expansions if o.close_date and o.close_date > cutoff}
            account_included[key] = included
            account_anchor[key] = anchor.sf_id
            if anchor.contract_start_date is None:
                anchors_missing_start.add(anchor.sf_id)
            if anchor.contract_end_date is None:
                anchors_missing_end.add(anchor.sf_id)
            account_sub_start[key] = anchor.contract_start_date or anchor.close_date
            account_sub_end[key] = anchor.contract_end_date or anchor.renewal_date or anchor.close_date
            account_note[key] = None
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

    all_included_sf_ids = set(opp_to_account_arr.keys())
    q_lines = select(OpportunityLineItem).where(
        OpportunityLineItem.opportunity_sf_id.in_(all_included_sf_ids)
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
    for key in account_keys:
        anchor_sf_id = account_anchor.get(key)
        if not anchor_sf_id:
            continue
        platform = platform_dates_by_opp.get(anchor_sf_id)
        if not platform:
            continue
        if anchor_sf_id in anchors_missing_start and platform[0]:
            account_sub_start[key] = platform[0]
        if anchor_sf_id in anchors_missing_end and platform[1]:
            account_sub_end[key] = platform[1]

    opp_to_arr: dict[str, float] = {}
    for opp_sf_id, _canonical, arr in _line_items_to_arr_by_group(lines):
        opp_to_arr[opp_sf_id] = opp_to_arr.get(opp_sf_id, 0.0) + arr

    all_opps = closed_won_opps + open_opps
    opp_to_close_date: dict[str, date | None] = {o.sf_id: o.close_date for o in all_opps}

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
    if account_ids:
        q_acc = select(Account.sf_id, Account.segment, Account.status).where(Account.sf_id.in_(account_ids))
        r_acc = await db.execute(q_acc)
        for (sf_id, seg, st) in r_acc.all():
            account_segment[sf_id] = seg
            account_status[sf_id] = st

    out_rows = []
    for (aid, aname), by_product in by_account_product.items():
        key = (aid, aname)
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
            # but treat current Contracted ARR and product breakdown as zero.
            total_arr = 0.0
            by_product_arr = {p: 0.0 for p in products}
        sub_start = account_sub_start.get(key)
        sub_end = account_sub_end.get(key)
        note = account_note.get(key)
        out_rows.append({
            "account_id": aid,
            "account_name": aname or "—",
            "status": status,
            "segment": seg,
            "active_arr": total_arr,
            "anchor_arr": anchor_arr,
            "expansions": expansions,
            "by_product": {p: by_product_arr.get(p, 0) for p in products},
            "subscription_start_date": sub_start.isoformat() if sub_start else None,
            "subscription_end_date": sub_end.isoformat() if sub_end else None,
            "note": note,
            "no_new_business": bool(note and (note == "ren only" or "Open renewal only" in (note or ""))),
        })
    base = os.getenv("SALESFORCE_BASE_URL", "").strip().rstrip("/")
    if base and ("salesforce.com" in base or "lightning.force.com" in base):
        return (out_rows, base)
    return (out_rows, None)


@app.get("/api/arr-schedule/active-arr")
async def get_arr_schedule_active_arr(db: AsyncSession = Depends(get_db)):
    """
    Active ARR by account. Simplified logic:
    - Regular: Active ARR = ARR of most recent closed-won renewal or new business + expansions since then.
      Subscription start/end from that most recent closed-won renewal or NB opp.
    - If no closed renewal/NB (only an open renewal): note flags it; Active ARR = ARR from that open renewal;
      subscription start = null, subscription end = close date of that open renewal.
    Classification: Opportunity Record Type (RecordType.Name → o.record_type_name). Overrides applied. Renewal ARR = open renewal opps only. Delta = Active ARR − Renewal ARR.
    """
    out_rows, base_url = await _compute_active_arr_rows(db)
    out_rows.sort(key=lambda x: -x["active_arr"])
    grand_total = round(sum(r["active_arr"] for r in out_rows), 2)
    return {
        "rows": out_rows,
        "grand_total": grand_total,
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
    out_rows, base_url = await _compute_active_arr_rows(db)
    months: list[str] = []
    for year in (2024, 2025, 2026):
        for month in range(1, 13):
            if year == 2024 and month < 12:
                continue
            if year == 2026 and month > 12:
                break
            months.append(f"{year}-{month:02d}")

    totals_by_month: dict[str, float] = {m: 0.0 for m in months}
    for row in out_rows:
        sub_start_s = row.get("subscription_start_date")
        sub_end_s = row.get("subscription_end_date")
        sub_start = date.fromisoformat(sub_start_s) if sub_start_s else None
        sub_end = date.fromisoformat(sub_end_s) if sub_end_s else None
        anchor_arr = row.get("anchor_arr") or 0.0
        expansions = row.get("expansions") or []
        by_month: dict[str, float] = {}
        for month_key in months:
            y, m = int(month_key[:4]), int(month_key[5:7])
            _, last_day = calendar.monthrange(y, m)
            month_end = date(y, m, last_day)
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
            by_month[month_key] = val
            totals_by_month[month_key] = round(totals_by_month[month_key] + val, 2)
        row["by_month"] = by_month
    out: dict = {"months": months, "totals_by_month": totals_by_month, "rows": out_rows}
    if base_url:
        out["salesforce_base_url"] = base_url
    return out


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
    Take an EOD snapshot now (for testing persistence). Uses current Salesforce data in DB.
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
    """Store end-of-day snapshot of all Salesforce data (EST date, UTC timestamp). Caller must commit.
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


async def _scheduled_salesforce_jobs() -> None:
    """Run hourly Salesforce sync at :59:59 EST (updates ARR and pipeline); EOD snapshot at 23:59:59 EST (for historical ARR and pipeline)."""
    last_sync_hour: Optional[tuple[date, int]] = None  # (date_est, hour_est)
    last_eod_date: Optional[date] = None

    while True:
        try:
            now_est = datetime.now(EST)
            today_est = now_est.date()
            run_hourly = now_est.minute == 59 and now_est.second >= 59
            run_eod = now_est.hour == 23 and now_est.minute == 59

            if run_hourly and (last_sync_hour is None or last_sync_hour != (today_est, now_est.hour)):
                async with AsyncSessionLocal() as session:
                    result = await _run_salesforce_sync(session)
                    if result.get("ok"):
                        await session.commit()
                        last_sync_hour = (today_est, now_est.hour)
                    else:
                        await session.rollback()

            if run_eod and (last_eod_date is None or last_eod_date != today_est):
                async with AsyncSessionLocal() as session:
                    try:
                        await _take_salesforce_eod_snapshot(session)
                        await session.commit()
                        last_eod_date = today_est
                        import logging
                        logging.getLogger(__name__).info("EOD snapshot taken for %s", today_est.isoformat())
                    except Exception as e:
                        await session.rollback()
                        import logging
                        logging.getLogger(__name__).exception("EOD snapshot failed for %s: %s", today_est.isoformat(), e)

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
    """True if Type/record type is New Business or New Customer (case-insensitive, trimmed)."""
    n = (name or "").strip().lower()
    return n == "new business" or "new business" in n or "new customer" in n


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


@app.get("/api/auth/check")
async def auth_check():
    """
    No logic—just confirms the request passed the app password middleware.
    Use this for login verification instead of a data endpoint so 500s from DB/Salesforce don't show as "Invalid password."
    """
    return {"ok": True}


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


def _normalize_renewal_rate_pct(val: Optional[float]) -> Optional[float]:
    """If sheet stores renewal rate as decimal (e.g. 0.588 for 58.8%), convert to percentage."""
    if val is None:
        return None
    if 0 < val <= 1:
        return val * 100
    return val


def _bookings_row(mtd: float, plan_val: Optional[float]) -> BookingsMTDRow:
    achievement_pct = (mtd / plan_val * 100) if plan_val and plan_val != 0 else None
    delta_k = (mtd - plan_val) / 1000.0 if plan_val is not None else None
    return BookingsMTDRow(mtd=mtd, plan=plan_val, achievement_pct=achievement_pct, delta_k=delta_k)


async def _closed_won_arr_in_range(
    db: AsyncSession,
    first_day: date,
    last_day: date,
) -> tuple[float, float, float]:
    """Return (total, new_business, expansion) ARR for Closed Won, New Business + Expansion in [first_day, last_day]."""
    q_closed = select(Opportunity).where(
        Opportunity.stage_name == "Closed Won",
        Opportunity.close_date.isnot(None),
        Opportunity.close_date >= first_day,
        Opportunity.close_date <= last_day,
    )
    r = await db.execute(q_closed)
    closed_opps = [o for o in r.scalars().all() if _is_pipeline_record_type(o.record_type_name)]
    closed_sf_ids = {o.sf_id for o in closed_opps}
    opp_to_arr: dict[str, float] = {}
    if closed_sf_ids:
        q_lines = select(OpportunityLineItem).where(
            OpportunityLineItem.opportunity_sf_id.in_(closed_sf_ids)
        )
        r_lines = await db.execute(q_lines)
        for li in r_lines.scalars().all():
            raw = _normalized_product_name(li.product_name)
            if not _include_line_item_in_arr(raw, li.product_name):
                continue
            opp_sf_id = li.opportunity_sf_id
            mrr = _line_item_effective_total(li)
            opp_to_arr[opp_sf_id] = opp_to_arr.get(opp_sf_id, 0) + mrr * PIPELINE_ARR_MULTIPLIER
    # ARR from product line items only (excl iVerify/Kipu), consistent with ARR overview
    nb, exp = 0.0, 0.0
    for o in closed_opps:
        arr = opp_to_arr.get(o.sf_id, 0)
        rt = (o.record_type_name or "").strip().lower()
        if rt == "new business":
            nb += arr
        elif rt == "expansion":
            exp += arr
    return nb + exp, nb, exp


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
    """Return sum of positive booking ARR (delta) for Closed Won renewals with close_date in [first_day, last_day]. Used to add to dashboard expansion."""
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
    closed = [o for o in r.scalars().all() if _is_renewal_record_type(_effective_record_type(o))]
    if not closed:
        return 0.0
    sf_ids = {o.sf_id for o in closed}
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
    total = 0.0
    for o in closed:
        arr = opp_to_arr.get(o.sf_id, 0)
        ufr = float(o.original_acv) if getattr(o, "original_acv", None) is not None else 0.0
        delta = arr - ufr
        total += max(0.0, delta)
    return round(total, 2)


async def _renewals_metrics_in_range(
    db: AsyncSession,
    first_day: date,
    last_day: date,
) -> tuple[float, float, float, float, float, Optional[float]]:
    """Return (total, renewed, open, churn, contracted, renewal_rate_pct) for renewals with renewal_date in [first_day, last_day].
    Definitions (consistent with Renewals overview):
    - Up for renewal (total) = sum of all UFR ARR for opps with renewal date in month
    - Open = UFR ARR for opps not closed won yet (open stage)
    - Churned = UFR ARR for all closed lost
    - Contracted = sum of |delta| for closed won with negative delta (UFR - renewed)
    - Renewed = sum of UFR for closed won with 0 or positive delta (renewed amount when no contraction)
    Then total = open + churned + contracted + renewed. Renewal rate = renewed / total (up for renewal) * 100.
    """
    overrides = await _get_record_type_overrides(db)

    def _effective_record_type(o: Opportunity) -> str:
        key = (o.sf_id or "").strip()
        override = overrides.get(key) or (overrides.get(key[:15]) if len(key) >= 15 else None)
        return (override or o.record_type_name or "").strip() or "—"

    def _renewal_date(o) -> date | None:
        return o.renewal_date if (getattr(o, "renewal_date", None) and o.renewal_date) else o.close_date

    q = select(Opportunity).where(Opportunity.record_type_name.isnot(None))
    r = await db.execute(q)
    all_opps = [o for o in r.scalars().all() if _is_renewal_record_type(_effective_record_type(o))]
    in_range = [o for o in all_opps if _renewal_date(o) and first_day <= _renewal_date(o) <= last_day]
    if not in_range:
        return 0.0, 0.0, 0.0, 0.0, 0.0, None
    sf_ids = {o.sf_id for o in in_range}
    opp_to_arr = await _compute_arr_from_line_items(db, sf_ids)
    open_arr = 0.0
    churned = 0.0
    contracted = 0.0
    renewed = 0.0
    for o in in_range:
        arr_from_lines = opp_to_arr.get(o.sf_id, 0)
        stage = (o.stage_name or "").strip()
        if stage == "Closed Won":
            ufr_val = float(o.original_acv) if getattr(o, "original_acv", None) is not None else None
            ufr = (ufr_val if ufr_val is not None else arr_from_lines) or 0
            renewed_arr = arr_from_lines
            delta = renewed_arr - ufr
            if delta >= 0:
                renewed += ufr
            else:
                contracted += -delta  # UFR - renewed
                renewed += renewed_arr  # renewed part (so contracted + renewed = UFR for this opp)
        elif stage == "Closed Lost":
            ufr = arr_from_lines
            churned += ufr
        else:
            open_arr += arr_from_lines
    # Total = sum of all UFR in period; must equal open + churned + contracted + renewed
    total = open_arr + churned + contracted + renewed
    renewal_rate_pct = (renewed / total * 100) if total > 0 else None
    return total, renewed, open_arr, churned, contracted, renewal_rate_pct


def _renewals_period_row(mtd: float, plan_val: Optional[float], is_pct: bool = False) -> BookingsMTDRow:
    """Build a row; for is_pct=True mtd/plan are percentages (renewal rate)."""
    if is_pct:
        achievement_pct = (mtd / plan_val * 100) if plan_val and plan_val != 0 else None
        delta_k = (mtd - plan_val) if plan_val is not None else None  # percentage point delta
    else:
        achievement_pct = (mtd / plan_val * 100) if plan_val and plan_val != 0 else None
        delta_k = (mtd - plan_val) / 1000.0 if plan_val is not None else None
    return BookingsMTDRow(mtd=mtd, plan=plan_val, achievement_pct=achievement_pct, delta_k=delta_k)


@app.get("/api/dashboard/bookings-mtd", response_model=BookingsMTDResponse)
async def get_dashboard_bookings_mtd(db: AsyncSession = Depends(get_db)):
    """
    Previous month, current month MTD, and current quarter-to-date Closed Won bookings (New Business + Expansion) vs plan.
    ARR from product line items only (excl. iVerify/Kipu), consistent with ARR overview.
    Plan from sheet ARR_Calculations_2026P: row 11 = new business, row 12 = expansion; columns BU..CF = Jan..Dec.
    On any failure returns 200 + JSON so frontend never sees 500/non-JSON.
    """
    try:
        return await _get_dashboard_bookings_mtd_impl(db)
    except Exception as e:
        return JSONResponse(status_code=200, content=_safe_bookings_fallback(f"Error loading bookings: {str(e)[:100]}"))


async def _get_dashboard_bookings_mtd_impl(db: AsyncSession) -> BookingsMTDResponse:
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

    # Actuals for each period (pipeline NB + Expansion); add Closed Won renewal positive delta to expansion
    prev_total, prev_nb, prev_exp = await _closed_won_arr_in_range(db, prev_first, prev_last)
    mtd_total, mtd_nb, mtd_exp = await _closed_won_arr_in_range(db, first_of_month, today)
    qtd_total, qtd_nb, qtd_exp = await _closed_won_arr_in_range(db, qtd_first, today)
    prev_renewal_exp = await _closed_won_renewal_expansion_arr_in_range(db, prev_first, prev_last)
    mtd_renewal_exp = await _closed_won_renewal_expansion_arr_in_range(db, first_of_month, today)
    qtd_renewal_exp = await _closed_won_renewal_expansion_arr_in_range(db, qtd_first, today)
    prev_exp_mid_term, prev_exp_upon_renewal = prev_exp, prev_renewal_exp
    mtd_exp_mid_term, mtd_exp_upon_renewal = mtd_exp, mtd_renewal_exp
    qtd_exp_mid_term, qtd_exp_upon_renewal = qtd_exp, qtd_renewal_exp
    prev_exp += prev_renewal_exp
    prev_total += prev_renewal_exp
    mtd_exp += mtd_renewal_exp
    mtd_total += mtd_renewal_exp
    qtd_exp += qtd_renewal_exp
    qtd_total += qtd_renewal_exp

    # Plan for previous month (month index 0-based)
    prev_m = (month - 2 + 12) % 12
    p_nb, p_exp = plan_by_month[prev_m]
    p_tot = (p_nb or 0) + (p_exp or 0) if (p_nb is not None or p_exp is not None) else None

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
    c_exp_d = _plan_dollars(c_exp, mtd_exp)
    q_tot_d = _plan_dollars(q_tot, qtd_total)
    q_nb_d = _plan_dollars(q_nb, qtd_nb)
    q_exp_d = _plan_dollars(q_exp, qtd_exp)
    shortfall_mtd_tot = max(0, c_tot_d - mtd_total)
    shortfall_mtd_nb = max(0, c_nb_d - mtd_nb)
    shortfall_mtd_exp = max(0, c_exp_d - mtd_exp)
    shortfall_qtd_tot = max(0, q_tot_d - qtd_total)
    shortfall_qtd_nb = max(0, q_nb_d - qtd_nb)
    shortfall_qtd_exp = max(0, q_exp_d - qtd_exp)
    pipe_cov_mtd_tot = round(pipeline_mtd_tot / shortfall_mtd_tot, 2) if shortfall_mtd_tot > 0 else None
    pipe_cov_mtd_nb = round(pipeline_mtd_nb / shortfall_mtd_nb, 2) if shortfall_mtd_nb > 0 else None
    pipe_cov_mtd_exp = round(pipeline_mtd_exp / shortfall_mtd_exp, 2) if shortfall_mtd_exp > 0 else None
    pipe_cov_qtd_tot = round(pipeline_qtd_tot / shortfall_qtd_tot, 2) if shortfall_qtd_tot > 0 else None
    pipe_cov_qtd_nb = round(pipeline_qtd_nb / shortfall_qtd_nb, 2) if shortfall_qtd_nb > 0 else None
    pipe_cov_qtd_exp = round(pipeline_qtd_exp / shortfall_qtd_exp, 2) if shortfall_qtd_exp > 0 else None

    return BookingsMTDResponse(
        previous_month=BookingsPeriod(
            period_label=prev_label,
            total=_bookings_row(prev_total, p_tot),
            new_business=_bookings_row(prev_nb, p_nb),
            expansion=_bookings_row(prev_exp, p_exp),
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
            expansion=_bookings_row(mtd_exp, c_exp),
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
            expansion=_bookings_row(qtd_exp, q_exp),
            expansion_mid_term=qtd_exp_mid_term,
            expansion_upon_renewal=qtd_exp_upon_renewal,
            pipe_coverage_total=pipe_cov_qtd_tot,
            pipe_coverage_new_business=pipe_cov_qtd_nb,
            pipe_coverage_expansion=pipe_cov_qtd_exp,
        ),
        plan_source=plan_source,
        plan_message=plan_message,
    )


# ARR_Calculations_2026P: row 52 = renewal rate %, row 54 = contraction rate % (Jan..Dec = BU..CF; Q1..Q4 = X,Y,Z,AA). Churn plan = up for renewal - renewed plan - contraction plan.
ARR_2026P_RENEWALS_PLAN_ROWS = (12, 13, 51)  # 0-based: row 13, 14, 52 -> churn $ (unused), contraction $ (unused), renewal_rate_pct
ARR_2026P_ROW_CONTRACTION_RATE = 53  # 0-based row 54 = contraction rate %
ARR_2026P_QUARTER_RR_COLUMNS = ("X", "Y", "Z", "AA")  # Q1..Q4 renewal rate and contraction rate in row 52 / 54


def _safe_renewals_fallback(plan_message: str) -> dict:
    """Minimal valid renewals JSON so frontend never gets 500/non-JSON."""
    now_est = datetime.now(EST)
    y, m = now_est.year, now_est.month
    prev = datetime(y - 1, 12, 1).strftime("%b %y") if m == 1 else datetime(y, m - 1, 1).strftime("%b %y")
    cur = now_est.strftime("%b %y") + " MTD"
    qm = ((m - 1) // 3) * 3 + 1
    qtd = f"Q{(qm - 1) // 3 + 1} {str(y)[2:]} QTD"
    row = {"mtd": 0.0, "plan": None, "achievement_pct": None, "delta_k": None}
    per = lambda label: {"period_label": label, "total": row, "renewed": row, "open": row, "churn": row, "contraction": row, "renewal_rate": row}
    return {"previous_month": per(prev), "current_mtd": per(cur), "qtd": per(qtd), "plan_source": None, "plan_message": plan_message}


def _safe_cash_fallback(plan_message: str) -> dict:
    """Minimal valid cash JSON for exception handler so frontend never gets 500/non-JSON."""
    now_est = datetime.now(EST)
    y, m = now_est.year, now_est.month
    prev = datetime(y - 1, 12, 1).strftime("%b %y") if m == 1 else datetime(y, m - 1, 1).strftime("%b %y")
    cur = now_est.strftime("%b %y") + " MTD"
    qm = ((m - 1) // 3) * 3 + 1
    qtd = f"Q{(qm - 1) // 3 + 1} {str(y)[2:]} QTD"
    empty = {"period_label": "", "billings_plan": None, "collections_plan": None, "billings_actual": None, "collections_actual": None, "billings_achievement_pct": None, "billings_delta_k": None, "collections_achievement_pct": None, "collections_delta_k": None}
    return {
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
    prev = datetime(y - 1, 12, 1).strftime("%b %y") if m == 1 else datetime(y, m - 1, 1).strftime("%b %y")
    cur = now_est.strftime("%b %y") + " MTD"
    qm = ((m - 1) // 3) * 3 + 1
    qtd = f"Q{(qm - 1) // 3 + 1} {str(y)[2:]} QTD"
    row = {"mtd": 0.0, "plan": None, "achievement_pct": None, "delta_k": None}
    per = lambda label: {"period_label": label, "total": row, "new_business": row, "expansion": row}
    return {"previous_month": per(prev), "current_mtd": per(cur), "qtd": per(qtd), "plan_source": None, "plan_message": plan_message}


@app.get("/api/dashboard/renewals-mtd", response_model=RenewalsMTDResponse)
async def get_dashboard_renewals_mtd(db: AsyncSession = Depends(get_db)):
    """Renewals metrics: previous month, MTD, QTD. On failure returns 200 + JSON so frontend never sees 500."""
    try:
        return await _get_dashboard_renewals_mtd_impl(db)
    except Exception as e:
        return JSONResponse(status_code=200, content=_safe_renewals_fallback(f"Error loading renewals: {str(e)[:100]}"))


async def _get_dashboard_renewals_mtd_impl(db: AsyncSession) -> RenewalsMTDResponse:
    """Renewals metrics: previous month, current MTD, QTD. Plan from sheet row 52/54."""
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
        prev_last = (prev_last.replace(day=1) - timedelta(days=1))
        prev_label = datetime(year, month - 1, 1).strftime("%b %y")

    first_of_month = date(year, month, 1)
    # Use full month range so cohort matches renewals overview (open + churn + renewed for the whole month)
    last_of_month = (first_of_month + timedelta(days=32)).replace(day=1) - timedelta(days=1)
    current_mtd_last = last_of_month
    current_label = now_est.strftime("%b %y") + " MTD"

    quarter_month = ((month - 1) // 3) * 3 + 1
    qtd_first = date(year, quarter_month, 1)
    # Full quarter range so QTD cohort matches quarter (like current month uses full month)
    qtd_last = (date(year, quarter_month + 3, 1) - timedelta(days=1)) if quarter_month <= 9 else date(year, 12, 31)
    qtd_label = f"Q{(quarter_month - 1) // 3 + 1} {str(year)[2:]} QTD"

    # Plan: renewal_rate (row 52), contraction rate % (row 54) by month; churn plan = up for renewal - renewed plan - contraction plan
    plan_renewal_rate_by_month: list[Optional[float]] = [None] * 12
    plan_contraction_rate_by_month: list[Optional[float]] = [None] * 12
    q_rr_plan: Optional[float] = None
    q_cont_rate: Optional[float] = None
    plan_source: Optional[str] = None
    plan_message: Optional[str] = None
    sheet_range = "ARR_Calculations_2026P!A1:ZZ1000"
    r_snap = await db.execute(
        select(SheetSnapshot).where(SheetSnapshot.range_name == sheet_range).order_by(SheetSnapshot.as_of.desc()).limit(1)
    )
    snap = r_snap.scalar_one_or_none()
    if snap and snap.data_json:
        data = json.loads(snap.data_json)
        try:
            # Sheets API returns variable-length rows (trailing empty cells omitted). Pad to max row
            # length so we can read BU/BV (Jan/Feb) on row 52 same as row 11/12 for bookings.
            max_cols = max(len(row) for row in data) if data else 0
            if max_cols > 0:
                data = [list(row) + [None] * (max_cols - len(row)) for row in data]
            for m in range(12):
                col_idx = _a1_col_to_index(ARR_2026P_MONTH_COLUMNS[m])
                # Renewal rate % from row 52
                rr_row = data[51] if len(data) > 51 else []
                v = rr_row[col_idx] if col_idx < len(rr_row) else None
                val = _to_float_sheet_pct(v)
                plan_renewal_rate_by_month[m] = _normalize_renewal_rate_pct(val)
                # Contraction rate % from row 54
                cr_row = data[ARR_2026P_ROW_CONTRACTION_RATE] if len(data) > ARR_2026P_ROW_CONTRACTION_RATE else []
                v_c = cr_row[col_idx] if col_idx < len(cr_row) else None
                val_c = _to_float_sheet_pct(v_c)
                norm_c = _normalize_renewal_rate_pct(val_c)
                plan_contraction_rate_by_month[m] = (norm_c * -1) if norm_c is not None else None
            # Q1..Q4 renewal rate and contraction rate from row 52 and 54: X, Y, Z, AA
            q_num = (quarter_month - 1) // 3  # 0..3 for Q1..Q4
            if q_num < len(ARR_2026P_QUARTER_RR_COLUMNS):
                col_idx = _a1_col_to_index(ARR_2026P_QUARTER_RR_COLUMNS[q_num])
                rr_row = data[51] if len(data) > 51 else []
                if col_idx < len(rr_row):
                    val = _to_float_sheet_pct(rr_row[col_idx])
                    q_rr_plan = _normalize_renewal_rate_pct(val)
                cr_row = data[ARR_2026P_ROW_CONTRACTION_RATE] if len(data) > ARR_2026P_ROW_CONTRACTION_RATE else []
                if col_idx < len(cr_row):
                    val_c = _to_float_sheet_pct(cr_row[col_idx])
                    norm_c = _normalize_renewal_rate_pct(val_c)
                    q_cont_rate = (norm_c * -1) if norm_c is not None else None
            plan_source = "ARR_Calculations_2026P"
        except (TypeError, ValueError, IndexError):
            plan_message = "Could not read renewal plan from sheet."
    else:
        plan_message = "No sheet snapshot. Sync ARR_Calculations_2026P first."

    # If renewal rate plan is missing but sheet loaded, hint that row 52 must extend to BU/BV (Jan/Feb)
    if plan_message is None and plan_source and all(plan_renewal_rate_by_month[i] is None for i in range(12)) and q_rr_plan is None:
        plan_message = "Renewal rate plan: add values in row 52 at BU (Jan), BV (Feb), X (Q1), then re-sync sheet."

    prev_t, prev_r, prev_o, prev_ch, prev_cont, prev_rr = await _renewals_metrics_in_range(db, prev_first, prev_last)
    mtd_t, mtd_r, mtd_o, mtd_ch, mtd_cont, mtd_rr = await _renewals_metrics_in_range(db, first_of_month, current_mtd_last)
    qtd_t, qtd_r, qtd_o, qtd_ch, qtd_cont, qtd_rr = await _renewals_metrics_in_range(db, qtd_first, qtd_last)

    prev_m = (month - 2 + 12) % 12
    c_m = month - 1
    if q_rr_plan is None:
        q_rr_vals = [plan_renewal_rate_by_month[i] for i in range(quarter_month - 1, min(quarter_month + 2, 12)) if plan_renewal_rate_by_month[i] is not None]
        q_rr_plan = sum(q_rr_vals) / len(q_rr_vals) if q_rr_vals else None
    if q_cont_rate is None:
        q_cr_vals = [plan_contraction_rate_by_month[i] for i in range(quarter_month - 1, min(quarter_month + 2, 12)) if plan_contraction_rate_by_month[i] is not None]
        q_cont_rate = sum(q_cr_vals) / len(q_cr_vals) if q_cr_vals else None

    def period(
        label: str,
        t: float, r: float, o: float, ch: float, cont: float, rr: Optional[float],
        cont_rate: Optional[float], rr_plan: Optional[float],
    ) -> RenewalsMTDPeriod:
        # Up for renewal plan = actual. Renewed plan = rr_plan × up for renewal. Contraction plan = cont_rate × up for renewal. Churn plan = up for renewal - renewed plan - contraction plan.
        renewed_plan = (rr_plan / 100.0 * t) if rr_plan is not None else None
        cont_plan = (cont_rate / 100.0 * t) if cont_rate is not None else None
        ch_plan = (t - renewed_plan - cont_plan) if (renewed_plan is not None and cont_plan is not None) else None
        return RenewalsMTDPeriod(
            period_label=label,
            total=_renewals_period_row(t, t),  # plan = actual
            renewed=_renewals_period_row(r, renewed_plan),
            open=_renewals_period_row(o, None),
            churn=_renewals_period_row(ch, ch_plan),
            contraction=_renewals_period_row(cont, cont_plan),
            renewal_rate=_renewals_period_row(rr or 0, rr_plan, is_pct=True),
        )

    return RenewalsMTDResponse(
        previous_month=period(prev_label, prev_t, prev_r, prev_o, prev_ch, prev_cont, prev_rr, plan_contraction_rate_by_month[prev_m], plan_renewal_rate_by_month[prev_m]),
        current_mtd=period(current_label, mtd_t, mtd_r, mtd_o, mtd_ch, mtd_cont, mtd_rr, plan_contraction_rate_by_month[c_m], plan_renewal_rate_by_month[c_m]),
        qtd=period(qtd_label, qtd_t, qtd_r, qtd_o, qtd_ch, qtd_cont, qtd_rr, q_cont_rate, q_rr_plan if q_rr_plan else None),
        plan_source=plan_source,
        plan_message=plan_message,
    )


# BS_2026P: Billings row 45 (index 44); Collections = sum rows 64,65,66 (indices 63,64,65). Same month columns as ARR (BU..CF = Jan..Dec).
BS_2026P_BILLINGS_ROW = 44
BS_2026P_COLLECTIONS_ROWS = (63, 64, 65)


@app.get("/api/dashboard/cash-mtd", response_model=CashMTDResponse)
async def get_dashboard_cash_mtd(db: AsyncSession = Depends(get_db)):
    """
    Cash KPIs: Billings and Collections. Same layout as Bookings: previous month, MTD, QTD.
    Plan from sheet BS_2026P: row 45 = Billings by month (BU..CF = Jan..Dec), rows 64–66 sum = Collections by month.
    Actuals from Chargebee (invoices = billings, payments = collections).
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
        if month == 1:
            prev_label = datetime(year - 1, 12, 1).strftime("%b %y")
        else:
            prev_label = datetime(year, month - 1, 1).strftime("%b %y")
        current_label = now_est.strftime("%b %y") + " MTD"
        quarter_month = ((month - 1) // 3) * 3 + 1
        qtd_label = f"Q{(quarter_month - 1) // 3 + 1} {str(year)[2:]} QTD"
        p = _empty_period(prev_label)
        c = _empty_period(current_label)
        q = _empty_period(qtd_label)
        return {
            "previous_month": p.model_dump(),
            "current_mtd": c.model_dump(),
            "qtd": q.model_dump(),
            "plan_source": None,
            "plan_message": plan_message,
            "chargebee_message": None,
        }

    try:
        return await _get_dashboard_cash_mtd_impl(db)
    except Exception as e:
        err_msg = str(e)[:120]
        try:
            body = _safe_cash_body(f"Error loading cash data: {err_msg}")
            return JSONResponse(status_code=200, content=body)
        except Exception:
            # Fallback: minimal dict so frontend always gets valid JSON
            now_est = datetime.now(EST)
            y, m = now_est.year, now_est.month
            prev = datetime(y - 1, 12, 1).strftime("%b %y") if m == 1 else datetime(y, m - 1, 1).strftime("%b %y")
            cur = now_est.strftime("%b %y") + " MTD"
            qm = ((m - 1) // 3) * 3 + 1
            qtd = f"Q{(qm - 1) // 3 + 1} {str(y)[2:]} QTD"
            empty = {"period_label": "", "billings_plan": None, "collections_plan": None, "billings_actual": None, "collections_actual": None, "billings_achievement_pct": None, "billings_delta_k": None, "collections_achievement_pct": None, "collections_delta_k": None}
            return JSONResponse(status_code=200, content={
                "previous_month": {**empty, "period_label": prev},
                "current_mtd": {**empty, "period_label": cur},
                "qtd": {**empty, "period_label": qtd},
                "plan_source": None,
                "plan_message": "Error loading cash data.",
                "chargebee_message": None,
            })


async def _get_dashboard_cash_mtd_impl(db: AsyncSession) -> CashMTDResponse:
    now_est = datetime.now(EST)
    year, month = now_est.year, now_est.month
    if month == 1:
        prev_label = datetime(year - 1, 12, 1).strftime("%b %y")
    else:
        prev_label = datetime(year, month - 1, 1).strftime("%b %y")
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
    c_m = month - 1
    prev_b = billings_by_month[prev_m]
    prev_c = collections_by_month[prev_m]
    curr_b = billings_by_month[c_m]
    curr_c = collections_by_month[c_m]
    q_b = sum(billings_by_month[i] or 0 for i in range(quarter_month - 1, min(quarter_month + 2, 12)))
    q_c = sum(collections_by_month[i] or 0 for i in range(quarter_month - 1, min(quarter_month + 2, 12)))

    # Actuals from Chargebee: billings = invoice total by invoice date; collections = payment transactions by date (matches Total Payments export)
    prev_billings_act: Optional[float] = None
    prev_coll_act: Optional[float] = None
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
    curr_first = datetime(year, month, 1, 0, 0, 0, tzinfo=EST)
    curr_last = now_est
    qtd_first_dt = datetime(year, quarter_month, 1, 0, 0, 0, tzinfo=EST)
    prev_start_ts = int(prev_first.timestamp())
    prev_end_ts = int(prev_last.timestamp())
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

        # Billings: from invoices by invoice date (unchanged)
        try:
            invoices = await asyncio.to_thread(
                connector.fetch_invoices_in_date_range,
                prev_start_ts,
                curr_end_ts + 86400,
            )
        except Exception as e:
            chargebee_message = f"Chargebee: {str(e)[:80]}"

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
                if _in_range(inv_ts, prev_start_ts, prev_end_ts):
                    prev_billings_act = (prev_billings_act or 0) + total_f
                if _in_range(inv_ts, curr_start_ts, curr_end_ts):
                    mtd_billings_act = (mtd_billings_act or 0) + total_f
                if inv_ts >= qtd_start_ts and inv_ts <= curr_end_ts:
                    qtd_billings_act = (qtd_billings_act or 0) + total_f

        # Collections: from payment transactions by transaction date (matches Chargebee Total Payments export)
        try:
            payments = await asyncio.to_thread(
                connector.fetch_payments_in_date_range,
                prev_start_ts,
                curr_end_ts + 86400,
            )
        except Exception as e:
            if not chargebee_message:
                chargebee_message = f"Chargebee payments: {str(e)[:80]}"

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
    """Compute ARR by account and product (open renewals only). Shared by GET and export."""
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
        return {"products": [], "rows": [], "total_by_product": {}, "grand_total": 0.0}

    q_lines = select(OpportunityLineItem).where(
        OpportunityLineItem.opportunity_sf_id.in_(renewal_sf_ids)
    )
    r_lines = await db.execute(q_lines)
    lines = r_lines.scalars().all()

    products = list(ARR_PRODUCT_COLUMNS) + ["Other"]
    by_account_product: dict[tuple[str | None, str | None], dict[str, float]] = {}
    for opp_sf_id, canonical, arr in _line_items_to_arr_by_group(lines):
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

    # Load segment per account for rows
    account_ids = {aid for (aid, _) in by_account_product.keys() if aid}
    account_segment: dict[str, str | None] = {}
    if account_ids:
        q_acc = select(Account.sf_id, Account.segment).where(Account.sf_id.in_(account_ids))
        r_acc = await db.execute(q_acc)
        for (sf_id, seg) in r_acc.all():
            account_segment[sf_id] = seg

    total_by_product: dict[str, float] = {p: 0.0 for p in products}
    rows = []
    grand_total = 0.0
    for (aid, aname), by_product in by_account_product.items():
        by_product_arr = {p: round(by_product.get(p, 0), 2) for p in products}  # already ARR (period-weighted when term_months present)
        for p in products:
            total_by_product[p] = total_by_product.get(p, 0) + by_product_arr.get(p, 0)
        total_arr = round(sum(by_product_arr.values()), 2)
        grand_total += total_arr
        seg = account_segment.get(aid) if aid else None
        seg = (seg or "").strip() or DEFAULT_SEGMENT
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
    Returns: products (column order), rows (account_name, by_product, total_arr), total_by_product, grand_total.
    Optional salesforce_base_url when SALESFORCE_BASE_URL is set (for account links).
    """
    data = await _get_arr_by_account_product_data(db)
    base = os.getenv("SALESFORCE_BASE_URL", "").strip().rstrip("/")
    if base and ("salesforce.com" in base or "lightning.force.com" in base):
        data["salesforce_base_url"] = base
    return data


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

    # Build sheet rows: header (Account, Segment, products..., Total CARR), data rows, total row
    header = ["Account", "Segment"] + products + ["Total CARR"]
    values = [header]
    for r in rows_data:
        values.append(
            [r["account_name"], (r.get("segment") or "").strip() or DEFAULT_SEGMENT]
            + [r["by_product"].get(p, 0) for p in products]
            + [r["total_arr"]]
        )
    values.append(
        ["Total", ""] + [total_by_product.get(p, 0) for p in products] + [grand_total]
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


# ARR_Calculations_2026P: row 11 = new business plan, row 12 = expansion plan; Feb = BV (user-specified).
ARR_2026P_MONTH_COLUMNS = [
    "BU", "BV", "BW", "BX", "BY", "BZ", "CA", "CB", "CC", "CD", "CE", "CF",
]  # Jan..Dec


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
    Same data source as ARR: hourly Salesforce sync at :59 EST, daily EOD snapshot at 23:59 EST (use as_of for historical pipeline).
    Optional filters: segment, stage, record_type. Optional as_of for pipeline from EOD snapshot.
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
            "message": "No EOD snapshot for that date. Pipeline and ARR are snapshotted daily at 23:59 EST.",
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
    for o in open_opps_all:
        seg = account_segment.get(o.account_id) if o.account_id else DEFAULT_SEGMENT
        segments_set.add(seg)
        stages_set.add(_canonical_stage_name(o.stage_name))
        record_types_set.add(o.record_type_name or "—")
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
    rows = []
    grand_total = 0.0
    for o in open_opps:
        if o.mrr is not None and o.mrr != 0:
            arr = round(float(o.mrr) * PIPELINE_ARR_MULTIPLIER, 2)
        else:
            arr = opp_to_arr_from_lines.get(o.sf_id, 0)
        grand_total += arr
        seg = account_segment.get(o.account_id) if o.account_id else DEFAULT_SEGMENT
        rows.append({
            "account_id": o.account_id,
            "account_name": o.account_name or "—",
            "segment": seg,
            "opportunity_sf_id": o.sf_id,
            "opportunity_name": o.name or "—",
            "stage_name": _canonical_stage_name(o.stage_name),
            "record_type_name": o.record_type_name or "—",
            "close_date": o.close_date.isoformat() if o.close_date else None,
            "arr": arr,
        })
    rows.sort(key=lambda x: -x["arr"])
    out = {
        "rows": rows,
        "grand_total": round(grand_total, 2),
        "segments": sorted(segments_set),
        "stages": sorted(stages_set),
        "record_types": sorted(record_types_set),
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
    Dashboard and bookings metrics still use New Business + Expansion only. Optional filters: segment, stage, record_type, months.
    ARR = sum of product line item ARR per opportunity (excl. iVerify/Kipu), consistent with ARR overview.
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
    closed_opps_all = [o for o in r.scalars().all() if _in_bookings_list(o)]
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
    closed_sf_ids = {o.sf_id for o in closed_opps}
    # ARR from product line items only (excl iVerify/Kipu), consistent with ARR overview
    opp_to_arr_from_lines: dict[str, float] = {}
    if closed_sf_ids:
        q_lines = select(OpportunityLineItem).where(
            OpportunityLineItem.opportunity_sf_id.in_(closed_sf_ids)
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
    rows = []
    grand_total = 0.0
    for o in closed_opps:
        arr_from_lines = opp_to_arr_from_lines.get(o.sf_id, 0)
        # For renewals and amendments, booking ARR = delta (renewal change) as in renewals overview
        if _is_renewal_record_type(_effective_record_type(o)) or _is_amendment_record_type(_effective_record_type(o)):
            stage = (o.stage_name or "").strip()
            if stage == "Closed Won":
                ufr_val = float(o.original_acv) if getattr(o, "original_acv", None) is not None else None
                ufr = (ufr_val if ufr_val is not None else 0) or 0
                arr = round(arr_from_lines - ufr, 2)
            elif stage == "Closed Lost":
                arr = round(0.0 - arr_from_lines, 2)
            else:
                arr = arr_from_lines
        else:
            arr = arr_from_lines
        # Closed Lost New Business: booking ARR = 0
        if (o.stage_name or "").strip() == "Closed Lost" and (_effective_record_type(o) or "").strip().lower() == "new business":
            arr = 0.0
        # Booking ARR is only positive; set to 0 if not positive
        arr = max(0.0, arr)
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


@app.get("/api/renewals-overview")
async def get_renewals_overview(
    db: AsyncSession = Depends(get_db),
    segment: Optional[List[str]] = Query(None, description="Filter by segment"),
    stage: Optional[List[str]] = Query(None, description="Filter by stage (e.g. Closed Won)"),
    record_type: Optional[List[str]] = Query(None, description="Filter by record type"),
    months: Optional[List[str]] = Query(None, description="Filter by renewal date (close date) month(s), e.g. 2026-02"),
):
    """
    All renewal opportunities (open + Closed Won + Closed Lost). Record type = Renewal only.
    Renewal date = Opportunity.renewal_date (if set, e.g. from Renewal_Date__c) else close_date.
    Same filters and response shape as closed-overview. ARR from product line items (excl. iVerify/Kipu).
    """
    def _renewal_date(o) -> date | None:
        return o.renewal_date if (getattr(o, "renewal_date", None) and o.renewal_date) else o.close_date

    overrides = await _get_record_type_overrides(db)

    def _effective_record_type(o: Opportunity) -> str:
        key = (o.sf_id or "").strip()
        override = overrides.get(key) or (overrides.get(key[:15]) if len(key) >= 15 else None)
        return (override or o.record_type_name or "").strip() or "—"

    q_renewals = select(Opportunity).where(
        Opportunity.record_type_name.isnot(None),
    ).order_by(Opportunity.close_date.desc().nullslast(), Opportunity.id.desc())
    r = await db.execute(q_renewals)
    renewal_opps_all = [o for o in r.scalars().all() if _is_renewal_record_type(_effective_record_type(o))]
    account_ids_all = {o.account_id for o in renewal_opps_all if o.account_id}
    account_segment: dict[str, str] = {}
    if account_ids_all:
        q_acc = select(Account.sf_id, Account.segment).where(Account.sf_id.in_(account_ids_all))
        r_acc = await db.execute(q_acc)
        for (sf_id, seg) in r_acc.all():
            account_segment[sf_id] = (seg or "").strip() or DEFAULT_SEGMENT
    segments_set: set[str] = set()
    stages_set: set[str] = set()
    record_types_set: set[str] = set()
    available_months_set: set[str] = set()
    for o in renewal_opps_all:
        seg = account_segment.get(o.account_id) if o.account_id else DEFAULT_SEGMENT
        segments_set.add(seg)
        stages_set.add(o.stage_name or "—")
        record_types_set.add(_effective_record_type(o))
        rd = _renewal_date(o)
        if rd:
            available_months_set.add(rd.strftime("%Y-%m"))

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
            renewal_opps = [o for o in renewal_opps_all if _keep(o) and _renewal_date(o) and _in_selected(_renewal_date(o))]
        else:
            renewal_opps = [o for o in renewal_opps_all if _keep(o)]
    else:
        renewal_opps = [o for o in renewal_opps_all if _keep(o)]
    renewal_sf_ids = {o.sf_id for o in renewal_opps}
    opp_to_arr_from_lines = await _compute_arr_from_line_items(db, renewal_sf_ids)
    rows = []
    grand_total = 0.0
    for o in renewal_opps:
        arr_from_lines = opp_to_arr_from_lines.get(o.sf_id, 0)
        stage = (o.stage_name or "").strip()
        is_closed = stage in CLOSED_STAGES
        if is_closed:
            if stage == "Closed Won":
                # Closed Won: UFR = Original ACV from SF, Renewed ARR = line-item ARR.
                ufr_val = float(o.original_acv) if getattr(o, "original_acv", None) is not None else None
                ufr_arr = round(ufr_val, 2) if ufr_val is not None else None
                renewed_arr = round(arr_from_lines, 2)
                renewal_change_arr = round(renewed_arr - (ufr_val or 0), 2)
            else:
                # Closed Lost: UFR = from line items (same as customer base), Renewed ARR = 0.
                ufr_arr = round(arr_from_lines, 2) if arr_from_lines else None
                renewed_arr = 0.0
                renewal_change_arr = round(0.0 - (arr_from_lines or 0), 2)
        else:
            # Open: UFR ARR = from line items (same as customer base). Renewed ARR = 0 (not closed yet).
            ufr_arr = round(arr_from_lines, 2) if arr_from_lines else None
            renewed_arr = 0.0
            renewal_change_arr = round(0.0 - (arr_from_lines or 0), 2)  # delta = renewed - ufr = 0 - ufr
        grand_total += renewed_arr
        seg = account_segment.get(o.account_id) if o.account_id else DEFAULT_SEGMENT
        rd = _renewal_date(o)
        rows.append({
            "account_id": o.account_id,
            "account_name": o.account_name or "—",
            "segment": seg,
            "opportunity_sf_id": o.sf_id,
            "opportunity_name": o.name or "—",
            "stage_name": o.stage_name or "—",
            "record_type_name": _effective_record_type(o),
            "close_date": o.close_date.isoformat() if o.close_date else None,
            "renewal_date": rd.isoformat() if rd else None,
            "ufr_arr": ufr_arr,
            "arr": renewed_arr,
            "renewal_change_arr": renewal_change_arr,
        })
    # Sort by renewal date (newest first), then ARR desc; rows with no date last
    def _sort_key(row: dict) -> tuple:
        rdd = row.get("renewal_date") or row.get("close_date")
        od = date.fromisoformat(rdd).toordinal() if rdd else (date.max.toordinal() + 1)
        return (-od, -row["arr"])
    rows.sort(key=_sort_key)
    # Hint for UI: if no opp has renewal_date set, we're bucketing by close date (set SALESFORCE_RENEWAL_DATE_FIELD and sync for correct months)
    any_renewal_date_set = any(
        getattr(o, "renewal_date", None) and o.renewal_date for o in renewal_opps_all
    )
    out = {
        "rows": rows,
        "grand_total": round(grand_total, 2),
        "available_months": sorted(available_months_set, reverse=True),
        "segments": sorted(segments_set),
        "stages": sorted(stages_set),
        "record_types": sorted(record_types_set),
        "renewal_date_used": any_renewal_date_set,
    }
    base = os.getenv("SALESFORCE_BASE_URL", "").strip().rstrip("/")
    if base and ("salesforce.com" in base or "lightning.force.com" in base):
        out["salesforce_base_url"] = base
    return out


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


@app.get("/api/debug/routes")
async def debug_routes():
    """Return list of registered route paths (for debugging 404s) and whether app password is required."""
    paths = [getattr(r, "path", None) for r in app.routes if hasattr(r, "path") and getattr(r, "path", None)]
    return {
        "paths": sorted(p for p in paths if p),
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

CHARGEBEE_REPORT_TYPES = ["subscriptions", "invoices"]


@app.post("/api/sync/chargebee")
async def sync_chargebee(db: AsyncSession = Depends(get_db)):
    """
    Sync subscriptions and invoices from Chargebee into the app.
    Requires CHARGEBEE_SITE and CHARGEBEE_API_KEY in .env.
    """
    from connectors.chargebee import ChargebeeConnector

    connector = ChargebeeConnector()
    if not connector.is_configured():
        return {
            "ok": False,
            "error": "Chargebee not configured. Set CHARGEBEE_SITE and CHARGEBEE_API_KEY in backend/.env.",
        }
    synced = {}
    for report_type in CHARGEBEE_REPORT_TYPES:
        try:
            if report_type == "subscriptions":
                data = await asyncio.to_thread(connector.list_subscriptions, limit=100)
            else:
                data = await asyncio.to_thread(connector.list_invoices, limit=100)
        except Exception as e:
            return {"ok": False, "error": f"Chargebee {report_type} failed: {e}"}
        snapshot = ChargebeeSnapshot(report_type=report_type, data_json=json.dumps(data))
        db.add(snapshot)
        count = len(data.get("list") or [])
        synced[report_type] = count
    await db.commit()
    return {
        "ok": True,
        "synced": synced,
        "message": "Chargebee subscriptions and invoices synced (first page each).",
    }


@app.get("/api/chargebee/{report_type}")
async def get_chargebee_snapshot(
    report_type: str,
    db: AsyncSession = Depends(get_db),
):
    """Return the latest Chargebee snapshot. report_type: subscriptions or invoices."""
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
