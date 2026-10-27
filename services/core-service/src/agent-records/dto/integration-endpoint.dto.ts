import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { AGENT_ACTIONS } from '../agent-actions';

const ENDPOINT_ID = /^[A-Za-z0-9_-]+$/;

export class ListIntegrationEndpointsDto {
  @ApiProperty() @IsUUID() integration_id!: string;
}

export class CreateIntegrationEndpointDto {
  @ApiProperty({ description: 'ระบบภายนอกที่ endpoint นี้เป็นของ' })
  @IsUUID()
  integration_id!: string;

  @ApiProperty({ enum: Object.keys(AGENT_ACTIONS), example: 'lead.find' })
  @IsIn(Object.keys(AGENT_ACTIONS))
  action!: string;

  @ApiProperty({ example: 'https://d80g4r2y4zcsb.cloudfront.net' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  base_url!: string;

  @ApiProperty({ example: 'ep_192af84bf2f9417cbf9f4097e050d264' })
  @Matches(ENDPOINT_ID, { message: 'endpoint id ใช้ได้แค่ตัวอักษร ตัวเลข _ -' })
  @MaxLength(200)
  endpoint_id!: string;

  @ApiProperty({ description: '`x-api-key` ของปลายทาง — เก็บแบบเข้ารหัส' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  api_key!: string;
}

/** Every field optional; an omitted `api_key` keeps the stored one. */
export class UpdateIntegrationEndpointDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  base_url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(ENDPOINT_ID, { message: 'endpoint id ใช้ได้แค่ตัวอักษร ตัวเลข _ -' })
  @MaxLength(200)
  endpoint_id?: string;

  @ApiPropertyOptional({ description: 'ไม่ส่ง = ใช้ key เดิม' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  api_key?: string;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
}

/** A row as the screen sees it — never the key. */
export class IntegrationEndpointRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() integration_id!: string;
  @ApiProperty() action!: string;
  @ApiProperty() base_url!: string;
  @ApiProperty() endpoint_id!: string;
  @ApiProperty() active!: boolean;
  @ApiProperty() created_at!: string;
  @ApiProperty() updated_at!: string;
}

export class IntegrationEndpointKeyDto {
  @ApiProperty() api_key!: string;
}
