"""Seed database with sample Dazos financial data."""
from datetime import date, timedelta
from sqlalchemy import select, text
from sqlalchemy.exc import OperationalError
from database import engine, AsyncSessionLocal
from models import Base, Company, KPI, PnLLine, CashFlowLine, BudgetLine


async def create_tables():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    # Add columns/tables added after initial schema
    async with engine.begin() as conn:
        for stmt in [
            "ALTER TABLE accounts ADD COLUMN status VARCHAR(128)",
            "ALTER TABLE accounts ADD COLUMN segment VARCHAR(128)",
            "ALTER TABLE opportunities ADD COLUMN record_type_name VARCHAR(128)",
            "ALTER TABLE opportunity_line_items ADD COLUMN product_name VARCHAR(255)",
        ]:
            try:
                await conn.execute(text(stmt))
            except OperationalError as e:
                if "duplicate column name" not in str(e).lower():
                    raise


async def seed():
    await create_tables()
    async with AsyncSessionLocal() as session:
        if await session.scalar(select(Company).limit(1)):
            return  # already seeded
        session.add(Company(id=1, name="Dazos", fiscal_year_end_month=12))
        session.add(KPI(
            as_of_date=date(2025, 2, 28),
            cash_balance=2_450_000,
            monthly_burn=185_000,
            revenue_ytd=1_240_000,
            revenue_prior_ytd=980_000,
            gross_margin_pct=72.5,
            ebitda_ytd=-95_000,
            ar_days=42,
            ap_days=38,
        ))
        # P&L last 3 months
        for i, (m, d) in enumerate([(12, 31), (1, 31), (2, 28)]):
            y = 2024 if m == 12 else 2025
            period = date(y, m, d)
            session.add(PnLLine(period_end=period, line_type="revenue", category="Product", amount=380_000 + i * 15_000, is_subtotal=0))
            session.add(PnLLine(period_end=period, line_type="revenue", category="Services", amount=45_000, is_subtotal=0))
            session.add(PnLLine(period_end=period, line_type="revenue", category="Total Revenue", amount=425_000 + i * 15_000, is_subtotal=1))
            session.add(PnLLine(period_end=period, line_type="cogs", category="COGS", amount=-(115_000 + i * 4_000), is_subtotal=0))
            session.add(PnLLine(period_end=period, line_type="opex", category="R&D", amount=-(125_000 + i * 2_000), is_subtotal=0))
            session.add(PnLLine(period_end=period, line_type="opex", category="Sales & Marketing", amount=-(95_000 + i * 3_000), is_subtotal=0))
            session.add(PnLLine(period_end=period, line_type="opex", category="G&A", amount=-55_000, is_subtotal=0))
            session.add(PnLLine(period_end=period, line_type="opex", category="Total Opex", amount=-(275_000 + i * 5_000), is_subtotal=1))
            session.add(PnLLine(period_end=period, line_type="other", category="EBITDA", amount=-(35_000 - i * 6_000), is_subtotal=1))
        # Cash flow
        for m, d in [(1, 31), (2, 28)]:
            period = date(2025, m, d)
            session.add(CashFlowLine(period_end=period, section="operating", category="Net income adj.", amount=-38_000 if m == 1 else -32_000))
            session.add(CashFlowLine(period_end=period, section="operating", category="D&A", amount=12_000))
            session.add(CashFlowLine(period_end=period, section="operating", category="Change in AR", amount=-28_000 if m == 1 else -15_000))
            session.add(CashFlowLine(period_end=period, section="operating", category="Change in AP", amount=18_000 if m == 1 else 8_000))
            session.add(CashFlowLine(period_end=period, section="investing", category="CapEx", amount=-22_000 if m == 1 else -10_000))
            session.add(CashFlowLine(period_end=period, section="financing", category="Debt draw", amount=0))
        # Budget vs actual
        feb = date(2025, 2, 28)
        for cat, budget, actual in [
            ("R&D", 130_000, 127_000),
            ("Sales & Marketing", 100_000, 98_000),
            ("G&A", 55_000, 58_000),
        ]:
            session.add(BudgetLine(period_end=feb, category=cat, budget_amount=budget, actual_amount=actual))
        await session.commit()
