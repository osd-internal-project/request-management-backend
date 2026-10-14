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
import { SaveChatWidgetDto, SaveChatWidgetGroupDto } from './chat-widget.dto';
import { ChatWidgetService } from './chat-widget.service';

@ApiTags('chat-widget')
@ApiBearerAuth()
@Controller('chat-widget')
export class ChatWidgetController {
  constructor(private readonly widget: ChatWidgetService) {}

  @ApiOperation({
    summary: 'chat ที่ผู้ใช้เปิดได้ (org + group ของตน) และตัวเริ่มต้น',
  })
  @Get('runtime')
  @Authenticated()
  runtime(@CurrentPrincipal() principal: Principal) {
    return this.widget.runtime(principal);
  }

  @ApiOperation({ summary: 'chat ทั้งหมดของบริษัท (รวมที่ปิดอยู่)' })
  @Get('widgets')
  @Permissions('admin.chat-widget.manage')
  list(@CurrentPrincipal() principal: Principal) {
    return this.widget.list(principal);
  }

  @ApiOperation({ summary: 'เพิ่ม chat' })
  @Post('widgets')
  @Permissions('admin.chat-widget.manage')
  create(
    @Body() dto: SaveChatWidgetDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.widget.create(principal, dto);
  }

  @ApiOperation({ summary: 'แก้ chat (active, ทั้งองค์กร, default ของ org)' })
  @Put('widgets/:id')
  @Permissions('admin.chat-widget.manage')
  update(
    @Param('id') id: string,
    @Body() dto: SaveChatWidgetDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.widget.update(principal, id, dto);
  }

  @ApiOperation({ summary: 'ลบ chat (group ที่ add ไว้หายไปด้วย)' })
  @Delete('widgets/:id')
  @HttpCode(204)
  @Permissions('admin.chat-widget.manage')
  async remove(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.widget.remove(principal, id);
  }

  @ApiOperation({ summary: 'หน่วยงานของบริษัท พร้อมจำนวน chat ที่ add ไว้' })
  @Get('org-units')
  @Permissions('admin.chat-widget.manage')
  orgUnits(@CurrentPrincipal() principal: Principal) {
    return this.widget.orgUnits(principal);
  }

  @ApiOperation({ summary: 'chat ที่ add ให้หน่วยงานนี้ และ default ของมัน' })
  @Get('groups/:orgUnitId')
  @Permissions('admin.chat-widget.manage')
  group(
    @Param('orgUnitId') orgUnitId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.widget.group(principal, orgUnitId);
  }

  @ApiOperation({ summary: 'ตั้ง chat ของหน่วยงาน (แทนที่ทั้งชุด)' })
  @Put('groups/:orgUnitId')
  @Permissions('admin.chat-widget.manage')
  saveGroup(
    @Param('orgUnitId') orgUnitId: string,
    @Body() dto: SaveChatWidgetGroupDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.widget.saveGroup(principal, orgUnitId, dto);
  }
}
