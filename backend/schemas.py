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
    """One period: label (e.g. Jan 26, Feb 26 MTD, Q1 26 QTD) and rows."""
    period_label: str
    total: BookingsMTDRow
    new_business: BookingsMTDRow
    expansion: BookingsMTDRow


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
