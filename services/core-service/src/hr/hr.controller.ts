import { thaiToday } from '../crm/vendor-costs';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AnyPermission,
  Authenticated,
  CurrentPrincipal,
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { HrRatesService } from './hr-rates.service';
import {
  AddLaborRateDto,
  ListEmployeesQueryDto,
  SaveEmployeeDto,
  SaveEmployeeSkillsDto,
  SaveHrItemDto,
  SaveSkillDto,
  ReturnTimesheetDto,
  SaveTimesheetWeekDto,
  AvailabilityQueryDto,
  CreateBookingDto,
  DecideLeaveDto,
  RequestLeaveDto,
  SaveLeaveEntitlementDto,
  SaveLeaveTypeDto,
} from './hr.dto';
import { EmployeesService } from './employees.service';
import { TimesheetsService } from './timesheets.service';
import { LeavesService } from './leaves.service';
import { AvailabilityService } from './availability.service';
import { MandayVarianceService } from './manday-variance.service';

/** CD-207 — ต้นทุนบุคลากร: levels, work types and cost per manday. */
@ApiTags('hr')
@ApiBearerAuth()
@Controller('hr')
export class HrController {
  constructor(
    private readonly hr: HrRatesService,
    private readonly employees: EmployeesService,
    private readonly timesheets: TimesheetsService,
    private readonly leaves: LeavesService,
    private readonly availabilityService: AvailabilityService,
    private readonly mandays: MandayVarianceService,
  ) {}

  // --- CD-233 Manday plan vs actual -------------------------------------------

  @ApiOperation({
    summary:
      'CD-233 manday แผนเทียบจริงทุกโครงการที่เห็นได้ (PM/Pricing/HR ทุกโครงการ, ผู้จัดการโครงการของตัวเอง)',
  })
  @Get('mandays')
  @Authenticated()
  mandayProjects(@CurrentPrincipal() principal: Principal) {
    return this.mandays.list(principal);
  }

  @ApiOperation({
    summary: 'CD-233 manday แผนเทียบจริงของโครงการ: ระดับ × ประเภทงาน และรายคน',
  })
  @Get('mandays/:projectId')
  @Authenticated()
  mandayProject(
    @Param('projectId') projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.mandays.project(principal, projectId);
  }

  // --- CD-232 Leave and availability ------------------------------------------

  @ApiOperation({ summary: 'CD-232 ประเภทการลา (HR เห็นที่เลิกใช้ด้วย)' })
  @Get('leave-types')
  @Authenticated()
  leaveTypes(@CurrentPrincipal() principal: Principal) {
    return this.leaves.listTypes(principal);
  }

  @ApiOperation({ summary: 'CD-232 เพิ่มประเภทการลา' })
  @Post('leave-types')
  @Permissions('hr.employee.manage')
  createLeaveType(
    @Body() dto: SaveLeaveTypeDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leaves.saveType(principal, null, dto);
  }

  @ApiOperation({ summary: 'CD-232 แก้ประเภทการลา' })
  @Put('leave-types/:id')
  @Permissions('hr.employee.manage')
  updateLeaveType(
    @Param('id') id: string,
    @Body() dto: SaveLeaveTypeDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leaves.saveType(principal, id, dto);
  }

  @ApiOperation({ summary: 'CD-232 สิทธิ์วันลารายคนที่ตั้งแทนค่าตั้งต้น' })
  @Get('leave-entitlements')
  @AnyPermission('hr.employee.read', 'hr.employee.manage')
  leaveEntitlements(
    @Query('year') year: string | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leaves.listEntitlements(principal, yearOf(year));
  }

  @ApiOperation({ summary: 'CD-232 ตั้งสิทธิ์วันลาของคนในปีหนึ่ง' })
  @Put('leave-entitlements')
  @Permissions('hr.employee.manage')
  saveLeaveEntitlement(
    @Body() dto: SaveLeaveEntitlementDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leaves.saveEntitlement(principal, dto);
  }

  @ApiOperation({ summary: 'CD-232 ใบลาและสิทธิ์คงเหลือของฉันในปี' })
  @Get('leaves/me')
  @Authenticated()
  myLeaves(
    @Query('year') year: string | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leaves.mine(principal, yearOf(year));
  }

  @ApiOperation({ summary: 'CD-232 ใบลาที่รอฉันอนุมัติ' })
  @Get('leaves/pending')
  @Authenticated()
  pendingLeaves(@CurrentPrincipal() principal: Principal) {
    return this.leaves.pending(principal);
  }

  @ApiOperation({
    summary: 'CD-232 สิทธิ์คงเหลือของพนักงาน (ตัวเอง หัวหน้า หรือ HR)',
  })
  @Get('leaves/balances/:userId')
  @Authenticated()
  leaveBalances(
    @Param('userId') userId: string,
    @Query('year') year: string | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leaves.balances(principal, userId, yearOf(year));
  }

  @ApiOperation({ summary: 'CD-232 ยื่นลา (แจ้งหัวหน้าตามผัง)' })
  @Post('leaves')
  @Authenticated()
  requestLeave(
    @Body() dto: RequestLeaveDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leaves.request(principal, dto);
  }

  @ApiOperation({ summary: 'CD-232 ยกเลิกใบลา' })
  @Post('leaves/:id/cancel')
  @Authenticated()
  cancelLeave(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leaves.cancel(principal, id);
  }

  @ApiOperation({ summary: 'CD-232 อนุมัติใบลา (หัวหน้าตามผังหรือ HR)' })
  @Post('leaves/:id/approve')
  @Authenticated()
  approveLeave(
    @Param('id') id: string,
    @Body() dto: DecideLeaveDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leaves.approve(principal, id, dto);
  }

  @ApiOperation({ summary: 'CD-232 ไม่อนุมัติใบลา (ต้องมีเหตุผล)' })
  @Post('leaves/:id/reject')
  @Authenticated()
  rejectLeave(
    @Param('id') id: string,
    @Body() dto: DecideLeaveDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leaves.reject(principal, id, dto);
  }

  @ApiOperation({
    summary:
      'CD-232 ความพร้อมรายคนรายวัน (8 ชม. − ลา − จอง) ตามสิทธิ์ที่เห็นคนได้',
  })
  @Get('availability')
  @Authenticated()
  availability(
    @Query() query: AvailabilityQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.availabilityService.availability(principal, query);
  }

  @ApiOperation({ summary: 'CD-232 การจองตัวคนของโครงการ' })
  @Get('bookings')
  @Authenticated()
  bookings(
    @Query('project_id') projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.availabilityService.projectBookings(principal, projectId);
  }

  @ApiOperation({
    summary:
      'CD-232 จองตัวคนเข้าโครงการ (PM ของโครงการ/HR) — จองเกินได้ ตอบวันที่เกิน',
  })
  @Post('bookings')
  @Authenticated()
  createBooking(
    @Body() dto: CreateBookingDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.availabilityService.createBooking(principal, dto);
  }

  @ApiOperation({ summary: 'CD-232 ยกเลิกการจอง' })
  @Delete('bookings/:id')
  @Authenticated()
  cancelBooking(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.availabilityService.cancelBooking(principal, id);
  }

  // --- CD-231 Timesheet ------------------------------------------------------

  @ApiOperation({ summary: 'CD-231 งานที่ลงเวลาได้ และประเภทงาน' })
  @Get('timesheets/options')
  @Authenticated()
  timesheetOptions(@CurrentPrincipal() principal: Principal) {
    return this.timesheets.options(principal);
  }

  @ApiOperation({ summary: 'CD-231 Timesheet ของฉันในสัปดาห์ของวันที่ระบุ' })
  @Get('timesheets/week')
  @Authenticated()
  timesheetWeek(
    @Query('day') dayOf: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.timesheets.week(
      principal,
      /^\d{4}-\d{2}-\d{2}$/.test(dayOf ?? '') ? dayOf : thaiToday(),
    );
  }

  @ApiOperation({
    summary: 'CD-231 บันทึกทั้งสัปดาห์ (ร่าง/ถูกตีกลับเท่านั้น)',
  })
  @Put('timesheets/week')
  @Authenticated()
  saveTimesheetWeek(
    @Body() dto: SaveTimesheetWeekDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.timesheets.saveWeek(principal, dto);
  }

  @ApiOperation({ summary: 'CD-231 สัปดาห์ที่รอฉันอนุมัติ (ลูกทีมทุกชั้น)' })
  @Get('timesheets/pending')
  @Authenticated()
  pendingTimesheets(@CurrentPrincipal() principal: Principal) {
    return this.timesheets.pending(principal);
  }

  @Get('timesheets/:id')
  @Authenticated()
  timesheet(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.timesheets.findOne(principal, id);
  }

  @Post('timesheets/:id/submit')
  @Authenticated()
  submitTimesheet(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.timesheets.submit(principal, id);
  }

  @Post('timesheets/:id/approve')
  @Authenticated()
  approveTimesheet(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.timesheets.approve(principal, id);
  }

  @Post('timesheets/:id/return')
  @Authenticated()
  returnTimesheet(
    @Param('id') id: string,
    @Body() dto: ReturnTimesheetDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.timesheets.returnSheet(principal, id, dto.reason);
  }

  // --- CD-229 ทะเบียนพนักงาน ------------------------------------------------

  @ApiOperation({
    summary: 'CD-229 ทะเบียนพนักงานของบริษัท (ข้อมูลจาก LDAP + ของ HR)',
  })
  @Get('employees')
  @AnyPermission('hr.employee.read', 'hr.employee.manage')
  listEmployees(
    @Query() query: ListEmployeesQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.employees.list(principal, query);
  }

  @ApiOperation({
    summary: 'CD-230 ลูกทีมใต้สายบังคับบัญชา (ทุกชั้น) — ไม่มีเงื่อนไขการจ้าง',
  })
  @Get('employees/team')
  @Authenticated()
  team(@CurrentPrincipal() principal: Principal) {
    return this.employees.team(principal);
  }

  @ApiOperation({
    summary: 'CD-230 รายชื่อทีมงานสำหรับจัดคน (ชื่อ สังกัด ระดับ ทักษะ)',
  })
  @Get('staff')
  @AnyPermission(
    'hr.employee.read',
    'hr.employee.manage',
    'pm.project.manage',
    'presales.solution.manage',
  )
  staff(
    @Query() query: ListEmployeesQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.employees.staff(principal, query);
  }

  @ApiOperation({ summary: 'CD-229 โปรไฟล์ของฉัน' })
  @Get('employees/me')
  @Authenticated()
  me(@CurrentPrincipal() principal: Principal) {
    return this.employees.findOne(principal, principal.userId);
  }

  @ApiOperation({ summary: 'CD-229 โปรไฟล์พนักงาน (HR หรือเจ้าตัว)' })
  @Get('employees/:userId')
  @Authenticated()
  employee(
    @Param('userId') userId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.employees.findOne(principal, userId);
  }

  @ApiOperation({ summary: 'CD-229 บันทึกระดับ การจ้าง และสถานะ' })
  @Put('employees/:userId')
  @Permissions('hr.employee.manage')
  saveEmployee(
    @Param('userId') userId: string,
    @Body() dto: SaveEmployeeDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.employees.saveProfile(principal, userId, dto);
  }

  @ApiOperation({ summary: 'CD-229 บันทึกทักษะทั้งชุด (ที่ไม่ส่งมาถูกถอด)' })
  @Put('employees/:userId/skills')
  @Permissions('hr.employee.manage')
  saveSkills(
    @Param('userId') userId: string,
    @Body() dto: SaveEmployeeSkillsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.employees.saveSkills(principal, userId, dto);
  }

  @ApiOperation({ summary: 'CD-229 รายการทักษะ' })
  @Get('skills')
  @AnyPermission(
    'hr.employee.read',
    'hr.employee.manage',
    'pm.project.manage',
    'presales.solution.manage',
  )
  skills(@CurrentPrincipal() principal: Principal) {
    return this.employees.skillCatalog(principal);
  }

  @Post('skills')
  @Permissions('hr.employee.manage')
  addSkill(
    @Body() dto: SaveSkillDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.employees.saveSkill(principal, null, dto);
  }

  @Patch('skills/:id')
  @Permissions('hr.employee.manage')
  saveSkill(
    @Param('id') id: string,
    @Body() dto: SaveSkillDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.employees.saveSkill(principal, id, dto);
  }

  @ApiOperation({
    summary: 'CD-207 ระดับและประเภทงานสำหรับเลือก (ไม่มีอัตรา)',
  })
  @Get('labor-options')
  @AnyPermission('presales.solution.manage', 'hr.rate.read', 'hr.rate.manage')
  options(@CurrentPrincipal() principal: Principal) {
    return this.hr.options(principal.activeCompanyId);
  }

  @ApiOperation({ summary: 'CD-207 ทะเบียนอัตราต้นทุนคนต่อ manday' })
  @Get('labor-rates')
  @AnyPermission('hr.rate.read', 'hr.rate.manage')
  list(@CurrentPrincipal() principal: Principal) {
    return this.hr.list(principal);
  }

  @ApiOperation({
    summary: 'CD-207 เพิ่มอัตรา — ปิดอัตราเดิมของคู่เดียวกันวันก่อนหน้า',
  })
  @Post('labor-rates')
  @Permissions('hr.rate.manage')
  addRate(
    @Body() dto: AddLaborRateDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.hr.addRate(principal, dto);
  }

  @ApiOperation({ summary: 'CD-207 ถอนอัตราที่ยังไม่มีผล' })
  @Delete('labor-rates/:id')
  @Permissions('hr.rate.manage')
  withdrawRate(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.hr.withdrawRate(principal, id);
  }

  @Post('levels')
  @Permissions('hr.rate.manage')
  addLevel(
    @Body() dto: SaveHrItemDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.hr.saveLevel(principal, null, dto);
  }

  @Patch('levels/:id')
  @Permissions('hr.rate.manage')
  saveLevel(
    @Param('id') id: string,
    @Body() dto: SaveHrItemDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.hr.saveLevel(principal, id, dto);
  }

  @Post('work-types')
  @Permissions('hr.rate.manage')
  addWorkType(
    @Body() dto: SaveHrItemDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.hr.saveWorkType(principal, null, dto);
  }

  @Patch('work-types/:id')
  @Permissions('hr.rate.manage')
  saveWorkType(
    @Param('id') id: string,
    @Body() dto: SaveHrItemDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.hr.saveWorkType(principal, id, dto);
  }
}

/** `?year=` or this year (Bangkok). */
function yearOf(value: string | undefined) {
  const year = Number(value);
  return Number.isInteger(year) && year >= 2000 && year <= 2100
    ? year
    : Number(thaiToday().slice(0, 4));
}
