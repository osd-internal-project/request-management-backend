import { Module } from '@nestjs/common';
import { PrincipalModule } from '../principal/principal.module';
import { CompanyPrefixRepository } from './company-prefix.repository';
import { RunNumberClient } from './run-number.client';

/**
 * ทางเดียวที่ core-service ขอเลขรัน.
 * import `PrincipalModule` เพื่อใช้ `ApiKeyService` แลก token ไม่ตั้ง logic ใหม่.
 */
@Module({
  imports: [PrincipalModule],
  providers: [RunNumberClient, CompanyPrefixRepository],
  exports: [RunNumberClient],
})
export class RunNumberClientModule {}
