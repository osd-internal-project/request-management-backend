import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { ErpSyncAdminService } from '../crm/erp-sync-admin.service';
import type { ErpJobFilter } from '../crm/erp-sync-admin.service';

export class ListErpJobsQueryDto {
  /** ค่าตั้งต้น `failed` — สิ่งที่ผู้ดูแลต้องลงมือ; `pending` = ยังลองเองอยู่. */
  @IsOptional()
  @IsIn(['failed', 'pending', 'all'])
  status?: ErpJobFilter;
}

/**
 * คิวส่ง SAP สำหรับผู้ดูแล (`admin.integration.manage`) — อยู่นอก `crm/` โดย
 * ตั้งใจ: หน้านี้เป็นงานของผู้ดูแลระบบบนพอร์ตภายใน ไม่ใช่ route CRM ที่ต้องมีคู่
 * บน external-service (`crm-route-parity.spec.ts`).
 */
@ApiTags('admin/erp-sync')
@ApiBearerAuth()
@Controller('admin/erp-sync')
export class ErpSyncAdminController {
  constructor(private readonly admin: ErpSyncAdminService) {}

  @Get('jobs')
  @Permissions('admin.integration.manage')
  @ApiOperation({
    summary:
      'งานในคิวส่ง SAP ของบริษัทนี้ (ส่งไม่สำเร็จ / รอส่ง) พร้อมข้อผิดพลาดล่าสุด',
  })
  list(
    @Query() query: ListErpJobsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.admin.list(principal, query.status ?? 'failed');
  }

  @Post('jobs/:id/retry')
  @HttpCode(HttpStatus.OK)
  @Permissions('admin.integration.manage')
  @ApiOperation({
    summary:
      'ส่งใหม่ — เริ่มนับรอบใหม่และส่งทันที (ผลเห็นเมื่อโหลดหน้าอีกครั้ง)',
  })
  retry(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.admin.retry(id, principal);
  }
}
