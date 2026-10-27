import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { IntegrationEndpointsAdminService } from './integration-endpoints-admin.service';
import {
  CreateIntegrationEndpointDto,
  IntegrationEndpointKeyDto,
  IntegrationEndpointRowDto,
  ListIntegrationEndpointsDto,
  UpdateIntegrationEndpointDto,
} from './dto/integration-endpoint.dto';

/** ผู้ดูแลตั้งปลายทางที่ CTD ส่งงานของ agent ไป — แท็บในหน้า Integrations. */
@ApiTags('admin/integration-endpoints')
@ApiBearerAuth()
@Controller('admin/integration-endpoints')
export class IntegrationEndpointsAdminController {
  constructor(private readonly endpoints: IntegrationEndpointsAdminService) {}

  @Get()
  @Permissions('admin.integration.manage')
  @ApiOperation({
    summary: 'endpoint ของระบบภายนอกหนึ่งระบบ — ไม่มี key ในคำตอบ',
  })
  @ApiOkResponse({ type: [IntegrationEndpointRowDto] })
  list(
    @Query() query: ListIntegrationEndpointsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.endpoints.list(query.integration_id, principal);
  }

  @Post()
  @Permissions('admin.integration.manage')
  @ApiOperation({
    summary: 'เพิ่ม endpoint ของงานหนึ่ง — งานละหนึ่ง endpoint ต่อบริษัท',
  })
  @ApiCreatedResponse({ type: IntegrationEndpointRowDto })
  create(
    @Body() dto: CreateIntegrationEndpointDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.endpoints.create(dto, principal);
  }

  @Patch(':id')
  @Permissions('admin.integration.manage')
  @ApiOperation({ summary: 'แก้ URL, endpoint id, key หรือเปิด/ปิด' })
  @ApiOkResponse({ type: IntegrationEndpointRowDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateIntegrationEndpointDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.endpoints.update(id, dto, principal);
  }

  @Get(':id/key')
  @Permissions('admin.integration.manage')
  @ApiOperation({ summary: 'ดู x-api-key ปัจจุบัน — ทุกครั้งที่ดูลง audit' })
  @ApiOkResponse({ type: IntegrationEndpointKeyDto })
  revealKey(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.endpoints.revealKey(id, principal);
  }
}
