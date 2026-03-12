import sqlite3
from pathlib import Path

db_path = Path(__file__).with_name("cfo.db")
conn = sqlite3.connect(db_path)
cur = conn.cursor()

print("Opportunities with 'Serenity' in name or account_name:\n")
cur.execute(
    """
    SELECT sf_id, name, stage_name, record_type_name, account_name,
           close_date, renewal_date, original_acv, mrr, contract_start_date, contract_end_date
    FROM opportunities
    WHERE name LIKE '%Serenity%' OR account_name LIKE '%Serenity%'
    ORDER BY close_date
    """
)
rows = cur.fetchall()
for r in rows:
    print(r)

conn.close()
