import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

export class ListCostCentersQueryDto {
  /** รหัสหรือชื่อ */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  /** `true` = รวมรายการที่ปิดใช้งานแล้ว (หน้าตั้งค่า) */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  include_inactive?: boolean;
}

export class CreateCostCenterDto {
  /** เช่น `2002` — ไม่ซ้ำในบริษัท แก้ภายหลังไม่ได้ เพราะใบเบิกเก่าอ้างถึงอยู่ */
  @IsString()
  @Matches(/^[A-Za-z0-9._-]{1,30}$/)
  code!: string;

  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsUUID()
  org_unit_id?: string;
}

export class UpdateCostCenterDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsUUID()
  org_unit_id?: string | null;

  /** ปิดใช้งานแทนการลบ — ฟอร์มใหม่เลือกไม่ได้ แต่ข้อมูลเก่ายังอ่านได้ */
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
