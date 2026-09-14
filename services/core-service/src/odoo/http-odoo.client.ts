import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError } from '@request-management/share';
import { OdooClient, OdooPartnerPayload, OdooReceivables } from './odoo-client';

/**
 * The real driver (ODOO_MODE=http) — Odoo's external JSON-RPC API
 * (`/jsonrpc`, service `object`, method `execute_kw`), authenticated with a
 * uid + API key the way Odoo 16+ documents it.
 *
 * Written against a sandbox that does not exist yet, so the field mapping
 * below is the starting point for the session with the Odoo implement team,
 * not a settled contract: `ref` carries our customerCode (they may prefer a
 * custom field), and receivables read `res.partner.credit` + a posted-invoice
 * count. Adjust here — nothing outside this file knows Odoo's shapes.
 */
@Injectable()
export class HttpOdooClient implements OdooClient {
  readonly mode = 'http' as const;
  private readonly logger = new Logger(HttpOdooClient.name);

  constructor(private readonly config: ConfigService) {}

  async createPartner(
    payload: OdooPartnerPayload,
  ): Promise<{ partnerId: string }> {
    const id = await this.executeKw<number>('res.partner', 'create', [
      [this.partnerFields(payload)],
    ]);
    return { partnerId: String(id) };
  }

  async updatePartner(
    partnerId: string,
    payload: OdooPartnerPayload,
  ): Promise<void> {
    await this.executeKw('res.partner', 'write', [
      [Number(partnerId)],
      this.partnerFields(payload),
    ]);
  }

  async getReceivables(partnerId: string): Promise<OdooReceivables> {
    const [rows, invoiceCount] = await Promise.all([
      this.executeKw<{ credit: number }[]>('res.partner', 'read', [
        [Number(partnerId)],
        ['credit'],
      ]),
      this.executeKw<number>('account.move', 'search_count', [
        [
          ['partner_id', '=', Number(partnerId)],
          ['move_type', '=', 'out_invoice'],
          ['state', '=', 'posted'],
          ['payment_state', '!=', 'paid'],
        ],
      ]),
    ]);

    return {
      outstanding: rows[0]?.credit ?? 0,
      invoiceCount,
      asOf: new Date().toISOString(),
    };
  }

  private partnerFields(payload: OdooPartnerPayload) {
    return {
      name: payload.branchName
        ? `${payload.name} (${payload.branchName})`
        : payload.name,
      ref: payload.customerCode,
      vat: payload.taxId ?? false,
      company_registry: payload.branchCode ?? false,
      email: payload.email ?? false,
      phone: payload.phone ?? false,
      street: payload.street ?? false,
      street2: payload.street2 ?? false,
      city: payload.city ?? false,
      zip: payload.zip ?? false,
      active: payload.active,
      customer_rank: 1,
    };
  }

  private async executeKw<T>(
    model: string,
    method: string,
    args: unknown[],
  ): Promise<T> {
    const { baseUrl, db, uid, apiKey } = this.settings();

    const response = await fetch(`${baseUrl}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          service: 'object',
          method: 'execute_kw',
          args: [db, uid, apiKey, model, method, args],
        },
        id: Date.now(),
      }),
    });

    if (!response.ok) {
      throw new AppError(
        'UPSTREAM_ERROR',
        `Odoo ตอบ HTTP ${response.status} (${model}.${method})`,
      );
    }

    const body = (await response.json()) as {
      result?: T;
      error?: { message?: string; data?: { message?: string } };
    };

    if (body.error) {
      const detail =
        body.error.data?.message ?? body.error.message ?? 'unknown';
      this.logger.warn(`odoo ${model}.${method} failed: ${detail}`);
      throw new AppError('UPSTREAM_ERROR', `Odoo ปฏิเสธ: ${detail}`);
    }

    return body.result as T;
  }

  private settings() {
    const baseUrl = this.config.get<string>('odoo.baseUrl');
    const db = this.config.get<string>('odoo.db');
    const uid = this.config.get<number>('odoo.uid');
    const apiKey = this.config.get<string>('odoo.apiKey');

    if (!baseUrl || !db || !uid || !apiKey) {
      throw new AppError(
        'UPSTREAM_ERROR',
        'ODOO_MODE=http แต่ยังตั้งค่า ODOO_BASE_URL / ODOO_DB / ODOO_UID / ODOO_API_KEY ไม่ครบ',
      );
    }

    return { baseUrl, db, uid, apiKey };
  }
}
