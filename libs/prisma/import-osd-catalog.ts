/**
 * Loads the OSD catalog — departments, request types and people — from the
 * interim Excel request logs into company `OSD`.
 *
 *   OSD_IMPORT_ALLOW=1 UAT_DEFAULT_PASSWORD=… yarn data:import-catalog
 *
 * Reads the JSON that `scripts/extract-request-log.py` writes, never the
 * `.xlsx` directly. See `docs/REQUEST_RAW_STRUCTURE.md` for what every column
 * means and where it lands.
 *
 * **This creates sign-in-able accounts for real employees.** It refuses to run
 * without `OSD_IMPORT_ALLOW=1`, and refuses outright under
 * `NODE_ENV=production` — the same containment `seed-uat.ts` uses, and for a
 * stronger reason: these are not invented characters.
 *
 * Idempotent. Every write is an upsert keyed on something stable (company +
 * code, or `keycloakId`), an account that already exists is reused, and its
 * password is left alone.
 *
 * What it deliberately does **not** do: invent data to fill a gap. Every row
 * the source cannot support is counted and printed at the end rather than
 * quietly patched — the source's own defects are findings, not noise.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import {
  connect,
  ensureKeycloakUser,
  grantRealmRole,
  grantSystemRole,
  readKeycloakEnv,
  upsertProfile,
  type KeycloakContext,
} from './keycloak-admin';
import {
  loadSheets,
  type Sheets,
  type Row,
  text,
  number,
} from './request-log-source';

const prisma = new PrismaClient();

const COMPANY_CODE = 'OSD';
const LEXTECH_CODE = 'LEXTECH';

/** A working day is eight hours — the source states SLA in days, we store hours. */
const HOURS_PER_DAY = 8;

/** Realm role every imported employee starts with (§5.2). */
const DEFAULT_ROLE = 'employee';

/**
 * Job title → the role that title implies.
 *
 * Order matters: the first pattern that matches wins, so `Chief Financial
 * Officer` is a CFO rather than merely an executive. Everyone keeps
 * `employee` as well — §5.2 makes it the base every user holds — and anyone
 * whose title matches nothing keeps only that, which is the honest answer for
 * a title this table has never seen.
 *
 * A guess here is visible and correctable on screen A4. Leaving every one of
 * the 73 imported people as `employee` was not: it meant nobody in the company
 * could approve or complete anything, and the process could not be finished at
 * all.
 */
const ROLE_BY_POSITION: readonly { readonly role: string; readonly match: RegExp }[] = [
  { role: 'ceo', match: /chief executive/i },
  { role: 'cfo', match: /chief financial/i },
  { role: 'executive', match: /chief |managing director|president/i },
  {
    role: 'department_manager',
    match: /\bmanager\b|\bhead\b|ผอ\.|ผู้จัดการ|ผู้อำนวยการ/i,
  },
  { role: 'team_lead', match: /supervisor|\blead\b|senior/i },
];

/** The role that lets somebody accept a ticket and finish it (§5.2). */
const RECEIVER_ROLE = 'receiver';

function roleForPosition(position: string): string | null {
  return (
    ROLE_BY_POSITION.find((entry) => entry.match.test(position))?.role ?? null
  );
}

/**
 * The form every interim request was filled in on.
 *
 * §16 A2's promise is that a request type's form is configuration; this is the
 * configuration that describes `01_REQUEST_LOG`. It is the same for all forty
 * types because the departments filled in one sheet for all of them — pretending
 * each type had its own form would be inventing structure the source never had.
 *
 * Every column of `01_REQUEST_LOG` that has no column in `requests` is declared
 * here, so the value that lands in `Request.formData` is a declared field
 * rather than a loose key. `docs/REQUEST_RAW_STRUCTURE.md` §3.1 is the
 * authority for which is which.
 */
function interimFormSchema(): Prisma.InputJsonValue {
  return {
    type: 'object',
    required: ['subject', 'objective', 'expected_outcome', 'priority', 'source_channel'],
    properties: {
      subject: { type: 'string', title: 'เรื่องที่ขอ', maxLength: 200, 'x-order': 10 },
      objective: {
        type: 'string',
        title: 'วัตถุประสงค์',
        'x-multiline': true,
        'x-order': 20,
      },
      requirement_detail: {
        type: 'string',
        title: 'ความต้องการ / สิ่งที่ต้องการ',
        'x-multiline': true,
        'x-order': 30,
      },
      expected_outcome: {
        type: 'string',
        title: 'ผลลัพธ์ที่คาดหวัง',
        'x-multiline': true,
        'x-order': 40,
      },
      customer_project: { type: 'string', title: 'ลูกค้า / โครงการ', 'x-order': 50 },
      cost_center: { type: 'string', title: 'ศูนย์ต้นทุน', 'x-order': 60 },
      // APV-02 measures this against the matrix ceilings. It lives here rather
      // than in a column — see REQUEST_RAW_NOT_MEARGE.md ข้อ 8.
      amount: { type: 'number', title: 'มูลค่า (บาท)', minimum: 0, 'x-order': 70 },
      priority: {
        type: 'string',
        title: 'ความเร่งด่วน',
        enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'],
        'x-order': 80,
      },
      source_channel: {
        type: 'string',
        title: 'ช่องทางที่รับเรื่อง',
        enum: ['EMAIL', 'LINE', 'PAPER', 'VERBAL', 'MEETING', 'SYSTEM', 'FORM'],
        'x-order': 90,
      },
      needed_by_date: {
        type: 'string',
        title: 'วันที่ต้องการได้รับ',
        format: 'date',
        'x-order': 100,
      },
      current_owner_name: { type: 'string', title: 'ขณะนี้อยู่ที่ใคร', 'x-order': 110 },
      assignee_name: {
        type: 'string',
        title: 'ผู้รับผิดชอบที่แผนกปลายทาง',
        'x-order': 120,
      },
      result_summary: {
        type: 'string',
        title: 'สรุปผลการดำเนินการ',
        'x-multiline': true,
        'x-order': 130,
      },
      legacy_doc_no: {
        type: 'string',
        title: 'เลขที่เอกสารอ้างอิงเดิม',
        'x-order': 140,
      },
      // The department's own request number. Kept because it is how a person
      // finds this row again in their spreadsheet, and how a re-run of the
      // importer recognises a request it has already loaded.
      source_request_id: {
        type: 'string',
        title: 'เลขที่คำขอในไฟล์ต้นทาง',
        'x-order': 150,
      },
      is_backfill: {
        type: 'string',
        title: 'บันทึกย้อนหลัง',
        enum: ['Y', 'N'],
        'x-order': 160,
      },
      remark: { type: 'string', title: 'หมายเหตุ', 'x-multiline': true, 'x-order': 170 },
    },
  };
}

interface Report {
  readonly rolesGranted: string[];
  readonly positionsUnmapped: string[];
  readonly orphanDepartments: string[];
  readonly divisionsWithoutName: string[];
  readonly positionUnits: string[];
  readonly splitDepartments: string[];
  readonly staleUnitsKept: string[];
  readonly staffWithoutUsername: string[];
  readonly usernamesWithoutStaff: string[];
  readonly createdAccounts: string[];
  readonly reusedAccounts: string[];
}

/** One row of `14_LIST_STAFF`, reduced to what the org tree needs. */
interface StaffPlacement {
  readonly employeeCode: string;
  readonly fullName: string;
  readonly position: string;
  readonly division: string;
  readonly department: string;
  readonly row: Row;
}

/**
 * The staff register, cleaned of the things that are not people.
 *
 * Row 78 repeats the header because the sheet holds two tables — see
 * `docs/REQUEST_RAW_STRUCTURE.md` ข้อบกพร่อง 6.
 */
function readStaff(sheets: Sheets): StaffPlacement[] {
  const people: StaffPlacement[] = [];

  for (const row of sheets['14_LIST_STAFF'].filter((r) => r.row >= 6)) {
    const employeeCode = text(row, 'B');
    if (!employeeCode || employeeCode === 'รหัส') continue;

    people.push({
      employeeCode,
      fullName: text(row, 'C') || employeeCode,
      position: text(row, 'E'),
      division: text(row, 'F'),
      department: text(row, 'G'),
      row,
    });
  }

  return people;
}

/**
 * Which company a person belongs to.
 *
 * `LEXTECH` is a separate business rather than a division of OSD: its people
 * carry `L-*` employee codes and its own English department names, none of
 * which appear in OSD's department register.
 */
function companyCodeFor(person: StaffPlacement): string {
  return person.division === LEXTECH_CODE ? LEXTECH_CODE : COMPANY_CODE;
}

/**
 * The key a position unit is looked up by: department plus job title.
 *
 * A title is not unique on its own — `พนักงานขาย` exists under several
 * departments and each is a different box on the chart — so the department has
 * to be part of the key or the whole company would collapse into one unit per
 * title, which is exactly the failure `User.position`'s doc comment warns of.
 */
function positionKey(department: string, position: string): string {
  return `${department}\u0000${position}`;
}

/**
 * A stable unit code for a position, derived from its title.
 *
 * Codes are unique per company (`@@unique([companyId, code])`) and are what an
 * admin reads on screen A3, so they have to survive a re-import unchanged.
 * Thai titles have no ASCII form worth writing, so the title is kept as-is with
 * only the characters that make a code unreadable removed, then prefixed with
 * the department. Collisions after that are titles that differ only in
 * punctuation, and they are resolved by suffix rather than silently merged.
 */
function positionCode(
  department: string,
  position: string,
  taken: Set<string>,
): string {
  const cleaned = position.replace(/[\s\u0000-\u001f]+/g, '-').replace(/-+/g, '-');
  const base = `${department}-${cleaned}`.slice(0, 60);

  let code = base;
  for (let n = 2; taken.has(code); n += 1) code = `${base}-${n}`;

  taken.add(code);
  return code;
}

/**
 * Builds one company's chart: root → ฝ่าย (DIVISION) → แผนก (DEPARTMENT)
 *                                   → ตำแหน่ง (POSITION).
 *
 * The staff register keeps `ฝ่าย`, `แผนก` and `ตำแหน่ง` in separate columns, so
 * the chart has four levels. The first import read only the department column
 * and hung every unit flat under the root; the second added divisions but still
 * parked every person directly in their department. This builds the last level
 * too, so a person sits in a position and a department is a branch again.
 *
 * `OrgClosure` is rebuilt from scratch at the end, exactly as `OrgService` does
 * after an edit — scope `team` and `department` resolve against that table, so
 * a stale closure silently changes who can see what.
 */
async function importOrgTree(
  companyId: string,
  companyCode: string,
  companyName: string,
  people: StaffPlacement[],
  sheets: Sheets,
  report: Report,
): Promise<Map<string, string>> {
  const byCode = new Map<string, string>();

  const root = await prisma.orgUnit.upsert({
    where: { companyId_code: { companyId, code: 'ROOT' } },
    update: { name: companyName, kind: 'COMPANY' },
    create: {
      companyId,
      code: 'ROOT',
      name: companyName,
      kind: 'COMPANY',
      createdBy: 'import',
    },
  });
  byCode.set('ROOT', root.id);

  /*
    Thai names for the departments that have one. Divisions have no name table
    at all, so their code doubles as their name — reported, not hidden.

    `11_LIST_DEPARTMENT` is *OSD's* register: its sixteen codes are OSD's
    departments, and none of LEXTECH's English department names appear in it.
    Applying it to both companies gave LEXTECH a copy of OSD's whole chart.
  */
  const departmentNames = new Map<string, string>();
  if (companyCode === COMPANY_CODE) {
    for (const row of sheets['11_LIST_DEPARTMENT'].filter((r) => r.row >= 6)) {
      const code = text(row, 'A');
      if (code) departmentNames.set(code, text(row, 'C') || text(row, 'B') || code);
    }
  }

  /*
    A department code is unique per company (`@@unique([companyId, code])`), so
    it can hang from exactly one division — but three of them appear under
    several. Resolved by headcount, ties broken by division code so the result
    is the same on every run, and every split is reported with its numbers.
  */
  const headcount = new Map<string, Map<string, number>>();
  for (const person of people) {
    if (!person.department || !person.division) continue;

    const divisions = headcount.get(person.department) ?? new Map<string, number>();
    divisions.set(person.division, (divisions.get(person.division) ?? 0) + 1);
    headcount.set(person.department, divisions);
  }

  const divisionOf = new Map<string, string>();
  for (const [department, divisions] of headcount) {
    const ranked = [...divisions.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );

    /*
      `Executive` is filed under a division also called `Executive`. Unit codes
      are unique per company, so both names are one row — and hanging that row
      from itself is a cycle that makes the closure rebuild run forever. The
      source is saying this division has no sub-department, so the row stays a
      division and its people attach there.
    */
    if (ranked[0][0] === department) {
      report.splitDepartments.push(
        `${companyCode}:${department} — ฝ่ายกับแผนกใช้รหัสเดียวกัน จึงเป็นหน่วยเดียว`,
      );
      continue;
    }

    divisionOf.set(department, ranked[0][0]);

    if (ranked.length > 1) {
      report.splitDepartments.push(
        `${companyCode}:${department} → ${ranked[0][0]} ` +
          `(${ranked.map(([code, n]) => `${code}=${n}`).join(' · ')})`,
      );
    }
  }

  const divisionCodes = new Set<string>();
  for (const divisions of headcount.values()) {
    for (const division of divisions.keys()) divisionCodes.add(division);
  }
  // Only the divisions something actually hangs from, plus the self-named ones
  // handled above — an unused division would be an empty box on the chart.
  const usedDivisions = new Set([
    ...divisionOf.values(),
    ...[...headcount.keys()].filter((code) => divisionCodes.has(code)),
  ]);

  const divisionUnits = new Set<string>();

  // Divisions first: a department cannot be created before its parent exists.
  for (const division of [...usedDivisions].sort()) {
    const saved = await prisma.orgUnit.upsert({
      where: { companyId_code: { companyId, code: division } },
      update: { kind: 'DIVISION', parentId: root.id },
      create: {
        companyId,
        code: division,
        name: division,
        kind: 'DIVISION',
        parentId: root.id,
        createdBy: 'import',
      },
    });

    byCode.set(division, saved.id);
    divisionUnits.add(division);
  }

  for (const [department, division] of [...divisionOf].sort()) {
    const parentId = byCode.get(division) ?? root.id;
    const known = departmentNames.has(department);

    const saved = await prisma.orgUnit.upsert({
      where: { companyId_code: { companyId, code: department } },
      update: {
        name: departmentNames.get(department) ?? department,
        kind: 'DEPARTMENT',
        parentId,
      },
      create: {
        companyId,
        code: department,
        name: departmentNames.get(department) ?? department,
        kind: 'DEPARTMENT',
        parentId,
        createdBy: known ? 'import' : 'import:staff-only',
      },
    });

    byCode.set(department, saved.id);

    /*
      A code the source uses for both a ฝ่าย and a แผนก — `ESD` is a division
      for one person and a department under EDO for three. Unit codes are unique
      per company, so the row cannot be both: the department wins, because that
      is where people sit. Reported, because the division reading is now gone.
    */
    if (divisionUnits.has(department)) {
      divisionUnits.delete(department);
      report.splitDepartments.push(
        `${companyCode}:${department} — เป็นทั้งฝ่ายและแผนก · เก็บเป็นแผนกใต้ ${division}`,
      );
    }

    /*
      A department the register never declared. Created so the people in it can
      be placed, but reported every time: most are free-text division names that
      leaked into a code column, and turning them into units silently would
      launder a defect in the source into what looks like a deliberate chart.
    */
    if (!known) report.orphanDepartments.push(`${companyCode}:${department}`);
  }

  /*
    Departments the register declares but nobody is in — `11_LIST_DEPARTMENT`
    lists sixteen and the staff sheet only fills some of them. Hung from the
    root because no division claims them; a guess would be worse than a shallow
    branch that is honestly empty.
  */
  for (const [code, name] of departmentNames) {
    if (byCode.has(code)) continue;

    const saved = await prisma.orgUnit.upsert({
      where: { companyId_code: { companyId, code } },
      update: { name, kind: 'DEPARTMENT' },
      create: {
        companyId,
        code,
        name,
        kind: 'DEPARTMENT',
        parentId: root.id,
        createdBy: 'import',
      },
    });

    byCode.set(code, saved.id);
  }

  for (const division of [...divisionUnits].sort()) {
    report.divisionsWithoutName.push(`${companyCode}:${division}`);
  }

  /*
    The fourth level: one unit per (department, job title) actually staffed.

    Built from the people rather than from a title register, because there is no
    title register — `14_LIST_STAFF` column E is the only place titles appear,
    and a title nobody holds would be an empty box.

    A person with no department has nowhere to hang a position from, so they
    stay unplaced and are already reported by `importStaff`.
  */
  const takenCodes = new Set(byCode.keys());
  const positions = new Map<string, { department: string; position: string }>();

  for (const person of people) {
    if (!person.position || !person.department) continue;
    if (!byCode.has(person.department)) continue;

    positions.set(positionKey(person.department, person.position), {
      department: person.department,
      position: person.position,
    });
  }

  for (const [key, { department, position }] of [...positions].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const parentId = byCode.get(department) as string;

    /*
      Matched on the parent and the title rather than on a generated code: the
      code is derived from the title and could drift between runs, and a second
      run must update the unit that is already there instead of creating a twin
      beside it.
    */
    const existing = await prisma.orgUnit.findFirst({
      where: { companyId, parentId, name: position, kind: 'POSITION' },
      select: { id: true, code: true },
    });

    const saved = existing
      ? await prisma.orgUnit.update({
          where: { id: existing.id },
          data: { name: position, kind: 'POSITION', parentId },
        })
      : await prisma.orgUnit.create({
          data: {
            companyId,
            code: positionCode(department, position, takenCodes),
            name: position,
            kind: 'POSITION',
            parentId,
            createdBy: 'import',
          },
        });

    if (existing) takenCodes.add(existing.code);
    byCode.set(key, saved.id);
    report.positionUnits.push(`${companyCode}:${saved.code}`);
  }

  await removeStaleUnits(companyId, byCode, report);
  await rebuildClosure(companyId);

  return byCode;
}

/**
 * Drops units left over from a previous import shape.
 *
 * The first import created 29 flat units under the root; re-running with the
 * three-level builder would otherwise leave the old ones beside the new. Only
 * units this importer created are considered, and only when nothing points at
 * them — a unit still holding people or requests is kept and reported, because
 * deleting it would either fail on a foreign key or orphan real rows.
 */
async function removeStaleUnits(
  companyId: string,
  byCode: Map<string, string>,
  report: Report,
): Promise<void> {
  const stale = await prisma.orgUnit.findMany({
    where: {
      companyId,
      id: { notIn: [...byCode.values()] },
      createdBy: { startsWith: 'import' },
    },
    select: {
      id: true,
      code: true,
      _count: { select: { members: true, children: true, receivedTypes: true } },
    },
  });

  for (const unit of stale) {
    const requests = await prisma.request.count({
      where: { requesterOrgUnitId: unit.id },
    });

    const blockers = [
      unit._count.members && `สมาชิก ${unit._count.members}`,
      unit._count.children && `หน่วยย่อย ${unit._count.children}`,
      unit._count.receivedTypes && `ประเภทคำขอ ${unit._count.receivedTypes}`,
      requests && `คำขอ ${requests}`,
    ].filter(Boolean);

    if (blockers.length) {
      report.staleUnitsKept.push(`${unit.code} (${blockers.join(' · ')})`);
      continue;
    }

    await prisma.orgClosure.deleteMany({
      where: { OR: [{ ancestorId: unit.id }, { descendantId: unit.id }] },
    });
    await prisma.orgUnit.delete({ where: { id: unit.id } });
  }
}

async function rebuildClosure(companyId: string): Promise<void> {
  const nodes = await prisma.orgUnit.findMany({
    where: { companyId },
    select: { id: true, parentId: true },
  });

  await prisma.orgClosure.deleteMany({ where: { ancestor: { companyId } } });

  const parentOf = new Map(nodes.map((node) => [node.id, node.parentId]));
  const rows: { ancestorId: string; descendantId: string; depth: number }[] = [];

  for (const node of nodes) {
    let depth = 0;
    let current: string | null = node.id;
    // A chart is a tree, but this data comes from a spreadsheet. Without the
    // seen-set a single self-parenting unit walks forever and takes the
    // process out of memory — which is exactly what it did.
    const seen = new Set<string>();

    while (current && !seen.has(current)) {
      seen.add(current);
      rows.push({ ancestorId: current, descendantId: node.id, depth });
      current = parentOf.get(current) ?? null;
      depth += 1;
    }

    if (current) {
      throw new Error(
        `ผังองค์กรมีวงรอบที่หน่วย ${current} — ตรวจ parentId ก่อน import ใหม่`,
      );
    }
  }

  await prisma.orgClosure.createMany({ data: rows });
}

/**
 * The forty types from `10_LIST_REQUEST_TYPE`.
 *
 * Only the six marked Release 1 are switched on. The rest are created inactive
 * because that is what the source says about them (`รอ sprint ถัดไป`) — an
 * inactive type is invisible on the submit screen but fully editable on A2,
 * which is where the remaining configuration will be filled in.
 */
async function importRequestTypes(
  companyId: string,
  sheets: Sheets,
  unitByCode: Map<string, string>,
): Promise<{ total: number; active: number }> {
  const schema = interimFormSchema();
  let total = 0;
  let active = 0;

  for (const row of sheets['10_LIST_REQUEST_TYPE']) {
    const code = text(row, 'A');
    if (!/^[A-Z]{2}-\d{2}$/.test(code)) continue;

    const name = text(row, 'B');
    const ownerDept = text(row, 'D');
    const slaDays = number(row, 'E');
    const release = text(row, 'F');
    const workflow = text(row, 'G');

    const isRelease1 = release === 'R1';
    if (isRelease1) active += 1;
    total += 1;

    const data = {
      name,
      receiverOrgUnitId: unitByCode.get(ownerDept) ?? null,
      formSchema: schema,
      requiredDocs: [] as Prisma.InputJsonValue,
      returnReasonCodes: [] as Prisma.InputJsonValue,
      /*
        `mode` is the only shape the approval engine implements (§8.1). The
        source's own workflow letter is carried alongside it rather than
        translated, because C ("no approval step") and D ("incident clock")
        have no implementation yet — recording the letter keeps the question
        answerable later instead of losing it at import.
        See REQUEST_RAW_NOT_MEARGE.md ข้อ 7.
      */
      approvalPolicy: {
        mode: 'standard_chain',
        amount_field: 'amount',
        source_workflow: workflow || null,
        source_category: text(row, 'C') || null,
      } as Prisma.InputJsonValue,
      slaHours: slaDays === null ? null : slaDays * HOURS_PER_DAY,
      slaCoverage: 'H8X5' as const,
      active: isRelease1,
    };

    const saved = await prisma.requestType.upsert({
      where: { code },
      update: { ...data, updatedBy: 'import' },
      create: { code, ...data, createdBy: 'import' },
    });

    await prisma.requestTypeCompany.upsert({
      where: {
        requestTypeId_companyId: { requestTypeId: saved.id, companyId },
      },
      update: { active: isRelease1 },
      create: { requestTypeId: saved.id, companyId, active: isRelease1 },
    });
  }

  return { total, active };
}

/** `นายสมชาย ใจดี` → given/family, for the realm's own name fields. */
function splitName(fullName: string): { firstName: string; lastName: string } {
  const bare = fullName.replace(/^(นาย|นางสาว|นาง|ดร\.|ม\.ล\.)\s*/u, '').trim();
  const parts = bare.split(/\s+/);

  return {
    firstName: parts[0] ?? bare,
    lastName: parts.slice(1).join(' ') || '—',
  };
}

/**
 * The people who have both a name and a username.
 *
 * Someone in `14_LIST_STAFF` with no row in `USERNAME_MAP` cannot get an
 * account, and a username with no staff row has no name to create one with.
 * Both are counted and reported instead of being filled in with a guess: a
 * fabricated username is a real account somebody could sign in to.
 */
async function importStaff(
  people: StaffPlacement[],
  companyIds: Map<string, string>,
  unitsByCompany: Map<string, Map<string, string>>,
  receivingUnitIds: Set<string>,
  sheets: Sheets,
  keycloak: KeycloakContext,
  report: Report,
): Promise<number> {
  const usernames = new Map<string, string>();
  for (const row of sheets['USERNAME_MAP'].filter((r) => r.row >= 2)) {
    const code = text(row, 'A');
    const username = text(row, 'B');
    if (code && username) usernames.set(code, username);
  }

  const known = new Set(people.map((person) => person.employeeCode));
  for (const code of usernames.keys()) {
    if (!known.has(code)) report.usernamesWithoutStaff.push(code);
  }

  let imported = 0;

  for (const person of people) {
    const username = usernames.get(person.employeeCode);
    if (!username) {
      report.staffWithoutUsername.push(person.employeeCode);
      continue;
    }

    const companyCode = companyCodeFor(person);
    const companyId = companyIds.get(companyCode);
    if (!companyId) continue;

    const units = unitsByCompany.get(companyCode);
    const departmentUnitId = units?.get(person.department) ?? null;

    /*
      People sit in a position, which hangs from their department. Falling back
      to the department covers the rows whose title column is blank — better a
      person one level up than a person with no place on the chart at all.
    */
    const unitId =
      (person.position
        ? units?.get(positionKey(person.department, person.position))
        : null) ?? departmentUnitId;

    const { firstName, lastName } = splitName(person.fullName);
    const account = await ensureKeycloakUser(keycloak, {
      username,
      email: `${username}@osd.co.th`,
      firstName,
      lastName,
    });

    await grantRealmRole(keycloak, account.id, DEFAULT_ROLE);

    const profileId = await upsertProfile(
      prisma,
      {
        username,
        displayName: person.fullName,
        firstName,
        lastName,
        email: `${username}@osd.co.th`,
        // The leaf of the chart, not the division or the department: a
        // position is the unit someone actually sits in.
        orgUnitId: unitId,
        position: person.position || null,
        keycloakRoles: [DEFAULT_ROLE],
      },
      account.id,
      companyId,
    );

    await grantSystemRole(prisma, profileId, companyId, DEFAULT_ROLE);

    /*
      The role the job title implies, on top of `employee`.

      Without this every imported person held `employee` alone, which carries
      neither `approval.decide` nor `request.complete` — nobody in the company
      could accept a ticket, check one, or finish one. A ticket system where no
      ticket can move is not a smaller feature set; it is no feature at all.
    */
    const mapped = roleForPosition(person.position);

    if (mapped) {
      await grantSystemRole(prisma, profileId, companyId, mapped);
      report.rolesGranted.push(`${username}=${mapped}`);
    } else if (person.position) {
      report.positionsUnmapped.push(`${person.position}`);
    }

    /*
      Anyone sitting in a unit that receives requests can act on them.

      `RequestType.receiverOrgUnitId` names the team a type is sent to, so its
      members are precisely the people who will be handed those tickets.
    */
    /*
      Keyed on the department, not on `unitId`. A request type names a
      department as its receiving unit, while a person now sits one level below
      it — comparing the two directly stopped matching the day positions were
      added, and silently left the whole company unable to accept a ticket.
    */
    if (departmentUnitId && receivingUnitIds.has(departmentUnitId)) {
      await grantSystemRole(prisma, profileId, companyId, RECEIVER_ROLE);
      report.rolesGranted.push(`${username}=${RECEIVER_ROLE}`);
    }

    (account.created ? report.createdAccounts : report.reusedAccounts).push(
      username,
    );
    imported += 1;
  }

  return imported;
}

function printReport(report: Report, counts: Record<string, number>): void {
  console.log('\nสรุปการนำเข้า catalog');
  for (const [label, value] of Object.entries(counts)) {
    console.log(`  ${label.padEnd(28)}${value}`);
  }

  const section = (title: string, items: string[]) => {
    if (!items.length) return;
    console.log(`\n${title} (${items.length})`);
    console.log(`  ${items.join(' · ')}`);
  };

  if (report.rolesGranted.length) {
    const counts = new Map<string, number>();
    for (const entry of report.rolesGranted) {
      const role = entry.split('=')[1];
      counts.set(role, (counts.get(role) ?? 0) + 1);
    }

    console.log('\nrole ที่ให้เพิ่มจากตำแหน่งงาน (ทุกคนยังถือ employee ด้วย)');
    for (const [role, count] of [...counts].sort()) {
      console.log(`  ${role.padEnd(22)}${count} คน`);
    }
  }

  section(
    'ตำแหน่งที่แมปเป็น role ไม่ได้ — คงเป็น employee · ตรวจที่หน้า A4',
    [...new Set(report.positionsUnmapped)].sort(),
  );

  section(
    'แผนกที่อยู่หลายฝ่าย — เลือกฝ่ายที่มีคนมากที่สุด',
    report.splitDepartments,
  );
  section(
    'รหัสแผนกที่ไม่มีใน 11_LIST_DEPARTMENT — สร้างจากข้อมูลพนักงาน',
    report.orphanDepartments,
  );
  section(
    'ฝ่ายที่ใช้รหัสเป็นชื่อ — ต้นทางไม่มีตารางชื่อฝ่าย',
    report.divisionsWithoutName,
  );
  section(
    'หน่วยงานเก่าที่ลบไม่ได้เพราะยังมีข้อมูลอ้างอยู่',
    report.staleUnitsKept,
  );
  section(
    'พนักงานที่ไม่มี username ใน USERNAME_MAP — ไม่ได้สร้างบัญชี',
    report.staffWithoutUsername,
  );
  section(
    'username ที่ไม่มีแถวใน 14_LIST_STAFF — ไม่รู้ชื่อ จึงไม่ได้สร้างบัญชี',
    report.usernamesWithoutStaff,
  );

  console.log(
    '\nสายบังคับบัญชา: ไม่ได้ตั้งให้ใครเลย — 13_LIST_USER มีแต่แถวตัวอย่าง',
  );
  console.log(
    '  ทุกคนจึงอยู่ในคิว "รอจัดสังกัด" และสายอนุมัติชั้นที่ 1 (§8.1) ยังหาผู้อนุมัติไม่ได้',
  );
  console.log('  ดู docs/REQUEST_RAW_NOT_MEARGE.md ข้อ 5');
}

async function main(): Promise<void> {
  const env = readKeycloakEnv(
    'OSD_IMPORT_ALLOW',
    'OSD_IMPORT_ALLOW=1 UAT_DEFAULT_PASSWORD=… yarn data:import-catalog',
  );

  const sheets = loadSheets();
  const people = readStaff(sheets);

  const companies = await prisma.company.findMany({
    where: { code: { in: [COMPANY_CODE, LEXTECH_CODE] } },
  });

  const companyIds = new Map(companies.map((c) => [c.code, c.id]));
  for (const code of [COMPANY_CODE, LEXTECH_CODE]) {
    if (!companyIds.has(code)) {
      throw new Error(`No company "${code}". Run \`yarn prisma:seed\` first.`);
    }
  }

  console.log(`นำเข้า catalog ของ ${COMPANY_CODE} · realm "${env.realm}"`);

  const report: Report = {
    rolesGranted: [],
    positionsUnmapped: [],
    orphanDepartments: [],
    divisionsWithoutName: [],
    positionUnits: [],
    splitDepartments: [],
    staleUnitsKept: [],
    staffWithoutUsername: [],
    usernamesWithoutStaff: [],
    createdAccounts: [],
    reusedAccounts: [],
  };

  // One chart per company: LEXTECH's people never appear under OSD's root.
  const unitsByCompany = new Map<string, Map<string, string>>();
  for (const company of companies) {
    unitsByCompany.set(
      company.code,
      await importOrgTree(
        company.id,
        company.code,
        company.name,
        people.filter((person) => companyCodeFor(person) === company.code),
        sheets,
        report,
      ),
    );
  }

  const osdUnits = unitsByCompany.get(COMPANY_CODE) ?? new Map<string, string>();

  // The forty types are OSD's catalog. LEXTECH has none of its own in the
  // source, and copying OSD's would be inventing its configuration.
  const types = await importRequestTypes(
    companyIds.get(COMPANY_CODE) as string,
    sheets,
    osdUnits,
  );

  /*
    The units that receive work. Their members get the `receiver` role, which
    is what makes "รับเรื่อง" and "เสร็จ" possible for somebody.
  */
  const receivingUnitIds = new Set(
    (
      await prisma.requestType.findMany({
        where: {
          companies: { some: { companyId: companyIds.get(COMPANY_CODE) } },
          receiverOrgUnitId: { not: null },
        },
        select: { receiverOrgUnitId: true },
      })
    )
      .map((type) => type.receiverOrgUnitId)
      .filter((id): id is string => id !== null),
  );

  const keycloak = await connect(env);
  const imported = await importStaff(
    people,
    companyIds,
    unitsByCompany,
    receivingUnitIds,
    sheets,
    keycloak,
    report,
  );

  const positionsIn = (code: string) =>
    report.positionUnits.filter((entry) => entry.startsWith(`${code}:`)).length;

  printReport(report, {
    // `unitsByCompany` is keyed by unit code *and* by (department, position),
    // so its raw size would double-count the fourth level.
    'หน่วยงาน OSD': osdUnits.size - positionsIn(COMPANY_CODE),
    '  ตำแหน่ง (ชั้นที่ 4)': positionsIn(COMPANY_CODE),
    'หน่วยงาน LEXTECH':
      (unitsByCompany.get(LEXTECH_CODE)?.size ?? 0) - positionsIn(LEXTECH_CODE),
    'ประเภทคำขอ': types.total,
    '  เปิดใช้ (Release 1)': types.active,
    'พนักงานที่นำเข้า': imported,
    '  สร้างบัญชีใหม่': report.createdAccounts.length,
    '  ใช้บัญชีเดิม': report.reusedAccounts.length,
  });
}

main()
  .then(() => console.log('\nDone.'))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
