import { Prisma } from '@prisma/client';
import type { Principal } from '@request-management/share';
import {
  DecisionLogService,
  EXPORT_MAX_ROWS,
  basisOf,
  decisionWindow,
} from './decision-log.service';

function principal(): Principal {
  return {
    userId: 'u-auditor',
    username: 'auditor',
    displayName: 'ผู้ตรวจ',
    activeCompanyId: 'company-osd',
    permissions: ['approval.history.read'],
    ledUnitIds: [],
    scopedUnitIds: [],
    isServiceAccount: false,
  } as unknown as Principal;
}

function step(overrides: Record<string, unknown> = {}) {
  return {
    id: 'st-1',
    stepNo: 1,
    approverRole: 'หัวหน้าแผนก',
    approverUserId: 'u-boss',
    candidateUserIds: [],
    decision: 'approve',
    note: null,
    decidedAt: new Date('2026-09-10T03:30:00Z'),
    decidedByUserId: 'u-boss',
    delegationId: null,
    approver: { displayName: 'หัวหน้า' },
    decidedBy: { displayName: 'หัวหน้า' },
    case: {
      id: 'case-1',
      subjectType: 'request:DSC',
      amount: new Prisma.Decimal(150000),
      currency: 'THB',
      status: 'approved',
      matrixVersion: 3,
      snapshotVersion: 1,
      snapshotHash: 'abcdef0123456789',
      request: {
        id: 'req-1',
        requestNo: 'REQ-OSD-DSC-69090001',
        typeCode: 'DSC',
      },
    },
    ...overrides,
  };
}

function harness(steps: unknown[] = [step()], total = steps.length) {
  const wheres: Record<string, unknown>[] = [];
  const cases = {
    decidedSteps: jest.fn((where: Record<string, unknown>) => {
      wheres.push(where);
      return Promise.resolve(steps);
    }),
    countDecidedSteps: jest.fn(() => Promise.resolve(total)),
    stepIdsByBasis: jest.fn(() => Promise.resolve(['st-9'])),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new DecisionLogService(cases as never, audit as never);
  return { service, cases, audit, wheres };
}

describe('APV-06 basisOf', () => {
  it('the named approver, or one of the step’s candidates, is the chain', () => {
    expect(basisOf(step())).toBe('chain');
    expect(
      basisOf(
        step({
          approverUserId: null,
          candidateUserIds: ['u-a', 'u-b'],
          decidedByUserId: 'u-b',
        }),
      ),
    ).toBe('chain');
  });

  it('a delegation is "on behalf", even when the delegate is also a candidate', () => {
    expect(
      basisOf(step({ delegationId: 'dg-1', decidedByUserId: 'u-deputy' })),
    ).toBe('delegate');
  });

  it('anyone else acted under a scope grant — the out-of-chain exception', () => {
    expect(basisOf(step({ decidedByUserId: 'u-ops-lead' }))).toBe(
      'scope_grant',
    );
  });
});

describe('APV-06 decisionWindow', () => {
  it('defaults to this Bangkok month, `to` inclusive', () => {
    const window = decisionWindow({}, new Date('2026-09-28T03:00:00Z'));
    expect(window).toMatchObject({ from: '2026-09-01', to: '2026-09-28' });
    expect(window.start).toEqual(new Date('2026-08-31T17:00:00Z'));
    expect(window.end).toEqual(new Date('2026-09-28T17:00:00Z'));
  });

  it('refuses impossible and reversed dates', () => {
    expect(() =>
      decisionWindow({ from: '2026-02-30', to: '2026-03-01' }),
    ).toThrow('วันที่ไม่ถูกต้อง');
    expect(() =>
      decisionWindow({ from: '2026-09-10', to: '2026-09-01' }),
    ).toThrow('วันเริ่มต้องไม่เกินวันสิ้นสุด');
  });
});

describe('APV-06 DecisionLogService', () => {
  const query = { from: '2026-09-01', to: '2026-09-30' } as never;

  it('APV-06: a row says who decided what, when, on what basis, on which data', async () => {
    const { service } = harness([
      step({
        delegationId: 'dg-1',
        decidedByUserId: 'u-deputy',
        decidedBy: { displayName: 'รองหัวหน้า' },
      }),
    ]);

    const result = await service.list(query, principal());

    expect(result.period).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(result.data[0]).toMatchObject({
      request_no: 'REQ-OSD-DSC-69090001',
      approver_name: 'หัวหน้า',
      decided_by_name: 'รองหัวหน้า',
      basis: 'delegate',
      decision: 'approve',
      amount: 150000,
      matrix_version: 3,
      snapshot_hash: 'abcdef0123456789',
    });
  });

  it('SCOPE-03: pinned to the active company and the decision window', async () => {
    const { service, wheres } = harness();

    await service.list(query, principal());

    expect(wheres[0]).toMatchObject({
      decision: { not: null },
      decidedAt: {
        gte: new Date('2026-08-31T17:00:00Z'),
        lt: new Date('2026-09-30T17:00:00Z'),
      },
      case: { companyId: 'company-osd' },
    });
  });

  it('APV-06: a basis filter narrows to the ids the column comparison found', async () => {
    const { service, cases, wheres } = harness();

    await service.list(
      { ...(query as object), basis: 'scope_grant' } as never,
      principal(),
    );

    expect(cases.stepIdsByBasis).toHaveBeenCalledWith(
      'company-osd',
      expect.anything(),
      'scope_grant',
    );
    expect(wheres[0]).toMatchObject({ id: { in: ['st-9'] } });
  });

  it('APV-06: export is Excel-ready CSV — BOM, Thai labels, Bangkok time, quoted and formula-safe', async () => {
    const { service, audit } = harness([
      step({ note: 'ตกลง, แต่ "ต้องแนบสัญญา"' }),
      step({
        id: 'st-2',
        decidedByUserId: 'u-ops',
        decidedBy: { displayName: 'ฝ่ายปฏิบัติการ' },
        note: '=HYPERLINK("x")',
      }),
    ]);

    const file = await service.exportCsv(query, principal());
    const text = file.body.toString('utf8');

    expect(text.startsWith('﻿')).toBe(true);
    expect(file.filename).toBe('approval-decisions_2026-09-01_2026-09-30.csv');
    const lines = text.slice(1).trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('ผู้ตัดสิน,ในฐานะ,ผลการตัดสิน');
    // 03:30 UTC → 10:30 Bangkok
    expect(lines[1]).toContain('2026-09-10 10:30');
    expect(lines[1]).toContain('ตามสายอนุมัติ,อนุมัติ');
    expect(lines[1]).toContain('"ตกลง, แต่ ""ต้องแนบสัญญา"""');
    expect(lines[1]).toContain('v1 abcdef012345');
    expect(lines[2]).toContain('สิทธิ์ขอบเขต (นอกสาย)');
    expect(lines[2]).toContain(`"'=HYPERLINK(""x"")"`);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'approval.decisions.exported',
        companyId: 'company-osd',
      }),
    );
  });

  it('APV-06: an export past the row cap is refused, and nothing is audited', async () => {
    const { service, audit, cases } = harness([], EXPORT_MAX_ROWS + 1);

    await expect(service.exportCsv(query, principal())).rejects.toThrow(
      'แคบช่วงเวลาลง',
    );
    expect(cases.decidedSteps).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
