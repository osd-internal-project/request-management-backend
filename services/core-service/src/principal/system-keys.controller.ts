import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  AppError,
  CurrentPrincipal,
  PageQueryDto,
  SystemPermissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { ApiKeyAdminService } from './api-key-admin.service';
import { IntegrationAdminService } from './integration-admin.service';
import { INTEGRATION_PRESETS } from './integration-presets';
import { IssueApiKeyDto, UpdateApiKeyScopesDto } from './dto/api-key.dto';
import {
  CreateIntegrationDto,
  UpdateIntegrationDto,
} from './dto/integration.dto';

/** Keys and integrations no company owns (`companyId` null). */
const SYSTEM = null;

/**
 * P8 + hub (14 พ.ย. 2569) — the company screens' services, run with the owner of
 * the row being touched: `null` for shared rows, the company for a company's row.
 * Creating an integration stays shared-only. A shared key reaches every company it
 * is allowed into, so it must expire; a company's key keeps the company's rule.
 */
@ApiTags('system')
@ApiBearerAuth()
@Controller('system/api-keys')
export class SystemKeysController {
  constructor(
    private readonly keys: ApiKeyAdminService,
    private readonly integrations: IntegrationAdminService,
  ) {}

  @Get('scopes')
  @SystemPermissions('system.integration.manage')
  scopes() {
    return this.keys.scopes();
  }

  /** `integration_id` = keys of that integration's owner; none = shared keys. */
  @Get()
  @SystemPermissions('system.integration.manage')
  async listKeys(
    @CurrentPrincipal() principal: Principal,
    @Query('integration_id') integrationId?: string,
  ) {
    const owner = integrationId
      ? await this.integrations.ownerOf(integrationId)
      : SYSTEM;
    return this.keys.list(principal, owner);
  }

  @Post()
  @SystemPermissions('system.integration.manage')
  async issue(
    @Body() dto: IssueApiKeyDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    const owner = dto.integration_id
      ? await this.integrations.ownerOf(dto.integration_id)
      : SYSTEM;
    if (owner === SYSTEM && !dto.expires_in_days) {
      throw new AppError(
        'VALIDATION_FAILED',
        'กุญแจระดับระบบต้องมีวันหมดอายุ',
        [{ field: 'expires_in_days', reason: 'required' }],
      );
    }
    return this.keys.issue(dto, principal, owner);
  }

  @Get(':id/secret')
  @SystemPermissions('system.integration.manage')
  async reveal(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.keys.reveal(id, principal, await this.keys.ownerOf(id));
  }

  @Get(':id/examples')
  @SystemPermissions('system.integration.manage')
  async examples(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.keys.examples(id, principal, await this.keys.ownerOf(id));
  }

  @Post(':id/rotate')
  @SystemPermissions('system.integration.manage')
  async rotate(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.keys.rotate(id, principal, await this.keys.ownerOf(id));
  }

  @Patch(':id/scopes')
  @SystemPermissions('system.integration.manage')
  async updateScopes(
    @Param('id') id: string,
    @Body() dto: UpdateApiKeyScopesDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.keys.updateScopes(
      id,
      dto,
      principal,
      await this.keys.ownerOf(id),
    );
  }

  @Post(':id/revoke')
  @SystemPermissions('system.integration.manage')
  async revoke(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.keys.revoke(id, principal, await this.keys.ownerOf(id));
  }
}

/** Hub — every company's integrations and the shared ones; edits run as the row's owner. */
@ApiTags('system')
@ApiBearerAuth()
@Controller('system/integrations')
export class SystemIntegrationsController {
  constructor(private readonly integrations: IntegrationAdminService) {}

  /** ประกาศก่อน `:id` — ชุด scope สำเร็จรูปชุดเดียวกับหน้าบริษัท */
  @Get('presets')
  @SystemPermissions('system.integration.manage')
  presets() {
    return INTEGRATION_PRESETS;
  }

  /** `company_id` = one company, `system` = shared only, none = all. */
  @Get()
  @SystemPermissions('system.integration.manage')
  listIntegrations(@Query('company_id') companyId?: string) {
    return this.integrations.listAcrossCompanies(companyId || undefined);
  }

  @Post()
  @SystemPermissions('system.integration.manage')
  createIntegration(
    @Body() dto: CreateIntegrationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.integrations.create(dto, principal, SYSTEM);
  }

  @Get(':id/calls')
  @SystemPermissions('system.integration.manage')
  async calls(
    @Param('id') id: string,
    @Query() query: PageQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    const owner = await this.integrations.ownerOf(id);
    return this.integrations.listCalls(id, query, principal, owner);
  }

  @Patch(':id')
  @SystemPermissions('system.integration.manage')
  async updateIntegration(
    @Param('id') id: string,
    @Body() dto: UpdateIntegrationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    const owner = await this.integrations.ownerOf(id);
    return this.integrations.update(id, dto, principal, owner);
  }
}
