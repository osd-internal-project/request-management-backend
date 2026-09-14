import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { AppError } from '@request-management/share';
import { API_KEY_PREFIX, ApiKeyService } from './api-key.service';
import type { ApiKeyRepository } from './api-key.repository';

/**
 * AUTH-06 — what a key must be before it opens anything.
 *
 * The exchange itself is not exercised here: it is one `fetch` to Keycloak, and
 * a test that stubs it only proves the stub. What these cover is the decision
 * that runs *before* it, where the rules live — and in particular the pair the
 * table exists for: a key with no expiry keeps working, and a revoked one stops.
 */
describe('ApiKeyService (AUTH-06)', () => {
  const KEY = `${API_KEY_PREFIX}abcdefghijklmnop`;
  const HASH = createHash('sha256').update(KEY).digest('hex');
  const TOKEN = 'minted-access-token';

  function serviceWith(row: Record<string, unknown> | null) {
    const findByHash = jest.fn().mockResolvedValue(row);
    const touch = jest.fn().mockResolvedValue(undefined);
    const keys = { findByHash, touch } as unknown as ApiKeyRepository;

    const config = {
      get: (path: string) =>
        ({
          'integration.clientId': 'aiyara-bot',
          'integration.clientSecret': 'not-a-real-secret',
          'keycloak.baseUrl': 'http://keycloak.invalid',
          'keycloak.realm': 'enterprise-request',
        })[path],
    } as unknown as ConfigService;

    const service = new ApiKeyService(keys, config);

    // Stand in for the Keycloak round trip so the assertions are about the
    // rules, not about the network.
    jest
      .spyOn(
        service as unknown as { integrationToken: () => Promise<string> },
        'integrationToken',
      )
      .mockResolvedValue(TOKEN);

    return { service, findByHash, touch };
  }

  const usable = {
    id: 'k1',
    prefix: KEY.slice(0, 12),
    name: 'Aiyara chatbot (prod)',
    companyId: null,
    sourceCode: null,
    scopes: [],
    active: true,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
  };

  it('ignores a bearer that is not an API key, without a lookup', async () => {
    const { service, findByHash } = serviceWith(null);

    await expect(
      service.resolve('Bearer eyJhbGciOi.some.jwt'),
    ).resolves.toBeNull();
    expect(findByHash).not.toHaveBeenCalled();
  });

  it('exchanges a key that never expires', async () => {
    const { service, findByHash } = serviceWith(usable);

    await expect(service.resolve(`Bearer ${KEY}`)).resolves.toMatchObject({
      accessToken: TOKEN,
    });
    expect(findByHash).toHaveBeenCalledWith(HASH);
  });

  it('accepts the key with no Bearer scheme, as Postman sends it', async () => {
    const { service } = serviceWith(usable);

    await expect(service.resolve(KEY)).resolves.toMatchObject({
      accessToken: TOKEN,
    });
  });

  it.each([
    ['unknown', null],
    ['switched off', { ...usable, active: false }],
    ['revoked', { ...usable, revokedAt: new Date('2026-09-01') }],
    ['expired', { ...usable, expiresAt: new Date('2026-09-01') }],
  ])('refuses a key that is %s', async (_case, row) => {
    const { service } = serviceWith(row);

    await expect(service.resolve(`Bearer ${KEY}`)).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it('accepts a key whose expiry is still ahead', async () => {
    const ahead = new Date(Date.now() + 86_400_000);
    const { service } = serviceWith({ ...usable, expiresAt: ahead });

    await expect(service.resolve(`Bearer ${KEY}`)).resolves.toMatchObject({
      accessToken: TOKEN,
    });
  });

  it('does not fail the call when the last-used stamp cannot be written', async () => {
    const { service, touch } = serviceWith(usable);
    touch.mockRejectedValue(new Error('write contended'));

    await expect(service.resolve(`Bearer ${KEY}`)).resolves.toMatchObject({
      accessToken: TOKEN,
    });
  });

  it('hands back what the key says about itself — company, channel, scopes', async () => {
    const { service } = serviceWith({
      ...usable,
      name: 'เว็บไซต์ osd.co.th',
      companyId: 'osd',
      sourceCode: 'website',
      scopes: ['integration.crm.lead.create'],
    });

    await expect(service.resolve(`Bearer ${KEY}`)).resolves.toMatchObject({
      accessToken: TOKEN,
      key: {
        companyId: 'osd',
        sourceCode: 'website',
        scopes: ['integration.crm.lead.create'],
      },
    });
  });
});
