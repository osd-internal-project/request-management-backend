import { PrismaService } from '@request-management/share';
import { OrgClosureRepository } from './org-closure.repository';

interface ClosureRow {
  ancestorId: string;
  descendantId: string;
  depth: number;
}

/**
 * Captures what `rebuildForCompany` would write, so the closure maths can be
 * checked without a database.
 */
function fakePrisma() {
  const created: ClosureRow[] = [];

  return {
    created,
    client: {
      orgClosure: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn((args: { data: ClosureRow[] }) => {
          created.push(...args.data);
          return Promise.resolve({ count: args.data.length });
        }),
      },
    },
  };
}

describe('§6.2 OrgClosure', () => {
  /**
   *   ou_company
   *     └── ou_dept
   *           ├── ou_team
   *           │     └── ou_sub
   *           └── ou_pricing
   */
  const NODES = [
    { id: 'ou_company', parentId: null },
    { id: 'ou_dept', parentId: 'ou_company' },
    { id: 'ou_team', parentId: 'ou_dept' },
    { id: 'ou_sub', parentId: 'ou_team' },
    { id: 'ou_pricing', parentId: 'ou_dept' },
  ];

  async function rebuild() {
    const fake = fakePrisma();
    const repository = new OrgClosureRepository(
      fake.client as unknown as PrismaService,
    );

    await repository.rebuildForCompany(NODES, 'c_osd');
    return fake.created;
  }

  it('records every node as its own ancestor at depth 0', async () => {
    const rows = await rebuild();

    for (const node of NODES) {
      expect(rows).toContainEqual({
        ancestorId: node.id,
        descendantId: node.id,
        depth: 0,
      });
    }
  });

  it('records transitive ancestry, not just direct parents', async () => {
    const rows = await rebuild();

    // ou_sub is two levels under ou_dept and three under ou_company.
    expect(rows).toContainEqual({
      ancestorId: 'ou_dept',
      descendantId: 'ou_sub',
      depth: 2,
    });
    expect(rows).toContainEqual({
      ancestorId: 'ou_company',
      descendantId: 'ou_sub',
      depth: 3,
    });
  });

  it('gives a team lead their own subtree and nothing sideways', async () => {
    const rows = await rebuild();
    const underTeam = rows
      .filter((row) => row.ancestorId === 'ou_team')
      .map((row) => row.descendantId)
      .sort();

    expect(underTeam).toEqual(['ou_sub', 'ou_team']);
    expect(underTeam).not.toContain('ou_pricing');
  });

  it('gives the department its whole subtree', async () => {
    const rows = await rebuild();
    const underDept = rows
      .filter((row) => row.ancestorId === 'ou_dept')
      .map((row) => row.descendantId)
      .sort();

    expect(underDept).toEqual(['ou_dept', 'ou_pricing', 'ou_sub', 'ou_team']);
  });

  it('clears the company’s old rows before writing, so a rebuild is not additive', async () => {
    const fake = fakePrisma();
    const repository = new OrgClosureRepository(
      fake.client as unknown as PrismaService,
    );

    await repository.rebuildForCompany(NODES, 'c_osd');

    expect(fake.client.orgClosure.deleteMany).toHaveBeenCalledWith({
      where: { ancestor: { companyId: 'c_osd' } },
    });
  });

  it('terminates on a cyclic tree instead of looping forever', async () => {
    const fake = fakePrisma();
    const repository = new OrgClosureRepository(
      fake.client as unknown as PrismaService,
    );

    await repository.rebuildForCompany(
      [
        { id: 'a', parentId: 'b' },
        { id: 'b', parentId: 'a' },
      ],
      'c_osd',
    );

    expect(fake.created.length).toBeGreaterThan(0);
  });
});
