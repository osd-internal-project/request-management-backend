import type { Principal } from '@request-management/share';
import { TechPackageService } from './tech-package.service';

const actor = {
  userId: 'u-eng',
  displayName: 'วิศวกร',
  activeCompanyId: 'osd',
  permissions: [],
} as unknown as Principal;

function harness(
  options: {
    canEdit?: boolean;
    member?: boolean;
    cautions?: string | null;
    configItems?: number;
  } = {},
) {
  let brief = options.cautions
    ? {
        cautions: options.cautions,
        updatedAt: new Date(),
        createdBy: 'u-pm',
        updatedBy: null,
      }
    : null;
  const deliveries = {
    access: jest.fn(() =>
      Promise.resolve({
        project: { id: 'p-1', companyId: 'osd' },
        canEdit: options.canEdit ?? false,
      }),
    ),
  };
  const projects = {
    access: jest.fn(() =>
      Promise.resolve({
        canEdit: false,
        project: {
          managerUserId: 'u-pm',
          members: options.member ? [{ userId: 'u-eng' }] : [],
        },
      }),
    ),
  };
  const asBuilt = {
    state: jest.fn(() =>
      Promise.resolve({
        complete: true,
        missingDocuments: [],
        openDeviations: [],
      }),
    ),
  };
  const configs = {
    count: jest.fn(() => Promise.resolve(options.configItems ?? 2)),
    findMany: jest.fn(() => Promise.resolve([{ system: 'NVR' }])),
  };
  const integrations = {
    findMany: jest.fn(() =>
      Promise.resolve([
        {
          seq: 1,
          name: 'SSO',
          targetSystem: 'AD',
          contactId: null,
          contactName: 'คุณเอ',
          contactPhone: null,
          contactEmail: null,
        },
      ]),
    ),
  };
  const briefs = {
    findFirst: jest.fn(() => Promise.resolve(brief)),
    upsert: jest.fn((args: { create: { cautions: string } }) => {
      brief = {
        cautions: args.create.cautions,
        updatedAt: new Date(),
        createdBy: 'u-eng',
        updatedBy: null,
      };
      return Promise.resolve({});
    }),
  };
  const people = { findMany: jest.fn(() => Promise.resolve([])) };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new TechPackageService(
    deliveries as never,
    projects as never,
    asBuilt as never,
    configs as never,
    integrations as never,
    briefs as never,
    people as never,
    audit as never,
  );
  return { service, briefs };
}

describe('CD-227 the technical package — service', () => {
  it('without cautions the handover cannot be sent; with them the snapshot is kept', async () => {
    const empty = harness();
    await expect(empty.service.snapshotFor('p-1', 'osd')).rejects.toMatchObject(
      {
        code: 'VALIDATION_FAILED',
      },
    );
    const ready = harness({ cautions: 'ระวังสาย fiber ใต้ฝ้า' });
    await expect(ready.service.snapshotFor('p-1', 'osd')).resolves.toEqual({
      configItems: 2,
      systems: ['NVR'],
      integrations: ['I-1 SSO → AD'],
      cautions: 'ระวังสาย fiber ใต้ฝ้า',
    });
  });

  it('no configuration recorded is a gap', async () => {
    const h = harness({ cautions: 'x', configItems: 0 });
    const view = await h.service.view(actor, 'p-1');
    expect(view.gaps).toEqual(['ยังไม่ได้บันทึกค่าตั้งค่าระบบ']);
  });

  it('the project team writes the cautions; someone outside it cannot', async () => {
    await expect(
      harness().service.saveCautions(actor, 'p-1', 'ระวัง'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const h = harness({ member: true });
    const view = await h.service.saveCautions(actor, 'p-1', '  ระวังสาย  ');
    const saved = h.briefs.upsert.mock.calls[0][0];
    expect(saved.create.cautions).toBe('ระวังสาย');
    expect(view).toMatchObject({ complete: true, canWrite: true });
    await expect(
      h.service.saveCautions(actor, 'p-1', ' '),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
