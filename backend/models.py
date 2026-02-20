"""Financial data models for Dazos CFO Copilot."""
from sqlalchemy import Column, Integer, String, Float, Date, DateTime, Text
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
    created_date = Column(DateTime, nullable=True)
    synced_at = Column(DateTime, server_default=func.now())


class QuickBooksReportSnapshot(Base):
    """Stored snapshot of a QuickBooks report (Phase 1c)."""
    __tablename__ = "quickbooks_report_snapshots"
    id = Column(Integer, primary_key=True)
    report_type = Column(String(32), nullable=False)  # pl, balance_sheet, cash_flow
    as_of = Column(DateTime, server_default=func.now())
    data_json = Column(Text, nullable=False)  # Full report JSON from QB API


class Opportunity(Base):
    """Synced from Salesforce (Phase 1b) for ARR and pipeline."""
    __tablename__ = "opportunities"
    id = Column(Integer, primary_key=True)
    sf_id = Column(String(18), unique=True, nullable=False)  # Salesforce Id
    name = Column(String(255), nullable=True)
    amount = Column(Float, default=0)
    close_date = Column(Date, nullable=True)
    stage_name = Column(String(128), nullable=True)
    type = Column(String(128), nullable=True)  # Opportunity type
    record_type_name = Column(String(128), nullable=True)  # RecordType.Name, e.g. 'Renewal'
    account_id = Column(String(18), nullable=True)
    account_name = Column(String(255), nullable=True)
    created_date = Column(DateTime, nullable=True)
    synced_at = Column(DateTime, server_default=func.now())


class SalesforceEODSnapshot(Base):
    """End-of-day snapshot of all Salesforce data (accounts, opportunities, opportunity_line_items) at 23:59:59 EST for historical analysis."""
    __tablename__ = "salesforce_eod_snapshots"
    id = Column(Integer, primary_key=True)
    snapshot_date = Column(Date, nullable=False, unique=True)  # Date in EST (day this EOD belongs to)
    snapshot_utc = Column(DateTime, nullable=False)  # When the snapshot was taken (UTC)
    data_json = Column(Text, nullable=False)  # JSON: { "accounts": [...], "opportunities": [...], "opportunity_line_items": [...] }


class OpportunityLineItem(Base):
    """Synced from Salesforce — product lines on opportunities. total_price = MRR (monthly); ARR = total_price * 12."""
    __tablename__ = "opportunity_line_items"
    id = Column(Integer, primary_key=True)
    opportunity_sf_id = Column(String(18), nullable=False)  # Opportunity.Id in Salesforce
    product_name = Column(String(255), nullable=True)  # Product2.Name
    quantity = Column(Float, default=0)
    unit_price = Column(Float, default=0)
    total_price = Column(Float, default=0)  # MRR (monthly); ARR = total_price * 12
    synced_at = Column(DateTime, server_default=func.now())
