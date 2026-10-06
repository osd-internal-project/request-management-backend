import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** ดีลของฉันหรือทุกดีลที่ผู้ถามมองเห็น. */
class DealViewDto {
  @ApiPropertyOptional({
    enum: ['mine', 'all'],
    description: '`mine` = ดีลที่ผู้ถามเป็นเจ้าของ · `all` (ค่าเริ่มต้น) = ทุกดีลที่มองเห็น',
  })
  @IsOptional()
  @IsIn(['mine', 'all'])
  view?: 'mine' | 'all';
}

export class ClosingDealsQueryDto extends DealViewDto {
  @ApiPropertyOptional({
    example: 30,
    default: 30,
    description: 'คาดปิดภายในกี่วันนับจากวันนี้ (รวมดีลที่เลยวันคาดปิดแล้วแต่ยังเปิด)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;
}

export class SilentDealsQueryDto extends DealViewDto {}

export class ProjectsAtRiskQueryDto {
  @ApiPropertyOptional({
    enum: ['red', 'amber'],
    description: '`red` = เฉพาะสุขภาพแดง · ไม่ระบุ = แดงและเหลือง',
  })
  @IsOptional()
  @IsIn(['red', 'amber'])
  level?: 'red' | 'amber';
}

export class ServiceJobsQueryDto {
  @ApiPropertyOptional({
    enum: ['true'],
    description: '`true` = เฉพาะงานที่เลย SLA แล้ว',
  })
  @IsOptional()
  @IsIn(['true'])
  overdue?: 'true';

  @ApiPropertyOptional({ description: 'เฉพาะลูกค้ารายนี้ (id)' })
  @IsOptional()
  @IsString()
  customer_id?: string;
}

export class AssistantArticlesQueryDto {
  @ApiProperty({
    example: 'ตั้งค่า VPN',
    description: 'คำค้นภาษาธรรมดา — หัวเรื่อง เนื้อหา แท็ก หรือรหัสสินค้า',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  q!: string;

  @ApiPropertyOptional({ example: 5, default: 5, maximum: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;
}
