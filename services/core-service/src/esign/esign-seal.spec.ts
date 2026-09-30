import { writeFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { seal } from './esign-seal';

// a 1×1 PNG — enough to prove an image signature is drawn
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function original(pages: number) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]);
  return doc.save();
}

describe('CD-169/170 sealing', () => {
  it('draws each signature in its field, adds the signature page and the evidence', async () => {
    const signedAt = new Date('2026-09-30T03:15:00Z');
    const bytes = await seal({
      original: await original(2),
      title: 'CTR-2569-0042 · สัญญาบริการดูแลระบบ',
      verifyCode: 'ABCD-EFGH-JKLM',
      verifyUrl: 'http://localhost:3000/v/ABCD-EFGH-JKLM',
      originalHash: 'a'.repeat(64),
      createdAt: signedAt,
      sentAt: signedAt,
      completedAt: signedAt,
      fields: [
        {
          key: 'f1',
          label: 'ผู้ว่าจ้าง',
          page: 'last',
          position: 'bottom-left',
          order: 1,
        },
        {
          key: 'f2',
          label: 'ผู้รับจ้าง',
          page: 'appendix',
          position: 'bottom-left',
          order: 2,
        },
      ],
      signers: [
        {
          fieldKey: 'f1',
          name: 'นายสมชาย ใจดี',
          label: 'ผู้ว่าจ้าง',
          kind: 'external',
          contact: 'so•••@example.com',
          signatureKind: 'type',
          signatureImage: null,
          signatureText: 'สมชาย ใจดี',
          authMethod: 'otp_email',
          signedAt,
          viewedAt: signedAt,
          ip: '203.0.113.5',
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
        },
        {
          fieldKey: 'f2',
          name: 'นางสาววิภา ศรีสุข',
          label: 'ผู้รับจ้าง',
          kind: 'internal',
          contact: null,
          signatureKind: 'draw',
          signatureImage: { mime: 'image/png', bytes: PNG },
          signatureText: null,
          authMethod: 'keycloak',
          signedAt,
          viewedAt: signedAt,
          ip: '10.0.0.8',
          userAgent: null,
        },
      ],
      events: [
        { at: signedAt, type: 'sent', who: 'นายสมชาย ใจดี', ip: null },
        {
          at: signedAt,
          type: 'otp_verified',
          who: 'นายสมชาย ใจดี',
          ip: '203.0.113.5',
        },
        {
          at: signedAt,
          type: 'signed',
          who: 'นายสมชาย ใจดี',
          ip: '203.0.113.5',
        },
      ],
    });
    // for a person to look at: SEAL_SAMPLE=/tmp/x.pdf yarn test esign-seal
    if (process.env.SEAL_SAMPLE) writeFileSync(process.env.SEAL_SAMPLE, bytes);

    const sealed = await PDFDocument.load(bytes);
    // 2 pages + the signature page + the evidence
    expect(sealed.getPageCount()).toBe(4);
    expect(sealed.getSubject()).toContain('ABCD-EFGH-JKLM');
  });

  it('refuses a file that is not a PDF', async () => {
    await expect(
      seal({
        original: Buffer.from('not a pdf'),
        title: 'x',
        verifyCode: 'x',
        verifyUrl: 'x',
        originalHash: 'x',
        createdAt: new Date(),
        sentAt: null,
        completedAt: new Date(),
        fields: [],
        signers: [],
        events: [],
      }),
    ).rejects.toThrow();
  });
});
