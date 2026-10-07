import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  AddOptOutDto,
  ListOptOutsQueryDto,
  RemoveOptOutDto,
} from './contact-preferences.dto';
import { DoNotContactService } from './do-not-contact.service';

/** CD-291 — the do-not-contact register (shared by AI SMART and AI CARE). */
@ApiTags('contact-preferences')
@ApiBearerAuth()
@Controller('contact-optouts')
export class ContactPreferencesController {
  constructor(private readonly register: DoNotContactService) {}

  @ApiOperation({ summary: 'CD-291 ทะเบียนห้ามติดต่อ' })
  @Get()
  @Permissions('crm.contact.optout.manage')
  list(
    @Query() query: ListOptOutsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.register.list(principal, query);
  }

  @ApiOperation({ summary: 'CD-291 เพิ่มเบอร์/อีเมลเข้าทะเบียนห้ามติดต่อ' })
  @Post()
  @Permissions('crm.contact.optout.manage')
  add(@Body() dto: AddOptOutDto, @CurrentPrincipal() principal: Principal) {
    return this.register.add(
      principal.activeCompanyId,
      { ...dto, source: 'manual' },
      principal,
    );
  }

  @ApiOperation({ summary: 'CD-291 ยกเลิกรายการในทะเบียน (เก็บประวัติไว้)' })
  @Post(':id/remove')
  @Permissions('crm.contact.optout.manage')
  remove(
    @Param('id') id: string,
    @Body() dto: RemoveOptOutDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.register.remove(principal, id, dto.reason);
  }
}
