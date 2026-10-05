#!/usr/bin/env python3
"""CD-256 — create "Delivery · การส่งมอบและงวดค้างชำระ" in Metabase: where
every phase stands, the share accepted by its milestone's due day month by
month, what is still waiting for the customer's acceptance, and installments
billed and past due (invoice + 30 days) but not yet paid, by age and by
salesperson. Reads the Data Mart (`mart` schema): mart.fact_delivery_phases
and mart.fact_receivables.

Same contract as build_utilization_dashboard.py: stdlib only; every card is
run once after it is made and the script stops on an error; the `company`
filter is locked for embedding; running twice makes a second copy.

Usage:
    MB_URL=http://localhost:3300 \\
    MB_SESSION=<X-Metabase-Session id> \\
    MB_DB_ID=<database id of the app DB, schema mart> \\
    python3 infra/metabase/build_delivery_dashboard.py

Then add the printed dashboard id on the BI settings screen (ตั้งค่า BI) with
"กรองตามบริษัทของผู้ดู" switched on. It shows every salesperson's contracts:
give it to finance and executives only.
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




# A rate over a group is a ratio of counts, not an average of percentages.
ON_TIME = "round(100.0 * count(*) FILTER (WHERE on_time) / NULLIF(count(on_time), 0), 1)"
LIVE = "project_status <> 'cancelled'"
YEAR_AGO = "to_char((now() AT TIME ZONE 'Asia/Bangkok') - interval '12 months', 'YYYY-MM')"

print("== Delivery · การส่งมอบและงวดค้างชำระ (Data Mart) ==")

asof = card("ข้อมูล ณ", """
SELECT to_char(refreshed_at AT TIME ZONE 'Asia/Bangkok', 'DD/MM/YYYY HH24:MI') AS "ข้อมูล ณ"
FROM mart.refresh_log WHERE table_name = 'fact_delivery_phases'""", "scalar", company=False)

on_time_12 = card("ตรวจรับตรงกำหนด (12 เดือน)", f"""
SELECT {ON_TIME} AS "ตรงกำหนด %"
FROM mart.fact_delivery_phases
WHERE accepted_month > {YEAR_AGO} {CO}""", "scalar")

pending = card("เฟสค้างรับมอบ", f"""
SELECT count(*) AS "เฟส"
FROM mart.fact_delivery_phases
WHERE {LIVE} AND phase_status IN ('delivered', 'in_acceptance') {CO}""", "scalar")

overdue_amount = card("งวดค้างชำระ (บาท)", f"""
SELECT COALESCE(sum(amount), 0) AS "บาท"
FROM mart.fact_receivables WHERE state = 'overdue' {CO}""", "scalar")

overdue_count = card("งวดค้างชำระ (งวด)", f"""
SELECT count(*) AS "งวด"
FROM mart.fact_receivables WHERE state = 'overdue' {CO}""", "scalar")

trend = card("อัตราตรวจรับตรงกำหนดรายเดือน", f"""
SELECT accepted_month AS "เดือน", {ON_TIME} AS "ตรงกำหนด %",
       count(*) FILTER (WHERE first_round_passed) AS "ผ่านรอบแรก",
       count(*) AS "เฟสที่รับมอบ"
FROM mart.fact_delivery_phases
WHERE accepted_month > {YEAR_AGO} {CO}
GROUP BY 1 ORDER BY 1""", "line")

status = card("สถานะเฟสที่ยังไม่รับมอบ", f"""
SELECT CASE phase_status
         WHEN 'not_started' THEN 'ยังไม่เริ่มส่ง' WHEN 'delivering' THEN 'กำลังส่ง'
         WHEN 'delivered' THEN 'ส่งครบ รอนัดตรวจรับ' WHEN 'in_acceptance' THEN 'อยู่ระหว่างตรวจรับ'
       END AS "สถานะ", count(*) AS "เฟส"
FROM mart.fact_delivery_phases
WHERE {LIVE} AND phase_status <> 'accepted' {CO}
GROUP BY 1 ORDER BY 2 DESC""", "pie")

aging = card("อายุงวดค้างชำระ", f"""
SELECT CASE WHEN days_overdue <= 30 THEN '1-30 วัน' WHEN days_overdue <= 60 THEN '31-60 วัน'
            WHEN days_overdue <= 90 THEN '61-90 วัน' ELSE 'เกิน 90 วัน' END AS "อายุ",
       sum(amount) AS "บาท", count(*) AS "งวด"
FROM mart.fact_receivables WHERE state = 'overdue' {CO}
GROUP BY 1 ORDER BY min(days_overdue)""", "bar")

by_owner = card("งวดค้างชำระตามพนักงานขาย", f"""
SELECT COALESCE(owner_name, 'ไม่ระบุ') AS "พนักงานขาย", sum(amount) AS "บาท",
       count(*) AS "งวด", max(days_overdue) AS "ค้างนานสุด (วัน)"
FROM mart.fact_receivables WHERE state = 'overdue' {CO}
GROUP BY 1 ORDER BY 2 DESC""", "bar")

pending_list = card("รายการค้างรับมอบ — ช้าสุดก่อน", f"""
SELECT project_no AS "โครงการ", project_name AS "ชื่อ", customer_name AS "ลูกค้า",
       milestone_seq || '. ' || milestone_title AS "เฟส", due_on AS "ครบกำหนด",
       delivered || '/' || deliveries AS "ส่งแล้ว", rounds AS "รอบตรวจรับ",
       days_late AS "เลยกำหนด (วัน)", manager_name AS "ผู้จัดการโครงการ"
FROM mart.fact_delivery_phases
WHERE {LIVE} AND (phase_status IN ('delivered', 'in_acceptance')
      OR (phase_status <> 'accepted' AND days_late > 0)) {CO}
ORDER BY days_late DESC NULLS LAST, project_no
LIMIT 200""", "table")

overdue_list = card("งวดค้างชำระ — นานสุดก่อน", f"""
SELECT contract_no AS "สัญญา", customer_name AS "ลูกค้า", project_no AS "โครงการ",
       seq || '. ' || label AS "งวด", amount AS "บาท", invoice_no AS "ใบแจ้งหนี้",
       invoiced_on AS "วางบิล", due_on AS "ครบกำหนด", days_overdue AS "ค้าง (วัน)",
       owner_name AS "พนักงานขาย"
FROM mart.fact_receivables WHERE state = 'overdue' {CO}
ORDER BY days_overdue DESC, contract_no
LIMIT 200""", "table")

dashboard(
    "Delivery · การส่งมอบและงวดค้างชำระ",
    "CD-256 — อัตราตรวจรับตรงกำหนด (วันรับมอบ ≤ วันครบกำหนดของหมุดหมาย) รายเดือน เฟสที่ค้างรับมอบ และงวดที่วางบิลแล้วเลยกำหนดชำระ (วางบิล + 30 วัน) แต่ยังไม่ได้รับเงิน — เห็นทุกสัญญา: ให้ฝ่ายการเงินและผู้บริหารเท่านั้น",
    [
        (asof, 0, 0, 4, 2), (on_time_12, 0, 4, 5, 2), (pending, 0, 9, 5, 2),
        (overdue_amount, 0, 14, 5, 2), (overdue_count, 0, 19, 5, 2),
        (trend, 2, 0, 12, 6), (status, 2, 12, 12, 6),
        (aging, 8, 0, 12, 6), (by_owner, 8, 12, 12, 6),
        (pending_list, 14, 0, 24, 8), (overdue_list, 22, 0, 24, 8),
    ],
)
