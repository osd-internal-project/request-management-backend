import { HrReportingRepository } from './hr.repositories';

describe('CD-230 สายบังคับบัญชา', () => {
  it('ลูกทีมทุกชั้นใต้หัวหน้า และตัดวงวนในผังที่ผิด', async () => {
    // boss → a, b · a → c · c → boss (a mistaken loop)
    const reportsTo: Record<string, string> = {
      a: 'boss',
      b: 'boss',
      c: 'a',
      boss: 'c',
    };
    const prisma = {
      user: {
        findMany: jest.fn(
          ({ where }: { where: { supervisorUserId: { in: string[] } } }) =>
            Promise.resolve(
              Object.entries(reportsTo)
                .filter(([, head]) => where.supervisorUserId.in.includes(head))
                .map(([id]) => ({ id })),
            ),
        ),
      },
    };
    const repo = new HrReportingRepository(prisma as never);
    expect((await repo.subordinatesOf('boss')).sort()).toEqual(['a', 'b', 'c']);
    expect(await repo.subordinatesOf('b')).toEqual([]);
  });
});
