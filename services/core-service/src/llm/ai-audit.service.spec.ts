import type { Principal } from '@request-management/share';
import { AiAuditService } from './ai-audit.service';
import { McpCallLogService } from './mcp-call-log.service';

const admin = {
  userId: 'u-admin',
  activeCompanyId: 'osd',
  permissions: ['admin.ai.audit'],
} as unknown as Principal;

function harness(retentionDays: number | null = 90) {
  const mcpCalls = {
    findMany: jest.fn(() => Promise.resolve([])),
    count: jest.fn(() => Promise.resolve(0)),
    create: jest.fn(() => Promise.resolve({})),
    purgeBefore: jest.fn(() => Promise.resolve(3)),
    companiesWithLogs: jest.fn(() => Promise.resolve(['osd'])),
  };
  const llmCalls = {
    findMany: jest.fn(() => Promise.resolve([])),
    count: jest.fn(() => Promise.resolve(0)),
    purgeBefore: jest.fn(() => Promise.resolve(1)),
  };
  const policies = {
    findFirst: jest.fn(() =>
      Promise.resolve(
        retentionDays === null
          ? null
          : { retentionDays, updatedAt: new Date() },
      ),
    ),
    upsert: jest.fn(() => Promise.resolve({})),
  };
  const people = { findMany: jest.fn(() => Promise.resolve([])) };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const transactions = {
    execute: jest.fn((fn: (prisma: unknown) => unknown) => fn({})),
  };
  const service = new AiAuditService(
    mcpCalls as never,
    llmCalls as never,
    policies as never,
    people as never,
    { get: () => 0 } as never,
    transactions as never,
    audit as never,
  );
  return { service, mcpCalls, llmCalls, policies, audit };
}

describe('CD-279 AI audit', () => {
  it('searches only the active company, by person, tool and Bangkok days', async () => {
    const { service, mcpCalls } = harness();
    await service.mcp(admin, {
      user_id: 'u-1',
      name: 'crm_get_leads',
      from: '2026-10-01',
      to: '2026-10-01',
      page: 1,
      page_size: 20,
    });
    const where = (
      mcpCalls.findMany.mock.calls[0] as unknown as [
        { where: Record<string, unknown> },
      ]
    )[0].where;
    expect(where).toMatchObject({
      companyId: 'osd',
      userId: 'u-1',
      tool: 'crm_get_leads',
    });
    const range = where.createdAt as { gte: Date; lt: Date };
    expect(range.gte.toISOString()).toBe('2026-09-30T17:00:00.000Z');
    expect(range.lt.toISOString()).toBe('2026-10-01T17:00:00.000Z');
  });

  it('a changed retention is audited with before and after', async () => {
    const { service, policies, audit } = harness(365);
    await service.savePolicy(admin, { retention_days: 180 });
    expect(policies.upsert).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ai.audit.policy.updated',
        before: { retentionDays: 365 },
        after: { retentionDays: 180 },
      }),
      expect.anything(),
    );
  });

  it('the sweep removes each company’s logs older than its policy (365 when unset)', async () => {
    const now = new Date('2026-10-06T00:00:00Z');
    const set = harness(90);
    await expect(set.service.sweep(now)).resolves.toEqual({ removed: 4 });
    expect(set.mcpCalls.purgeBefore).toHaveBeenCalledWith(
      'osd',
      new Date('2026-07-08T00:00:00Z'),
    );
    const unset = harness(null);
    await unset.service.sweep(now);
    expect(unset.llmCalls.purgeBefore).toHaveBeenCalledWith(
      'osd',
      new Date('2025-10-06T00:00:00Z'),
    );
  });
});

describe('CD-279 MCP call log', () => {
  it('keeps ids and a count, never values; a failed call keeps its code', async () => {
    const calls = { create: jest.fn(() => Promise.resolve({})) };
    const log = new McpCallLogService(calls as never);
    await log.record({
      companyId: 'osd',
      userId: 'u-1',
      viaServiceAccount: true,
      tool: 'crm_get_customers',
      args: { search: 'บริษัท' },
      result: { data: [{ id: 'c-1', taxId: '0105551234567' }], total: 1 },
      durationMs: 12.6,
    });
    const data = (
      calls.create.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(data).toMatchObject({
      resultIds: ['c-1'],
      resultCount: 1,
      status: 'ok',
      isWrite: false,
      durationMs: 13,
    });
    expect(JSON.stringify(data)).not.toContain('0105551234567');

    await log.record({
      companyId: 'osd',
      userId: 'u-1',
      viaServiceAccount: false,
      tool: 'crm_post_leads',
      args: { name: 'ลูกค้าใหม่', phone: '0812345678' },
      errorCode: 'FORBIDDEN',
      durationMs: 1,
    });
    const failed = (
      calls.create.mock.calls[1] as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(failed).toMatchObject({
      status: 'error',
      errorCode: 'FORBIDDEN',
      isWrite: true,
      args: { fields: ['name', 'phone'] },
    });
  });

  it('a log that cannot be written does not fail the call', async () => {
    const log = new McpCallLogService({
      create: jest.fn(() => Promise.reject(new Error('db down'))),
    } as never);
    await expect(
      log.record({
        companyId: 'osd',
        userId: null,
        viaServiceAccount: false,
        tool: 'x',
        args: {},
        durationMs: 0,
      }),
    ).resolves.toBeUndefined();
  });
});
