import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { PrismaService } from '@request-management/share';
import { RequestsService } from '../services/core-service/src/requests/requests.service';
import type { CreateRequestTypeDto } from '../services/core-service/src/requests/dto/request.dto';
import { text, number, type Row } from '../libs/prisma/request-log-source';
import {
  connectAdmin,
  findAccount,
  grantSystemRole,
  readRealmSettings,
  updateAccountEmail,
  upsertProfile,
  type KeycloakAdminContext,
} from '../libs/prisma/keycloak-admin';
import {
  bootRequestsContext,
  describeError,
  isApply,
  maskedDatabaseTarget,
  scriptPrincipal,
} from './request-type-script-context';

/**
 * Brings company OSD in line with the fourteen 2569 Request Logs: departments
 * (named `FAC · Finance & Accounting`), every request type active with BS-01's
 * form, `receiver` for the owning departments, and the staff register's names.
 * Dry-run unless `--apply`; `SYNC_OSD_KEYCLOAK=1` adds the id24 lookups and the
 * one email fix — it never creates a realm account.
 */

const SOURCE_DIR =
  process.env.REQUEST_LOG_DIR ?? resolve(__dirname, '../../source/bakdata/extracted');
const COMPANY_CODE = 'OSD';
const ROOT_UNIT_CODE = 'OSD-OU0001';
const ACTOR = 'script:sync-osd-catalog';
const HOURS_PER_DAY = 8;
const TYPE_CODE = /^[A-Z]{2}-\d{2}$/;
const THAI = /[฀-๿]/;
/** PS-01 is `PS01`, seeded with its own form by seed-presales-type.ts. */
const SKIP_TYPES = new Set(['PS-01']);
/** From the old user export (source/users_202609160951.csv); the 2569 logs have no email for them. */
const STAFF_EMAILS: Record<string, string> = { 'EMP-234': 'khunnaphatk@osd.co.th' };
/** Stated by the user on 10 Nov 2026; no source file carries it. */
const EMAIL_FIXES: Record<string, string> = { anuwatp: 'anuwatp@osd.co.th' };

interface Action {
  label: string;
  run: () => Promise<void>;
}

/** One sheet from every extracted workbook. */
function sheetFromAll(sheet: string): Row[][] {
  return readdirSync(SOURCE_DIR)
    .map((dir) => join(SOURCE_DIR, dir, `${sheet}.json`))
    .filter((file) => existsSync(file))
    // The extractor writes `Row[]`; scripts/extract-request-log.py is the contract.
    .map((file) => JSON.parse(readFileSync(file, 'utf8')) as Row[]);
}

/** The value most files agree on — two files carry a stray variant of PC-02. */
function majority<T>(values: T[]): T {
  const counts = new Map<string, { value: T; n: number }>();
  for (const value of values) {
    const key = JSON.stringify(value);
    const entry = counts.get(key) ?? { value, n: 0 };
    entry.n += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0].value;
}

function readTypes() {
  const seen = new Map<string, { name: string; category: string; owner: string; slaDays: number | null; workflow: string }[]>();
  for (const rows of sheetFromAll('10_LIST_REQUEST_TYPE')) {
    for (const row of rows) {
      const code = text(row, 'A');
      if (!TYPE_CODE.test(code) || SKIP_TYPES.has(code)) continue;
      const list = seen.get(code) ?? [];
      list.push({
        name: text(row, 'B').replace(/\s+/g, ' '),
        category: text(row, 'C'),
        owner: text(row, 'D'),
        slaDays: number(row, 'E'),
        workflow: text(row, 'G'),
      });
      seen.set(code, list);
    }
  }
  return [...seen].map(([code, variants]) => ({ code, ...majority(variants) }));
}

function readDepartments(): Map<string, string> {
  const labels = new Map<string, string>();
  for (const rows of sheetFromAll('11_LIST_DEPARTMENT')) {
    for (const row of rows.filter((r) => r.row >= 6)) {
      const code = text(row, 'A');
      const english = text(row, 'B');
      if (code && english && !labels.has(code)) labels.set(code, `${code} · ${english}`);
    }
  }
  return labels;
}

function readStaff() {
  const staff = new Map<string, { name: string; position: string; dept: string }>();
  for (const rows of sheetFromAll('14_LIST_STAFF')) {
    for (const row of rows.filter((r) => r.row >= 6)) {
      const code = text(row, 'B');
      if (!code || code === 'employee_code' || code === 'รหัส' || !text(row, 'C') || staff.has(code)) continue;
      if (text(row, 'F') === 'LEXTECH') continue;
      staff.set(code, { name: text(row, 'C'), position: text(row, 'E'), dept: text(row, 'G') });
    }
  }
  return staff;
}

const bareName = (name: string) =>
  name.replace(/^(นาย|นางสาว|นาง|ดร\.|ม\.ล\.)\s*/u, '').replace(/\s+/g, '');

async function main() {
  const apply = isApply(process.argv.slice(2));
  console.log(`DB: ${maskedDatabaseTarget()} | source: ${SOURCE_DIR} | mode: ${apply ? 'APPLY' : 'dry-run'}`);

  const keycloak: KeycloakAdminContext | null =
    process.env.SYNC_OSD_KEYCLOAK === '1'
      ? await connectAdmin(
          readRealmSettings('SYNC_OSD_KEYCLOAK', 'SYNC_OSD_KEYCLOAK=1 yarn data:sync-osd-catalog'),
        )
      : null;

  const app = await bootRequestsContext();
  try {
    const prisma = app.get(PrismaService);
    const requests = app.get(RequestsService);
    const company = await prisma.company.findUniqueOrThrow({ where: { code: COMPANY_CODE } });
    const actor = { ...(await scriptPrincipal(app, 'sync-osd-catalog')), activeCompanyId: company.id };

    const actions: Action[] = [];
    const notes: string[] = [];

    // ── departments ──────────────────────────────────────────────────────
    const units = await prisma.orgUnit.findMany({ where: { companyId: company.id } });
    const unitIds = new Map<string, string>();
    const findUnit = (code: string) =>
      units.find((u) => u.kind !== 'POSITION' && (u.name === code || u.name.startsWith(`${code} · `)));
    const root = units.find((u) => u.code === ROOT_UNIT_CODE);
    if (!root) throw new Error(`No root unit ${ROOT_UNIT_CODE} in ${COMPANY_CODE}`);
    let nextUnitNo = Math.max(...units.map((u) => Number(/^OSD-OU(\d+)$/.exec(u.code)?.[1] ?? 0))) + 1;

    for (const [code, label] of readDepartments()) {
      const unit = findUnit(code);
      if (unit) {
        unitIds.set(code, unit.id);
        if (unit.name !== label) {
          actions.push({
            label: `UNIT     rename ${unit.code} "${unit.name}" → "${label}"`,
            run: async () => {
              await prisma.orgUnit.update({ where: { id: unit.id }, data: { name: label, updatedBy: ACTOR } });
            },
          });
        }
        continue;
      }
      const unitCode = `OSD-OU${String(nextUnitNo++).padStart(4, '0')}`;
      actions.push({
        label: `UNIT     create ${unitCode} "${label}" under ${root.code}`,
        run: async () => {
          const created = await prisma.$transaction(async (tx) => {
            const row = await tx.orgUnit.create({
              data: { companyId: company.id, code: unitCode, name: label, kind: 'DEPARTMENT', parentId: root.id, createdBy: ACTOR, updatedBy: ACTOR },
            });
            const above = await tx.orgClosure.findMany({ where: { descendantId: root.id } });
            await tx.orgClosure.createMany({
              data: [
                { ancestorId: row.id, descendantId: row.id, depth: 0 },
                ...above.map((a) => ({ ancestorId: a.ancestorId, descendantId: row.id, depth: a.depth + 1 })),
              ],
            });
            return row;
          });
          unitIds.set(code, created.id);
        },
      });
    }
    const unitOf = (code: string) => unitIds.get(code) ?? null;

    // ── request types ────────────────────────────────────────────────────
    const generalForm = (
      await prisma.requestType.findUniqueOrThrow({ where: { code: 'BS-01' }, select: { formSchema: true } })
    ).formSchema as { properties: Record<string, unknown>; required?: string[] };
    // BS-01's `request_type` enum (RQ-001) belongs to BS-01 alone.
    const { request_type: _bs01Only, ...properties } = generalForm.properties;
    const formSchema = {
      ...generalForm,
      properties,
      required: (generalForm.required ?? []).filter((key) => key !== 'request_type'),
    };

    const existingTypes = await prisma.requestType.findMany({
      include: { companies: { where: { companyId: company.id } } },
    });
    const effectiveReceivers = new Set<string>();

    for (const type of readTypes()) {
      const existing = existingTypes.find((t) => t.code === type.code);
      if (!existing) {
        actions.push({
          label: `TYPE     create ${type.code} ${type.name} → ${type.owner} (${type.slaDays ?? '-'}d, wf ${type.workflow})`,
          run: async () => {
            const dto: CreateRequestTypeDto = {
              code: type.code,
              name: type.name,
              receiver_org_unit_id: unitOf(type.owner) ?? undefined,
              form_schema: formSchema,
              approval_policy: {
                mode: 'standard_chain',
                amount_field: 'amount',
                source_workflow: type.workflow || null,
                source_category: type.category || null,
              },
              sla_hours: type.slaDays === null ? undefined : type.slaDays * HOURS_PER_DAY,
              sla_coverage: 'H8X5',
              company_ids: [company.id],
              active: true,
            };
            await requests.createType(dto, actor);
          },
        });
        effectiveReceivers.add(type.owner);
        continue;
      }

      const ownerUnit = unitOf(type.owner);
      const hasReceiver = existing.receiverOrgUnitId || existing.receiverUserId;
      if (existing.receiverOrgUnitId && ownerUnit && existing.receiverOrgUnitId !== ownerUnit) {
        const current = units.find((u) => u.id === existing.receiverOrgUnitId);
        notes.push(`${type.code} ผู้รับใน DB = ${current?.name ?? existing.receiverOrgUnitId}, ต้นทาง = ${type.owner} — คงของ DB`);
      }
      // BS-01 names the whole company; that is "anyone may be handed it", not a team to grant.
      if (existing.receiverOrgUnitId) {
        if (existing.receiverOrgUnitId !== root.id) effectiveReceivers.add(existing.receiverOrgUnitId);
      } else if (!existing.receiverUserId) {
        effectiveReceivers.add(type.owner);
      }

      const active = existing.active && existing.companies.every((c) => c.active) && existing.companies.length > 0;
      if (active && hasReceiver) continue;
      actions.push({
        label: `TYPE     update ${type.code}${active ? '' : ' active=true'}${hasReceiver ? '' : ` receiver=${type.owner}`}`,
        run: async () => {
          await requests.updateType(
            type.code,
            {
              ...(active ? {} : { active: true }),
              ...(hasReceiver ? {} : { receiver_org_unit_id: unitOf(type.owner) }),
            },
            actor,
          );
        },
      });
    }

    // ── people ───────────────────────────────────────────────────────────
    const people = await prisma.user.findMany({
      where: { companies: { some: { companyId: company.id } } },
      include: { roles: { where: { companyId: company.id }, include: { role: true } } },
    });
    const staff = readStaff();
    const byName = new Map(people.map((u) => [bareName(u.displayName), u]));
    const byEmployee = new Map(people.filter((u) => u.employeeId).map((u) => [u.employeeId, u]));
    /*
      The old USERNAME_MAP gave `khunnaphatk` to EMP-233; the old user export
      says the account is EMP-234's. A known email wins, and the person it was
      taken from is left without an account and reported.
    */
    const reclaimed = new Map<string, (typeof people)[number]>();
    for (const [code, email] of Object.entries(STAFF_EMAILS)) {
      const holder = people.find((u) => u.username === email.split('@')[0]);
      if (!holder || holder.employeeId === code) continue;
      reclaimed.set(code, holder);
      if (holder.employeeId) byEmployee.delete(holder.employeeId);
      byName.delete(bareName(holder.displayName));
      notes.push(`${holder.username} เคยผูกกับ ${holder.employeeId ?? '-'} ${holder.displayName} — ย้ายให้ ${code} ตาม email`);
    }

    for (const [code, person] of staff) {
      const user = byEmployee.get(code) ?? byName.get(bareName(person.name));
      if (user) {
        const data = {
          ...(user.employeeId ? {} : { employeeId: code }),
          ...(THAI.test(user.displayName) ? {} : { displayName: person.name }),
        };
        if (Object.keys(data).length) {
          actions.push({
            label: `USER     ${user.username} ${JSON.stringify(data)}`,
            run: async () => {
              await prisma.user.update({ where: { id: user.id }, data: { ...data } });
            },
          });
        }
        continue;
      }

      const owned = reclaimed.get(code);
      if (owned) {
        const data = { employeeId: code, displayName: person.name, position: person.position || null, orgUnitId: unitOf(person.dept) };
        actions.push({
          label: `USER     relabel ${owned.username}: ${owned.employeeId} ${owned.displayName} → ${code} ${person.name} (${person.dept})`,
          run: async () => {
            await prisma.user.update({ where: { id: owned.id }, data });
          },
        });
        continue;
      }

      const email = STAFF_EMAILS[code];
      if (!email) {
        notes.push(`${code} ${person.name} (${person.dept}) ไม่ได้สร้าง — ไม่มี email`);
        continue;
      }
      const username = email.split('@')[0];
      const account = keycloak ? await findAccount(keycloak, username) : null;
      if (!account) {
        notes.push(`${code} ${username} ${keycloak ? 'ไม่มีบัญชีใน id24 — ต้องสร้างก่อน (ถามผู้ใช้)' : 'ข้าม — รันด้วย SYNC_OSD_KEYCLOAK=1 เพื่อค้น id24'}`);
        continue;
      }
      actions.push({
        label: `USER     add ${username} (${code} ${person.name}) → ${person.dept} + employee`,
        run: async () => {
          const [first, ...rest] = person.name.replace(/^(นาย|นางสาว|นาง|ดร\.|ม\.ล\.)\s*/u, '').split(' ');
          const id = await upsertProfile(
            prisma,
            {
              username,
              displayName: person.name,
              firstName: first,
              lastName: rest.join(' ') || '—',
              email,
              orgUnitId: unitOf(person.dept),
              position: person.position || null,
              keycloakRoles: [],
            },
            account.id,
            company.id,
          );
          await prisma.user.update({ where: { id }, data: { employeeId: code } });
          await grantSystemRole(prisma, id, company.id, 'employee');
        },
      });
    }

    for (const [username, email] of Object.entries(EMAIL_FIXES)) {
      const user = people.find((u) => u.username === username);
      if (!user || user.email === email) continue;
      const holder = await prisma.user.findFirst({ where: { email, NOT: { id: user.id } } });
      if (holder) {
        notes.push(`${username}: ${email} ถูก ${holder.username} ใช้อยู่ — ไม่เปลี่ยน`);
        continue;
      }
      if (!keycloak) {
        notes.push(`${username}: email ${user.email} → ${email} ข้าม — ต้องแก้ id24 ด้วย (login จะทับกลับ) รันด้วย SYNC_OSD_KEYCLOAK=1`);
        continue;
      }
      const realm = keycloak;
      const account = await findAccount(realm, username);
      if (!account) {
        notes.push(`${username}: ไม่มีบัญชีใน id24 — ไม่เปลี่ยน email`);
        continue;
      }
      actions.push({
        label: `EMAIL    ${username} ${user.email} → ${email} (DB + id24)`,
        run: async () => {
          if (account.email !== email) await updateAccountEmail(realm, account.id, email);
          await prisma.user.update({ where: { id: user.id }, data: { email } });
        },
      });
    }

    // ── receiver role (after units and types exist) ──────────────────────
    actions.push({
      label: 'ROLE     receiver → everyone under a receiving unit (listed below)',
      run: async () => {
        // A ref is a department code or, for a type that already names its team, a unit id.
        const covered = await prisma.orgClosure.findMany({
          where: { ancestorId: { in: [...effectiveReceivers].map((ref) => unitOf(ref) ?? ref) } },
          select: { descendantId: true },
        });
        const coveredIds = new Set(covered.map((c) => c.descendantId));
        const members = await prisma.user.findMany({
          where: {
            companies: { some: { companyId: company.id } },
            orgUnitId: { in: [...coveredIds] },
            NOT: { roles: { some: { companyId: company.id, role: { code: 'receiver' } } } },
          },
        });
        for (const member of members) {
          await grantSystemRole(prisma, member.id, company.id, 'receiver');
          console.log(`         receiver + ${member.username}`);
        }
      },
    });
    const preview = await prisma.orgClosure.findMany({
      where: { ancestorId: { in: [...effectiveReceivers].map((ref) => unitOf(ref) ?? ref) } },
      select: { descendantId: true },
    });
    const previewIds = new Set(preview.map((p) => p.descendantId));
    const wouldGrant = people.filter(
      (u) => u.orgUnitId && previewIds.has(u.orgUnitId) && !u.roles.some((r) => r.role.code === 'receiver'),
    );

    // ── run ──────────────────────────────────────────────────────────────
    let failed = 0;
    for (const action of actions) {
      if (!apply) {
        console.log(action.label);
        continue;
      }
      try {
        await action.run();
        console.log(`OK  ${action.label}`);
      } catch (error) {
        failed += 1;
        console.log(`FAIL ${action.label}: ${describeError(error)}`);
      }
    }
    if (!apply) {
      console.log(`         receiver would go to ${wouldGrant.length}: ${wouldGrant.map((u) => u.username).join(', ')}`);
    }

    console.log('\nรายงาน');
    for (const note of notes) console.log(`  - ${note}`);
    console.log(`\nactions ${actions.length} / ${apply ? `failed ${failed}` : 'dry-run, nothing written'}`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
