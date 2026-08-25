import { Module } from '@nestjs/common';
import { SlaController } from './sla.controller';

/** S3 — the minimum clock from §09. */
@Module({
  controllers: [SlaController],
})
export class SlaModule {}
