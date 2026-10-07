#!/usr/bin/env python3
"""CD-266 — create "KBMS · ช่องว่างความรู้และ AI" in Metabase: how often the
AI channels (AI CARE · AI SMART) answered from the knowledge base by
themselves, month by month and by channel, and the knowledge gaps opened and
filled each month by where they came from (AI couldn't answer · rated not
helpful · staff search found nothing). Reads the Data Mart (`mart` schema):
mart.fact_kb_ai_monthly and mart.fact_kb_gaps_monthly — counts only, no
question text.

Same contract as build_delivery_dashboard.py: stdlib only; every card is run
once after it is made and the script stops on an error; the `company` filter
is locked for embedding; running twice makes a second copy.

Usage:
    MB_URL=http://localhost:3300 \\
    MB_SESSION=<X-Metabase-Session id> \\
    MB_DB_ID=<database id of the app DB, schema mart> \\
    python3 infra/metabase/build_kb_dashboard.py

Then add the printed dashboard id on the BI settings screen (ตั้งค่า BI) with
"กรองตามบริษัทของผู้ดู" switched on, for the knowledge owners.
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
SELF = "round(100.0 * sum(answered) / NULLIF(sum(answered) + sum(unanswered), 0), 1)"
YEAR_AGO = "to_char((now() AT TIME ZONE 'Asia/Bangkok') - interval '12 months', 'YYYY-MM')"
KIND = """CASE kind WHEN 'ai_unanswered' THEN 'AI ตอบไม่ได้'
         WHEN 'low_rated' THEN 'คะแนนต่ำ' WHEN 'search_miss' THEN 'ค้นไม่เจอ' END"""

print("== KBMS · ช่องว่างความรู้และ AI (Data Mart) ==")

asof = card("ข้อมูล ณ", """
SELECT to_char(refreshed_at AT TIME ZONE 'Asia/Bangkok', 'DD/MM/YYYY HH24:MI') AS "ข้อมูล ณ"
FROM mart.refresh_log WHERE table_name = 'fact_kb_ai_monthly'""", "scalar", company=False)

self_this = card("AI ตอบได้เอง เดือนนี้", f"""
SELECT {SELF} AS "ตอบได้เอง %"
FROM mart.fact_kb_ai_monthly WHERE month = {THIS_MONTH} {CO}""", "scalar")

self_last = card("AI ตอบได้เอง เดือนก่อน", f"""
SELECT {SELF} AS "ตอบได้เอง %"
FROM mart.fact_kb_ai_monthly WHERE month = {LAST_MONTH} {CO}""", "scalar")

opened_this = card("ช่องว่างใหม่ เดือนนี้", f"""
SELECT COALESCE(sum(opened), 0) AS "ช่องว่าง"
FROM mart.fact_kb_gaps_monthly WHERE month = {THIS_MONTH} {CO}""", "scalar")

resolved_this = card("เติมแล้ว เดือนนี้", f"""
SELECT COALESCE(sum(resolved), 0) AS "ช่องว่าง"
FROM mart.fact_kb_gaps_monthly WHERE month = {THIS_MONTH} {CO}""", "scalar")

trend = card("อัตรา AI ตอบได้เองรายเดือน", f"""
SELECT month AS "เดือน", {SELF} AS "รวม %",
       round(100.0 * sum(answered) FILTER (WHERE channel = 'ai_care')
             / NULLIF(sum(answered + unanswered) FILTER (WHERE channel = 'ai_care'), 0), 1) AS "AI CARE %",
       round(100.0 * sum(answered) FILTER (WHERE channel = 'ai_smart')
             / NULLIF(sum(answered + unanswered) FILTER (WHERE channel = 'ai_smart'), 0), 1) AS "AI SMART %"
FROM mart.fact_kb_ai_monthly
WHERE month > {YEAR_AGO} {CO}
GROUP BY 1 ORDER BY 1""", "line")

volume = card("คำถามที่ AI ค้นรายเดือน", f"""
SELECT month AS "เดือน", sum(answered) AS "ตอบได้", sum(unanswered) AS "ตอบไม่ได้",
       sum(pending) AS "ไม่ได้บันทึกผล"
FROM mart.fact_kb_ai_monthly
WHERE month > {YEAR_AGO} {CO}
GROUP BY 1 ORDER BY 1""", "bar", {"stackable.stack_type": "stacked"})

gaps = card("ช่องว่างเปิด/เติมรายเดือน", f"""
SELECT month AS "เดือน", sum(opened) AS "เปิดใหม่", sum(resolved) AS "เติมแล้ว",
       sum(dismissed) AS "ปิดทิ้ง"
FROM mart.fact_kb_gaps_monthly
WHERE month > {YEAR_AGO} {CO}
GROUP BY 1 ORDER BY 1""", "bar")

by_kind = card("ช่องว่างตามแหล่ง (12 เดือน)", f"""
SELECT {KIND} AS "แหล่ง", sum(opened) AS "เปิดใหม่", sum(resolved) AS "เติมแล้ว",
       sum(dismissed) AS "ปิดทิ้ง"
FROM mart.fact_kb_gaps_monthly
WHERE month > {YEAR_AGO} {CO}
GROUP BY 1 ORDER BY 2 DESC""", "bar")

dashboard(
    "KBMS · ช่องว่างความรู้และ AI",
    "CD-266 — อัตราที่ AI CARE / AI SMART ตอบได้เองจากคลังความรู้ (ตอบได้ ÷ ตอบได้ + ตอบไม่ได้) รายเดือนและรายช่องทาง และช่องว่างความรู้ที่เปิด/เติม/ปิดทิ้งแต่ละเดือนตามแหล่ง — ตัวเลขล้วน ไม่มีข้อความคำถาม",
    [
        (asof, 0, 0, 4, 2), (self_this, 0, 4, 5, 2), (self_last, 0, 9, 5, 2),
        (opened_this, 0, 14, 5, 2), (resolved_this, 0, 19, 5, 2),
        (trend, 2, 0, 12, 6), (volume, 2, 12, 12, 6),
        (gaps, 8, 0, 12, 6), (by_kind, 8, 12, 12, 6),
    ],
)
