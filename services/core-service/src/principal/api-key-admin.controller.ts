import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { ApiKeyAdminService } from './api-key-admin.service';
import {
  ApiKeyRowDto,
  ApiKeyScopeDto,
  IssueApiKeyDto,
  IssuedApiKeyDto,
} from './dto/api-key.dto';

/**
 * หน้าจอผู้ดูแล → ออกกุญแจให้ช่องทางภายนอกเอง (14 ก.ย. 2569).
 *
 * ทุก route ผูกกับบริษัทที่ผู้เรียกกำลังทำงานอยู่ (`X-Company-Id` ตามปกติ) และ
 * กุญแจที่ออกก็ผูกกับบริษัทนั้น — ผู้ดูแลของบริษัทหนึ่งออกกุญแจที่เขียนข้อมูลลง
 * อีกบริษัทไม่ได้ ไม่ว่าจะส่งอะไรมาใน body.
 *
 * ไม่มี `GET :id` และจะไม่มี: สิ่งเดียวที่คนอยากอ่านทีหลังคือตัวกุญแจ ซึ่งอ่าน
 * ไม่ได้ทั้งที่นี่และที่อื่น (ฐานข้อมูลเก็บแค่ sha256).
 */
@ApiTags('admin/api-keys')
@ApiBearerAuth()
@Controller('admin/api-keys')
export class ApiKeyAdminController {
  constructor(private readonly keys: ApiKeyAdminService) {}

  /**
   * ประกาศก่อน `:id` ไม่งั้น Nest จะอ่าน `scopes` เป็น id ของกุญแจ — แต่ที่นี่
   * เป็น `GET` ทั้งคู่กับ `POST :id/revoke` จึงไม่ชนกันอยู่แล้ว; วางไว้ก่อน
   * เพื่อไม่ให้เป็นกับดักตอนมีใครเพิ่ม `GET :id` วันหลัง.
   */
  @Get('scopes')
  @Permissions('admin.integration.manage')
  @ApiOperation({
    summary:
      'สิทธิ์ที่ออกให้กุญแจจากหน้าจอได้ — มาจาก catalog ไม่ใช่รายการเขียนมือ',
  })
  @ApiOkResponse({ type: [ApiKeyScopeDto] })
  scopes() {
    return this.keys.scopes();
  }

  @Get()
  @Permissions('admin.integration.manage')
  @ApiOperation({
    summary: 'กุญแจของบริษัทนี้ — ไม่มีตัวกุญแจในคำตอบ มีแต่ prefix',
  })
  @ApiOkResponse({ type: [ApiKeyRowDto] })
  list(@CurrentPrincipal() principal: Principal) {
    return this.keys.list(principal);
  }

  @Post()
  @Permissions('admin.integration.manage')
  @ApiOperation({
    summary: 'ออกกุญแจใบใหม่ให้ช่องทางหนึ่ง',
    description:
      'ค่าเต็มของกุญแจอยู่ใน `key` ของคำตอบนี้ **ครั้งเดียว** — ไม่มี endpoint ไหน ' +
      'อ่านกลับได้อีก เพราะฐานข้อมูลเก็บแค่ sha256 ' +
      'คัดลอกส่งให้ผู้ดูแลช่องทางทันที ทำหาย = ออกใบใหม่แล้วเพิกถอนใบเก่า',
  })
  @ApiCreatedResponse({ type: IssuedApiKeyDto })
  issue(@Body() dto: IssueApiKeyDto, @CurrentPrincipal() principal: Principal) {
    return this.keys.issue(dto, principal);
  }

  @Post(':id/revoke')
  @Permissions('admin.integration.manage')
  @ApiOperation({
    summary: 'เพิกถอนกุญแจ — มีผลกับคำขอถัดไปทันที และย้อนกลับไม่ได้',
  })
  @ApiOkResponse({ type: ApiKeyRowDto })
  revoke(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.keys.revoke(id, principal);
  }
}
