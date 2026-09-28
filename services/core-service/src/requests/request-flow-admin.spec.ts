import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { RequestFlowAdminService } from './request-flow-admin.service';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PublishFlowDto } from './dto/request.dto';
import { suggestedFlow } from './request-flow-suggest';

const OSD = 'company-osd';

function admin(): Principal {
  return {
    userId: 'user-admin',
    activeCompanyId: OSD,
    username: 'admin',
    permissions: ['admin.request-type.manage'],
    companies: [{ id: OSD }],
    // Only the fields these paths read.
  } as unknown as Principal;
}

const TYPE = {
  id: 'type-inst',
  code: 'INST',
  formSchema: { properties: { amount: { type: 'number' } } },
};

function serviceWith(
  options: { type?: typeof TYPE | null; hasLadder?: boolean } = {},
) {
  const created: Record<string, unknown>[] = [];

  const prisma = {
    requestFlowVersion: {
      findFirst: jest.fn(() => Promise.resolve({ version: 2 })),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return Promise.resolve({ id: 'flow-v3', version: 3 });
      }),
    },
  };

  const service = new RequestFlowAdminService(
    { findVersion: jest.fn(() => Promise.resolve({ id: 'flow-v3' })) } as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve(options.type === undefined ? TYPE : options.type),
      ),
      findMany: jest.fn(() => Promise.resolve([])),
    } as never,
    { findReceiver: jest.fn(() => Promise.resolve(null)) } as never,
    {
      hasPublishedMatrix: jest.fn(() =>
        Promise.resolve(options.hasLadder ?? true),
      ),
    } as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
    {
      execute: jest.fn((work: (client: unknown) => unknown) => work(prisma)),
    } as never,
    { assertLevelTargetsExist: jest.fn(() => Promise.resolve()) } as never, // access
  );

  return { service, created };
}

const INSTALL: PublishFlowDto = {
  steps: [
    { code: 'DOCS', name: 'ตรวจเอกสาร' },
    { code: 'INSTALL', name: 'ติดตั้ง', requires_approval: true },
    { code: 'TEST', name: 'ทดสอบ' },
  ],
  transitions: [
    { from_step: 'DOCS', to_step: 'INSTALL' },
    {
      from_step: 'INSTALL',
      to_step: 'TEST',
      condition: { field: 'amount', op: 'gt', value: 1 },
    },
    { from_step: 'INSTALL', to_step: 'TEST' },
    { from_step: 'TEST', to_step: 'DOCS', backward: true },
  ],
};

async function refused(work: Promise<unknown>): Promise<AppError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('request flow admin: publishing a version', () => {
  it('writes the next version with steps and exits in the order given', async () => {
    const { service, created } = serviceWith();

    await service.publish('INST', INSTALL, admin());

    expect(created[0]).toMatchObject({ version: 3, companyId: OSD });
    const exits = (
      created[0].transitions as { create: { sortOrder: number }[] }
    ).create;
    // The two forward exits out of INSTALL keep their order: conditional first.
    expect(exits.map((exit) => exit.sortOrder)).toEqual([1, 1, 2, 1]);
  });

  it('refuses a step that needs approval before its ladder is published', async () => {
    const { service, created } = serviceWith({ hasLadder: false });

    const error = await refused(service.publish('INST', INSTALL, admin()));

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details?.[0].reason).toBe('request:INST:step:INSTALL');
    expect(created).toHaveLength(0);
  });

  it('refuses a fixed assignee who is not in the company', async () => {
    const { service, created } = serviceWith();
    const dto: PublishFlowDto = {
      steps: [
        {
          code: 'DOCS',
          name: 'ตรวจ',
          assignee_rule: { type: 'user', user_id: 'ghost' },
        },
      ],
      transitions: [],
    };

    const error = await refused(service.publish('INST', dto, admin()));

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(created).toHaveLength(0);
  });

  it('answers NOT_FOUND for a type that does not exist', async () => {
    const { service } = serviceWith({ type: null });

    const error = await refused(service.publish('NOPE', INSTALL, admin()));

    expect(error.code).toBe('NOT_FOUND');
  });
});

describe('request flow admin: publishing a v2 flow', () => {
  const SUGGESTED = suggestedFlow({
    formSchema: TYPE.formSchema,
    requiredDocs: [],
    receiverFormSchema: null,
    subRequestTypes: [],
    preLevels: [{ type: 'supervisor', up: 1 }],
    postLevels: null,
  }) as unknown as PublishFlowDto; // same wire shape; the suggestion is a plain object

  it('publishes the suggestion from the existing settings as schema 2', async () => {
    const { service, created } = serviceWith();

    await service.publish('INST', SUGGESTED, admin());

    const steps = (created[0].steps as { create: Record<string, unknown>[] })
      .create;
    expect(created[0].schemaVersion).toBe(2);
    expect(steps.map((step) => step.scopeStatus)).toEqual([
      'draft',
      'pending_approval',
      'submitted',
      'in_progress',
      'approved',
    ]);
    expect(steps[1]).toMatchObject({ returnToStepCode: 'REQUEST' });
  });

  it('refuses a step that takes the reserved code END', async () => {
    const { service, created } = serviceWith();
    const dto = {
      ...SUGGESTED,
      steps: SUGGESTED.steps.map((step) =>
        step.code === 'CONFIRM' ? { ...step, code: 'END' } : step,
      ),
    };

    const error = await refused(service.publish('INST', dto, admin()));

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(created).toHaveLength(0);
  });

  it('keeps the v2 fields through the request whitelist', () => {
    const dto = plainToInstance(PublishFlowDto, SUGGESTED);

    expect(validateSync(dto, { whitelist: true })).toEqual([]);
    expect(dto.schema_version).toBe(2);
    expect(dto.steps[1]).toMatchObject({
      scope_status: 'pending_approval',
      return_to_step: 'REQUEST',
      approval_levels: [{ type: 'supervisor', up: 1, chartOf: 'requester' }],
    });
  });
});
