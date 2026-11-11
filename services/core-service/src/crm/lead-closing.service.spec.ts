import type { Principal } from '@request-management/share';
import { LeadClosingService } from './lead-closing.service';

/**
 * User decision, 11 Nov 2026: a Lead is `won` when the customer commits
 * (quotation accepted — a confirmation or PO — or a sale order opened), not
 * when it is converted into a deal.
 */
function principal(): Principal {
  return {
    userId: 'me',
    activeCompanyId: 'osd',
    isServiceAccount: false,
    displayName: 'Me',
  } as unknown as Principal;
}

function harness(
  options: {
    lead?: { status: string } | null;
    failOn?: 'update';
  } = {},
) {
  const lead =
    options.lead === null
      ? null
      : {
          id: 'lead-1',
          name: 'บริษัท มุ่งหวัง จำกัด',
          sourceCode: 'web',
          status: options.lead?.status ?? 'negotiation',
        };
  const leads = {
    findFirst: jest.fn(() => Promise.resolve(lead)),
    update: jest.fn(() =>
      options.failOn === 'update'
        ? Promise.reject(new Error('db down'))
        : Promise.resolve({}),
    ),
  };
  const kinds: Record<string, string> = {
    negotiation: 'open',
    won: 'won',
    lost: 'lost',
  };
  const statuses = {
    require: jest.fn((_company: string, code: string) =>
      Promise.resolve({ code, kind: kinds[code] ?? 'open', nameTh: code }),
    ),
    closingCode: jest.fn(() => Promise.resolve('won')),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const events = { emit: jest.fn(() => Promise.resolve()) };
  const service = new LeadClosingService(
    leads as never,
    statuses as never,
    audit as never,
    events as never,
  );
  return { service, leads, statuses, audit, events };
}

describe('LeadClosingService — Lead เป็น Won เมื่อลูกค้ายืนยัน', () => {
  it('Lead ที่ยังเปิดอยู่ของดีลนี้ → ปิดเป็น won, ลง audit และส่ง lead.status_changed', async () => {
    const { service, leads, audit, events } = harness();

    await service.wonByOpportunity('opp-1', 'quotation_accepted', principal());

    expect(leads.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { convertedOpportunityId: 'opp-1', companyId: 'osd' },
      }),
    );
    expect(leads.update).toHaveBeenCalledWith({
      where: { id: 'lead-1' },
      data: { status: 'won', updatedBy: 'me' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'crm.lead.status_changed',
        resourceId: 'lead-1',
        before: { status: 'negotiation' },
        after: {
          status: 'won',
          reason: 'quotation_accepted',
          opportunityId: 'opp-1',
        },
      }),
    );
    expect(events.emit).toHaveBeenCalledWith({
      name: 'lead.status_changed',
      payload: expect.objectContaining({
        lead_id: 'lead-1',
        status: 'won',
        previous_status: 'negotiation',
        opportunity_id: 'opp-1',
        reason: 'quotation_accepted',
      }),
    });
  });

  it('เรียกซ้ำ (ยอมรับใบเสนอราคาแล้วเปิดใบสั่งขาย) — Lead ที่ปิดแล้วไม่ถูกเขียนทับ', async () => {
    for (const status of ['won', 'lost']) {
      const { service, leads, audit, events } = harness({ lead: { status } });

      await service.wonByOpportunity(
        'opp-1',
        'sale_order_opened',
        principal(),
      );

      expect(leads.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    }
  });

  it('ดีลที่ไม่ได้มาจาก Lead — ไม่ทำอะไร', async () => {
    const { service, leads, statuses } = harness({ lead: null });

    await service.wonByOpportunity('opp-1', 'sale_order_opened', principal());

    expect(statuses.require).not.toHaveBeenCalled();
    expect(leads.update).not.toHaveBeenCalled();
  });

  it('ปิด Lead ไม่สำเร็จไม่ทำให้การยอมรับใบเสนอราคา/ใบสั่งขายล้ม', async () => {
    const { service, events } = harness({ failOn: 'update' });

    await expect(
      service.wonByOpportunity('opp-1', 'quotation_accepted', principal()),
    ).resolves.toBeUndefined();
    expect(events.emit).not.toHaveBeenCalled();
  });
});
