import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  salesAccessSubject,
  visibleSalesWhere,
} from '@request-management/share';
import { ApplyLeadStageDto } from './dto/lead-workflow.dto';
import { LeadStatusService } from './lead-status.service';
import { LeadActivityRepository, LeadRepository } from './sales.repositories';

/**
 * สิ่งที่ workflow engine (`lwf-0001` บน OSD Workflow) เรียกเข้ามา — สองอย่าง
 * เท่านั้น: **อ่านข้อเท็จจริง** และ **บันทึกขั้นที่มันตัดสินใจแล้ว**.
 *
 * PO 10 ก.ย. 2569 — "Workflow owns Process, Core owns Data":
 *
 * - *Process* คือคำถามว่า "เลื่อนจากขั้นนี้ไปขั้นนั้นได้ไหม" — อยู่บน workflow
 *   ทั้งหมด ไฟล์นี้ไม่ถาม ไม่รู้ ไม่มีตารางเงื่อนไข ไม่มี state machine.
 * - *Data* คือแถว Lead กับกิจกรรมของมัน — core เป็นเจ้าของ และยังบังคับความ
 *   ถูกต้องของข้อมูลอยู่: ขอบบริษัท (SCOPE-03), row scope (SCOPE-02), รหัส
 *   สถานะต้องมีจริงในบริษัทนั้น, เขียนทับ Lead ที่ปิดแล้วไม่ได้, audit ทุกครั้ง.
 *
 * เส้นนี้สำคัญตรงที่ว่า **การปฏิเสธของ `applyStage` ไม่ใช่การตัดสินเชิงกฎ** —
 * มันคือการบอกว่าคำสั่งนั้นเขียนลงข้อมูลไม่ได้ ถ้าวันหนึ่ง workflow อยากให้
 * Lead เดินถอยหลัง หรือข้ามขั้น หรือมีสิบขั้น core จะยอมทั้งหมดโดยไม่ต้องแก้
 * ไฟล์นี้เลย. เพิ่มเงื่อนไขเชิงกฎลงที่นี่เมื่อไร = มี process สองที่เมื่อนั้น.
 */
@Injectable()
export class LeadWorkflowService {
  constructor(
    private readonly leads: LeadRepository,
    private readonly activities: LeadActivityRepository,
    private readonly statuses: LeadStatusService,
    private readonly audit: AuditWriter,
  ) {}

  /**
   * ข้อเท็จจริงที่ Decision node ทดสอบ — node "System action" ตัวแรกของ
   * `lwf-0001` เรียกอันนี้ แล้ว map ออกเป็นตัวแปรของ workflow.
   *
   * `completed_activity_count` นับเฉพาะกิจกรรมที่ `completedAt` ไม่ว่าง:
   * กิจกรรมที่มีกำหนดแต่ยังไม่ติ๊กเสร็จคือ *นัดไว้* ยังไม่ได้คุย. ตรงนี้เป็น
   * นิยามของ **ข้อมูล** (กิจกรรมไหนถือว่าทำแล้ว) ไม่ใช่กฎ (ต้องมีกี่รายการถึง
   * ผ่าน) — จำนวนขั้นต่ำอยู่ในเงื่อนไขบน workflow.
   */
  async facts(id: string, actor: Principal) {
    const lead = await this.requireVisible(id, actor);
    const status = await this.statuses.require(
      actor.activeCompanyId,
      lead.status,
    );

    const completed = await this.activities.count({
      where: { leadId: id, completedAt: { not: null } },
    });

    const pending = await this.activities.count({
      where: { leadId: id, completedAt: null },
    });

    return {
      lead_id: lead.id,
      company_id: lead.companyId,
      name: lead.name,
      status: status.code,
      status_kind: status.kind,
      /** ยังทำงานต่อได้ — ปลายทาง (`won`/`lost`) ถือว่าปิดแล้ว. */
      open: status.kind === 'open',
      completed_activity_count: completed,
      pending_activity_count: pending,
      owner_user_id: lead.ownerUserId,
      converted_opportunity_id: lead.convertedOpportunityId,
    };
  }

  /**
   * บันทึกขั้นที่ workflow ตัดสินใจแล้ว.
   *
   * Idempotent: สั่งซ้ำด้วยขั้นเดิมไม่เขียนอะไรและไม่ลง audit ซ้ำ — HTTP task
   * ของ Flowable retry ได้ และการ retry ต้องไม่สร้างประวัติปลอม.
   */
  async applyStage(id: string, dto: ApplyLeadStageDto, actor: Principal) {
    const lead = await this.requireVisible(id, actor);

    const current = await this.statuses.require(
      actor.activeCompanyId,
      lead.status,
    );
    if (current.kind !== 'open') {
      throw new AppError(
        'CONFLICT',
        `Lead นี้ปิดแล้ว (${current.nameTh}) — เขียนสถานะทับไม่ได้`,
        [{ field: 'status', reason: current.code }],
      );
    }

    const target = await this.statuses.require(
      actor.activeCompanyId,
      dto.stage,
    );

    /*
      ปลายทางถูกกันไว้เพราะ **ข้อมูล** ไม่ครบ ไม่ใช่เพราะกฎ: `won` ต้องมีโอกาส
      การขายที่เกิดขึ้นจริงผูกไว้ และ `lost` ต้องมีเหตุผล — ทั้งสองอย่างเกิดจาก
      `convert`/`disqualify` ซึ่งเขียนคอลัมน์อื่นพร้อมกันในทรานแซกชันเดียว.
      ถ้าปล่อยให้เลื่อนเข้ามาตรง ๆ จะได้ Lead ที่ปิดแล้วโดยไม่มีอะไรอธิบาย.
    */
    if (target.kind !== 'open') {
      throw new AppError(
        'CONFLICT',
        `สถานะ "${target.nameTh}" เป็นปลายทาง — ต้องมาจากการแปลงเป็นโอกาสการขายหรือคัดออก`,
        [{ field: 'stage', reason: target.kind }],
      );
    }

    if (!target.active) {
      throw new AppError(
        'CONFLICT',
        `สถานะ "${target.nameTh}" ถูกปิดใช้งานอยู่`,
        [{ field: 'stage', reason: 'inactive' }],
      );
    }

    if (lead.status === target.code) {
      return { lead_id: lead.id, status: target.code, changed: false };
    }

    await this.leads.update({
      where: { id },
      data: { status: target.code, updatedBy: actor.userId },
    });

    await this.audit.record({
      eventType: 'crm.lead.stage_applied',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'lead',
      resourceId: id,
      before: { status: lead.status },
      after: {
        status: target.code,
        instanceId: dto.instance_id ?? null,
        reason: dto.reason ?? null,
      },
    });

    return { lead_id: lead.id, status: target.code, changed: true };
  }

  /**
   * SCOPE-02/03 — ผ่านตัวกรองเดียวกับทุกหน้าจอ (non-negotiable ข้อ 2) และ
   * มองไม่เห็น = 404 ไม่ใช่ 403 (ข้อ 3). service account ของ workflow ถือ
   * `crm.sales.read.all` จึงเห็นทั้งบริษัท โดยไม่ต้องมีสาขาพิเศษในตัวกรอง.
   */
  private async requireVisible(id: string, actor: Principal) {
    const found = (await this.leads.findFirst({
      where: {
        id,
        AND: [visibleSalesWhere(salesAccessSubject(actor))],
      },
    })) as {
      id: string;
      companyId: string;
      name: string;
      status: string;
      /** null = กองกลาง — ใบที่ระบบภายนอกยิงเข้ามาและยังไม่มีใครรับ. */
      ownerUserId: string | null;
      convertedOpportunityId: string | null;
    } | null;

    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบ Lead ที่ระบุ');
    return found;
  }
}
