import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** CD-236 — the register's search. */
export class ListAssetsQueryDto {
  @ApiPropertyOptional({
    description: 'serial / ชื่อ / รุ่น / สถานที่ / รหัสสินค้า',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  customer_id?: string;

  @ApiPropertyOptional({ enum: ['active', 'replaced', 'removed', 'all'] })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string;

  @ApiPropertyOptional({ enum: ['equipment', 'software'] })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  kind?: string;
}

/** CD-236 — an asset entered or corrected by hand. */
export class SaveAssetDto {
  @ApiPropertyOptional({ enum: ['equipment', 'software'] })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  kind?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  customer_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  product_code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  serial_no?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  location?: string;

  @ApiPropertyOptional({ description: 'ซอฟต์แวร์ที่บันทึกเอง: เวอร์ชัน' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  version?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  installed_on?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @ApiPropertyOptional({ description: 'เหตุผล (บังคับเมื่อแก้)' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

/** CD-236 — in use, replaced or removed, with the reason. */
export class AssetStatusDto {
  @ApiProperty({ enum: ['active', 'replaced', 'removed'] })
  @IsIn(['active', 'replaced', 'removed'])
  status!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}

/** CD-236 — one row of the file, as the browser parsed it. */
export class ImportAssetRowDto {
  @ApiProperty()
  @IsInt()
  row_no!: number;

  @ApiPropertyOptional({ description: 'รหัสลูกค้า (CUS-…)' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  customer_code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  kind?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  product_code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  serial_no?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  location?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  version?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10)
  installed_on?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** CD-236 — the base that predates the system, from a file. */
export class ImportAssetsDto {
  @ApiProperty({ enum: ['dry_run', 'commit'] })
  @IsIn(['dry_run', 'commit'])
  mode!: 'dry_run' | 'commit';

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  import_id!: string;

  @ApiProperty({ type: [ImportAssetRowDto] })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ImportAssetRowDto)
  rows!: ImportAssetRowDto[];
}
