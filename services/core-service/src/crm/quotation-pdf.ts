import { PDFDocument, rgb, type PDFPage } from 'pdf-lib';
import { embedSarabun, Writer } from '../esign/esign-seal';
import type { QuotationPrintService } from './quotation-print.service';

/**
 * ใบเสนอราคาเป็น PDF (5 พ.ย. 2569) — for the email to the customer. The
 * screen prints from the browser (`printView`); this draws the same content
 * on the server, from the same view, so the two never say different things.
 */
export type QuotationPrintView = Awaited<
  ReturnType<QuotationPrintService['printView']>
>;

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 48;

const money = (value: unknown) =>
  Number(value ?? 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const thaiDay = (value: Date | string | null | undefined) =>
  value
    ? new Date(value).toLocaleDateString('th-TH', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'Asia/Bangkok',
      })
    : '—';

export async function quotationPdf(view: QuotationPrintView): Promise<Buffer> {
  const { quotation: q, billTo, seller, letterhead } = view;
  const doc = await PDFDocument.create();
  doc.setTitle(`ใบเสนอราคา ${q.quotationNo} v${q.version}`);
  const writer = new Writer(await embedSarabun(doc));
  const right = A4.width - MARGIN;
  const maxWidth = right - MARGIN;
  let page: PDFPage = doc.addPage([A4.width, A4.height]);
  let y = A4.height - MARGIN;

  const newPage = () => {
    page = doc.addPage([A4.width, A4.height]);
    y = A4.height - MARGIN;
  };
  const ensure = (height: number) => {
    if (y - height < MARGIN) newPage();
  };
  const text = (value: string, size = 10, bold = false, indent = 0) => {
    for (const part of writer.wrap(value, size, maxWidth - indent)) {
      ensure(size * 1.6);
      writer.draw(page, part, MARGIN + indent, y, size, bold);
      y -= size * 1.6;
    }
  };
  const rightText = (value: string, x: number, size = 10, bold = false) =>
    writer.draw(
      page,
      value,
      x - writer.width(value, size, bold),
      y,
      size,
      bold,
    );
  const rule = () => {
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: right, y },
      thickness: 0.6,
      color: rgb(0.6, 0.6, 0.6),
    });
  };

  // Letterhead
  writer.draw(page, letterhead.nameTh, MARGIN, y, 14, true);
  rightText('ใบเสนอราคา', right, 16, true);
  y -= 18;
  for (const value of [
    letterhead.nameEn,
    letterhead.address,
    [
      letterhead.taxId ? `เลขประจำตัวผู้เสียภาษี ${letterhead.taxId}` : null,
      letterhead.branch,
    ]
      .filter(Boolean)
      .join(' · '),
    [letterhead.phone, letterhead.email, letterhead.website]
      .filter(Boolean)
      .join(' · '),
  ]) {
    if (value) text(value, 9);
  }
  if (!view.isFinal) text('ร่าง — ยังไม่ใช่ฉบับที่ส่งลูกค้าได้', 10, true);
  y -= 6;
  rule();
  y -= 18;

  // Parties and document facts
  const top = y;
  writer.draw(page, 'เสนอราคาถึง', MARGIN, y, 10, true);
  y -= 15;
  for (const value of [
    billTo.name,
    billTo.branch,
    billTo.address,
    billTo.taxId ? `เลขประจำตัวผู้เสียภาษี ${billTo.taxId}` : null,
    billTo.contactName ? `ผู้ติดต่อ ${billTo.contactName}` : null,
  ]) {
    if (!value) continue;
    for (const part of writer.wrap(value, 10, maxWidth / 2 - 10)) {
      writer.draw(page, part, MARGIN, y, 10);
      y -= 15;
    }
  }
  const leftBottom = y;
  y = top;
  const facts: [string, string][] = [
    [
      'เลขที่',
      `${q.quotationNo ?? ''}${(q.version ?? 1) > 1 ? ` (ฉบับที่ ${q.version})` : ''}`,
    ],
    ['วันที่', thaiDay(q.createdAt)],
    ['ยืนราคาถึง', thaiDay(q.validUntil)],
    ['เงื่อนไขชำระเงิน', q.paymentTerms ?? '—'],
    [
      'ผู้เสนอ',
      seller
        ? `${seller.name}${seller.email ? ` (${seller.email})` : ''}`
        : '—',
    ],
  ];
  const factX = MARGIN + maxWidth / 2 + 10;
  for (const [label, value] of facts) {
    writer.draw(page, label, factX, y, 10, true);
    const parts = writer.wrap(value, 10, right - factX - 90);
    parts.forEach((part, i) =>
      writer.draw(page, part, factX + 90, y - i * 15, 10),
    );
    y -= Math.max(1, parts.length) * 15;
  }
  y = Math.min(y, leftBottom) - 10;
  if (q.title) text(`เรื่อง ${q.title}`, 11, true);
  y -= 4;

  // Lines
  const cols = {
    no: MARGIN,
    desc: MARGIN + 24,
    qty: right - 210,
    price: right - 130,
    disc: right - 80,
    total: right,
  };
  const header = () => {
    ensure(24);
    rule();
    y -= 13;
    writer.draw(page, '#', cols.no, y, 9, true);
    writer.draw(page, 'รายการ', cols.desc, y, 9, true);
    rightText('จำนวน', cols.qty, 9, true);
    rightText('ราคา/หน่วย', cols.price, 9, true);
    rightText('ส่วนลด', cols.disc, 9, true);
    rightText('จำนวนเงิน', cols.total, 9, true);
    y -= 7;
    rule();
    y -= 13;
  };
  header();
  for (const line of q.lines ?? []) {
    const label = [
      line.productCode ? `[${line.productCode}] ` : '',
      line.description,
      line.priceModel === 'monthly' && line.termMonths
        ? ` (รายเดือน ${line.termMonths} เดือน)`
        : '',
    ].join('');
    const parts = writer.wrap(label, 9, cols.qty - cols.desc - 50);
    if (y - parts.length * 13 < MARGIN) {
      newPage();
      header();
    }
    writer.draw(page, String(line.lineNo), cols.no, y, 9);
    rightText(
      `${Number(line.quantity)}${line.unit ? ` ${line.unit}` : ''}`,
      cols.qty,
      9,
    );
    rightText(money(line.unitPrice), cols.price, 9);
    rightText(
      Number(line.discountPct ?? 0) > 0 ? `${Number(line.discountPct)}%` : '-',
      cols.disc,
      9,
    );
    rightText(money(line.lineTotal), cols.total, 9);
    parts.forEach((part, i) =>
      writer.draw(page, part, cols.desc, y - i * 13, 9),
    );
    y -= parts.length * 13 + 4;
  }
  rule();
  y -= 16;

  // Totals
  const totals: [string, unknown, boolean][] = [
    ['รวมเป็นเงิน', q.subtotal, false],
    ['ส่วนลด', q.discountTotal, false],
    ['ยอดหลังหักส่วนลด', q.netTotal, false],
    [`ภาษีมูลค่าเพิ่ม ${Number(q.vatPct ?? 0)}%`, q.vatAmount, false],
    [`ยอดรวมทั้งสิ้น (${q.currency ?? 'THB'})`, q.grandTotal, true],
  ];
  for (const [label, value, bold] of totals) {
    ensure(16);
    rightText(label, right - 100, 10, bold);
    rightText(money(value), right, 10, bold);
    y -= 15;
  }
  if (view.monthlyRecurring) {
    ensure(16);
    rightText(
      `ค่าบริการรายเดือน ${money(view.monthlyRecurring)} ${q.currency ?? 'THB'}`,
      right,
      9,
    );
    y -= 15;
  }
  y -= 8;

  if (q.note?.trim()) {
    text('หมายเหตุ', 10, true);
    text(q.note.trim(), 9, false, 8);
    y -= 4;
  }
  if (letterhead.terms?.trim()) {
    text('เงื่อนไข', 10, true);
    text(letterhead.terms.trim(), 9, false, 8);
  }

  return Buffer.from(await doc.save());
}
