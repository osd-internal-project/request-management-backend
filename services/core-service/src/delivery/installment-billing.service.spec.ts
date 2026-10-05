import type { Principal } from '@request-management/share';
import { InstallmentBillingService } from './installment-billing.service';

const actor = (userId: string) =>
  ({ userId, activeCompanyId: 'osd', permissions: [] }) as unknown as Principal;

function harness(invoice: Record<string, unknown> | null) {
  const prisma = {
    installmentInvoice: {
      findFirst: jest.fn(() => Promise.resolve(invoice)),
      update: jest.fn(() => Promise.resolve({})),
    },
  };
  const service = new InstallmentBillingService(
    {
      access: () =>
        Promise.resolve({
          project: {
            id: 'P',
            companyId: 'osd',
            status: 'active',
            managerUserId: 'pm',
          },
        }),
    } as never,
    prisma as never,
    {} as never,
    { on: jest.fn() } as never,
    { kickCancel: jest.fn(), kickCreate: jest.fn() } as never,
    { record: () => Promise.resolve() } as never,
  );
  return { service, prisma };
}

describe('CD-253 วางบิลรายงวด — สิทธิ์และการถอน', () => {
  it('เฉพาะผู้จัดการโครงการ', async () => {
    await expect(
      harness(null).service.cancel(actor('someone'), 'P', 1, 'x'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('การเงินออกใบแจ้งหนี้แล้ว = ถอนไม่ได้', async () => {
    await expect(
      harness({
        id: 'I',
        status: 'sent',
        erpInvoiceStatus: 'open',
        erpInvoiceNo: 'IN-1',
      }).service.cancel(actor('pm'), 'P', 1, 'x'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('ถอนต้องมีเหตุผล; ถอนแล้วสั่งลบร่างใน SAP', async () => {
    const { service, prisma } = harness({
      id: 'I',
      status: 'sent',
      erpInvoiceStatus: 'draft',
      erpDraftNo: 'DR-1',
      reference: 'INS-CT-1',
    });
    await expect(
      service.cancel(actor('pm'), 'P', 1, ' '),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    jest.spyOn(service, 'view').mockResolvedValue({} as never);
    await service.cancel(actor('pm'), 'P', 1, 'ลูกค้าขอเลื่อน');
    expect(prisma.installmentInvoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'cancelled',
          erpStatus: 'pending',
        }) as unknown,
      }),
    );
  });
});
