/**
 * Loads the interim request log itself — `01_REQUEST_LOG` and `02_ACTION_LOG` —
 * into company `OSD`.
 *
 *   OSD_IMPORT_ALLOW=1 yarn data:import-requests
 *
 * Run `yarn data:import-catalog` first: this script resolves request types,
 * org units and people by the codes the catalog created, and refuses rather
 * than inventing any of them.
 *
 * **Rows that cannot be imported are reported, never dropped quietly.** Every
 * run rewrites `source/extracted/import-report.md` with one line per rejected
 * row, quoting the row number in the original spreadsheet so the person who
 * filled it in can find it. The source has real defects — see
 * `docs/REQUEST_RAW_STRUCTURE.md` §8 — and a silent import would turn them
 * into missing data nobody goes looking for.
 *
 * Idempotent: a request is matched on `formData.source_request_id` within the
 * company, so a second run updates rather than duplicates.
 */
import { PrismaClient, Prisma, RequestStatus } from '@prisma/client';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  codePart,
  date,
  loadSheets,
  number,
  text,
  type Row,
  type Sheets,
} from './request-log-source';

const prisma = new PrismaClient();

const COMPANY_CODE = 'OSD';
const REPORT_PATH = resolve(__dirname, '../../../source/extracted/import-report.md');

/** `12_LIST_CODE` status → `RequestStatus`. Eleven values, all accounted for. */
const STATUS: Record<string, RequestStatus> = {
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  PENDING_APPROVAL: 'pending_approval',
  RETURNED: 'returned',
  APPROVED: 'approved',
  IN_PROGRESS: 'in_progress',
  ON_HOLD: 'on_hold',
  COMPLETED: 'completed',
  CLOSED: 'closed',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
};

/** Column → `formData` key, for the fields with no column in `requests`. */
const FORM_FIELDS: Record<string, string> = {
  I: 'subject',
  J: 'objective',
  K: 'requirement_detail',
  L: 'expected_outcome',
  M: 'customer_project',
  N: 'cost_center',
  P: 'priority',
  Q: 'source_channel',
  W: 'current_owner_name',
  X: 'assignee_name',
  AA: 'result_summary',
  AB: 'legacy_doc_no',
  AE: 'is_backfill',
  AH: 'remark',
};

interface Rejection {
  readonly sheet: string;
  readonly row: number;
  readonly ref: string;
  readonly reason: string;
}

/**
 * Reserves the next request number.
 *
 * The statement is the one in
 * `services/core-service/src/requests/doc-number.service.ts`, which is the
 * authority — it is repeated here rather than imported because that file is a
 * Nest provider inside another workspace package, and pulling the Nest runtime
 * into a Prisma script to reuse ten lines of SQL costs more than it saves. If
 * the pattern or the padding changes there, change it here too.
 *
 * Read-then-write is not an option even in a single-threaded script: the
 * counter is shared with the running service, and a stale read would hand a
 * live submit a number this import has already used.
 */
async function issueRequestNo(
  companyId: string,
  docPrefix: string,
  typeCode: string,
  at: Date,
): Promise<string> {
  const yearMonth = at.getUTCFullYear() * 100 + (at.getUTCMonth() + 1);

  const config = await prisma.docNumberConfig.findUnique({
    where: { companyId_typeCode: { companyId, typeCode } },
  });

  const rows = await prisma.$queryRaw<{ lastSeq: number }[]>`
    INSERT INTO doc_number_counters
      (id, "companyId", "typeCode", "yearMonth", "lastSeq", "updatedAt")
    VALUES
      (gen_random_uuid(), ${companyId}, ${typeCode}, ${yearMonth}, 1, now())
    ON CONFLICT ("companyId", "typeCode", "yearMonth")
    DO UPDATE SET
      "lastSeq" = doc_number_counters."lastSeq" + 1,
      "updatedAt" = now()
    RETURNING "lastSeq"
  `;

  const padding = config?.seqPadding ?? 4;

  return (config?.pattern ?? '{PREFIX}-{TYPE}-{YYYYMM}-{SEQ}')
    .replace('{PREFIX}', docPrefix)
    .replace('{TYPE}', typeCode)
    .replace('{YYYYMM}', String(yearMonth))
    .replace('{SEQ}', String(rows[0].lastSeq).padStart(padding, '0'));
}

/** `employee_code` → the `User` row the catalog import created. */
async function loadPeople(sheets: Sheets): Promise<Map<string, string>> {
  const usernames = new Map<string, string>();
  for (const row of sheets['USERNAME_MAP'].filter((r) => r.row >= 2)) {
    const code = text(row, 'A');
    const username = text(row, 'B');
    if (code && username) usernames.set(code, username);
  }

  const users = await prisma.user.findMany({
    where: { username: { in: [...usernames.values()] } },
    select: { id: true, username: true },
  });
  const idByUsername = new Map(users.map((user) => [user.username, user.id]));

  const byEmployeeCode = new Map<string, string>();
  for (const [code, username] of usernames) {
    const id = idByUsername.get(username);
    if (id) byEmployeeCode.set(code, id);
  }

  return byEmployeeCode;
}

/**
 * The declared fields, read off the row.
 *
 * A value only travels if `FORM_FIELDS` names it, which mirrors the properties
 * `import-osd-catalog.ts` declares in `formSchema`. Anything the schema does
 * not declare is not carried — `formData` is the shape of a form, not a
 * dumping ground.
 */
function buildFormData(row: Row, sourceRequestId: string): Prisma.InputJsonValue {
  const data: Record<string, string | number> = {
    source_request_id: sourceRequestId,
  };

  for (const [column, field] of Object.entries(FORM_FIELDS)) {
    const value = text(row, column);
    if (value) data[field] = value;
  }

  const amount = number(row, 'O');
  if (amount !== null) data.amount = amount;

  const neededBy = row.dates?.S;
  if (neededBy) data.needed_by_date = neededBy;

  return data;
}

async function importRequests(
  companyId: string,
  docPrefix: string,
  sheets: Sheets,
  people: Map<string, string>,
  rejected: Rejection[],
): Promise<Map<string, string>> {
  const types = await prisma.requestType.findMany({
    where: { companies: { some: { companyId } } },
    select: { id: true, code: true, name: true, formSchema: true, requiredDocs: true, slaHours: true, approvalPolicy: true },
  });
  const typeByCode = new Map(types.map((type) => [type.code, type]));

  const units = await prisma.orgUnit.findMany({
    where: { companyId },
    select: { id: true, code: true },
  });
  const unitByCode = new Map(units.map((unit) => [unit.code, unit.id]));

  const idBySourceId = new Map<string, string>();

  for (const row of sheets['01_REQUEST_LOG'].filter((r) => r.row >= 6)) {
    const sourceId = text(row, 'B');
    const subject = text(row, 'I');
    if (!sourceId || !subject) continue;

    const reject = (reason: string) =>
      rejected.push({ sheet: '01_REQUEST_LOG', row: row.row, ref: sourceId, reason });

    const typeCode = codePart(text(row, 'C'));
    const type = typeByCode.get(typeCode);
    if (!type) {
      reject(`ไม่พบประเภทคำขอ "${typeCode}" — รัน data:import-catalog ก่อน`);
      continue;
    }

    const requesterCode = text(row, 'F');
    const requesterId = people.get(requesterCode);
    if (!requesterId) {
      reject(
        `ผู้ขอ "${requesterCode}" ไม่มีบัญชีในระบบ — ` +
          'ไม่มีใน USERNAME_MAP หรือยังไม่ได้ provision',
      );
      continue;
    }

    const rawStatus = text(row, 'V');
    const status = STATUS[rawStatus];
    if (!status) {
      reject(`สถานะ "${rawStatus}" ไม่อยู่ใน 12_LIST_CODE (กติกา ③)`);
      continue;
    }

    const submittedAt = date(row, 'R');
    if (!submittedAt) {
      reject('ไม่มีวันที่ส่งคำขอ (คอลัมน์ R) — บังคับกรอก');
      continue;
    }

    // Rule ④: a closed, rejected or cancelled request must say when.
    const completedAt = date(row, 'Y');
    if (!completedAt && ['closed', 'rejected', 'cancelled'].includes(status)) {
      reject(`สถานะ ${rawStatus} แต่ไม่มีวันที่ปิดคำขอ (คอลัมน์ Y) — ผิดกติกา ④`);
      continue;
    }

    // The source's own parent-request column is broken in every row that has
    // one, and there is no column to hold it anyway. Reported per row so the
    // count is visible rather than a footnote. NOT_MEARGE ข้อ 2.
    const parent = text(row, 'AD');
    if (parent) {
      rejected.push({
        sheet: '01_REQUEST_LOG',
        row: row.row,
        ref: sourceId,
        reason:
          parent === sourceId
            ? `คำขอต้นเรื่องชี้หาตัวเอง (${parent}) — ผิดกติกา ⑫ · ไม่ได้บันทึก`
            : `คำขอต้นเรื่อง "${parent}" — ระบบยังไม่มีที่เก็บ · ไม่ได้บันทึก`,
      });
    }

    const externalId = text(row, 'AC');

    const existing = await prisma.request.findFirst({
      where: {
        companyId,
        formData: { path: ['source_request_id'], equals: sourceId },
      },
      select: { id: true, requestNo: true },
    });

    const data = {
      requestTypeId: type.id,
      typeCode,
      companyId,
      requesterId,
      requesterOrgUnitId: unitByCode.get(text(row, 'H')) ?? null,
      status,
      formData: buildFormData(row, sourceId),
      refType: externalId ? 'legacy_system' : null,
      refId: externalId || null,
      // §7 / rule 7 of the working agreement: running work keeps the rules it
      // started under. Snapshotted at import because that is the moment this
      // request entered the system.
      typeSnapshot: {
        code: type.code,
        name: type.name,
        formSchema: type.formSchema,
        requiredDocs: type.requiredDocs,
        slaHours: type.slaHours,
        approvalPolicy: type.approvalPolicy,
      } as Prisma.InputJsonValue,
      submittedAt,
      dueAt: date(row, 'U'),
      completedAt,
      updatedBy: 'import',
    };

    if (existing) {
      await prisma.request.update({ where: { id: existing.id }, data });
      idBySourceId.set(sourceId, existing.id);
      continue;
    }

    const saved = await prisma.request.create({
      data: {
        ...data,
        // REQ-02: the number belongs to the receiving system, not to the
        // spreadsheet. The department's own number is kept in formData.
        requestNo: await issueRequestNo(companyId, docPrefix, typeCode, submittedAt),
        createdBy: 'import',
      },
    });

    idBySourceId.set(sourceId, saved.id);
  }

  return idBySourceId;
}

/**
 * `02_ACTION_LOG` → `RequestEvent`.
 *
 * No `ApprovalStep` is created: not one row in the source fills in the approval
 * level (rule ⑥), so there is no chain to reconstruct. Seventeen `APPROVED`
 * rows with no level are a record that somebody approved something, which is
 * what a timeline entry says — and is not enough to rebuild an approval case.
 */
async function importEvents(
  sheets: Sheets,
  requestIds: Map<string, string>,
  people: Map<string, string>,
  rejected: Rejection[],
): Promise<number> {
  const seqByRequest = new Map<string, number>();
  let imported = 0;

  for (const row of sheets['02_ACTION_LOG'].filter((r) => r.row >= 6)) {
    const action = text(row, 'H');
    if (!action) continue;

    const sourceId = text(row, 'B');
    const reject = (reason: string) =>
      rejected.push({ sheet: '02_ACTION_LOG', row: row.row, ref: sourceId || '—', reason });

    if (!sourceId) {
      reject('ไม่ได้กรอกเลขที่คำขอ (คอลัมน์ B) — ผูกกับคำขอไหนไม่ได้');
      continue;
    }

    const requestId = requestIds.get(sourceId);
    if (!requestId) {
      reject(
        `เลขที่คำขอ "${sourceId}" ไม่มีในชีต 01 ของไฟล์นี้ — ` +
          'อาจอยู่ในไฟล์ของแผนกอื่นที่ยังไม่ได้นำเข้า (กติกา ②)',
      );
      continue;
    }

    const actorCode = text(row, 'D');
    const actorId = people.get(actorCode) ?? null;

    const seq = (seqByRequest.get(requestId) ?? 0) + 1;
    seqByRequest.set(requestId, seq);

    const occurredAt = date(row, 'I');

    await prisma.requestEvent.upsert({
      where: { requestId_seq: { requestId, seq } },
      update: {},
      create: {
        requestId,
        seq,
        type: action,
        actorId,
        actorLabel: actorId ? null : text(row, 'E') || actorCode || 'import',
        data: {
          actor_dept_code: text(row, 'F') || null,
          actor_role: text(row, 'G') || null,
          comment: text(row, 'J') || null,
          delegated_from: text(row, 'K') || null,
          remark: text(row, 'L') || null,
          source_row: row.row,
        } as Prisma.InputJsonValue,
        ...(occurredAt ? { createdAt: occurredAt } : {}),
      },
    });

    imported += 1;
  }

  return imported;
}

/**
 * Attachments are not imported at all.
 *
 * `RequestAttachment` requires `mimeType`, `sizeBytes` and `storageKey`; the
 * source has a URL into another system and nothing else. Filling those three
 * with `0` and a guess would put a row in the database that claims to be a
 * file and is not — a download that fails is worse than an absence that is
 * written down. NOT_MEARGE ข้อ 3.
 */
function reportAttachments(sheets: Sheets, rejected: Rejection[]): void {
  for (const row of sheets['05_ATTACHMENT_LOG'].filter((r) => r.row >= 6)) {
    const sourceId = text(row, 'B');
    if (!sourceId) continue;

    rejected.push({
      sheet: '05_ATTACHMENT_LOG',
      row: row.row,
      ref: sourceId,
      reason:
        `ไฟล์ "${text(row, 'C')}" มีแต่ที่อยู่ ไม่มีไฟล์จริง — ` +
        'RequestAttachment บังคับ mimeType/sizeBytes/storageKey · NOT_MEARGE ข้อ 3',
    });
  }
}

function writeReport(rejected: Rejection[], counts: Record<string, number>): void {
  const lines = [
    '# รายงานการนำเข้าคำขอ',
    '',
    '> สร้างโดย `yarn data:import-requests` ทุกครั้งที่รัน — แก้ด้วยมือไม่มีประโยชน์',
    '',
    '## จำนวนที่นำเข้าได้',
    '',
    '| รายการ | จำนวน |',
    '|---|---|',
    ...Object.entries(counts).map(([label, value]) => `| ${label} | ${value} |`),
    '',
    `## แถวที่นำเข้าไม่ได้ (${rejected.length})`,
    '',
  ];

  if (!rejected.length) {
    lines.push('ไม่มี — ทุกแถวนำเข้าครบ');
  } else {
    lines.push('| ชีต | แถว | เลขที่คำขอ | เหตุผล |', '|---|---|---|---|');
    for (const item of rejected) {
      lines.push(
        `| \`${item.sheet}\` | ${item.row} | ${item.ref} | ${item.reason} |`,
      );
    }
  }

  lines.push(
    '',
    '---',
    '',
    'รายละเอียดของข้อบกพร่องแต่ละแบบอยู่ใน',
    '[`docs/REQUEST_RAW_STRUCTURE.md`](../../docs/REQUEST_RAW_STRUCTURE.md) §8',
    'และสิ่งที่ระบบยังรองรับไม่ได้อยู่ใน',
    '[`docs/REQUEST_RAW_NOT_MEARGE.md`](../../docs/REQUEST_RAW_NOT_MEARGE.md)',
    '',
  );

  writeFileSync(REPORT_PATH, lines.join('\n'), 'utf-8');
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to import interim spreadsheet data in production.');
  }
  if (process.env.OSD_IMPORT_ALLOW !== '1') {
    throw new Error(
      'Refusing to run without OSD_IMPORT_ALLOW=1.\n' +
        'This writes real request history into the database. Re-run as:\n' +
        '  OSD_IMPORT_ALLOW=1 yarn data:import-requests',
    );
  }

  const sheets = loadSheets();

  const company = await prisma.company.findUnique({
    where: { code: COMPANY_CODE },
  });
  if (!company) {
    throw new Error(`No company "${COMPANY_CODE}". Run \`yarn prisma:seed\` first.`);
  }

  const people = await loadPeople(sheets);
  if (!people.size) {
    throw new Error(
      'ไม่มีผู้ใช้ที่ตรงกับ USERNAME_MAP เลย — รัน `yarn data:import-catalog` ก่อน',
    );
  }

  const rejected: Rejection[] = [];

  const requestIds = await importRequests(
    company.id,
    company.docPrefix,
    sheets,
    people,
    rejected,
  );
  const events = await importEvents(sheets, requestIds, people, rejected);
  reportAttachments(sheets, rejected);

  const counts = {
    'คำขอ': requestIds.size,
    'เหตุการณ์ (RequestEvent)': events,
    'ผู้ใช้ที่จับคู่ได้': people.size,
  };

  writeReport(rejected, counts);

  console.log('นำเข้าคำขอของ OSD');
  for (const [label, value] of Object.entries(counts)) {
    console.log(`  ${label.padEnd(28)}${value}`);
  }
  console.log(`  ${'แถวที่นำเข้าไม่ได้'.padEnd(28)}${rejected.length}`);
  console.log(`\nรายงานฉบับเต็ม: ${REPORT_PATH}`);
}

main()
  .then(() => console.log('Done.'))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
