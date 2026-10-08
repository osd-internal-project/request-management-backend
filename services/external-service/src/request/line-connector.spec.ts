import { createHmac } from 'crypto';
import {
  lineSignatureValid,
  messageField,
  textMessages,
  careMessages,
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

describe('CD-285 careMessages', () => {
  const user = { type: 'user', userId: 'U1' };
  it('turns each kind of LINE message into a conversation message', () => {
    const out = careMessages([
      {
        type: 'message',
        replyToken: 'r1',
        timestamp: 1759900000000,
        source: user,
        message: { type: 'text', text: ' ตู้เสีย ' },
      },
      { type: 'message', source: user, message: { id: 'm2', type: 'image' } },
      {
        type: 'message',
        source: user,
        message: { id: 'm3', type: 'file', fileName: 'invoice.pdf' },
      },
      { type: 'message', source: user, message: { id: 'm4', type: 'sticker' } },
      {
        type: 'message',
        source: user,
        message: {
          id: 'm5',
          type: 'location',
          title: 'สาขา 1',
          address: 'ถนนสุขุมวิท',
          latitude: 13.7,
          longitude: 100.5,
        },
      },
    ]);
    expect(out[0]).toEqual({
      userId: 'U1',
      replyToken: 'r1',
      at: new Date(1759900000000),
      text: 'ตู้เสีย',
      attachment: null,
    });
    expect(out[1].attachment).toEqual({
      name: 'รูปภาพ m2',
      type: 'image',
      source: 'line',
      lineMessageId: 'm2',
    });
    expect(out[2].attachment?.name).toBe('invoice.pdf');
    expect(out[3].attachment).toEqual({ name: 'สติกเกอร์', type: 'sticker' });
    expect(out[4].attachment).toEqual({
      name: 'สาขา 1 · ถนนสุขุมวิท',
      type: 'location',
      url: 'https://www.google.com/maps?q=13.7,100.5',
    });
  });

  it('leaves out groups, follows, empty text and media without an id', () => {
    expect(
      careMessages([
        {
          type: 'message',
          source: { type: 'group', userId: 'U1' },
          message: { type: 'text', text: 'x' },
        },
        { type: 'follow', source: user },
        {
          type: 'message',
          source: user,
          message: { type: 'text', text: '  ' },
        },
        { type: 'message', source: user, message: { type: 'image' } },
      ]),
    ).toEqual([]);
  });
});
