import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Lead ที่ระบบภายนอกยิงเข้ามาเอง (14 ก.ย. 2569) — เว็บไซต์, LINE OA, ฟอร์มงาน
 * อีเวนต์, ระบบของพาร์ตเนอร์.
 *
 * เขียนเป็นคลาสของตัวเองแทนที่จะสืบจาก `CreateLeadDto` ด้วยเหตุผลสองข้อ:
 *
 * 1. **มันคือสัญญากับคนนอก.** ฟิลด์ที่นี่มี `@ApiProperty` ครบเพราะนักพัฒนา
 *    ฝั่งนั้นอ่านเอกสารที่ generate จากไฟล์นี้ ไม่ได้อ่านโค้ดเรา. ถ้าสืบจาก DTO
 *    ของหน้าจอ การเพิ่มช่องให้ฟอร์มภายในวันหนึ่งจะกลายเป็นการขยาย API สาธารณะ
 *    โดยไม่มีใครตั้งใจ.
 * 2. **ไม่มี `customer_id`.** ระบบภายนอกไม่รู้จัก uuid ของลูกค้าในทะเบียนเรา และ
 *    การเปิดช่องนี้ให้คนนอกคือการเปิดให้เดา uuid แล้วดูว่าตัวไหนมีจริง. การผูก
 *    Lead เข้ากับลูกค้าเดิมเป็นงานของคนที่รับใบไปดูแล.
 */
export class IntakeLeadDto {
  @ApiProperty({
    description: 'ชื่อผู้มุ่งหวัง — ชื่อบริษัท หรือชื่อคนถ้ายังไม่รู้บริษัท',
    example: 'บจก. ตัวอย่าง เทคโนโลยี',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  /**
   * ปกติ **ไม่ต้องส่ง** — ช่องทางมาจาก API key ที่ยิงเข้ามา.
   *
   * หนึ่ง key ต่อหนึ่งช่องทาง (14 ก.ย. 2569) กุญแจจึงรู้อยู่แล้วว่าตัวเองคือ
   * เว็บฟอร์มหรือ LINE OA และค่าจากกุญแจชนะค่าใน body เสมอ — แหล่งที่มาเป็น
   * ข้อเท็จจริงของผู้เรียก ไม่ใช่ช่องให้ผู้เรียกประกาศตัวเอง (ซึ่งพิมพ์ผิดได้
   * และพอตัวเลขการตลาดเพี้ยนก็ไล่ไม่ได้ว่าใบไหนมาจากไหน).
   *
   * เหลือไว้ให้ key ที่ยังไม่ได้ผูกช่องทาง — key เดิมทุกใบก่อนวันนั้น. ถ้าไม่มี
   * ทั้งสองทาง คำขอถูกปฏิเสธ: ใบที่ไม่มีต้นทางคือใบที่วัดผลไม่ได้.
   */
  @ApiPropertyOptional({
    description:
      'ช่องทางที่มา — ไม่ต้องส่งถ้า API key ผูกช่องทางไว้แล้ว (ค่าจาก key ชนะเสมอ). ' +
      'ส่งได้เฉพาะกรณี key ยังไม่ได้ผูก เช่น `website`, `line-oa`, `event-2026-q4`',
    example: 'website',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  source_code?: string;

  @ApiPropertyOptional({
    description:
      'รหัสแคมเปญ (CD-71) เช่นฟอร์มลงทะเบียนงานอีเวนต์ — ต้องเป็นแคมเปญที่เปิดอยู่',
    example: 'EXPO-2026-Q4',
    maxLength: 40,
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  campaign_code?: string;

  @ApiPropertyOptional({ description: 'ชื่อผู้ติดต่อ', example: 'สมชาย ใจดี' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  contact_name?: string;

  @ApiPropertyOptional({
    description: 'ตำแหน่ง/ฝ่ายของผู้ติดต่อ',
    example: 'ผู้จัดการฝ่ายไอที',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  contact_position?: string;

  @ApiPropertyOptional({ description: 'เบอร์ติดต่อ', example: '0812345678' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @ApiPropertyOptional({ example: 'somchai@example.co.th' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    description: 'สิ่งที่ผู้มุ่งหวังเขียนมา หรือบริบทที่ช่องทางนั้นเก็บได้',
    example: 'สนใจระบบ CCTV 3 สาขา ขอให้ติดต่อกลับช่วงบ่าย',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @ApiPropertyOptional({ description: 'ชื่อภาษาอังกฤษ' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name_en?: string;

  @ApiPropertyOptional({ description: 'เลขประจำตัวผู้เสียภาษี 13 หลัก' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  tax_id?: string;

  @ApiPropertyOptional({ example: 'ค้าปลีก' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  industry?: string;

  @ApiPropertyOptional({ example: 'SME' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  company_size?: string;

  @ApiPropertyOptional({ example: 120 })
  @IsOptional()
  @IsInt()
  @Min(0)
  employee_count?: number;

  @ApiPropertyOptional({
    description: 'กลุ่มสินค้าที่สนใจ',
    example: 'Security',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  product_group?: string;

  @ApiPropertyOptional({ example: 'CCTV' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  sub_product?: string;

  @ApiPropertyOptional({
    description: 'มูลค่าโครงการโดยประมาณ',
    example: 250000,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  project_revenue?: number;

  @ApiPropertyOptional({ example: '99/1 ถนนสุขุมวิท' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address_line?: string;

  @ApiPropertyOptional({ example: 'คลองเตย' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  district?: string;

  @ApiPropertyOptional({ example: 'กรุงเทพมหานคร' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  province?: string;

  @ApiPropertyOptional({ example: '10110' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  postal_code?: string;

  @ApiPropertyOptional({
    description: 'รหัสประเทศ 2 ตัว — ไม่ส่งถือเป็น TH',
    example: 'TH',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;
}

/** สิ่งที่ตอบกลับให้ระบบภายนอก — เท่าที่มันต้องใช้อ้างถึงใบนี้ต่อ. */
export class IntakeLeadResultDto {
  @ApiProperty({
    description: 'id ของ Lead ที่สร้าง — เก็บไว้ถ้าต้องอ้างกลับมาภายหลัง',
    example: '6f6bd3a7-7308-4d2e-a4de-75e1f89b6871',
  })
  id!: string;

  @ApiProperty({ example: 'บจก. ตัวอย่าง เทคโนโลยี' })
  name!: string;

  @ApiProperty({
    description:
      'ขั้นตั้งต้นของบริษัทนั้น — ตั้งได้จากหน้าตั้งค่า ไม่ใช่ค่าคงที่',
    example: 'new',
  })
  status!: string;

  @ApiProperty({
    description:
      'ช่องทางที่ระบบบันทึกให้ใบนี้ — มาจาก API key เว้นแต่ key ยังไม่ผูก',
    example: 'website',
  })
  source_code!: string;

  @ApiProperty({
    description:
      'เจ้าของใบ — เป็น null เสมอตอนสร้าง: ใบเข้ากองกลางรอพนักงานขายรับ',
    nullable: true,
    example: null,
  })
  owner_user_id!: string | null;

  @ApiProperty({ example: '2026-09-14T09:30:00.000Z' })
  created_at!: string;
}
