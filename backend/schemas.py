"""Pydantic schemas for API request/response."""
from datetime import date, datetime
from pydantic import BaseModel
from typing import Optional


class DashboardKPI(BaseModel):
    """Dashboard KPI Summary from Salesforce (Phase 2): ARR and Pipeline only."""
    arr: float
    pipeline: float
    salesforce_synced_at: Optional[datetime] = None


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
