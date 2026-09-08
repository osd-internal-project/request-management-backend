import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * The pagination and sort contract shared by every list endpoint — CTD spec
 * §11.1. Extend it in a feature DTO to add filters:
 *
 * @example
 * ```ts
 * export class ListRequestsDto extends PageQueryDto {
 *   @IsOptional() @IsString() status?: string;
 * }
 * ```
 */
export class PageQueryDto {
  @ApiPropertyOptional({
    description: 'เลขหน้าที่ต้องการ เริ่มที่ 1',
    minimum: 1,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    description: 'จำนวนรายการต่อหน้า',
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  page_size: number = DEFAULT_PAGE_SIZE;

  /** `sort=field` ascending, `sort=-field` descending. */
  @ApiPropertyOptional({
    description: '`sort=field` เรียงขึ้น, `sort=-field` เรียงลง',
    example: '-createdAt',
  })
  @IsOptional()
  @IsString()
  @Matches(/^-?[a-zA-Z_][a-zA-Z0-9_]*$/, {
    message: 'sort must be a field name, optionally prefixed with "-"',
  })
  sort?: string;
}

/** The response envelope every list endpoint returns. */
export interface Paginated<T> {
  data: T[];
  page: number;
  page_size: number;
  total: number;
}

/** Prisma `skip`/`take` for a page query. */
export function toSkipTake(query: PageQueryDto): {
  skip: number;
  take: number;
} {
  const page = query.page ?? 1;
  const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

  return { skip: (page - 1) * pageSize, take: pageSize };
}

/**
 * Prisma `orderBy` for a `sort` param, or `undefined` when none was given.
 *
 * `allowed` is the whitelist of sortable columns — anything outside it is
 * ignored rather than passed through, so a client cannot order by a column
 * that is not meant to be exposed.
 */
export function toOrderBy(
  sort: string | undefined,
  allowed: readonly string[],
): Record<string, 'asc' | 'desc'> | undefined {
  if (!sort) return undefined;

  const desc = sort.startsWith('-');
  const field = desc ? sort.slice(1) : sort;
  if (!allowed.includes(field)) return undefined;

  return { [field]: desc ? 'desc' : 'asc' };
}

/** Wraps rows in the §11.1 envelope. */
export function paginated<T>(
  data: T[],
  query: PageQueryDto,
  total: number,
): Paginated<T> {
  return {
    data,
    page: query.page ?? 1,
    page_size: query.page_size ?? DEFAULT_PAGE_SIZE,
    total,
  };
}
