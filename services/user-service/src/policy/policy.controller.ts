import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  Authenticated,
  CurrentPrincipal,
  Permissions,
  ServiceAccountAllowed,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { PolicyService } from './policy.service';
import {
  ReplaceScopeRulesDto,
  ReplaceSensitiveFieldRulesDto,
} from './dto/policy.dto';

/** §11.3 — scope and masking configuration. */
@ApiTags('admin/policy')
@ApiBearerAuth()
@Controller('admin')
export class PolicyController {
  constructor(private readonly policyService: PolicyService) {}

  @Get('scope-rules')
  @Permissions('admin.role.manage')
  listScopeRules() {
    return this.policyService.listScopeRules();
  }

  @Put('scope-rules')
  @Permissions('admin.role.manage')
  replaceScopeRules(
    @Body() dto: ReplaceScopeRulesDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.policyService.replaceScopeRules(dto, principal);
  }

  @Get('sensitive-field-rules')
  @Permissions('admin.role.manage')
  listSensitiveFieldRules() {
    return this.policyService.listSensitiveFieldRules();
  }

  @Put('sensitive-field-rules')
  @Permissions('admin.role.manage')
  replaceSensitiveFieldRules(
    @Body() dto: ReplaceSensitiveFieldRulesDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.policyService.replaceSensitiveFieldRules(dto, principal);
  }
}

/**
 * How `core-service` learns who the caller is without reading this service's
 * tables (§03: services own their data and talk over internal APIs).
 *
 * It forwards the caller's own bearer token, so the answer is always about
 * that caller — this endpoint cannot be used to look up someone else.
 */
@ApiTags('internal')
@ApiBearerAuth()
@Controller('internal/policy')
export class InternalPolicyController {
  @Get('resolve')
  @Authenticated()
  @ServiceAccountAllowed()
  resolve(@CurrentPrincipal() principal: Principal): Principal {
    return principal;
  }
}
