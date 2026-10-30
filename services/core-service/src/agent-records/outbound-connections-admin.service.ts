import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  type Principal,
} from '@request-management/share';
import { openSecret, sealSecret } from '../pm/config-rules';
import { IntegrationAdminService } from '../principal/integration-admin.service';
import { addressProblems, urlProblems } from '../webhook/webhook-rules';
import { AGENT_ACTIONS, type AgentAction } from './agent-actions';
import { parseEndpoints } from './outbound-connection';
import { OutboundConnectionRepository } from './outbound-connection.repository';
import { VuvagentClient } from './vuvagent.client';
import type {
  ActionEndpointDto,
  AgentActionInfoDto,
  ConnectionTestResultDto,
  CreateOutboundConnectionDto,
  OutboundConnectionRowDto,
  UpdateOutboundConnectionDto,
} from './dto/outbound-connection.dto';

interface ConnectionRow {
  id: string;
  companyId: string;
  integrationId: string;
  vendor: string;
  baseUrl: string;
  secretEnc: string;
  endpoints: unknown;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * แท็บ "การเชื่อมต่อที่เราเรียก" ของหน้า Integrations (30 ต.ค. 2569) — URL และ key
 * ของ vendor ตั้งครั้งเดียว, งานแต่ละงานเลือก endpoint และ timeout ของตัวเอง.
 * ผูกบริษัทที่ใช้งานอยู่; ของบริษัทอื่นตอบ 404 (SCOPE-03). key ออกจากระบบเฉพาะ
 * `GET :id/key` และไม่เคยอยู่ใน audit — แบบเดียวกับ webhook secret.
 */
@Injectable()
export class OutboundConnectionsAdminService {
  constructor(
    private readonly connections: OutboundConnectionRepository,
    private readonly integrations: IntegrationAdminService,
    private readonly vuvagent: VuvagentClient,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
  ) {}

  actions(): AgentActionInfoDto[] {
    return (Object.keys(AGENT_ACTIONS) as AgentAction[]).map((action) => ({
      action,
      vendor: AGENT_ACTIONS[action].vendor,
      payload_fields: [...AGENT_ACTIONS[action].payloadFields],
      default_timeout_minutes: AGENT_ACTIONS[action].defaultTimeoutMinutes,
    }));
  }

  async list(
    integrationId: string,
    actor: Principal,
  ): Promise<OutboundConnectionRowDto[]> {
    await this.integrations.owned(integrationId, actor);
    const rows = (await this.connections.findMany({
      where: { companyId: actor.activeCompanyId, integrationId },
      orderBy: { createdAt: 'asc' },
    })) as ConnectionRow[];
    return rows.map(toRow);
  }

  async create(
    dto: CreateOutboundConnectionDto,
    actor: Principal,
  ): Promise<OutboundConnectionRowDto> {
    const integration = await this.integrations.owned(
      dto.integration_id,
      actor,
    );
    await this.assertUrl(dto.base_url);
    const endpoints = toEndpointsJson(dto.endpoints ?? [], dto.vendor);

    const taken = await this.connections.findFirst({
      where: { companyId: actor.activeCompanyId, vendor: dto.vendor },
      select: { id: true },
    });
    if (taken) {
      throw new AppError(
        'CONFLICT',
        `บริษัทนี้มีการเชื่อมต่อ ${dto.vendor} แล้ว — แก้ที่แถวเดิม`,
        [{ field: 'vendor', reason: 'taken' }],
      );
    }

    const row = (await this.connections.create({
      data: {
        companyId: actor.activeCompanyId,
        integrationId: integration.id,
        vendor: dto.vendor,
        baseUrl: dto.base_url.trim(),
        secretEnc: this.seal(dto.api_key.trim()),
        endpoints,
        createdBy: actor.userId,
      },
    })) as ConnectionRow;
    await this.record('created', row, actor);
    return toRow(row);
  }

  async update(
    id: string,
    dto: UpdateOutboundConnectionDto,
    actor: Principal,
  ): Promise<OutboundConnectionRowDto> {
    const found = await this.owned(id, actor);
    if (dto.base_url !== undefined) await this.assertUrl(dto.base_url);

    const row = (await this.connections.update({
      where: { id },
      data: {
        ...(dto.base_url !== undefined && { baseUrl: dto.base_url.trim() }),
        ...(dto.api_key !== undefined && {
          secretEnc: this.seal(dto.api_key.trim()),
        }),
        ...(dto.active !== undefined && { active: dto.active }),
        ...(dto.endpoints !== undefined && {
          endpoints: toEndpointsJson(dto.endpoints, found.vendor),
        }),
      },
    })) as ConnectionRow;
    await this.record('updated', row, actor, {
      keyChanged: dto.api_key !== undefined,
    });
    return toRow(row);
  }

  /** `x-api-key` ปัจจุบัน — ทุกครั้งที่ดูลง audit (ไม่มีตัว key ในนั้น). */
  async revealKey(id: string, actor: Principal): Promise<{ api_key: string }> {
    const found = await this.owned(id, actor);
    const apiKey = openSecret(found.secretEnc, this.sealKey());
    if (apiKey === null) {
      throw new AppError(
        'UNPROCESSABLE',
        'ถอดรหัส x-api-key ไม่ได้ — CONFIG_SECRET_KEY อาจถูกเปลี่ยน ให้ใส่ key ใหม่',
      );
    }
    await this.record('key_revealed', found, actor);
    return { api_key: apiKey };
  }

  /** Calls the vendor for real — the result is shown, and audited without the key. */
  async test(
    id: string,
    action: AgentAction,
    actor: Principal,
  ): Promise<ConnectionTestResultDto> {
    const found = await this.owned(id, actor);
    if (AGENT_ACTIONS[action].vendor !== found.vendor) {
      throw new AppError(
        'VALIDATION_FAILED',
        `งาน ${action} ไม่ได้ใช้การเชื่อมต่อ ${found.vendor}`,
        [{ field: 'action', reason: 'vendor' }],
      );
    }
    const result = await this.vuvagent.test(found, action);
    await this.record('tested', found, actor, { ok: result.ok });
    return result;
  }

  private async owned(id: string, actor: Principal): Promise<ConnectionRow> {
    const found = (await this.connections.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    })) as ConnectionRow | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบการเชื่อมต่อที่ระบุ');
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
    what: 'created' | 'updated' | 'key_revealed' | 'tested',
    row: ConnectionRow,
    actor: Principal,
    extra: Record<string, boolean> = {},
  ) {
    return this.audit.record({
      eventType: `admin.outbound_connection.${what}`,
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'outbound_connection',
      resourceId: row.id,
      after: {
        vendor: row.vendor,
        baseUrl: row.baseUrl,
        endpoints: row.endpoints as Prisma.InputJsonValue,
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

/** The list the screen sends, stored keyed by action; another vendor's action is refused. */
function toEndpointsJson(
  list: ActionEndpointDto[],
  vendor: string,
): Prisma.InputJsonObject {
  const json: Record<string, Prisma.InputJsonObject> = {};
  for (const item of list) {
    const action = item.action as AgentAction;
    if (AGENT_ACTIONS[action].vendor !== vendor) {
      throw new AppError(
        'VALIDATION_FAILED',
        `งาน ${action} ไม่ได้ใช้การเชื่อมต่อ ${vendor}`,
        [{ field: 'endpoints', reason: action }],
      );
    }
    json[action] = {
      endpointId: item.endpoint_id,
      timeoutMinutes: item.timeout_minutes,
    };
  }
  return json;
}

function toRow(row: ConnectionRow): OutboundConnectionRowDto {
  return {
    id: row.id,
    integration_id: row.integrationId,
    vendor: row.vendor,
    base_url: row.baseUrl,
    active: row.active,
    endpoints: Object.entries(parseEndpoints(row.endpoints)).map(
      ([action, endpoint]) => ({
        action,
        endpoint_id: endpoint.endpointId,
        timeout_minutes: endpoint.timeoutMinutes,
      }),
    ),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
