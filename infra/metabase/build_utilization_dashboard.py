#!/usr/bin/env python3
"""CD-235 — create "ผู้บริหาร · Utilization" in Metabase: how much of the
time people could work was sold (billable ÷ available, available = working
days × 8 less approved leave), and how much of what they logged was billable,
by month, team and level, and person by person — hours only, never a rate or
a cost. Reads the Data Mart (`mart` schema): mart.fact_utilization.

Same contract as build_exec_dashboard.py: stdlib only; every card is run once
after it is made and the script stops on an error; the `company` filter is
locked for embedding; running twice makes a second copy.

Usage:
    MB_URL=http://localhost:3300 \\
    MB_SESSION=<X-Metabase-Session id> \\
    MB_DB_ID=<database id of the app DB, schema mart> \\
    python3 infra/metabase/build_utilization_dashboard.py

Then add the printed dashboard id on the BI settings screen (ตั้งค่า BI) with
"กรองตามบริษัทของผู้ดู" switched on.
"""
import json
import os
import sys
import urllib.error
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
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path} → {e.code}: {e.read().decode()[:500]}")


COMPANY_TAG = {
    "company": {
        "id": "0b1c6a8e-5c1f-4d2a-9b0e-cd92c0a1f001",
        "name": "company",
        "display-name": "บริษัท",
        "type": "text",
        "required": False,
    }
}

# Bangkok's this month and last month, as the mart writes them (YYYY-MM).
THIS_MONTH = "to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM')"
LAST_MONTH = "to_char((now() AT TIME ZONE 'Asia/Bangkok') - interval '1 month', 'YYYY-MM')"
CO = "[[AND company_code = {{company}}]]"
def card(name, sql, display, settings=None, company=True):
    c = call("POST", "/card", {
        "name": name,
        "display": display,
        "visualization_settings": settings or {},
        "dataset_query": {
            "type": "native",
            "database": DB,
            "native": {
                "query": sql.strip(),
                "template-tags": COMPANY_TAG if company else {},
            },
        },
    })
    result = call("POST", f"/card/{c['id']}/query", {})
    if result.get("status") != "completed":
        sys.exit(f"card {c['id']} '{name}' failed: {result.get('error')}")
    rows = len(result.get("data", {}).get("rows", []))
    print(f"  card {c['id']}: {name} ({rows} row(s))")
    return (c["id"], company)


def dashboard(name, description, cards):
    """cards: list of ((card_id, takes_company), row, col, size_x, size_y)"""
    d = call("POST", "/dashboard", {
        "name": name,
        "description": description,
        "parameters": [{
            "id": "company", "name": "บริษัท", "slug": "company",
            "type": "category",
        }],
    })
    dashcards = [
        {
            "id": -(i + 1), "card_id": cid, "row": r, "col": c,
            "size_x": sx, "size_y": sy, "series": [],
            "visualization_settings": {},
            "parameter_mappings": [{
                "parameter_id": "company", "card_id": cid,
                "target": ["variable", ["template-tag", "company"]],
            }] if takes_company else [],
        }
        for i, ((cid, takes_company), r, c, sx, sy) in enumerate(cards)
    ]
    call("PUT", f"/dashboard/{d['id']}", {"dashcards": dashcards})
    call("PUT", f"/dashboard/{d['id']}", {
        "enable_embedding": True,
        "embedding_params": {"company": "locked"},
    })
    print(f"dashboard {d['id']}: {name} ({len(cards)} cards, embedding on, company locked)")
    return d["id"]




# Rates over a group are ratios of sums, not averages of percentages.
UTIL = "round(100.0 * sum(billable_hours) / NULLIF(sum(available_hours), 0), 1)"
SHARE = "round(100.0 * sum(billable_hours) / NULLIF(sum(logged_hours), 0), 1)"

print("== ผู้บริหาร · Utilization (Data Mart) ==")

asof = card("ข้อมูล ณ", """
SELECT to_char(refreshed_at AT TIME ZONE 'Asia/Bangkok', 'DD/MM/YYYY HH24:MI') AS "ข้อมูล ณ"
FROM mart.refresh_log WHERE table_name = 'fact_utilization'""", "scalar", company=False)

util_now = card("Utilization เดือนนี้ (ถึงวันนี้)", f"""
SELECT {UTIL} AS "Utilization %"
FROM mart.fact_utilization WHERE month = {THIS_MONTH} {CO}""", "scalar")

util_last = card("Utilization เดือนที่แล้ว", f"""
SELECT {UTIL} AS "Utilization %"
FROM mart.fact_utilization WHERE month = {LAST_MONTH} {CO}""", "scalar")

share_last = card("สัดส่วนชั่วโมงขายได้ของที่ลง (เดือนที่แล้ว)", f"""
SELECT {SHARE} AS "Billable %"
FROM mart.fact_utilization WHERE month = {LAST_MONTH} {CO}""", "scalar")

unlogged_last = card("ชั่วโมงที่ยังไม่ลง Timesheet (เดือนที่แล้ว)", f"""
SELECT COALESCE(sum(unlogged_hours), 0) AS "ชั่วโมง"
FROM mart.fact_utilization WHERE month = {LAST_MONTH} {CO}""", "scalar")

trend = card("แนวโน้ม Utilization 12 เดือน", f"""
SELECT month AS "เดือน", {UTIL} AS "Utilization %", {SHARE} AS "Billable % ของที่ลง"
FROM mart.fact_utilization WHERE true {CO}
GROUP BY 1 ORDER BY 1""", "line")

mix = card("ชั่วโมงตามประเภทงาน (12 เดือน)", f"""
SELECT month AS "เดือน",
       sum(project_hours) AS "โครงการ", sum(service_hours) AS "งานบริการ",
       sum(presales_hours) AS "Pre-Sales", sum(internal_hours) AS "งานภายใน",
       sum(unlogged_hours) AS "ไม่ได้ลง"
FROM mart.fact_utilization WHERE true {CO}
GROUP BY 1 ORDER BY 1""", "bar", {"stackable.stack_type": "stacked"})

by_team = card("Utilization ตามทีม (เดือนที่แล้ว)", f"""
SELECT COALESCE(team, 'ไม่ระบุทีม') AS "ทีม", {UTIL} AS "Utilization %",
       count(*) AS "คน"
FROM mart.fact_utilization WHERE month = {LAST_MONTH} {CO}
GROUP BY 1 ORDER BY 2 DESC NULLS LAST""", "bar")

by_level = card("Utilization ตามระดับ (เดือนที่แล้ว)", f"""
SELECT COALESCE(level_name, 'ไม่มีระดับ') AS "ระดับ", {UTIL} AS "Utilization %",
       count(*) AS "คน"
FROM mart.fact_utilization WHERE month = {LAST_MONTH} {CO}
GROUP BY 1 ORDER BY 2 DESC NULLS LAST""", "bar")

people = card("รายคน (เดือนที่แล้ว) — ต่ำสุดก่อน", f"""
SELECT user_name AS "พนักงาน", team AS "ทีม", level_name AS "ระดับ",
       available_hours AS "ทำงานได้ (ชม.)", logged_hours AS "ลงแล้ว",
       billable_hours AS "ขายได้", utilization_pct AS "Utilization %",
       billable_share_pct AS "Billable % ของที่ลง", unlogged_hours AS "ยังไม่ลง"
FROM mart.fact_utilization WHERE month = {LAST_MONTH} {CO}
ORDER BY utilization_pct ASC NULLS FIRST, user_name
LIMIT 200""", "table")

dashboard(
    "ผู้บริหาร · Utilization",
    "CD-235 — ชั่วโมงขายได้ ÷ ชั่วโมงที่ทำงานได้ (วันทำการ × 8 − ลาที่อนุมัติ) จาก Timesheet ที่อนุมัติแล้ว รายเดือน ทีม ระดับ และรายคน — ไม่แสดงอัตราหรือต้นทุน",
    [
        (asof, 0, 0, 4, 2), (util_now, 0, 4, 5, 2), (util_last, 0, 9, 5, 2),
        (share_last, 0, 14, 5, 2), (unlogged_last, 0, 19, 5, 2),
        (trend, 2, 0, 12, 6), (mix, 2, 12, 12, 6),
        (by_team, 8, 0, 12, 6), (by_level, 8, 12, 12, 6),
        (people, 14, 0, 24, 9),
    ],
)
