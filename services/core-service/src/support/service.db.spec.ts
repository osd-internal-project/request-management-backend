import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { Principal } from '@request-management/share';
import { ContractTermsRepository } from '../crm/contract-terms.service';
import { CustomerContractRepository } from '../crm/contract.repositories';
import { CustomerRepository } from '../crm/customer.repository';
import { RequestRepository } from '../requests/request.repository';
import { SlaService } from '../sla/sla.service';
import { EntitlementsService } from './entitlements.service';
import {
  ServiceAssetRepository,
  ServiceEntitlementAssetRepository,
  ServiceEntitlementRepository,
  ServiceWorkOrderRepository,
} from './support.repositories';
import { WorkOrdersService } from './work-orders.service';

const DB_URL = process.env.CORE_DB_TEST_URL;

(DB_URL ? describe : describe.skip)(
  'CD-239 service work orders (real Postgres)',
  () => {
    let prisma: PrismaClient;
    let companyId: string;
    let staff: string;
    let customerId: string;
    let assetId: string;
    let entitlementId: string;
    let typeId: string;
    let typeCode: string;
    const tag = randomUUID().slice(0, 6).toUpperCase();
    const requestIds: string[] = [];

    beforeAll(async () => {
      prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
      const company = await prisma.company.findFirstOrThrow({
        select: { id: true },
      });
      companyId = company.id;
      const user = await prisma.user.findFirstOrThrow({
        where: { username: { not: { startsWith: 't175-' } } },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      staff = user.id;
      const type = await prisma.requestType.findFirstOrThrow({
        select: { id: true, code: true },
      });
      typeId = type.id;
      typeCode = type.code;
      const customer = await prisma.customer.create({
        data: {
          companyId,
          customerCode: `CUS-T239-${tag}`,
          nameTh: `ทดสอบใบสั่งงาน ${tag}`,
          normalizedName: `ทดสอบใบสั่งงาน ${tag}`,
          status: 'active',
          type: 'corporate',
        },
      });
      customerId = customer.id;
      const asset = await prisma.serviceAsset.create({
        data: {
          companyId,
          customerId,
          kind: 'equipment',
          source: 'manual',
          name: 'กล้อง IP',
          serialNo: `T239-${tag}`,
          location: 'ชั้น 2',
          createdBy: staff,
        },
      });
      assetId = asset.id;
      // a cover running today, one corrective visit
      const today = new Date().toISOString().slice(0, 10);
      const entitlement = await prisma.serviceEntitlement.create({
        data: {
          companyId,
          customerId,
          kind: 'service_contract',
          title: `MA ${tag}`,
          startOn: new Date('2026-01-01T00:00:00Z'),
          endOn: new Date(`${Number(today.slice(0, 4)) + 1}-12-31T00:00:00Z`),
          coverage: 'H24X7',
          // CD-240 — high: 1 h to respond, 6 h to fix
          severityTargets: {
            critical: { responseHours: 0.5, resolutionHours: 2 },
            high: { responseHours: 1, resolutionHours: 6 },
            medium: { responseHours: 4, resolutionHours: 24 },
            low: { responseHours: 8, resolutionHours: 48 },
          },
          correctiveQuota: 1,
          preventiveQuota: null,
          createdBy: staff,
          assets: { create: { assetId, addedBy: staff } },
        },
      });
      entitlementId = entitlement.id;
    });

    afterAll(async () => {
      await prisma.serviceWorkOrder.deleteMany({
        where: { requestId: { in: requestIds } },
      });
      await prisma.slaClock.deleteMany({
        where: { requestId: { in: requestIds } },
      });
      await prisma.request.deleteMany({ where: { id: { in: requestIds } } });
      await prisma.serviceEntitlementAsset.deleteMany({
        where: { entitlementId },
      });
      await prisma.serviceEntitlement.deleteMany({
        where: { id: entitlementId },
      });
      await prisma.serviceAsset.deleteMany({ where: { id: assetId } });
      await prisma.customer.deleteMany({ where: { id: customerId } });
      await prisma.$disconnect();
    });

    it('CD-239: a job raised as a case — suggested from the cover, confirmed, a billed one agreed by the customer, held at start and close, the visit given back on cancel', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const guards = new Map<string, (r: { id: string }) => Promise<void>>();
      let cancelled: ((event: { payload: unknown }) => Promise<void>) | null =
        null;
      // the request engine stood in: real rows, the guards it would run
      const requests = {
        addGuard: (action: string, fn: (r: { id: string }) => Promise<void>) =>
          guards.set(action, fn),
        create: async (dto: { form_data: Record<string, string> }) => {
          const row = await prisma.request.create({
            data: {
              requestTypeId: typeId,
              typeCode,
              companyId,
              requesterId: staff,
              status: 'draft',
              severity: 'high',
              formData: dto.form_data,
            },
          });
          requestIds.push(row.id);
          return row;
        },
        submit: (id: string) =>
          prisma.request.update({
            where: { id },
            data: { status: 'submitted' },
          }),
      };
      const entitlements = new EntitlementsService(
        new ServiceEntitlementRepository(client),
        new ServiceEntitlementAssetRepository(client),
        new ServiceAssetRepository(client),
        new CustomerContractRepository(client),
        new ContractTermsRepository(client),
        new CustomerRepository(client),
        audit,
        transactions,
      );
      const orders = new WorkOrdersService(
        new ServiceWorkOrderRepository(client),
        new ServiceAssetRepository(client),
        new ServiceEntitlementRepository(client),
        new CustomerRepository(client),
        {
          findFirst: () =>
            Promise.resolve({ serviceWorkOrderTypeCode: typeCode }),
        } as never,
        new RequestRepository(client),
        requests as never,
        entitlements,
        {
          on: (
            _name: string,
            handler: (event: { payload: unknown }) => Promise<void>,
          ) => {
            cancelled = handler;
          },
        } as never,
        audit,
        transactions,
        new SlaService(prisma as never),
      );
      orders.onModuleInit();
      const manager = {
        userId: staff,
        activeCompanyId: companyId,
        permissions: ['service.asset.read', 'service.asset.manage'],
      } as unknown as Principal;
      const used = async () =>
        (
          await prisma.serviceEntitlement.findUniqueOrThrow({
            where: { id: entitlementId },
          })
        ).correctiveUsed;

      // the first call: covered, one visit left — suggested in contract
      const first = await orders.open(
        manager,
        {
          customer_id: customerId,
          asset_id: assetId,
          work_kind: 'corrective',
          severity: 'high',
          subject: 'กล้องภาพไม่ขึ้น',
        },
        'Bearer x',
      );
      expect(first).toMatchObject({
        suggestedBilling: 'in_contract',
        suggestedEntitlement: { id: entitlementId },
        billing: null,
        request: { status: 'submitted', subject: 'กล้องภาพไม่ขึ้น' },
      });
      // CD-240 — a clock running on the type's 48 h moves to the cover's 6 h
      const startedAt = new Date();
      await prisma.slaClock.create({
        data: {
          requestId: first.requestId,
          startedAt,
          dueAt: new Date(startedAt.getTime() + 48 * 3_600_000),
          state: 'running',
        },
      });
      // not started before it is decided
      await expect(
        guards.get('receive')!({ id: first.requestId }),
      ).rejects.toThrow('ยังไม่ได้ยืนยัน');
      await orders.confirm(manager, first.id, { billing: 'in_contract' });
      expect(await used()).toBe(1);
      const clock = await prisma.slaClock.findUniqueOrThrow({
        where: { requestId: first.requestId },
      });
      const left = clock.dueAt.getTime() - Date.now();
      expect(left).toBeGreaterThan(5.9 * 3_600_000);
      expect(left).toBeLessThanOrEqual(6 * 3_600_000);
      await guards.get('receive')!({ id: first.requestId });

      // the second: the visit is used — suggested billed
      const second = await orders.open(
        manager,
        {
          customer_id: customerId,
          asset_id: assetId,
          work_kind: 'corrective',
          severity: 'medium',
          subject: 'ขอย้ายจุดกล้อง',
        },
        'Bearer x',
      );
      expect(second).toMatchObject({ suggestedBilling: 'billable' });
      expect(second.suggestionNote).toContain('หมดแล้ว');
      await expect(
        orders.confirm(manager, second.id, { billing: 'in_contract' }),
      ).rejects.toThrow('ต้องระบุเหตุผล');
      await orders.confirm(manager, second.id, { billing: 'billable' });
      // billed: the customer agrees before work starts
      await expect(
        guards.get('receive')!({ id: second.requestId }),
      ).rejects.toThrow('ลูกค้ารับทราบค่าใช้จ่าย');
      const acked = await orders.acknowledge(manager, second.id, {
        name: 'คุณวิภา (ฝ่ายอาคาร)',
        on: new Date().toISOString().slice(0, 10),
        estimate: 3500,
      });
      expect(acked.ack).toMatchObject({ estimate: 3500 });
      await guards.get('receive')!({ id: second.requestId });

      // closed with its cause and fix — the service team or the assignee
      await expect(
        guards.get('complete')!({ id: second.requestId }),
      ).rejects.toThrow('สาเหตุและวิธีแก้');
      await expect(
        orders.outcome(
          { ...manager, userId: randomUUID(), permissions: [] },
          second.id,
          { cause: 'x' },
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await orders.outcome(manager, second.id, {
        cause: 'ลูกค้าต้องการเปลี่ยนมุม',
        resolution: 'ย้ายขายึดและตั้งค่ามุมใหม่',
      });
      await guards.get('complete')!({ id: second.requestId });

      // the first case cancelled: its visit goes back
      await cancelled!({ payload: { request_id: first.requestId } });
      expect(await used()).toBe(0);

      // a case raised elsewhere (LINE) made a service job
      const line = await prisma.request.create({
        data: {
          requestTypeId: typeId,
          typeCode,
          companyId,
          requesterId: staff,
          status: 'submitted',
          refType: 'customer',
          refId: `CUS-T239-${tag}`,
          formData: { subject: 'แจ้งผ่าน LINE' },
        },
      });
      requestIds.push(line.id);
      const attached = await orders.attach(manager, line.id, {
        asset_id: assetId,
        work_kind: 'preventive',
      });
      expect(attached).toMatchObject({
        customer: { id: customerId },
        suggestedBilling: 'in_contract',
      });
      await expect(
        orders.attach(manager, line.id, { work_kind: 'preventive' }),
      ).rejects.toThrow('เป็นใบสั่งงานบริการแล้ว');

      const open = await orders.list(manager, { customer_id: customerId });
      expect(open).toHaveLength(3);
      expect(await orders.ofRequest(manager, line.id)).toMatchObject({
        id: attached.id,
      });
    });
  },
);
