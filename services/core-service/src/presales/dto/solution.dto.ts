import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ASSUMPTION_CATEGORIES } from '../solution-rules';

/** CD-132 — เริ่ม Solution จากคำขอ "ขอ Solution" ที่รับเรื่องแล้ว. */
export class StartSolutionDto {
  @ApiProperty({ description: 'id ของคำขอ "ขอ Solution และประเมินต้นทุน"' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  request_id!: string;
}

export class AssumptionDto {
  @ApiProperty({ enum: ASSUMPTION_CATEGORIES })
  @IsIn(ASSUMPTION_CATEGORIES)
  category!: (typeof ASSUMPTION_CATEGORIES)[number];

  @ApiProperty()
  @IsString()
  @MaxLength(2000)
  text!: string;
}

/** CD-132 — แก้ร่างของเวอร์ชัน (ส่งเฉพาะที่แก้). */
export class UpdateSolutionDraftDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  title?: string;

  @ApiPropertyOptional({ description: 'สรุปทางออก' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  summary?: string;

  @ApiPropertyOptional({ description: 'รายละเอียดการออกแบบ' })
  @IsOptional()
  @IsString()
  @MaxLength(50000)
  design?: string;

  @ApiPropertyOptional({ type: [AssumptionDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AssumptionDto)
  assumptions?: AssumptionDto[];
}

/** CD-132 — เปิดเวอร์ชันใหม่จากเวอร์ชันที่ยืนยันแล้ว. */
export class NewSolutionVersionDto {
  @ApiProperty({ description: 'ทำไมต้องแก้ — เห็นในประวัติเวอร์ชัน' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  change_note!: string;
}
