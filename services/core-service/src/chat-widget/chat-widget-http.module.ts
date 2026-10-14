import { Module } from '@nestjs/common';
import { ChatWidgetController } from './chat-widget.controller';
import { ChatWidgetSettingRepository } from './chat-widget.repository';
import { ChatWidgetService } from './chat-widget.service';

/** The ผู้ช่วย AI panel's LibreChat host, set per company on screen. */
@Module({
  controllers: [ChatWidgetController],
  providers: [ChatWidgetSettingRepository, ChatWidgetService],
})
export class ChatWidgetHttpModule {}
