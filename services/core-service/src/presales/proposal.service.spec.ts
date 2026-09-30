import type { Principal } from '@request-management/share';
import { ProposalService } from './proposal.service';

const seller = {
  userId: 'sales-1',
  activeCompanyId: 'osd',
  permissions: ['crm.sales.read'],
} as unknown as Principal;

function harness(options: { approval?: string; readable?: boolean } = {}) {
  const solutions = {
    requireReadable: jest.fn(() =>
      options.readable === false
        ? Promise.reject(Object.assign(new Error('x'), { code: 'NOT_FOUND' }))
        : Promise.resolve({
            id: 'sol-1',
            companyId: 'osd',
            opportunityId: 'opp-1',
            title: 'SD-WAN',
          }),
    ),
  };
  const versions = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        versionNo: 2,
        status: 'locked',
        approvalStatus: options.approval ?? 'approved',
        approvedAt: new Date('2026-09-30T00:00:00Z'),
        lockedAt: new Date('2026-09-29T00:00:00Z'),
        summary: 'SD-WAN 12 สาขา',
        design: 'Hub and spoke',
        assumptions: [
          { category: 'technical', text: 'ใช้ลิงก์เดิม' },
          {
            category: 'customer',
            text: 'ลูกค้าจัดพื้นที่ rack',
            owner: 'ฝ่าย IT ลูกค้า',
            neededBy: '2026-10-15',
          },
        ],
        inScope: ['ติดตั้ง 12 สาขา'],
        outOfScope: ['งานสายภายในอาคาร'],
        deliverables: [
          {
            title: 'อุปกรณ์ติดตั้งแล้ว',
            description: '',
            criteria: ['ping ผ่าน'],
          },
        ],
        boq: [
          {
            kind: 'equipment',
            productCode: 'FG-100F',
            name: 'FortiGate',
            description: '',
            model: '100F',
            quantity: 12,
            unit: 'เครื่อง',
            refUnitCost: 45000,
          },
        ],
      }),
    ),
  };
  const opportunities = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        opportunityCode: 'OPP-OSD-0001',
        title: 'SD-WAN',
        prospectName: null,
        prospectContactName: 'คุณเอ',
        customer: { customerCode: 'CUS-0001', nameTh: 'บริษัท ลูกค้า' },
        company: { name: 'OSD' },
      }),
    ),
  };
  const configs = {
    findFirst: jest.fn(() =>
      Promise.resolve({ letterheadNameTh: 'บริษัท โอเอสดี จำกัด' }),
    ),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new ProposalService(
    solutions as never,
    versions as never,
    opportunities as never,
    configs as never,
    audit as never,
  );
  return { service, audit, versions };
}

describe('ProposalService (CD-137)', () => {
  it('builds the proposal from an approved version, with no cost anywhere', async () => {
    const { service, audit } = harness();
    const view = await service.printView('sol-1', 2, seller);

    expect(view.letterhead.nameTh).toBe('บริษัท โอเอสดี จำกัด');
    expect(view.deal).toMatchObject({
      opportunityCode: 'OPP-OSD-0001',
      partyName: 'บริษัท ลูกค้า',
      contactName: 'คุณเอ',
    });
    expect(view.version).toMatchObject({
      versionNo: 2,
      superseded: false,
      inScope: ['ติดตั้ง 12 สาขา'],
      outOfScope: ['งานสายภายในอาคาร'],
      deliverables: [
        expect.objectContaining({
          title: 'อุปกรณ์ติดตั้งแล้ว',
          criteria: ['ping ผ่าน'],
        }),
      ],
    });
    expect(view.boq).toEqual([
      expect.objectContaining({
        lineNo: 1,
        productCode: 'FG-100F',
        quantity: 12,
      }),
    ]);
    expect(JSON.stringify(view)).not.toContain('45000');
    expect(JSON.stringify(view)).not.toContain('refUnitCost');
    expect(view.assumptions.map((row) => row.text)).toEqual(['ใช้ลิงก์เดิม']);
    expect(view.dependencies).toEqual([
      expect.objectContaining({
        text: 'ลูกค้าจัดพื้นที่ rack',
        owner: 'ฝ่าย IT ลูกค้า',
        neededBy: '2026-10-15',
      }),
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'presales.solution.proposal_printed',
        resourceId: 'sol-1',
        after: { versionNo: 2 },
      }),
    );
  });

  it.each(['none', 'pending', 'rejected', 'cancelled'])(
    'refuses a version whose approval is %s',
    async (approval) => {
      const { service, audit } = harness({ approval });
      await expect(service.printView('sol-1', 2, seller)).rejects.toMatchObject(
        { code: 'CONFLICT' },
      );
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('answers 404 for a Solution the caller cannot read (SCOPE-03)', async () => {
    const { service, versions } = harness({ readable: false });
    await expect(service.printView('sol-1', 2, seller)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(versions.findFirst).not.toHaveBeenCalled();
  });
});
