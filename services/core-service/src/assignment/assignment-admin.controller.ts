import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { AssignmentService } from './assignment.service';
import {
  CreateAssignmentRuleDto,
  UpdateAssignmentRoleDto,
  UpdateAssignmentRuleDto,
} from './dto/assignment.dto';

/**
 * ตารางทีม (2 พ.ย. 2569) — งานของแต่ละบทบาทไปทีมไหน. ทีมคือผังองค์กร จึงใช้
 * สิทธิ์เดียวกับหน้าผังองค์กร.
 */
@ApiTags('admin/assignment-rules')
@ApiBearerAuth()
@Controller('admin/assignment-rules')
export class AssignmentAdminController {
  constructor(private readonly assignments: AssignmentService) {}

  @Get('roles')
  @Permissions('admin.org.manage')
  @ApiOperation({ summary: 'บทบาทและช่องที่ใช้เป็นเงื่อนไขได้' })
  roles() {
    return this.assignments.roles();
  }

  @Get()
  @Permissions('admin.org.manage')
  @ApiOperation({ summary: 'กฎทั้งหมดของบริษัท + ค่าต่อบทบาท (คนรับสำรอง, ประเภทคำขอที่นับงาน)' })
  list(@CurrentPrincipal() principal: Principal) {
    return this.assignments.listRules(principal);
  }

  @Post()
  @Permissions('admin.org.manage')
  @ApiOperation({ summary: 'เพิ่มกฎ: บทบาท + เงื่อนไข → ทีม' })
  create(
    @Body() dto: CreateAssignmentRuleDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.assignments.createRule(dto, principal);
  }

  @Patch('roles/:role')
  @Permissions('admin.org.manage')
  @ApiOperation({ summary: 'ตั้งคนรับสำรอง / ประเภทคำขอที่นับงานเปิดของบทบาท' })
  updateRole(
    @Param('role') role: string,
    @Body() dto: UpdateAssignmentRoleDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.assignments.updateRole(role, dto, principal);
  }

  @Get('history')
  @Permissions('admin.org.manage')
  @ApiOperation({ summary: 'การจัดคน 100 รายการล่าสุด' })
  @ApiQuery({ name: 'role', required: false })
  history(
    @CurrentPrincipal() principal: Principal,
    @Query('role') role?: string,
  ) {
    return this.assignments.history(principal, role);
  }

  @Post('preview')
  @Permissions('admin.org.manage')
  @ApiOperation({ summary: 'ลองจับคู่ — ตอบคนที่จะได้งาน ไม่บันทึก ไม่แจ้งเตือน' })
  preview(
    @Body() body: { role: string; criteria?: Record<string, string> },
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.assignments.preview(body.role, body.criteria ?? {}, principal);
  }

  @Patch(':id')
  @Permissions('admin.org.manage')
  @ApiOperation({ summary: 'แก้กฎ หรือปิด (active=false) — ไม่ลบจริง' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAssignmentRuleDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.assignments.updateRule(id, dto, principal);
  }
}
