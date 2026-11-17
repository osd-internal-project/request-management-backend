import { ValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import {
  ExternalListRequestsDto,
  ExternalTypeQueryDto,
  ExternalUsersDto,
} from './request.dto';

// The same pipe main.ts installs: `whitelist` is what used to drop `search`.
const pipe = new ValidationPipe({ whitelist: true, transform: true });

function parse<T>(metatype: new () => T, query: Record<string, string>) {
  const meta: ArgumentMetadata = { type: 'query', metatype };
  return pipe.transform(query, meta) as Promise<T>;
}

describe.each([
  ['GET request/users', ExternalUsersDto],
  ['GET request/requests', ExternalListRequestsDto],
  ['GET request/types', ExternalTypeQueryDto],
] as const)('%s search term', (_route, dto) => {
  it('takes `search` as the term', async () => {
    const query = await parse<{ q?: string }>(dto, { search: 'ชนะกุล' });
    expect(query.q).toBe('ชนะกุล');
    expect(query).not.toHaveProperty('search');
  });

  it('prefers `q` when both are sent', async () => {
    const query = await parse<{ q?: string }>(dto, { q: 'a', search: 'b' });
    expect(query.q).toBe('a');
  });

  it('leaves the term unset when neither is sent', async () => {
    const query = await parse<{ q?: string }>(dto, {});
    expect(query.q).toBeUndefined();
  });
});
