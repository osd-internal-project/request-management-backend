import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CallWindowDto {
  @ApiProperty({ example: 1, description: '1 = จันทร์ … 7 = อาทิตย์' })
  @IsInt()
  @Min(1)
  @Max(7)
  day!: number;

  @ApiProperty({ example: '09:00' })
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  from!: string;

  @ApiProperty({ example: '18:00' })
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  to!: string;
}

export class SaveCallPolicyDto {
  @ApiProperty({ type: [CallWindowDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(21)
  @ValidateNested({ each: true })
  @Type(() => CallWindowDto)
  windows!: CallWindowDto[];

  @ApiProperty({
    example: 3,
    description: 'โทรได้สูงสุดกี่ครั้งต่อเบอร์ต่อรายการ',
  })
  @IsInt()
  @Min(1)
  @Max(10)
  max_attempts!: number;

  @ApiProperty({
    example: 3,
    description: 'เว้นระยะอย่างน้อยกี่วันระหว่างครั้ง',
  })
  @IsInt()
  @Min(1)
  @Max(60)
  min_gap_days!: number;

  @ApiProperty({
    description:
      'บทเปิดบังคับ: แจ้งว่าเป็น AI โทรจากบริษัทใด เพื่ออะไร ({company} = ชื่อบริษัท)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  opening_script!: string;

  @ApiProperty({ description: 'วิธีปฏิเสธการติดต่อ — พูดต่อจากบทเปิดเสมอ' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  optout_script!: string;
}

export class CertifyCallPolicyDto {
  @ApiPropertyOptional({
    example:
      'ตรวจตาม พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล และแนวปฏิบัติการตลาดทางโทรศัพท์',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class SaveCallListDto {
  @ApiProperty({ example: 'โรงงานภาคตะวันออก — ต.ค. 2569' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiProperty({ description: 'สิ่งที่ AI พูดต่อจากบทเปิด' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  script!: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'บทความ KBMS ที่เผยแพร่แล้วที่บทพูดอ้างได้',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  kb_article_ids?: string[];
}

export class CallListStatusDto {
  @ApiProperty({ enum: ['active', 'paused', 'closed'] })
  @IsIn(['active', 'paused', 'closed'])
  status!: 'active' | 'paused' | 'closed';
}

export class AddCallTargetsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  prospect_ids!: string[];
}

export class RefuseCallDto {
  @ApiPropertyOptional({ example: 'ลูกค้าโทรกลับมาขอไม่ให้ติดต่อ' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** CD-292 — how a call went, as D-Callcenter reports it. */
export class CallResultDto {
  @ApiProperty({ description: 'รหัสสายของ D-Callcenter (ที่ได้ตอนสั่งโทร)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  call_id!: string;

  @ApiProperty({
    enum: [
      'interested',
      'not_interested',
      'no_answer',
      'busy',
      'refused',
      'failed',
    ],
  })
  @IsIn([
    'interested',
    'not_interested',
    'no_answer',
    'busy',
    'refused',
    'failed',
  ])
  outcome!:
    | 'interested'
    | 'not_interested'
    | 'no_answer'
    | 'busy'
    | 'refused'
    | 'failed';

  @ApiPropertyOptional({ example: 95 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86400)
  duration_sec?: number;

  @ApiPropertyOptional({ description: 'บทสนทนาที่ถอดความแล้ว' })
  @IsOptional()
  @IsString()
  @MaxLength(50000)
  transcript?: string;

  @ApiPropertyOptional({ description: 'อ้างอิงไฟล์เสียงในระบบ D-Callcenter' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  recording_ref?: string;
}
