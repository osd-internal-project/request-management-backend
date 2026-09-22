import { Module } from '@nestjs/common';
import { CompanyPrefixRepository } from './company-prefix.repository';
import { RunNumberClient } from './run-number.client';

/** ทางเดียวที่ core-service ขอเลขรัน — docs/run-number.md. */
@Module({
  providers: [RunNumberClient, CompanyPrefixRepository],
  exports: [RunNumberClient],
})
export class RunNumberClientModule {}
