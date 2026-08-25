import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { TQueryClient, TxOption } from './types';

/** Longest a transaction may wait for a free connection. */
const MAX_WAIT_MS = 60 * 1000;
/** Longest a transaction may stay open before Prisma rolls it back. */
const TIMEOUT_MS = 15 * 60 * 1000;

@Injectable()
export class PrismaTransactionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs `work` inside a transaction and hands it the scoped client to pass
   * down to repositories. If `option.prisma` is already a transaction client,
   * the callback joins that transaction instead of opening a nested one.
   */
  async execute<T>(
    work: (prisma: TQueryClient) => Promise<T>,
    option?: TxOption,
  ): Promise<T> {
    if (option?.prisma) {
      return work(option.prisma);
    }

    return this.prisma.$transaction((tx) => work(tx), {
      maxWait: MAX_WAIT_MS,
      timeout: TIMEOUT_MS,
    });
  }
}
