import {
  MAX_REQUIREMENT_ASKS,
  decide,
  extractByRules,
  mergeRequirements,
  parseRequirementAnswer,
  productIn,
  quantityIn,
  requirementEmailBody,
} from './requirement-rules';

const site = { key: 'site', question: 'สถานที่ติดตั้ง', hints: ['ติดตั้งที่'] };
const term = { key: 'term', question: 'ระยะสัญญา (เดือน)', hints: [] };
const names = ['IP-PHONE', 'IP-PHONE Pro', 'D-DEBT'];

describe('requirement rules (13 พ.ย. 2569)', () => {
  it('quantityIn reads a number with a unit, or after "จำนวน"', () => {
    expect(quantityIn('สนใจ IP Phone 50 เครื่องครับ')).toBe(50);
    expect(quantityIn('จำนวน: 1,200')).toBe(1200);
    expect(quantityIn('ต้องการ 25 users')).toBe(25);
    expect(quantityIn('โทร 02-123-4567 ได้เลย')).toBeNull();
    expect(quantityIn('สนใจครับ')).toBeNull();
  });

  it('productIn finds the longest known name, whatever the case', () => {
    expect(productIn('สนใจ ip-phone pro ครับ', names)).toBe('IP-PHONE Pro');
    expect(productIn('ขอราคา D-Debt', names)).toBe('D-DEBT');
    expect(productIn('สนใจกล้องวงจรปิด', names)).toBeNull();
  });

  describe('extractByRules', () => {
    it('a hint in a line answers its question with that line', () => {
      expect(
        extractByRules({
          text: 'สนใจ IP-PHONE 50 เครื่อง\nติดตั้งที่ระยอง',
          productNames: names,
          questions: [site, term],
          answeringAsk: false,
        }),
      ).toEqual({
        product: 'IP-PHONE',
        quantity: 50,
        answers: { site: 'ติดตั้งที่ระยอง' },
      });
    });

    it('answering our own questions, a question with no hints takes the whole reply', () => {
      const found = extractByRules({
        text: '36 เดือนครับ',
        productNames: names,
        questions: [site, term],
        answeringAsk: true,
      });
      expect(found.answers).toEqual({ term: '36 เดือนครับ' });
    });
  });

  it('parseRequirementAnswer keeps only the keys asked, and nothing from nonsense', () => {
    expect(
      parseRequirementAnswer(
        'ok {"product":"IP-PHONE","quantity":"50","answers":{"site":"ระยอง","term":null,"x":"y"}}',
        [site, term],
      ),
    ).toEqual({
      product: 'IP-PHONE',
      quantity: 50,
      answers: { site: 'ระยอง' },
    });
    expect(parseRequirementAnswer('ไม่ทราบ', [site])).toBeNull();
    expect(
      parseRequirementAnswer('{"product":null,"quantity":null}', [site]),
    ).toEqual({ product: null, quantity: null, answers: {} });
  });

  it('mergeRequirements adds to what was known; newer wins', () => {
    expect(
      mergeRequirements(
        { product: 'IP-PHONE', quantity: 10, answers: { site: 'กทม.' } },
        { product: null, quantity: 50, answers: { term: '36' } },
      ),
    ).toEqual({
      product: 'IP-PHONE',
      quantity: 50,
      answers: { site: 'กทม.', term: '36' },
    });
  });

  describe('decide', () => {
    const base = {
      product: 'IP-PHONE',
      productNames: names,
      hasItems: true,
      unpriced: [] as string[],
      quantityKnown: true,
      questions: [site, term],
      answers: { site: 'ระยอง', term: '36' },
      asksSent: 0,
    };

    it('everything known and priced → ready', () => {
      expect(decide(base)).toMatchObject({ outcome: 'ready', missing: [] });
    });

    it('missing quantity and an unanswered question → ask for exactly those', () => {
      const result = decide({
        ...base,
        quantityKnown: false,
        answers: { site: 'ระยอง' },
      });
      expect(result.outcome).toBe('ask');
      expect(result.missing).toEqual([
        { key: 'quantity', question: 'จำนวนที่ต้องการ' },
        { key: 'term', question: 'ระยะสัญญา (เดือน)' },
      ]);
    });

    it('nobody said which product → ask, listing what the company sells', () => {
      const result = decide({
        ...base,
        product: null,
        hasItems: false,
        questions: [],
        answers: {},
      });
      expect(result.outcome).toBe('ask');
      expect(result.missing[0].key).toBe('product');
      expect(result.missing[0].question).toContain('D-DEBT');
    });

    it('a product with nothing to quote from → no_solution, never an email', () => {
      expect(
        decide({ ...base, product: 'CCTV', hasItems: false }),
      ).toMatchObject({ outcome: 'no_solution', missing: [] });
    });

    it('an item with no standard price → no_solution, naming it', () => {
      const result = decide({ ...base, unpriced: ['INSTALL-01'] });
      expect(result.outcome).toBe('no_solution');
      expect(result.reason).toContain('INSTALL-01');
    });

    it('no_solution is judged before requirements: a customer is not questioned about a product we cannot price', () => {
      expect(
        decide({ ...base, unpriced: ['X'], quantityKnown: false, answers: {} })
          .outcome,
      ).toBe('no_solution');
    });

    it(`asked ${MAX_REQUIREMENT_ASKS} times and still incomplete → handover`, () => {
      expect(
        decide({ ...base, answers: {}, asksSent: MAX_REQUIREMENT_ASKS }),
      ).toMatchObject({ outcome: 'handover' });
      expect(decide({ ...base, asksSent: MAX_REQUIREMENT_ASKS }).outcome).toBe(
        'ready',
      );
    });
  });

  it('requirementEmailBody numbers the questions and keeps a given opening', () => {
    const body = requirementEmailBody(
      [
        { key: 'quantity', question: 'จำนวนที่ต้องการ' },
        { key: 'site', question: 'สถานที่ติดตั้ง' },
      ],
      'IP-PHONE',
    );
    expect(body).toContain('ขอบคุณที่สนใจ IP-PHONE');
    expect(body).toContain('1. จำนวนที่ต้องการ\n2. สถานที่ติดตั้ง');
    expect(
      requirementEmailBody([{ key: 'a', question: 'ก' }], null, 'เรียน คุณเอ'),
    ).toMatch(/^เรียน คุณเอ\n\n1\. ก/);
  });
});
