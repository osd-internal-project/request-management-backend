import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PageQueryDto } from '@request-management/share';
import {
  CONTACT_KINDS,
  OPT_OUT_CHANNELS,
  OPT_OUT_SOURCES,
} from './contact-rules';

export class ListOptOutsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'เบอร์โทรหรืออีเมล' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ enum: OPT_OUT_SOURCES })
  @IsOptional()
  @IsIn(OPT_OUT_SOURCES)
  source?: string;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description: '`false` = รวมรายการที่ยกเลิกแล้ว',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  active?: string;
}

export class AddOptOutDto {
  @ApiProperty({ enum: CONTACT_KINDS })
  @IsIn(CONTACT_KINDS)
  kind!: (typeof CONTACT_KINDS)[number];

  @ApiProperty({ example: '0812345678' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  value!: string;

  @ApiProperty({
    enum: OPT_OUT_CHANNELS,
    description: '`call` = ห้ามโทร · `all` = ห้ามติดต่อทุกช่องทาง',
  })
  @IsIn(OPT_OUT_CHANNELS)
  channel!: (typeof OPT_OUT_CHANNELS)[number];

  @ApiPropertyOptional({ example: 'ลูกค้าแจ้งทางอีเมลว่าไม่ต้องการให้ติดต่อ' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class RemoveOptOutDto {
  @ApiProperty({ example: 'ลูกค้ากลับมาขอให้ติดต่อได้ (มีหลักฐานอีเมล)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
