import { Module } from '@nestjs/common';
import { AssignmentModule } from './assignment.module';
import { AssignmentAdminController } from './assignment-admin.controller';

/** The admin screen's routes; internal port only (see `src/index.ts`). */
@Module({
  imports: [AssignmentModule],
  controllers: [AssignmentAdminController],
})
export class AssignmentHttpModule {}
