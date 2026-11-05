import { GraphMailClient } from './graph-mail.client';
import { MailError } from './mail-client';

type Call = {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
};

function client(
  responses: ((call: Call) => { status: number; body?: unknown })[],
) {
  const graph = new GraphMailClient({
    mailbox: 'sales@osd.co.th',
    tenantId: 't-1',
    clientId: 'c-1',
    clientSecret: 's-1',
  });
  const calls: Call[] = [];
  let i = 0;
  graph.useFetch((url, init) => {
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body:
        typeof init?.body === 'string' && init.body.startsWith('{')
          ? JSON.parse(init.body)
          : init?.body,
    };
    calls.push(call);
    const answer = url.includes('login.microsoftonline.com')
      ? { status: 200, body: { access_token: 'tok', expires_in: 3600 } }
      : responses[i++](call);
    return Promise.resolve(
      new Response(
        answer.body === undefined ? null : JSON.stringify(answer.body),
        {
          status: answer.status,
        },
      ),
    );
  });
  return { graph, calls };
}

describe('GraphMailClient (MAIL_MODE=graph)', () => {
  it('a new message: one draft with the attachment, then send; the token is reused', async () => {
    const { graph, calls } = client([
      () => ({
        status: 201,
        body: {
          id: 'm-1',
          internetMessageId: '<a@x>',
          conversationId: 'conv-1',
        },
      }),
      () => ({ status: 202 }),
      () => ({ status: 201, body: { id: 'm-2', conversationId: 'conv-2' } }),
      () => ({ status: 202 }),
    ]);

    const sent = await graph.send({
      to: ['customer@example.com'],
      subject: 'ขอบคุณ',
      html: '<p>hi</p>',
      attachments: [
        {
          name: 'p.pdf',
          contentType: 'application/pdf',
          contentBase64: 'QUJD',
        },
      ],
    });
    await graph.send({ to: ['b@example.com'], subject: 's', html: 'h' });

    expect(sent).toEqual({
      graphMessageId: 'm-1',
      internetMessageId: '<a@x>',
      conversationId: 'conv-1',
    });
    expect(
      calls.filter((c) => c.url.includes('login.microsoftonline')),
    ).toHaveLength(1);
    const draft = calls[1];
    expect(draft.url).toBe(
      'https://graph.microsoft.com/v1.0/users/sales%40osd.co.th/messages',
    );
    expect(draft.headers.authorization).toBe('Bearer tok');
    expect(draft.headers.prefer).toContain('ImmutableId');
    expect(draft.body).toMatchObject({
      subject: 'ขอบคุณ',
      toRecipients: [{ emailAddress: { address: 'customer@example.com' } }],
      attachments: [
        {
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: 'p.pdf',
          contentBytes: 'QUJD',
        },
      ],
    });
    expect(calls[2].url).toMatch(/\/messages\/m-1\/send$/);
  });

  it('a reply: createReply on the customer message, our body, attachments, send', async () => {
    const { graph, calls } = client([
      () => ({ status: 201, body: { id: 'd-1' } }),
      () => ({
        status: 200,
        body: {
          id: 'd-1',
          internetMessageId: '<r@x>',
          conversationId: 'conv-1',
        },
      }),
      () => ({ status: 201, body: {} }),
      () => ({ status: 202 }),
    ]);
    const sent = await graph.send({
      to: ['customer@example.com'],
      subject: 'RE: x',
      html: '<p>quote</p>',
      attachments: [
        {
          name: 'q.pdf',
          contentType: 'application/pdf',
          contentBase64: 'QUJD',
        },
      ],
      replyToGraphId: 'in-7',
    });
    const paths = calls
      .slice(1)
      .map((c) => `${c.method} ${c.url.split('/users/sales%40osd.co.th')[1]}`);
    expect(paths).toEqual([
      'POST /messages/in-7/createReply',
      'PATCH /messages/d-1',
      'POST /messages/d-1/attachments',
      'POST /messages/d-1/send',
    ]);
    expect(calls[2].body).toMatchObject({
      body: { contentType: 'HTML', content: '<p>quote</p>' },
    });
    expect(sent.conversationId).toBe('conv-1');
  });

  it('lists the inbox across pages with ids only, and reads one message as text', async () => {
    const { graph, calls } = client([
      () => ({
        status: 200,
        body: {
          value: [
            {
              id: 'a',
              conversationId: 'c1',
              receivedDateTime: '2026-11-05T01:00:00Z',
            },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-page',
        },
      }),
      () => ({
        status: 200,
        body: {
          value: [{ id: 'b', receivedDateTime: '2026-11-05T02:00:00Z' }],
        },
      }),
      () => ({
        status: 200,
        body: {
          id: 'a',
          conversationId: 'c1',
          subject: 'RE: ขอบคุณ',
          from: { emailAddress: { address: 'customer@example.com' } },
          uniqueBody: { content: 'สนใจครับ' },
          body: { content: 'สนใจครับ\n> quoted' },
        },
      }),
      () => ({
        status: 200,
        body: {
          value: [{ name: 'PO.pdf', contentType: 'application/pdf', size: 10 }],
        },
      }),
    ]);
    const refs = await graph.listInbox(new Date('2026-11-05T00:00:00Z'));
    expect(refs.map((r) => r.graphMessageId)).toEqual(['a', 'b']);
    expect(decodeURIComponent(calls[1].url)).toContain(
      'receivedDateTime ge 2026-11-05T00:00:00.000Z',
    );
    expect(calls[1].url).toContain('receivedDateTime%20ge%20');
    expect(calls[1].url).not.toContain('+');
    expect(calls[1].url).toContain(
      '$select=id%2CinternetMessageId%2CconversationId%2CreceivedDateTime',
    );

    const message = await graph.read('a');
    expect(message).toMatchObject({
      from: 'customer@example.com',
      text: 'สนใจครับ',
      attachments: [
        { name: 'PO.pdf', contentType: 'application/pdf', size: 10 },
      ],
    });
    expect(calls[3].headers.prefer).toContain(
      'outlook.body-content-type="text"',
    );
  });

  it('a refusal is a MailError with the status', async () => {
    const { graph } = client([
      () => ({ status: 403, body: { error: 'denied' } }),
    ]);
    await expect(
      graph.send({ to: ['x@y.z'], subject: 's', html: 'h' }),
    ).rejects.toMatchObject({
      name: 'MailError',
      statusCode: 403,
    });
  });

  it('names every missing setting', () => {
    expect(GraphMailClient.missingSettings('', {})).toEqual([
      'MAIL_MAILBOX',
      'MAIL_GRAPH_TENANT_ID',
      'MAIL_GRAPH_CLIENT_ID',
      'MAIL_GRAPH_CLIENT_SECRET',
    ]);
    expect(new MailError('x')).toBeInstanceOf(Error);
  });
});
