import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CustomerIntakeService } from './customer-intake.service';
import {
  IntakeChannelParam,
  SaveIntakeChannelDto,
} from './dto/customer-intake.dto';

/**
 * CD-66 — each company's customer channels (web form / LINE / AI CARE):
 * open or closed, who stands as the requester, which request types they
 * offer, and the web form's link and wording. Administered with the request
 * types, so under the same permission.
 *
 * Screens only (crm-route-parity SCREEN_ONLY): the channels themselves are
 * served by external-service, and no integration configures them.
 */
@ApiTags('admin/intake-channels')
@ApiBearerAuth()
@Controller('admin/intake-channels')
export class CustomerIntakeAdminController {
  constructor(private readonly intake: CustomerIntakeService) {}

  @ApiOperation({ summary: 'ช่องทางรับคำขอจากลูกค้าของบริษัท' })
  @Get()
  @Permissions('admin.request-type.manage')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query('company_id') companyId?: string,
  ) {
    return this.intake.listAdmin(principal, companyId);
  }

  @ApiOperation({
    summary: 'ตั้งค่าช่องทาง — เปิด/ปิด ผู้ยื่นแทน ประเภทคำขอ ข้อความฟอร์ม',
    description: 'new_link=true ออกลิงก์ฟอร์มใหม่ ลิงก์เดิมใช้ไม่ได้อีก',
  })
  @Put(':channel')
  @Permissions('admin.request-type.manage')
  save(
    @Param() params: IntakeChannelParam,
    @Body() dto: SaveIntakeChannelDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.intake.save(params.channel, dto, principal);
  }
}
