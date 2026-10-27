import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PageQueryDto } from '@request-management/share';
import { AGENT_ACTIONS, AGENT_RECORD_STATUSES } from '../agent-actions';

/** Most rows one stream watches — a page of the list is 20 by default. */
export const MAX_STREAM_IDS = 50;

export class FindLeadsDto {
  @ApiProperty({
    description: 'ลูกค้าแบบไหนที่ต้องการให้ agent หา',
    example: 'บริษัทโลจิสติกส์ในภาคตะวันออก',
    maxLength: 500,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  topic!: string;
}

export class ListAgentRecordsDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: AGENT_RECORD_STATUSES })
  @IsOptional()
  @IsIn(AGENT_RECORD_STATUSES)
  status?: string;

  @ApiPropertyOptional({ enum: Object.keys(AGENT_ACTIONS) })
  @IsOptional()
  @IsIn(Object.keys(AGENT_ACTIONS))
  action?: string;
}

export class StreamAgentRecordsDto {
  @ApiProperty({
    description: `id ของ record ที่จะเฝ้า คั่นด้วย comma — ไม่เกิน ${MAX_STREAM_IDS}`,
    example: '6f6bd3a7-7308-4d2e-a4de-75e1f89b6871',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',').filter(Boolean) : value,
  )
  @IsArray()
  @ArrayMaxSize(MAX_STREAM_IDS)
  @IsUUID('4', { each: true })
  ids!: string[];
}

/** What the agent sends to close the job — a finished record never changes again. */
export class CompleteAgentRecordDto {
  @ApiProperty({ enum: ['done', 'failed'], example: 'done' })
  @IsIn(['done', 'failed'])
  status!: 'done' | 'failed';

  @ApiPropertyOptional({
    description: 'ผลลัพธ์ของงาน — JSON object ใดก็ได้ เช่นจำนวน lead ที่สร้าง',
    example: { leads_created: 12 },
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  result?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'เหตุที่ล้มเหลว — แสดงให้ผู้ใช้เห็นตรง ๆ',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  error?: string;
}
