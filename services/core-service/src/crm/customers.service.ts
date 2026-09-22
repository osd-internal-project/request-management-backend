import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma, CustomerStatus } from '@prisma/client';
import {
  accessSubject,
  salesAccessSubject,
  visibleSalesWhere,
  AppError,
  AuditWriter,
  auditActor,
  customerAccessSubject,
  hasPermission,
  paginated,
  Principal,
  PrismaTransactionService,
  toOrderBy,
  toSkipTake,
  TQueryClient,
  visibleCustomersWhere,
  visibleRequestsWhere,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { RequestRepository } from '../requests/request.repository';
import { CustomerRepository } from './customer.repository';
import {
  CustomerLocationRepository,
  CustomerContactRepository,
  CustomerExternalCodeRepository,
  CustomerFieldChangeRepository,
} from './customer-child.repositories';
import {
  CustomerSegmentAssignmentRepository,
  CustomerSegmentValueRepository,
} from './segment.repositories';
import { RunNumberClient } from '../run-number/run-number.client';
import {
  CustomerDedupService,
  SimilarCustomer,
} from './customer-dedup.service';
import { CustomerTimelineService } from './customer-timeline.service';
import { CustomerOdooSyncService } from './customer-odoo-sync.service';
import { KycProductRuleRepository } from './kyc-product.repository';
import { OpportunityRepository } from './sales.repositories';
import { PDPA_CLIENT } from '../pdpa/pdpa-client';
import type { ContactConsentStatus, PdpaClient } from '../pdpa/pdpa-client';
import { assertCustomerTransition } from './customer-state-machine';
import { isValidThaiTaxId, normalizeCustomerName } from './customer-name';
import {
  CheckDuplicateDto,
  CreateCustomerDto,
  CustomerLocationDto,
  CustomerContactDto,
  ListCustomersQueryDto,
  SetSegmentsDto,
  TimelineQueryDto,
  UpdateCustomerDto,
  UpsertExternalCodeDto,
} from './dto/customer.dto';

/** The scalar fields CM-01's per-field history tracks. */
const TRACKED_FIELDS = [
  'type',
  'nameTh',
  'nameEn',
  'taxId',
  'branchCode',
  'branchName',
  'accountOwnerUserId',
  'status',
] as const;

type TrackedField = (typeof TRACKED_FIELDS)[number];

const SORTABLE = [
  'createdAt',
  'updatedAt',
  'customerCode',
  'nameTh',
  'status',
] as const;

/**
 * Customer Master (CM-01…08, โครง CM-09) — the one customer registry.
 *
 * Every read is filtered through `visibleCustomersWhere` (SCOPE-02); a
 * customer outside the caller's reach answers 404, never 403 (SCOPE-03).
 * Every write is a transaction that carries its audit entry, its CM-01
 * field-history rows, and its C360-03 timeline event together.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly locations: CustomerLocationRepository,
    private readonly contacts: CustomerContactRepository,
    private readonly externalCodes: CustomerExternalCodeRepository,
    private readonly fieldChanges: CustomerFieldChangeRepository,
    private readonly segmentValues: CustomerSegmentValueRepository,
    private readonly assignments: CustomerSegmentAssignmentRepository,
    private readonly members: CompanyMemberRepository,
    private readonly requests: RequestRepository,
    private readonly runNumbers: RunNumberClient,
    private readonly dedup: CustomerDedupService,
    private readonly timeline: CustomerTimelineService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly odooSync: CustomerOdooSyncService,
    @Inject(PDPA_CLIENT) private readonly pdpa: PdpaClient,
    private readonly kycProducts: KycProductRuleRepository,
    private readonly opportunities: OpportunityRepository,
  ) {}

  private readonly logger = new Logger(CustomersService.name);

  // --- register (CM-01/08) -------------------------------------------------

  async list(actor: Principal, query: ListCustomersQueryDto) {
    const { skip, take } = toSkipTake(query);
    const where = this.scopedWhere(actor, query);

    const [rows, total] = await Promise.all([
      this.customers.search(where, {
        skip,
        take,
        orderBy: toOrderBy(query.sort, SORTABLE),
      }),
      this.customers.countWhere(where),
    ]);

    return paginated(rows as unknown[], query, total);
  }

  async findOne(id: string, actor: Principal) {
    const found = await this.customers.findDetail({
      id,
      AND: [visibleCustomersWhere(customerAccessSubject(actor))],
    });

    if (!found) {
      throw new AppError('NOT_FOUND', 'ไม่พบลูกค้าที่ระบุ');
    }

    return found;
  }

  /**
   * The list filter and the summary counts build here and nowhere else, so a
   * number on a card and the rows behind it cannot disagree (SCOPE-02 — the
   * C360-01 AC repeats it for this module).
   */
  private scopedWhere(
    actor: Principal,
    query: ListCustomersQueryDto,
  ): Prisma.CustomerWhereInput {
    const filters: Prisma.CustomerWhereInput = {};

    if (query.status) filters.status = query.status;
    if (query.view === 'mine') filters.accountOwnerUserId = actor.userId;
    if (query.account_owner_user_id) {
      filters.accountOwnerUserId = query.account_owner_user_id;
    }
    if (query.segment_value_id) {
      filters.segments = { some: { valueId: query.segment_value_id } };
    }
    if (query.search) {
      const q = query.search.trim();
      filters.OR = [
        { nameTh: { contains: q, mode: 'insensitive' } },
        { nameEn: { contains: q, mode: 'insensitive' } },
        { customerCode: { contains: q, mode: 'insensitive' } },
        { taxId: { contains: q } },
      ];
    }

    // AND rather than spread: the scope where carries its own OR, and merging
    // two ORs by spread silently drops one of them.
    return {
      AND: [visibleCustomersWhere(customerAccessSubject(actor)), filters],
    };
  }

  /**
   * C360-01 — the 360° header card. The numbers and the tabs behind them are
   * counted through the same filters as the tabs' own queries (SCOPE-02), so
   * a card can never disagree with the rows under it. The requests block is
   * `null` for a viewer without `request.read` — the frontend hides the card
   * instead of showing a number that would 403 on click (C360-04).
   */
  async summaryOf(id: string, actor: Principal) {
    await this.findOne(id, actor);

    const requestWhere = {
      AND: [
        visibleRequestsWhere(accessSubject(actor)),
        { refType: 'customer', refId: id },
      ],
    };

    const salesWhere = hasPermission(actor, 'crm.sales.read')
      ? ({
          AND: [
            visibleSalesWhere(salesAccessSubject(actor)),
            { customerId: id },
          ],
        } as never)
      : null;

    const [
      contacts,
      locations,
      branchCustomers,
      requestTotal,
      requestOpen,
      odooCode,
      opportunityOpenCount,
      opportunityOpenSum,
    ] = await Promise.all([
      this.contacts.count({ where: { customerId: id, active: true } }),
      this.locations.count({ where: { customerId: id, active: true } }),
      this.customers.countWhere({
        headOfficeId: id,
        mergedIntoCustomerId: null,
      }),
      hasPermission(actor, 'request.read')
        ? this.requests.count({ where: requestWhere })
        : Promise.resolve(null),
      hasPermission(actor, 'request.read')
        ? this.requests.count({
            where: {
              AND: [
                requestWhere,
                {
                  status: {
                    notIn: ['completed', 'closed', 'cancelled', 'rejected'],
                  },
                },
              ],
            } as never,
          })
        : Promise.resolve(null),
      this.externalCodes.findFirst({
        where: { customerId: id, system: 'odoo' },
        select: { payload: true },
      }) as Promise<{ payload: unknown } | null>,
      salesWhere
        ? this.opportunities.count({
            where: {
              AND: [
                salesWhere,
                { stage: { in: ['qualifying', 'proposing', 'negotiating'] } },
              ],
            } as never,
          })
        : Promise.resolve(null),
      salesWhere
        ? this.opportunities.sumAmount({
            AND: [
              salesWhere,
              { stage: { in: ['qualifying', 'proposing', 'negotiating'] } },
            ],
          } as never)
        : Promise.resolve(null),
    ]);

    // C360-02 — ยอดค้างชำระอ่านจาก cache ที่รอบ sync รายชั่วโมงเติมไว้ (CM-06);
    // ไม่มี = ยังไม่เคย sync สำเร็จ และการ์ดฝั่งหน้าจอบอกตรง ๆ ว่ารอ.
    const payload =
      odooCode?.payload && typeof odooCode.payload === 'object'
        ? (odooCode.payload as { receivables?: unknown })
        : null;

    return {
      contacts,
      locations,
      branchCustomers,
      // C360-01 — โอกาสการขายนับผ่าน visibleSalesWhere เดียวกับแท็บ (SCOPE-02);
      // null = viewer ไม่มี crm.sales.read → การ์ดถูกซ่อน (C360-04).
      opportunities:
        opportunityOpenCount === null
          ? null
          : {
              open: opportunityOpenCount,
              openAmount: opportunityOpenSum ?? 0,
            },
      requests:
        requestTotal === null
          ? null
          : { total: requestTotal, open: requestOpen },
      // ODOO_MODE=mock → ตัวเลขใน cache เป็นของปลอม: ตอบ null ให้การ์ดบอกว่ารอ Odoo
      financials: (this.odooSync.receivablesLive
        ? (payload?.receivables ?? null)
        : null) as {
        outstanding: number;
        invoiceCount: number;
        asOf: string;
      } | null,
    };
  }

  /**
   * CM-05 — consent badges for the contacts tab, read LIVE from the central
   * PDPA service every time (the spec forbids copying consent into the
   * contact table). The PDPA service being down degrades to `unknown` per
   * channel — a badge that says "ตรวจไม่ได้" instead of a broken tab.
   */
  async contactConsents(
    customerId: string,
    actor: Principal,
  ): Promise<ContactConsentStatus[]> {
    const found = await this.findOne(customerId, actor);

    const contacts = (
      found as unknown as {
        contacts: { id: string; email: string | null; phone: string | null }[];
      }
    ).contacts;

    if (!contacts.length) return [];

    const queries = contacts.map((contact) => ({
      contactId: contact.id,
      email: contact.email,
      phone: contact.phone,
    }));

    try {
      return await this.pdpa.lookupConsents(queries);
    } catch (error) {
      this.logger.warn(
        `pdpa lookup degraded to unknown: ${error instanceof Error ? error.message : String(error)}`,
      );
      return queries.map((query) => ({
        contactId: query.contactId,
        email: query.email ? ('unknown' as const) : null,
        phone: query.phone ? ('unknown' as const) : null,
        doNotCall: false,
      }));
    }
  }

  /** CM-04 ชุดงาน B — เฉพาะ rule ที่ active สำหรับผู้ใช้ทั่วไป/โมดูลอื่น. */
  async listKycProducts(actor: Principal) {
    return this.kycProducts.findMany({
      where: { companyId: actor.activeCompanyId, active: true },
      select: { id: true, productCode: true, name: true },
      orderBy: { productCode: 'asc' },
    });
  }

  // --- create (CM-01/02/03) ------------------------------------------------

  async create(dto: CreateCustomerDto, actor: Principal) {
    this.assertTaxId(dto.tax_id);

    const owner = await this.resolveAccountOwner(
      dto.account_owner_user_id,
      actor,
    );
    const segmentValueIds = await this.assertSegmentValues(
      dto.segment_value_ids,
      actor.activeCompanyId,
    );

    // ออกเลขนอก transaction และหลังตรวจทุกอย่างผ่าน — docs/run-number.md
    const customerCode = await this.runNumbers.issueUnused(
      { companyId: actor.activeCompanyId, docType: 'CUSTOMER' },
      (code) => this.customers.codeTaken(code),
    );

    const created = await this.transactions.execute(async (prisma) => {
      const overridden = await this.guardDuplicates(
        {
          nameTh: dto.name_th,
          nameEn: dto.name_en,
          taxId: dto.tax_id,
          branchCode: dto.branch_code,
        },
        actor,
        { confirm: dto.confirm_duplicate, reason: dto.override_reason },
        prisma,
      );

      // Redesign #2 (8 ก.ย. 2569): a second row with the same tax id IS a
      // branch — link it to the head office automatically, never block it.
      const headOffice = dto.tax_id
        ? await this.dedup.headOfficeOf(
            dto.tax_id,
            actor.activeCompanyId,
            prisma,
          )
        : null;

      const status: CustomerStatus = dto.status ?? 'active';

      const row = await this.customers.create(
        {
          data: {
            customerCode,
            companyId: actor.activeCompanyId,
            type: dto.type,
            nameTh: dto.name_th,
            nameEn: dto.name_en ?? null,
            normalizedName: normalizeCustomerName(dto.name_th),
            taxId: dto.tax_id ?? null,
            branchCode: dto.branch_code ?? '00000',
            branchName: dto.branch_name ?? null,
            headOfficeId: headOffice?.id ?? null,
            status,
            accountOwnerUserId: owner.id,
            ownerOrgUnitId: owner.orgUnitId,
            dedupOverrideReason: overridden.length
              ? (dto.override_reason ?? null)
              : null,
            createdBy: actor.userId,
            locations: {
              create: (dto.locations ?? []).map((l) =>
                locationData(l, actor.userId),
              ),
            },
            contacts: {
              create: (dto.contacts ?? []).map((c) =>
                contactData(c, actor.userId),
              ),
            },
            segments: {
              create: segmentValueIds.map((valueId) => ({
                valueId,
                assignedBy: actor.userId,
              })),
            },
          },
        },
        { prisma },
      );

      await this.audit.record(
        {
          eventType: 'crm.customer.created',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'customer',
          resourceId: row.id,
          after: {
            customerCode,
            nameTh: row.nameTh,
            taxId: row.taxId,
            status: row.status,
          },
        },
        { prisma },
      );

      if (overridden.length) {
        // CM-03 AC: confirming past the warning is itself an audited event,
        // carrying the reason and exactly which customers were flagged.
        await this.audit.record(
          {
            eventType: 'crm.customer.dedup_overridden',
            companyId: actor.activeCompanyId,
            ...auditActor(actor),
            resourceType: 'customer',
            resourceId: row.id,
            after: {
              reason: dto.override_reason,
              similar: overridden.map((s) => ({
                id: s.id,
                customerCode: s.customerCode,
                similarity: s.similarity,
              })),
            },
          },
          { prisma },
        );
      }

      await this.timeline.publish(
        {
          companyId: actor.activeCompanyId,
          customerId: row.id,
          refType: 'customer',
          refId: row.id,
          eventType: 'customer.created',
          summary: `สร้างลูกค้า ${customerCode} · ${row.nameTh}`,
          actorId: auditActor(actor).actorId,
          actorName: actor.displayName,
        },
        { prisma },
      );

      return row;
    });

    // CM-06: Odoo is called AFTER the commit — a slow upstream cannot hold a
    // database transaction open, and a down one becomes a queue row.
    if (created.status === 'active') this.odooSync.kickCustomer(created.id);

    return this.findOne(created.id, actor);
  }

  // --- update (CM-01 field history) ----------------------------------------

  async update(id: string, dto: UpdateCustomerDto, actor: Principal) {
    const found = await this.requireEditable(id, actor);
    this.assertTaxId(dto.tax_id);

    const next: Partial<Record<TrackedField, unknown>> = {
      type: dto.type,
      nameTh: dto.name_th,
      nameEn: dto.name_en,
      taxId: dto.tax_id,
      branchCode: dto.branch_code,
      branchName: dto.branch_name,
      accountOwnerUserId: dto.account_owner_user_id,
    };

    const changed = TRACKED_FIELDS.filter(
      (field) =>
        next[field] !== undefined && next[field] !== (found as never)[field],
    );

    if (!changed.length) return this.findOne(id, actor);

    const owner = changed.includes('accountOwnerUserId')
      ? await this.resolveAccountOwner(dto.account_owner_user_id, actor)
      : null;

    const identityChanged = (
      ['nameTh', 'nameEn', 'taxId', 'branchCode'] as const
    ).some((field) => changed.includes(field));

    await this.transactions.execute(async (prisma) => {
      if (identityChanged) {
        await this.guardDuplicates(
          {
            nameTh: dto.name_th ?? found.nameTh,
            nameEn: dto.name_en ?? found.nameEn,
            taxId: dto.tax_id ?? found.taxId,
            branchCode: dto.branch_code ?? found.branchCode,
            excludeCustomerId: id,
          },
          actor,
          { confirm: dto.confirm_duplicate, reason: dto.override_reason },
          prisma,
        );
      }

      const data: Prisma.CustomerUncheckedUpdateInput = {
        updatedBy: actor.userId,
      };
      for (const field of changed) data[field] = next[field] as never;
      if (changed.includes('nameTh')) {
        data.normalizedName = normalizeCustomerName(dto.name_th!);
      }
      if (owner) {
        data.accountOwnerUserId = owner.id;
        data.ownerOrgUnitId = owner.orgUnitId;
      }

      // A tax-id change moves the row between เครือ — recompute the head link
      // the same way create does (null when it is now the only row).
      if (changed.includes('taxId')) {
        const head = dto.tax_id
          ? await this.dedup.headOfficeOf(
              dto.tax_id,
              actor.activeCompanyId,
              prisma,
              { excludeCustomerId: id },
            )
          : null;
        data.headOfficeId = head?.id ?? null;
      }

      await this.customers.update({ where: { id }, data }, { prisma });

      // CM-01 AC: แก้ field ใดเก็บประวัติ ใคร–เมื่อไร–ค่าก่อน/หลัง — one row
      // per field, in the same transaction as the change itself.
      await this.fieldChanges.createMany(
        changed.map((field) => ({
          customerId: id,
          field,
          before: (found as never)[field] ?? null,
          after: (next[field] as Prisma.InputJsonValue) ?? null,
          changedBy: actor.userId,
        })),
        { prisma },
      );

      await this.audit.record(
        {
          eventType: 'crm.customer.updated',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'customer',
          resourceId: id,
          before: pick(found, changed),
          after: pick(next, changed),
        },
        { prisma },
      );
    });

    this.odooSync.kickCustomer(id);

    return this.findOne(id, actor);
  }

  // --- lifecycle (CM-04) ---------------------------------------------------

  async activate(id: string, actor: Principal) {
    return this.changeStatus(id, 'active', actor, {
      clear: {
        suspendReason: null,
        deactivatedAt: null,
        deactivateReason: null,
      },
    });
  }

  async suspend(id: string, reason: string, actor: Principal) {
    return this.changeStatus(id, 'suspended', actor, {
      set: { suspendReason: reason },
      reason,
    });
  }

  /** ปิดใช้งาน — เหตุผลบังคับ ข้อมูลไม่หาย ไม่มี DELETE (spec rule #4). */
  async deactivate(id: string, reason: string, actor: Principal) {
    return this.changeStatus(id, 'inactive', actor, {
      set: { deactivateReason: reason, deactivatedAt: new Date() },
      reason,
    });
  }

  private async changeStatus(
    id: string,
    to: CustomerStatus,
    actor: Principal,
    options: {
      set?: Prisma.CustomerUncheckedUpdateInput;
      clear?: Prisma.CustomerUncheckedUpdateInput;
      reason?: string;
    },
  ) {
    const found = await this.requireEditable(id, actor);

    // CM-04 AC: transitions outside the table are impossible through every
    // channel — this is the only status-write path, and it always asserts.
    assertCustomerTransition(found.status, to);

    await this.transactions.execute(async (prisma) => {
      await this.customers.update(
        {
          where: { id },
          data: {
            status: to,
            updatedBy: actor.userId,
            ...options.clear,
            ...options.set,
          },
        },
        { prisma },
      );

      await this.fieldChanges.createMany(
        [
          {
            customerId: id,
            field: 'status',
            before: found.status,
            after: to,
            changedBy: actor.userId,
          },
        ],
        { prisma },
      );

      await this.audit.record(
        {
          eventType: 'crm.customer.status_changed',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'customer',
          resourceId: id,
          before: { status: found.status },
          after: { status: to, reason: options.reason },
        },
        { prisma },
      );

      await this.timeline.publish(
        {
          companyId: actor.activeCompanyId,
          customerId: id,
          refType: 'customer',
          refId: id,
          eventType: 'customer.status_changed',
          summary: options.reason
            ? `เปลี่ยนสถานะเป็น ${STATUS_LABEL[to]} — ${options.reason}`
            : `เปลี่ยนสถานะเป็น ${STATUS_LABEL[to]}`,
          actorId: auditActor(actor).actorId,
          actorName: actor.displayName,
        },
        { prisma },
      );
    });

    this.odooSync.kickCustomer(id);

    return this.findOne(id, actor);
  }

  // --- dedup (CM-03) -------------------------------------------------------

  async checkDuplicate(dto: CheckDuplicateDto, actor: Principal) {
    return this.dedup.check(
      {
        nameTh: dto.name_th,
        nameEn: dto.name_en,
        taxId: dto.tax_id,
        branchCode: dto.branch_code,
        excludeCustomerId: dto.exclude_customer_id,
      },
      actor.activeCompanyId,
    );
  }

  /**
   * The CM-03 gate before any identity write.
   *
   * Hard duplicate → 409, always. Similar names → 422 warning, unless the
   * caller confirmed past it — which requires `crm.customer.dedup.override`
   * (PO decision #4: a dedicated permission, not part of `manage`) and a
   * reason. The permission is only demanded when there is actually something
   * to override, so sending `confirm_duplicate` on a clean name costs nothing.
   */
  private async guardDuplicates(
    input: {
      nameTh: string;
      nameEn?: string | null;
      taxId?: string | null;
      branchCode?: string | null;
      excludeCustomerId?: string;
    },
    actor: Principal,
    override: { confirm?: boolean; reason?: string },
    prisma: TQueryClient,
  ): Promise<readonly SimilarCustomer[]> {
    const result = await this.dedup.check(input, actor.activeCompanyId, {
      prisma,
    });

    if (result.duplicate) {
      throw new AppError(
        'CRM_CUSTOMER_DUPLICATE',
        'เลขผู้เสียภาษีและรหัสสาขานี้มีลูกค้าอยู่แล้ว — เปิดใช้รายเดิมแทนการสร้างซ้ำ',
        [
          { field: 'tax_id', reason: result.duplicate.customerCode },
          { field: 'existing_customer_id', reason: result.duplicate.id },
        ],
      );
    }

    if (!result.similar.length) return [];

    if (!override.confirm) {
      throw new AppError(
        'CRM_CUSTOMER_SIMILAR',
        'พบลูกค้าชื่อคล้ายกัน — เลือกใช้รายเดิม หรือยืนยันสร้างใหม่พร้อมเหตุผล',
        result.similar.map((s) => ({
          field: 'similar_customer_id',
          reason: `${s.id}|${s.customerCode}|${s.nameTh}`,
        })),
      );
    }

    if (!hasPermission(actor, 'crm.customer.dedup.override')) {
      throw new AppError(
        'FORBIDDEN',
        'การยืนยันสร้างลูกค้าทั้งที่ระบบเตือนชื่อคล้าย ต้องได้รับสิทธิ์เฉพาะ',
      );
    }

    if (!override.reason?.trim()) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ต้องระบุเหตุผลในการยืนยันสร้าง',
        [{ field: 'override_reason', reason: 'required' }],
      );
    }

    return result.similar;
  }

  // --- contacts (CM-05 CRUD; PDPA badge มาชุดงาน C) ------------------------

  async addContact(
    customerId: string,
    dto: CustomerContactDto,
    actor: Principal,
  ) {
    await this.requireEditable(customerId, actor);

    return this.transactions.execute(async (prisma) => {
      if (dto.is_primary) {
        await this.demoteOtherPrimaries('contact', customerId, prisma);
      }

      const row = await this.contacts.create(
        { data: { customerId, ...contactData(dto, actor.userId) } },
        { prisma },
      );

      await this.audit.record(
        {
          eventType: 'crm.customer.contact_added',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'customer',
          resourceId: customerId,
          after: { name: dto.name, role: dto.role },
        },
        { prisma },
      );

      return row;
    });
  }

  async updateContact(
    customerId: string,
    contactId: string,
    dto: CustomerContactDto,
    actor: Principal,
  ) {
    await this.requireEditable(customerId, actor);
    await this.requireChild(
      this.contacts,
      contactId,
      customerId,
      'ไม่พบผู้ติดต่อที่ระบุ',
    );

    return this.transactions.execute(async (prisma) => {
      if (dto.is_primary) {
        await this.demoteOtherPrimaries(
          'contact',
          customerId,
          prisma,
          contactId,
        );
      }

      return this.contacts.update(
        {
          where: { id: contactId },
          data: { ...contactData(dto, undefined, actor.userId) },
        },
        { prisma },
      );
    });
  }

  /** Soft delete — the row stays, like every other retirement here. */
  async removeContact(customerId: string, contactId: string, actor: Principal) {
    await this.requireEditable(customerId, actor);
    await this.requireChild(
      this.contacts,
      contactId,
      customerId,
      'ไม่พบผู้ติดต่อที่ระบุ',
    );

    await this.contacts.update({
      where: { id: contactId },
      data: { active: false, isPrimary: false, updatedBy: actor.userId },
    });
  }

  // --- locations (CM-01, redesign #2 — ที่อยู่/ไซต์ของลูกค้ารายนี้) --------

  async addLocation(
    customerId: string,
    dto: CustomerLocationDto,
    actor: Principal,
  ) {
    await this.requireEditable(customerId, actor);

    return this.transactions.execute(async (prisma) => {
      if (dto.is_primary) {
        await this.demoteOtherPrimaries('location', customerId, prisma);
      }

      return this.locations.create(
        { data: { customerId, ...locationData(dto, actor.userId) } },
        { prisma },
      );
    });
  }

  async updateLocation(
    customerId: string,
    locationId: string,
    dto: CustomerLocationDto,
    actor: Principal,
  ) {
    await this.requireEditable(customerId, actor);
    await this.requireChild(
      this.locations,
      locationId,
      customerId,
      'ไม่พบที่อยู่/ไซต์ที่ระบุ',
    );

    return this.transactions.execute(async (prisma) => {
      if (dto.is_primary) {
        await this.demoteOtherPrimaries(
          'location',
          customerId,
          prisma,
          locationId,
        );
      }

      return this.locations.update(
        {
          where: { id: locationId },
          data: { ...locationData(dto, undefined, actor.userId) },
        },
        { prisma },
      );
    });
  }

  async removeLocation(
    customerId: string,
    locationId: string,
    actor: Principal,
  ) {
    await this.requireEditable(customerId, actor);
    await this.requireChild(
      this.locations,
      locationId,
      customerId,
      'ไม่พบที่อยู่/ไซต์ที่ระบุ',
    );

    await this.locations.update({
      where: { id: locationId },
      data: { active: false, isPrimary: false, updatedBy: actor.userId },
    });
  }

  // --- segments (CM-07) ----------------------------------------------------

  async setSegments(customerId: string, dto: SetSegmentsDto, actor: Principal) {
    await this.requireEditable(customerId, actor);
    const valueIds = await this.assertSegmentValues(
      dto.segment_value_ids,
      actor.activeCompanyId,
    );

    const current = (await this.assignments.findMany({
      where: { customerId },
      select: { valueId: true },
    })) as { valueId: string }[];

    await this.transactions.execute(async (prisma) => {
      // Assignments are current-state configuration on the customer, replaced
      // wholesale; the audit entry keeps before/after so nothing is lost.
      await prisma.customerSegmentAssignment.deleteMany({
        where: { customerId },
      });
      if (valueIds.length) {
        await this.assignments.createMany(
          {
            data: valueIds.map((valueId) => ({
              customerId,
              valueId,
              assignedBy: actor.userId,
            })),
          },
          { prisma },
        );
      }

      await this.audit.record(
        {
          eventType: 'crm.customer.segments_changed',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'customer',
          resourceId: customerId,
          before: { valueIds: current.map((c) => c.valueId) },
          after: { valueIds },
        },
        { prisma },
      );
    });

    return this.findOne(customerId, actor);
  }

  // --- history / external codes / timeline ---------------------------------

  /**
   * CM-01 — the ประวัติการแก้ไข tab.
   *
   * `changedBy` is a plain id column (no FK, like every actor snapshot here),
   * so the display name is resolved at read time — one `IN` query for the
   * whole page, and a departed user's rows still show whatever the directory
   * last knew rather than breaking the join.
   */
  async history(customerId: string, actor: Principal) {
    await this.findOne(customerId, actor);

    const rows = (await this.fieldChanges.findMany({
      where: { customerId },
      orderBy: { changedAt: 'desc' },
      take: 200,
    })) as { changedBy: string | null }[];

    const actorIds = [
      ...new Set(rows.map((row) => row.changedBy).filter(Boolean)),
    ] as string[];

    const users = actorIds.length
      ? ((await this.members.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, displayName: true },
        })) as { id: string; displayName: string }[])
      : [];

    const nameOf = new Map(users.map((user) => [user.id, user.displayName]));

    return rows.map((row) => ({
      ...row,
      changedByName: row.changedBy
        ? (nameOf.get(row.changedBy) ?? row.changedBy)
        : null,
    }));
  }

  /** CM-02 — Odoo partner id + 7 accounting systems. Admin surface. */
  async listExternalCodes(customerId: string, actor: Principal) {
    await this.findOne(customerId, actor);

    return this.externalCodes.findMany({
      where: { customerId },
      orderBy: { system: 'asc' },
    });
  }

  async upsertExternalCode(
    customerId: string,
    dto: UpsertExternalCodeDto,
    actor: Principal,
  ) {
    await this.findOne(customerId, actor);

    return this.transactions.execute(async (prisma) => {
      const row = await this.externalCodes.upsert(
        {
          where: {
            customerId_system: { customerId, system: dto.system },
          },
          create: {
            customerId,
            system: dto.system,
            externalCode: dto.external_code,
            payload: (dto.payload ?? undefined) as Prisma.InputJsonValue,
            createdBy: actor.userId,
          },
          update: {
            externalCode: dto.external_code,
            payload: (dto.payload ?? undefined) as Prisma.InputJsonValue,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );

      await this.audit.record(
        {
          eventType: 'crm.customer.external_code_set',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'customer',
          resourceId: customerId,
          after: { system: dto.system, externalCode: dto.external_code },
        },
        { prisma },
      );

      return row;
    });
  }

  /**
   * CM-07 — the active dimensions and values, for the form's pickers and the
   * register's filter. Readable by anyone who can read customers; the admin
   * surface (which also shows inactive rows and edits them) stays behind
   * `admin.crm.manage`.
   */
  async segmentOptions(actor: Principal) {
    return this.segmentValues.findMany({
      where: {
        active: true,
        dimension: { companyId: actor.activeCompanyId, active: true },
      },
      select: {
        id: true,
        code: true,
        nameTh: true,
        sortOrder: true,
        dimension: {
          select: { id: true, code: true, nameTh: true, sortOrder: true },
        },
      },
      orderBy: [{ dimension: { sortOrder: 'asc' } }, { sortOrder: 'asc' }],
    });
  }

  /** C360-03 — the feed, filtered to what this viewer may see. */
  async timelineOf(
    customerId: string,
    actor: Principal,
    query: TimelineQueryDto,
  ) {
    await this.findOne(customerId, actor);

    return this.timeline.list(customerId, actor, {
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      eventType: query.type,
    });
  }

  // --- helpers -------------------------------------------------------------

  /** Visible AND not an alias — every write path starts here. */
  private async requireEditable(id: string, actor: Principal) {
    const found = await this.findOne(id, actor);

    if (found.mergedIntoCustomerId) {
      throw new AppError(
        'CRM_CUSTOMER_STATE_INVALID',
        'ลูกค้ารายนี้ถูกรวมเข้ากับรายอื่นแล้ว — แก้ไขที่รายหลักแทน',
        [{ field: 'merged_into', reason: found.mergedIntoCustomerId }],
      );
    }

    return found;
  }

  private async requireChild(
    repo: CustomerContactRepository | CustomerLocationRepository,
    childId: string,
    customerId: string,
    message: string,
  ) {
    const child = (await repo.findFirst({
      where: { id: childId, customerId, active: true },
      select: { id: true },
    })) as { id: string } | null;

    if (!child) throw new AppError('NOT_FOUND', message);
  }

  /** ผู้ติดต่อหลัก/ที่อยู่หลัก has exactly one holder. */
  private async demoteOtherPrimaries(
    kind: 'contact' | 'location',
    customerId: string,
    prisma: TQueryClient,
    exceptId?: string,
  ) {
    const where = {
      customerId,
      isPrimary: true,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    };

    if (kind === 'contact') {
      await prisma.customerContact.updateMany({
        where,
        data: { isPrimary: false },
      });
    } else {
      await prisma.customerLocation.updateMany({
        where,
        data: { isPrimary: false },
      });
    }
  }

  private assertTaxId(taxId: string | undefined | null): void {
    if (taxId && !isValidThaiTaxId(taxId)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'เลขผู้เสียภาษีไม่ถูกต้อง (checksum ไม่ผ่าน)',
        [{ field: 'tax_id', reason: 'checksum' }],
      );
    }
  }

  /**
   * The account owner must be an active member of the active company; their
   * current group is snapshotted onto the customer (`ownerOrgUnitId`) so team
   * visibility reflects where the book sat when it was assigned.
   */
  private async resolveAccountOwner(
    ownerUserId: string | undefined,
    actor: Principal,
  ): Promise<{ id: string; orgUnitId: string | null }> {
    const id = ownerUserId ?? actor.userId;

    if (id === actor.userId) {
      return { id: actor.userId, orgUnitId: actor.orgUnitId };
    }

    const owner = (await this.members.findFirst({
      where: {
        id,
        status: 'ACTIVE',
        companies: { some: { companyId: actor.activeCompanyId } },
      },
      select: { id: true, orgUnitId: true },
    })) as { id: string; orgUnitId: string | null } | null;

    if (!owner) {
      throw new AppError('VALIDATION_FAILED', 'ไม่พบผู้รับผิดชอบบัญชีที่ระบุ', [
        { field: 'account_owner_user_id', reason: id },
      ]);
    }

    return owner;
  }

  /** Values must exist, be active, and belong to this company (SCOPE-03). */
  private async assertSegmentValues(
    valueIds: string[] | undefined,
    companyId: string,
  ): Promise<string[]> {
    const ids = [...new Set(valueIds ?? [])];
    if (!ids.length) return [];

    const rows = (await this.segmentValues.findMany({
      where: {
        id: { in: ids },
        active: true,
        dimension: { companyId, active: true },
      },
      select: { id: true },
    })) as { id: string }[];

    const foundIds = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !foundIds.has(id));

    if (missing.length) {
      throw new AppError('VALIDATION_FAILED', 'กลุ่มลูกค้าที่เลือกไม่ถูกต้อง', [
        ...missing.map((id) => ({ field: 'segment_value_ids', reason: id })),
      ]);
    }

    return ids;
  }
}

const STATUS_LABEL: Record<CustomerStatus, string> = {
  draft: 'ร่าง',
  active: 'ใช้งาน',
  suspended: 'พักใช้งาน',
  inactive: 'ปิดใช้งาน',
};

function locationData(
  dto: CustomerLocationDto,
  createdBy?: string,
  updatedBy?: string,
) {
  return {
    name: dto.name ?? null,
    line1: dto.line1,
    line2: dto.line2 ?? null,
    subDistrict: dto.sub_district ?? null,
    district: dto.district ?? null,
    province: dto.province ?? null,
    postalCode: dto.postal_code ?? null,
    country: dto.country ?? 'TH',
    isBilling: dto.is_billing ?? false,
    isSite: dto.is_site ?? true,
    isPrimary: dto.is_primary ?? false,
    ...(createdBy ? { createdBy } : {}),
    ...(updatedBy ? { updatedBy } : {}),
  };
}

function contactData(
  dto: CustomerContactDto,
  createdBy?: string,
  updatedBy?: string,
) {
  return {
    name: dto.name,
    role: dto.role ?? ('other' as const),
    position: dto.position ?? null,
    phone: dto.phone ?? null,
    email: dto.email ?? null,
    lineId: dto.line_id ?? null,
    note: dto.note ?? null,
    isPrimary: dto.is_primary ?? false,
    ...(createdBy ? { createdBy } : {}),
    ...(updatedBy ? { updatedBy } : {}),
  };
}

function pick(
  source: Record<string, unknown> | object,
  fields: readonly string[],
): Prisma.InputJsonValue {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    out[field] = (source as Record<string, unknown>)[field] ?? null;
  }
  return out as Prisma.InputJsonValue;
}
