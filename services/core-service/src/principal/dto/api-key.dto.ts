import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * รหัสช่องทาง — ตัวพิมพ์เล็ก ตัวเลข ขีด. ใช้เป็นค่าที่ลงคอลัมน์ `sourceCode`
 * ของ Lead ทุกใบที่เข้ามาด้วยกุญแจนี้ และเป็นค่าที่รายงานการตลาดจัดกลุ่มด้วย —
 * ปล่อยให้พิมพ์อะไรก็ได้เมื่อไร วันหนึ่งจะมี `Website`, `website ` และ `เว็บไซต์`
 * เป็นสามช่องทางคนละอันในกราฟเดียวกัน.
 */
const SOURCE_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class IssueApiKeyDto {
  @ApiProperty({
    description: 'ชื่อที่คนอ่านแล้วรู้ว่ากุญแจใบนี้อยู่ที่ไหน',
    example: 'เว็บไซต์ osd.co.th (production)',
    maxLength: 120,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({
    description:
      'รหัสช่องทาง — ประทับลง Lead ทุกใบที่เข้ามาด้วยกุญแจนี้ ' +
      'ตัวพิมพ์เล็ก/ตัวเลข/ขีด เท่านั้น',
    example: 'website',
  })
  @Matches(SOURCE_CODE_PATTERN, {
    message: 'source_code ต้องเป็นตัวพิมพ์เล็ก ตัวเลข หรือขีด เช่น line-oa',
  })
  source_code!: string;

  /**
   * บังคับให้ระบุ และระบุได้เฉพาะ `integration.*` — ดู `ApiKeyAdminService`.
   *
   * ไม่มีค่า default ว่า "เอาทุกอย่าง" โดยตั้งใจ: กุญแจที่ออกจากหน้าจอเดินออกไป
   * อยู่บนเครื่องที่เราไม่ได้ดูแล และสิ่งที่มันทำได้ต้องเป็นสิ่งที่มีคนตั้งใจติ๊ก
   * ไม่ใช่สิ่งที่ได้มาเพราะไม่ได้กรอก.
   */
  @ApiProperty({
    description: 'สิทธิ์ที่กุญแจใบนี้ถือ — ได้เฉพาะ `integration.*`',
    example: ['integration.crm.lead.create'],
    type: [String],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  scopes!: string[];

  @ApiPropertyOptional({
    description: 'อายุเป็นวัน — ไม่ระบุ = ไม่หมดอายุ (เพิกถอนเอาเท่านั้น)',
    minimum: 1,
    maximum: 3650,
    example: 365,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  expires_in_days?: number;
}

/** แถวที่หน้าจอแสดง — ไม่มีตัวกุญแจ และไม่มี hash ของมัน. */
export class ApiKeyRowDto {
  @ApiProperty() id!: string;

  @ApiProperty({
    description: 'ตัวขึ้นต้นของกุญแจ — ใช้อ้างถึงใบนี้ได้โดยไม่ต้องเอ่ยตัวเต็ม',
    example: 'rfk_cgM8rX2h',
  })
  prefix!: string;

  @ApiProperty({ example: 'เว็บไซต์ osd.co.th (production)' })
  name!: string;

  @ApiProperty({ example: 'website' })
  source_code!: string | null;

  @ApiProperty({ type: [String], example: ['integration.crm.lead.create'] })
  scopes!: string[];

  @ApiProperty({
    description: 'active / expired / revoked — คำนวณจากวันหมดอายุและวันเพิกถอน',
    example: 'active',
  })
  status!: 'active' | 'expired' | 'revoked';

  @ApiProperty({ nullable: true, example: null })
  expires_at!: string | null;

  @ApiProperty({ nullable: true, example: '2026-09-14T09:30:00.000Z' })
  last_used_at!: string | null;

  @ApiProperty({ example: '2026-09-14T09:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ nullable: true }) created_by!: string | null;
}

/**
 * คำตอบของการออกกุญแจ — **ครั้งเดียวในชีวิตของกุญแจใบนั้นที่ค่าเต็มปรากฏ**.
 *
 * ฐานข้อมูลเก็บแค่ sha256 ดังนั้นไม่มี endpoint ไหนอ่านค่านี้กลับมาได้อีก และ
 * นั่นคือเจตนา: "ทำหาย" แปลว่า "ออกใบใหม่แล้วเพิกถอนใบเก่า" ไม่ใช่ "เปิดดู".
 */
export class IssuedApiKeyDto extends ApiKeyRowDto {
  @ApiProperty({
    description:
      'ตัวกุญแจเต็ม — แสดงครั้งเดียว คัดลอกแล้วส่งให้ผู้ดูแลช่องทางทันที',
    example: 'rfk_cgM8rX2hoXGsT6uuAsU0vjwLNpO14dpkQrkBgoyELOY',
  })
  key!: string;
}

/** ตัวเลือกที่หน้าจอเอาไปวาดเป็น checkbox. */
export class ApiKeyScopeDto {
  @ApiProperty({ example: 'integration.crm.lead.create' })
  code!: string;
}
