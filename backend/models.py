"""Financial data models for Dazos CFO Cockpit."""
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
    customer_success_manager = Column(String(255), nullable=True)  # Salesforce Customer_Success_Manager__c
    ae_owner = Column(String(255), nullable=True)  # Salesforce Account.AE_Owner__c
    owner_name = Column(String(255), nullable=True)  # Salesforce Account.Owner.Name (standard record owner)
    partner_affiliate_revenue_share = Column(Float, nullable=True)  # Salesforce Partner/Affiliate Revenue Share (% retained)
    created_date = Column(DateTime, nullable=True)
    # Customer health & risk fields (synced from Salesforce when SF_ACCOUNT_* env vars are configured)
    health_score = Column(Float, nullable=True)               # Master/composite health score (e.g. Master_Health_Score_Calc__c)
    risk_score = Column(Float, nullable=True)                 # Risk score (e.g. Risk_Score__c)
    product_usage_score = Column(Float, nullable=True)        # Product usage score (e.g. Product_Usage_Score__c)
    financial_score = Column(Float, nullable=True)            # Financial health score (e.g. Financial_Score__c)
    customer_engagement_score = Column(Float, nullable=True)  # Engagement score (e.g. Customer_Engagement_Score__c)
    support_score = Column(Float, nullable=True)              # Support score (e.g. Support_Score__c)
    customer_journey_phase = Column(String(64), nullable=True) # e.g. Implementation, Adoption (Customer_Journey_Phase__c)
    payment_status = Column(String(64), nullable=True)        # Current, Past Due, etc. (Payment_Status__c)
    outstanding_balance = Column(Float, nullable=True)        # Outstanding unpaid balance
    overdue_invoice_count = Column(Integer, nullable=True)    # Count of overdue invoices
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
    report_type = Column(String(32), nullable=False)  # subscriptions, invoices, cash_invoices, cash_payments
    as_of = Column(DateTime, server_default=func.now())
    data_json = Column(Text, nullable=False)  # Full list response: { "list": [...], "next_offset": "..." }


class AppDatasetState(Base):
    """Singleton (id=1): last unified app dataset refresh from the Dashboard (Salesforce, Sheets, Chargebee)."""

    __tablename__ = "app_dataset_state"
    id = Column(Integer, primary_key=True)  # always 1
    # UTC instant; SQLite stores ISO string. Prefer aware writes (datetime.now(timezone.utc)).
    updated_at = Column(DateTime(timezone=True), nullable=True)
    last_refresh_ok = Column(Integer, default=0)  # 1 = last run succeeded
    last_error = Column(Text, nullable=True)
    steps_json = Column(Text, nullable=True)  # JSON: [{ "step": "...", "ok": bool, "detail": ... }, ...]


class Opportunity(Base):
    """Synced from Salesforce (Phase 1b) for ARR and pipeline."""
    __tablename__ = "opportunities"
    id = Column(Integer, primary_key=True)
    sf_id = Column(String(18), unique=True, nullable=False)  # Salesforce Id
    name = Column(String(255), nullable=True)
    amount = Column(Float, default=0)
    close_date = Column(Date, nullable=True)
    renewal_date = Column(Date, nullable=True)  # Optional; from SF custom e.g. Renewal_Date__c. Used for renewals when set.
    original_acv = Column(Float, nullable=True)  # Optional; UFR from SF Original_ARR__c (via sync helper; may fall back per org).
    opportunity_arr = Column(Float, nullable=True)  # Optional; SF ARR__c (renewed ARR on closed-won renewals).
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
    forecast_category = Column(String(64), nullable=True)  # SF Forecast__c picklist: Commit, Best Case, Upside, Positive Outlook, Neutral, At Risk, Intent to Churn
    created_date = Column(DateTime, nullable=True)
    # AI-agent enrichment fields (optional; only populated when env vars are configured)
    next_step = Column(Text, nullable=True)              # SF standard NextStep field
    lead_type = Column(String(128), nullable=True)       # e.g. Lead_Type__c
    current_crm = Column(String(128), nullable=True)     # e.g. Current_CRM__c
    current_voip = Column(String(128), nullable=True)    # e.g. Current_VOIP__c
    deal_tier = Column(String(64), nullable=True)         # Deal_Tier__c (Commit / Strong Upside / Weak Upside / Hail Mary)
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


class MonthlyArrSnapshot(Base):
    """
    Materialized end-of-month live ARR per account, covering Jan 2022 → current month.
    Only non-zero rows are stored (missing = $0 ARR for that account-month).
    Fully replaced on every dataset refresh via _refresh_monthly_arr_snapshot().
    Source: ARR_Schedule Google Sheet (Jan 2022 – Nov 2025) + Salesforce opps (Dec 2025+).
    """
    __tablename__ = "monthly_arr_snapshots"
    id = Column(Integer, primary_key=True)
    account_name = Column(String(256), nullable=False, index=True)
    month_key = Column(String(7), nullable=False, index=True)   # YYYY-MM
    arr = Column(Float, nullable=False)
    refreshed_at = Column(DateTime, server_default=func.now())
    __table_args__ = (
        UniqueConstraint("account_name", "month_key", name="uq_monthly_arr_account_month"),
    )


class ForecastSnapshot(Base):
    """Point-in-time forecast saved on the 1st of each month (or on-demand).
    Enables forecast accuracy tracking: compare snapshot forecast to final actuals at month/quarter end."""
    __tablename__ = "forecast_snapshots"
    __table_args__ = (UniqueConstraint("snapshot_date", "target_month", name="uq_forecast_snapshot"),)
    id = Column(Integer, primary_key=True)
    snapshot_date = Column(Date, nullable=False)       # Date the snapshot was taken
    target_month = Column(String(7), nullable=False)   # YYYY-MM being forecast
    # New Business
    nb_actuals = Column(Float, nullable=True)
    nb_pipeline_weighted = Column(Float, nullable=True)
    nb_in_quarter_est = Column(Float, nullable=True)
    nb_forecast = Column(Float, nullable=True)           # actuals + weighted pipeline
    nb_adjusted_forecast = Column(Float, nullable=True)  # forecast + in-quarter est
    nb_target = Column(Float, nullable=True)
    # Expansion
    exp_actuals = Column(Float, nullable=True)
    exp_pipeline_weighted = Column(Float, nullable=True)
    exp_in_quarter_est = Column(Float, nullable=True)
    exp_forecast = Column(Float, nullable=True)
    exp_adjusted_forecast = Column(Float, nullable=True)
    exp_target = Column(Float, nullable=True)
    # Totals
    total_forecast = Column(Float, nullable=True)
    total_adjusted_forecast = Column(Float, nullable=True)
    total_target = Column(Float, nullable=True)
    # AI forecast (if available)
    nb_ai_forecast = Column(Float, nullable=True)
    exp_ai_forecast = Column(Float, nullable=True)
    created_at = Column(DateTime, server_default=func.now())


class OppFieldHistory(Base):
    """Stage, close-date, and amount changes synced from Salesforce OpportunityFieldHistory.
    Used by the AI forecast scoring agent to assess deal velocity and close-date stability."""
    __tablename__ = "opp_field_history"
    __table_args__ = (UniqueConstraint("sf_opp_id", "field", "changed_at", name="uq_opp_field_history"),)
    id = Column(Integer, primary_key=True)
    sf_opp_id = Column(String(18), nullable=False, index=True)   # OpportunityId
    field = Column(String(64), nullable=False)                    # StageName | CloseDate | Amount
    old_value = Column(Text, nullable=True)
    new_value = Column(Text, nullable=True)
    changed_at = Column(DateTime, nullable=False)                 # CreatedDate from SF
    synced_at = Column(DateTime, server_default=func.now())


class OppNote(Base):
    """Notes synced from Salesforce (Note object) linked to an Opportunity.
    Used by the AI forecast agent for qualitative deal intelligence."""
    __tablename__ = "opp_notes"
    id = Column(Integer, primary_key=True)
    sf_note_id = Column(String(18), unique=True, nullable=False)
    sf_opp_id = Column(String(18), nullable=False, index=True)
    title = Column(String(512), nullable=True)
    body = Column(Text, nullable=True)
    created_date = Column(DateTime, nullable=True)
    synced_at = Column(DateTime, server_default=func.now())


class OppActivity(Base):
    """Tasks (calls, emails, meetings) synced from Salesforce linked to an Opportunity.
    Used by the AI forecast agent as an engagement-recency signal."""
    __tablename__ = "opp_activities"
    id = Column(Integer, primary_key=True)
    sf_task_id = Column(String(18), unique=True, nullable=False)
    sf_opp_id = Column(String(18), nullable=False, index=True)
    subject = Column(String(512), nullable=True)
    description = Column(Text, nullable=True)
    activity_date = Column(Date, nullable=True)
    activity_type = Column(String(64), nullable=True)   # Email, Call, Meeting, etc.
    synced_at = Column(DateTime, server_default=func.now())


class AIForecastObservations(Base):
    """Executive-level observations generated by the AI agent after each scoring run.
    obs_type: 'forecast' (revenue/forecast focus) | 'pipeline' (stage/tier/velocity) | 'renewals' (renewal health/risk)."""
    __tablename__ = "ai_forecast_observations"
    __table_args__ = (UniqueConstraint("scored_at", "obs_type", name="uq_ai_obs_scored_type"),)
    id = Column(Integer, primary_key=True)
    scored_at = Column(DateTime, nullable=False, index=True)
    obs_type = Column(String(16), nullable=False, default="forecast")  # 'forecast' | 'pipeline' | 'renewals'
    quarter_label = Column(String(16), nullable=True)
    observations_json = Column(Text, nullable=True)   # JSON array of bullet strings
    created_at = Column(DateTime, server_default=func.now())


class DealAIScore(Base):
    """LLM-generated win-probability score and reasoning per open opportunity, produced by the nightly AI forecast agent."""
    __tablename__ = "deal_ai_scores"
    __table_args__ = (UniqueConstraint("sf_opp_id", "scored_at", name="uq_deal_ai_score_opp_run"),)
    id = Column(Integer, primary_key=True)
    sf_opp_id = Column(String(18), nullable=False, index=True)
    scored_at = Column(DateTime, nullable=False, index=True)      # When the scoring run executed
    probability = Column(Float, nullable=False)                   # 0.0–1.0
    reasoning = Column(Text, nullable=True)                       # 1–2 sentence explanation from LLM
    model_used = Column(String(64), nullable=True)                # e.g. gpt-4o-mini
    input_snapshot_json = Column(Text, nullable=True)            # Context sent to LLM (auditability)


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
