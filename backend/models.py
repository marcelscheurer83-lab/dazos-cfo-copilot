"""Financial data models for Dazos CFO Copilot."""
from sqlalchemy import Column, Integer, String, Float, Date, DateTime, Text, UniqueConstraint
from sqlalchemy.sql import func
from database import Base


class Company(Base):
    __tablename__ = "companies"
    id = Column(Integer, primary_key=True)
    name = Column(String(128), nullable=False)
    fiscal_year_end_month = Column(Integer, default=12)


class KPI(Base):
    __tablename__ = "kpis"
    id = Column(Integer, primary_key=True)
    as_of_date = Column(Date, nullable=False)
    cash_balance = Column(Float, default=0)
    monthly_burn = Column(Float, default=0)
    revenue_ytd = Column(Float, default=0)
    revenue_prior_ytd = Column(Float, default=0)
    gross_margin_pct = Column(Float, default=0)
    ebitda_ytd = Column(Float, default=0)
    ar_days = Column(Float, default=0)
    ap_days = Column(Float, default=0)


class PnLLine(Base):
    __tablename__ = "pnl_lines"
    id = Column(Integer, primary_key=True)
    period_end = Column(Date, nullable=False)
    line_type = Column(String(32), nullable=False)  # revenue, cogs, opex, other
    category = Column(String(128), nullable=False)
    amount = Column(Float, default=0)
    is_subtotal = Column(Integer, default=0)


class CashFlowLine(Base):
    __tablename__ = "cash_flow_lines"
    id = Column(Integer, primary_key=True)
    period_end = Column(Date, nullable=False)
    section = Column(String(32), nullable=False)  # operating, investing, financing
    category = Column(String(128), nullable=False)
    amount = Column(Float, default=0)


class BudgetLine(Base):
    __tablename__ = "budget_lines"
    id = Column(Integer, primary_key=True)
    period_end = Column(Date, nullable=False)
    category = Column(String(128), nullable=False)
    budget_amount = Column(Float, default=0)
    actual_amount = Column(Float, default=0)


class SheetSnapshot(Base):
    """Stored snapshot of a Google Sheet range after sync (Phase 1a)."""
    __tablename__ = "sheet_snapshots"
    id = Column(Integer, primary_key=True)
    source = Column(String(64), nullable=False, default="google_sheets")
    range_name = Column(String(128), nullable=False)  # e.g. "Plan!A1:Z50"
    as_of = Column(DateTime, server_default=func.now())
    data_json = Column(Text, nullable=False)  # JSON array of rows (list of lists)


class Account(Base):
    """Synced from Salesforce (Phase 1b)."""
    __tablename__ = "accounts"
    id = Column(Integer, primary_key=True)
    sf_id = Column(String(18), unique=True, nullable=False)  # Salesforce Id
    name = Column(String(255), nullable=True)
    type = Column(String(128), nullable=True)  # Account type
    status = Column(String(128), nullable=True)  # Account status (e.g. Active; custom field may be Status__c)
    industry = Column(String(128), nullable=True)
    annual_revenue = Column(Float, nullable=True)
    number_of_employees = Column(Integer, nullable=True)
    billing_country = Column(String(128), nullable=True)
    billing_city = Column(String(128), nullable=True)
    billing_state = Column(String(64), nullable=True)
    phone = Column(String(64), nullable=True)
    website = Column(String(512), nullable=True)
    segment = Column(String(128), nullable=True)  # Segment__c or similar from Salesforce
    ae_owner = Column(String(255), nullable=True)  # Salesforce Account.AE_Owner__c
    owner_name = Column(String(255), nullable=True)  # Salesforce Account.Owner.Name (standard record owner)
    partner_affiliate_revenue_share = Column(Float, nullable=True)  # Salesforce Partner/Affiliate Revenue Share (% retained)
    created_date = Column(DateTime, nullable=True)
    synced_at = Column(DateTime, server_default=func.now())


class QuickBooksReportSnapshot(Base):
    """Stored snapshot of a QuickBooks report (Phase 1c)."""
    __tablename__ = "quickbooks_report_snapshots"
    id = Column(Integer, primary_key=True)
    report_type = Column(String(32), nullable=False)  # pl, balance_sheet, cash_flow
    as_of = Column(DateTime, server_default=func.now())
    data_json = Column(Text, nullable=False)  # Full report JSON from QB API


class ChargebeeSnapshot(Base):
    """Stored snapshot of Chargebee list API response for billing reconciliation."""
    __tablename__ = "chargebee_snapshots"
    id = Column(Integer, primary_key=True)
    report_type = Column(String(32), nullable=False)  # subscriptions, invoices
    as_of = Column(DateTime, server_default=func.now())
    data_json = Column(Text, nullable=False)  # Full list response: { "list": [...], "next_offset": "..." }


class Opportunity(Base):
    """Synced from Salesforce (Phase 1b) for ARR and pipeline."""
    __tablename__ = "opportunities"
    id = Column(Integer, primary_key=True)
    sf_id = Column(String(18), unique=True, nullable=False)  # Salesforce Id
    name = Column(String(255), nullable=True)
    amount = Column(Float, default=0)
    close_date = Column(Date, nullable=True)
    renewal_date = Column(Date, nullable=True)  # Optional; from SF custom e.g. Renewal_Date__c. Used for renewals when set.
    original_acv = Column(Float, nullable=True)  # Optional; from SF Original_ACV__c = ARR up for renewal (UFR ARR).
    expansion_arr = Column(Float, nullable=True)  # Optional; from SF Expansion_ARR__c = positive renewal expansion uplift.
    stage_name = Column(String(128), nullable=True)
    type = Column(String(128), nullable=True)  # Opportunity type
    record_type_name = Column(String(128), nullable=True)  # RecordType.Name, e.g. 'Renewal'
    account_id = Column(String(18), nullable=True)
    account_name = Column(String(255), nullable=True)
    mrr = Column(Float, nullable=True)  # MRR from Opportunity Finance Details (e.g. MRR__c); ARR = mrr * 12
    contract_start_date = Column(Date, nullable=True)  # Optional; from SF e.g. Contract_Start_Date__c (New Business)
    contract_end_date = Column(Date, nullable=True)  # Optional; from SF e.g. Contract_End_Date__c (New Business)
    owner_name = Column(String(255), nullable=True)  # Opportunity Owner (User) name from Salesforce
    midterm_cancellation = Column(Integer, default=0)  # 1 = Midterm Cancellation true on renewal (subscription ended at this opp's contract_end_date)
    created_date = Column(DateTime, nullable=True)
    synced_at = Column(DateTime, server_default=func.now())


class OpportunityRecordTypeOverride(Base):
    """Manual overwrite of opportunity record type for reporting (e.g. treat as Amendment instead of Renewal). Logged with note."""
    __tablename__ = "opportunity_record_type_overrides"
    id = Column(Integer, primary_key=True)
    opportunity_sf_id = Column(String(18), unique=True, nullable=False)
    record_type_name = Column(String(128), nullable=False)  # Override value, e.g. 'Amendment'
    note = Column(String(512), nullable=True)
    created_at = Column(DateTime, server_default=func.now())


class ActiveARRAccountOverride(Base):
    """Manual override for Active ARR by account (e.g. use open renewal ARR as Active ARR). Logged with note."""
    __tablename__ = "active_arr_account_overrides"
    id = Column(Integer, primary_key=True)
    account_name = Column(String(255), nullable=False)  # Match by account name (case-insensitive)
    use_open_renewal_arr = Column(Integer, default=1)   # 1 = use open renewal ARR as Active ARR for this account
    note = Column(String(512), nullable=True)
    created_at = Column(DateTime, server_default=func.now())


class SalesforceEODSnapshot(Base):
    """End-of-day snapshot of all Salesforce data (accounts, opportunities, opportunity_line_items) at 23:59:59 EST for historical analysis."""
    __tablename__ = "salesforce_eod_snapshots"
    id = Column(Integer, primary_key=True)
    snapshot_date = Column(Date, nullable=False, unique=True)  # Date in EST (day this EOD belongs to)
    snapshot_utc = Column(DateTime, nullable=False)  # When the snapshot was taken (UTC)
    data_json = Column(Text, nullable=False)  # JSON: { "accounts": [...], "opportunities": [...], "opportunity_line_items": [...] }


class ARRScheduleDaily(Base):
    """
    Materialized ARR by account, by day. One row = ARR active at end of snapshot_date for one account.
    Populated from EOD snapshots (same logic as customer ARR view). Enables ARR bridge, retention, NRR, renewal rates.
    """
    __tablename__ = "arr_schedule_daily"
    __table_args__ = (UniqueConstraint("snapshot_date", "account_id", "account_name", name="uq_arr_schedule_daily_date_account"),)
    id = Column(Integer, primary_key=True)
    snapshot_date = Column(Date, nullable=False)  # As-of date (EOD); ARR active at end of this day
    account_id = Column(String(18), nullable=True)  # Salesforce account ID
    account_name = Column(String(255), nullable=False)
    segment = Column(String(128), nullable=True)
    subscription_end_date = Column(Date, nullable=True)  # Latest renewal close_date for this account
    total_arr = Column(Float, nullable=False, default=0)
    by_product_json = Column(Text, nullable=True)  # JSON: {"IQ Platform": 12000, "Add. MR/IQ": 5000, ...}


class ARRSchedulePeriod(Base):
    """
    Editable ARR schedule: one row = one account's active subscription period (start/end + ARR).
    Source of truth for historical ARR; can be corrected when a closed opportunity is updated in SF.
    'ARR as of date D' = sum of total_arr for periods where period_start <= D <= period_end.
    Aligns with the financial model sheet (ARR schedule from row 185): list of accounts with
    subscription start, subscription end, and ARR active during that period.
    """
    __tablename__ = "arr_schedule_periods"
    id = Column(Integer, primary_key=True)
    account_id = Column(String(18), nullable=True)  # Salesforce account ID
    account_name = Column(String(255), nullable=False)
    segment = Column(String(128), nullable=True)
    period_start = Column(Date, nullable=False)  # First day this ARR is active
    period_end = Column(Date, nullable=False)  # Last day (inclusive); use same as period_start for single-day
    total_arr = Column(Float, nullable=False, default=0)
    by_product_json = Column(Text, nullable=True)  # JSON: {"IQ Platform": 12000, ...}
    source = Column(String(32), nullable=True)  # 'salesforce' | 'manual' | 'backfill'
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class OpportunityLineItem(Base):
    """Synced from Salesforce — product lines on opportunities. total_price = MRR (monthly); ARR = total_price * 12.
    When same product has multiple segments (different term/price), ARR = (sum(term_months_i * price_i) / sum(term_months_i)) * 12."""
    __tablename__ = "opportunity_line_items"
    id = Column(Integer, primary_key=True)
    opportunity_sf_id = Column(String(18), nullable=False)  # Opportunity.Id in Salesforce
    product_name = Column(String(255), nullable=True)  # Product2.Name
    quantity = Column(Float, default=0)
    unit_price = Column(Float, default=0)
    total_price = Column(Float, default=0)  # MRR (monthly) for that segment
    term_months = Column(Float, nullable=True)  # Term in months for this segment (enables period-weighted ARR)
    service_start_date = Column(Date, nullable=True)  # Optional; from SF ServiceDate
    service_end_date = Column(Date, nullable=True)   # Optional; from SF EndDate or custom
    synced_at = Column(DateTime, server_default=func.now())
