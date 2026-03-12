import sqlite3
from pathlib import Path

db_path = Path(__file__).with_name("cfo.db")
conn = sqlite3.connect(db_path)
cur = conn.cursor()

opp_id = "006Vq00000LYUMCIA5"

print("Opportunity line items for Serenity Health Group renewal:", opp_id)
cur.execute(
    """
    SELECT opportunity_sf_id, product_name, quantity, unit_price, total_price, term_months
    FROM opportunity_line_items
    WHERE opportunity_sf_id = ?
    """,
    (opp_id,),
)
rows = cur.fetchall()
for r in rows:
    print(r)

conn.close()
