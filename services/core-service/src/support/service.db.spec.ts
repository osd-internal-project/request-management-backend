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
  ServiceBillingRepository,
  ServiceCalendarRepository,
  ServiceClaimRepository,
  ServiceEntitlementRepository,
  ServiceLabourRateRepository,
  ServiceMaterialUseRepository,
  ServiceMaOfferRepository,
  ServicePmPlanRepository,
  ServicePmRoundRepository,
  ServiceWorkTypeRepository,
  ServiceOnCallDispatchRepository,
  ServiceOnCallShiftRepository,
  ServiceWorkOrderRepository,
} from './support.repositories';
import { WorkOrdersService } from './work-orders.service';
import { OnCallService } from './on-call.service';
import { ClaimsService } from './claims.service';
import { SpareIssueErpSyncService } from './spare-issue-erp-sync.service';
import { TimeMaterialsService } from './time-materials.service';
import { PmPlanService } from './pm-plan.service';
import { TimesheetsService } from '../hr/timesheets.service';
import { HrTimesheetRepository } from '../hr/hr.repositories';
import { ProductRepository } from '../crm/product.repositories';
import { ServiceBillingService } from './service-billing.service';
import { ServiceBillingErpSyncService } from './service-billing-erp-sync.service';
import { MockSapClient } from '../erp/mock-sap.client';
import { CustomerExternalCodeRepository } from '../crm/customer-child.repositories';
import { IntegrationSyncJobRepository } from '../crm/integration-job.repository';
import { CompanyRepository } from '../crm/product.repositories';
import { CompanyMemberRepository } from '../access/company-member.repository';

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
    const shiftIds: string[] = [];
    const userIds: string[] = [];
    const workTypeIds: string[] = [];
    const extraEntitlements: string[] = [];
    const startedAt = new Date();

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
      await prisma.serviceBilling.deleteMany({
        where: { requestId: { in: requestIds } },
      });
      await prisma.serviceClaim.deleteMany({
        where: { companyId, createdAt: { gte: startedAt } },
      });
      await prisma.serviceAssetHistory.deleteMany({ where: { assetId } });
      await prisma.serviceMaterialUse.deleteMany({
        where: { requestId: { in: requestIds } },
      });
      await prisma.hrTimesheet.deleteMany({
        where: {
          companyId,
          userId: staff,
          weekStart: { gte: new Date('2031-01-01') },
        },
      });
      await prisma.serviceLabourRate.deleteMany({
        where: { companyId, workTypeId: { in: workTypeIds } },
      });
      await prisma.hrWorkType.deleteMany({
        where: { id: { in: workTypeIds } },
      });
      await prisma.customerExternalCode.deleteMany({ where: { customerId } });
      await prisma.servicePmRound.deleteMany({
        where: { entitlementId: { in: [entitlementId, ...extraEntitlements] } },
      });
      await prisma.servicePmPlan.deleteMany({
        where: { entitlementId: { in: [entitlementId, ...extraEntitlements] } },
      });
      await prisma.serviceMaOffer.deleteMany({
        where: { openedAt: { gte: startedAt } },
      });
      await prisma.serviceWorkOrder.deleteMany({
        where: { requestId: { in: requestIds } },
      });
      await prisma.serviceOnCallDispatch.deleteMany({
        where: { requestId: { in: requestIds } },
      });
      await prisma.serviceOnCallShift.deleteMany({
        where: { id: { in: shiftIds } },
      });
      await prisma.requestEvent.deleteMany({
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
        where: { id: { in: [entitlementId, ...extraEntitlements] } },
      });
      await prisma.serviceAsset.deleteMany({ where: { id: assetId } });
      await prisma.customer.deleteMany({ where: { id: customerId } });
      await prisma.userCompany.deleteMany({
        where: { userId: { in: userIds } },
      });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
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
        { dispatch: () => Promise.resolve(null) } as never,
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

    it('CD-241: an out-of-hours case goes to whoever is on call — the backup when the primary is on leave, or has not received it in time', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      // two people of the company to put on the rota
      const [primary, backup] = await Promise.all(
        ['a', 'b'].map(async (suffix) => {
          const user = await prisma.user.create({
            data: {
              keycloakId: `t241-${tag}-${suffix}`,
              username: `t241-${tag}-${suffix}`,
              displayName: `เวรทดสอบ ${suffix.toUpperCase()}`,
              companies: { create: { companyId } },
            },
          });
          userIds.push(user.id);
          return user.id;
        }),
      );
      const told: { userId: string; reason: string }[] = [];
      let away = new Set<string>();
      const onCall = new OnCallService(
        new ServiceOnCallShiftRepository(client),
        new ServiceOnCallDispatchRepository(client),
        {
          findFirst: () =>
            Promise.resolve({ serviceOnCallEscalateMinutes: 30 }),
        } as never,
        new RequestRepository(client),
        {
          holding: (_c: string, ids: string[]) =>
            Promise.resolve(
              new Map(ids.filter((id) => away.has(id)).map((id) => [id, [{}]])),
            ),
        } as never,
        {
          onCallDispatched: (
            userId: string,
            _c: string,
            x: { reason: string },
          ) => {
            told.push({ userId, reason: x.reason });
            return Promise.resolve();
          },
        } as never,
        new ServiceCalendarRepository(client),
        new CompanyMemberRepository(client),
        { record: () => Promise.resolve() } as never,
        transactions,
        { get: () => 0 } as never,
      );
      const manager = {
        userId: staff,
        activeCompanyId: companyId,
        permissions: ['service.asset.read', 'service.asset.manage'],
      } as unknown as Principal;
      // far ahead, so no rota of the database's own is in the way
      const shift = await onCall.create(manager, {
        start_on: '2031-03-08',
        end_on: '2031-03-09',
        primary_user_id: primary,
        backup_user_id: backup,
      });
      shiftIds.push(shift.id);
      await expect(
        onCall.create(manager, {
          start_on: '2031-03-09',
          end_on: '2031-03-12',
          primary_user_id: backup,
        }),
      ).rejects.toThrow('ทับกับเวร');

      const raise = async () => {
        const row = await prisma.request.create({
          data: {
            requestTypeId: typeId,
            typeCode,
            companyId,
            requesterId: staff,
            receiverUserId: staff,
            status: 'submitted',
            severity: 'high',
            formData: { subject: 'ระบบล่มกลางดึก' },
          },
        });
        requestIds.push(row.id);
        return row.id;
      };
      // Saturday 8 Mar 2031, 03:00 Bangkok
      const night = new Date('2031-03-07T20:00:00Z');
      const first = await raise();
      const sent = await onCall.dispatch(first, night);
      expect(sent).toMatchObject({ userId: primary, level: 'primary' });
      expect(
        (await prisma.request.findUniqueOrThrow({ where: { id: first } }))
          .receiverUserId,
      ).toBe(primary);
      expect(told).toEqual([
        { userId: primary, reason: 'แจ้งนอกเวลาทำการ — คุณเป็นเวรหลัก' },
      ]);
      expect(await onCall.dispatch(first, night)).toBeNull();
      expect(
        await prisma.requestEvent.count({
          where: { requestId: first, type: 'service.oncall.dispatched' },
        }),
      ).toBe(1);

      // 10 minutes on: still the primary's
      const later = (minutes: number) =>
        new Date(night.getTime() + minutes * 60_000);
      expect((await onCall.sweep(later(10))).handed).toBe(0);
      // 30 minutes and not received: to the backup
      expect((await onCall.sweep(later(31))).handed).toBe(1);
      expect(
        (await prisma.request.findUniqueOrThrow({ where: { id: first } }))
          .receiverUserId,
      ).toBe(backup);
      expect(told[1].userId).toBe(backup);
      expect(told[1].reason).toContain('ภายใน 30 นาที');
      expect(await onCall.ofRequest(manager, first)).toMatchObject({
        userId: backup,
        level: 'backup',
        watching: false,
      });

      // the primary on leave: straight to the backup, nobody further
      away = new Set([primary]);
      const second = await raise();
      expect(await onCall.dispatch(second, later(40))).toMatchObject({
        userId: backup,
        level: 'backup',
      });

      // received before the minutes run out: left alone
      away = new Set();
      const third = await raise();
      await onCall.dispatch(third, later(50));
      await prisma.request.update({
        where: { id: third },
        data: { status: 'in_progress' },
      });
      await onCall.sweep(later(120));
      expect(
        (await prisma.request.findUniqueOrThrow({ where: { id: third } }))
          .receiverUserId,
      ).toBe(primary);

      // Monday 10:00 Bangkok, in hours: not the rota's
      const fourth = await raise();
      expect(
        await onCall.dispatch(fourth, new Date('2031-03-10T03:00:00Z')),
      ).toBeNull();
    });

    it('CD-242: a billed job done — its charge from the agreed estimate, edited, sent to SAP as a draft invoice, read back, withdrawn', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const erp = new MockSapClient();
      const sync = new ServiceBillingErpSyncService(
        new ServiceBillingRepository(client),
        new CustomerExternalCodeRepository(client),
        new CustomerRepository(client),
        new CompanyRepository(client),
        new IntegrationSyncJobRepository(client),
        erp,
        { queueCustomer: () => Promise.resolve() } as never,
        { register: () => undefined } as never,
        audit,
        { get: () => 0 } as never,
      );
      const kicked: string[] = [];
      const billings = new ServiceBillingService(
        new ServiceBillingRepository(client),
        new ServiceWorkOrderRepository(client),
        new RequestRepository(client),
        new CustomerRepository(client),
        new CompanyMemberRepository(client),
        {
          kickCreate: (id: string) => kicked.push(`create:${id}`),
          kickCancel: (id: string) => kicked.push(`cancel:${id}`),
          refresh: (id: string) => sync.refresh(id),
        } as never,
        { assertCodes: () => Promise.resolve() } as never,
        { chargeLines: () => Promise.resolve([]) } as never,
        audit,
        transactions,
      );
      const manager = {
        userId: staff,
        activeCompanyId: companyId,
        permissions: ['service.asset.read', 'service.asset.manage'],
      } as unknown as Principal;

      const job = async (status: string, billing: string | null) => {
        const request = await prisma.request.create({
          data: {
            requestTypeId: typeId,
            typeCode,
            companyId,
            requesterId: staff,
            requestNo: `REQ-T242-${tag}-${requestIds.length}`,
            status: status as never,
            severity: 'medium',
            formData: { subject: 'ย้ายจุดกล้อง' },
          },
        });
        requestIds.push(request.id);
        return prisma.serviceWorkOrder.create({
          data: {
            companyId,
            requestId: request.id,
            customerId,
            assetId,
            workKind: 'corrective',
            suggestedBilling: 'billable',
            billing,
            ackName: 'คุณวิภา',
            ackOn: new Date(),
            ackEstimate: 3500,
            createdBy: staff,
          },
        });
      };

      // in contract, or not done yet: nothing to bill
      const covered = await job('completed', 'in_contract');
      await expect(billings.prepare(manager, covered.id)).rejects.toThrow(
        'เก็บเงินเพิ่ม',
      );
      const running = await job('in_progress', 'billable');
      await expect(billings.prepare(manager, running.id)).rejects.toThrow(
        'งานเสร็จ',
      );

      const done = await job('completed', 'billable');
      const draft = await billings.prepare(manager, done.id);
      expect(draft).toMatchObject({
        status: 'draft',
        netTotal: 3500,
        reference: expect.stringMatching(/^SVB-REQ-T242-/) as unknown,
        lines: [
          {
            description: 'ค่าบริการ ย้ายจุดกล้อง',
            unitPrice: 3500,
            source: 'estimate',
          },
        ],
        erp: { status: 'none' },
      });
      await expect(billings.prepare(manager, done.id)).rejects.toThrow(
        'มีใบเรียกเก็บแล้ว',
      );

      // the team adds the bracket and drops the price a little
      const saved = await billings.save(manager, draft.id, {
        lines: [
          {
            description: 'ค่าบริการ ย้ายจุดกล้อง',
            quantity: 1,
            unit_price: 3500,
            discount_pct: 10,
          },
          {
            product_code: 'BRK-01',
            description: 'ขายึดกล้อง',
            quantity: 2,
            unit: 'ชิ้น',
            unit_price: 450,
          },
        ],
        note: 'ลดค่าบริการ 10%',
      });
      expect(saved.netTotal).toBe(4050);
      expect(saved.lines.map((line) => line.source)).toEqual([
        'estimate',
        'manual',
      ]);

      // no BP yet: confirmed, but SAP waits for the customer
      await billings.confirm(manager, draft.id);
      expect(kicked).toEqual([`create:${draft.id}`]);
      await expect(
        billings.save(manager, draft.id, { lines: [] }),
      ).rejects.toThrow('ยังไม่ยืนยันส่ง');
      await expect(sync.pushBilling(draft.id)).rejects.toThrow('เลข BP');

      await prisma.customerExternalCode.create({
        data: { customerId, system: 'sap', externalCode: `BP-T242-${tag}` },
      });
      const draftNo = await sync.pushBilling(draft.id);
      expect(draftNo).toMatch(/^MOCK-DR-/);
      expect(await sync.pushBilling(draft.id)).toBe(draftNo);
      const sent = await billings.refresh(manager, draft.id);
      expect(sent.erp).toMatchObject({
        status: 'synced',
        draftNo,
        invoiceStatus: 'draft',
      });

      // withdrawn before finance posts it: the draft is deleted in SAP
      await billings.cancel(manager, draft.id, { reason: 'ลูกค้าขอรวมบิล' });
      expect(kicked[1]).toBe(`cancel:${draft.id}`);
      await sync.cancelBilling(draft.id);
      const gone = await billings.detail(manager, draft.id);
      expect(gone).toMatchObject({
        status: 'cancelled',
        cancelReason: 'ลูกค้าขอรวมบิล',
        erp: { invoiceStatus: 'missing' },
      });
      expect(
        (await erp.invoiceDraftState({ companyCode: 'X' }, gone.reference))
          .status,
      ).toBe('missing');
      expect(await billings.list(manager, { status: 'cancelled' })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: draft.id }) as unknown,
        ]),
      );
    });

    it('CD-243: a job time from timesheets and materials from SAP items become its charge — at the selling rate, with its cost and margin for those who may see cost', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const workType = await prisma.hrWorkType.create({
        data: { companyId, code: `T243-${tag}`, name: 'ซ่อมหน้างาน' },
      });
      workTypeIds.push(workType.id);
      const request = await prisma.request.create({
        data: {
          requestTypeId: typeId,
          typeCode,
          companyId,
          requesterId: staff,
          requestNo: `REQ-T243-${tag}`,
          status: 'completed',
          severity: 'medium',
          formData: { subject: 'กล้องดับ' },
        },
      });
      requestIds.push(request.id);
      const order = await prisma.serviceWorkOrder.create({
        data: {
          companyId,
          requestId: request.id,
          customerId,
          assetId,
          workKind: 'corrective',
          suggestedBilling: 'billable',
          billing: 'billable',
          ackEstimate: 5000,
          createdBy: staff,
        },
      });
      // 3 h billable + 1 h not, approved; 2 h still waiting
      const sheet = async (
        weekStart: string,
        status: string,
        lines: { hours: number; billable: boolean }[],
      ) =>
        prisma.hrTimesheet.create({
          data: {
            companyId,
            userId: staff,
            weekStart: new Date(`${weekStart}T00:00:00Z`),
            status,
            lines: {
              create: lines.map((line) => ({
                workDate: new Date(`${weekStart}T00:00:00Z`),
                kind: 'service',
                requestId: request.id,
                workTypeId: workType.id,
                hours: line.hours,
                billable: line.billable,
              })),
            },
          },
        });
      await sheet('2031-03-03', 'approved', [
        { hours: 3, billable: true },
        { hours: 1, billable: false },
      ]);
      await sheet('2031-03-10', 'submitted', [{ hours: 2, billable: true }]);

      const timeMaterials = new TimeMaterialsService(
        new ServiceWorkOrderRepository(client),
        new ServiceMaterialUseRepository(client),
        new ServiceLabourRateRepository(client),
        new ServiceWorkTypeRepository(client),
        new ServiceBillingRepository(client),
        new RequestRepository(client),
        new ProductRepository(client),
        { assertCodes: () => Promise.resolve() } as never,
        {
          lookup: (_a: unknown, codes: string[]) =>
            Promise.resolve(
              codes[0] === 'BRK-01' ? { 'BRK-01': { unit_price: 450 } } : {},
            ),
        } as never,
        {
          lookup: () => Promise.resolve({ items: [{ unitCost: 300 }] }),
        } as never,
        new TimesheetsService(
          new HrTimesheetRepository(client),
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          audit,
          transactions,
        ),
        {
          forRequests: () =>
            Promise.resolve(
              new Map([[request.id, { cost: 1200, unpricedHours: 0 }]]),
            ),
        } as never,
        new CompanyMemberRepository(client),
        audit,
        transactions,
        new CompanyRepository(client),
        new MockSapClient(),
        { kick: () => undefined } as never,
      );
      const manager = {
        userId: staff,
        activeCompanyId: companyId,
        permissions: ['service.asset.read', 'service.asset.manage'],
      } as unknown as Principal;
      const finance = {
        ...manager,
        permissions: [...manager.permissions, 'hr.rate.read'],
      } as unknown as Principal;

      const rates = await timeMaterials.saveLabourRate(manager, {
        work_type_id: workType.id,
        hourly_rate: 800,
        product_code: 'SV-LAB',
      });
      expect(rates.find((row) => row.workTypeId === workType.id)).toMatchObject(
        {
          hourlyRate: 800,
          productCode: 'SV-LAB',
        },
      );
      await timeMaterials.addMaterial(manager, order.id, {
        product_code: 'BRK-01',
        description: 'ขายึดกล้อง',
        quantity: 2,
        serial_no: 'SN-77',
      });
      await timeMaterials.addMaterial(manager, order.id, {
        product_code: 'CAM-01',
        description: 'กล้องสำรอง (เปลี่ยนในประกัน)',
        quantity: 1,
        billable: false,
      });
      // not the service team, not the case's assignee
      await expect(
        timeMaterials.addMaterial(
          {
            ...manager,
            userId: randomUUID(),
            permissions: ['service.asset.read'],
          } as never,
          order.id,
          { product_code: 'BRK-01', quantity: 1 },
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      const seen = await timeMaterials.ofWorkOrder(finance, order.id);
      expect(seen.time).toMatchObject({ approved: 4, pending: 2, billable: 3 });
      expect(seen.materials).toEqual([
        expect.objectContaining({
          productCode: 'BRK-01',
          unitPrice: 450,
          priceSource: 'standard',
          unitCost: 300,
          billable: true,
        }) as unknown,
        expect.objectContaining({
          productCode: 'CAM-01',
          unitPrice: null,
          billable: false,
        }) as unknown,
      ]);
      expect(seen.charge.lines).toEqual([
        expect.objectContaining({
          description: 'ค่าแรง ซ่อมหน้างาน',
          quantity: 3,
          unitPrice: 800,
          productCode: 'SV-LAB',
        }) as unknown,
        expect.objectContaining({
          description: 'ขายึดกล้อง · S/N SN-77',
          quantity: 2,
          unitPrice: 450,
        }) as unknown,
      ]);
      expect(seen.costs).toMatchObject({
        labour: { cost: 1200 },
        materials: { cost: 900 },
      });
      // no hr.rate.read: no cost
      const plain = await timeMaterials.ofWorkOrder(manager, order.id);
      expect(plain.costs).toBeNull();
      expect(plain.materials[0].unitCost).toBeNull();

      // the charge starts from the actual, not the estimate
      const billings = new ServiceBillingService(
        new ServiceBillingRepository(client),
        new ServiceWorkOrderRepository(client),
        new RequestRepository(client),
        new CustomerRepository(client),
        new CompanyMemberRepository(client),
        { kickCreate: () => undefined, kickCancel: () => undefined } as never,
        { assertCodes: () => Promise.resolve() } as never,
        timeMaterials,
        audit,
        transactions,
      );
      const draft = await billings.prepare(manager, order.id);
      expect(draft.netTotal).toBe(3300);
      expect(draft.lines.map((line) => line.source)).toEqual([
        'labour',
        'material',
      ]);
      // a typed line stays when time and materials are pulled again
      await billings.save(manager, draft.id, {
        lines: [
          ...draft.lines.map((line) => ({
            product_code: line.productCode,
            description: line.description,
            quantity: line.quantity,
            unit_price: line.unitPrice,
          })),
          { description: 'ค่าเดินทาง', quantity: 1, unit_price: 300 },
        ],
      });
      await timeMaterials.addMaterial(manager, order.id, {
        product_code: 'BRK-01',
        description: 'ขายึดกล้อง',
        quantity: 1,
        unit_price: 500,
      });
      const pulled = await billings.pull(manager, draft.id);
      expect(pulled.lines.map((line) => [line.source, line.lineTotal])).toEqual(
        [
          ['manual', 300],
          ['labour', 2400],
          ['material', 900],
          ['material', 500],
        ],
      );
      expect(pulled.netTotal).toBe(4100);

      // sent: the materials are locked
      await billings.confirm(manager, draft.id);
      await expect(
        timeMaterials.addMaterial(manager, order.id, {
          product_code: 'BRK-01',
          quantity: 1,
        }),
      ).rejects.toThrow('ส่งใบเรียกเก็บ');
    });

    it('CD-244: a service contract plans its PM rounds — each opened ahead as a contract visit under the plan owner, done with its case, told once when late; a cover with no contract gets a service-contract offer before it ends', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      // the request engine stood in, as in CD-239
      const requests = {
        addGuard: () => undefined,
        create: async (dto: { form_data: Record<string, string> }) => {
          const row = await prisma.request.create({
            data: {
              requestTypeId: typeId,
              typeCode,
              companyId,
              requesterId: staff,
              status: 'draft',
              severity: 'low',
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
      const workOrders = new WorkOrdersService(
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
        { on: () => undefined } as never,
        audit,
        transactions,
        new SlaService(prisma as never),
        { dispatch: () => Promise.resolve(null) } as never,
      );
      const told: string[] = [];
      const deals: string[] = [];
      const standard = {
        enabled: true,
        params: { open_days: 90, remind_days: [60, 30] },
      };
      const pm = new PmPlanService(
        new ServicePmPlanRepository(client),
        new ServicePmRoundRepository(client),
        new ServiceMaOfferRepository(client),
        new ServiceEntitlementRepository(client),
        new ServiceEntitlementAssetRepository(client),
        new RequestRepository(client),
        new CustomerRepository(client),
        {
          findFirst: () =>
            Promise.resolve({
              id: 'opp-t244',
              opportunityCode: 'OPP-T244',
              ownerUserId: staff,
            }),
        } as never,
        new CompanyMemberRepository(client),
        workOrders,
        {
          createRenewal: (input: { title: string }) => {
            deals.push(input.title);
            return Promise.resolve({
              id: 'opp-t244',
              opportunityCode: 'OPP-T244',
            });
          },
        } as never,
        {
          across: () =>
            Promise.resolve({
              standard,
              byCompany: new Map(),
              of: () => standard,
            }),
        } as never,
        {
          pmRound: (
            _u: string,
            _c: string,
            x: { kind: string; roundNo: number },
          ) => {
            told.push(`pm.${x.kind}#${x.roundNo}`);
            return Promise.resolve();
          },
          maOffer: (_u: string, _c: string, x: { kind: string }) => {
            told.push(`ma.${x.kind}`);
            return Promise.resolve();
          },
        } as never,
        audit,
        transactions,
        { get: () => 0 } as never,
      );
      const manager = {
        userId: staff,
        activeCompanyId: companyId,
        permissions: ['service.asset.read', 'service.asset.manage'],
      } as unknown as Principal;

      // the contract cover from beforeAll: 1 Jan 2026 → 31 Dec next year
      const planned = await pm.savePlan(manager, entitlementId, {
        interval: 'quarterly',
        lead_days: 14,
        owner_user_id: staff,
      });
      expect(planned.plan).toMatchObject({
        interval: 'quarterly',
        leadDays: 14,
      });
      expect(planned.rounds[0]).toMatchObject({
        roundNo: 1,
        dueOn: '2026-04-01',
        status: 'planned',
      });

      // 20 Mar: round 1 (due 1 Apr) is within 14 days — opened, in contract
      const first = await pm.sweep(new Date('2026-03-20T03:00:00Z'));
      expect(first.opened).toBe(1);
      const round1 = (await pm.planOf(manager, entitlementId)).rounds[0];
      expect(round1).toMatchObject({
        status: 'opened',
        request: { status: 'submitted' },
      });
      const order = await prisma.serviceWorkOrder.findUniqueOrThrow({
        where: { id: round1.workOrderId! },
      });
      expect(order).toMatchObject({
        workKind: 'preventive',
        billing: 'in_contract',
        entitlementId,
      });
      expect(told).toContain('pm.opened#1');
      // not twice
      expect((await pm.sweep(new Date('2026-03-21T03:00:00Z'))).opened).toBe(0);

      // its case done → the round is done
      await prisma.request.update({
        where: { id: round1.requestId! },
        data: { status: 'completed' },
      });
      expect((await pm.sweep(new Date('2026-03-22T03:00:00Z'))).done).toBe(1);

      // round 2 (1 Jul) left undone past its day: told once
      await pm.sweep(new Date('2026-07-05T03:00:00Z'));
      await pm.sweep(new Date('2026-07-06T03:00:00Z'));
      expect(told.filter((one) => one === 'pm.overdue#2')).toHaveLength(1);

      // round 3 skipped, with why
      const round3 = (await pm.planOf(manager, entitlementId)).rounds[2];
      const skipped = await pm.skip(manager, round3.id, {
        reason: 'ลูกค้าปิดอาคารปรับปรุง',
      });
      expect(skipped).toMatchObject({
        status: 'skipped',
        skippedReason: 'ลูกค้าปิดอาคารปรับปรุง',
      });

      // a warranty ending in 80 days, no contract: offered once to the account owner
      await prisma.customer.update({
        where: { id: customerId },
        data: { accountOwnerUserId: staff },
      });
      const today = new Date().toISOString().slice(0, 10);
      const end = new Date(Date.parse(`${today}T00:00:00Z`) + 80 * 86_400_000);
      const warranty = await prisma.serviceEntitlement.create({
        data: {
          companyId,
          customerId,
          kind: 'warranty',
          title: `ประกัน ${tag}`,
          startOn: new Date('2026-01-01T00:00:00Z'),
          endOn: end,
          createdBy: staff,
        },
      });
      extraEntitlements.push(warranty.id);
      await pm.sweep(new Date());
      await pm.sweep(new Date());
      expect(
        deals.filter((title) => title.includes(`ประกัน ${tag}`)),
      ).toHaveLength(1);
      expect(
        told.filter((one) => one === 'ma.opened').length,
      ).toBeGreaterThanOrEqual(1);
      // 25 days on (55 left): the 60-day reminder while the deal is open
      const later = new Date(Date.now() + 25 * 86_400_000);
      await pm.sweep(later);
      expect(told).toContain('ma.due');

      // a warranty cannot carry a plan
      await expect(
        pm.savePlan(manager, warranty.id, {
          interval: 'monthly',
          owner_user_id: staff,
        }),
      ).rejects.toThrow('สัญญาบริการ');
    });

    it('CD-245: a spare out of stock becomes a goods issue in SAP and is locked; a unit swapped keeps the asset with a new serial and the faulty one goes on a claim, told once when late', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const erp = new MockSapClient();
      const request = await prisma.request.create({
        data: {
          requestTypeId: typeId,
          typeCode,
          companyId,
          requesterId: staff,
          requestNo: `REQ-T245-${tag}`,
          status: 'in_progress',
          severity: 'high',
          formData: { subject: 'กล้องเสีย' },
        },
      });
      requestIds.push(request.id);
      const order = await prisma.serviceWorkOrder.create({
        data: {
          companyId,
          requestId: request.id,
          customerId,
          assetId,
          workKind: 'corrective',
          suggestedBilling: 'in_contract',
          billing: 'in_contract',
          createdBy: staff,
        },
      });
      const sync = new SpareIssueErpSyncService(
        new ServiceMaterialUseRepository(client),
        new CompanyRepository(client),
        new IntegrationSyncJobRepository(client),
        erp,
        { register: () => undefined } as never,
        audit,
        { get: () => 0 } as never,
      );
      const kicked: string[] = [];
      const timeMaterials = new TimeMaterialsService(
        new ServiceWorkOrderRepository(client),
        new ServiceMaterialUseRepository(client),
        new ServiceLabourRateRepository(client),
        new ServiceWorkTypeRepository(client),
        new ServiceBillingRepository(client),
        new RequestRepository(client),
        new ProductRepository(client),
        { assertCodes: () => Promise.resolve() } as never,
        { lookup: () => Promise.resolve({}) } as never,
        { lookup: () => Promise.resolve({ items: [] }) } as never,
        { serviceTime: () => Promise.resolve([]) } as never,
        { forRequests: () => Promise.resolve(new Map()) } as never,
        new CompanyMemberRepository(client),
        audit,
        transactions,
        new CompanyRepository(client),
        erp,
        { kick: (id: string) => kicked.push(id) } as never,
      );
      const manager = {
        userId: staff,
        activeCompanyId: companyId,
        permissions: ['service.asset.read', 'service.asset.manage'],
      } as unknown as Principal;

      // on hand per warehouse, from SAP
      const stock = await timeMaterials.stock(manager, ['CAM-01']);
      expect(stock.map((row) => row.warehouseCode)).toEqual(['WH01', 'WH-SVC']);

      // out of stock needs a warehouse
      await expect(
        timeMaterials.addMaterial(manager, order.id, {
          product_code: 'CAM-01',
          quantity: 1,
          from_stock: true,
        }),
      ).rejects.toThrow('ระบุคลัง');
      const spare = await timeMaterials.addMaterial(manager, order.id, {
        product_code: 'CAM-01',
        description: 'กล้อง IP ตัวใหม่',
        quantity: 1,
        serial_no: `NEW-${tag}`,
        from_stock: true,
        warehouse_code: 'WH01',
      });
      expect(kicked).toEqual([spare.id]);
      const docNo = await sync.push(spare.id);
      expect(docNo).toMatch(/^MOCK-GI-/);
      expect(await sync.push(spare.id)).toBe(docNo);
      const seen = await timeMaterials.ofWorkOrder(manager, order.id);
      expect(seen.materials[0]).toMatchObject({
        fromStock: true,
        warehouseCode: 'WH01',
        erpStatus: 'synced',
        erpDocNo: docNo,
      });
      // issued in SAP: not edited away here
      await expect(
        timeMaterials.removeMaterial(manager, spare.id),
      ).rejects.toThrow('รับคืนเข้าคลังใน SAP');

      // the unit swapped: same asset, new serial, the faulty one claimed
      const claims = new ClaimsService(
        new ServiceClaimRepository(client),
        new ServiceAssetRepository(client),
        new ServiceWorkOrderRepository(client),
        new RequestRepository(client),
        new CompanyRepository(client),
        new CompanyMemberRepository(client),
        erp,
        {
          claimOverdue: (_u: string, _c: string, x: { vendorName: string }) => {
            told.push(x.vendorName);
            return Promise.resolve();
          },
        } as never,
        audit,
        transactions,
        { get: () => 0 } as never,
      );
      const told: string[] = [];
      const before = await prisma.serviceAsset.findUniqueOrThrow({
        where: { id: assetId },
      });
      await expect(
        claims.replaceUnit(manager, assetId, {
          new_serial: before.serialNo!,
          reason: 'x',
        }),
      ).rejects.toThrow('ซ้ำกับเครื่องเดิม');
      const vendors = await claims.vendors(manager);
      const swapped = await claims.replaceUnit(manager, assetId, {
        new_serial: `new-${tag}`,
        reason: 'กล้องภาพไม่ขึ้น เปลี่ยนตัวใหม่',
        work_order_id: order.id,
        claim: { vendor_code: vendors[0].code, vendor_name: vendors[0].name },
      });
      expect(swapped).toMatchObject({
        oldSerial: before.serialNo,
        newSerial: `NEW-${tag}`,
        claim: {
          status: 'pending',
          serialNo: before.serialNo,
          requestNo: `REQ-T245-${tag}`,
        },
      });
      const history = await prisma.serviceAssetHistory.findFirstOrThrow({
        where: { assetId, action: 'replaced' },
      });
      expect(history.before).toEqual({ serialNo: before.serialNo });

      // sent with an RMA, due back on the 20th — late on the 25th, told once
      const claimId = swapped.claim!.id;
      await expect(
        claims.step(manager, claimId, {
          status: 'replaced',
          resolved_on: '2026-10-21',
        }),
      ).rejects.toThrow('ไม่ได้');
      await claims.step(manager, claimId, {
        status: 'sent',
        rma_no: 'RMA-889',
        sent_on: '2026-10-06',
        expected_on: '2026-10-20',
      });
      await claims.sweep(new Date('2026-10-25T03:00:00Z'));
      await claims.sweep(new Date('2026-10-26T03:00:00Z'));
      expect(told).toEqual([vendors[0].name]);
      await expect(
        claims.step(manager, claimId, {
          status: 'credited',
          resolved_on: '2026-10-27',
        }),
      ).rejects.toThrow('ยอดเครดิต');
      const done = await claims.step(manager, claimId, {
        status: 'replaced',
        resolved_on: '2026-10-27',
        replacement_serial: `RPL-${tag}`,
      });
      expect(done).toMatchObject({ status: 'replaced', overdue: false });
      expect(
        (await claims.list(manager, { work_order_id: order.id })).map(
          (row) => row.id,
        ),
      ).toEqual([claimId]);

      // put the serial back for the other tests' sake
      await prisma.serviceAsset.update({
        where: { id: assetId },
        data: { serialNo: before.serialNo },
      });
    });
  },
);
