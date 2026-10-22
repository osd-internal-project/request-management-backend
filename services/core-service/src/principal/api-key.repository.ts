import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** The one table AUTH-06 owns: credentials an integration holds. */
@Injectable()
export class ApiKeyRepository extends BaseRepository<PrismaService['apiKey']> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.apiKey;
  }

  /**
   * The key with this hash, whatever its state.
   *
   * Deliberately not filtered to usable keys: the caller decides *why* a key
   * was refused, and "revoked" and "never existed" want the same answer to the
   * caller but different lines in the log.
   */
  findByHash(keyHash: string) {
    return this.findFirst({
      where: { keyHash },
      include: { integration: true },
    });
  }

  /**
   * Record that a key was used, at most once a minute.
   *
   * Every request would otherwise turn a read path into a write path. A
   * last-used stamp accurate to the minute answers the questions it is for —
   * which keys are dead, which one is the chatbot — and none of them need
   * finer resolution.
   */
  async touch(id: string, lastUsedAt: Date | null): Promise<void> {
    const A_MINUTE = 60_000;
    if (lastUsedAt && Date.now() - lastUsedAt.getTime() < A_MINUTE) return;

    await this.update({ where: { id }, data: { lastUsedAt: new Date() } });
  }
}
