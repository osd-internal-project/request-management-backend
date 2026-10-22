import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
} from '@request-management/share';
import { IntegrationRepository } from './integration.repository';
import {
  CreateIntegrationDto,
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
  active: boolean;
  createdAt: Date;
  createdBy: string;
  _count?: { apiKeys: number; webhooks: number };
}

const WITH_COUNTS = {
  _count: { select: { apiKeys: true, webhooks: true } },
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
  ) {}

  async list(actor: Principal): Promise<IntegrationRowDto[]> {
    const rows = (await this.integrations.findMany({
      where: { companyId: actor.activeCompanyId },
      include: WITH_COUNTS,
      orderBy: { createdAt: 'desc' },
    })) as IntegrationRow[];
    return rows.map(toRow);
  }

  async create(
    dto: CreateIntegrationDto,
    actor: Principal,
  ): Promise<IntegrationRowDto> {
    const row = (await this.integrations.create({
      data: {
        companyId: actor.activeCompanyId,
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
      companyId: actor.activeCompanyId,
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
  ): Promise<IntegrationRowDto> {
    const found = await this.owned(id, actor);
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
      },
      include: WITH_COUNTS,
    })) as IntegrationRow;

    await this.audit.record({
      eventType: 'admin.integration.updated',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'integration',
      resourceId: id,
      before: summary(found),
      after: summary(row),
    });
    return toRow(row);
  }

  /**
   * integration ของบริษัทผู้เรียก — ของบริษัทอื่นตอบ 404 (SCOPE-03).
   * ใช้ตอนผูก key / webhook เข้ากับ integration ด้วย.
   */
  async owned(id: string, actor: Principal): Promise<IntegrationRow> {
    const found = (await this.integrations.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    })) as IntegrationRow | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบระบบภายนอกที่ระบุ');
    return found;
  }

  /**
   * key ที่ออกโดยไม่ระบุ integration ได้ integration ของตัวเอง — หน้าจอ api-keys
   * เดิมยังไม่ส่ง `integration_id`. ปิด `X-Acting-User` ตามค่าเริ่มต้นของ key ใหม่.
   */
  async createForKey(name: string, actor: Principal): Promise<string> {
    const row = await this.create({ name, modes: ['app', 'delegated'] }, actor);
    return row.id;
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
    active: row.active,
    api_key_count: row._count?.apiKeys ?? 0,
    webhook_count: row._count?.webhooks ?? 0,
    created_at: row.createdAt.toISOString(),
    created_by: row.createdBy,
  };
}

function summary(row: IntegrationRow) {
  return {
    name: row.name,
    modes: row.modes,
    allowActingUser: row.allowActingUser,
    keycloakClientIds: row.keycloakClientIds,
    active: row.active,
  };
}
