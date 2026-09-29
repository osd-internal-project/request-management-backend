import type { Principal } from '@request-management/share';
import {
  effectiveRule,
  NOTIFICATION_RULES,
  ruleOf,
  ruleProblems,
} from './notification-rules';
import { NotificationRuleAdminService } from './notification-rule-admin.service';
import { templateOf } from './notification-templates';

const renewal = ruleOf('contract.renewal')!;

describe('CD-53 the rule catalog', () => {
  it('CD-53: every rule sends only templates the catalog declares, and its standard is valid and ordered', () => {
    for (const rule of NOTIFICATION_RULES) {
      for (const eventType of rule.eventTypes) {
        expect(templateOf(eventType)).toBeDefined();
      }
      expect(ruleProblems(rule, rule.defaults)).toEqual({
        problems: [],
        params: rule.defaults,
      });
    }
  });

  it('CD-53: the ticket examples are rules — contract 90/60/30, overdue invoice, KYC expiry', () => {
    expect(renewal.defaults).toEqual({ open_days: 90, remind_days: [60, 30] });
    expect(ruleOf('invoice.overdue')).toBeDefined();
    expect(ruleOf('kyc.expiry')?.defaults).toEqual({ warn_days: 30 });
  });

  it('lists are de-duplicated and sorted largest first', () => {
    expect(
      ruleProblems(renewal, { open_days: 120, remind_days: [30, 60, 30, 7] }),
    ).toEqual({
      problems: [],
      params: { open_days: 120, remind_days: [60, 30, 7] },
    });
  });

  it('refuses out-of-range, empty, fractional, unknown keys and reminders past the opening', () => {
    const problems = (input: Record<string, unknown>) =>
      ruleProblems(renewal, input).problems;
    expect(problems({ open_days: 0 })[0]).toContain('ระหว่าง 1–365');
    expect(problems({ remind_days: [] })[0]).toContain('อย่างน้อย 1');
    expect(problems({ open_days: 1.5 })[0]).toContain('รูปแบบไม่ถูกต้อง');
    expect(problems({ remind_days: 30 })[0]).toContain('รูปแบบไม่ถูกต้อง');
    expect(problems({ remind_days: [1, 2, 3, 4, 5, 6, 7] })[0]).toContain(
      'ไม่เกิน 6',
    );
    expect(problems({ colour: 'red' })[0]).toContain('colour');
    expect(problems({ open_days: 30, remind_days: [60, 30] })[0]).toBe(
      'วันเตือนซ้ำต้องน้อยกว่าวันที่เปิดดีลต่ออายุ',
    );
  });

  it('a stored value that no longer passes falls back to the standard instead of breaking a sweep', () => {
    expect(effectiveRule(renewal, null)).toEqual({
      code: 'contract.renewal',
      enabled: true,
      params: { open_days: 90, remind_days: [60, 30] },
    });
    expect(
      effectiveRule(renewal, {
        enabled: false,
        params: { open_days: 999, remind_days: [45] },
      }),
    ).toEqual({
      code: 'contract.renewal',
      enabled: false,
      params: { open_days: 90, remind_days: [45] },
    });
    // each value valid alone but not together → the whole standard
    expect(
      effectiveRule(renewal, {
        enabled: true,
        params: { open_days: 20, remind_days: [30] },
      }).params,
    ).toEqual(renewal.defaults);
  });
});

describe('CD-53 rules admin', () => {
  const admin = {
    userId: 'admin-1',
    username: 'admin',
    activeCompanyId: 'osd',
    companies: [{ id: 'osd' }],
    permissions: ['admin.notification.manage'],
  } as unknown as Principal;

  function harness(existing: Record<string, unknown> | null = null) {
    const audit = { record: jest.fn(() => Promise.resolve()) };
    const prisma = {
      notificationRule: {
        findMany: jest.fn(() => Promise.resolve(existing ? [existing] : [])),
        findUnique: jest.fn(() => Promise.resolve(existing)),
        upsert: jest.fn((args: { create: Record<string, unknown> }) =>
          Promise.resolve({ ...args.create, updatedAt: new Date() }),
        ),
        delete: jest.fn(() => Promise.resolve({})),
      },
    };
    const service = new NotificationRuleAdminService(
      {
        execute: jest.fn((work: (p: unknown) => unknown) => work(prisma)),
      } as never,
      audit as never,
    );
    return { service, audit, prisma };
  }

  it('CD-53: lists every rule with the standard where the company saved nothing', async () => {
    const { service } = harness({
      code: 'kyc.expiry',
      enabled: false,
      params: { warn_days: 45 },
      updatedAt: new Date('2026-09-29T00:00:00Z'),
    });
    const rows = await service.list(admin);
    expect(rows.map((row) => row.code)).toEqual(
      NOTIFICATION_RULES.map((rule) => rule.code),
    );
    const kyc = rows.find((row) => row.code === 'kyc.expiry')!;
    expect(kyc).toMatchObject({
      enabled: false,
      values: { warn_days: 45 },
      customized: true,
    });
    expect(rows.find((row) => row.code === 'contract.renewal')).toMatchObject({
      enabled: true,
      values: { open_days: 90, remind_days: [60, 30] },
      customized: false,
    });
  });

  it('CD-53: a save is validated, stored for the active company and audited before/after', async () => {
    const { service, audit, prisma } = harness();
    await service.save(
      'contract.renewal',
      { enabled: true, params: { open_days: 120, remind_days: [30, 60] } },
      admin,
    );
    const upsert = (
      prisma.notificationRule.upsert.mock.calls as unknown as [
        { where: unknown; create: { params: unknown } },
      ][]
    )[0][0];
    expect(upsert.where).toEqual({
      companyId_code: { companyId: 'osd', code: 'contract.renewal' },
    });
    expect(upsert.create.params).toEqual({
      open_days: 120,
      remind_days: [60, 30],
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'notification.rule.updated',
        before: { standard: true },
      }),
      expect.anything(),
    );

    await expect(
      service.save(
        'contract.renewal',
        { enabled: true, params: { open_days: 0 } },
        admin,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      service.save('nope', { enabled: true }, admin),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('CD-53: a company the admin is not a member of cannot be targeted', async () => {
    const { service, prisma } = harness();
    await expect(
      service.save('kyc.expiry', { enabled: true, company_id: 'other' }, admin),
    ).rejects.toMatchObject({ code: 'COMPANY_FORBIDDEN' });
    expect(prisma.notificationRule.upsert).not.toHaveBeenCalled();
  });

  it('reset removes the row and is audited; nothing to reset is fine', async () => {
    const saved = harness({
      code: 'kyc.expiry',
      enabled: true,
      params: { warn_days: 45 },
      updatedAt: new Date(),
    });
    await expect(
      saved.service.reset('kyc.expiry', admin),
    ).resolves.toMatchObject({
      customized: false,
      values: { warn_days: 30 },
    });
    expect(saved.prisma.notificationRule.delete).toHaveBeenCalled();
    expect(saved.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'notification.rule.reset' }),
      expect.anything(),
    );

    const none = harness();
    await none.service.reset('kyc.expiry', admin);
    expect(none.audit.record).not.toHaveBeenCalled();
  });
});
