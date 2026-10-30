import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildApiExamples,
  buildWebhookExamples,
  type OpenApiDocument,
} from './api-examples-builder';
import { API_EXAMPLES, WEBHOOK_EXAMPLES } from './api-examples.generated';

function document(file: string): OpenApiDocument {
  return JSON.parse(
    readFileSync(join(__dirname, '../../../../docs/openapi', file), 'utf8'),
  ) as OpenApiDocument;
}

function example(method: string, path: string) {
  return API_EXAMPLES.find(
    (item) => item.method === method && item.path === path,
  );
}

describe('generated call examples', () => {
  it('match docs/openapi — run `yarn examples` after `yarn openapi`', () => {
    expect(buildApiExamples(document('external-service.json'))).toEqual(
      API_EXAMPLES,
    );
    expect(buildWebhookExamples(document('external-webhook.json'))).toEqual(
      WEBHOOK_EXAMPLES,
    );
  });

  it('PATCH agent-records/{id} sends the DTO examples, no acting user', () => {
    expect(example('PATCH', '/agent-records/{id}')).toMatchObject({
      scopes: ['integration.agent.record.update'],
      actingUser: false,
      query: {},
      body: { status: 'done', result: { leads_created: 12 } },
    });
  });

  it('POST crm/leads/intake carries the required name', () => {
    const body = example('POST', '/crm/leads/intake')?.body as {
      name?: unknown;
    };
    expect(body.name).toBe('บจก. ตัวอย่าง เทคโนโลยี');
  });

  it('skips MCP and routes no key may call', () => {
    expect(API_EXAMPLES.some((item) => item.path.startsWith('/mcp'))).toBe(
      false,
    );
    expect(API_EXAMPLES.every((item) => item.scopes.length > 0)).toBe(true);
  });

  it('has a body for every webhook event', () => {
    expect(WEBHOOK_EXAMPLES).toHaveLength(22);
    expect(
      WEBHOOK_EXAMPLES.find((item) => item.event === 'request.submitted')?.body,
    ).toMatchObject({
      event: 'request.submitted',
      data: { request_id: '<request_id>' },
    });
  });
});
