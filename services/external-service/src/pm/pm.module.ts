import { Module } from '@nestjs/common';
import {
  MilestonesService,
  PmModule as CorePmModule,
} from '@request-management/core-service';
import { AuthModule } from '../auth/auth.module';
import { NoFileStorage } from '../common/no-file-storage';
import { ExternalProjectsController } from './projects.controller';

/**
 * `api/v1/pm/*` — projects from outside.
 *
 * `ProjectsService` comes from the PM domain module. `MilestonesService`
 * lives in core's `PmHttpModule` (milestone evidence is a file), so it is
 * declared here; listing milestones never touches a file.
 */
@Module({
  imports: [CorePmModule, AuthModule],
  controllers: [ExternalProjectsController],
  providers: [MilestonesService, NoFileStorage],
  exports: [CorePmModule],
})
export class PmModule {}
