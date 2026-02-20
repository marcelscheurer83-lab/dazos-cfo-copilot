"""
Dazos CFO Copilot — FastAPI backend.
Dashboard, P&L, cash flow, budget vs actuals, and Copilot Q&A.
All scheduled times (hourly sync, EOD snapshot) use America/New_York (EST/EDT).
"""
import asyncio
import json
import os
from contextlib import asynccontextmanager
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from sqlalchemy import select, delete, func
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
    QuickBooksReportSnapshot,
    SalesforceEODSnapshot,
)
from schemas import KPISummary, PnLLineOut, CashFlowLineOut, BudgetVsActualOut, CopilotRequest, CopilotResponse, DashboardKPI
from seed_data import seed

# Load .env from backend directory so GOOGLE_SHEET_ID etc. are available
load_dotenv(Path(__file__).resolve().parent / ".env")

EST = ZoneInfo("America/New_York")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await seed()
    # Background task: hourly Salesforce sync at :59:59 EST, EOD snapshot at 23:59:59 EST
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
        password = os.getenv("APP_PASSWORD")
        if not password:
            return await call_next(request)
        supplied = request.headers.get("X-App-Password")
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
    """Answer natural-language questions using latest KPI and rule-based logic. Plug in OpenAI later via COPILOT_API_KEY."""
    q = body.question.lower().strip()
    # Fetch latest KPI for context
    r = await db.execute(select(KPI).order_by(KPI.as_of_date.desc()).limit(1))
    kpi = r.scalar_one_or_none()
    runway = _runway_months(kpi.cash_balance, kpi.monthly_burn) if kpi else None
    growth = _growth_pct(kpi.revenue_ytd, kpi.revenue_prior_ytd) if kpi else None

    if "runway" in q or "how long" in q and "cash" in q:
        if runway is not None:
            return CopilotResponse(answer=f"Based on the latest data (as of {kpi.as_of_date}), cash balance is ${kpi.cash_balance:,.0f} with a monthly burn of ${kpi.monthly_burn:,.0f}. **Runway is approximately {runway} months.**", sources=["KPI snapshot"])
        return CopilotResponse(answer="Runway cannot be computed without cash balance and monthly burn. Please ensure KPI data is loaded.", sources=[])
    if "revenue" in q and ("growth" in q or "yoy" in q or "compare" in q):
        if growth is not None and kpi:
            return CopilotResponse(answer=f"YTD revenue as of {kpi.as_of_date} is ${kpi.revenue_ytd:,.0f}, compared to prior year YTD ${kpi.revenue_prior_ytd:,.0f}. **Revenue growth is {growth}%.**", sources=["KPI snapshot"])
        return CopilotResponse(answer="Revenue comparison data is not available for the requested period.", sources=[])
    if "cash" in q and ("balance" in q or "position" in q):
        if kpi:
            return CopilotResponse(answer=f"As of {kpi.as_of_date}, **cash balance is ${kpi.cash_balance:,.0f}.** Monthly burn is ${kpi.monthly_burn:,.0f}.", sources=["KPI snapshot"])
        return CopilotResponse(answer="No cash balance data available.", sources=[])
    if "burn" in q or "burn rate" in q:
        if kpi:
            return CopilotResponse(answer=f"Monthly burn as of {kpi.as_of_date} is **${kpi.monthly_burn:,.0f}.**", sources=["KPI snapshot"])
        return CopilotResponse(answer="Burn rate data is not available.", sources=[])
    if "margin" in q or "gross" in q:
        if kpi:
            return CopilotResponse(answer=f"Gross margin as of {kpi.as_of_date} is **{kpi.gross_margin_pct}%.**", sources=["KPI snapshot"])
        return CopilotResponse(answer="Gross margin data is not available.", sources=[])
    if "ebitda" in q:
        if kpi:
            return CopilotResponse(answer=f"YTD EBITDA as of {kpi.as_of_date} is **${kpi.ebitda_ytd:,.0f}.**", sources=["KPI snapshot"])
        return CopilotResponse(answer="EBITDA data is not available.", sources=[])
    if "ar " in q or "receivable" in q or "ar days" in q:
        if kpi:
            return CopilotResponse(answer=f"AR days as of {kpi.as_of_date} is **{kpi.ar_days} days.**", sources=["KPI snapshot"])
        return CopilotResponse(answer="AR days data is not available.", sources=[])
    if "ap " in q or "payable" in q or "ap days" in q:
        if kpi:
            return CopilotResponse(answer=f"AP days as of {kpi.as_of_date} is **{kpi.ap_days} days.**", sources=["KPI snapshot"])
        return CopilotResponse(answer="AP days data is not available.", sources=[])

    return CopilotResponse(
        answer="I can answer questions about runway, cash balance, burn rate, revenue growth, gross margin, EBITDA, AR days, and AP days. Try: 'What is our runway?' or 'How did revenue compare to last year?'",
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

# Default SOQL for opportunities (ARR / pipeline). RecordType.Name for ARR (renewals only).
DEFAULT_OPPORTUNITY_SOQL = (
    "SELECT Id, Name, Amount, CloseDate, StageName, Type, RecordType.Name, "
    "Account.Id, Account.Name, CreatedDate "
    "FROM Opportunity ORDER BY CloseDate DESC NULLS LAST"
)
# Opportunity products: TotalPrice = MRR; ARR = MRR * 12. Product2.Name (or Name) for product columns.
DEFAULT_OPPORTUNITY_LINE_ITEM_SOQL = (
    "SELECT Id, OpportunityId, Name, Product2.Name, Quantity, UnitPrice, TotalPrice FROM OpportunityLineItem"
)
ARR_MULTIPLIER = 12  # MRR -> ARR

# Products excluded from ARR (not counted in totals or shown as columns). Case-insensitive match.
# Price book: "Verify Monthly Credits", "Kipu API" — excluded; 6 one-time ProServ products are out of scope for ARR.
ARR_PRODUCT_EXCLUDE = frozenset({"iverify monthly credits", "verify monthly credits", "kipu api"})

# Canonical ARR product columns: order = display order (Account, Segment, then these, then Other).
# One-time products (Implementation, Data Migration, Kipu API Set Up, etc.) are not in ARR.
ARR_PRODUCT_COLUMNS = [
    "Dazos CRM Platform (Legacy)",
    "Dazos CRM Platform (Includes 5 Seats)",
    "Billing Company CRM Platform (Includes 5 Seats)",
    "Additional CRM Seats",
    "Marketing Reports Platform Fee (Includes 1 EIN)",
    "IQ Platform Fee (Includes 1 EIN)",
    "Additional IQ/MR EINs",
    "iCampaign Platform",
    "Premium Support",
]
_ARR_PRODUCT_NORMALIZED = {p.strip().lower(): p for p in ARR_PRODUCT_COLUMNS}
# Price book alias: "Additional IQMR EINs" (no slash) -> same column
_ARR_PRODUCT_NORMALIZED["additional iqmr eins"] = "Additional IQ/MR EINs"


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


def _match_arr_product(sf_product_name: str | None) -> str | None:
    """Map Salesforce product name to canonical ARR column, or None -> 'Other'. Uses exact then contains match."""
    if not sf_product_name or not sf_product_name.strip():
        return None
    raw = sf_product_name.strip()
    key = raw.lower()
    if key in _ARR_PRODUCT_NORMALIZED:
        return _ARR_PRODUCT_NORMALIZED[key]
    for norm, canonical in _ARR_PRODUCT_NORMALIZED.items():
        if norm in key or key in norm:
            return canonical
    return None


# Stages that count as "closed" (excluded from pipeline and from renewal ARR).
CLOSED_STAGES = frozenset({"Closed Won", "Closed Lost"})
# Default SOQL for accounts. Add custom fields to the SELECT if needed.
# Default segment when Salesforce Segment__c is empty.
DEFAULT_SEGMENT = "SMB/ MM"

# Account Status = Account_Status__c; Segment = Segment__c (add Sub_Segment__c or other segment field here if your org has it).
DEFAULT_ACCOUNT_SOQL = (
    "SELECT Id, Name, Type, Account_Status__c, Industry, AnnualRevenue, NumberOfEmployees, "
    "BillingCountry, BillingCity, BillingState, Phone, Website, Segment__c, CreatedDate "
    "FROM Account ORDER BY Name"
)


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
        account_records = await asyncio.to_thread(connector.query, DEFAULT_ACCOUNT_SOQL)
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

    try:
        opp_records = await asyncio.to_thread(connector.query, DEFAULT_OPPORTUNITY_SOQL)
    except Exception as e:
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
        record_type_name = (rt or "").strip() or None
        opp = Opportunity(
            sf_id=sf_id,
            name=rec.get("Name"),
            amount=float(rec.get("Amount") or 0),
            close_date=_parse_date(rec.get("CloseDate")),
            stage_name=rec.get("StageName"),
            type=rec.get("Type"),
            record_type_name=record_type_name,
            account_id=rec.get("Account_Id"),
            account_name=rec.get("Account_Name"),
            created_date=_parse_datetime(rec.get("CreatedDate")),
        )
        db.add(opp)

    try:
        line_records = await asyncio.to_thread(connector.query, DEFAULT_OPPORTUNITY_LINE_ITEM_SOQL)
    except Exception as e:
        await db.rollback()
        return {"ok": False, "error": f"OpportunityLineItem sync failed: {e}"}
    await db.execute(delete(OpportunityLineItem))
    for rec in line_records:
        opp_sf_id = rec.get("OpportunityId")
        if not opp_sf_id:
            continue
        total = rec.get("TotalPrice")
        if total is None:
            try:
                total = float(rec.get("UnitPrice") or 0) * float(rec.get("Quantity") or 0)
            except (TypeError, ValueError):
                total = 0
        else:
            total = float(total)
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
        db.add(OpportunityLineItem(
            opportunity_sf_id=opp_sf_id,
            product_name=product_name,
            quantity=float(rec.get("Quantity") or 0),
            unit_price=float(rec.get("UnitPrice") or 0),
            total_price=total,
        ))

    q_renewal_count = select(Opportunity).where(
        Opportunity.stage_name.isnot(None),
        ~Opportunity.stage_name.in_(CLOSED_STAGES),
    )
    r_count = await db.execute(q_renewal_count)
    all_open = r_count.scalars().all()
    renewal_count = sum(1 for o in all_open if _is_renewal_record_type(o.record_type_name))
    return {
        "ok": True,
        "synced_accounts": len(account_records),
        "synced_opportunities": len(opp_records),
        "synced_line_items": len(line_records),
        "renewal_opportunities_count": renewal_count,
        "message": "Accounts, opportunities, and opportunity products synced.",
    }


@app.post("/api/sync/salesforce")
async def sync_salesforce(db: AsyncSession = Depends(get_db)):
    """
    Sync opportunities and accounts from Salesforce into the app.
    Requires SALESFORCE_USERNAME, SALESFORCE_PASSWORD, and SALESFORCE_SECURITY_TOKEN in .env.
    """
    return await _run_salesforce_sync(db)


async def _take_salesforce_eod_snapshot(db: AsyncSession) -> None:
    """Store end-of-day snapshot of all Salesforce data (EST date, UTC timestamp). Caller must commit."""
    from datetime import timezone

    now_utc = datetime.now(timezone.utc)
    today_est = datetime.fromtimestamp(now_utc.timestamp(), tz=EST).date()

    r_acc = await db.execute(select(Account))
    accounts = [{"sf_id": a.sf_id, "name": a.name, "type": a.type, "status": a.status, "segment": (a.segment or "").strip() or DEFAULT_SEGMENT, "industry": a.industry, "annual_revenue": a.annual_revenue, "number_of_employees": a.number_of_employees, "billing_country": a.billing_country, "billing_city": a.billing_city, "billing_state": a.billing_state, "phone": a.phone, "website": a.website, "created_date": a.created_date.isoformat() if a.created_date else None, "synced_at": a.synced_at.isoformat() if a.synced_at else None} for a in r_acc.scalars().all()]
    r_opp = await db.execute(select(Opportunity))
    opportunities = [{"sf_id": o.sf_id, "name": o.name, "amount": o.amount, "close_date": o.close_date.isoformat() if o.close_date else None, "stage_name": o.stage_name, "type": o.type, "record_type_name": o.record_type_name, "account_id": o.account_id, "account_name": o.account_name, "created_date": o.created_date.isoformat() if o.created_date else None, "synced_at": o.synced_at.isoformat() if o.synced_at else None} for o in r_opp.scalars().all()]
    r_li = await db.execute(select(OpportunityLineItem))
    line_items = [{"opportunity_sf_id": li.opportunity_sf_id, "product_name": li.product_name, "quantity": li.quantity, "unit_price": li.unit_price, "total_price": li.total_price, "synced_at": li.synced_at.isoformat() if li.synced_at else None} for li in r_li.scalars().all()]

    payload = {"accounts": accounts, "opportunities": opportunities, "opportunity_line_items": line_items}
    await db.execute(delete(SalesforceEODSnapshot).where(SalesforceEODSnapshot.snapshot_date == today_est))
    snapshot = SalesforceEODSnapshot(
        snapshot_date=today_est,
        snapshot_utc=now_utc.replace(tzinfo=None),
        data_json=json.dumps(payload),
    )
    db.add(snapshot)


async def _scheduled_salesforce_jobs() -> None:
    """Run hourly sync at :59:59 EST and EOD snapshot at 23:59:59 EST."""
    last_sync_hour: Optional[tuple[date, int]] = None  # (date_est, hour_est)
    last_eod_date: Optional[date] = None

    while True:
        try:
            now_est = datetime.now(EST)
            today_est = now_est.date()
            run_hourly = now_est.minute == 59 and now_est.second >= 59
            run_eod = now_est.hour == 23 and now_est.minute == 59 and now_est.second >= 59

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
                    except Exception:
                        await session.rollback()

        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        await asyncio.sleep(30)


# ----- Dashboard KPI (Phase 2: Salesforce only) -----

def _is_renewal_record_type(name: Optional[str]) -> bool:
    """True if record type is Renewal (case-insensitive, trimmed)."""
    return (name or "").strip().lower() == "renewal"


@app.get("/api/dashboard-kpi", response_model=DashboardKPI)
async def get_dashboard_kpi(db: AsyncSession = Depends(get_db)):
    """
    ARR and Pipeline from Salesforce. ARR = sum(TotalPrice) for product lines on open renewal opportunities.
    Pipeline = sum(Amount) for open opportunities (not Closed Won / Closed Lost).
    """
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
            if _is_arr_excluded_product(_normalized_product_name(li.product_name)):
                continue
            mrr += float(li.total_price or 0)
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
            if _is_arr_excluded_product(_normalized_product_name(li.product_name)):
                continue
            opp_sf_id = li.opportunity_sf_id
            opp_to_total[opp_sf_id] = opp_to_total.get(opp_sf_id, 0) + float(li.total_price or 0)

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
        for li in r_lines.scalars().all():
            if _is_arr_excluded_product(_normalized_product_name(li.product_name)):
                continue
            opp_sf_id = li.opportunity_sf_id
            opp_to_total[opp_sf_id] = opp_to_total.get(opp_sf_id, 0) + float(li.total_price or 0)

    # Group by account: (account_id, account_name) -> { count, mrr } then ARR = mrr * 12
    by_account: dict[tuple[str | None, str | None], tuple[int, float]] = {}
    for o in renewal_opps:
        key = (o.account_id, o.account_name or None)
        line_total = opp_to_total.get(o.sf_id) or 0  # MRR
        if key not in by_account:
            by_account[key] = (0, 0.0)
        cnt, mrr = by_account[key]
        by_account[key] = (cnt + 1, mrr + line_total)

    rows = [
        {"account_id": aid, "account_name": (aname or "—"), "open_renewal_count": cnt, "arr": round((mrr * ARR_MULTIPLIER), 2)}
        for (aid, aname), (cnt, mrr) in by_account.items()
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
    for li in lines:
        acc = opp_to_account.get(li.opportunity_sf_id)
        if not acc:
            continue
        raw = _normalized_product_name(li.product_name)
        if _is_arr_excluded_product(raw) or _is_arr_excluded_product(li.product_name):
            continue
        if not raw:
            continue
        if acc not in by_account_product:
            by_account_product[acc] = {p: 0.0 for p in products}
        canonical = _match_arr_product(raw) if raw else None
        canonical = canonical or "Other"
        by_account_product[acc][canonical] = by_account_product[acc].get(canonical, 0) + (li.total_price or 0)
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
        by_product_arr = {p: round((mrr * ARR_MULTIPLIER), 2) for p, mrr in by_product.items()}
        for p in products:
            total_by_product[p] = total_by_product.get(p, 0) + by_product_arr.get(p, 0)
        total_arr = round(sum(by_product_arr.values()), 2)
        grand_total += total_arr
        seg = account_segment.get(aid) if aid else None
        seg = (seg or "").strip() or DEFAULT_SEGMENT
        rows.append({
            "account_id": aid,
            "account_name": aname or "—",
            "segment": seg,
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


@app.get("/api/arr-by-account-product")
async def get_arr_by_account_product(db: AsyncSession = Depends(get_db)):
    """
    ARR by account with product columns (open renewals only). total_price from SF = MRR; ARR = MRR * 12.
    Returns: products (column order), rows (account_name, by_product, total_arr), total_by_product, grand_total.
    """
    return await _get_arr_by_account_product_data(db)


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

    # Build sheet rows: header (Account, Segment, products..., Total ARR), data rows, total row
    header = ["Account", "Segment"] + products + ["Total ARR"]
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
