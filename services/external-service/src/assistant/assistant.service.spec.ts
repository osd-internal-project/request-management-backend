import {
  SensitiveFieldMasker,
  type Principal,
} from '@request-management/share';
import { AssistantService } from './assistant.service';

const person = (permissions: string[], hidden: string[] = []) =>
  ({
    userId: 'u-1',
    activeCompanyId: 'osd',
    permissions,
    sensitiveFieldsAll: hidden,
    sensitiveFieldsVisible: [],
  }) as unknown as Principal;

const dealRow = (overrides: Record<string, unknown> = {}) => ({
  opportunityCode: 'OPP-1',
  title: 'ระบบกล้อง',
  stage: 'proposing',
  amount: '120000',
  currency: 'THB',
  probability: 60,
  expectedCloseAt: new Date('2026-10-20T00:00:00Z'),
  customer: { customerCode: 'C1', nameTh: 'ลูกค้า ก' },
  prospectName: null,
  ownerUserId: 'u-1',
  lastActivityAt: null,
  nextFollowUpAt: null,
  ...overrides,
});

function harness() {
  const opportunities = {
    list: jest.fn(() =>
      Promise.resolve({
        data: [
          dealRow(),
          dealRow({
            opportunityCode: 'OPP-2',
            expectedCloseAt: new Date('2020-01-01T00:00:00Z'),
          }),
        ],
        total: 2,
      }),
    ),
  };
  const approvals = {
    inbox: jest.fn(() =>
      Promise.resolve({
        data: [
          {
            id: 'case-1',
            subjectType: 'request',
            amount: null,
            currency: null,
            currentStep: 1,
            requestId: 'r-1',
            createdAt: new Date(Date.now() - 3 * 86_400_000),
          },
        ],
        total: 1,
      }),
    ),
  };
  const statusReports = {
    portfolio: jest.fn(() =>
      Promise.resolve({
        counts: { red: 1, amber: 1, green: 1, unreported: 0 },
        projects: [
          {
            projectNo: 'P1',
            name: 'แดง',
            health: { level: 'red', factors: [] },
          },
          {
            projectNo: 'P2',
            name: 'เหลือง',
            health: { level: 'amber', factors: [] },
          },
          {
            projectNo: 'P3',
            name: 'เขียว',
            health: { level: 'green', factors: [] },
          },
        ],
      }),
    ),
  };
  const workOrders = {
    list: jest.fn(() =>
      Promise.resolve([
        {
          requestId: 'r-1',
          request: { requestNo: 'SR-1' },
          workKind: 'corrective',
        },
        {
          requestId: 'r-2',
          request: { requestNo: 'SR-2' },
          workKind: 'preventive',
        },
      ]),
    ),
  };
  const kb = {
    search: jest.fn(() =>
      Promise.resolve({
        items: [
          {
            articleNo: 'KB-1',
            title: 'VPN',
            summary: 's',
            category: null,
            tags: [],
            score: 5,
            body: 'ยาวมาก',
            match: 'meaning',
            passage: { heading: 'วิธีแก้', text: 'ท่อน', similarity: 0.8 },
          },
        ],
      }),
    ),
  };
  const crmDashboard = {
    dashboard: jest.fn(() =>
      Promise.resolve({ leads: {}, opportunities: {}, activities: {} }),
    ),
  };
  const requestApi = {
    summary: jest.fn(() => Promise.resolve({ open_total: 4 })),
  };
  const requestRows = {
    findMany: jest.fn((args: { select: Record<string, boolean> }) =>
      Promise.resolve(
        args.select.requestNo
          ? [
              {
                id: 'r-1',
                requestNo: 'REQ-1',
                typeCode: 'IT',
                formData: { subject: 'ขอเครื่อง' },
              },
            ]
          : [{ id: 'r-2' }],
      ),
    ),
  };
  const service = new AssistantService(
    opportunities as never,
    approvals as never,
    statusReports as never,
    workOrders as never,
    kb as never,
    crmDashboard as never,
    requestApi as never,
    requestRows as never,
    new SensitiveFieldMasker(),
  );
  return { service, opportunities, approvals, statusReports, kb, requestApi };
}

describe('CD-276 assistant', () => {
  it('closing deals ask the screen’s list for open deals within N days, late first', async () => {
    const { service, opportunities } = harness();
    const answer = await service.closingDeals(person(['crm.sales.read']), {
      days: 14,
      view: 'mine',
    });
    expect(opportunities.list).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ closing_within_days: 14, view: 'mine' }),
    );
    expect(answer.items.map((row) => row.code)).toEqual(['OPP-2', 'OPP-1']);
    expect(answer.items[0].past_expected_close).toBe(true);
    expect(answer.items[1].amount).toBe(120000);
  });

  it('silent deals are the stale alert and the overdue follow-up, both through list', async () => {
    const { service, opportunities } = harness();
    await service.silentDeals(person(['crm.sales.read']), {});
    const asked = opportunities.list.mock.calls.map(
      (call) =>
        (call as unknown as [unknown, { follow_up: string }])[1].follow_up,
    );
    expect(asked.sort()).toEqual(['overdue', 'stale']);
  });

  it('approvals carry the request number, subject and days waiting', async () => {
    const answer = await harness().service.myApprovals(
      person(['approval.decide']),
    );
    expect(answer.items[0]).toMatchObject({
      request_no: 'REQ-1',
      subject: 'ขอเครื่อง',
      waiting_days: 3,
    });
  });

  it('CD-277: a subject the request type masks never reaches the answer', async () => {
    const answer = await harness().service.myApprovals(
      person(['approval.decide'], ['request:IT.subject']),
    );
    expect(answer.items[0].subject).toBeNull();
    expect(answer.items[0].request_no).toBe('REQ-1');
  });

  it('projects at risk are red and amber unless asked for red only', async () => {
    const all = await harness().service.projectsAtRisk(person([]), {});
    expect(all.items.map((row) => row.project_no)).toEqual(['P1', 'P2']);
    const red = await harness().service.projectsAtRisk(person([]), {
      level: 'red',
    });
    expect(red.items.map((row) => row.project_no)).toEqual(['P1']);
  });

  it('service jobs flag the ones past SLA and can keep only those', async () => {
    const { service } = harness();
    const all = await service.serviceJobs(person(['service.asset.read']), {});
    expect(all).toMatchObject({ total: 2, overdue: 1 });
    const late = await service.serviceJobs(person(['service.asset.read']), {
      overdue: 'true',
    });
    expect(late.items.map((row) => row.request_no)).toEqual(['SR-2']);
  });

  it('articles answer short cards, never the body', async () => {
    const answer = await harness().service.articles(person([]), { q: 'vpn' });
    expect(answer.items[0]).toEqual(
      expect.objectContaining({
        article_no: 'KB-1',
        // CD-267 — how it was found reaches the assistant
        match: 'meaning',
        passage: { heading: 'วิธีแก้', text: 'ท่อน', similarity: 0.8 },
      }),
    );
    expect(answer.items[0]).not.toHaveProperty('body');
  });

  it('the summary leaves out a section the person has no screen for', async () => {
    const { service, requestApi, approvals } = harness();
    const answer = await service.summary(person(['request.read']));
    expect(answer.requests).toEqual({ open_total: 4 });
    expect(answer.approvals).toBeNull();
    expect(answer.sales).toBeNull();
    expect(answer.service).toBeNull();
    expect(answer.projects).toMatchObject({ red: 1 });
    expect(requestApi.summary).toHaveBeenCalled();
    expect(approvals.inbox).not.toHaveBeenCalled();
  });
});
