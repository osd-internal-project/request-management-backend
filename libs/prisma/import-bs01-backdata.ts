/**
 * Loads the departments' interim request logs into type `BS-01` (คำขอทั่วไป).
 *
 *   yarn data:import-bs01-backdata                            # dry run, reads only
 *   OSD_IMPORT_ALLOW=1 yarn data:import-bs01-backdata --apply # writes
 *
 * Input is `source/bakdata/preview/BS-01-import.json` — the `import_ok=Y` rows
 * of the reviewed preview CSV. Rows the preview rejected never reach this file.
 *
 * Numbers come from the real `RunNumberService` (run_number_* belongs to
 * run-number-service), booted in-process; `import-osd-requests.ts` still
 * writes the retired doc_number_counters and must not be copied.
 *
 * Idempotent: a request already imported (matched on `formData.source_request_id`)
 * is skipped, never updated — people may have worked it since, and a re-run
 * must not overwrite that with the spreadsheet's status.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { Prisma, PrismaClient, RequestStatus } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AuditModule, PrismaModule } from '@request-management/share';
import { RunNumberModule } from '../../services/run-number-service/src/run-number/run-number.module';
import { RunNumberService } from '../../services/run-number-service/src/run-number/run-number.service';

const COMPANY_CODE = 'OSD';
const TYPE_CODE = 'BS-01';
const ACTOR = 'import-bs01-backdata';
const INPUT = resolve(__dirname, '../../../source/bakdata/preview/BS-01-import.json');

interface Row {
  readonly source_file: string;
  readonly source_request_id: string;
  readonly status: RequestStatus;
  readonly requester_email: string;
  readonly requester_org_unit: string;
  readonly receiver_email: string;
  readonly submitted_at: string;
  readonly due_at: string;
  readonly completed_at: string;
  readonly 'form.subject': string;
  readonly 'form.objective': string;
  readonly 'form.request_type': string;
  readonly 'form.description': string;
  readonly 'receiver.summary': string;
}

@Module({ imports: [PrismaModule, AuditModule, RunNumberModule] })
class ImportModule {}

const prisma = new PrismaClient();
const day = (iso: string): Date | null => (iso ? new Date(`${iso}T00:00:00Z`) : null);

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  if (apply && process.env.OSD_IMPORT_ALLOW !== '1') {
    throw new Error('Refusing to write without OSD_IMPORT_ALLOW=1.');
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to import interim spreadsheet data in production.');
  }

  const rows = (JSON.parse(readFileSync(INPUT, 'utf-8')) as Row[]).sort((a, b) =>
    a.submitted_at.localeCompare(b.submitted_at),
  );

  const company = await prisma.company.findUniqueOrThrow({ where: { code: COMPANY_CODE } });
  const type = await prisma.requestType.findUniqueOrThrow({ where: { code: TYPE_CODE } });

  const emails = [...new Set(rows.flatMap((r) => [r.requester_email, r.receiver_email]).filter(Boolean))];
  const users = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { id: true, email: true },
  });
  const userId = new Map(users.map((u) => [u.email, u.id]));

  const units = await prisma.orgUnit.findMany({
    where: { companyId: company.id },
    select: { id: true, name: true },
  });
  const unitId = new Map(units.map((u) => [u.name, u.id]));

  const existing = await prisma.request.findMany({
    where: { companyId: company.id, typeCode: TYPE_CODE, createdBy: ACTOR },
    select: { id: true, formData: true },
  });
  const idBySource = new Map(
    existing.map((r) => [(r.formData as { source_request_id?: string }).source_request_id, r.id]),
  );

  const typeSnapshot = {
    code: type.code,
    name: type.name,
    formSchema: type.formSchema,
    receiverFormSchema: type.receiverFormSchema,
    requiredDocs: type.requiredDocs,
    returnReasonCodes: type.returnReasonCodes,
    approvalPolicy: type.approvalPolicy,
    slaHours: type.slaHours,
    receiverOrgUnitId: type.receiverOrgUnitId,
    subRequestTypes: type.subRequestTypes,
  } as Prisma.InputJsonValue;

  const build = (row: Row) => {
    const requesterId = userId.get(row.requester_email);
    if (!requesterId) throw new Error(`${row.source_request_id}: ไม่พบผู้ขอ ${row.requester_email}`);
    const ended = day(row.completed_at);

    return {
      requestTypeId: type.id,
      typeCode: TYPE_CODE,
      companyId: company.id,
      requesterId,
      requesterOrgUnitId: unitId.get(row.requester_org_unit) ?? null,
      receiverUserId: userId.get(row.receiver_email) ?? null,
      receiverOrgUnitId: type.receiverOrgUnitId,
      status: row.status,
      formData: {
        subject: row['form.subject'],
        objective: row['form.objective'],
        request_type: row['form.request_type'],
        description: row['form.description'],
        source_request_id: row.source_request_id,
      },
      receiverFormData: row['receiver.summary'] ? { summary: row['receiver.summary'] } : {},
      typeSnapshot,
      submittedAt: day(row.submitted_at),
      dueAt: day(row.due_at),
      completedAt: ['completed', 'approved', 'closed'].includes(row.status) ? ended : null,
      closedAt: row.status === 'closed' ? ended : null,
      cancelledAt: row.status === 'cancelled' ? ended : null,
      updatedBy: ACTOR,
    };
  };

  // Every row is built before anything is written, so a bad row stops the run at zero writes.
  const payloads = rows.map((row) => ({ row, data: build(row) }));
  const toCreate = payloads.filter((p) => !idBySource.has(p.row.source_request_id));

  const app = await NestFactory.createApplicationContext(ImportModule, { logger: ['error'] });
  const numbers = app.get(RunNumberService);
  const ctx = {
    companyId: company.id,
    docType: 'REQUEST' as const,
    scopeKey: TYPE_CODE,
    companyPrefix: company.docPrefix,
    companyCode: company.code,
    master: { 'M:REQUEST_TYPE': TYPE_CODE },
  };

  console.log(`โหมด: ${apply ? 'APPLY (เขียน DB)' : 'dry-run (อ่านอย่างเดียว)'}`);
  console.log(`แถวในไฟล์ ${rows.length} · สร้างใหม่ ${toCreate.length} · ข้าม (มีอยู่แล้ว) ${rows.length - toCreate.length}`);
  console.log(`ผู้รับที่จับคู่ได้ ${payloads.filter((p) => p.data.receiverUserId).length} · แผนกผู้ขอที่จับคู่ได้ ${payloads.filter((p) => p.data.requesterOrgUnitId).length}`);

  if (!apply) {
    const next = await numbers.preview({ ...ctx, at: new Date() });
    console.log(`เลขที่ใบแรกที่จะออก ${next.number} (pattern ${next.pattern}, period ${next.periodKey})`);
    for (const p of toCreate.slice(0, 2).concat(toCreate.slice(-1))) {
      console.log(JSON.stringify({ ...p.data, typeSnapshot: '(BS-01)' }, null, 1));
    }
    await app.close();
    return;
  }

  let created = 0;
  for (const { data } of toCreate) {
    let requestNo: string;
    do {
      requestNo = (await numbers.issue({ ...ctx, at: new Date() })).number;
    } while (await prisma.request.findUnique({ where: { requestNo }, select: { id: true } }));

    await prisma.request.create({ data: { ...data, requestNo, createdBy: ACTOR } });
    created += 1;
  }

  console.log(`สร้าง ${created}`);
  await app.close();
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
