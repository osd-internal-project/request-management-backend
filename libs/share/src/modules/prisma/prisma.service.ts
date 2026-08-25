import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Thin wrapper around PrismaClient, shared by every app in apps/*.
 *
 * NOTE: this project does not have a real database connected yet.
 * `DATABASE_URL` is a placeholder until one is provisioned, so `onModuleInit`
 * warns instead of throwing on a failed connection — bootstrapping must not
 * depend on a live database. Repositories that query through this service
 * will still reject; callers decide how to degrade.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    try {
      await this.$connect();
    } catch {
      this.logger.warn(
        'Could not connect to the database. This is expected until a real DATABASE_URL is configured.',
      );
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
