import { Module } from '@nestjs/common';
import { BiController } from './bi.controller';

/** CD-92: menu + signed embed URLs for the Metabase dashboards. */
@Module({
  controllers: [BiController],
})
export class BiModule {}
