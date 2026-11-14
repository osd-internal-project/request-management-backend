import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  paginated,
  PageQueryDto,
  Principal,
  toSkipTake,
} from '@request-management/share';
import { CompanyRepository } from '../crm/product.repositories';
import { IntegrationRepository } from './integration.repository';
import { IntegrationCallRepository } from './integration-call.repository';
import {
  CreateIntegrationDto,
  IntegrationCallRowDto,
  IntegrationRowDto,
  UpdateIntegrationDto,
} from './dto/integration.dto';

interface IntegrationRow {
  id: string;
  companyId: string | null;
  name: string;
  description: string | null;
  modes: string[];
  allowActingUser: boolean;
  keycloakClientIds: string[];
  allowedCompanyIds: string[];
  active: boolean;
  createdAt: Date;
  createdBy: string;
  _count?: { apiKeys: number; webhooks: number; connections: number };
}

interface IntegrationCallRow {
  id: string;
  apiKeyId: string | null;
  method: string;
  route: string;
  mode: string;
  actorUserId: string | null;
  status: number;
  durationMs: number;
  createdAt: Date;
}

const WITH_COUNTS = {
  _count: { select: { apiKeys: true, webhooks: true, connections: true } },
} as const;

/**
 * ระบบภายนอกหนึ่งระบบ = หนึ่งแถว ถือ key และ webhook ของตัวเอง (22 ต.ค. 2569).
 *
 * ผูกกับบริษัทที่ผู้ดูแลกำลังทำงานอยู่เสมอ เหมือน `ApiKeyAdminService` —
 * integration ข้ามบริษัท (`companyId` NULL) มาจาก backfill ของ key เดิมเท่านั้น
 * และไม่ปรากฏบนหน้าจอของบริษัทไหน.
 */
@Injectable()
export class IntegrationAdminService {
  constructor(
    private readonly integrations: IntegrationRepository,
    private readonly audit: AuditWriter,
    private readonly calls: IntegrationCallRepository,
    private readonly companies: CompanyRepository,
  ) {}

  /**
   * หน้า hub ระบบ (14 พ.ย. 2569): integration ของทุกบริษัทและของกลาง.
   * `company` = uuid ของบริษัท, `system` = ของกลาง, ไม่ส่ง = ทั้งหมด
   */
  async listAcrossCompanies(company?: string): Promise<IntegrationRowDto[]> {
    // undefined = ทุกบริษัท; key ต้องมีให้ tenant guard เห็นว่าเลือกแล้ว
    const where = {
      companyId:
        company === undefined ? undefined : company === 'system' ? null : company,
    };
    const rows = (await this.integrations.findMany({
      where,
      include: WITH_COUNTS,
      orderBy: [{ companyId: 'asc' }, { createdAt: 'desc' }],
    })) as IntegrationRow[];
    return rows.map(toRow);
  }

  /** บริษัทเจ้าของแถว — ให้ route ของระบบเรียก service เดิมด้วย owner ที่ถูกต้อง */
  async ownerOf(id: string): Promise<string | null> {
    const found = (await this.integrations.findFirst({
      // ระดับระบบ: ทุกบริษัทโดยตั้งใจ — key ต้องมีให้ tenant guard เห็นว่าเลือกแล้ว
      where: { id, companyId: undefined },
      select: { companyId: true },
    })) as { companyId: string | null } | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบระบบภายนอกที่ระบุ');
    return found.companyId;
  }

  async list(
    actor: Principal,
    owner: string | null = actor.activeCompanyId,
  ): Promise<IntegrationRowDto[]> {
    const rows = (await this.integrations.findMany({
      where: { companyId: owner },
      include: WITH_COUNTS,
      orderBy: { createdAt: 'desc' },
    })) as IntegrationRow[];
    return rows.map(toRow);
  }

  async create(
    dto: CreateIntegrationDto,
    actor: Principal,
    owner: string | null = actor.activeCompanyId,
  ): Promise<IntegrationRowDto> {
    const row = (await this.integrations.create({
      data: {
        companyId: owner,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        modes: [...new Set(dto.modes)],
        allowActingUser: dto.allow_acting_user ?? false,
        keycloakClientIds: [...new Set(dto.keycloak_client_ids ?? [])],
        createdBy: actor.userId,
      },
      include: WITH_COUNTS,
    })) as IntegrationRow;

    await this.audit.record({
      eventType: 'admin.integration.created',
      companyId: owner,
      ...auditActor(actor),
      resourceType: 'integration',
      resourceId: row.id,
      after: summary(row),
    });
    return toRow(row);
  }

  async update(
    id: string,
    dto: UpdateIntegrationDto,
    actor: Principal,
    owner: string | null = actor.activeCompanyId,
  ): Promise<IntegrationRowDto> {
    const found = await this.owned(id, actor, owner);
    const allowedCompanyIds = await this.allowedCompaniesOf(dto, owner);
    const row = (await this.integrations.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        description:
          dto.description === undefined
            ? undefined
            : dto.description.trim() || null,
        modes: dto.modes ? [...new Set(dto.modes)] : undefined,
        allowActingUser: dto.allow_acting_user,
        keycloakClientIds: dto.keycloak_client_ids
          ? [...new Set(dto.keycloak_client_ids)]
          : undefined,
        active: dto.active,
        allowedCompanyIds,
      },
      include: WITH_COUNTS,
    })) as IntegrationRow;

    await this.audit.record({
      eventType: 'admin.integration.updated',
      companyId: owner,
      ...auditActor(actor),
      resourceType: 'integration',
      resourceId: id,
      before: summary(found),
      after: summary(row),
    });
    return toRow(row);
  }

  /** คำขอล่าสุดของระบบภายนอกนี้ — ใหม่สุดก่อน, เก็บตาม retention ของ AI audit. */
  async listCalls(
    id: string,
    query: PageQueryDto,
    actor: Principal,
    owner: string | null = actor.activeCompanyId,
  ) {
    await this.owned(id, actor, owner);
    const where = { integrationId: id };
    const { skip, take } = toSkipTake(query);
    const [rows, total] = await Promise.all([
      this.calls.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }) as Promise<IntegrationCallRow[]>,
      this.calls.count({ where }),
    ]);
    return paginated(rows.map(toCallRow), query, total);
  }

  /**
   * integration ของบริษัทผู้เรียก — ของบริษัทอื่นตอบ 404 (SCOPE-03).
   * ใช้ตอนผูก key / webhook เข้ากับ integration ด้วย.
   */
  async owned(
    id: string,
    actor: Principal,
    owner: string | null = actor.activeCompanyId,
  ): Promise<IntegrationRow> {
    const found = (await this.integrations.findFirst({
      where: { id, companyId: owner },
    })) as IntegrationRow | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบระบบภายนอกที่ระบุ');
    return found;
  }

  /**
   * key ที่ออกโดยไม่ระบุ integration ได้ integration ของตัวเอง — หน้าจอ api-keys
   * เดิมยังไม่ส่ง `integration_id`. ปิด `X-Acting-User` ตามค่าเริ่มต้นของ key ใหม่.
   */
  async createForKey(
    name: string,
    actor: Principal,
    owner: string | null = actor.activeCompanyId,
  ): Promise<string> {
    // owner ต้องส่งต่อ ไม่งั้น key ระบบได้ integration ของบริษัทที่ผู้ดูแลเปิดอยู่
    const row = await this.create(
      { name, modes: ['app', 'delegated'] },
      actor,
      owner,
    );
    return row.id;
  }

  /** `allowed_company_ids` ตั้งได้เฉพาะ integration กลาง และต้องเป็นบริษัทที่ใช้งานอยู่ */
  private async allowedCompaniesOf(
    dto: UpdateIntegrationDto,
    owner: string | null,
  ): Promise<string[] | undefined> {
    if (dto.allowed_company_ids === undefined) return undefined;
    if (owner !== null) {
      throw new AppError(
        'VALIDATION_FAILED',
        'จำกัดบริษัทได้เฉพาะระบบภายนอกกลาง',
        [{ field: 'allowed_company_ids', reason: 'company_owned' }],
      );
    }
    const ids = [...new Set(dto.allowed_company_ids)];
    const found = (await this.companies.findMany({
      where: { id: { in: ids }, active: true },
      select: { id: true },
    })) as { id: string }[];
    const known = new Set(found.map((row) => row.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        'มีบริษัทที่ไม่พบหรือปิดใช้งานแล้ว',
        unknown.map((id) => ({ field: 'allowed_company_ids', reason: id })),
      );
    }
    return ids;
  }
}

function toRow(row: IntegrationRow): IntegrationRowDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    modes: row.modes,
    allow_acting_user: row.allowActingUser,
    keycloak_client_ids: row.keycloakClientIds,
    company_id: row.companyId,
    allowed_company_ids: row.allowedCompanyIds ?? [],
    active: row.active,
    api_key_count: row._count?.apiKeys ?? 0,
    webhook_count: row._count?.webhooks ?? 0,
    connection_count: row._count?.connections ?? 0,
    created_at: row.createdAt.toISOString(),
    created_by: row.createdBy,
  };
}

function toCallRow(row: IntegrationCallRow): IntegrationCallRowDto {
  return {
    id: row.id,
    at: row.createdAt.toISOString(),
    method: row.method,
    route: row.route,
    mode: row.mode,
    api_key_id: row.apiKeyId,
    actor_user_id: row.actorUserId,
    status: row.status,
    duration_ms: row.durationMs,
  };
}

function summary(row: IntegrationRow) {
  return {
    name: row.name,
    modes: row.modes,
    allowActingUser: row.allowActingUser,
    keycloakClientIds: row.keycloakClientIds,
    allowedCompanyIds: row.allowedCompanyIds ?? [],
    active: row.active,
  };
}
