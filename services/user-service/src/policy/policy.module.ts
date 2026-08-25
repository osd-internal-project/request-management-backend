import { Module } from '@nestjs/common';
import { PrismaTransactionService } from '@request-management/share';
import {
  InternalPolicyController,
  PolicyController,
} from './policy.controller';
import { PolicyService } from './policy.service';
import { ScopeRuleRepository } from './scope-rule.repository';
import { SensitiveFieldRuleRepository } from './sensitive-field-rule.repository';

@Module({
  controllers: [PolicyController, InternalPolicyController],
  providers: [
    PolicyService,
    ScopeRuleRepository,
    SensitiveFieldRuleRepository,
    PrismaTransactionService,
  ],
  exports: [PolicyService],
})
export class PolicyModule {}
