/**
 * Adopt one org chart as a company's real one and retire the other.
 *
 *   ORG_ADOPT_ALLOW=1 yarn org:adopt OSD OSD-OU0001            # dry run
 *   ORG_ADOPT_ALLOW=1 yarn org:adopt OSD OSD-OU0001 --apply    # write
 *
 * **One-off, written 31 Aug 2026.** OSD ended up with two complete charts under
 * two roots: one built by hand, and one re-created by `data:import-catalog`
 * when it was run against a database that was no longer empty. The importer
 * also moved every person onto its own chart, so the hand-built one was left
 * structurally intact but empty.
 *
 * Rather than deleting rows by hand, this reconciles the two:
 *
 *   1. every person on the retiring chart is matched back onto the surviving
 *      one by (department, job title) — the two charts name the same boxes,
 *      one using the register's department codes and one its Thai names
 *   2. the surviving chart's leaf units become `POSITION`, which is what they
 *      always were; `TEAM` was the only kind available when they were created
 *   3. request types pointing at a retiring unit are re-pointed at the unit of
 *      the same name on the surviving chart, at whatever level it sits
 *   4. the retiring chart is deleted
 *
 * Nothing is written without `--apply`. A person whose title has no box on the
 * surviving chart goes back to the "รอจัดสังกัด" queue rather than to an
 * approximate one: an admin can see that queue and place them, whereas a wrong
 * placement is invisible and feeds the approval chain a wrong answer.
 *
 * Delete this file once the situation it describes is resolved.
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

interface Unit {
  id: string;
  code: string;
  name: string;
  kind: string;
  parentId: string | null;
}

function assertAllowed(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run in production. This deletes an org chart.');
  }

  if (process.env.ORG_ADOPT_ALLOW !== '1') {
    throw new Error(
      'Refusing to run without ORG_ADOPT_ALLOW=1.\n' +
        '  ORG_ADOPT_ALLOW=1 yarn org:adopt <COMPANY_CODE> <KEEP_ROOT_CODE> [--apply]',
    );
  }
}

/** Every unit under `rootId`, root included, read through the closure table. */
async function subtree(rootId: string): Promise<Unit[]> {
  const ids = (
    await prisma.orgClosure.findMany({
      where: { ancestorId: rootId },
      select: { descendantId: true },
    })
  ).map((row) => row.descendantId);

  return prisma.orgUnit.findMany({
    where: { id: { in: ids } },
    select: { id: true, code: true, name: true, kind: true, parentId: true },
  });
}

/**
 * The two charts describe the same organisation with different labels: one
 * names a department by the register's code (`LCD`), the other by its Thai
 * name and keeps the code in `code`. The code is the fact both agree on.
 */
function departmentKey(value: string): string {
  return value.trim().toUpperCase();
}

async function main(argv: readonly string[]): Promise<void> {
  assertAllowed();

  const [companyCode, keepRootCode] = argv.filter((arg) => !arg.startsWith('--'));
  const apply = argv.includes('--apply');

  if (!companyCode || !keepRootCode) {
    throw new Error(
      'Company code and the code of the root to keep are both required.\n' +
        '  ORG_ADOPT_ALLOW=1 yarn org:adopt OSD OSD-OU0001',
    );
  }

  const company = await prisma.company.findUnique({
    where: { code: companyCode },
  });
  if (!company) throw new Error(`No company with code "${companyCode}".`);

  const roots = await prisma.orgUnit.findMany({
    where: { companyId: company.id, parentId: null },
    select: { id: true, code: true, name: true, kind: true, parentId: true },
  });

  const keep = roots.find((root) => root.code === keepRootCode);
  if (!keep) {
    throw new Error(
      `No root unit "${keepRootCode}" in ${companyCode}. Roots are: ` +
        roots.map((root) => root.code).join(', '),
    );
  }

  const retiring = roots.filter((root) => root.id !== keep.id);
  if (!retiring.length) {
    console.log(`${companyCode} already has one chart. Nothing to do.`);
    return;
  }

  const keepUnits = await subtree(keep.id);
  const keepById = new Map(keepUnits.map((unit) => [unit.id, unit]));

  /*
    Where a person should end up, keyed by department plus job title. This
    chart labels a department with the register's code, so its `name` is what
    the other chart carries in `code`.
  */
  const target = new Map<string, Unit>();
  for (const unit of keepUnits) {
    if (unit.kind !== 'TEAM' && unit.kind !== 'POSITION') continue;

    const parent = unit.parentId ? keepById.get(unit.parentId) : undefined;
    if (!parent) continue;

    target.set(`${departmentKey(parent.name)} ${unit.name.trim()}`, unit);
  }

  /*
    Where a request type's receiving unit lands, by name across every level.

    A department on the retiring chart is sometimes a division on the surviving
    one — `INF` is exactly that — and a type addressed to "INF" means the same
    part of the business either way. Departments win a name clash because that
    is the level types are normally addressed to.
  */
  const keepByName = new Map<string, Unit>();
  for (const unit of keepUnits) {
    if (unit.kind === 'TEAM' || unit.kind === 'POSITION') continue;

    const key = departmentKey(unit.name);
    if (!keepByName.has(key) || unit.kind === 'DEPARTMENT') {
      keepByName.set(key, unit);
    }
  }

  const moves: { userId: string; username: string; to: Unit }[] = [];
  const unassign: { userId: string; username: string; label: string }[] = [];
  const typeMoves: { code: string; to: Unit }[] = [];
  const typesOrphaned: string[] = [];
  let retiringUnitCount = 0;

  for (const root of retiring) {
    const units = await subtree(root.id);
    const byId = new Map(units.map((unit) => [unit.id, unit]));
    retiringUnitCount += units.length;

    const members = await prisma.user.findMany({
      where: { orgUnitId: { in: units.map((unit) => unit.id) } },
      select: { id: true, username: true, position: true, orgUnitId: true },
    });

    for (const member of members) {
      const current = byId.get(member.orgUnitId as string) as Unit;
      const parent = current.parentId ? byId.get(current.parentId) : undefined;

      const department = parent ? departmentKey(parent.code) : '';
      const title = (member.position ?? current.name).trim();
      const found = target.get(`${department} ${title}`);

      /*
        A title the surviving chart has no box for. The person goes back to the
        "รอจัดสังกัด" queue rather than to an approximate box: an admin can see
        the queue and place them, whereas a wrong placement is invisible and
        feeds data scope and the approval chain a wrong answer.
      */
      if (!found) {
        unassign.push({
          userId: member.id,
          username: member.username,
          label: `${member.username} (${department || '-'} / ${title})`,
        });
        continue;
      }

      moves.push({ userId: member.id, username: member.username, to: found });
    }

    const types = await prisma.requestType.findMany({
      where: { receiverOrgUnitId: { in: units.map((unit) => unit.id) } },
      select: { code: true, receiverOrgUnitId: true },
    });

    for (const type of types) {
      const from = byId.get(type.receiverOrgUnitId as string) as Unit;
      const found = keepByName.get(departmentKey(from.code));

      if (found) typeMoves.push({ code: type.code, to: found });
      else typesOrphaned.push(`${type.code} (${from.code})`);
    }
  }

  console.log(`\n${apply ? 'ปรับผัง' : 'ตรวจผัง (dry run)'} ของบริษัท ${companyCode}`);
  console.log(`  ผังที่เก็บไว้             ${keep.code} · ${keepUnits.length} หน่วยงาน`);
  console.log(
    `  ผังที่จะลบ                ${retiring.map((root) => root.code).join(', ')} · ${retiringUnitCount} หน่วยงาน`,
  );
  console.log(`  ผู้ใช้ที่ย้ายกลับได้        ${moves.length}`);
  console.log(`  ผู้ใช้ที่กลับไปรอจัดสังกัด    ${unassign.length}`);
  console.log(`  ประเภทคำขอที่ย้ายทีมผู้รับ   ${typeMoves.length}`);
  console.log(`  ประเภทคำขอที่ทีมผู้รับเป็นว่าง ${typesOrphaned.length}`);

  if (unassign.length) {
    console.log(
      `\n  รอจัดสังกัด (ผังนี้ไม่มีตำแหน่งนั้น): ${unassign.map((u) => u.label).join(' · ')}`,
    );
  }
  if (typesOrphaned.length) {
    console.log(`\n  ทีมผู้รับเป็นว่าง — ตั้งใหม่ที่หน้า A2: ${typesOrphaned.join(' · ')}`);
  }

  if (!apply) {
    console.log('\n  ยังไม่เขียนอะไรลงฐาน — เติม --apply เมื่อตัวเลขข้างบนถูกต้อง');
    return;
  }

  const retiringIds: string[] = [];
  for (const root of retiring) {
    for (const unit of await subtree(root.id)) retiringIds.push(unit.id);
  }

  await prisma.$transaction(
    async (tx) => {
      for (const move of moves) {
        await tx.user.update({
          where: { id: move.userId },
          data: { orgUnitId: move.to.id },
        });
      }

      // The foreign key is ON DELETE SET NULL, so a type left pointing at a
      // retiring unit would end up null anyway — done explicitly so the report
      // above and the database agree.
      await tx.user.updateMany({
        where: { id: { in: unassign.map((entry) => entry.userId) } },
        data: { orgUnitId: null, supervisorUserId: null },
      });

      for (const move of typeMoves) {
        await tx.requestType.updateMany({
          where: { code: move.code },
          data: { receiverOrgUnitId: move.to.id },
        });
      }

      // What they always were. `TEAM` was the only kind available when this
      // chart was built; `POSITION` exists now and says what the level means.
      await tx.orgUnit.updateMany({
        where: {
          id: {
            in: keepUnits.filter((unit) => unit.kind === 'TEAM').map((u) => u.id),
          },
        },
        data: { kind: 'POSITION' },
      });

      // Parents cleared first so the self-referencing foreign key cannot block
      // a delete that removes a child before its parent.
      await tx.orgUnit.updateMany({
        where: { id: { in: retiringIds } },
        data: { managerUserId: null, parentId: null },
      });
      await tx.orgUnit.deleteMany({ where: { id: { in: retiringIds } } });

      /*
        The closure lost the retired rows by cascade, and clearing `parentId`
        above invalidated the rest. Rebuild the whole company's closure, the
        same way `OrgService` does after an edit — `team`/`department` answers
        read this table, so a stale one silently changes who sees what.
      */
      const nodes = await tx.orgUnit.findMany({
        where: { companyId: company.id },
        select: { id: true, parentId: true },
      });

      await tx.orgClosure.deleteMany({
        where: { ancestor: { companyId: company.id } },
      });

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

      await tx.auditLog.create({
        data: {
          eventType: 'org.chart.adopted',
          companyId: company.id,
          actorUsername: 'org:adopt (cli)',
          resourceType: 'company',
          resourceId: company.id,
          after: {
            kept: keep.code,
            retired: retiring.map((root) => root.code),
            unitsDeleted: retiringIds.length,
            usersMoved: moves.length,
            usersUnassigned: unassign.length,
            requestTypesRepointed: typeMoves.length,
          } as Prisma.InputJsonValue,
        },
      });
    },
    { timeout: 120_000 },
  );

  console.log('\n  เขียนลงฐานแล้ว');
}

main(process.argv.slice(2))
  .then(() => console.log('Done.'))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
