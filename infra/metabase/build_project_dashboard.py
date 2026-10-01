#!/usr/bin/env python3
"""CD-192 — create "ผู้บริหาร · โครงการ" in Metabase: every project's health
(green / amber / red, from the weekly status reports CD-192 drafts and the
managers submit), the ones at risk first, the trend by week, and which
managers have not reported this week. Reads the Data Mart (`mart` schema):
mart.fact_projects and mart.project_health_weekly.

Same contract as build_exec_dashboard.py: stdlib only; every card is run once
after it is made and the script stops on an error; the `company` filter is
locked for embedding; running twice makes a second copy.

Usage:
    MB_URL=http://localhost:3300 \\
    MB_SESSION=<X-Metabase-Session id> \\
    MB_DB_ID=<database id of the app DB, schema mart> \\
    python3 infra/metabase/build_project_dashboard.py

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

# Bangkok "now", the start of this Monday-based week, and this month.
TODAY = "(now() AT TIME ZONE 'Asia/Bangkok')::date"
WEEK_START = f"date_trunc('week', {TODAY})::date"
THIS_MONTH = "to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM')"
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



HEALTH_TH = "CASE health WHEN 'red' THEN 'เสี่ยง' WHEN 'amber' THEN 'เฝ้าระวัง' WHEN 'green' THEN 'ปกติ' ELSE 'ยังไม่มีรายงาน' END"
RUNNING = "status IN ('active', 'on_hold')"

print("== ผู้บริหาร · โครงการ (Data Mart) ==")

asof = card("ข้อมูล ณ", """
SELECT to_char(refreshed_at AT TIME ZONE 'Asia/Bangkok', 'DD/MM/YYYY HH24:MI') AS "ข้อมูล ณ"
FROM mart.refresh_log WHERE table_name = 'fact_projects'""", "scalar", company=False)

running = card("โครงการที่ดำเนินอยู่", f"""
SELECT count(*) AS "โครงการ" FROM mart.fact_projects WHERE {RUNNING} {CO}""", "scalar")

red = card("โครงการเสี่ยง (แดง)", f"""
SELECT count(*) AS "เสี่ยง" FROM mart.fact_projects
WHERE {RUNNING} AND health = 'red' {CO}""", "scalar")

amber = card("โครงการเฝ้าระวัง (เหลือง)", f"""
SELECT count(*) AS "เฝ้าระวัง" FROM mart.fact_projects
WHERE {RUNNING} AND health = 'amber' {CO}""", "scalar")

value_at_risk = card("มูลค่าสัญญาของโครงการเสี่ยง", f"""
SELECT COALESCE(sum(contract_value), 0) AS "มูลค่า" FROM mart.fact_projects
WHERE {RUNNING} AND health = 'red' {CO}""", "scalar")

by_health = card("สุขภาพโครงการตอนนี้", f"""
SELECT {HEALTH_TH} AS "สุขภาพ", count(*) AS "โครงการ"
FROM mart.fact_projects WHERE {RUNNING} {CO}
GROUP BY 1 ORDER BY 2 DESC""", "pie")

trend = card("แนวโน้มสุขภาพโครงการ (12 สัปดาห์)", f"""
SELECT week_start AS "สัปดาห์", {HEALTH_TH} AS "สุขภาพ", sum(projects) AS "โครงการ"
FROM mart.project_health_weekly
WHERE week_start >= {WEEK_START} - 77 {CO}
GROUP BY 1, 2 ORDER BY 1""", "bar", {"stackable.stack_type": "stacked"})

at_risk = card("โครงการที่เสี่ยงเกินเกณฑ์ (เรียงตามคะแนน)", f"""
SELECT {HEALTH_TH} AS "สุขภาพ", health_score AS "คะแนน",
       project_no AS "โครงการ", project_name AS "ชื่อ", customer_name AS "ลูกค้า",
       manager_name AS "ผู้จัดการ", factors AS "ปัจจัย",
       work_pct AS "งานเสร็จ %", planned_pct AS "ตามแผน %", end_on AS "สิ้นสุด"
FROM mart.fact_projects
WHERE {RUNNING} AND health IN ('red', 'amber') {CO}
ORDER BY CASE health WHEN 'red' THEN 0 ELSE 1 END, health_score DESC
LIMIT 50""", "table")

unreported = card("ยังไม่ส่งรายงานสัปดาห์นี้", f"""
SELECT project_no AS "โครงการ", project_name AS "ชื่อ", manager_name AS "ผู้จัดการ",
       CASE WHEN report_week = {WEEK_START} THEN 'ร่าง' ELSE 'ยังไม่มีร่าง' END AS "รายงาน"
FROM mart.fact_projects
WHERE {RUNNING} AND NOT (report_submitted AND report_week = {WEEK_START}) {CO}
ORDER BY manager_name, project_no""", "table")

dashboard(
    "ผู้บริหาร · โครงการ",
    "CD-192 — สุขภาพโครงการจากรายงานสถานะรายสัปดาห์ โครงการที่เสี่ยงเกินเกณฑ์ขึ้นก่อน",
    [
        (asof, 0, 0, 4, 2), (running, 0, 4, 5, 2), (red, 0, 9, 5, 2),
        (amber, 0, 14, 5, 2), (value_at_risk, 0, 19, 5, 2),
        (by_health, 2, 0, 8, 6), (trend, 2, 8, 16, 6),
        (at_risk, 8, 0, 24, 8),
        (unreported, 16, 0, 24, 6),
    ],
)
