#!/usr/bin/env python3
"""Create the two OSD adoption dashboards in Metabase from the
reporting.adoption_* views:

  1. "สรุปสถานะการใช้งานระบบ Request ของแต่ละทีม"  — team adoption status
  2. "OSD Request Log · Executive Summary"        — the executive overview

Idempotent-ish: running twice creates a second copy — meant for a fresh
instance or after deleting the previous cards. Stdlib only.

Usage:
    MB_URL=http://localhost:3300 \
    MB_SESSION=<X-Metabase-Session id> \
    [MB_DB_ID=<database id>] \
    python3 infra/metabase/build_adoption_dashboards.py

MB_SESSION: from POST /api/session with admin credentials, or the browser's
X-Metabase-Session header. MB_DB_ID is optional — if omitted, the script picks
the Postgres database that already exposes the `reporting` schema (the CTD
Reporting connection). Prerequisites: workshop_schema.sql + workshop_seed.sql +
reporting_adoption.sql applied to the app DB, and that DB registered in
Metabase via the read-only metabase_ro role.
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("MB_URL", "http://localhost:3300").rstrip("/") + "/api"
SESSION = os.environ.get("MB_SESSION", "")
DB_ENV = os.environ.get("MB_DB_ID", "")

if not SESSION:
    sys.exit("MB_SESSION is required — see the docstring.")


def call(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"Content-Type": "application/json",
                 "X-Metabase-Session": SESSION},
    )
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path} -> HTTP {e.code}: {e.read().decode()[:400]}")


def resolve_db():
    if DB_ENV:
        return int(DB_ENV)
    data = call("GET", "/database")
    dbs = data["data"] if isinstance(data, dict) else data
    # Prefer a database whose schemas include `reporting`; fall back to the
    # first Postgres connection.
    postgres = [d for d in dbs if d.get("engine") == "postgres"]
    for d in postgres:
        try:
            schemas = call("GET", f"/database/{d['id']}/schemas")
            if schemas and "reporting" in schemas:
                return d["id"]
        except SystemExit:
            pass
    if postgres:
        return postgres[0]["id"]
    sys.exit("No Postgres database found in Metabase — set MB_DB_ID explicitly.")


DB = resolve_db()
print(f"Using Metabase database id {DB}")


def card(name, sql, display, viz=None):
    c = call("POST", "/card", {
        "name": name,
        "display": display,
        "visualization_settings": viz or {},
        "dataset_query": {
            "type": "native",
            "database": DB,
            "native": {"query": sql},
        },
    })
    print(f"  card {c['id']}: {name}")
    return c["id"]


def dashboard(name, cards):
    """cards: list of (card_id, row, col, size_x, size_y[, viz])"""
    d = call("POST", "/dashboard", {"name": name})
    dashcards = []
    for i, spec in enumerate(cards):
        cid, r, col, sx, sy = spec[:5]
        viz = spec[5] if len(spec) > 5 else {}
        dashcards.append({
            "id": -(i + 1), "card_id": cid, "row": r, "col": col,
            "size_x": sx, "size_y": sy, "series": [],
            "parameter_mappings": [], "visualization_settings": viz,
        })
    call("PUT", f"/dashboard/{d['id']}", {"dashcards": dashcards})
    call("PUT", f"/dashboard/{d['id']}", {"enable_embedding": True})
    print(f"dashboard {d['id']}: {name} ({len(cards)} cards, embedding on)")
    return d["id"]


T = "reporting.adoption_teams"
R = "reporting.adoption_requests"
F = "reporting.adoption_flow"
S = "reporting.adoption_status"


def scalar(name, sql):
    return card(name, sql, "scalar")


# ---------------------------------------------------------------------------
# Dashboard 1 — team adoption status
# ---------------------------------------------------------------------------
print("== สรุปสถานะการใช้งานระบบ Request ของแต่ละทีม ==")

d1_used = scalar("ทีมที่เปิดคำขอแล้ว",
                 f"SELECT count(*) FROM {T} WHERE has_opened")
d1_notused = scalar("ทีมที่ยังไม่เปิด",
                    f"SELECT count(*) FROM {T} WHERE NOT has_opened")
d1_total = scalar("รวมทั้งหมด (ทีม)", f"SELECT count(*) FROM {T}")
d1_reqs = scalar("คำขอทั้งหมด", f"SELECT count(*) FROM {R}")
# metabase_ro reaches the workshop tables only THROUGH the reporting views, so
# every card must query reporting.* — never workshop.* directly.
d1_logs = scalar("บันทึกการทำงาน", f"SELECT sum(action_logs) FROM {T}")

teams_cols = {
    "table.columns": [
        {"name": "name_th", "enabled": True}, {"name": "opened", "enabled": True},
        {"name": "opened_pct", "enabled": True}, {"name": "usage_level", "enabled": True},
        {"name": "received", "enabled": True}, {"name": "action_logs", "enabled": True},
        {"name": "closed", "enabled": True},
    ],
    "column_settings": {
        '["name","name_th"]': {"column_title": "ทีม"},
        '["name","opened"]': {"column_title": "Request ที่เปิด"},
        '["name","opened_pct"]': {"column_title": "สัดส่วน %"},
        '["name","usage_level"]': {"column_title": "ระดับการใช้งาน"},
        '["name","received"]': {"column_title": "ถูกขอให้ทำงาน"},
        '["name","action_logs"]': {"column_title": "บันทึกการทำงาน"},
        '["name","closed"]': {"column_title": "ปิดงานแล้ว"},
    },
}
d1_teams = card(
    "ทีมที่ใช้งานระบบ Request แล้ว",
    f"""SELECT name_th, opened, opened_pct, usage_level, received, action_logs, closed
FROM {T} WHERE has_opened ORDER BY opened DESC, sort_order""",
    "table", teams_cols)

notused_cols = {
    "table.columns": [
        {"name": "name_th", "enabled": True},
        {"name": "participation_note", "enabled": True},
    ],
    "column_settings": {
        '["name","name_th"]': {"column_title": "ทีม"},
        '["name","participation_note"]': {"column_title": "สถานะการมีส่วนร่วม"},
    },
}
d1_notopened = card(
    "ทีมที่ยังไม่ได้เปิด Request",
    f"""SELECT name_th, participation_note
FROM {T} WHERE NOT has_opened ORDER BY sort_order""",
    "table", notused_cols)

dash1 = dashboard("สรุปสถานะการใช้งานระบบ Request ของแต่ละทีม", [
    (d1_used, 0, 0, 4, 3), (d1_notused, 0, 4, 4, 3), (d1_total, 0, 8, 4, 3),
    (d1_reqs, 0, 12, 4, 3), (d1_logs, 0, 16, 4, 3),
    (d1_teams, 3, 0, 12, 8),
    (d1_notopened, 3, 12, 12, 8),
])

# ---------------------------------------------------------------------------
# Dashboard 2 — executive summary
# ---------------------------------------------------------------------------
print("== OSD Request Log · Executive Summary ==")

e_total = scalar("คำขอทั้งหมด", f"SELECT count(*) FROM {R}")
e_open = scalar("ยังเปิดอยู่", f"SELECT count(*) FROM {R} WHERE is_open")
e_done = scalar("Completed / Closed", f"SELECT count(*) FROM {R} WHERE is_terminal")
e_cross = scalar("คำขอข้ามแผนก", f"SELECT count(*) FROM {R} WHERE is_cross_dept")
e_overdue = scalar("เลยกำหนดแล้ว", f"SELECT count(*) FROM {R} WHERE due_bucket = 'overdue'")
e_today = scalar("ครบกำหนดวันนี้", f"SELECT count(*) FROM {R} WHERE due_bucket = 'due_today'")

e_status = card("สถานะคำขอทั้งหมด", f"""
SELECT status_label, requests FROM {S} ORDER BY requests DESC""", "pie")

e_opener = card("ใครเป็นผู้เปิด Request?", f"""
SELECT name_th AS team, opened FROM {T} WHERE opened > 0 ORDER BY opened DESC""",
    "row")
e_receiver = card("ใครเป็นผู้รับ Request?", f"""
SELECT COALESCE(assignee_dept_code, 'ไม่ระบุ') AS team, count(*) AS received
FROM {R} GROUP BY 1 ORDER BY 2 DESC""", "row")

e_flow = card("Request Flow ระหว่างแผนก", f"""
SELECT from_dept || ' → ' || to_dept AS flow, requests
FROM {F} ORDER BY requests DESC, from_dept""", "row")

target_cols = {
    "column_settings": {
        '["name","request_id"]': {"column_title": "Request"},
        '["name","flow"]': {"column_title": "ต้นทาง → ปลายทาง"},
        '["name","status"]': {"column_title": "สถานะ"},
        '["name","due_at"]': {"column_title": "Target"},
        '["name","assignee_name"]': {"column_title": "ผู้รับผิดชอบ"},
    },
}
e_target = card("Target Date & ผู้รับผิดชอบ (ที่ต้องติดตามก่อน)", f"""
SELECT request_id,
       requester_dept_code || ' → ' || COALESCE(assignee_dept_code, '—') AS flow,
       status, due_at, assignee_name
FROM {R}
WHERE due_bucket IN ('overdue', 'due_today', 'due_soon')
ORDER BY due_at, request_id
LIMIT 20""", "table", target_cols)

e_workload = card("ภาระงานตามผู้รับผิดชอบ (เฉพาะที่ยังเปิด)", f"""
SELECT assignee_name, count(*) AS open_requests
FROM {R}
WHERE is_open AND assignee_name IS NOT NULL
GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10""", "row")

dash2 = dashboard("OSD Request Log · Executive Summary", [
    (e_total, 0, 0, 3, 3), (e_open, 0, 3, 3, 3), (e_done, 0, 6, 3, 3),
    (e_cross, 0, 9, 3, 3), (e_overdue, 0, 12, 3, 3), (e_today, 0, 15, 3, 3),
    (e_status, 3, 0, 6, 6), (e_opener, 3, 6, 6, 6), (e_receiver, 3, 12, 6, 6),
    (e_flow, 9, 0, 6, 7), (e_target, 9, 6, 12, 7), (e_workload, 16, 6, 12, 6),
])

print(f"\nDone. Dashboard ids — team-adoption: {dash1}, executive: {dash2}")
print("Publish each (Sharing → Embed) if you will embed via CD-92 /bi/menu,")
print("then add them in the app's ตั้งค่า Dashboard screen with the Metabase id.")
