/**
 * Flatten the POSITION level out of the org chart and lift everyone who was
 * sitting in one up to the department that holds it.
 *
 *   ORG_FLATTEN_ALLOW=1 yarn org:flatten-positions            # dry run
 *   ORG_FLATTEN_ALLOW=1 yarn org:flatten-positions --apply    # write
 *   ORG_FLATTEN_ALLOW=1 yarn org:flatten-positions OSD --apply
 *
 * **One-off, written 10 Sep 2026.** `import-osd-catalog.ts` built OSD's chart
 * as บริษัท → ฝ่าย → แผนก → ตำแหน่ง, giving every job title its own box. Most of
 * those boxes are empty — 88 of OSD's 134 and all 17 of LEXTECH's — and the
 * ones that are not add nothing the register does not already say, because
 * `users.position` carries the same title as text.
 *
 * The chart is moving to five adjacent levels, บริษัท → ฝ่าย → แผนก → ทีม →
 * ตำแหน่ง, where ทีม and ตำแหน่ง are optional and a person sits at แผนก or
 * below. This clears the ground for that: it removes the imported ตำแหน่ง boxes
 * and puts their members on the department, then lifts the handful of accounts
 * that were sitting on a company unit — which the new rule forbids — down onto
 * a department.
 *
 * Nothing is written without `--apply`. A job title is never lost: where a
 * member has no `position` text of their own, the box's name is copied onto
 * them before the box goes.
 *
 * Delete this file once every environment has been flattened.
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Accounts that must not be left on a company unit, and the department code
 * each one moves to. Read as "username in company → department code".
 *
 * Placed by hand rather than by rule: there is no fact in the database that
 * says where a CEO or an auditor belongs, and an approximate placement is
 * invisible while it feeds data scope and the approval chain a wrong answer.
 */
const COMPANY_LEVEL_PLACEMENTS: readonly {
  company: string;
  username: string;
  department: string;
}[] = [
  { company: 'OSD', username: 'uat.admin', department: 'OSD-OU0009' },
  { company: 'OSD', username: 'uat.orasak', department: 'OSD-OU0009' },
  { company: 'OSD_DEMO', username: 'uat.ceo', department: 'EXEC' },
  { company: 'OSD_DEMO', username: 'uatadmin', department: 'EXEC' },
  { company: 'OSD_DEMO', username: 'uat.auditor', department: 'FIN' },
  { company: 'OSD_DEMO', username: 'wichai.p', department: 'SALES' },
];

/**
 * A department created on demand for accounts placed above one. OSD_DEMO has
 * only ฝ่ายขาย and ฝ่ายการเงิน, and neither is where a CEO belongs.
 */
const CREATED_DEPARTMENTS: readonly {
  company: string;
  code: string;
  name: string;
}[] = [{ company: 'OSD_DEMO', code: 'EXEC', name: 'แผนกผู้บริหาร' }];

interface Unit {
  id: string;
  code: string;
  name: string;
  kind: string;
  parentId: string | null;
}

interface Report {
  company: string;
  unitsDeleted: number;
  usersMoved: number;
  titlesBackfilled: number;
  requestsRepointed: number;
  scopesRepointed: number;
  scopesMerged: number;
  membersLiftedFromCompany: number;
  departmentsCreated: string[];
}

function assertAllowed(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run in production. This deletes org units.');
  }

  if (process.env.ORG_FLATTEN_ALLOW !== '1') {
    throw new Error(
      'Refusing to run without ORG_FLATTEN_ALLOW=1.\n' +
        '  ORG_FLATTEN_ALLOW=1 yarn org:flatten-positions [COMPANY_CODE...] [--apply]',
    );
  }
}

/**
 * Rebuild one company's closure by walking each unit's parents.
 *
 * `scopeSetsFor` reads this table on every request, so it has to move in the
 * same transaction as the chart — a stale closure silently changes who sees
 * what rather than failing.
 */
async function rebuildClosure(
  tx: Prisma.TransactionClient,
  companyId: string,
): Promise<void> {
  const nodes = await tx.orgUnit.findMany({
    where: { companyId },
    select: { id: true, parentId: true },
  });

  await tx.orgClosure.deleteMany({ where: { ancestor: { companyId } } });

  const parents = new Map(nodes.map((node) => [node.id, node.parentId]));
  const rows: Prisma.OrgClosureCreateManyInput[] = [];

  for (const node of nodes) {
    let ancestor: string | null = node.id;
    let depth = 0;

    while (ancestor && depth <= 20) {
      rows.push({ ancestorId: ancestor, descendantId: node.id, depth });
      ancestor = parents.get(ancestor) ?? null;
      depth += 1;
    }
  }

  await tx.orgClosure.createMany({ data: rows, skipDuplicates: true });
}

interface ScopeRow {
  id: string;
  viewerOrgUnitId: string | null;
  viewerUserId: string | null;
  targetOrgUnitId: string | null;
  targetUserId: string | null;
  includeDescendants: boolean;
  permissions: string[];
  canAct: boolean;
}

/** The four partial unique indexes key a grant on this pair, so we do too. */
function pairKey(row: {
  viewerOrgUnitId: string | null;
  viewerUserId: string | null;
  targetOrgUnitId: string | null;
  targetUserId: string | null;
}): string {
  const viewer = row.viewerOrgUnitId ?? row.viewerUserId ?? '';
  const target = row.targetOrgUnitId ?? row.targetUserId ?? '';
  return `${viewer}→${target}`;
}

type ScopeAction =
  | { kind: 'repoint'; id: string; viewerOrgUnitId?: string; targetOrgUnitId?: string }
  | { kind: 'merge'; id: string; into: string; permissions: string[]; includeDescendants: boolean; canAct: boolean }
  | { kind: 'drop'; id: string; why: string };

/**
 * Point every grant that names a ตำแหน่ง at the department above it.
 *
 * Widening is the point and the cost: a grant that reached the five people in
 * "Software Developer" reaches the whole of RND afterwards. What is not
 * acceptable is losing the grant — the foreign key is ON DELETE CASCADE, so
 * doing nothing would delete it with the unit and nobody would see it go.
 *
 * Two collisions have to be handled rather than left to the unique indexes:
 * a repointed grant that now duplicates an existing one (merge the two), and
 * one whose viewer and target have become the same unit (meaningless, drop).
 */
function planScopes(
  rows: readonly ScopeRow[],
  parentOf: ReadonlyMap<string, string>,
): ScopeAction[] {
  const actions: ScopeAction[] = [];
  const byPair = new Map<string, ScopeRow>();
  const touched = new Set<string>();

  for (const row of rows) {
    const viewerMoves = row.viewerOrgUnitId && parentOf.has(row.viewerOrgUnitId);
    const targetMoves = row.targetOrgUnitId && parentOf.has(row.targetOrgUnitId);

    if (!viewerMoves && !targetMoves) {
      byPair.set(pairKey(row), row);
      continue;
    }
    touched.add(row.id);
  }

  for (const row of rows) {
    if (!touched.has(row.id)) continue;

    const viewerOrgUnitId = row.viewerOrgUnitId
      ? (parentOf.get(row.viewerOrgUnitId) ?? row.viewerOrgUnitId)
      : null;
    const targetOrgUnitId = row.targetOrgUnitId
      ? (parentOf.get(row.targetOrgUnitId) ?? row.targetOrgUnitId)
      : null;

    if (viewerOrgUnitId && viewerOrgUnitId === targetOrgUnitId) {
      actions.push({
        kind: 'drop',
        id: row.id,
        why: 'ผู้ดูกับเป้าหมายกลายเป็นหน่วยเดียวกัน',
      });
      continue;
    }

    const moved = { ...row, viewerOrgUnitId, targetOrgUnitId };
    const existing = byPair.get(pairKey(moved));

    if (existing) {
      actions.push({
        kind: 'merge',
        id: row.id,
        into: existing.id,
        permissions: [...new Set([...existing.permissions, ...row.permissions])],
        includeDescendants: existing.includeDescendants || row.includeDescendants,
        canAct: existing.canAct || row.canAct,
      });
      continue;
    }

    byPair.set(pairKey(moved), moved);
    actions.push({
      kind: 'repoint',
      id: row.id,
      ...(viewerOrgUnitId && viewerOrgUnitId !== row.viewerOrgUnitId
        ? { viewerOrgUnitId }
        : {}),
      ...(targetOrgUnitId && targetOrgUnitId !== row.targetOrgUnitId
        ? { targetOrgUnitId }
        : {}),
    });
  }

  return actions;
}

interface Plan {
  companyId: string;
  companyCode: string;
  positions: Unit[];
  /** ตำแหน่ง id → the department it hangs under. */
  parentOf: Map<string, string>;
  moves: { userId: string; username: string; from: string; to: string }[];
  backfills: { userId: string; username: string; title: string }[];
  requestIds: Map<string, string[]>;
  scopeActions: ScopeAction[];
  lifts: { userId: string; username: string; from: string; to: string; toCode: string }[];
  departmentsToCreate: { code: string; name: string; parentId: string }[];
}

/**
 * A ตำแหน่ง is only ever a leaf under a แผนก. Anything else means the chart is
 * not the one this script was written for, and guessing where its people
 * belong is exactly the mistake `adopt-org-chart.ts` was written to undo.
 */
function assertFlattenable(positions: readonly Unit[], byId: ReadonlyMap<string, Unit>): void {
  const bad = positions.filter((unit) => {
    const parent = unit.parentId ? byId.get(unit.parentId) : undefined;
    return parent?.kind !== 'DEPARTMENT';
  });

  if (bad.length) {
    throw new Error(
      `ตำแหน่ง ${bad.length} หน่วยไม่ได้แขวนใต้แผนก จึงไม่รู้ว่าคนในนั้นควรไปอยู่ที่ใด: ` +
        bad.map((unit) => unit.code).join(', '),
    );
  }
}

async function planFor(companyCode: string): Promise<Plan> {
  const company = await prisma.company.findUnique({ where: { code: companyCode } });
  if (!company) throw new Error(`No company with code "${companyCode}".`);

  const units = await prisma.orgUnit.findMany({
    where: { companyId: company.id },
    select: { id: true, code: true, name: true, kind: true, parentId: true },
  });
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const byCode = new Map(units.map((unit) => [unit.code, unit]));

  const positions = units.filter((unit) => unit.kind === 'POSITION');
  assertFlattenable(positions, byId);

  const parentOf = new Map(
    positions.map((unit) => [unit.id, unit.parentId as string]),
  );

  const members = await prisma.user.findMany({
    where: { orgUnitId: { in: [...parentOf.keys()] } },
    select: { id: true, username: true, position: true, orgUnitId: true },
  });

  const moves = members.map((member) => ({
    userId: member.id,
    username: member.username,
    from: member.orgUnitId as string,
    to: parentOf.get(member.orgUnitId as string) as string,
  }));

  // The register's job title is the fact; the box's name is only a copy of it.
  // Only a member with no title of their own inherits the box's name, so the
  // 24 people whose title and box disagree keep what HR recorded.
  const backfills = members
    .filter((member) => !member.position?.trim())
    .map((member) => ({
      userId: member.id,
      username: member.username,
      title: (byId.get(member.orgUnitId as string) as Unit).name,
    }));

  // `requests.requesterOrgUnitId` carries no foreign key, so a deleted unit
  // leaves an id that resolves to nothing rather than a null the screens can
  // read. Repointed to the department, the row still says where it was raised.
  const requests = await prisma.request.findMany({
    where: { requesterOrgUnitId: { in: [...parentOf.keys()] } },
    select: { id: true, requesterOrgUnitId: true },
  });

  const requestIds = new Map<string, string[]>();
  for (const request of requests) {
    const to = parentOf.get(request.requesterOrgUnitId as string) as string;
    requestIds.set(to, [...(requestIds.get(to) ?? []), request.id]);
  }

  const scopeRows = await prisma.orgUnitScope.findMany({
    where: { companyId: company.id },
    select: {
      id: true,
      viewerOrgUnitId: true,
      viewerUserId: true,
      targetOrgUnitId: true,
      targetUserId: true,
      includeDescendants: true,
      permissions: true,
      canAct: true,
    },
  });

  const departmentsToCreate = CREATED_DEPARTMENTS.filter(
    (row) => row.company === companyCode && !byCode.has(row.code),
  ).map((row) => ({
    code: row.code,
    name: row.name,
    parentId: (units.find((unit) => unit.kind === 'COMPANY') as Unit).id,
  }));

  return {
    companyId: company.id,
    companyCode,
    positions,
    parentOf,
    moves,
    backfills,
    requestIds,
    scopeActions: planScopes(scopeRows, parentOf),
    lifts: await planLifts(company.id, companyCode, units, byCode, departmentsToCreate),
    departmentsToCreate,
  };
}

/**
 * A person on a บริษัท or ฝ่าย unit, and the แผนก they move to.
 *
 * The five-level chart puts people at แผนก or below, and these accounts predate
 * that rule. Refused rather than guessed when an account is not named in
 * `COMPANY_LEVEL_PLACEMENTS`: a wrong placement is invisible.
 */
async function planLifts(
  companyId: string,
  companyCode: string,
  units: readonly Unit[],
  byCode: ReadonlyMap<string, Unit>,
  creating: readonly { code: string }[],
): Promise<Plan['lifts']> {
  const above = units.filter(
    (unit) => unit.kind === 'COMPANY' || unit.kind === 'DIVISION',
  );

  const sitting = await prisma.user.findMany({
    where: { orgUnitId: { in: above.map((unit) => unit.id) } },
    select: { id: true, username: true, orgUnitId: true },
  });

  return sitting.map((user) => {
    const placement = COMPANY_LEVEL_PLACEMENTS.find(
      (row) => row.company === companyCode && row.username === user.username,
    );

    if (!placement) {
      throw new Error(
        `${user.username} นั่งอยู่ชั้นบริษัท/ฝ่ายใน ${companyCode} แต่ไม่มีในตาราง ` +
          'COMPANY_LEVEL_PLACEMENTS — เติมแผนกปลายทางก่อนแล้วรันใหม่',
      );
    }

    const target = byCode.get(placement.department);
    if (!target && !creating.some((row) => row.code === placement.department)) {
      throw new Error(
        `${companyCode} ไม่มีแผนกรหัส "${placement.department}" สำหรับ ${user.username}`,
      );
    }
    if (target && target.kind !== 'DEPARTMENT') {
      throw new Error(
        `"${placement.department}" ใน ${companyCode} ไม่ใช่แผนก (เป็น ${target.kind})`,
      );
    }

    return {
      userId: user.id,
      username: user.username,
      from: user.orgUnitId as string,
      to: target?.id ?? '',
      toCode: placement.department,
    };
  });
}

function hasWork(plan: Plan): boolean {
  return Boolean(
    plan.positions.length ||
      plan.lifts.length ||
      plan.scopeActions.length ||
      plan.departmentsToCreate.length,
  );
}

async function apply(plan: Plan): Promise<Report> {
  return prisma.$transaction(
    async (tx) => {
      const created: string[] = [];
      const codeToId = new Map<string, string>();

      for (const department of plan.departmentsToCreate) {
        const unit = await tx.orgUnit.create({
          data: {
            companyId: plan.companyId,
            code: department.code,
            name: department.name,
            kind: 'DEPARTMENT',
            parentId: department.parentId,
            createdBy: 'org:flatten-positions (cli)',
            updatedBy: 'org:flatten-positions (cli)',
          },
        });
        created.push(department.code);
        codeToId.set(department.code, unit.id);
      }

      for (const backfill of plan.backfills) {
        await tx.user.update({
          where: { id: backfill.userId },
          data: { position: backfill.title },
        });
      }

      for (const move of plan.moves) {
        await tx.user.update({
          where: { id: move.userId },
          data: { orgUnitId: move.to },
        });
      }

      for (const lift of plan.lifts) {
        await tx.user.update({
          where: { id: lift.userId },
          data: { orgUnitId: lift.to || (codeToId.get(lift.toCode) as string) },
        });
      }

      for (const [to, ids] of plan.requestIds) {
        await tx.request.updateMany({
          where: { id: { in: ids } },
          data: { requesterOrgUnitId: to },
        });
      }

      for (const action of plan.scopeActions) {
        if (action.kind === 'repoint') {
          await tx.orgUnitScope.update({
            where: { id: action.id },
            data: {
              ...(action.viewerOrgUnitId
                ? { viewerOrgUnitId: action.viewerOrgUnitId }
                : {}),
              ...(action.targetOrgUnitId
                ? { targetOrgUnitId: action.targetOrgUnitId }
                : {}),
              updatedBy: 'org:flatten-positions (cli)',
            },
          });
          continue;
        }

        if (action.kind === 'merge') {
          await tx.orgUnitScope.update({
            where: { id: action.into },
            data: {
              permissions: action.permissions,
              includeDescendants: action.includeDescendants,
              canAct: action.canAct,
              updatedBy: 'org:flatten-positions (cli)',
            },
          });
        }

        await tx.orgUnitScope.delete({ where: { id: action.id } });
      }

      const positionIds = plan.positions.map((unit) => unit.id);

      // Parents cleared first so the self-referencing foreign key cannot block
      // a delete that removes a child before its parent.
      await tx.orgUnit.updateMany({
        where: { id: { in: positionIds } },
        data: { managerUserId: null, parentId: null },
      });
      await tx.orgUnit.deleteMany({ where: { id: { in: positionIds } } });

      await rebuildClosure(tx, plan.companyId);

      const report: Report = {
        company: plan.companyCode,
        unitsDeleted: positionIds.length,
        usersMoved: plan.moves.length,
        titlesBackfilled: plan.backfills.length,
        requestsRepointed: [...plan.requestIds.values()].flat().length,
        scopesRepointed: plan.scopeActions.filter((a) => a.kind === 'repoint').length,
        scopesMerged: plan.scopeActions.filter((a) => a.kind !== 'repoint').length,
        membersLiftedFromCompany: plan.lifts.length,
        departmentsCreated: created,
      };

      await tx.auditLog.create({
        data: {
          eventType: 'org.positions.flattened',
          companyId: plan.companyId,
          actorUsername: 'org:flatten-positions (cli)',
          resourceType: 'company',
          resourceId: plan.companyId,
          after: { ...report } as Prisma.InputJsonValue,
        },
      });

      return report;
    },
    { timeout: 120_000 },
  );
}

function describe(plan: Plan): void {
  const empty = plan.positions.length - new Set(plan.moves.map((m) => m.from)).size;

  console.log(`\n  บริษัท ${plan.companyCode}`);
  console.log(`    ตำแหน่งที่จะลบ            ${plan.positions.length} (ว่างเปล่า ${empty})`);
  console.log(`    ผู้ใช้ที่ย้ายขึ้นแผนก        ${plan.moves.length}`);
  console.log(`    เติมชื่อตำแหน่งให้           ${plan.backfills.length}`);
  console.log(`    ประวัติคำขอที่ชี้ใหม่        ${[...plan.requestIds.values()].flat().length}`);
  console.log(`    สิทธิ์ที่ชี้ใหม่ / รวมเข้าแถวเดิม ${plan.scopeActions.filter((a) => a.kind === 'repoint').length} / ${plan.scopeActions.filter((a) => a.kind !== 'repoint').length}`);
  console.log(`    ผู้ใช้ที่ย้ายลงจากชั้นบริษัท   ${plan.lifts.length}`);

  if (plan.departmentsToCreate.length) {
    console.log(
      `    แผนกที่สร้างใหม่          ` +
        plan.departmentsToCreate.map((d) => `${d.code} (${d.name})`).join(', '),
    );
  }
  for (const lift of plan.lifts) {
    console.log(`      ${lift.username} → ${lift.toCode}`);
  }
  for (const backfill of plan.backfills) {
    console.log(`      เติมตำแหน่ง ${backfill.username} → "${backfill.title}"`);
  }
}

async function main(argv: readonly string[]): Promise<void> {
  assertAllowed();

  const wanted = argv.filter((arg) => !arg.startsWith('--'));
  const write = argv.includes('--apply');

  const codes = wanted.length
    ? wanted
    : (
        await prisma.company.findMany({
          select: { code: true },
          orderBy: { code: 'asc' },
        })
      ).map((company) => company.code);

  const all = [];
  for (const code of codes) all.push(await planFor(code));

  // A company named on the command line is always reported, so that asking
  // about one and being told nothing is left is a real answer rather than
  // silence. Ones found by the sweep are only listed when they change.
  const plans = wanted.length ? all : all.filter(hasWork);

  if (!plans.length) {
    console.log('ทุกบริษัทเข้ารูปแล้ว — ไม่มีอะไรต้องทำ');
    return;
  }

  console.log(write ? '\nยุบชั้นตำแหน่ง' : '\nตรวจการยุบชั้นตำแหน่ง (dry run)');

  for (const plan of plans) describe(plan);

  if (!write) {
    console.log('\n  ยังไม่เขียนอะไรลงฐาน — เติม --apply เมื่อตัวเลขข้างบนถูกต้อง');
    return;
  }

  for (const plan of plans) await apply(plan);
  console.log('\n  เขียนลงฐานแล้ว');
}

main(process.argv.slice(2))
  .then(() => console.log('Done.'))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
