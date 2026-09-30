import { Module } from '@nestjs/common';
import { PmModule } from './pm.module';
import { ProjectsController } from './projects.controller';

/** The screen-facing routes of {@link PmModule}. */
@Module({
  imports: [PmModule],
  controllers: [ProjectsController],
})
export class PmHttpModule {}
