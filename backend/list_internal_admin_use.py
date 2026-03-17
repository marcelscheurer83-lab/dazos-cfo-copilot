import sqlite3
from pathlib import Path

db_path = Path(__file__).with_name("cfo.db")

conn = sqlite3.connect(db_path)
cur = conn.cursor()

cur.execute(
    """
    SELECT sf_id, name, stage_name, close_date
    FROM opportunities
    WHERE record_type_name = 'Internal Admin Use'
    ORDER BY close_date
    """
)
rows = cur.fetchall()

print(f"Total opportunities with record_type_name='Internal Admin Use': {len(rows)}")
for sf_id, name, stage, close_date in rows:
    print(sf_id, "|", name, "| stage =", stage, "| close_date =", close_date)

conn.close()
