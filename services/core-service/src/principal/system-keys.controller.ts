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
import { IssueApiKeyDto, UpdateApiKeyScopesDto } from './dto/api-key.dto';
import {
  CreateIntegrationDto,
  UpdateIntegrationDto,
} from './dto/integration.dto';

/** Keys and integrations no company owns (`companyId` null). */
const SYSTEM = null;

/**
 * P8 — the company screens' services, owner `null`. A system key reaches
 * every company it is sent to, so it must expire.
 */
@ApiTags('system')
@ApiBearerAuth()
@Controller('system/api-keys')
export class SystemKeysController {
  constructor(private readonly keys: ApiKeyAdminService) {}

  @Get('scopes')
  @SystemPermissions('system.integration.manage')
  scopes() {
    return this.keys.scopes();
  }

  @Get()
  @SystemPermissions('system.integration.manage')
  listKeys(@CurrentPrincipal() principal: Principal) {
    return this.keys.list(principal, SYSTEM);
  }

  @Post()
  @SystemPermissions('system.integration.manage')
  issue(@Body() dto: IssueApiKeyDto, @CurrentPrincipal() principal: Principal) {
    if (!dto.expires_in_days) {
      throw new AppError(
        'VALIDATION_FAILED',
        'กุญแจระดับระบบต้องมีวันหมดอายุ',
        [{ field: 'expires_in_days', reason: 'required' }],
      );
    }
    return this.keys.issue(dto, principal, SYSTEM);
  }

  @Get(':id/secret')
  @SystemPermissions('system.integration.manage')
  reveal(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.keys.reveal(id, principal, SYSTEM);
  }

  @Get(':id/examples')
  @SystemPermissions('system.integration.manage')
  examples(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.keys.examples(id, principal, SYSTEM);
  }

  @Post(':id/rotate')
  @SystemPermissions('system.integration.manage')
  rotate(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.keys.rotate(id, principal, SYSTEM);
  }

  @Patch(':id/scopes')
  @SystemPermissions('system.integration.manage')
  updateScopes(
    @Param('id') id: string,
    @Body() dto: UpdateApiKeyScopesDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.keys.updateScopes(id, dto, principal, SYSTEM);
  }

  @Post(':id/revoke')
  @SystemPermissions('system.integration.manage')
  revoke(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.keys.revoke(id, principal, SYSTEM);
  }
}

/** P8 — integrations no company owns; the same service as the company screen, owner `null`. */
@ApiTags('system')
@ApiBearerAuth()
@Controller('system/integrations')
export class SystemIntegrationsController {
  constructor(private readonly integrations: IntegrationAdminService) {}

  @Get()
  @SystemPermissions('system.integration.manage')
  listIntegrations(@CurrentPrincipal() principal: Principal) {
    return this.integrations.list(principal, SYSTEM);
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
  calls(
    @Param('id') id: string,
    @Query() query: PageQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.integrations.listCalls(id, query, principal, SYSTEM);
  }

  @Patch(':id')
  @SystemPermissions('system.integration.manage')
  updateIntegration(
    @Param('id') id: string,
    @Body() dto: UpdateIntegrationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.integrations.update(id, dto, principal, SYSTEM);
  }
}
