import { writeFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { quotationPdf, type QuotationPrintView } from './quotation-pdf';

const line = (lineNo: number, description: string, unitPrice = 0) => ({
  lineNo,
  productCode: null,
  description,
  quantity: '1',
  unit: 'Unit',
  unitPrice: String(unitPrice),
  discountPct: '0',
  lineTotal: String(unitPrice),
  priceModel: 'unit',
  termMonths: null,
});

function view(lines: number, note: string | null = null): QuotationPrintView {
  return {
    quotation: {
      id: 'q1',
      quotationNo: 'OSD_QT2611-024',
      version: 1,
      status: 'approved',
      title:
        '[Chubb] AV Equipment for Townhall (Option 3), Training Room and War room',
      currency: 'THB',
      validUntil: new Date('2026-12-11T05:00:00Z'),
      paymentTerms: 'เงื่อนไขการชำระเงินเป็นไปตามข้อตกลง',
      deliveryTime: 'Within 75 days after received PO or quotation confirmed',
      warranty: '1 Years',
      partyFax: null,
      sellerMobile: '0941488861',
      note,
      partyName: 'บริษัท ชับบ์ สามัคคีประกันภัย จำกัด (มหาชน)',
      partyTaxId: null,
      contactName: 'คุณชนิดา รัตนวิจัย',
      subtotal: '2341900',
      discountTotal: '0',
      netTotal: '2341900',
      vatPct: '7',
      vatAmount: '163933',
      grandTotal: '2505833',
      createdAt: new Date('2026-11-11T05:00:00Z'),
      sentAt: null,
      lines: Array.from({ length: lines }, (_, i) =>
        line(
          i + 1,
          i % 7 === 0
            ? 'งานติดตั้งระบบกระจายเสียง : (Sound System and Speaker) for Projector for Town Hall / Canteen Zone\nงานย้ายอุปกรณ์จาก The PARQ Breakout Zone'
            : `${i}. SOUNDVISION Digital Intelligent Audio Management Plus`,
          i % 7 === 0 ? 289900 : 0,
        ),
      ),
    },
    billTo: {
      name: 'บริษัท ชับบ์ สามัคคีประกันภัย จำกัด (มหาชน)',
      customerCode: null,
      taxId: null,
      branch: null,
      address:
        'เลขที่ 2/4 อาคารชับบ์ ชั้นที่ 12 โครงการนอร์ธปาร์ค ถนนวิภาวดีรังสิต แขวงทุ่งสองห้อง เขตหลักสี่ กรุงเทพมหานคร 10210',
      contactName: 'คุณชนิดา รัตนวิจัย',
      phone: '061-3920011',
      email: 'chanida@example.com',
    },
    seller: {
      name: 'คุณอันชินี อำนวยพานิชย์',
      email: 's@osd.co.th',
      phone: '0941488861',
    },
    letterhead: {
      nameTh: 'บริษัท โอ เอส ดี จำกัด',
      nameEn: 'OSD Co., Ltd.',
      taxId: '0105546127022',
      branch: null,
      address:
        '24 ซอยรามอินทรา 20 ถนนรามอินทรา แขวงท่าแร้ง เขตบางเขน กรุงเทพมหานคร 10230',
      phone: '020801111',
      fax: '020801123',
      email: null,
      website: null,
      logo: null,
      terms: null,
    },
    monthlyRecurring: '0',
    isFinal: true,
  } as unknown as QuotationPrintView;
}

const pages = async (pdf: Buffer) =>
  (await PDFDocument.load(pdf)).getPageCount();

describe('ใบเสนอราคา PDF ตามแบบฟอร์มบริษัท', () => {
  it('a short quotation fits one page: items, totals, terms and signatures', async () => {
    expect(await pages(await quotationPdf(view(3)))).toBe(1);
  });

  it('items longer than a page continue under the same header, and a long remark flows on', async () => {
    const remark = Array.from(
      { length: 12 },
      (_, i) =>
        `${i + 1}. Price did not included site network infrastructure equipment and other accessories which's not shown in this quote.`,
    ).join('\n');
    const pdf = await quotationPdf(view(60, remark));
    if (process.env.QUOTATION_PDF_OUT) {
      writeFileSync(process.env.QUOTATION_PDF_OUT, pdf);
    }
    expect(await pages(pdf)).toBeGreaterThan(2);
  }, 20_000);

  it('a draft or a logo that cannot be read still renders', async () => {
    const draft = view(1);
    draft.isFinal = false;
    draft.letterhead.logo = 'data:image/png;base64,AAAA';
    expect(await pages(await quotationPdf(draft))).toBe(1);
  });
});
