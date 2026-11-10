import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Authenticated,
  CurrentPrincipal,
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CreateCallLogDto, SaveSoftphoneExtensionDto } from './softphone.dto';
import { SoftphoneService } from './softphone.service';

@ApiTags('softphone')
@ApiBearerAuth()
@Controller('softphone')
export class SoftphoneController {
  constructor(private readonly softphone: SoftphoneService) {}

  @ApiOperation({
    summary: 'เลขต่อของผู้ใช้เอง (พร้อมรหัส SIP) · ไม่มี = enabled:false',
  })
  @Get('runtime')
  @Authenticated()
  runtime(@CurrentPrincipal() principal: Principal) {
    return this.softphone.runtime(principal);
  }

  @ApiOperation({
    summary: 'บันทึกสายเข้าที่รับแล้วเป็นคำขอ CALL_LOG (ซ้ำ call_id = ตัวเดิม)',
  })
  @Post('call-logs')
  @Permissions('request.create')
  logCall(
    @Body() dto: CreateCallLogDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.softphone.logCall(principal, dto);
  }

  @ApiOperation({ summary: 'เลขต่อทั้งหมดของบริษัท (ไม่มีรหัส SIP)' })
  @Get('extensions')
  @Permissions('admin.softphone.manage')
  list(@CurrentPrincipal() principal: Principal) {
    return this.softphone.list(principal);
  }

  @ApiOperation({ summary: 'เพิ่มเลขต่อให้ผู้ใช้' })
  @Post('extensions')
  @Permissions('admin.softphone.manage')
  create(
    @Body() dto: SaveSoftphoneExtensionDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.softphone.create(principal, dto);
  }

  @ApiOperation({ summary: 'แก้เลขต่อ (รหัสว่าง = คงรหัสเดิม)' })
  @Put('extensions/:id')
  @Permissions('admin.softphone.manage')
  update(
    @Param('id') id: string,
    @Body() dto: SaveSoftphoneExtensionDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.softphone.update(principal, id, dto);
  }

  @ApiOperation({ summary: 'ลบเลขต่อ' })
  @Delete('extensions/:id')
  @HttpCode(204)
  @Permissions('admin.softphone.manage')
  async remove(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.softphone.remove(principal, id);
  }
}
