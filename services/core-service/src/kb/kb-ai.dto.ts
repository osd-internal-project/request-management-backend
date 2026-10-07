import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AI_CHANNELS, type AiChannel } from './kb-ai.service';

/** CD-265 — an AI channel's search of customer-facing articles. */
export class KbAiSearchDto {
  @ApiProperty({
    description:
      'คำถามของลูกค้า — ค้นทั้งคำ (เว้นวรรคระหว่างคำ) และความหมาย (CD-267)',
  })
  @IsString()
  @MaxLength(4000)
  question!: string;

  @ApiProperty({ enum: AI_CHANNELS })
  @IsIn(AI_CHANNELS)
  channel!: AiChannel;

  @ApiPropertyOptional({
    description: 'รหัสลูกค้าในบทสนทนา — ได้บทความเฉพาะของลูกค้ารายนี้ด้วย',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  customer_code?: string;

  @ApiPropertyOptional({ description: 'อ้างอิงบทสนทนาฝั่ง AI' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  conversation_ref?: string;

  @ApiPropertyOptional({ default: 5, maximum: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  limit?: number;
}

/** CD-265 — what the AI answered, and with which returned articles. */
export class KbAiAnswerDto {
  @ApiProperty({ enum: ['answered', 'unanswered'] })
  @IsIn(['answered', 'unanswered'])
  outcome!: 'answered' | 'unanswered';

  @ApiPropertyOptional({
    description: 'ข้อความที่ตอบลูกค้า (เก็บตามระยะที่กำหนด)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  answer?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'บทความที่คำตอบอ้างอิง (จากผลค้นนี้)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  cited_article_ids?: string[];
}

export class KbAiLogQueryDto {
  @ApiPropertyOptional({ enum: ['pending', 'answered', 'unanswered'] })
  @IsOptional()
  @IsIn(['pending', 'answered', 'unanswered'])
  outcome?: string;

  @ApiPropertyOptional({ enum: AI_CHANNELS })
  @IsOptional()
  @IsIn(AI_CHANNELS)
  channel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  article_id?: string;
}
