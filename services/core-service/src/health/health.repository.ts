import { Injectable, Logger } from '@nestjs/common';
import {
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';

/**
 * Not a model repository — it owns the one raw query the health check needs,
 * keeping direct PrismaService use out of the service layer.
 */
@Injectable()
export class HealthRepository {
  private readonly logger = new Logger(HealthRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Round-trips the cheapest possible query to prove the database answers. */
  async ping(option?: TxOption): Promise<boolean> {
    const client: TQueryClient = option?.prisma ?? this.prisma;

    try {
      await client.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.warn(
        `Database ping failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
