import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  PhoneNumberUnavailableError,
  type AvailablePhoneNumber,
  type PhoneNumberSearch,
  type PhoneReservation,
  type ReservePhoneClient,
  type ReservePhoneContext,
} from './reserve-phone-client';

/** A number made only of one or two digits after its prefix reads "golden". */
function categoryOf(number: string): string {
  const tail = number.slice(-4);
  return new Set(tail).size <= 2 ? 'golden' : 'normal';
}

/**
 * The stand-in Reserve-phone: a fixed pool per company (02-100-0000 upward and
 * a few 08x mobile numbers), holds kept in memory. A hold past its expiry
 * frees the number again, as the real system is expected to.
 */
@Injectable()
export class MockReservePhoneClient implements ReservePhoneClient {
  readonly mode = 'mock' as const;
  private readonly holds = new Map<
    string,
    { companyCode: string; number: string; expiresAt: Date }
  >();

  private pool(): string[] {
    const fixed = Array.from(
      { length: 200 },
      (_, i) =>
        `02100${String(i * 37)
          .padStart(4, '0')
          .slice(-4)}`,
    );
    const golden = ['021008888', '021009999', '021005555', '021001234'];
    const mobile = Array.from(
      { length: 40 },
      (_, i) => `0861${String(100000 + i * 911).slice(-6)}`,
    );
    return [...new Set([...golden, ...fixed, ...mobile])];
  }

  private taken(companyCode: string, now = new Date()): Set<string> {
    const numbers = new Set<string>();
    for (const [id, hold] of this.holds) {
      if (hold.expiresAt <= now) {
        this.holds.delete(id);
        continue;
      }
      if (hold.companyCode === companyCode) numbers.add(hold.number);
    }
    return numbers;
  }

  search(
    ctx: ReservePhoneContext,
    query: PhoneNumberSearch,
  ): Promise<AvailablePhoneNumber[]> {
    const taken = this.taken(ctx.companyCode);
    const found = this.pool()
      .filter((number) => !taken.has(number))
      .filter((number) => !query.prefix || number.startsWith(query.prefix))
      .filter((number) => !query.contains || number.includes(query.contains))
      .map((number) => ({ number, category: categoryOf(number) }))
      .filter((row) => !query.category || row.category === query.category)
      .slice(0, query.limit)
      .map((row) => ({
        ...row,
        fee: row.category === 'golden' ? 5000 : null,
      }));
    return Promise.resolve(found);
  }

  reserve(
    ctx: ReservePhoneContext,
    number: string,
    hold: { reference: string; expiresAt: string },
  ): Promise<PhoneReservation> {
    if (
      !this.pool().includes(number) ||
      this.taken(ctx.companyCode).has(number)
    ) {
      return Promise.reject(new PhoneNumberUnavailableError(number));
    }
    const reservationId = `MOCK-${randomUUID()}`;
    this.holds.set(reservationId, {
      companyCode: ctx.companyCode,
      number,
      expiresAt: new Date(hold.expiresAt),
    });
    return Promise.resolve({
      reservationId,
      number,
      category: categoryOf(number),
      fee: categoryOf(number) === 'golden' ? 5000 : null,
      expiresAt: hold.expiresAt,
    });
  }

  extend(
    _ctx: ReservePhoneContext,
    reservationId: string,
    expiresAt: string,
  ): Promise<{ expiresAt: string }> {
    const hold = this.holds.get(reservationId);
    // A restarted mock has forgotten its holds — answer as if extended, the
    // way a real system that still had it would.
    if (hold) hold.expiresAt = new Date(expiresAt);
    return Promise.resolve({ expiresAt });
  }

  release(_ctx: ReservePhoneContext, reservationId: string): Promise<void> {
    this.holds.delete(reservationId);
    return Promise.resolve();
  }
}
