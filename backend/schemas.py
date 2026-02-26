"""Pydantic schemas for API request/response."""
from datetime import date, datetime
from pydantic import BaseModel
from typing import Optional


class DashboardKPI(BaseModel):
    """Dashboard KPI Summary from Salesforce (Phase 2): ARR and Pipeline only."""
    arr: float
    pipeline: float
    salesforce_synced_at: Optional[datetime] = None


class BookingsMTDRow(BaseModel):
    """One row for dashboard: actual, plan, % achievement, delta $K."""
    mtd: float
    plan: Optional[float] = None
    achievement_pct: Optional[float] = None
    delta_k: Optional[float] = None  # actual - plan in thousands


class BookingsPeriod(BaseModel):
    """One period: label (e.g. Jan 26, Feb 26 MTD, Q1 26 QTD) and rows. Expansion breakdown: mid_term (closed won expansions), upon_renewal (renewals). Pipe coverage = open pipeline ARR / shortfall to plan (MTD/QTD only)."""
    period_label: str
    total: BookingsMTDRow
    new_business: BookingsMTDRow
    expansion: BookingsMTDRow
    expansion_mid_term: Optional[float] = None  # booking ARR from closed won expansions (no plan/delta)
    expansion_upon_renewal: Optional[float] = None  # booking ARR from renewals (no plan/delta)
    pipe_coverage_total: Optional[float] = None  # total open pipeline ARR / shortfall to plan (MTD/QTD only)
    pipe_coverage_new_business: Optional[float] = None  # open pipeline NB ARR / shortfall to plan (MTD/QTD only)
    pipe_coverage_expansion: Optional[float] = None  # open pipeline expansion ARR / shortfall to plan (MTD/QTD only)


class BookingsMTDResponse(BaseModel):
    """Bookings vs plan: previous month, current MTD, quarter to date."""
    previous_month: BookingsPeriod
    current_mtd: BookingsPeriod
    qtd: BookingsPeriod
    plan_source: Optional[str] = None
    plan_message: Optional[str] = None


class RenewalsMTDPeriod(BaseModel):
    """Renewals metrics for one period: Total, Renewed, Open, Churn, Contraction, Renewal rate (ARR-based)."""
    period_label: Optional[str] = None
    total: BookingsMTDRow
    renewed: BookingsMTDRow
    open: BookingsMTDRow
    churn: BookingsMTDRow
    contraction: BookingsMTDRow
    renewal_rate: BookingsMTDRow  # mtd/plan as percentage (e.g. 85.2)


class RenewalsMTDResponse(BaseModel):
    """Renewals vs plan: previous month, current MTD, quarter to date. Plan from sheet rows 13 (churn), 14 (contraction), 52 (renewal rate)."""
    previous_month: RenewalsMTDPeriod
    current_mtd: RenewalsMTDPeriod
    qtd: RenewalsMTDPeriod
    plan_source: Optional[str] = None
    plan_message: Optional[str] = None


class CashPeriod(BaseModel):
    """One period: Billings and Collections plan and actuals (actuals from Chargebee). % and delta vs plan."""
    period_label: str
    billings_plan: Optional[float] = None
    collections_plan: Optional[float] = None
    billings_actual: Optional[float] = None
    collections_actual: Optional[float] = None
    billings_achievement_pct: Optional[float] = None
    billings_delta_k: Optional[float] = None  # (actual - plan) / 1000
    collections_achievement_pct: Optional[float] = None
    collections_delta_k: Optional[float] = None


class CashMTDResponse(BaseModel):
    """Cash KPIs: Billings and Collections. Plan from BS_2026P. Same period layout as Bookings (previous month, MTD, QTD)."""
    previous_month: CashPeriod
    current_mtd: CashPeriod
    qtd: CashPeriod
    plan_source: Optional[str] = None
    plan_message: Optional[str] = None
    chargebee_message: Optional[str] = None  # e.g. error or "No invoices in range"


class KPISummary(BaseModel):
    as_of_date: date
    cash_balance: float
    monthly_burn: float
    runway_months: Optional[float] = None
    revenue_ytd: float
    revenue_prior_ytd: float
    revenue_growth_pct: Optional[float] = None
    gross_margin_pct: float
    ebitda_ytd: float
    ar_days: float
    ap_days: float


class PnLLineOut(BaseModel):
    period_end: date
    line_type: str
    category: str
    amount: float
    is_subtotal: bool

    class Config:
        from_attributes = True


class CashFlowLineOut(BaseModel):
    period_end: date
    section: str
    category: str
    amount: float

    class Config:
        from_attributes = True


class BudgetVsActualOut(BaseModel):
    period_end: date
    category: str
    budget_amount: float
    actual_amount: float
    variance: float
    variance_pct: Optional[float] = None

    class Config:
        from_attributes = True


class CopilotRequest(BaseModel):
    question: str


class CopilotResponse(BaseModel):
    answer: str
    sources: Optional[list[str]] = None
