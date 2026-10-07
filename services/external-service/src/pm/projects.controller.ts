import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ActingPermissions,
  CurrentPrincipal,
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  ListProjectsQueryDto,
  MilestonesService,
  OpenProjectDto,
  ProjectsService,
} from '@request-management/core-service';
import { ActsForPerson } from '../auth/acts-for-person.decorator';
import { IDEMPOTENCY_KEY_HEADER } from '../common/idempotency-header';

/**
 * Projects (CD-18 PM) from outside: find them, read them, and **open one
 * from a signed contract** — the step that starts delivery.
 *
 * Opening is the one write, because it is the hand-off a partner system may
 * own (a contract signed elsewhere, a PMO tool that assigns the manager).
 * Planning, budgets and the rest of the project stay on the screens.
 *
 * Reading a project asks the person for `notification.read` exactly as the
 * screen does — every role holds it, and `ProjectsService` decides which rows
 * (the manager and team see theirs without `pm.project.read`). Preparing and
 * opening ask for `pm.project.manage`, also as the screen does.
 */
@ApiTags('pm')
@Controller('pm/projects')
@ActsForPerson()
export class ExternalProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly milestones: MilestonesService,
  ) {}

  @ApiOperation({
    summary: 'ค้นโครงการ',
    description:
      '`opportunity_id` = โครงการของดีลนั้น · `scope=mine` = ที่ผู้ใช้เป็นผู้จัดการหรืออยู่ในทีม',
  })
  @Get()
  @Permissions('integration.pm.read')
  @ActingPermissions('notification.read')
  list(
    @Query() query: ListProjectsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.projects.list(principal, query);
  }

  @ApiOperation({
    summary: 'สัญญาที่ลงนามแล้วและยังไม่ได้เปิดโครงการ',
    description: 'ตัวเลือกของ `contract_id` สำหรับ `POST pm/projects`',
  })
  @Get('openable-contracts')
  @Permissions('integration.pm.manage')
  @ActingPermissions('pm.project.manage')
  openable(@CurrentPrincipal() principal: Principal) {
    return this.projects.openable(principal);
  }

  @ApiOperation({
    summary: 'ตรวจก่อนเปิดโครงการ — ข้อมูลที่จะดึงมา และสิ่งที่ยังขาด',
    description:
      'ดึงจากสัญญา ขอบเขตงาน (SOW) และ BOQ ของ Solution ที่อนุมัติ · ' +
      '`problems` ไม่ว่าง = เปิดไม่ได้จนกว่าจะแก้',
  })
  @Get('preview/:contractId')
  @Permissions('integration.pm.manage')
  @ActingPermissions('pm.project.manage')
  preview(
    @Param('contractId') contractId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.projects.preview(contractId, principal);
  }

  @ApiOperation({
    summary: 'โครงการที่เปิดจากสัญญานี้',
    description: '`null` = สัญญานี้ยังไม่ได้เปิดโครงการ',
  })
  @Get('by-contract/:contractId')
  @Permissions('integration.pm.read')
  @ActingPermissions('notification.read')
  forContract(
    @Param('contractId') contractId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.projects.forContract(contractId, principal);
  }

  @ApiOperation({
    summary: 'เปิดโครงการจากสัญญาที่ลงนามแล้ว (CD-175)',
    description:
      'ออกเลขที่โครงการ ดึงหมุดหมาย/งวดจากสัญญา แจ้งผู้จัดการและทีม · ' +
      'สัญญายังไม่ลงนาม หรือเปิดโครงการไปแล้ว = `409 CONFLICT` พร้อมเหตุผล · ' +
      '`manager_user_id` เป็น uuid หาได้จาก `GET request/users`',
  })
  @ApiHeader(IDEMPOTENCY_KEY_HEADER)
  @Post()
  @Permissions('integration.pm.manage')
  @ActingPermissions('pm.project.manage')
  open(@Body() dto: OpenProjectDto, @CurrentPrincipal() principal: Principal) {
    return this.projects.open(dto, principal);
  }

  @ApiOperation({ summary: 'รายละเอียดโครงการ' })
  @Get(':id')
  @Permissions('integration.pm.read')
  @ActingPermissions('notification.read')
  detail(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.projects.detail(id, principal);
  }

  @ApiOperation({
    summary: 'หมุดหมายของโครงการ และงวดชำระของสัญญา (CD-182)',
  })
  @Get(':id/milestones')
  @Permissions('integration.pm.read')
  @ActingPermissions('notification.read')
  listMilestones(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.milestones.list(id, principal);
  }
}
