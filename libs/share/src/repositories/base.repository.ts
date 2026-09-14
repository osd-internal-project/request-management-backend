import { PrismaService } from '../modules/prisma/prisma.service';
import { TQueryClient, TxOption } from '../modules/prisma/types';

/**
 * Structural stand-in for a Prisma model delegate (`prisma.user`, …).
 * `never[]` parameters make this "any function" without reaching for `any`.
 */
type DelegateFn = (...args: never[]) => unknown;

export interface PrismaDelegate {
  findMany: DelegateFn;
  findFirst: DelegateFn;
  findUnique: DelegateFn;
  create: DelegateFn;
  createMany: DelegateFn;
  update: DelegateFn;
  updateMany: DelegateFn;
  upsert: DelegateFn;
  delete: DelegateFn;
  count: DelegateFn;
}

type Args<
  TDelegate extends PrismaDelegate,
  K extends keyof PrismaDelegate,
> = Parameters<TDelegate[K]>[0];
type Result<
  TDelegate extends PrismaDelegate,
  K extends keyof PrismaDelegate,
> = ReturnType<TDelegate[K]>;

/**
 * Shared CRUD surface for every repository, replacing the one-file-per-model
 * boilerplate. Subclasses supply the delegate and add domain queries.
 *
 * Every method takes an optional `TxOption`, so the same repository call works
 * standalone or inside `PrismaTransactionService.execute`.
 *
 * @example
 * ```ts
 * @Injectable()
 * export class UsersRepository extends BaseRepository<PrismaService['user']> {
 *   constructor(prisma: PrismaService) { super(prisma); }
 *   protected delegate(client: TQueryClient) { return client.user; }
 * }
 * ```
 */
export abstract class BaseRepository<TDelegate extends PrismaDelegate> {
  protected constructor(protected readonly prisma: PrismaService) {}

  /** Resolves the model delegate against the transaction client, when given. */
  protected abstract delegate(client: TQueryClient): TDelegate;

  protected client(option?: TxOption): TDelegate {
    return this.delegate(option?.prisma ?? this.prisma);
  }

  findMany(args?: Args<TDelegate, 'findMany'>, option?: TxOption) {
    return this.call('findMany', args, option);
  }

  findFirst(args?: Args<TDelegate, 'findFirst'>, option?: TxOption) {
    return this.call('findFirst', args, option);
  }

  findUnique(args: Args<TDelegate, 'findUnique'>, option?: TxOption) {
    return this.call('findUnique', args, option);
  }

  create(args: Args<TDelegate, 'create'>, option?: TxOption) {
    return this.call('create', args, option);
  }

  createMany(args: Args<TDelegate, 'createMany'>, option?: TxOption) {
    return this.call('createMany', args, option);
  }

  update(args: Args<TDelegate, 'update'>, option?: TxOption) {
    return this.call('update', args, option);
  }

  /**
   * Conditional write — the `where` may name columns that are not unique, and
   * the returned `count` says whether the row still matched.
   *
   * That count is the point. `update` addresses a row by id and overwrites it
   * whatever it now holds, so "claim this lead only while nobody owns it"
   * written with `update` is a read followed by a write with a gap in between:
   * two people claiming at once both read `NULL` and the second silently wins.
   * With the condition in the statement, the database decides, and `count: 0`
   * is the loser's answer.
   */
  updateMany(args: Args<TDelegate, 'updateMany'>, option?: TxOption) {
    return this.call('updateMany', args, option);
  }

  upsert(args: Args<TDelegate, 'upsert'>, option?: TxOption) {
    return this.call('upsert', args, option);
  }

  delete(args: Args<TDelegate, 'delete'>, option?: TxOption) {
    return this.call('delete', args, option);
  }

  count(args?: Args<TDelegate, 'count'>, option?: TxOption) {
    return this.call('count', args, option);
  }

  private call<K extends keyof PrismaDelegate>(
    method: K,
    args: Args<TDelegate, K> | undefined,
    option?: TxOption,
  ): Result<TDelegate, K> {
    // Inside a generic body TS cannot prove `delegate[method]` accepts `args`;
    // the public signatures above pin both types at every real call site.
    // `args` is optional because findMany/findFirst/count take no required args.
    // Cast the delegate rather than the extracted method so the call stays a
    // member invocation and keeps its `this` binding.
    const delegate = this.client(option) as Record<
      K,
      (a?: Args<TDelegate, K>) => Result<TDelegate, K>
    >;

    return delegate[method](args);
  }
}
