import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { PrismaTransactionService } from './prisma-transaction.service';

/**
 * Global so any feature module can inject PrismaService without importing it.
 *
 * Repositories are deliberately NOT registered here — each feature module
 * provides the repositories it owns, so this list never has to grow.
 */
@Global()
@Module({
  providers: [PrismaService, PrismaTransactionService],
  exports: [PrismaService, PrismaTransactionService],
})
export class PrismaModule {}
