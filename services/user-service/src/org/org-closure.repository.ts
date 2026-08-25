import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import type { OrgClosure } from '@prisma/client';

/** One node of the org tree, as the closure builder needs it. */
export interface ClosureNode {
  id: string;
  parentId: string | null;
}

/**
 * Maintains the ancestor–descendant closure of the org tree.
 *
 * Scope resolution reads this table instead of walking `parentId` per query
 * (§6.2 note) — the difference between an `IN (…)` on an indexed column and a
 * recursive lookup on every list request, which is what NFR-02 is measuring.
 */
@Injectable()
export class OrgClosureRepository extends BaseRepository<
  PrismaService['orgClosure']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.orgClosure;
  }

  /** The unit itself plus everything beneath it — scope `team`. */
  async descendantIdsOf(
    ancestorId: string,
    option?: TxOption,
  ): Promise<string[]> {
    const rows = (await this.findMany(
      { where: { ancestorId }, select: { descendantId: true } },
      option,
    )) as Pick<OrgClosure, 'descendantId'>[];

    return rows.map((row) => row.descendantId);
  }

  /** Every unit above a given one, nearest first — used to find a department. */
  async ancestorsOf(
    descendantId: string,
    option?: TxOption,
  ): Promise<{ ancestorId: string; depth: number }[]> {
    const rows = (await this.findMany(
      {
        where: { descendantId },
        select: { ancestorId: true, depth: true },
        orderBy: { depth: 'asc' },
      },
      option,
    )) as Pick<OrgClosure, 'ancestorId' | 'depth'>[];

    return rows.map((row) => ({
      ancestorId: row.ancestorId,
      depth: row.depth,
    }));
  }

  /**
   * Rebuilds the closure for one company from its `parentId` edges.
   *
   * Deliberately a full rebuild rather than an incremental patch: org edits
   * are rare and admin-driven, while an incremental update has to handle
   * re-parenting subtrees correctly — the kind of code that is wrong for
   * months before anyone notices a manager seeing the wrong team. Runs inside
   * the caller's transaction, so readers never observe a half-built tree.
   */
  async rebuildForCompany(
    nodes: readonly ClosureNode[],
    companyId: string,
    option?: TxOption,
  ): Promise<void> {
    const client = option?.prisma ?? this.prisma;

    await client.orgClosure.deleteMany({
      where: { ancestor: { companyId } },
    });

    const parentOf = new Map(nodes.map((node) => [node.id, node.parentId]));
    const rows: { ancestorId: string; descendantId: string; depth: number }[] =
      [];

    for (const node of nodes) {
      let depth = 0;
      let current: string | null = node.id;
      const seen = new Set<string>();

      while (current) {
        if (seen.has(current)) break; // cycle guard; createUnit rejects these
        seen.add(current);

        rows.push({ ancestorId: current, descendantId: node.id, depth });
        current = parentOf.get(current) ?? null;
        depth += 1;
      }
    }

    if (rows.length) {
      await client.orgClosure.createMany({ data: rows });
    }
  }
}
