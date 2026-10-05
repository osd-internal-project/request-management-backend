import type { Principal } from '@request-management/share';
import { AcceptanceCertificatesService } from './acceptance-certificates.service';

const actor = {
  userId: 'u',
  activeCompanyId: 'osd',
  permissions: [],
} as unknown as Principal;

function harness(canEdit: boolean, cert: Record<string, unknown> | null) {
  const prisma = {
    acceptanceCertificate: {
      findFirst: () => Promise.resolve(cert),
      count: () => Promise.resolve(cert?.status === 'signed' ? 1 : 0),
    },
  };
  return new AcceptanceCertificatesService(
    {
      access: () =>
        Promise.resolve({
          project: {
            id: 'P',
            companyId: 'osd',
            projectNo: 'PRJ-1',
            status: 'active',
          },
          canEdit,
        }),
    } as never,
    { cancel: jest.fn(() => Promise.resolve()) } as never,
    { on: jest.fn() } as never,
    prisma as never,
    {} as never,
    { record: () => Promise.resolve() } as never,
  );
}

describe('CD-252 ใบรับรองการตรวจรับ', () => {
  it('จัดการได้เฉพาะทีม Delivery / ผู้จัดการโครงการ', async () => {
    await expect(
      harness(false, null).generate(actor, 'P', 'A'),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('ถอนได้เฉพาะที่ส่งลงนามอยู่ และต้องมีเหตุผล', async () => {
    await expect(
      harness(true, { id: 'C', status: 'draft' }).withdraw(
        actor,
        'P',
        'A',
        'x',
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      harness(true, { id: 'C', status: 'sent', envelopeId: 'E' }).withdraw(
        actor,
        'P',
        'A',
        ' ',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('ลงนามแล้ว = มีใบรับรองสถานะ signed (ทั้ง e-sign และกระดาษ)', async () => {
    expect(await harness(true, { status: 'signed' }).isSigned('A')).toBe(true);
    expect(await harness(true, { status: 'sent' }).isSigned('A')).toBe(false);
  });
});
