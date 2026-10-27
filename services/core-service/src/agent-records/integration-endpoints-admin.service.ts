import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppError,
  AuditWriter,
  auditActor,
  type Principal,
} from '@request-management/share';
import { openSecret, sealSecret } from '../pm/config-rules';
import { IntegrationAdminService } from '../principal/integration-admin.service';
import { addressProblems, urlProblems } from '../webhook/webhook-rules';
import { IntegrationEndpointRepository } from './integration-endpoint.repository';
import type {
  CreateIntegrationEndpointDto,
  IntegrationEndpointRowDto,
  UpdateIntegrationEndpointDto,
} from './dto/integration-endpoint.dto';

interface EndpointRow {
  id: string;
  companyId: string;
  integrationId: string;
  action: string;
  baseUrl: string;
  endpointId: string;
  apiKeyEnc: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * แท็บ "Endpoint ที่เราเรียก" ของหน้า Integrations — ปลายทางที่ CTD ส่งงานของ
 * agent ไป (27 ต.ค. 2569). ผูกบริษัทที่ใช้งานอยู่; ของบริษัทอื่นตอบ 404 (SCOPE-03).
 * key ออกจากระบบเฉพาะ `GET :id/key` และไม่เคยอยู่ใน audit — แบบเดียวกับ webhook secret.
 */
@Injectable()
export class IntegrationEndpointsAdminService {
  constructor(
    private readonly endpoints: IntegrationEndpointRepository,
    private readonly integrations: IntegrationAdminService,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
  ) {}

  async list(
    integrationId: string,
    actor: Principal,
  ): Promise<IntegrationEndpointRowDto[]> {
    await this.integrations.owned(integrationId, actor);
    const rows = (await this.endpoints.findMany({
      where: { companyId: actor.activeCompanyId, integrationId },
      orderBy: { createdAt: 'asc' },
    })) as EndpointRow[];
    return rows.map(toRow);
  }

  async create(
    dto: CreateIntegrationEndpointDto,
    actor: Principal,
  ): Promise<IntegrationEndpointRowDto> {
    const integration = await this.integrations.owned(
      dto.integration_id,
      actor,
    );
    await this.assertUrl(dto.base_url);

    const taken = await this.endpoints.findFirst({
      where: { companyId: actor.activeCompanyId, action: dto.action },
      select: { id: true },
    });
    if (taken) {
      throw new AppError(
        'CONFLICT',
        `งาน ${dto.action} มี endpoint แล้ว — แก้ที่แถวเดิม`,
        [{ field: 'action', reason: 'taken' }],
      );
    }

    const row = (await this.endpoints.create({
      data: {
        companyId: actor.activeCompanyId,
        integrationId: integration.id,
        action: dto.action,
        baseUrl: dto.base_url.trim(),
        endpointId: dto.endpoint_id,
        apiKeyEnc: this.seal(dto.api_key.trim()),
        createdBy: actor.userId,
      },
    })) as EndpointRow;
    await this.record('created', row, actor);
    return toRow(row);
  }

  async update(
    id: string,
    dto: UpdateIntegrationEndpointDto,
    actor: Principal,
  ): Promise<IntegrationEndpointRowDto> {
    await this.owned(id, actor);
    if (dto.base_url !== undefined) await this.assertUrl(dto.base_url);

    const row = (await this.endpoints.update({
      where: { id },
      data: {
        ...(dto.base_url !== undefined && { baseUrl: dto.base_url.trim() }),
        ...(dto.endpoint_id !== undefined && { endpointId: dto.endpoint_id }),
        ...(dto.api_key !== undefined && {
          apiKeyEnc: this.seal(dto.api_key.trim()),
        }),
        ...(dto.active !== undefined && { active: dto.active }),
      },
    })) as EndpointRow;
    await this.record('updated', row, actor, {
      keyChanged: dto.api_key !== undefined,
    });
    return toRow(row);
  }

  /** `x-api-key` ปัจจุบัน — ทุกครั้งที่ดูลง audit (ไม่มีตัว key ในนั้น). */
  async revealKey(id: string, actor: Principal): Promise<{ api_key: string }> {
    const found = await this.owned(id, actor);
    const apiKey = openSecret(found.apiKeyEnc, this.sealKey());
    if (apiKey === null) {
      throw new AppError(
        'UNPROCESSABLE',
        'ถอดรหัส x-api-key ไม่ได้ — CONFIG_SECRET_KEY อาจถูกเปลี่ยน ให้ใส่ key ใหม่',
      );
    }
    await this.record('key_revealed', found, actor);
    return { api_key: apiKey };
  }

  private async owned(id: string, actor: Principal): Promise<EndpointRow> {
    const found = (await this.endpoints.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    })) as EndpointRow | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบ endpoint ที่ระบุ');
    return found;
  }

  /** The webhook rule: https only (http for `WEBHOOK_PRIVATE_HOSTS`), never an inside address. */
  private async assertUrl(url: string): Promise<void> {
    const privateHosts =
      this.config.get<string[]>('webhook.privateHosts') ?? [];
    const shape = urlProblems(url.trim(), privateHosts);
    const problems = shape.length
      ? shape
      : await addressProblems(url.trim(), privateHosts);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'base_url', reason })),
      );
    }
  }

  private record(
    what: 'created' | 'updated' | 'key_revealed',
    row: EndpointRow,
    actor: Principal,
    extra: Record<string, boolean> = {},
  ) {
    return this.audit.record({
      eventType: `admin.integration_endpoint.${what}`,
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'integration_endpoint',
      resourceId: row.id,
      after: {
        action: row.action,
        baseUrl: row.baseUrl,
        endpointId: row.endpointId,
        active: row.active,
        ...extra,
      },
    });
  }

  private seal(secret: string): string {
    return sealSecret(secret, this.sealKey());
  }

  private sealKey(): string {
    const key = this.config.get<string>('projectConfig.secret');
    if (!key) throw new Error('CONFIG_SECRET_KEY is not set');
    return key;
  }
}

function toRow(row: EndpointRow): IntegrationEndpointRowDto {
  return {
    id: row.id,
    integration_id: row.integrationId,
    action: row.action,
    base_url: row.baseUrl,
    endpoint_id: row.endpointId,
    active: row.active,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
