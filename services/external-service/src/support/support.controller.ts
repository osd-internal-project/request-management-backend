import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ActingPermissions,
  CurrentPrincipal,
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  EntitlementsService,
  ListAssetsQueryDto,
  ListEntitlementsQueryDto,
  ListWorkOrdersQueryDto,
  OpenWorkOrderDto,
  ServiceAssetsService,
  WorkOrdersService,
} from '@request-management/core-service';
import { ActsForPerson } from '../auth/acts-for-person.decorator';
import { BearerToken } from '../auth/bearer-token.decorator';
import { IDEMPOTENCY_KEY_HEADER } from '../common/idempotency-header';

/**
 * After-sales service (CD-21) from outside: the installed base, what covers
 * it, and **opening a service job** — the start of the service flow, which a
 * monitoring system or a partner helpdesk may own.
 *
 * Each route is its screen twin under a shorter path (`support/assets` for
 * `service-assets`, …) — `support` after core's `SupportModule`, because
 * `service` would name the partner document `external-service.json`, the
 * file that already describes this whole service — `downstream-route-parity.spec.ts` holds the map and
 * the permissions. Customers raising cases themselves do not come here: they
 * use the intake channels (`request/intake/*`) or the Customer Portal.
 */
@ApiTags('support')
@Controller('support')
@ActsForPerson()
export class ExternalSupportController {
  constructor(
    private readonly assets: ServiceAssetsService,
    private readonly entitlements: EntitlementsService,
    private readonly orders: WorkOrdersService,
  ) {}

  // --- CD-236 installed base ---------------------------------------------------

  @ApiOperation({
    summary: 'ค้นทะเบียนอุปกรณ์ที่ติดตั้ง',
    description: '`q` = serial / ชื่อ / รุ่น / สถานที่ · กรองตามลูกค้าได้',
  })
  @Get('assets')
  @Permissions('integration.service.asset.read')
  @ActingPermissions('service.asset.read')
  listAssets(
    @Query() query: ListAssetsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.assets.list(principal, query);
  }

  @ApiOperation({ summary: 'รายละเอียดและประวัติของอุปกรณ์' })
  @Get('assets/:id')
  @Permissions('integration.service.asset.read')
  @ActingPermissions('service.asset.read')
  asset(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.assets.detail(principal, id);
  }

  // --- CD-237 entitlements -----------------------------------------------------

  @ApiOperation({
    summary: 'สิทธิ์บริการ (ประกัน / สัญญาบริการ MA)',
    description: 'กรองลูกค้า สถานะ และที่ใกล้หมดอายุ',
  })
  @Get('entitlements')
  @Permissions('integration.service.asset.read')
  @ActingPermissions('service.asset.read')
  listEntitlements(
    @Query() query: ListEntitlementsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.entitlements.list(principal, query);
  }

  @ApiOperation({ summary: 'รายละเอียดสิทธิ์ และอุปกรณ์ที่ครอบคลุม' })
  @Get('entitlements/:id')
  @Permissions('integration.service.asset.read')
  @ActingPermissions('service.asset.read')
  entitlement(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.entitlements.detail(principal, id);
  }

  // --- CD-239 service jobs -----------------------------------------------------

  @ApiOperation({ summary: 'ใบสั่งงานบริการ — ที่ยังเปิด หรือทั้งหมด' })
  @Get('work-orders')
  @Permissions('integration.service.asset.read')
  @ActingPermissions('service.asset.read')
  listWorkOrders(
    @Query() query: ListWorkOrdersQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.orders.list(principal, query);
  }

  @ApiOperation({
    summary: 'เปิดใบสั่งงานบริการ (CD-239)',
    description:
      'สร้างเคสตามประเภทใบสั่งงานบริการที่ตั้งในหน้าตั้งค่า CRM แล้วยื่นทันที — ' +
      'นาฬิกา SLA เริ่ม และคำตอบบอกว่าอยู่ในสิทธิ์บริการหรือต้องเก็บเงิน · ' +
      'ติดตามต่อด้วย `GET request/requests/{requestNo}` · ' +
      'ยังไม่ได้ตั้งประเภท = `409 CONFLICT`',
  })
  @ApiHeader(IDEMPOTENCY_KEY_HEADER)
  @Post('work-orders')
  @Permissions('integration.service.asset.manage')
  @ActingPermissions('service.asset.manage')
  openWorkOrder(
    @Body() dto: OpenWorkOrderDto,
    @CurrentPrincipal() principal: Principal,
    @BearerToken() authorization: string,
  ) {
    return this.orders.open(principal, dto, authorization);
  }

  /** Declared before `:id`, or `by-request` would be read as an id. */
  @ApiOperation({
    summary: 'ข้อมูลบริการของคำขอ',
    description: '`null` ถ้าคำขอนี้ไม่ใช่ใบสั่งงานบริการ',
  })
  @Get('work-orders/by-request/:requestId')
  @Permissions('integration.service.asset.read')
  @ActingPermissions('notification.read')
  ofRequest(
    @Param('requestId') requestId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.orders.ofRequest(principal, requestId);
  }

  @ApiOperation({ summary: 'รายละเอียด + สิทธิ์ที่ครอบคลุมอุปกรณ์วันนี้' })
  @Get('work-orders/:id')
  @Permissions('integration.service.asset.read')
  @ActingPermissions('service.asset.read')
  workOrder(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.orders.detail(principal, id);
  }
}
