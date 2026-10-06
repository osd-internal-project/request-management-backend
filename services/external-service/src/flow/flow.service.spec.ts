import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { FlowService } from './flow.service';

const deal = {
  id: 'opp-1',
  opportunityCode: 'OPP-OSD-0001',
  title: 'ระบบกล้อง',
  stage: 'proposing',
  saleOrders: [],
  solutionRequestTypeCode: 'SOL',
  demoRequestTypeCode: null,
  contractRequestTypeCode: 'CTR',
};

function principal(permissions: string[]): Principal {
  return { permissions } as unknown as Principal;
}

function build(overrides: Record<string, jest.Mock> = {}) {
  const mocks = {
    findOne: jest.fn().mockResolvedValue(deal),
    requests: jest
      .fn()
      .mockImplementation((_actor: unknown, query: { type_code?: string }) =>
        Promise.resolve({
          data:
            query.type_code !== 'SOL'
              ? []
              : [
                  {
                    id: 'r1',
                    requestNo: 'REQ-1',
                    typeCode: 'SOL',
                    status: 'submitted',
                    formData: { subject: 'ขอ Solution' },
                    statusTokenHash: 'secret-hash',
                    requestType: { formSchema: {} },
                  },
                ],
        }),
      ),
    forDeal: jest.fn().mockResolvedValue([]),
    quotations: jest.fn().mockResolvedValue({ data: [] }),
    contracts: jest.fn().mockResolvedValue({ data: [] }),
    projects: jest.fn().mockResolvedValue({ data: [] }),
    ...overrides,
  };
  const service = new FlowService(
    { findOne: mocks.findOne } as never,
    { list: mocks.requests } as never,
    { forDeal: mocks.forDeal } as never,
    { list: mocks.quotations } as never,
    { list: mocks.contracts } as never,
    { list: mocks.projects } as never,
  );
  return { service, mocks };
}

describe('FlowService.track — one deal, followed as the person sees it', () => {
  const reader = principal([
    'crm.sales.read',
    'request.read',
    'legal.contract.read',
  ]);

  it('reads the deal first and refuses with its 404 (SCOPE-03)', async () => {
    const { service, mocks } = build({
      findOne: jest
        .fn()
        .mockRejectedValue(
          new AppError('NOT_FOUND', 'ไม่พบโอกาสการขายที่ระบุ'),
        ),
    });

    await expect(service.track('opp-x', reader)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(mocks.forDeal).not.toHaveBeenCalled();
  });

  it('asks for hand-offs by the deal code and the configured type', async () => {
    const { service, mocks } = build();

    const result = await service.track('opp-1', reader);

    expect(mocks.requests).toHaveBeenCalledWith(
      reader,
      expect.objectContaining({
        ref_type: 'opportunity',
        ref_id: 'OPP-OSD-0001',
        type_code: 'SOL',
      }),
    );
    // A type the company has not set is no step, not an empty one.
    expect(result.handoffs.demo).toBeNull();
    expect(result.stage).toBe('presales');
  });

  it('keeps the hand-off rows to where they stand', async () => {
    const { service } = build();

    const result = await service.track('opp-1', reader);
    const solution = result.handoffs.solution!;

    expect(solution.requests).toEqual({
      visible: true,
      data: [
        expect.objectContaining({ requestNo: 'REQ-1', subject: 'ขอ Solution' }),
      ],
    });
    const [row] = (solution.requests as { data: object[] }).data;
    expect(row).not.toHaveProperty('statusTokenHash');
    expect(row).not.toHaveProperty('requestType');
  });

  it('hides contracts from a person without legal.contract.read, without asking', async () => {
    const { service, mocks } = build();

    const result = await service.track(
      'opp-1',
      principal(['crm.sales.read', 'request.read']),
    );

    expect(result.contracts).toEqual({
      visible: false,
      reason: 'missing_permission',
    });
    expect(mocks.contracts).not.toHaveBeenCalled();
  });

  it("turns a section's FORBIDDEN into visible:false, not a failed answer", async () => {
    const { service } = build({
      projects: jest
        .fn()
        .mockRejectedValue(new AppError('FORBIDDEN', 'ไม่มีสิทธิ์')),
    });

    const result = await service.track('opp-1', reader);

    expect(result.projects).toEqual({ visible: false, reason: 'forbidden' });
  });

  it('lets a real fault through rather than reading it as empty', async () => {
    const { service } = build({
      quotations: jest.fn().mockRejectedValue(new Error('db down')),
    });

    await expect(service.track('opp-1', reader)).rejects.toThrow('db down');
  });
});
