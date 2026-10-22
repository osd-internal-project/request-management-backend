import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/** `app` = ในนามบริษัท, `delegated` = ในนามผู้ใช้ที่แนบ Keycloak token มา. */
export const INTEGRATION_MODES = ['app', 'delegated'] as const;
export type IntegrationMode = (typeof INTEGRATION_MODES)[number];

/** client id ของ Keycloak — ตรงกับ `azp` ของ token ที่ระบบนั้นได้มา. */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,255}$/;

export class CreateIntegrationDto {
  @ApiProperty({ example: 'Aiyara chatbot (production)', maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({
    description:
      'วิธีเรียกที่ยอมรับ — `app` ในนามบริษัท, `delegated` ในนามผู้ใช้',
    example: ['delegated'],
    enum: INTEGRATION_MODES,
    isArray: true,
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(INTEGRATION_MODES, { each: true })
  modes!: IntegrationMode[];

  @ApiPropertyOptional({
    description:
      'ยอมให้ระบุผู้ใช้ด้วยอีเมลใน `X-Acting-User` โดยผู้ใช้ไม่ได้ยืนยันตัวเอง — โหมดเดิม ไม่แนะนำ',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  allow_acting_user?: boolean;

  @ApiPropertyOptional({
    description:
      'Keycloak client ที่ token ใน `X-User-Token` ต้องออกให้ (`azp`)',
    example: ['aiyara-web'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(CLIENT_ID_PATTERN, {
    each: true,
    message:
      'keycloak_client_ids ต้องเป็น client id ของ Keycloak เช่น aiyara-web',
  })
  keycloak_client_ids?: string[];
}

export class UpdateIntegrationDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ enum: INTEGRATION_MODES, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(INTEGRATION_MODES, { each: true })
  modes?: IntegrationMode[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allow_acting_user?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(CLIENT_ID_PATTERN, {
    each: true,
    message:
      'keycloak_client_ids ต้องเป็น client id ของ Keycloak เช่น aiyara-web',
  })
  keycloak_client_ids?: string[];

  @ApiPropertyOptional({
    description: 'false = ปิดการเชื่อมต่อ — key ทุกใบของระบบนี้ถูกปฏิเสธทันที',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class IntegrationRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: INTEGRATION_MODES, isArray: true })
  modes!: string[];
  @ApiProperty() allow_acting_user!: boolean;
  @ApiProperty({ type: [String] }) keycloak_client_ids!: string[];
  @ApiProperty() active!: boolean;
  @ApiProperty() api_key_count!: number;
  @ApiProperty() webhook_count!: number;
  @ApiProperty() created_at!: string;
  @ApiProperty() created_by!: string;
}

export class IntegrationCallRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() at!: string;
  @ApiProperty() method!: string;
  @ApiProperty({ description: 'template ของ route ไม่ใช่ URL จริง' })
  route!: string;
  @ApiProperty({ enum: ['app', 'user_token', 'acting_user', 'person'] })
  mode!: string;
  @ApiProperty({ nullable: true }) api_key_id!: string | null;
  @ApiProperty({ nullable: true, description: 'NULL ในโหมด app' })
  actor_user_id!: string | null;
  @ApiProperty() status!: number;
  @ApiProperty() duration_ms!: number;
}
