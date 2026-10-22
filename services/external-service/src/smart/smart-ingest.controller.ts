import { ActsAsCompany } from '../auth/acts-as-company.decorator';
import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  PushProspectsDto,
  SmartIngestService,
  toFound,
} from '@request-management/core-service';

/**
 * CD-289 (CD-16 AI SMART) — a licensed crawler or data vendor pushes what it
 * found into the staging list of the key's company.
 *
 * Robot-only and with no acting person (AGENTS.md, "On external-service"):
 * nobody at the far end is a user here, and nothing reaches CRM — rows wait
 * for screening (CD-290). The source must be one the company set up as
 * `push`; a row already held is counted as a duplicate, not stored twice,
 * so a vendor may resend a whole day's results safely.
 */
@ApiTags('smart')
@ApiBearerAuth()
@Controller('smart/prospects')
@ActsAsCompany()
export class ExternalSmartIngestController {
  constructor(private readonly ingest: SmartIngestService) {}

  @ApiOperation({
    summary: 'ส่งรายชื่อธุรกิจที่กวาดได้เข้าคิวของ AI SMART',
    description:
      'ต้องเป็นแหล่งชนิด push ที่ตั้งไว้ในบริษัทของกุญแจ · ครั้งละไม่เกิน 1000 รายการ · ' +
      'รายการที่มีอยู่แล้ว (แหล่งเดียวกัน+external_ref เดียวกัน หรือเลขนิติบุคคลซ้ำ) นับเป็นซ้ำ ไม่บันทึกซ้ำ · ' +
      'ยังไม่เข้า CRM จนกว่าจะผ่านการคัดกรอง',
  })
  @Post('ingest')
  @Permissions('integration.smart.prospect.create')
  push(
    @Body() dto: PushProspectsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.ingest.push(
      principal.activeCompanyId,
      dto.source_code,
      dto.rows.map(toFound),
    );
  }
}
