import { createHmac } from 'node:crypto';

import {
  addressProblems,
  eventProblems,
  isPrivateAddress,
  nextAttemptDelayMs,
  newWebhookSecret,
  signWebhook,
  standardSignature,
  urlProblems,
} from './webhook-rules';

describe('G-07 webhook rules', () => {
  it('signs timestamp.body with HMAC-SHA256 the way a receiver recomputes it', () => {
    const expected = createHmac('sha256', 'whsec_x')
      .update('1700000000.{"a":1}')
      .digest('hex');

    expect(signWebhook('whsec_x', '1700000000', '{"a":1}')).toBe(
      `sha256=${expected}`,
    );
    expect(signWebhook('whsec_x', '1700000001', '{"a":1}')).not.toBe(
      `sha256=${expected}`,
    );
  });

  it('webhook-signature matches the Standard Webhooks reference vector', () => {
    expect(
      standardSignature(
        'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
        'msg_p5jXN8AQM9LWM0D4loKWxJek',
        '1614265330',
        '{"test": 2432232314}',
      ),
    ).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('a new secret is standard base64, so the standardwebhooks library can decode it', () => {
    const body = newWebhookSecret().replace(/^whsec_/, '');
    expect(body).toMatch(/^[A-Za-z0-9+/]{32}$/);
    expect(Buffer.from(body, 'base64')).toHaveLength(24);
  });

  it('retries five times with growing delays, then gives up', () => {
    expect(nextAttemptDelayMs(1)).toBe(60_000);
    expect(nextAttemptDelayMs(5)).toBe(6 * 3_600_000);
    expect(nextAttemptDelayMs(6)).toBeNull();
  });

  it('accepts catalog events and ping, refuses unknown or none', () => {
    expect(eventProblems(['request.approved', 'webhook.ping'])).toEqual([]);
    expect(eventProblems([])).toHaveLength(1);
    expect(eventProblems(['request.exploded'])[0]).toContain(
      'request.exploded',
    );
  });

  it('allows https anywhere and http only to an allow-listed host', () => {
    expect(urlProblems('https://hooks.example.com/x', [])).toEqual([]);
    expect(urlProblems('http://hooks.example.com/x', [])).toHaveLength(1);
    expect(urlProblems('http://erp.local:8080/x', ['erp.local'])).toEqual([]);
    expect(urlProblems('ftp://erp.local/x', ['erp.local'])).toHaveLength(1);
    expect(urlProblems('https://u:p@hooks.example.com', [])).toHaveLength(1);
    expect(urlProblems('not a url', [])).toHaveLength(1);
  });

  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.32.0.1', false],
    ['192.168.31.55', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['8.8.8.8', false],
    ['::1', true],
    ['fd00::1', true],
    ['fe80::1', true],
    ['::ffff:10.0.0.1', true],
    ['2606:4700::1111', false],
  ])('isPrivateAddress(%s) = %s', (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });

  it('refuses a public name that resolves inside, unless the host is allow-listed', async () => {
    const inside = jest.fn().mockResolvedValue([{ address: '192.168.31.55' }]);
    const outside = jest.fn().mockResolvedValue([{ address: '93.184.216.34' }]);

    expect(
      await addressProblems('https://evil.example.com', [], inside),
    ).toHaveLength(1);
    expect(
      await addressProblems('https://hooks.example.com', [], outside),
    ).toEqual([]);
    expect(
      await addressProblems('http://erp.local', ['erp.local'], inside),
    ).toEqual([]);
    expect(inside).toHaveBeenCalledTimes(1);
  });

  it('checks a literal IP without DNS and reports an unresolvable host', async () => {
    const lookup = jest.fn().mockRejectedValue(new Error('ENOTFOUND'));

    expect(await addressProblems('https://127.0.0.1', [], lookup)).toHaveLength(
      1,
    );
    expect(lookup).not.toHaveBeenCalled();
    expect(await addressProblems('https://nope.invalid', [], lookup)).toEqual([
      'หา host nope.invalid ไม่พบ',
    ]);
  });
});
