import {
  EMAIL_INTENTS,
  intentByRules,
  intentPrompt,
  parseIntent,
  replySubject,
  textToHtml,
  type IntentInput,
} from './mail-rules';
import { itemsFromLead } from './sales-mail.service';

const reply = (
  text: string,
  extra: Partial<IntentInput> = {},
): IntentInput => ({
  subject: 'RE: ขอบคุณที่สนใจบริการของเรา',
  text,
  attachmentNames: [],
  quotationSent: false,
  ...extra,
});

describe('sales email rules (5 พ.ย. 2569)', () => {
  describe('intentByRules — the fallback classifier', () => {
    it.each([
      ['สนใจครับ รบกวนส่งใบเสนอราคาให้ด้วย', 'interested'],
      ['ขอสอบถามว่ารองรับ VPN ไหม', 'needs_info'],
      ['ขอบคุณครับ ตอนนี้ยังไม่สนใจ', 'not_interested'],
      ['ไม่มีอะไรครับ', 'unclear'],
      ['ขอส่วนลดหน่อย', 'negotiation'],
      ['ราคาแพงไปนิด ลดได้ไหมครับ', 'negotiation'],
    ])('%s → %s', (text, intent) => {
      expect(intentByRules(reply(text)).intent).toBe(intent);
    });

    it('confirming counts only once a quotation was sent', () => {
      expect(intentByRules(reply('ยืนยันตามนี้ครับ')).intent).not.toBe(
        'confirmed',
      );
      expect(
        intentByRules(reply('ยืนยันตามนี้ครับ', { quotationSent: true }))
          .intent,
      ).toBe('confirmed');
    });

    it('a confirmation on a price condition is negotiation, not a yes (6 พ.ย. 2569)', () => {
      expect(
        intentByRules(
          reply('ยืนยันได้เลยถ้าลดให้ 10%', { quotationSent: true }),
        ).intent,
      ).toBe('negotiation');
    });

    it('a PO beats everything — by file name or by text', () => {
      expect(
        intentByRules(
          reply('ยืนยันครับ', {
            quotationSent: true,
            attachmentNames: ['PO-2026-0153.pdf'],
          }),
        ).intent,
      ).toBe('purchase_order');
      expect(intentByRules(reply('แนบ PO มาให้แล้วครับ')).intent).toBe(
        'purchase_order',
      );
      // a word that merely contains "po" is not a PO
      expect(
        intentByRules(reply('สนใจครับ', { attachmentNames: ['report.pdf'] }))
          .intent,
      ).toBe('interested');
    });
  });

  describe('parseIntent — the LLM answer', () => {
    it('takes the JSON object out of the answer', () => {
      expect(
        parseIntent(
          '```json\n{"intent":"interested","reason":"ขอราคา"}\n```',
          false,
        ),
      ).toEqual({ intent: 'interested', reason: 'ขอราคา' });
    });

    it('refuses codes it does not know, non-JSON, and a confirm with nothing sent', () => {
      expect(parseIntent('{"intent":"maybe"}', false)).toBeNull();
      expect(parseIntent('interested', false)).toBeNull();
      expect(parseIntent('{"intent":"confirmed"}', false)).toBeNull();
      expect(parseIntent('{"intent":"confirmed"}', true)?.intent).toBe(
        'confirmed',
      );
    });

    it('the prompt lists every intent code', () => {
      const { system } = intentPrompt(reply('x', { quotationSent: true }));
      for (const intent of EMAIL_INTENTS) expect(system).toContain(intent);
    });
  });

  it('textToHtml escapes what the caller wrote and keeps paragraphs', () => {
    const html = textToHtml(
      'เรียน คุณ <b>A</b>\n\nบรรทัด 1\nบรรทัด 2',
      'ฝ่ายขาย',
    );
    expect(html).toContain('&lt;b&gt;A&lt;/b&gt;');
    expect(html).not.toContain('<b>');
    expect(html).toContain('<p>บรรทัด 1<br>บรรทัด 2</p>');
    expect(html).toContain('ฝ่ายขาย');
  });

  it('replySubject adds one RE: however deep the thread', () => {
    expect(replySubject('RE: Re: FW: ใบเสนอราคา')).toBe('RE: ใบเสนอราคา');
    expect(replySubject('ขอบคุณ')).toBe('RE: ขอบคุณ');
  });

  describe('itemsFromLead', () => {
    it('reads intake_data.products in either shape', () => {
      expect(
        itemsFromLead({
          subProduct: 'IGNORED',
          intakeData: {
            products: [
              { product_code: 'A-1', quantity: 3 },
              { code: 'B-2', qty: '2' },
              'C-3',
              { name: 'no code' },
            ],
          },
        }),
      ).toEqual([
        { product_code: 'A-1', quantity: 3 },
        { product_code: 'B-2', quantity: 2 },
        { product_code: 'C-3', quantity: 1 },
      ]);
    });

    it('falls back to subProduct × 1, and to nothing', () => {
      expect(itemsFromLead({ subProduct: ' X-9 ', intakeData: null })).toEqual([
        { product_code: 'X-9', quantity: 1 },
      ]);
      expect(itemsFromLead({ subProduct: null, intakeData: {} })).toEqual([]);
      expect(itemsFromLead(null)).toEqual([]);
    });
  });
});
