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
    """One period: label and rows. Closed Lost = 0. NB = ARR__c; expansion / mid-term / upon renewal = Expansion_ARR__c as in API. Pipe coverage = open pipeline / shortfall (MTD/QTD only)."""
    period_label: str
    total: BookingsMTDRow
    new_business: BookingsMTDRow
    expansion: BookingsMTDRow  # mtd = mid-term + upon renewal; plan from sheet expansion column
    expansion_mid_term: Optional[float] = None  # Closed Won Expansion record type only (Expansion_ARR__c)
    expansion_upon_renewal: Optional[float] = None  # Closed Won renewal Expansion_ARR__c (no plan/delta)
    pipe_coverage_total: Optional[float] = None  # total open pipeline ARR / shortfall to plan (MTD/QTD only)
    pipe_coverage_new_business: Optional[float] = None  # open pipeline NB ARR / shortfall to plan (MTD/QTD only)
    pipe_coverage_expansion: Optional[float] = None  # open pipeline expansion ARR / shortfall to plan (MTD/QTD only)


class BookingsMTDResponse(BaseModel):
    """Bookings vs plan: previous month, current MTD, quarter to date."""
    two_months_ago: BookingsPeriod
    previous_month: BookingsPeriod
    current_mtd: BookingsPeriod
    qtd: BookingsPeriod
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
    """Cash KPIs: Billings and Collections. Plan from BS_2026P. Same period layout as Bookings (two months ago, previous month, MTD, QTD)."""
    two_months_ago: CashPeriod
    previous_month: CashPeriod
    current_mtd: CashPeriod
    qtd: CashPeriod
    plan_source: Optional[str] = None
    plan_message: Optional[str] = None
    chargebee_message: Optional[str] = None  # e.g. error or "No invoices in range"


class RenewalsMTDRow(BaseModel):
    """Renewals dashboard row: actual (mtd), plan, % = actual/plan, Δ = actual − plan (delta_k in $K for dollars; for rate row, mtd/plan are 0–1 and delta_k is percentage points)."""

    mtd: float
    plan: Optional[float] = None
    achievement_pct: Optional[float] = None
    delta_k: Optional[float] = None
    is_rate: bool = False


class RenewalsPeriod(BaseModel):
    """Renewals vs plan for one period (same labels as Bookings MTD)."""

    period_label: str
    up_for_renewal: RenewalsMTDRow
    renewed: RenewalsMTDRow
    open: RenewalsMTDRow
    churn: RenewalsMTDRow
    contraction: RenewalsMTDRow
    renewal_rate: RenewalsMTDRow
    cancelled: RenewalsMTDRow


class RenewalsMTDResponse(BaseModel):
    """Renewals KPIs vs ARR_Calculations_2026P (UFR row + BU35/BU52/BU54). Same four periods as Bookings."""

    two_months_ago: RenewalsPeriod
    previous_month: RenewalsPeriod
    current_mtd: RenewalsPeriod
    qtd: RenewalsPeriod
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


class RenewalsOverviewRow(BaseModel):
    """One renewal opportunity: UFR from Original_ARR__c; Renewed from ARR__c when Closed Won / 0 when Closed Lost."""

    account_id: Optional[str] = None
    account_name: str
    opportunity_sf_id: str
    opportunity_name: str
    stage_name: str
    renewal_date: Optional[str] = None  # ISO date; dedicated Renewal Date when set, else Close Date
    midterm_cancellation_after_stage: Optional[str] = None  # "Yes" when Midterm_Cancellation__c is true; null when false
    up_for_renewal_arr: Optional[float] = None  # Original_ARR__c (stored as original_acv)
    renewed_arr: Optional[float] = None  # Closed Won: ARR__c; Closed Lost: 0; open pipeline: null
    delta: Optional[float] = None  # renewed_arr - up_for_renewal_arr when both sides defined


class RenewalsChartMonth(BaseModel):
    """Stacked chart bucket for one renewal month (excludes mid-term cancellation)."""

    month: str  # YYYY-MM
    arr_open: float  # sum of up-for-renewal ARR (original_acv) for open (non-closed) opps
    arr_renewed: float  # UFR total − churned/contracted − open (residual; ≥ 0)
    arr_churned: float  # positive magnitude: −sum(delta) over opps with delta < 0
    count_open: int
    count_renewed: int  # Closed Won
    count_lost: int  # Closed Lost
    arr_renewal_rate: Optional[float] = None  # (ufr on closed opps + sum(delta where delta<0)) / ufr on closed; open excluded
    opp_renewal_rate: Optional[float] = None  # closed won / (closed won + closed lost)
    arr_midterm_cancellation: float = 0.0  # sum of up-for-renewal ARR for mid-term cancellation = Yes (not in stack)
    count_midterm_cancellation: int = 0  # opps with mid-term cancellation = Yes in that renewal month


class RenewalsOverviewResponse(BaseModel):
    rows: list[RenewalsOverviewRow]
    grand_up_for_renewal_arr: float
    grand_renewed_arr: float
    grand_delta: float
    stages: list[str]
    available_months: list[str]  # YYYY-MM from renewal date (or close date fallback), for filter dropdown
    renewals_chart: list[RenewalsChartMonth]  # ~6 months: 3 prior + current + 2 upcoming; excludes mid-term in stacks
    salesforce_base_url: Optional[str] = None
