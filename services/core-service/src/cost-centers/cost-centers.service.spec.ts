import type { Principal } from '@request-management/share';
import { FormOptionSources } from '../requests/form-option-sources';
import { CostCentersService } from './cost-centers.service';

const actor = { userId: 'u-admin', activeCompanyId: 'osd' } as unknown as Principal;

function build(rows: { id: string; companyId: string; code: string; active: boolean }[]) {
  const repo = {
    findFirst: jest.fn(async ({ where }) =>
      rows.find(
        (r) =>
          r.companyId === where.companyId &&
          (where.id === undefined || r.id === where.id) &&
          (where.code === undefined || r.code === where.code),
      ) ?? null,
    ),
    findMany: jest.fn(async ({ where }) =>
      rows.filter(
        (r) => r.companyId === where.companyId && r.active === where.active && where.code.in.includes(r.code),
      ),
    ),
    create: jest.fn(async ({ data }) => ({ id: 'new', ...data })),
    update: jest.fn(async ({ data }) => ({ id: 'cc1', ...data })),
  };
  const audit = { record: jest.fn() };
  const transactions = { execute: jest.fn((fn: (p: unknown) => unknown) => fn({})) };
  const sources = new FormOptionSources();
  // The constructor's types are the Nest providers; the spec hands in the parts it uses.
  const service = new CostCentersService(repo as never, sources, audit as never, transactions as never);
  service.onModuleInit();
  return { service, repo, audit, sources };
}

const ROWS = [
  { id: 'cc1', companyId: 'osd', code: '2002', active: true },
  { id: 'cc2', companyId: 'osd', code: '9999', active: false },
  { id: 'cc3', companyId: 'other', code: '3001', active: true },
];

describe('Cost Center master', () => {
  it('refuses a second Cost Center with the same code in the company', async () => {
    const { service } = build(ROWS);
    await expect(service.create(actor, { code: '2002', name: 'ซ้ำ' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('answers 404 for a Cost Center of another company (SCOPE-03)', async () => {
    const { service } = build(ROWS);
    await expect(service.update(actor, 'cc3', { name: 'x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('writes the audit entry inside the same transaction as the change', async () => {
    const { service, audit } = build(ROWS);
    await service.create(actor, { code: '2003', name: 'ขาย' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'cost_center.created', resourceType: 'cost_center' }),
      { prisma: {} },
    );
  });

  it('treats an inactive or foreign code as unknown, and reads "code - name" by its code', async () => {
    const { service } = build(ROWS);
    expect(await service.unknownCodes('osd', ['2002 - การตลาด', '9999', '3001'])).toEqual(['9999', '3001']);
  });

  it('makes a submit with a deactivated Cost Center fail through the option source', async () => {
    const { sources } = build(ROWS);
    const schema = {
      type: 'object',
      properties: { cost_center: { type: 'string', 'x-options-source': 'cost_centers' } },
    };
    await expect(sources.assertValid('osd', schema, { cost_center: '9999' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(sources.assertValid('osd', schema, { cost_center: '2002' })).resolves.toBeUndefined();
  });
});
