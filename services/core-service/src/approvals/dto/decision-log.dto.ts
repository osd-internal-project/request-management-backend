import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { PageQueryDto } from '@request-management/share';

/**
 * ตัดสินในฐานะอะไร — คำถามที่รายงานการใช้อำนาจต้องตอบ:
 *   - `chain`       ผู้อนุมัติตามสาย (คนที่สายอนุมัติระบุ หรือหนึ่งในผู้มีสิทธิ์ของขั้น)
 *   - `delegate`    ผู้รับมอบอำนาจ ตัดสินแทนระหว่างช่วงมอบอำนาจ
 *   - `scope_grant` ตัดสินด้วยสิทธิ์ขอบเขตที่ผู้ดูแลให้ไว้ — นอกสายปกติ (ข้อยกเว้น)
 */
export const DECISION_BASES = ['chain', 'delegate', 'scope_grant'] as const;
export type DecisionBasis = (typeof DECISION_BASES)[number];

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** APV-06 (CD-45) — ตัวกรองของบันทึกการตัดสิน ใช้ทั้งหน้าจอและ export. */
export class DecisionLogQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    example: '2026-09-01',
    description: 'วันแรก (เวลาไทย) — ไม่ส่ง = วันที่ 1 ของเดือนนี้',
  })
  @IsOptional()
  @Matches(DAY)
  from?: string;

  @ApiPropertyOptional({
    example: '2026-09-30',
    description: 'วันสุดท้าย นับรวม (เวลาไทย) — ไม่ส่ง = วันนี้',
  })
  @IsOptional()
  @Matches(DAY)
  to?: string;

  @ApiPropertyOptional({ example: 'request:DSC' })
  @IsOptional()
  @IsString()
  subject_type?: string;

  @ApiPropertyOptional({ description: 'เฉพาะการตัดสินของคนนี้' })
  @IsOptional()
  @IsString()
  decided_by?: string;

  @ApiPropertyOptional({ enum: DECISION_BASES })
  @IsOptional()
  @IsIn(DECISION_BASES)
  basis?: DecisionBasis;
}
