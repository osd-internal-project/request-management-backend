#!/usr/bin/env python3
"""Generate workshop_seed.sql — 92 requests + 51 action-log rows whose
aggregates reproduce the two requirement dashboards (team adoption + executive
summary), as of the workshop cut-off 2026-08-24 (24 ส.ค. 2569).

Deterministic: no randomness, so re-running yields byte-identical SQL. The
mockups are slightly inconsistent in their derived cells (a few column totals
in the source do not sum), so this pins the HEADLINE figures exactly and lets
the secondary cells fall out of the data:

  * opened per team:   CRM 64, BSD 8, FAC 6, ENG 5, BCD 4, PCD 3, RND 2  (=92)
  * received per team:  CRM 69, FAC 6, BSD 3, PCD 3, RND 3, HRD 2, LCD 2,
                        BSC 1, PRC 1, ENG 1, (ไม่ระบุ) 1                  (=92)
  * action logs:       CRM 13, BSD 18, FAC 2, ENG 7, PCD 7, RND 4        (=51)
  * terminal (ปิดงาน): 24  (COMPLETED 21 + CLOSED 3)
  * cross-department:  26   ·  distinct requests with an action log: 19

Run:  python3 infra/metabase/gen_workshop_seed.py > infra/metabase/workshop_seed.sql
"""
from datetime import date, timedelta

CUTOFF = date(2026, 8, 24)  # 24 ส.ค. 2569 — the "ข้อมูล ณ" date on both sheets

# opener -> receiver -> count. Within-team edges (opener==receiver) are the
# CRM/BSD/ENG diagonal; everything else is a cross-department hand-off.
EDGES = [
    ("CRM", "CRM", 63), ("CRM", "FAC", 1),
    ("BSD", "CRM", 3), ("BSD", "PCD", 3), ("BSD", "BSD", 1), ("BSD", "RND", 1),
    ("FAC", "CRM", 2), ("FAC", "RND", 2), ("FAC", "LCD", 2),
    ("ENG", "FAC", 2), ("ENG", "HRD", 2), ("ENG", "ENG", 1),
    ("BCD", "CRM", 1), ("BCD", "BSD", 1), ("BCD", "BSC", 1), ("BCD", "PRC", 1),
    ("PCD", "FAC", 3),
    ("RND", "BSD", 1), ("RND", None, 1),
]

# Terminal (COMPLETED/CLOSED) requests per opener — image 1 "ปิดงานแล้ว".
# The split into completed vs closed reproduces the donut (21 + 3 = 24).
TERMINAL_BY_OPENER = {"CRM": 18, "BSD": 2, "FAC": 3, "BCD": 1}
CLOSED_BY_OPENER = {"CRM": 2, "FAC": 1}  # the rest of the terminal set is COMPLETED

# Non-terminal status mix for the 68 still-open requests (donut totals).
OPEN_STATUS_PLAN = (
    [("IN_PROGRESS", 44), ("__NULL__", 14), ("SUBMITTED", 9),
     ("PENDING_APPROVAL", 1)]
)

# Action logs recorded per team — image 1 "บันทึกการทำงาน".
ACTIONLOG_BY_DEPT = {"CRM": 13, "BSD": 18, "FAC": 2, "ENG": 7, "PCD": 7, "RND": 4}
# How many DISTINCT requests each team's logs are spread over (sums to 19,
# matching the exec message "เพียง 19 จาก 92 คำขอที่มี Action Log").
ACTIONLOG_DISTINCT = {"CRM": 5, "BSD": 3, "FAC": 2, "ENG": 3, "PCD": 3, "RND": 3}
ACTION_TYPES = ["RECEIVED", "ASSIGNED", "IN_PROGRESS", "APPROVED", "COMPLETED"]

# The 7 responsible people and their open-request workload (image 2 card 6).
WORKLOAD = [
    ("EMP-J01", "จุฑามาศ บำรุงกิจ", 6),
    ("EMP-J02", "ณัฐกรณ์ ธรรมาธิวัฒน์", 5),
    ("EMP-J03", "นิศรา ศรีขจร", 4),
    ("EMP-J04", "จารุภา มีรัตน์", 4),
    ("EMP-J05", "ศุภลักษณ์ พรหมสง", 3),
    ("EMP-J06", "ภัทรวิทย์ น้อมมนัส", 2),
    ("EMP-J07", "สุพรรณ อดเหนียว", 2),
]
# A few more named people who appear on the Target-Date list (image 2 card 5).
# These, and the generic fillers below, each hold at most ONE open request so
# the workload card (image 2 card 6) is topped by the seven WORKLOAD people.
EXTRA_STAFF = [
    ("EMP-J08", "วณัฐพร จำรัสเลิศลักษณ์"),
    ("EMP-J09", "ธวัลกร วงศ์ประเทศ"),
    ("EMP-J10", "เจตนา ตุ้มณี"),
    ("EMP-J11", "มูหมัดฟิตรี เจ๊ะเละ"),
    ("EMP-J12", "เธียรดฤษฎีนนท์ แสงเดือน"),
    ("EMP-J13", "อมรรัตน์ มั่นคง"),
    ("EMP-J14", "ณัฏฐณิชา วงศ์สุวรรณ"),
]


def sql_str(value):
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def sql_date(value):
    return "NULL" if value is None else "'" + value.isoformat() + "'"


# --- build the 92 request rows ---------------------------------------------

requests = []  # dict per request
counters = {}


def next_id(dept):
    counters[dept] = counters.get(dept, 0) + 1
    return f"REQ-{dept}-{counters[dept]:05d}"


for opener, receiver, count in EDGES:
    for _ in range(count):
        requests.append({
            "id": next_id(opener),
            "opener": opener,
            "receiver": receiver,
            "status": None,
            "assignee": None,
            "submitted_at": None,
            "due_at": None,
            "closed_at": None,
        })

assert len(requests) == 92, len(requests)

# index requests by opener, in insertion order, for status assignment
by_opener = {}
for r in requests:
    by_opener.setdefault(r["opener"], []).append(r)

# 1) mark terminal requests per opener (COMPLETED / CLOSED)
for opener, n_terminal in TERMINAL_BY_OPENER.items():
    rows = by_opener[opener]
    n_closed = CLOSED_BY_OPENER.get(opener, 0)
    for i in range(n_terminal):
        rows[i]["status"] = "CLOSED" if i < n_closed else "COMPLETED"
        # terminal requests were submitted earlier and are already closed
        rows[i]["submitted_at"] = CUTOFF - timedelta(days=14 + (i % 7))
        rows[i]["closed_at"] = CUTOFF - timedelta(days=1 + (i % 5))

# 2) assign the open-status mix to everything still unmarked
open_rows = [r for r in requests if r["status"] is None]
assert len(open_rows) == 68, len(open_rows)
plan = []
for status, n in OPEN_STATUS_PLAN:
    plan.extend([status] * n)
assert len(plan) == 68, len(plan)
for r, status in zip(open_rows, plan):
    r["status"] = None if status == "__NULL__" else status

# 3) due dates for the open rows — image 2 card 5:
#    6 overdue, 3 due today (24 Aug), 40 due 25–27 Aug, 19 later.
due_plan = (
    [CUTOFF - timedelta(days=1 + (i % 3)) for i in range(6)]        # overdue
    + [CUTOFF] * 3                                                   # due today
    + [CUTOFF + timedelta(days=1 + (i % 3)) for i in range(40)]      # 25–27 Aug
    + [CUTOFF + timedelta(days=4 + (i % 9)) for i in range(19)]      # later
)
assert len(due_plan) == 68, len(due_plan)
for r, due in zip(open_rows, due_plan):
    r["due_at"] = due
    if r["submitted_at"] is None:
        r["submitted_at"] = due - timedelta(days=5)

# 4) assignees on open rows. open_rows is in due-date order (overdue → today →
#    due-soon → later), so putting the seven WORKLOAD people on the most urgent
#    rows makes them the names on the Target-Date table (card 5) too. Then 12
#    rows stay unassigned, and every remaining row gets a DISTINCT person (one
#    request each) so the workload card (card 6) is topped by exactly the seven.
FILLER = [emp for emp, _ in EXTRA_STAFF] + [f"EMP-F{n:02d}" for n in range(1, 40)]
FILLER_NAMES = dict(EXTRA_STAFF)

idx = 0
for emp, _name, load in WORKLOAD:
    for _ in range(load):
        open_rows[idx]["assignee"] = emp
        idx += 1
idx += 12  # image 2 card 6: "12 คำขอที่ยังเปิดอยู่แต่ไม่ได้ระบุผู้รับผิดชอบ"
fi = 0
while idx < len(open_rows):
    open_rows[idx]["assignee"] = FILLER[fi]
    idx += 1
    fi += 1

# --- build the 51 action-log rows ------------------------------------------

action_rows = []
for dept, total in ACTIONLOG_BY_DEPT.items():
    # spread this team's logs over `distinct` requests it opened or received
    pool = [r["id"] for r in requests
            if r["opener"] == dept or r["receiver"] == dept]
    n_distinct = ACTIONLOG_DISTINCT[dept]
    targets = pool[:n_distinct] if len(pool) >= n_distinct else pool
    for i in range(total):
        rid = targets[i % len(targets)]
        action_rows.append({
            "request_id": rid,
            "dept": dept,
            "action_type": ACTION_TYPES[i % len(ACTION_TYPES)],
            "occurred_at": CUTOFF - timedelta(days=(i % 10)),
        })

assert len(action_rows) == 51, len(action_rows)


# --- emit -------------------------------------------------------------------

def emit():
    out = []
    out.append("-- GENERATED by gen_workshop_seed.py — do not edit by hand.")
    out.append("-- 92 requests + 51 action logs reproducing the two adoption")
    out.append("-- dashboards as of 2026-08-24. Re-run the generator to change.")
    out.append("\\set ON_ERROR_STOP on")
    out.append("BEGIN;")
    out.append("TRUNCATE workshop.action_log, workshop.request, workshop.staff RESTART IDENTITY;")
    out.append("")

    out.append("INSERT INTO workshop.staff (employee_code, full_name, dept_code) VALUES")
    dept_cycle = ["CRM", "BSD", "FAC", "ENG", "PCD"]
    # Emit exactly the people referenced by a request, with a real name for the
    # named staff and a plain placeholder for generic fillers.
    used = []
    seen = set()
    for r in requests:
        emp = r["assignee"]
        if emp and emp not in seen:
            seen.add(emp)
            used.append(emp)
    names = {emp: name for emp, name, _ in WORKLOAD}
    names.update(FILLER_NAMES)
    staff_rows = []
    for i, emp in enumerate(used):
        # Distinct placeholder per generic filler so a name-based grouping never
        # merges them into one giant bar ahead of the seven real people.
        name = names.get(emp, f"เจ้าหน้าที่ปฏิบัติการ {emp[-2:]}")
        staff_rows.append(
            f"  ({sql_str(emp)}, {sql_str(name)}, {sql_str(dept_cycle[i % len(dept_cycle)])})"
        )
    out.append(",\n".join(staff_rows) + ";")
    out.append("")

    out.append("INSERT INTO workshop.request")
    out.append("  (request_id, requester_dept_code, assignee_dept_code, assignee_emp_code,")
    out.append("   subject, status, submitted_at, due_at, closed_at) VALUES")
    req_rows = []
    for r in requests:
        subject = f"คำขอจาก {r['opener']}"
        req_rows.append(
            "  (" + ", ".join([
                sql_str(r["id"]),
                sql_str(r["opener"]),
                sql_str(r["receiver"]),
                sql_str(r["assignee"]),
                sql_str(subject),
                sql_str(r["status"]),
                sql_date(r["submitted_at"]),
                sql_date(r["due_at"]),
                sql_date(r["closed_at"]),
            ]) + ")"
        )
    out.append(",\n".join(req_rows) + ";")
    out.append("")

    out.append("INSERT INTO workshop.action_log")
    out.append("  (request_id, actor_dept_code, action_type, occurred_at) VALUES")
    act_rows = []
    for a in action_rows:
        act_rows.append(
            "  (" + ", ".join([
                sql_str(a["request_id"]),
                sql_str(a["dept"]),
                sql_str(a["action_type"]),
                sql_date(a["occurred_at"]),
            ]) + ")"
        )
    out.append(",\n".join(act_rows) + ";")
    out.append("")
    out.append("COMMIT;")
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    import sys
    sys.stdout.write(emit())
