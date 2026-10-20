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
import { WebhookAdminService } from './webhook-admin.service';
import {
  CreateWebhookDto,
  UpdateWebhookDto,
  WebhookDeliveryRowDto,
  WebhookRowDto,
  WebhookWithSecretDto,
} from './dto/webhook.dto';

/** G-07 — ผู้ดูแลตั้งเว็บภายนอกที่รับ event ของบริษัทนี้. */
@ApiTags('admin/webhooks')
@ApiBearerAuth()
@Controller('admin/webhooks')
export class WebhookAdminController {
  constructor(private readonly webhooks: WebhookAdminService) {}

  @Get('events')
  @Permissions('admin.integration.manage')
  @ApiOperation({ summary: 'event ที่สมัครรับได้ — มาจาก event catalog' })
  events() {
    return this.webhooks.events();
  }

  @Get()
  @Permissions('admin.integration.manage')
  @ApiOperation({ summary: 'webhook ของบริษัทนี้ — ไม่มี secret ในคำตอบ' })
  @ApiOkResponse({ type: [WebhookRowDto] })
  list(@CurrentPrincipal() principal: Principal) {
    return this.webhooks.list(principal);
  }

  @Post()
  @Permissions('admin.integration.manage')
  @ApiOperation({
    summary: 'เพิ่มปลายทาง — `secret` อยู่ในคำตอบนี้ครั้งเดียว',
  })
  @ApiCreatedResponse({ type: WebhookWithSecretDto })
  create(
    @Body() dto: CreateWebhookDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.webhooks.create(dto, principal);
  }

  @Patch(':id')
  @Permissions('admin.integration.manage')
  @ApiOperation({ summary: 'แก้ชื่อ URL event หรือเปิด/ปิด' })
  @ApiOkResponse({ type: WebhookRowDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateWebhookDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.webhooks.update(id, dto, principal);
  }

  @Post(':id/rotate-secret')
  @Permissions('admin.integration.manage')
  @ApiOperation({
    summary: 'ออก secret ใหม่ — secret เดิมใช้ไม่ได้ทันที',
  })
  @ApiCreatedResponse({ type: WebhookWithSecretDto })
  rotateSecret(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.webhooks.rotateSecret(id, principal);
  }

  @Get(':id/deliveries')
  @Permissions('admin.integration.manage')
  @ApiOperation({ summary: 'การส่ง 50 รายการล่าสุด' })
  @ApiOkResponse({ type: [WebhookDeliveryRowDto] })
  deliveries(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.webhooks.listDeliveries(id, principal);
  }

  @Post(':id/test')
  @Permissions('admin.integration.manage')
  @ApiOperation({ summary: 'ส่ง `webhook.ping` ในรอบถัดไปของ worker' })
  test(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.webhooks.test(id, principal);
  }
}
