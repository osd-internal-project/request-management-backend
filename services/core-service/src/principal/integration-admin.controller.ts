import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { IntegrationAdminService } from './integration-admin.service';
import { INTEGRATION_PRESETS } from './integration-presets';
import {
  CreateIntegrationDto,
  IntegrationRowDto,
  UpdateIntegrationDto,
} from './dto/integration.dto';

/** หน้าจอผู้ดูแล → ระบบภายนอก: วิธีเรียกที่ยอมรับ แล้วผูก key / webhook เข้ามา. */
@ApiTags('admin/integrations')
@ApiBearerAuth()
@Controller('admin/integrations')
export class IntegrationAdminController {
  constructor(private readonly integrations: IntegrationAdminService) {}

  @Get('presets')
  @Permissions('admin.integration.manage')
  @ApiOperation({
    summary: 'ชุด scope สำเร็จรูปต่อ use case — ใช้ติ๊กให้ตอนสร้าง',
  })
  presets() {
    return INTEGRATION_PRESETS;
  }

  @Get()
  @Permissions('admin.integration.manage')
  @ApiOperation({ summary: 'ระบบภายนอกของบริษัทนี้' })
  @ApiOkResponse({ type: [IntegrationRowDto] })
  list(@CurrentPrincipal() principal: Principal) {
    return this.integrations.list(principal);
  }

  @Post()
  @Permissions('admin.integration.manage')
  @ApiOperation({
    summary: 'เพิ่มระบบภายนอก — แล้วออก key / ตั้ง webhook ให้มัน',
  })
  @ApiCreatedResponse({ type: IntegrationRowDto })
  create(
    @Body() dto: CreateIntegrationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.integrations.create(dto, principal);
  }

  @Patch(':id')
  @Permissions('admin.integration.manage')
  @ApiOperation({
    summary: 'แก้วิธีเรียก / ปิดการเชื่อมต่อ — มีผลกับคำขอถัดไปทันที',
  })
  @ApiOkResponse({ type: IntegrationRowDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateIntegrationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.integrations.update(id, dto, principal);
  }
}
