import { Prisma, PrismaClient } from '@prisma/client';

/**
 * A client capable of running queries: either the long-lived PrismaClient or
 * the scoped client handed to an interactive `$transaction` callback.
 *
 * Repository methods accept one of these so the same method works inside and
 * outside a transaction.
 */
export type TQueryClient = PrismaClient | Prisma.TransactionClient;

/** Opt a repository call into an already-open transaction. */
export interface TxOption {
  readonly prisma?: TQueryClient;
}
