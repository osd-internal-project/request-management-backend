#!/usr/bin/env python3
"""CD-91 — create the "ยอดขายและคำขอค้าง" dashboard in Metabase, reading the
Data Mart (`mart` schema) only. Card definitions are in docs/metabase.md.

Same contract as build_dashboards.py: stdlib only, running twice creates a
second copy — meant for a fresh instance or after deleting the old one.

Usage:
    MB_URL=http://192.168.31.51:3400 \
    MB_SESSION=<X-Metabase-Session id> \
    MB_DB_ID=<database id of "CTD Reporting"> \
    python3 infra/metabase/build_mart_dashboard.py

Then add the printed dashboard id on the BI settings screen (ตั้งค่า BI) so it
appears in the system's BI menu.
"""
import json
import os
import sys
import urllib.request

BASE = os.environ.get("MB_URL", "http://localhost:3300").rstrip("/") + "/api"
SESSION = os.environ.get("MB_SESSION", "")
DB = int(os.environ.get("MB_DB_ID", "0"))

if not SESSION or not DB:
    sys.exit("MB_SESSION and MB_DB_ID are required — see the docstring.")


def call(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"Content-Type": "application/json", "X-Metabase-Session": SESSION},
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def card(name, sql, display):
    c = call("POST", "/card", {
        "name": name,
        "display": display,
        "visualization_settings": {},
        "dataset_query": {"type": "native", "database": DB, "native": {"query": sql}},
    })
    print(f"  card {c['id']}: {name}")
    return c["id"]


def dashboard(name, cards):
    """cards: list of (card_id, row, col, size_x, size_y)"""
    d = call("POST", "/dashboard", {"name": name})
    dashcards = [
        {"id": -(i + 1), "card_id": cid, "row": r, "col": c,
         "size_x": sx, "size_y": sy, "series": [], "parameter_mappings": [],
         "visualization_settings": {}}
        for i, (cid, r, c, sx, sy) in enumerate(cards)
    ]
    call("PUT", f"/dashboard/{d['id']}", {"dashcards": dashcards})
    call("PUT", f"/dashboard/{d['id']}", {"enable_embedding": True})
    print(f"dashboard {d['id']}: {name} ({len(cards)} cards, embedding on)")
    return d["id"]


THIS_MONTH = "to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM')"

print("== ยอดขายและคำขอค้าง (Data Mart) ==")
m_asof = card("ข้อมูล ณ", """
SELECT to_char(min(refreshed_at) AT TIME ZONE 'Asia/Bangkok', 'DD/MM/YYYY HH24:MI') AS as_of
FROM mart.refresh_log""", "scalar")
m_sales = card("ยอดขายเดือนนี้", f"""
SELECT COALESCE(sum(amount), 0) FROM mart.fact_sales
WHERE NOT is_cancelled AND order_month = {THIS_MONTH}""", "scalar")
m_open = card("คำขอค้างตอนนี้", "SELECT count(*) FROM mart.open_requests", "scalar")
m_over = card("เกินกำหนดอยู่ตอนนี้", """
SELECT count(*) FROM mart.open_requests WHERE sla_status = 'overdue'""", "scalar")
m_monthly = card("ยอดขายรายเดือน (12 เดือน)", """
SELECT order_month, sum(amount) AS sales, count(*) AS orders
FROM mart.fact_sales WHERE NOT is_cancelled
GROUP BY 1 ORDER BY 1 DESC LIMIT 12""", "bar")
m_team = card("ยอดขายเดือนนี้ตามทีม", f"""
SELECT COALESCE(owner_unit, '-') AS team, sum(amount) AS sales
FROM mart.fact_sales WHERE NOT is_cancelled AND order_month = {THIS_MONTH}
GROUP BY 1 ORDER BY 2 DESC""", "row")
m_target = card("เป้า vs ยอดจริง งวดนี้", f"""
SELECT subject_name AS "เป้าของ", scope, target_amount AS "เป้า",
       actual_amount AS "ยอดจริง", forecast_amount AS "พยากรณ์",
       attainment_pct AS "% ถึงเป้า", forecast_pct AS "% พยากรณ์"
FROM mart.sales_target_actual WHERE period = {THIS_MONTH}
ORDER BY attainment_pct NULLS LAST""", "table")
m_stage = card("Pipeline ตามขั้น", """
SELECT stage, count(*) AS deals, sum(amount) AS amount, sum(weighted_amount) AS weighted
FROM mart.fact_pipeline GROUP BY 1
ORDER BY array_position(ARRAY['qualifying','proposing','negotiating'], stage)""", "bar")
m_close = card("Pipeline ถ่วงน้ำหนักตามเดือนที่คาดปิด", """
SELECT COALESCE(expected_close_month, 'ไม่ระบุ') AS month, sum(weighted_amount) AS weighted
FROM mart.fact_pipeline GROUP BY 1 ORDER BY 1""", "bar")
m_trend = card("แนวโน้มคำขอค้างรายวัน (60 วัน)", """
SELECT snapshot_date, sum(open_count) AS open, sum(overdue_count) AS overdue
FROM mart.request_backlog_daily
WHERE snapshot_date > (now() AT TIME ZONE 'Asia/Bangkok')::date - 60
GROUP BY 1 ORDER BY 1""", "line")
m_age = card("คำขอค้างตามทีม × อายุ", """
SELECT COALESCE(receiver_unit, '-') AS team, age_bucket, count(*) AS requests
FROM mart.open_requests GROUP BY 1, 2 ORDER BY 1, 2""", "table")
m_oldest = card("คำขอค้างนานสุด", """
SELECT request_no, type_name, receiver_unit, assignee, status, age_days, sla_status
FROM mart.open_requests ORDER BY age_days DESC LIMIT 20""", "table")

dashboard("ยอดขายและคำขอค้าง", [
    (m_asof, 0, 0, 6, 3), (m_sales, 0, 6, 6, 3), (m_open, 0, 12, 6, 3), (m_over, 0, 18, 6, 3),
    (m_monthly, 3, 0, 12, 6), (m_team, 3, 12, 12, 6),
    (m_target, 9, 0, 24, 6),
    (m_stage, 15, 0, 12, 6), (m_close, 15, 12, 12, 6),
    (m_trend, 21, 0, 12, 6), (m_age, 21, 12, 12, 6),
    (m_oldest, 27, 0, 24, 7),
])
