import { Injectable } from '@nestjs/common';
import { AppError, auditActor, AuditWriter } from '@request-management/share';
import type { Principal } from '@request-management/share';
import type { Delegation } from '@prisma/client';
import { DelegationRepository } from './delegation.repository';
import { CreateDelegationDto } from './dto/approval.dto';

/**
 * APV-03 — temporary delegation.
 *
 * The window is the whole point: a delegation that never expires is just a
 * permanent grant wearing a different name, and the history would stop showing
 * who was really accountable.
 */
@Injectable()
export class DelegationsService {
  constructor(
    private readonly delegations: DelegationRepository,
    private readonly audit: AuditWriter,
  ) {}

  list(actor: Principal): Promise<Delegation[]> {
    return this.delegations.findForCompany(actor.activeCompanyId);
  }

  async create(
    dto: CreateDelegationDto,
    actor: Principal,
  ): Promise<Delegation> {
    const from = new Date(dto.from_date);
    const to = new Date(dto.to_date);

    if (to < from) {
      throw new AppError('VALIDATION_FAILED', 'ช่วงวันที่ไม่ถูกต้อง', [
        { field: 'to_date', reason: 'before from_date' },
      ]);
    }

    if (dto.delegate_user_id === actor.userId) {
      throw new AppError('VALIDATION_FAILED', 'มอบอำนาจให้ตัวเองไม่ได้', [
        { field: 'delegate_user_id', reason: 'self' },
      ]);
    }

    // APV-03: no sub-delegation. Someone already covering for another person
    // cannot pass that on — otherwise authority travels arbitrarily far from
    // the person who actually holds it, and nobody can answer who approved.
    const alreadyCovering = await this.delegations.isActingAsDelegate(
      actor.activeCompanyId,
      actor.userId,
      new Date(),
    );

    if (alreadyCovering) {
      throw new AppError(
        'APV_NO_SUBDELEGATION',
        'ผู้ที่รับมอบอำนาจอยู่ ไม่สามารถมอบอำนาจต่อได้',
      );
    }

    const created = await this.delegations.create({
      data: {
        companyId: actor.activeCompanyId,
        delegatorUserId: actor.userId,
        delegateUserId: dto.delegate_user_id,
        fromDate: from,
        toDate: to,
        note: dto.note ?? null,
        createdBy: actor.userId,
      },
    });

    await this.audit.record({
      eventType: 'approval.delegation.created',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'delegation',
      resourceId: created.id,
      after: {
        delegateUserId: dto.delegate_user_id,
        fromDate: dto.from_date,
        toDate: dto.to_date,
      },
    });

    return created;
  }

  /** Revoked, never deleted — the history of who could act must survive. */
  async revoke(id: string, actor: Principal): Promise<void> {
    const found = await this.delegations.findUnique({ where: { id } });

    if (!found || found.companyId !== actor.activeCompanyId) {
      throw new AppError('NOT_FOUND', 'ไม่พบการมอบอำนาจที่ระบุ');
    }

    if (found.delegatorUserId !== actor.userId) {
      throw new AppError(
        'FORBIDDEN',
        'เพิกถอนได้เฉพาะการมอบอำนาจของตนเองเท่านั้น',
      );
    }

    await this.delegations.update({
      where: { id },
      data: { active: false, revokedAt: new Date() },
    });

    await this.audit.record({
      eventType: 'approval.delegation.revoked',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'delegation',
      resourceId: id,
      before: { delegateUserId: found.delegateUserId, active: true },
    });
  }
}
