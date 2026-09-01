import { Module } from '@nestjs/common';
import { AccessService } from './access.service';
import { OrgUnitRepository } from './org-unit.repository';

/**
 * Read-only access to the org chart, and the questions answered from it.
 *
 * The chart itself is user-service's to maintain (D-08); nothing here writes
 * to it. It lives in its own module because two feature modules ask the same
 * questions — requests, for which groups may raise a type, and approvals, for
 * who may decide a level — and a copy in each is a copy that drifts.
 */
@Module({
  providers: [AccessService, OrgUnitRepository],
  exports: [AccessService, OrgUnitRepository],
})
export class AccessModule {}
