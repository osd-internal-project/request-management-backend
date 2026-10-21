import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { ProcessRefsQueryDto } from './dto/process-refs.dto';
import { ProcessRefsService } from './process-refs.service';

type Find = jest.Mock<Promise<unknown>, [Record<string, unknown>]>;

function repo(answer: unknown = null): { findFirst: Find } {
  return { findFirst: jest.fn().mockResolvedValue(answer) };
}

function build(over: Partial<Record<string, { findFirst: Find }>> = {}) {
  const r = {
    leads: repo({
      id: 'lead-1',
      name: 'ACME',
      status: 'converted',
      convertedOpportunityId: 'opp-1',
    }),
    opportunities: repo({
      id: 'opp-1',
      opportunityCode: 'OPP-OSD-0007',
      stage: 'won',
    }),
    quotations: repo({
      id: 'qt-1',
      quotationNo: 'QT-OSD-0003',
      version: 2,
      status: 'accepted',
    }),
    saleOrders: repo({
      saleOrderCode: 'SO-OSD-0001',
      status: 'open',
      erpOrderNo: null,
    }),
    contracts: repo(null),
    crmConfig: repo({
      solutionRequestTypeCode: 'SOL',
      contractRequestTypeCode: 'CTR',
    }),
    solutions: repo({ id: 'sol-1' }),
    requests: repo({
      id: 'req-1',
      requestNo: 'REQ-OSD-SOL-26100001',
      status: 'completed',
    }),
    projects: repo({
      id: 'prj-1',
      projectNo: 'PRJ-OSD-0004',
      status: 'active',
    }),
    certificates: repo({
      certificateNo: 'AC-PRJ-OSD-0004-01',
      status: 'signed',
    }),
    ...over,
  };
  const config = {
    get: () => 'https://ctd-dev.osd.co.th/',
  } as unknown as ConfigService;
  const service = new ProcessRefsService(
    r.leads as never,
    r.opportunities as never,
    r.quotations as never,
    r.saleOrders as never,
    r.contracts as never,
    r.crmConfig as never,
    r.solutions as never,
    r.requests as never,
    r.projects as never,
    r.certificates as never,
    config,
  );
  return { service, r };
}

describe('ProcessRefsService — the deal trail for OSD Workflow', () => {
  it('follows a converted lead to its deal, quotation, sale order and project', async () => {
    const { service } = build();
    const refs = await service.resolve({ lead_id: 'lead-1' }, 'osd');

    expect(refs).toMatchObject({
      lead_url: 'https://ctd-dev.osd.co.th/pages/leads/lead-1',
      opportunity_no: 'OPP-OSD-0007',
      opportunity_url: 'https://ctd-dev.osd.co.th/pages/opportunities/opp-1',
      solution_request_no: 'REQ-OSD-SOL-26100001',
      solution_request_url: 'https://ctd-dev.osd.co.th/pages/requests/req-1',
      quotation_no: 'QT-OSD-0003',
      quotation_version: '2',
      quotation_url: 'https://ctd-dev.osd.co.th/pages/quotations/qt-1',
      sale_order_no: 'SO-OSD-0001',
      project_no: 'PRJ-OSD-0004',
      project_url: 'https://ctd-dev.osd.co.th/pages/projects/prj-1',
      acceptance_no: 'AC-PRJ-OSD-0004-01',
    });
  });

  it('answers "-" for what does not exist yet — a null would fail the workflow template', async () => {
    const { service } = build();
    const refs = await service.resolve({ lead_id: 'lead-1' }, 'osd');

    expect(refs.sale_order_erp_no).toBe('-');
    expect(refs.contract_no).toBe('-');
    expect(refs.nda_no).toBe('-');
    // no contract yet: the deal page is where it is asked for
    expect(refs.contract_url).toBe(
      'https://ctd-dev.osd.co.th/pages/opportunities/opp-1',
    );
    expect(
      Object.values(refs).every((v) => typeof v === 'string' && v !== ''),
    ).toBe(true);
  });

  it('an unconverted lead links its deal steps to the lead page', async () => {
    const { service, r } = build({
      leads: repo({
        id: 'lead-2',
        name: 'New Co',
        status: 'new',
        convertedOpportunityId: null,
      }),
    });
    const refs = await service.resolve({ lead_id: 'lead-2' }, 'osd');

    expect(r.opportunities.findFirst).not.toHaveBeenCalled();
    expect(refs.opportunity_no).toBe('-');
    expect(refs.opportunity_url).toBe(
      'https://ctd-dev.osd.co.th/pages/leads/lead-2',
    );
  });

  it('an unknown lead is every field "-", not an error (test runs, late syncs)', async () => {
    const { service } = build({ leads: repo(null) });
    const refs = await service.resolve({ lead_id: 'TEST-LEAD-003' }, 'osd');

    expect(refs.lead_id).toBe('-');
    expect(refs.opportunity_no).toBe('-');
    expect(refs.project_no).toBe('-');
  });

  it("SCOPE-03 — every read is pinned to the key's company", async () => {
    const { service, r } = build();
    await service.resolve({ lead_id: 'lead-1' }, 'osd');

    for (const one of Object.values(r)) {
      for (const [args] of one.findFirst.mock.calls) {
        expect((args.where as Record<string, unknown>).companyId).toBe('osd');
      }
    }
  });

  it('finds the deal by number when there is no lead id', async () => {
    const { service, r } = build();
    await service.resolve({ opportunity_no: 'OPP-OSD-0007' }, 'osd');

    expect(r.leads.findFirst).not.toHaveBeenCalled();
    expect(r.opportunities.findFirst.mock.calls[0][0].where).toEqual({
      opportunityCode: 'OPP-OSD-0007',
      companyId: 'osd',
    });
  });

  it('refuses without a company or without anything to look up', async () => {
    const { service } = build();
    await expect(
      service.resolve({ lead_id: 'lead-1' }, null),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(service.resolve({}, 'osd')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('reads the workflow\'s "-" as not sent', () => {
    const query = plainToInstance(ProcessRefsQueryDto, {
      lead_id: 'lead-1',
      opportunity_no: '-',
    });
    expect(query.opportunity_no).toBeUndefined();
    expect(query.lead_id).toBe('lead-1');
  });
});
