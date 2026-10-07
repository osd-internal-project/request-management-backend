import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { FoundProspect } from './smart-rules';

/** What a connector is asked to look for (a source's `criteria`). */
export interface SweepCriteria {
  keywords?: string[];
  industries?: string[];
  provinces?: string[];
  minCapital?: number;
  maxResults?: number;
}

/**
 * CD-289 — one outside place to search (DBD, the web, social). A real one
 * arrives with the provider and its contract; until then the mock answers.
 */
export interface SmartConnector {
  readonly kind: string;
  search(criteria: SweepCriteria): Promise<FoundProspect[]>;
}

export const SMART_CONNECTORS = Symbol('SMART_CONNECTORS');

const hashDigits = (seed: string, length: number) =>
  BigInt(`0x${createHash('sha256').update(seed).digest('hex').slice(0, 15)}`)
    .toString()
    .padStart(length, '0')
    .slice(-length);

/**
 * Deterministic made-up businesses for each keyword: the same criteria give
 * the same rows, so a second sweep shows up as duplicates, not new finds.
 * Marked `mock: true` in the evidence so nobody mistakes them for real.
 */
@Injectable()
export class MockSmartConnector implements SmartConnector {
  constructor(readonly kind: string) {}

  search(criteria: SweepCriteria): Promise<FoundProspect[]> {
    const keywords = criteria.keywords?.length ? criteria.keywords : ['ทั่วไป'];
    const provinces = criteria.provinces?.length
      ? criteria.provinces
      : ['กรุงเทพมหานคร'];
    const limit = Math.min(criteria.maxResults ?? 5, 50);
    const rows: FoundProspect[] = [];
    for (const keyword of keywords) {
      for (let n = 1; n <= limit; n++) {
        const seed = `${this.kind}:${keyword}:${n}`;
        const taxId = `0${hashDigits(seed, 12)}`;
        rows.push({
          externalRef: this.kind === 'dbd' ? taxId : `mock://${seed}`,
          name: `บริษัท ${keyword} ตัวอย่าง ${n} จำกัด`,
          taxId: this.kind === 'dbd' ? taxId : null,
          phone: `02${hashDigits(`${seed}:tel`, 7)}`,
          website:
            this.kind === 'dbd'
              ? null
              : `https://example.com/${encodeURIComponent(keyword)}/${n}`,
          industry: criteria.industries?.[0] ?? keyword,
          province: provinces[n % provinces.length],
          registeredCapital: (criteria.minCapital ?? 1_000_000) * n,
          evidence: {
            mock: true,
            source: this.kind,
            keyword,
            fetchedAt: new Date().toISOString(),
          },
        });
      }
    }
    return Promise.resolve(rows);
  }
}
