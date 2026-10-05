import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  hasPermission,
  Principal,
} from '@request-management/share';
import { NotificationsService } from '../notifications/notifications.service';
import { ProjectMilestoneRepository } from '../pm/project.repositories';
import { ReadinessService } from '../pm/readiness.service';
import { DeliveriesService } from './deliveries.service';
import {
  DeliveryPeopleRepository,
  ProjectDeliveryRepository,
  ProjectInstallConfirmationRepository,
} from './delivery.repositories';
import { installBlockers } from './install-rules';

/**
 * CD-254 ยืนยันงานติดตั้งเสร็จ (part of CD-20 Delivery).
 *
 * The project's manager (or `pm.project.manage`) confirms a phase's
 * installation complete once the technicians' readiness check passes
 * (CD-225, the delivery documents aside); that tells the delivery team to
 * prepare the acceptance, and is itself one of the readiness checks for the
 * next phase — so acceptance (CD-189) cannot be booked before it. It can be
 * taken back, with a reason, until the phase is achieved.
 */
@Injectable()
export class InstallConfirmationsService {
  constructor(
    private readonly deliveries: DeliveriesService,
    private readonly readiness: ReadinessService,
    private readonly confirmations: ProjectInstallConfirmationRepository,
    private readonly trips: ProjectDeliveryRepository,
    private readonly milestones: ProjectMilestoneRepository,
    private readonly people: DeliveryPeopleRepository,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
  ) {}

  /** What stands in the way now (for the screen, before pressing). */
  async gate(actor: Principal, projectId: string) {
    const { project } = await this.deliveries.access(actor, projectId);
    const state = await this.readiness.state(projectId, project.companyId);
    return { blockers: installBlockers(state) };
  }

  async confirm(
    actor: Principal,
    projectId: string,
    milestoneId: string,
    note: string,
  ) {
    const { project } = await this.deliveries.access(actor, projectId);
    this.assertManager(actor, project);
    const milestone = await this.phase(projectId, milestoneId);
    if (await this.confirmations.count({ where: { milestoneId } })) {
      throw new AppError('CONFLICT', 'ยืนยันติดตั้งเสร็จของเฟสนี้แล้ว');
    }
    const state = await this.readiness.state(projectId, project.companyId);
    const blockers = installBlockers(state);
    if (blockers.length) {
      throw new AppError(
        'CONFLICT',
        `ยังยืนยันไม่ได้ — ${blockers[0]}`,
        blockers.map((reason) => ({ field: 'readiness', reason })),
      );
    }
    await this.confirmations.create({
      data: {
        companyId: project.companyId,
        projectId,
        milestoneId,
        note: note.trim(),
        checks: state.checks.map((c) => ({ key: c.key, ok: c.ok })),
        confirmedBy: actor.userId,
      },
    });
    await this.audit.record({
      eventType: 'delivery.install_confirmed',
      companyId: project.companyId,
      ...auditActor(actor),
      resourceType: 'project',
      resourceId: projectId,
      after: { milestoneId, note: note.trim() },
    });
    const team = await this.people.holdersOf(
      project.companyId,
      'delivery.manage',
    );
    const label = `${project.projectNo} · ${project.name}`;
    for (const userId of new Set([project.managerUserId, ...team])) {
      if (userId === actor.userId) continue;
      await this.notifications.deliveryInstalled(
        userId,
        project.companyId,
        { id: project.id, label },
        `${milestone.seq}. ${milestone.title}`,
        actor.displayName ?? actor.userId,
      );
    }
    return { milestoneId, confirmed: true };
  }

  async revoke(
    actor: Principal,
    projectId: string,
    milestoneId: string,
    reason: string,
  ) {
    const { project } = await this.deliveries.access(actor, projectId);
    this.assertManager(actor, project);
    const milestone = await this.phase(projectId, milestoneId);
    if (!reason.trim()) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ต้องระบุเหตุผลที่ยกเลิกการยืนยัน',
      );
    }
    const found = await this.confirmations.findFirst({
      where: { milestoneId },
    });
    if (!found)
      throw new AppError('NOT_FOUND', 'เฟสนี้ยังไม่ได้ยืนยันติดตั้งเสร็จ');
    await this.confirmations.delete({ where: { milestoneId } });
    await this.audit.record({
      eventType: 'delivery.install_revoked',
      companyId: project.companyId,
      ...auditActor(actor),
      resourceType: 'project',
      resourceId: projectId,
      before: { milestoneId, phase: milestone.title },
      after: { reason: reason.trim() },
    });
    return { milestoneId, confirmed: false };
  }

  // --- helpers ----------------------------------------------------------------

  private assertManager(
    actor: Principal,
    project: { status: string; managerUserId: string },
  ) {
    const running = project.status === 'active' || project.status === 'on_hold';
    if (
      !running ||
      !(
        hasPermission(actor, 'pm.project.manage') ||
        project.managerUserId === actor.userId
      )
    ) {
      throw new AppError(
        'FORBIDDEN',
        'ยืนยันติดตั้งเสร็จได้เฉพาะผู้จัดการโครงการ ขณะโครงการดำเนินอยู่',
      );
    }
  }

  /** A phase of the project that is still open and has a delivery trip. */
  private async phase(projectId: string, milestoneId: string) {
    const milestone = (await this.milestones.findFirst({
      where: { id: milestoneId, projectId },
      select: { id: true, seq: true, title: true, status: true },
    })) as { id: string; seq: number; title: string; status: string } | null;
    if (!milestone || milestone.status === 'cancelled') {
      throw new AppError('NOT_FOUND', 'ไม่พบเฟส (หมุดหมาย) ที่ระบุ');
    }
    if (milestone.status === 'achieved') {
      throw new AppError('CONFLICT', 'เฟสนี้บรรลุแล้ว');
    }
    if (
      !(await this.trips.count({
        where: { milestoneId, status: { not: 'cancelled' } },
      }))
    ) {
      throw new AppError('CONFLICT', 'เฟสนี้ยังไม่มีรอบส่งของในแผนส่งมอบ');
    }
    return milestone;
  }
}
