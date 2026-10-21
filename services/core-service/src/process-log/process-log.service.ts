import { Injectable } from '@nestjs/common';
import { Prisma, type ProcessFlowLog } from '@prisma/client';
import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import type { ApiKeyContext } from '../principal/api-key.service';
import {
  CreateProcessLogDto,
  ProcessLogPageDto,
  ProcessLogQueryDto,
  ProcessLogRowDto,
} from './dto/process-log.dto';
import { stageOf } from './process-stages';
import { ProcessFlowLogRepository } from './process-log.repository';

const MAX_PAYLOAD_BYTES = 16 * 1024;

/**
 * บันทึกการเดินของกระบวนการ 7 ขั้น — OSD Workflow เป็นผู้เขียน หน้าจอเป็นผู้อ่าน.
 *
 * "Workflow owns Process, Core owns Data": core ไม่ตัดสินว่าขั้นถัดไปคืออะไร
 * มันแค่เก็บว่า workflow บอกว่าเกิดอะไรขึ้น ตรวจเพียงว่าเลขขั้นมีจริง.
 */
@Injectable()
export class ProcessLogService {
  constructor(private readonly logs: ProcessFlowLogRepository) {}

  /** Workflow → core. The key's company wins over anything the caller says. */
  async record(
    dto: CreateProcessLogDto,
    principal: Principal,
    key: ApiKeyContext | undefined,
  ): Promise<ProcessLogRowDto> {
    const companyId = key?.companyId ?? principal.activeCompanyId;
    if (!companyId) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ไม่ทราบบริษัท — ผูกบริษัทกับ API key หรือส่ง X-Company-Id',
        [{ field: 'X-Company-Id', reason: 'required' }],
      );
    }

    const stage = stageOf(dto.stage_no);
    if (!stage) {
      throw new AppError('VALIDATION_FAILED', 'ไม่มีขั้นนี้ในกระบวนการ', [
        { field: 'stage_no', reason: 'unknown' },
      ]);
    }

    if (
      dto.payload &&
      Buffer.byteLength(JSON.stringify(dto.payload)) > MAX_PAYLOAD_BYTES
    ) {
      throw new AppError('VALIDATION_FAILED', 'payload ใหญ่เกิน 16 KB', [
        { field: 'payload', reason: 'too_large' },
      ]);
    }

    const eventId = dto.event_id?.trim() || null;
    if (eventId) {
      const existing = await this.logs.findFirst({
        where: { companyId, eventId },
      });
      if (existing) return toRow(existing);
    }

    try {
      const row = await this.logs.create({
        data: {
          companyId,
          eventId,
          instanceId: dto.instance_id,
          workflowKey: dto.workflow_key,
          stageNo: stage.no,
          stageCode: stage.code,
          teamCode: stage.team,
          stepCode: dto.step_code,
          stepName: dto.step_name ?? null,
          status: dto.status,
          decision: dto.decision ?? null,
          refType: dto.ref_type ?? null,
          refNo: dto.ref_no ?? null,
          actorEmail: dto.actor_email?.toLowerCase() ?? null,
          actorName: dto.actor_name ?? null,
          comment: dto.comment ?? null,
          payload: (dto.payload as Prisma.InputJsonValue) ?? Prisma.JsonNull,
          occurredAt: dto.occurred_at ? new Date(dto.occurred_at) : new Date(),
          apiKeyPrefix: key?.prefix ?? null,
        },
      });
      return toRow(row);
    } catch (error) {
      // two retries racing on the same event_id — the loser answers the winner
      if (
        eventId &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.logs.findFirst({
          where: { companyId, eventId },
        });
        if (existing) return toRow(existing);
      }
      throw error;
    }
  }

  /** Screen and external read — always pinned to the active company. */
  async list(
    query: ProcessLogQueryDto,
    companyId: string,
  ): Promise<ProcessLogPageDto> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 50;
    const where: Prisma.ProcessFlowLogWhereInput = {
      companyId,
      ...(query.instance_id ? { instanceId: query.instance_id } : {}),
      ...(query.stage_no ? { stageNo: query.stage_no } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.ref_no
        ? { refNo: { contains: query.ref_no, mode: 'insensitive' } }
        : {}),
      ...(query.from || query.to
        ? {
            occurredAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.logs.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.logs.count({ where }),
    ]);

    return { data: rows.map(toRow), total, page, page_size: pageSize };
  }
}

function toRow(row: ProcessFlowLog): ProcessLogRowDto {
  return {
    id: row.id,
    event_id: row.eventId,
    instance_id: row.instanceId,
    workflow_key: row.workflowKey,
    stage_no: row.stageNo,
    stage_code: row.stageCode,
    stage_name: stageOf(row.stageNo)?.name ?? row.stageCode,
    team_code: row.teamCode,
    step_code: row.stepCode,
    step_name: row.stepName,
    status: row.status,
    decision: row.decision,
    ref_type: row.refType,
    ref_no: row.refNo,
    actor_email: row.actorEmail,
    actor_name: row.actorName,
    comment: row.comment,
    payload: row.payload,
    occurred_at: row.occurredAt.toISOString(),
    created_at: row.createdAt.toISOString(),
  };
}
