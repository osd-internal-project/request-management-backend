import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const B1_TRANSPORT = 'B1_TRANSPORT';

export interface B1Request {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

export interface B1Response {
  readonly status: number;
  /** `set-cookie` arrives as an array; everything else as a string. */
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/** The wire, apart from the client — tests swap in a fake Service Layer. */
export interface B1Transport {
  send(request: B1Request): Promise<B1Response>;
}

/**
 * node:https rather than global fetch: an on-premise Service Layer usually
 * serves a self-signed certificate, and trusting one (ERP_B1_CA_FILE) needs an
 * https.Agent, which fetch cannot take without an extra dependency.
 */
@Injectable()
export class HttpsB1Transport implements B1Transport {
  private readonly logger = new Logger(HttpsB1Transport.name);
  private readonly agent: https.Agent;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    const caFile = config.get<string>('erp.b1.caFile');
    const insecure = config.get<boolean>('erp.b1.tlsInsecure') ?? false;
    if (insecure) {
      this.logger.warn(
        'ERP_B1_TLS_INSECURE=true — ไม่ตรวจ certificate ของ SAP B1; ใช้ ERP_B1_CA_FILE แทนเมื่อทำได้',
      );
    }
    this.agent = new https.Agent({
      keepAlive: true,
      ca: caFile ? readFileSync(caFile) : undefined,
      rejectUnauthorized: !insecure,
    });
    this.timeoutMs = config.get<number>('erp.b1.timeoutMs') ?? 30_000;
  }

  send(request: B1Request): Promise<B1Response> {
    const url = new URL(request.url);
    const lib = url.protocol === 'http:' ? http : https;

    return new Promise((resolve, reject) => {
      const req = lib.request(
        url,
        {
          method: request.method,
          headers: request.headers,
          agent: url.protocol === 'https:' ? this.agent : undefined,
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
          res.on('error', reject);
        },
      );
      req.on('timeout', () =>
        req.destroy(new Error(`SAP B1 ไม่ตอบภายใน ${this.timeoutMs}ms`)),
      );
      req.on('error', reject);
      if (request.body !== undefined) req.write(request.body);
      req.end();
    });
  }
}
