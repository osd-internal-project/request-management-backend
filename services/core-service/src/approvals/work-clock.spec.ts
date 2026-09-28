import type { Principal } from '@request-management/share';
import { ApprovalsService } from './approvals.service';

const OSD = 'company-osd';

function deciding(subjectType: string, requestStatusAfter: string) {
  const sla = {
    stop: jest.fn(() => Promise.resolve()),
    resume: jest.fn(() => Promise.resolve()),
    pause: jest.fn(() => Promise.resolve()),
    dueAfter: jest.fn(() => Promise.resolve(null)),
  };
  const prisma = {
    approvalCase: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 'case-1',
          companyId: OSD,
          status: 'pending',
          currentStep: 1,
          subjectType,
          requestId: 'req-1',
          createdBy: 'user-requester',
          steps: [
            {
              id: 'step-1',
              stepNo: 1,
              status: 'pending',
              candidateUserIds: ['user-a'],
              approverUserId: 'user-a',
              mode: 'any',
              noteRequired: 'always',
            },
          ],
          request: {
            requesterId: 'user-requester',
            receiverUserId: null,
            assigneeUserId: null,
            requesterOrgUnitId: null,
            receiverOrgUnitId: null,
            typeCode: 'IT',
            requestNo: 'OSD-IT-1',
            status: 'pending_approval',
          },
        }),
      ),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      findUniqueOrThrow: jest.fn(() =>
        Promise.resolve({ id: 'case-1', status: 'approved', steps: [] }),
      ),
    },
    approvalStep: { update: jest.fn(() => Promise.resolve({})) },
    approvalVote: { create: jest.fn(() => Promise.resolve({})) },
    request: {
      update: jest.fn(() => Promise.resolve({})),
      findUniqueOrThrow: jest.fn(() =>
        Promise.resolve({ status: requestStatusAfter }),
      ),
    },
    $queryRaw: jest.fn(() => Promise.resolve([])),
    requestEvent: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      create: jest.fn(() => Promise.resolve({})),
    },
  };
  const service = new ApprovalsService(
    {} as never,
    { findActiveFor: jest.fn(() => Promise.resolve(null)) } as never,
    {} as never,
    {} as never,
    {} as never,
    { decisionMade: jest.fn(() => Promise.resolve()) } as never,
    { emit: jest.fn(() => Promise.resolve()) } as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
    {
      execute: jest.fn((work: (client: unknown) => unknown) => work(prisma)),
    } as never,
    { advanceAfterApproval: jest.fn(() => Promise.resolve()) } as never,
    sla as never,
  );
  const approver = {
    userId: 'user-a',
    activeCompanyId: OSD,
    permissions: ['approval.decide'],
  };
  return { service, sla, approver: approver as unknown as Principal };
}

describe('SUP-01: the team clock around an approval', () => {
  it('stops, judged, when the result is accepted after the work', async () => {
    const { service, sla, approver } = deciding('request:IT', 'approved');

    await service.decide(
      'case-1',
      { decision: 'approve', note: 'ok' },
      approver,
    );

    expect(sla.stop).toHaveBeenCalledWith(expect.anything(), 'req-1', 'met');
  });

  it('resumes when the work is sent back to the team, so the rework is timed', async () => {
    const { service, sla, approver } = deciding('request:IT', 'in_progress');

    await service.decide(
      'case-1',
      { decision: 'return', note: 'fix' },
      approver,
    );

    expect(sla.resume).toHaveBeenCalledWith(expect.anything(), 'req-1');
    expect(sla.stop).not.toHaveBeenCalled();
  });

  it('cancels the clock when the request is refused before any work', async () => {
    const { service, sla, approver } = deciding('request:IT:pre', 'rejected');

    await service.decide(
      'case-1',
      { decision: 'reject', note: 'no' },
      approver,
    );

    expect(sla.stop).toHaveBeenCalledWith(
      expect.anything(),
      'req-1',
      'cancelled',
    );
  });

  it('leaves a pre-work approval alone — the clock starts at assignment', async () => {
    const { service, sla, approver } = deciding('request:IT:pre', 'submitted');

    await service.decide(
      'case-1',
      { decision: 'approve', note: 'ok' },
      approver,
    );

    expect(sla.stop).not.toHaveBeenCalled();
    expect(sla.resume).not.toHaveBeenCalled();
  });
});
