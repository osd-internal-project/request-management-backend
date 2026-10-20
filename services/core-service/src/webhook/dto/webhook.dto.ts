import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateWebhookDto {
  @ApiProperty({ example: 'ERP ฝ่ายบัญชี (production)', maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({
    description:
      'https ที่ใดก็ได้ — http หรือ host ในเครือข่ายภายในได้เฉพาะที่อยู่ใน WEBHOOK_PRIVATE_HOSTS',
    example: 'https://erp.example.com/hooks/request-management',
    maxLength: 2000,
  })
  @IsString()
  @MaxLength(2000)
  url!: string;

  @ApiProperty({
    description: 'ชื่อ event จาก `GET admin/webhooks/events`',
    example: ['request.approved', 'sla.breached'],
    type: [String],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  events!: string[];
}

export class UpdateWebhookDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  url?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  events?: string[];

  @ApiPropertyOptional({
    description: 'false = หยุดส่ง (ไม่ลบ ประวัติยังอยู่)',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class WebhookRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() url!: string;
  @ApiProperty({ type: [String] }) events!: string[];
  @ApiProperty() active!: boolean;
  @ApiProperty() created_at!: string;
  @ApiProperty() created_by!: string;
}

export class WebhookWithSecretDto extends WebhookRowDto {
  @ApiProperty({
    description:
      'ใช้ตรวจ `X-Webhook-Signature` — แสดงครั้งเดียว ทำหาย = กด "ออก secret ใหม่"',
  })
  secret!: string;
}

export class WebhookDeliveryRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() event_id!: string;
  @ApiProperty() event!: string;
  @ApiProperty({ enum: ['pending', 'sending', 'sent', 'dead'] })
  status!: string;
  @ApiProperty() attempts!: number;
  @ApiProperty({ nullable: true, type: Number }) last_status_code!:
    number | null;
  @ApiProperty({ nullable: true, type: String }) last_error!: string | null;
  @ApiProperty() next_attempt_at!: string;
  @ApiProperty({ nullable: true, type: String }) sent_at!: string | null;
  @ApiProperty() created_at!: string;
}
