import { PDFDocument } from 'pdf-lib';
import { certificatePdf } from './certificate-pdf';

describe('CD-252 certificate PDF', () => {
  it('draws a Thai certificate and keeps room for the signatures', async () => {
    const pdf = await certificatePdf({
      companyName: 'บริษัท โอเอสดี จำกัด',
      certificateNo: 'AC-PRJ-1-2',
      projectNo: 'PRJ-1',
      projectName: 'ระบบเครือข่ายอาคาร B',
      contractNo: 'CT-2026-0001',
      customerName: 'ลูกค้า ก',
      phase: '2. ติดตั้งอาคาร B',
      decidedOn: '2026-10-05',
      result: 'conditional',
      note: null,
      deliverables: Array.from(
        { length: 40 },
        (_, i) => `BOQ ${i + 1}: Switch × 4`,
      ),
      openPoints: [{ text: 'ติดป้ายสาย', dueOn: '2026-10-20' }],
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
  });
});
