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
import { AGENT_ACTIONS, isAgentAction, type AgentAction } from './agent-actions';
import { timeoutMinutesOf } from './outbound-connection';
import { OutboundConnectionRepository } from './outbound-connection.repository';
import { VuvagentClient } from './vuvagent.client';
import type {
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
  /** null only on a row the per-action migration could not place; never listed */
  action: string | null;
  baseUrl: string;
  secretEnc: string;
  endpointId: string | null;
  timeoutMinutes: number | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * แท็บ "การเชื่อมต่อที่เราเรียก" ของหน้า Integrations — หนึ่งแถวต่อหนึ่งงาน เพราะที่
 * Vuvagent หนึ่งงานคือหนึ่ง agent มี URL, key, endpoint และ timeout ของตัวเอง (31 ต.ค. 2569).
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
      where: {
        companyId: actor.activeCompanyId,
        integrationId,
        action: { not: null },
      },
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
    const action = dto.action as AgentAction; // `@IsIn(ACTIONS)` narrowed it

    const taken = await this.connections.findFirst({
      where: { companyId: actor.activeCompanyId, action },
      select: { id: true },
    });
    if (taken) {
      throw new AppError(
        'CONFLICT',
        `บริษัทนี้มีการเชื่อมต่อของงาน ${action} แล้ว — แก้ที่กล่องเดิม`,
        [{ field: 'action', reason: 'taken' }],
      );
    }

    const row = (await this.connections.create({
      data: {
        companyId: actor.activeCompanyId,
        integrationId: integration.id,
        vendor: AGENT_ACTIONS[action].vendor,
        action,
        baseUrl: dto.base_url.trim(),
        secretEnc: this.seal(dto.api_key.trim()),
        endpointId: dto.endpoint_id,
        timeoutMinutes: dto.timeout_minutes ?? null,
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
    await this.owned(id, actor);
    if (dto.base_url !== undefined) await this.assertUrl(dto.base_url);

    const row = (await this.connections.update({
      where: { id },
      data: {
        ...(dto.base_url !== undefined && { baseUrl: dto.base_url.trim() }),
        ...(dto.api_key !== undefined && {
          secretEnc: this.seal(dto.api_key.trim()),
        }),
        ...(dto.endpoint_id !== undefined && { endpointId: dto.endpoint_id }),
        ...(dto.timeout_minutes !== undefined && {
          timeoutMinutes: dto.timeout_minutes,
        }),
        ...(dto.active !== undefined && { active: dto.active }),
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
  async test(id: string, actor: Principal): Promise<ConnectionTestResultDto> {
    const found = await this.owned(id, actor);
    const result = await this.vuvagent.test(found);
    await this.record('tested', found, actor, { ok: result.ok });
    return result;
  }

  private async owned(id: string, actor: Principal): Promise<ConnectionRow> {
    const found = (await this.connections.findFirst({
      where: { id, companyId: actor.activeCompanyId, action: { not: null } },
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
        action: row.action,
        baseUrl: row.baseUrl,
        endpointId: row.endpointId,
        timeoutMinutes: row.timeoutMinutes,
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

function toRow(row: ConnectionRow): OutboundConnectionRowDto {
  // `list`/`owned` read only rows with an action; an unknown one has no default timeout
  const action = row.action ?? '';
  return {
    id: row.id,
    integration_id: row.integrationId,
    vendor: row.vendor,
    action,
    base_url: row.baseUrl,
    endpoint_id: row.endpointId ?? '',
    timeout_minutes: isAgentAction(action)
      ? timeoutMinutesOf(action, row.timeoutMinutes)
      : (row.timeoutMinutes ?? 0),
    active: row.active,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
