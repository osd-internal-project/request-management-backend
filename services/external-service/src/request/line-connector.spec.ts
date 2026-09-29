import { createHmac } from 'crypto';
import {
  lineSignatureValid,
  messageField,
  textMessages,
} from './line-connector';

describe('CD-66 LINE connector', () => {
  const secret = 'channel-secret';
  const body = Buffer.from(JSON.stringify({ events: [] }));
  const signed = createHmac('sha256', secret).update(body).digest('base64');

  it('CD-66: only LINE’s own signature over the raw body is accepted', () => {
    expect(lineSignatureValid(body, signed, secret)).toBe(true);
    expect(lineSignatureValid(body, signed, 'other-secret')).toBe(false);
    expect(lineSignatureValid(Buffer.from('{}'), signed, secret)).toBe(false);
    expect(lineSignatureValid(body, undefined, secret)).toBe(false);
    expect(lineSignatureValid(body, signed, '')).toBe(false);
    expect(lineSignatureValid(body, 'short', secret)).toBe(false);
  });

  it('only a person’s text messages become submissions', () => {
    expect(
      textMessages([
        {
          type: 'message',
          replyToken: 'r1',
          source: { type: 'user', userId: 'U1' },
          message: { type: 'text', text: '  เน็ตล่ม  ' },
        },
        { type: 'follow', source: { type: 'user', userId: 'U2' } },
        {
          type: 'message',
          source: { type: 'user', userId: 'U3' },
          message: { type: 'sticker' },
        },
        {
          type: 'message',
          source: { type: 'group' },
          message: { type: 'text', text: 'hi' },
        },
      ]),
    ).toEqual([{ userId: 'U1', text: 'เน็ตล่ม', replyToken: 'r1' }]);
  });

  it('the message goes into the type’s first multiline field, else its first text field', () => {
    expect(
      messageField([
        { key: 'subject', type: 'text' },
        { key: 'detail', type: 'multiline' },
      ]),
    ).toBe('detail');
    expect(messageField([{ key: 'subject', type: 'text' }])).toBe('subject');
    expect(messageField([{ key: 'n', type: 'number' }])).toBeNull();
  });
});
