#!/usr/bin/env python3
"""CD-288 — create "AI CARE · ผลการดูแลลูกค้า" in Metabase: how AI CARE
conversations ended — closed by AI by itself, a service case opened, or
handed to a person — by month and channel, why they went to a person, and
how long until a person took part. Reads the Data Mart (`mart` schema):
mart.fact_care_conversations — counts and times only, no message text.

AI-closed rate = AI closed ÷ (AI closed + case opened + handed to a person);
conversations still live, and those without any question, are left out.

Same contract as build_kb_dashboard.py: stdlib only; every card is run once
after it is made and the script stops on an error; the `company` filter is
locked for embedding; running twice makes a second copy.

Usage:
    MB_URL=http://localhost:3300 \\
    MB_SESSION=<X-Metabase-Session id> \\
    MB_DB_ID=<database id of the app DB, schema mart> \\
    python3 infra/metabase/build_care_dashboard.py

Then add the printed dashboard id on the BI settings screen (ตั้งค่า BI) with
"กรองตามบริษัทของผู้ดู" switched on, for the service team.
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
RATE = """round(100.0 * count(*) FILTER (WHERE result = 'ai_resolved')
       / NULLIF(count(*) FILTER (WHERE result IN ('ai_resolved', 'case_opened', 'handed_over')), 0), 1)"""
YEAR_AGO = "to_char((now() AT TIME ZONE 'Asia/Bangkok') - interval '12 months', 'YYYY-MM')"
CHANNEL = """CASE channel WHEN 'line' THEN 'LINE' WHEN 'facebook' THEN 'Facebook'
         WHEN 'instagram' THEN 'Instagram' WHEN 'tiktok' THEN 'TikTok'
         WHEN 'email' THEN 'อีเมล' WHEN 'web' THEN 'เว็บแชต'
         WHEN 'callcenter' THEN 'คอลเซ็นเตอร์' ELSE channel END"""
REASON = """CASE handover_reason WHEN 'asked' THEN 'ลูกค้าขอ' WHEN 'severe' THEN 'เรื่องรุนแรง'
         WHEN 'displeased' THEN 'ลูกค้าไม่พอใจ' WHEN 'unanswered' THEN 'AI ตอบไม่ได้ซ้ำ'
         WHEN 'channel' THEN 'ช่องทางกดขอ' WHEN 'staff' THEN 'เจ้าหน้าที่ส่งต่อ'
         ELSE 'เจ้าหน้าที่รับช่วงเอง / คืน AI แล้ว' END"""

print("== AI CARE · ผลการดูแลลูกค้า (Data Mart) ==")

asof = card("ข้อมูล ณ", """
SELECT to_char(refreshed_at AT TIME ZONE 'Asia/Bangkok', 'DD/MM/YYYY HH24:MI') AS "ข้อมูล ณ"
FROM mart.refresh_log WHERE table_name = 'fact_care_conversations'""", "scalar", company=False)

rate_this = card("AI ปิดเรื่องเอง เดือนนี้", f"""
SELECT {RATE} AS "AI ปิดเอง %"
FROM mart.fact_care_conversations WHERE month = {THIS_MONTH} {CO}""", "scalar")

rate_last = card("AI ปิดเรื่องเอง เดือนก่อน", f"""
SELECT {RATE} AS "AI ปิดเอง %"
FROM mart.fact_care_conversations WHERE month = {LAST_MONTH} {CO}""", "scalar")

total_this = card("บทสนทนา เดือนนี้", f"""
SELECT count(*) AS "บทสนทนา"
FROM mart.fact_care_conversations WHERE month = {THIS_MONTH} {CO}""", "scalar")

waiting = card("นาทีจนเจ้าหน้าที่ร่วม (มัธยฐาน เดือนนี้)", f"""
SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes_to_person) AS "นาที"
FROM mart.fact_care_conversations
WHERE month = {THIS_MONTH} AND minutes_to_person IS NOT NULL {CO}""", "scalar")

trend = card("อัตรา AI ปิดเรื่องเองรายเดือน", f"""
SELECT month AS "เดือน", {RATE} AS "AI ปิดเอง %"
FROM mart.fact_care_conversations
WHERE month > {YEAR_AGO} {CO}
GROUP BY 1 ORDER BY 1""", "line")

volume = card("บทสนทนารายเดือนตามผล", f"""
SELECT month AS "เดือน",
       count(*) FILTER (WHERE result = 'ai_resolved') AS "AI ตอบจบเอง",
       count(*) FILTER (WHERE result = 'case_opened') AS "เปิดเคส",
       count(*) FILTER (WHERE result = 'handed_over') AS "ส่งต่อเจ้าหน้าที่",
       count(*) FILTER (WHERE result = 'no_answer') AS "ไม่ได้ถามเรื่องใด",
       count(*) FILTER (WHERE result = 'live') AS "ยังคุยอยู่"
FROM mart.fact_care_conversations
WHERE month > {YEAR_AGO} {CO}
GROUP BY 1 ORDER BY 1""", "bar", {"stackable.stack_type": "stacked"})

by_channel = card("ตามช่องทาง (12 เดือน)", f"""
SELECT {CHANNEL} AS "ช่องทาง", count(*) AS "บทสนทนา", {RATE} AS "AI ปิดเอง %",
       count(*) FILTER (WHERE result = 'case_opened') AS "เปิดเคส",
       count(*) FILTER (WHERE result = 'handed_over') AS "ส่งต่อเจ้าหน้าที่"
FROM mart.fact_care_conversations
WHERE month > {YEAR_AGO} {CO}
GROUP BY 1 ORDER BY 2 DESC""", "table")

reasons = card("เหตุที่ส่งต่อเจ้าหน้าที่ (12 เดือน)", f"""
SELECT {REASON} AS "เหตุ", count(*) AS "บทสนทนา"
FROM mart.fact_care_conversations
WHERE month > {YEAR_AGO} AND result = 'handed_over' {CO}
GROUP BY 1 ORDER BY 2 DESC""", "bar")

dashboard(
    "AI CARE · ผลการดูแลลูกค้า",
    "CD-288 — บทสนทนา AI CARE จบอย่างไร: AI ตอบจบเอง / เปิดเคส / ส่งต่อเจ้าหน้าที่ รายเดือนและช่องทาง · อัตรา AI ปิดเอง = AI ตอบจบเอง ÷ (AI ตอบจบเอง + เปิดเคส + ส่งต่อเจ้าหน้าที่) — ตัวเลขล้วน ไม่มีข้อความบทสนทนา",
    [
        (asof, 0, 0, 4, 2), (rate_this, 0, 4, 5, 2), (rate_last, 0, 9, 5, 2),
        (total_this, 0, 14, 5, 2), (waiting, 0, 19, 5, 2),
        (trend, 2, 0, 12, 6), (volume, 2, 12, 12, 6),
        (by_channel, 8, 0, 12, 6), (reasons, 8, 12, 12, 6),
    ],
)
