import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * สิ่งที่ workflow ส่งกลับมาเมื่อมันตัดสินใจเลื่อนขั้นแล้ว — snake_case ตาม
 * §11.1 เหมือน DTO อื่นในโมดูลนี้.
 *
 * ไม่มีฟิลด์ไหนอธิบาย *เหตุผล* ของการเลื่อนขั้นเชิงกฎ เพราะ core ไม่ตัดสิน:
 * `reason` เป็นข้อความสำหรับ audit ไม่ใช่เงื่อนไขที่ core ตรวจ.
 */
export class ApplyLeadStageDto {
  /** รหัสสถานะปลายทาง — ต้องมีอยู่จริงใน `lead_statuses` ของบริษัทนี้. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  stage!: string;

  /** instance ของ workflow ที่สั่ง — เก็บลง audit เพื่อสาวกลับได้ว่าใครสั่ง. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  instance_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
