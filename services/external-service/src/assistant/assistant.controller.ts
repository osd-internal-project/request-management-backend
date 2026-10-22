import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ActingPermissions,
  CurrentPrincipal,
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { ActsForPerson } from '../auth/acts-for-person.decorator';
import {
  AssistantArticlesQueryDto,
  ClosingDealsQueryDto,
  ProjectsAtRiskQueryDto,
  ServiceJobsQueryDto,
  SilentDealsQueryDto,
} from './assistant.dto';
import { AssistantService } from './assistant.service';

/**
 * CD-276 — the personal assistant's questions, one route each.
 *
 * Question-shaped rather than table-shaped on purpose: a model offered
 * "deals closing soon" picks it, where offered a list route with nine
 * filters it guesses at the filters. Read-only. Each route asks the person
 * for the permission of the screen that shows the same thing; the summary
 * asks `notification.read` (every role) and leaves out the sections the
 * person has no screen for.
 */
@ApiTags('assistant')
@Controller('assistant')
@ActsForPerson()
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @ApiOperation({
    summary: 'ตัวเลขสรุปของฉัน',
    description:
      'ภาพรวมของผู้ถามในคำตอบเดียว — คำขอค้าง/เลย SLA, งานรออนุมัติ, Lead/ดีล/กิจกรรมของฉัน, ' +
      'ดีลคาดปิดใน 30 วัน, สุขภาพโครงการ (แดง/เหลือง/เขียว), งานบริการเปิดอยู่/เลย SLA · ' +
      'หมวดที่ผู้ถามไม่มีสิทธิ์ดูบนหน้าจอจะเป็น null · ใช้ตอบคำถามกว้าง ๆ ว่า "วันนี้มีอะไรต้องทำ"',
  })
  @Get('summary')
  @Permissions('integration.assistant.read')
  @ActingPermissions('notification.read')
  summary(@CurrentPrincipal() principal: Principal) {
    return this.assistant.summary(principal);
  }

  @ApiOperation({
    summary: 'ดีลที่ใกล้ปิด',
    description:
      'ดีลที่ยังเปิดและคาดว่าจะปิดภายใน `days` วัน (ค่าเริ่มต้น 30) เรียงวันคาดปิดก่อน-หลัง · ' +
      '`past_expected_close` = เลยวันคาดปิดแล้วแต่ยังไม่ปิด · `view=mine` เฉพาะดีลของผู้ถาม',
  })
  @Get('deals/closing')
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  closingDeals(
    @Query() query: ClosingDealsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.assistant.closingDeals(principal, query);
  }

  @ApiOperation({
    summary: 'ดีลที่เงียบหรือเลยนัดติดตาม',
    description:
      '`silent` = ดีลที่ไม่มีกิจกรรมเกินเกณฑ์ของบริษัท · `follow_up_overdue` = เลยวันนัดติดตามแล้ว · ' +
      '`view=mine` เฉพาะดีลของผู้ถาม',
  })
  @Get('deals/silent')
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  silentDeals(
    @Query() query: SilentDealsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.assistant.silentDeals(principal, query);
  }

  @ApiOperation({
    summary: 'งานที่รอฉันอนุมัติ',
    description:
      'รายการที่รอการตัดสินใจของผู้ถาม รวมงานที่รับมอบหมายแทนคนอื่น · ' +
      '`waiting_days` = รอมากี่วันแล้ว · อนุมัติ/ตีกลับทำบนหน้าจอหรือผ่าน action ของคำขอ',
  })
  @Get('approvals')
  @Permissions('integration.approval.decide')
  @ActingPermissions('approval.decide')
  myApprovals(@CurrentPrincipal() principal: Principal) {
    return this.assistant.myApprovals(principal);
  }

  @ApiOperation({
    summary: 'โครงการที่มีปัญหา',
    description:
      'โครงการที่กำลังดำเนินอยู่ที่สุขภาพแดงหรือเหลือง แย่สุดก่อน · `why` บอกสาเหตุ ' +
      '(ต้นทุนโตเกินงบ `costGrowthPct`, งานล่าช้า, ความเสี่ยงสูง, ประเด็นเลยกำหนด, งวดเงินค้าง) · ' +
      'เห็นเฉพาะโครงการที่ผู้ถามมองเห็นบนหน้าจอ',
  })
  @Get('projects/at-risk')
  @Permissions('integration.assistant.read')
  @ActingPermissions('notification.read')
  projectsAtRisk(
    @Query() query: ProjectsAtRiskQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.assistant.projectsAtRisk(principal, query);
  }

  @ApiOperation({
    summary: 'งานบริการที่ยังค้าง',
    description:
      'ใบสั่งงานบริการที่ยังไม่ปิด พร้อม `overdue` เมื่อเลย SLA แล้ว · `overdue=true` เฉพาะที่เลย SLA',
  })
  @Get('service-jobs')
  @Permissions('integration.service.asset.read')
  @ActingPermissions('service.asset.read')
  serviceJobs(
    @Query() query: ServiceJobsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.assistant.serviceJobs(principal, query);
  }

  @ApiOperation({
    summary: 'ค้นบทความในคลังความรู้',
    description:
      'บทความที่เผยแพร่แล้วซึ่งตอบคำถามได้ เรียงตามความเกี่ยวข้อง · ' +
      'ใช้ก่อนตอบคำถามวิธีทำ/แก้ปัญหา แล้วอ้าง `article_no` ในคำตอบ',
  })
  @Get('kb/articles')
  @Permissions('integration.assistant.read')
  @ActingPermissions('notification.read')
  articles(
    @Query() query: AssistantArticlesQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.assistant.articles(principal, query);
  }
}
