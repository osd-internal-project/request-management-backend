import { Prisma } from '@prisma/client';
import type { Principal } from '@request-management/share';
import type { ApiKeyContext } from '../principal/api-key.service';
import type { CreateProcessLogDto } from './dto/process-log.dto';
import type { ProcessFlowLogRepository } from './process-log.repository';
import { ProcessLogService } from './process-log.service';

const principal = {
  userId: 'svc',
  activeCompanyId: 'header-company',
  permissions: ['integration.process.log'],
  isServiceAccount: true,
} as unknown as Principal;

const key = {
  id: 'k1',
  prefix: 'rfk_abc',
  name: 'OSD Workflow',
  companyId: 'osd',
  sourceCode: null,
  scopes: ['integration.process.log'],
} as ApiKeyContext;

const dto: CreateProcessLogDto = {
  event_id: 'i-1:qualification:completed',
  instance_id: 'i-1',
  workflow_key: 'ctd-s1-market-to-lead',
  stage_no: 1,
  step_code: 'qualification',
  status: 'completed',
  ref_no: 'LEAD-1',
};

function stored(data: Record<string, unknown>) {
  return {
    id: 'log-1',
    createdAt: new Date('2026-10-21T02:00:00Z'),
    occurredAt: new Date('2026-10-21T02:00:00Z'),
    stepName: null,
    decision: null,
    refType: null,
    actorEmail: null,
    actorName: null,
    comment: null,
    payload: null,
    apiKeyPrefix: null,
    ...data,
  };
}

function setup(existing: unknown = null) {
  const repo = {
    findFirst: jest.fn().mockResolvedValue(existing),
    create: jest.fn(({ data }) => Promise.resolve(stored(data))),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  };
  const service = new ProcessLogService(
    repo as unknown as ProcessFlowLogRepository,
  );
  return { repo, service };
}

describe('End-to-End process log', () => {
  it("stamps the stage's code and team and the key's company", async () => {
    const { repo, service } = setup();
    const row = await service.record(dto, principal, key);

    expect(repo.create.mock.calls[0][0].data).toMatchObject({
      companyId: 'osd',
      stageNo: 1,
      stageCode: 'market_to_lead',
      teamCode: 'T01',
      apiKeyPrefix: 'rfk_abc',
    });
    expect(row.stage_name).toBe('การตลาด & สร้างโอกาส');
  });

  it('falls back to the active company when the key has none', async () => {
    const { repo, service } = setup();
    await service.record(dto, principal, { ...key, companyId: null });
    expect(repo.create.mock.calls[0][0].data.companyId).toBe('header-company');
  });

  it('answers the first row for a repeated event_id', async () => {
    const { repo, service } = setup(
      stored({
        ...dto,
        companyId: 'osd',
        eventId: dto.event_id,
        stageCode: 'market_to_lead',
        teamCode: 'T01',
        instanceId: 'i-1',
        workflowKey: dto.workflow_key,
        stageNo: 1,
        stepCode: 'qualification',
        refNo: 'LEAD-1',
      }),
    );
    const row = await service.record(dto, principal, key);
    expect(repo.create).not.toHaveBeenCalled();
    expect(row.id).toBe('log-1');
  });

  it('turns a racing duplicate into the winning row', async () => {
    const { repo, service } = setup();
    repo.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    repo.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        stored({
          eventId: dto.event_id,
          companyId: 'osd',
          instanceId: 'i-1',
          workflowKey: 'w',
          stageNo: 1,
          stageCode: 'market_to_lead',
          teamCode: 'T01',
          stepCode: 'qualification',
          status: 'completed',
          refNo: null,
        }),
      );
    const row = await service.record(dto, principal, key);
    expect(row.event_id).toBe(dto.event_id);
  });

  it('refuses an oversized payload', async () => {
    const { service } = setup();
    await expect(
      service.record(
        { ...dto, payload: { blob: 'x'.repeat(17 * 1024) } },
        principal,
        key,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('always pins the list to the company', async () => {
    const { repo, service } = setup();
    await service.list({ ref_no: 'LEAD' }, 'osd');
    expect(repo.findMany.mock.calls[0][0].where).toMatchObject({
      companyId: 'osd',
      refNo: { contains: 'LEAD', mode: 'insensitive' },
    });
  });
});
