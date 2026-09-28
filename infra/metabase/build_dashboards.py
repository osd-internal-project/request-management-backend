#!/usr/bin/env python3
"""Create the 3 CTD dashboards (Request / Approval / SLA) in a Metabase
instance, from the card definitions in docs/metabase.md.

Idempotent-ish: running twice creates duplicates — meant for a fresh instance
or after deleting the old collection. Stdlib only.

Usage:
    MB_URL=http://192.168.31.51:3400 \
    MB_SESSION=<X-Metabase-Session id> \
    MB_DB_ID=<database id of "CTD Reporting"> \
    python3 infra/metabase/build_dashboards.py

A session id comes from POST /api/session with admin credentials, or from the
browser's X-Metabase-Session header. The database id is in the URL of
Admin → Databases → CTD Reporting.
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
    # CD-92 menu embedding needs each dashboard published for static embeds.
    call("PUT", f"/dashboard/{d['id']}", {"enable_embedding": True})
    print(f"dashboard {d['id']}: {name} ({len(cards)} cards, embedding on)")
    return d["id"]


R = "reporting.requests"
S = "reporting.approval_steps"
C = "reporting.sla_clocks"
E = "reporting.request_events"

print("== Request Overview ==")
c_open = card("คำขอที่ยังไม่จบ", f"SELECT count(*) FROM {R} WHERE NOT is_terminal", "scalar")
c_hold = card("พักอยู่ (on hold)", f"SELECT count(*) FROM {R} WHERE status = 'on_hold'", "scalar")
c_week = card("คำขอใหม่ต่อสัปดาห์", f"""
SELECT date_trunc('week', submitted_at)::date AS week, count(*) AS requests
FROM {R} WHERE submitted_at IS NOT NULL GROUP BY 1 ORDER BY 1""", "line")
c_status = card("แยกตามสถานะ (ยังไม่จบ)", f"""
SELECT status, count(*) FROM {R} WHERE NOT is_terminal GROUP BY 1 ORDER BY 2 DESC""", "pie")
c_type = card("แยกตามประเภทคำขอ", f"""
SELECT type_name, count(*) AS requests FROM {R} GROUP BY 1 ORDER BY 2 DESC""", "row")
c_cycle = card("Cycle time เฉลี่ย (ชม.) ต่อประเภท", f"""
SELECT type_name, round(avg(cycle_hours)::numeric, 1) AS avg_hours
FROM {R} WHERE cycle_hours IS NOT NULL GROUP BY 1 ORDER BY 2 DESC""", "bar")
c_oldest = card("คำขอค้างนานสุด", f"""
SELECT request_no, type_name, requester_unit, requester, status, submitted_at, due_at
FROM {R} WHERE NOT is_terminal ORDER BY submitted_at ASC LIMIT 20""", "table")
dash_req = dashboard("Request Overview", [
    (c_open, 0, 0, 6, 3), (c_hold, 0, 6, 6, 3), (c_week, 0, 12, 12, 6),
    (c_status, 3, 0, 6, 5), (c_type, 3, 6, 6, 5),
    (c_cycle, 8, 0, 12, 5), (c_oldest, 8, 12, 12, 8),
])

print("== Approval ==")
a_wait = card("รออนุมัติตอนนี้", f"SELECT count(*) FROM {S} WHERE step_status = 'waiting'", "scalar")
a_deleg = card("ตัดสินผ่าน delegation", f"SELECT count(*) FROM {S} WHERE via_delegation AND decided_at IS NOT NULL", "scalar")
a_role = card("เวลาตัดสินเฉลี่ย (ชม.) ต่อชั้น", f"""
SELECT approver_role, round(avg(decision_hours)::numeric, 1) AS avg_hours
FROM {S} WHERE decided_at IS NOT NULL GROUP BY 1 ORDER BY 2 DESC""", "bar")
a_queue = card("คิวงานต่อผู้อนุมัติ", f"""
SELECT approver, count(*) AS waiting FROM {S}
WHERE step_status = 'waiting' AND approver IS NOT NULL GROUP BY 1 ORDER BY 2 DESC""", "row")
a_dec = card("สัดส่วนผลตัดสิน", f"""
SELECT decision, count(*) FROM {S} WHERE decision IS NOT NULL GROUP BY 1""", "pie")
a_top = card("เคสวงเงินสูงที่ยังค้าง", f"""
SELECT request_no, subject_type, amount, currency, step_no, approver
FROM {S} WHERE case_status = 'pending' AND step_status = 'waiting'
ORDER BY amount DESC NULLS LAST LIMIT 20""", "table")
dash_apv = dashboard("Approval", [
    (a_wait, 0, 0, 6, 3), (a_deleg, 0, 6, 6, 3), (a_dec, 0, 12, 12, 6),
    (a_role, 3, 0, 12, 5), (a_queue, 6, 12, 12, 5), (a_top, 8, 0, 12, 7),
])

print("== SLA ==")
s_comp = card("SLA compliance % (30 วัน)", f"""
SELECT round(100.0 * count(*) FILTER (WHERE sla_status = 'on_time') / nullif(count(*), 0), 1)
FROM {C} WHERE sla_status IN ('on_time','late') AND completed_at > now() - interval '30 days'""", "scalar")
s_over = card("เกินกำหนดอยู่ตอนนี้", f"SELECT count(*) FROM {C} WHERE sla_status = 'overdue'", "scalar")
s_pause = card("นาฬิกาที่หยุดพัก", f"SELECT count(*) FROM {C} WHERE state = 'paused'", "scalar")
s_breach = card("Breach ต่อสัปดาห์", f"""
SELECT date_trunc('week', breached_at)::date AS week, count(*) AS breaches
FROM {C} WHERE breached_at IS NOT NULL GROUP BY 1 ORDER BY 1""", "line")
s_due = card("ใกล้ครบกำหนดใน 24 ชม.", f"""
SELECT request_no, type_code, due_at FROM {C}
WHERE state = 'running' AND due_at BETWEEN now() AND now() + interval '24 hours'
ORDER BY due_at""", "table")
s_neck = card("คอขวด: เวลาเฉลี่ยระหว่างขั้น (ชม.)", f"""
SELECT type_code, event_type, round(avg(hours_since_previous)::numeric, 1) AS avg_hours
FROM {E} WHERE hours_since_previous IS NOT NULL
GROUP BY 1, 2 ORDER BY 3 DESC""", "table")
dash_sla = dashboard("SLA", [
    (s_comp, 0, 0, 6, 3), (s_over, 0, 6, 6, 3), (s_pause, 0, 12, 6, 3),
    (s_breach, 3, 0, 12, 5), (s_due, 3, 12, 12, 6), (s_neck, 8, 0, 12, 7),
])

print(f"\nDone. Dashboard ids — request: {dash_req}, approval: {dash_apv}, sla: {dash_sla}")
print("Put these in core-service .env as METABASE_DASHBOARD_REQUEST / _APPROVAL / _SLA.")
