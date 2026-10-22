/**
 * G-07 — outbound webhooks: the rules, apart from the database and the
 * network — which events exist, how a body is signed, when to retry, and
 * which URLs may be called.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { DOMAIN_EVENTS } from '../events/event-catalog';

/** Sent by "test" in the admin page; never emitted by the domain. */
export const WEBHOOK_PING = 'webhook.ping';

export const WEBHOOK_EVENTS: readonly string[] = [
  ...Object.values(DOMAIN_EVENTS),
  WEBHOOK_PING,
];

/** Delay before retry n (1-based); 6 attempts in all, then `dead`. */
export const RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  6 * 3_600_000,
] as const;

export const DELIVERY_TIMEOUT_MS = 10_000;

/** When to try again after `attempts` failed tries, or null = give up. */
export function nextAttemptDelayMs(attempts: number): number | null {
  return RETRY_DELAYS_MS[attempts - 1] ?? null;
}

/** base64 มาตรฐาน (ไม่ใช่ base64url) — library `standardwebhooks` decode ได้เฉพาะแบบนี้. */
export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64')}`;
}

/** `X-Webhook-Signature` — timestamp is signed too, so a captured call cannot be replayed later. */
export function signWebhook(
  secret: string,
  timestamp: string,
  body: string,
): string {
  const mac = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return `sha256=${mac}`;
}

/**
 * `webhook-signature` ตาม Standard Webhooks — key คือ bytes ของ secret หลัง `whsec_`.
 * Node decode `base64` รับตัวอักษร base64url ด้วย secret เดิมจึงเซ็นได้เหมือนกัน.
 */
export function standardSignature(
  secret: string,
  id: string,
  timestamp: string,
  body: string,
): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const mac = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
  return `v1,${mac}`;
}

export function eventProblems(events: readonly string[]): string[] {
  if (events.length === 0) return ['ต้องเลือกอย่างน้อยหนึ่ง event'];
  const unknown = events.filter((name) => !WEBHOOK_EVENTS.includes(name));
  return unknown.length ? [`ไม่รู้จัก event: ${unknown.join(', ')}`] : [];
}

/**
 * Shape of the URL only. https anywhere; http only to a host the operator
 * listed in `WEBHOOK_PRIVATE_HOSTS`. Where it resolves is `addressProblems`.
 */
export function urlProblems(
  raw: string,
  privateHosts: readonly string[],
): string[] {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return ['URL ไม่ถูกต้อง'];
  }
  if (url.username || url.password) return ['URL ต้องไม่มีรหัสผ่านฝังอยู่'];
  const allowed = privateHosts.includes(url.hostname.toLowerCase());
  if (url.protocol === 'https:') return [];
  if (url.protocol === 'http:' && allowed) return [];
  return ['ต้องเป็น https (http ได้เฉพาะ host ใน WEBHOOK_PRIVATE_HOSTS)'];
}

const PRIVATE_V4: readonly [number, number][] = [
  // [network as uint32, prefix length]
  [ipv4ToInt('0.0.0.0'), 8],
  [ipv4ToInt('10.0.0.0'), 8],
  [ipv4ToInt('100.64.0.0'), 10],
  [ipv4ToInt('127.0.0.0'), 8],
  [ipv4ToInt('169.254.0.0'), 16],
  [ipv4ToInt('172.16.0.0'), 12],
  [ipv4ToInt('192.168.0.0'), 16],
];

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

/** Loopback, private, link-local, CGNAT — anything that is not the public internet. */
export function isPrivateAddress(ip: string): boolean {
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  if (isIP(lower) === 4) {
    const value = ipv4ToInt(lower);
    return PRIVATE_V4.some(
      ([net, bits]) =>
        Math.floor(value / 2 ** (32 - bits)) ===
        Math.floor(net / 2 ** (32 - bits)),
    );
  }
  if (isIP(lower) === 6) {
    return (
      lower === '::' ||
      lower === '::1' ||
      /^f[cd]/.test(lower) ||
      /^fe[89ab]/.test(lower)
    );
  }
  return true;
}

export type Lookup = (host: string) => Promise<{ address: string }[]>;

const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true });

/**
 * Where the URL resolves. Checked when saved and again before every call,
 * so a name that later points inside (DNS rebinding) is refused then.
 */
export async function addressProblems(
  raw: string,
  privateHosts: readonly string[],
  lookup: Lookup = defaultLookup,
): Promise<string[]> {
  const host = new URL(raw).hostname.toLowerCase();
  if (privateHosts.includes(host)) return [];
  const bare = host.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(bare)
      ? [bare]
      : (await lookup(bare)).map((entry) => entry.address);
  } catch {
    return [`หา host ${host} ไม่พบ`];
  }
  return addresses.some(isPrivateAddress)
    ? [`${host} ชี้เข้าเครือข่ายภายใน — ต้องใส่ใน WEBHOOK_PRIVATE_HOSTS ก่อน`]
    : [];
}
