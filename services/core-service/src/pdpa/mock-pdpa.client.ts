import { Injectable } from '@nestjs/common';
import {
  ContactConsentQuery,
  ContactConsentStatus,
  PdpaClient,
} from './pdpa-client';

/**
 * The stand-in driver (PDPA_MODE=mock). Deterministic by channel value so a
 * UAT walkthrough repeats: most channels answer `granted`, every ~5th `none`,
 * every ~9th `withdrawn`, and a phone ending in 9 lands on the do-not-call
 * register — enough variety to see every badge without seeding anything.
 */
@Injectable()
export class MockPdpaClient implements PdpaClient {
  readonly mode = 'mock' as const;

  lookupConsents(
    queries: readonly ContactConsentQuery[],
  ): Promise<ContactConsentStatus[]> {
    return Promise.resolve(
      queries.map((query) => ({
        contactId: query.contactId,
        email: query.email ? stateOf(query.email) : null,
        phone: query.phone ? stateOf(query.phone) : null,
        doNotCall: Boolean(query.phone?.trim().endsWith('9')),
      })),
    );
  }
}

function stateOf(channel: string): ContactConsentStatus['email'] {
  const seed = [...channel].reduce(
    (hash, char) => (hash * 31 + char.charCodeAt(0)) % 1_000_003,
    7,
  );
  if (seed % 9 === 0) return 'withdrawn';
  if (seed % 5 === 0) return 'none';
  return 'granted';
}
