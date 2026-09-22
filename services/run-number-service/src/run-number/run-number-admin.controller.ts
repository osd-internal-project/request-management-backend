import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentPrincipal,
  Permissions,
  type Principal,
  type RunNumberFormat,
} from '@request-management/share';
import {
  CreateRunNumberSettingDto,
  PreviewRunNumberDto,
  UpdateRunNumberSettingDto,
} from './dto/run-number.dto';
import { RunNumberService } from './run-number.service';
import { RunNumberSettingsService } from './run-number-settings.service';

@ApiTags('admin/run-numbers')
@ApiBearerAuth()
@Controller('admin/run-numbers')
export class RunNumberAdminController {
  constructor(
    private readonly settings: RunNumberSettingsService,
    private readonly numbers: RunNumberService,
  ) {}

  @Get()
  @Permissions('admin.run-number.manage')
  list(@CurrentPrincipal() principal: Principal) {
    return this.settings.list(principal);
  }

  @Get('tokens')
  @Permissions('admin.run-number.manage')
  tokens(@Query('doc_type') docType: string) {
    return this.settings.tokens(docType);
  }

  // ต้องประกาศก่อน route ที่มี `:id` — Nest จับคู่ตามลำดับที่ประกาศ.
  @Post('preview')
  @Permissions('admin.run-number.manage')
  preview(
    @Body() dto: PreviewRunNumberDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    const override: RunNumberFormat | undefined = dto.pattern
      ? {
          pattern: dto.pattern,
          seqPadding: dto.seq_padding ?? 4,
          startNumber: dto.start_number ?? 1,
          resetPeriod: dto.reset_period ?? 'none',
        }
      : undefined;

    return this.numbers.preview(
      {
        companyId: principal.activeCompanyId,
        docType: dto.doc_type,
        scopeKey: dto.scope_key?.trim() || '*',
        // ค่าสมมุติ: ตาราง `companies` เป็นของ service อื่น (§03).
        companyPrefix: 'OSD',
        companyCode: 'OSD',
        at: new Date(),
        master: Object.fromEntries(
          this.settings
            .tokens(dto.doc_type)
            .filter((token) => token.token.startsWith('M:'))
            .map((token) => [token.token, token.sample]),
        ),
      },
      override,
    );
  }

  @Post()
  @Permissions('admin.run-number.manage')
  create(
    @Body() dto: CreateRunNumberSettingDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.settings.create(dto, principal);
  }

  @Patch(':id')
  @Permissions('admin.run-number.manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateRunNumberSettingDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.settings.update(id, dto, principal);
  }

  @Delete(':id')
  @Permissions('admin.run-number.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.settings.remove(id, principal);
  }
}
