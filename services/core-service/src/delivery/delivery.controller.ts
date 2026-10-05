import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AnyPermission,
  Authenticated,
  CurrentPrincipal,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  CancelDeliveryDto,
  ListDeliveriesQueryDto,
  SaveDeliveryDto,
} from './delivery.dto';
import { DeliveriesService } from './deliveries.service';

/** CD-20 Delivery — ส่งมอบและตรวจรับ. */
@ApiTags('delivery')
@ApiBearerAuth()
@Controller('delivery')
export class DeliveryController {
  constructor(private readonly deliveries: DeliveriesService) {}

  @ApiOperation({
    summary: 'CD-250 รอบส่งของทุกโครงการ (ของไม่พร้อมใกล้วันส่งขึ้นเตือน)',
  })
  @Get('deliveries')
  @AnyPermission('delivery.read', 'delivery.manage', 'pm.project.read')
  list(
    @Query() query: ListDeliveriesQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.deliveries.list(principal, query);
  }

  @ApiOperation({
    summary:
      'CD-250 แผนส่งมอบของโครงการ: รอบส่ง หมุดหมาย และ BOQ ที่วางแผนแล้ว',
  })
  @Get('projects/:projectId')
  @Authenticated()
  project(
    @Param('projectId') projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.deliveries.project(principal, projectId);
  }

  @ApiOperation({
    summary: 'CD-250 เพิ่มรอบส่ง (ทีม Delivery / ผู้จัดการโครงการ)',
  })
  @Post('projects/:projectId/deliveries')
  @Authenticated()
  create(
    @Param('projectId') projectId: string,
    @Body() dto: SaveDeliveryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.deliveries.create(principal, projectId, dto);
  }

  @ApiOperation({ summary: 'CD-250 แก้รอบส่ง (เลื่อนวัน = เตือนใหม่)' })
  @Put('deliveries/:id')
  @Authenticated()
  update(
    @Param('id') id: string,
    @Body() dto: SaveDeliveryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.deliveries.update(principal, id, dto);
  }

  @ApiOperation({ summary: 'CD-250 ยกเลิกรอบส่ง (ต้องมีเหตุผล)' })
  @Post('deliveries/:id/cancel')
  @Authenticated()
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelDeliveryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.deliveries.cancel(principal, id, dto.reason);
  }
}
