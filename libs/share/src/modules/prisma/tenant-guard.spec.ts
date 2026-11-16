import { PrismaService } from './prisma.service';
import {
  COMPANY_SCOPED_MODELS,
  lacksCompanyScope,
  tenantGuardMode,
} from './tenant-guard';

describe('H3 tenant guard — which calls forget the company', () => {
  it('knows the company-owned tables from the schema', () => {
    expect(COMPANY_SCOPED_MODELS.has('Request')).toBe(true);
    expect(COMPANY_SCOPED_MODELS.has('User')).toBe(false);
  });

  it.each([
    ['Request', 'findMany', {}, true],
    ['Request', 'findMany', { where: { status: 'draft' } }, true],
    ['Request', 'count', { where: { companyId: 'osd' } }, false],
    ['Request', 'findMany', { where: { AND: [{ companyId: 'osd' }] } }, false],
    ['RequestComment', 'findMany', { where: { request: { companyId: 'osd' } } }, false],
    ['Request', 'findUnique', { where: { id: 'r-1' } }, false],
    ['Request', 'create', { data: {} }, false],
    // ระดับระบบที่ตั้งใจข้ามบริษัท: key มีอยู่ ค่า undefined (14 พ.ย. 2569)
    ['Integration', 'findFirst', { where: { id: 'i-1', companyId: undefined } }, false],
    ['Integration', 'findFirst', { where: { id: 'i-1' } }, true],
    ['User', 'findMany', {}, false],
  ])('%s.%s %j → %s', (model, operation, args, expected) => {
    expect(lacksCompanyScope(model, operation, args)).toBe(expected);
  });

  it('defaults to log; only off and throw switch it', () => {
    expect(tenantGuardMode(undefined)).toBe('log');
    expect(tenantGuardMode('throw')).toBe('throw');
    expect(tenantGuardMode('off')).toBe('off');
    expect(tenantGuardMode('yes')).toBe('log');
  });
});

describe('H3 tenant guard — wired into the injected client', () => {
  const previous = process.env.TENANT_GUARD;
  afterAll(() => {
    process.env.TENANT_GUARD = previous;
  });

  it('throw mode refuses an unscoped read before it reaches the database', async () => {
    process.env.TENANT_GUARD = 'throw';
    const prisma = new PrismaService();

    await expect(prisma.request.findMany({ where: {} })).rejects.toThrow(
      'TenantGuard: Request.findMany without companyId',
    );
    expect(typeof prisma.onModuleInit).toBe('function');
    expect(typeof prisma.$transaction).toBe('function');
  });
});
