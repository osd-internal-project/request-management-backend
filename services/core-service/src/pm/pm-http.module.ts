import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageModule, type StorageOptions } from '@request-management/share';
import { MilestonesService } from './milestones.service';
import { PmModule } from './pm.module';
import { ProjectsController } from './projects.controller';

/** The screen-facing routes of {@link PmModule}. */
@Module({
  imports: [
    PmModule,
    // CD-182 milestone evidence — storage for the HTTP half only
    StorageModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<StorageOptions>('storage'),
    }),
  ],
  controllers: [ProjectsController],
  providers: [MilestonesService],
})
export class PmHttpModule {}
