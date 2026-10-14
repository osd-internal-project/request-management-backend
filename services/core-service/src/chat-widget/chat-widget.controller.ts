import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Authenticated,
  CurrentPrincipal,
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { SaveChatWidgetSettingsDto } from './chat-widget.dto';
import { ChatWidgetService } from './chat-widget.service';

@ApiTags('chat-widget')
@ApiBearerAuth()
@Controller('chat-widget')
export class ChatWidgetController {
  constructor(private readonly widget: ChatWidgetService) {}

  @ApiOperation({ summary: 'LibreChat widget ที่แผงผู้ช่วย AI โหลด (ทุกคน)' })
  @Get('runtime')
  @Authenticated()
  runtime(@CurrentPrincipal() principal: Principal) {
    return this.widget.runtime(principal);
  }

  @ApiOperation({ summary: 'ค่าตั้ง LibreChat widget ของบริษัท' })
  @Get('settings')
  @Permissions('admin.chat-widget.manage')
  settings(@CurrentPrincipal() principal: Principal) {
    return this.widget.view(principal);
  }

  @ApiOperation({ summary: 'ตั้ง LibreChat widget (http / https / public id)' })
  @Put('settings')
  @Permissions('admin.chat-widget.manage')
  save(
    @Body() dto: SaveChatWidgetSettingsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.widget.save(principal, dto);
  }
}
