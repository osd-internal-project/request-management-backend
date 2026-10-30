import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  NotContains,
  ValidateNested,
} from 'class-validator';
import { AGENT_ACTIONS, VENDORS } from '../agent-actions';
import {
  MAX_TIMEOUT_MINUTES,
  MIN_TIMEOUT_MINUTES,
} from '../outbound-connection';

const ENDPOINT_ID = /^[A-Za-z0-9_-]+$/;
const ACTIONS = Object.keys(AGENT_ACTIONS);

export class ListOutboundConnectionsDto {
  @ApiProperty() @IsUUID() integration_id!: string;
}

export class ActionEndpointDto {
  @ApiProperty({ enum: ACTIONS, example: 'lead.find' })
  @IsIn(ACTIONS)
  action!: string;

  @ApiProperty({ example: 'ep_192af84bf2f9417cbf9f4097e050d264' })
  @Matches(ENDPOINT_ID, { message: 'endpoint id ใช้ได้แค่ตัวอักษร ตัวเลข _ -' })
  @MaxLength(200)
  endpoint_id!: string;

  @ApiProperty({
    description: 'ไม่มีผลตอบกลับภายในกี่นาทีจึงปิดงานเป็น failed',
    minimum: MIN_TIMEOUT_MINUTES,
    maximum: MAX_TIMEOUT_MINUTES,
    example: 30,
  })
  @IsInt()
  @Min(MIN_TIMEOUT_MINUTES)
  @Max(MAX_TIMEOUT_MINUTES)
  timeout_minutes!: number;
}

export class CreateOutboundConnectionDto {
  @ApiProperty({ description: 'ระบบภายนอกที่การเชื่อมต่อนี้เป็นของ' })
  @IsUUID()
  integration_id!: string;

  @ApiProperty({ enum: VENDORS, example: 'vuvagent' })
  @IsIn(VENDORS)
  vendor!: string;

  @ApiProperty({ example: 'https://vuvagent.say2us.com' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  // the screen splits a pasted endpoint URL; a path that reaches here was not split
  @NotContains('/v1/', {
    message:
      'base URL ต้องไม่มี /v1/… — วาง URL ทั้งเส้นที่หน้าจอแล้วระบบจะแยกให้',
  })
  base_url!: string;

  @ApiProperty({ description: 'x-api-key ของ vendor' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  api_key!: string;

  @ApiPropertyOptional({ type: [ActionEndpointDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ACTIONS.length)
  @ValidateNested({ each: true })
  @Type(() => ActionEndpointDto)
  endpoints?: ActionEndpointDto[];
}

export class UpdateOutboundConnectionDto {
  @ApiPropertyOptional({ example: 'https://vuvagent.say2us.com' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @NotContains('/v1/', {
    message:
      'base URL ต้องไม่มี /v1/… — วาง URL ทั้งเส้นที่หน้าจอแล้วระบบจะแยกให้',
  })
  base_url?: string;

  @ApiPropertyOptional({ description: 'ไม่ส่ง = ใช้ key เดิม' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  api_key?: string;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;

  @ApiPropertyOptional({
    type: [ActionEndpointDto],
    description: 'แทนที่ทั้งชุด — งานที่ไม่อยู่ในรายการจะไม่มี endpoint',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ACTIONS.length)
  @ValidateNested({ each: true })
  @Type(() => ActionEndpointDto)
  endpoints?: ActionEndpointDto[];
}

export class TestOutboundConnectionDto {
  @ApiProperty({ enum: ACTIONS, example: 'lead.find' })
  @IsIn(ACTIONS)
  action!: string;
}

/** A row as the screen sees it — never the key. */
export class OutboundConnectionRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() integration_id!: string;
  @ApiProperty({ enum: VENDORS }) vendor!: string;
  @ApiProperty() base_url!: string;
  @ApiProperty() active!: boolean;
  @ApiProperty({ type: [ActionEndpointDto] }) endpoints!: ActionEndpointDto[];
  @ApiProperty() created_at!: string;
  @ApiProperty() updated_at!: string;
}

/** What each action sends, from `AGENT_ACTIONS` — the screen keeps no copy. */
export class AgentActionInfoDto {
  @ApiProperty({ example: 'lead.find' }) action!: string;
  @ApiProperty({ enum: VENDORS }) vendor!: string;
  @ApiProperty({ example: ['agent_record_id', 'topic'] })
  payload_fields!: string[];
  @ApiProperty({ example: 30 }) default_timeout_minutes!: number;
}

export class OutboundConnectionKeyDto {
  @ApiProperty() api_key!: string;
}

export class ConnectionTestResultDto {
  @ApiProperty() ok!: boolean;
  @ApiProperty({ nullable: true, type: Number }) status!: number | null;
  @ApiProperty() ms!: number;
  @ApiProperty({ nullable: true, type: String }) problem!: string | null;
}
