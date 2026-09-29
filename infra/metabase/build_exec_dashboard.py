#!/usr/bin/env python3
"""CD-92 — create "ผู้บริหาร · ภาพรวมรายสัปดาห์" in Metabase: the weekly
executive view (sales, win rate, pipeline, requests overdue, the Getter and
Keeper axes), reading the Data Mart (`mart` schema) only.

Every card takes an optional `company` value (`[[AND company_code = {{company}}]]`)
and the dashboard maps one `company` parameter to all of them, **locked** for
embedding: the application signs the viewer's company code into the token
(bi_dashboards.lockCompany), so an embedded viewer sees one company and cannot
change it. Opened inside Metabase by an admin, the filter is free.

After creating each card the script runs it once and stops on an error, so a
dashboard is never published with a broken card.

Same contract as build_mart_dashboard.py: stdlib only; running twice makes a
second copy.

Usage:
    MB_URL=http://localhost:3300 \\
    MB_SESSION=<X-Metabase-Session id> \\
    MB_DB_ID=<database id of the app DB, schema mart> \\
    python3 infra/metabase/build_exec_dashboard.py

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
# Thai labels for codes, in SQL — the screen's wording for the same codes.
DEAL_TYPE_TH = ("CASE deal_type WHEN 'upsell' THEN 'ขายเพิ่ม' WHEN 'cross_sell' THEN 'ขายข้าม' "
                "WHEN 'renewal' THEN 'ต่ออายุ' ELSE 'ลูกค้าใหม่' END")
SIGNALS_TH = ("replace(replace(replace(replace(replace(replace(replace(signals, "
              "'case_breached', 'เคสเกิน SLA'), 'case_serious', 'เคสร้ายแรง'), "
              "'invoice_overdue', 'ใบแจ้งหนี้เลยกำหนด'), 'contract_ending', 'สัญญาใกล้หมด'), "
              "'renewal_lost', 'ต่ออายุแพ้'), 'low_satisfaction', 'ความพึงพอใจต่ำ'), "
              "'no_contact', 'ไม่ได้ติดต่อนาน')")


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


print("== ผู้บริหาร · ภาพรวมรายสัปดาห์ (Data Mart) ==")

# --- KPIs --------------------------------------------------------------------
asof = card("ข้อมูล ณ", """
SELECT to_char(min(refreshed_at) AT TIME ZONE 'Asia/Bangkok', 'DD/MM/YYYY HH24:MI') AS "ข้อมูล ณ"
FROM mart.refresh_log""", "scalar", company=False)

sales_week = card("ยอดขายสัปดาห์นี้", f"""
SELECT COALESCE(sum(amount), 0) AS "ยอดขาย"
FROM mart.fact_sales
WHERE NOT is_cancelled AND ordered_on >= {WEEK_START} {CO}""", "scalar")

sales_month = card("ยอดขายเดือนนี้ เทียบเดือนก่อน", f"""
WITH m AS (
  SELECT order_month, sum(amount) AS sales FROM mart.fact_sales
  WHERE NOT is_cancelled {CO}
  GROUP BY order_month
)
SELECT COALESCE((SELECT sales FROM m WHERE order_month = {THIS_MONTH}), 0) AS "เดือนนี้",
       COALESCE((SELECT sales FROM m WHERE order_month =
         to_char((now() AT TIME ZONE 'Asia/Bangkok') - interval '1 month', 'YYYY-MM')), 0) AS "เดือนก่อน"
""",
    "table")

win_rate = card("Win rate 90 วัน (%)", f"""
-- no deal closed in the window: say so, rather than a misleading 0
SELECT COALESCE(round(100.0 * count(*) FILTER (WHERE is_won)
       / nullif(count(*) FILTER (WHERE is_won OR is_lost), 0), 1)::text,
       'ยังไม่มีดีลที่ปิด') AS "Win rate"
FROM mart.fact_deals
WHERE closed_on >= {TODAY} - 90 {CO}""", "scalar")

pipeline = card("Pipeline ถ่วงน้ำหนัก", f"""
SELECT COALESCE(sum(weighted_amount), 0) AS "ถ่วงน้ำหนัก"
FROM mart.fact_pipeline WHERE 1 = 1 {CO}""", "scalar")

new_customers = card("ลูกค้าใหม่เดือนนี้", f"""
SELECT count(*) AS "ลูกค้าใหม่" FROM (
  SELECT customer_code, min(order_month) AS first_month
  FROM mart.fact_sales
  WHERE NOT is_cancelled AND customer_code IS NOT NULL {CO}
  GROUP BY customer_code
) f WHERE first_month = {THIS_MONTH}""", "scalar")

overdue = card("คำขอเกินกำหนดตอนนี้", f"""
SELECT count(*) AS "เกินกำหนด" FROM mart.open_requests WHERE sla_status = 'overdue' {CO}""", "scalar")

at_risk = card("ลูกค้าเสี่ยง (Keeper)", f"""
SELECT count(*) AS "เสี่ยง" FROM mart.customer_accounts WHERE health = 'red' {CO}""", "scalar")

# --- Getter ------------------------------------------------------------------
lead_funnel = card("Getter · Lead → ดีล รายเดือน (6 เดือน)", f"""
SELECT created_month AS "เดือน", count(*) AS "Lead",
       count(*) FILTER (WHERE is_converted) AS "เป็นดีล",
       round(100.0 * count(*) FILTER (WHERE is_converted) / nullif(count(*), 0), 1) AS "% แปลงเป็นดีล"
FROM mart.fact_leads
WHERE created_on >= {TODAY} - 183 {CO}
GROUP BY created_month ORDER BY created_month""", "bar")

lead_sources = card("Getter · แหล่งที่มาของ Lead (90 วัน)", f"""
SELECT COALESCE(source_code, '(ไม่ระบุ)') AS "แหล่งที่มา", count(*) AS "Lead",
       count(*) FILTER (WHERE is_converted) AS "เป็นดีล",
       round(100.0 * count(*) FILTER (WHERE is_converted) / nullif(count(*), 0), 1) AS "% แปลงเป็นดีล",
       round(avg(contact_attempts), 1) AS "ติดต่อเฉลี่ย (ครั้ง)",
       round(avg(days_to_convert), 1) AS "วันจนเป็นดีล (เฉลี่ย)"
FROM mart.fact_leads
WHERE created_on >= {TODAY} - 90 {CO}
GROUP BY 1 ORDER BY 2 DESC""", "table")

by_type = card("Win rate ตามชนิดดีล (90 วัน)", f"""
SELECT {DEAL_TYPE_TH} AS "ชนิดดีล",
       count(*) FILTER (WHERE is_won) AS "ชนะ",
       count(*) FILTER (WHERE is_lost) AS "แพ้",
       round(100.0 * count(*) FILTER (WHERE is_won)
             / nullif(count(*) FILTER (WHERE is_won OR is_lost), 0), 1) AS "Win rate %",
       COALESCE(sum(amount) FILTER (WHERE is_won), 0) AS "มูลค่าที่ชนะ"
FROM mart.fact_deals
WHERE closed_on >= {TODAY} - 90 {CO}
GROUP BY deal_type ORDER BY 5 DESC""", "table")

loss = card("เหตุผลที่แพ้ (90 วัน)", f"""
SELECT COALESCE(lost_reason, '(ไม่ระบุ)') AS "เหตุผล", count(*) AS "ดีล",
       COALESCE(sum(amount), 0) AS "มูลค่า"
FROM mart.fact_deals
WHERE is_lost AND closed_on >= {TODAY} - 90 {CO}
GROUP BY 1 ORDER BY 2 DESC""", "row")

# --- Keeper ------------------------------------------------------------------
health = card("Keeper · สุขภาพลูกค้าตอนนี้", f"""
SELECT CASE health WHEN 'red' THEN 'เสี่ยง' WHEN 'amber' THEN 'เฝ้าระวัง' ELSE 'ปกติ' END AS "สุขภาพ",
       count(*) AS "บัญชี"
FROM mart.customer_accounts WHERE 1 = 1 {CO}
GROUP BY health ORDER BY min(CASE health WHEN 'red' THEN 0 WHEN 'amber' THEN 1 ELSE 2 END)""", "pie")

health_trend = card("Keeper · แนวโน้มสุขภาพลูกค้า (30 วัน)", f"""
SELECT snapshot_date AS "วันที่",
       sum(accounts) FILTER (WHERE health = 'red') AS "เสี่ยง",
       sum(accounts) FILTER (WHERE health = 'amber') AS "เฝ้าระวัง",
       sum(accounts) FILTER (WHERE health = 'green') AS "ปกติ"
FROM mart.customer_health_daily
WHERE snapshot_date >= {TODAY} - 30 {CO}
GROUP BY snapshot_date ORDER BY snapshot_date""", "line")

reviews = card("Keeper · แผนบัญชีและรอบทบทวน", f"""
SELECT count(*) FILTER (WHERE tier IS NULL) AS "ยังไม่มีแผนบัญชี",
       count(*) FILTER (WHERE review_overdue) AS "เลยรอบทบทวน",
       count(*) FILTER (WHERE open_deals IS NOT NULL AND open_expansion = 0) AS "ไม่มีดีลขยาย"
FROM mart.customer_accounts WHERE 1 = 1 {CO}""", "table")

expansion = card("Keeper · ยอดขายตามชนิดดีล (ไตรมาสนี้)", f"""
SELECT {DEAL_TYPE_TH.replace('deal_type', "COALESCE(d.deal_type, 'new_business')")} AS "ชนิดดีล",
       sum(s.amount) AS "ยอดขาย"
FROM mart.fact_sales s
LEFT JOIN mart.fact_deals d ON d.opportunity_code = s.opportunity_code
WHERE NOT s.is_cancelled
  AND s.ordered_on >= date_trunc('quarter', {TODAY})::date
  [[AND s.company_code = {{{{company}}}}]]
GROUP BY 1 ORDER BY 2 DESC""", "bar")

risk_list = card("Keeper · ลูกค้าที่ต้องดูแล", f"""
SELECT CASE health WHEN 'red' THEN 'เสี่ยง' ELSE 'เฝ้าระวัง' END AS "สุขภาพ",
       customer_code AS "รหัสลูกค้า", customer_name AS "ลูกค้า", owner_name AS "ผู้ดูแล",
       upper(tier) AS "ระดับ", {SIGNALS_TH} AS "สัญญาณ",
       last_contact_on AS "ติดต่อล่าสุด", next_review_on AS "ทบทวนครั้งถัดไป",
       revenue_12m AS "ยอดขาย 12 เดือน"
FROM mart.customer_accounts
WHERE health IN ('red', 'amber') {CO}
ORDER BY health DESC, revenue_12m DESC NULLS LAST LIMIT 30""", "table")

dashboard(
    "ผู้บริหาร · ภาพรวมรายสัปดาห์",
    "CD-92 — ยอดขาย win rate pipeline คำขอเกินกำหนด และแกนขาย Getter / Keeper จาก Data Mart",
    [
        (asof, 0, 0, 4, 2), (sales_week, 0, 4, 5, 2), (win_rate, 0, 9, 5, 2),
        (pipeline, 0, 14, 5, 2), (new_customers, 0, 19, 5, 2),
        (sales_month, 2, 0, 8, 3), (overdue, 2, 8, 8, 3), (at_risk, 2, 16, 8, 3),
        (lead_funnel, 5, 0, 12, 6), (lead_sources, 5, 12, 12, 6),
        (by_type, 11, 0, 12, 5), (loss, 11, 12, 12, 5),
        (health, 16, 0, 8, 6), (health_trend, 16, 8, 10, 6), (reviews, 16, 18, 6, 6),
        (expansion, 22, 0, 8, 6), (risk_list, 22, 8, 16, 6),
    ],
)
