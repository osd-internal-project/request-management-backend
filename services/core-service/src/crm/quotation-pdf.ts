import {
  PDFDocument,
  degrees,
  rgb,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib';
import { embedSarabun, Writer } from '../esign/esign-seal';
import type { QuotationPrintService } from './quotation-print.service';

/**
 * ใบเสนอราคาเป็น PDF (5 พ.ย. 2569) — for the email to the customer. The
 * screen prints from the browser (`printView`); this draws the same content
 * on the server, from the same view, so the two never say different things.
 *
 * แบบฟอร์มตามต้นแบบของบริษัท (11 พ.ย. 2569): หัวกระดาษ + กรอบ "ใบเสนอราคา
 * (Quotation)" + ข้อมูลลูกค้า/ผู้ขาย ซ้ำทุกหน้า, ตารางรายการ, ยอดรวม, เงื่อนไข,
 * Remark, ช่องลงนาม และท้ายกระดาษ Print Date / Page n / N.
 */
export type QuotationPrintView = Awaited<
  ReturnType<QuotationPrintService['printView']>
>;

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 26;
const LEFT = MARGIN;
const RIGHT = A4.width - MARGIN;
const WIDTH = RIGHT - LEFT;
/** เส้นแบ่งซ้าย/ขวาของกล่องข้อมูล และขอบซ้ายของกล่องยอดรวม */
const MID = LEFT + WIDTH * 0.548;
const BOTTOM = 34;
const SIZE = 8.5;
const ROW = 13;
const PAD = 4;
/** ช่องหัวข้อของตารางเงื่อนไข / Remark */
const TERM_LABEL = 166;

const COLS = (() => {
  const amount = RIGHT - 78;
  const discount = amount - 56;
  const price = discount - 70;
  const unit = price - 44;
  const qty = unit - 32;
  const desc = LEFT + 30;
  return { item: LEFT, desc, qty, unit, price, discount, amount };
})();
const COL_LINES = [
  COLS.desc,
  COLS.qty,
  COLS.unit,
  COLS.price,
  COLS.discount,
  COLS.amount,
];

const money = (value: unknown) =>
  Number(value ?? 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const quantity = (value: unknown) =>
  Number(value ?? 0).toLocaleString('en-US', { maximumFractionDigits: 3 });

/** dd/mm/yyyy (ค.ศ.) ตามต้นแบบ */
const day = (value: Date | string) =>
  new Date(value).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Bangkok',
  });

const stamp = (value: Date) =>
  `${day(value)}  ${value.toLocaleTimeString('en-GB', {
    hour12: false,
    timeZone: 'Asia/Bangkok',
  })}`;

/** ส่วนลดของบรรทัดเป็นจำนวนเงิน — ราคาเต็มตามวิธีคิดราคา (CD-196) ลบยอดบรรทัด */
function lineDiscount(line: {
  quantity: unknown;
  unitPrice: unknown;
  lineTotal: unknown;
  priceModel: string;
  termMonths: number | null;
}): number {
  const count =
    line.priceModel === 'lump_sum'
      ? 1
      : Number(line.quantity) *
        (line.priceModel === 'monthly' ? (line.termMonths ?? 1) : 1);
  const off = count * Number(line.unitPrice) - Number(line.lineTotal);
  return off > 0.004 ? Math.round(off * 100) / 100 : 0;
}

async function embedLogo(
  doc: PDFDocument,
  logo: string | null | undefined,
): Promise<PDFImage | null> {
  const match = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(logo ?? '');
  if (!match) return null;
  try {
    const bytes = Buffer.from(match[2], 'base64');
    return match[1].toLowerCase() === 'png'
      ? await doc.embedPng(bytes)
      : await doc.embedJpg(bytes);
  } catch {
    // โลโก้ที่อ่านไม่ได้ไม่ควรทำให้ส่งใบเสนอราคาไม่ได้
    return null;
  }
}

export async function quotationPdf(
  view: QuotationPrintView,
  printedAt: Date = new Date(),
): Promise<Buffer> {
  const { quotation: q, billTo, seller, letterhead } = view;
  const doc = await PDFDocument.create();
  const docNo = `${q.quotationNo ?? ''}${(q.version ?? 1) > 1 ? ` (ฉบับที่ ${q.version})` : ''}`;
  doc.setTitle(`ใบเสนอราคา ${q.quotationNo} v${q.version}`);
  const fonts = await embedSarabun(doc);
  const writer = new Writer(fonts);
  const logo = await embedLogo(doc, letterhead.logo);
  const issued = q.sentAt ?? q.createdAt ?? printedAt;

  let page!: PDFPage;
  let y = 0;
  /** ขอบล่างของกรอบใหญ่ของแต่ละหน้า — วาดตอนจบเพราะหน้าสุดท้ายจบที่เนื้อหา */
  const frames: { page: PDFPage; top: number; bottom: number }[] = [];

  const hline = (at: number, from = LEFT, to = RIGHT, thickness = 0.7) =>
    page.drawLine({
      start: { x: from, y: at },
      end: { x: to, y: at },
      thickness,
      color: rgb(0, 0, 0),
    });
  const vline = (x: number, from: number, to: number) =>
    page.drawLine({
      start: { x, y: from },
      end: { x, y: to },
      thickness: 0.7,
      color: rgb(0, 0, 0),
    });
  const left = (value: string, x: number, at: number, bold = false) =>
    writer.draw(page, value, x, at, SIZE, bold);
  const rightAt = (value: string, x: number, at: number, bold = false) =>
    writer.draw(
      page,
      value,
      x - writer.width(value, SIZE, bold),
      at,
      SIZE,
      bold,
    );
  const centre = (
    value: string,
    from: number,
    to: number,
    at: number,
    size = SIZE,
    bold = false,
  ) =>
    writer.draw(
      page,
      value,
      (from + to - writer.width(value, size, bold)) / 2,
      at,
      size,
      bold,
    );
  /** ตัดบรรทัดตามที่พิมพ์มา แล้วตัดตามความกว้าง */
  const wrap = (value: string, max: number) =>
    value
      .split(/\r?\n/)
      .flatMap((part) => (part ? writer.wrap(part, SIZE, max) : ['']));

  // กล่องข้อมูลลูกค้า/ผู้ขาย — เหมือนกันทุกหน้า คำนวณครั้งเดียว
  const leftValue = LEFT + 72;
  const rightValue = MID + 104;
  const address = billTo.address
    ? wrap(billTo.address, MID - leftValue - PAD)
    : [''];
  const partyRows: [string, string[]][] = [
    ['Attention', [billTo.contactName ?? '']],
    [
      'Company',
      wrap(
        `${billTo.name}${billTo.branch ? ` (${billTo.branch})` : ''}`,
        MID - leftValue - PAD,
      ),
    ],
    ['Address', address.length > 1 ? address : [...address, '']],
    ['', ['']],
    ['Tel', [billTo.phone ?? '']],
    ['Fax', [q.partyFax ?? '']],
    ['Email', [billTo.email ?? '']],
    ['Subject', wrap(q.title ?? '', MID - leftValue - PAD)],
  ];
  const sellerRows: [string, string[]][] = [
    ['Quotation No.', [docNo]],
    ['Date.', [day(issued)]],
    ['Sales Executive', wrap(seller?.name ?? '', RIGHT - rightValue - PAD)],
    ['Tel/Ext.', [seller?.phone ?? '']],
    ['Fax', [letterhead.fax ?? '']],
    ['Mobile', [q.sellerMobile ?? '']],
    ['Email', [seller?.email ?? '']],
  ];
  const rowCount = (rows: [string, string[]][]) =>
    rows.reduce((sum, [, lines]) => sum + lines.length, 0);
  const infoHeight =
    Math.max(rowCount(partyRows), rowCount(sellerRows)) * ROW + 6;

  const drawInfo = (
    rows: [string, string[]][],
    labelX: number,
    valueX: number,
    top: number,
  ) => {
    let at = top - 11;
    for (const [label, lines] of rows) {
      if (label) {
        left(label, labelX, at);
        left(':', valueX - 8, at);
      }
      lines.forEach((line, i) => left(line, valueX, at - i * ROW));
      at -= lines.length * ROW;
    }
  };

  const newPage = () => {
    page = doc.addPage([A4.width, A4.height]);
    if (!view.isFinal) {
      // ลายน้ำ — ยังไม่ใช่ฉบับที่ส่งลูกค้าได้
      page.drawText('ร่าง', {
        x: 190,
        y: 300,
        size: 150,
        font: fonts.thaiBold,
        color: rgb(0.8, 0.8, 0.8),
        opacity: 0.45,
        rotate: degrees(30),
      });
    }

    // หัวกระดาษ
    const top = A4.height - 20;
    let textX = LEFT;
    if (logo) {
      const scale = Math.min(34 / logo.height, 96 / logo.width);
      const size = { width: logo.width * scale, height: logo.height * scale };
      page.drawImage(logo, {
        x: LEFT,
        y: top - 2 - size.height,
        ...size,
      });
      textX = LEFT + size.width + 8;
    }
    writer.draw(page, letterhead.nameTh, textX, top - 10, 11.5, true);
    const contact = [
      letterhead.phone ? `เบอร์โทร ${letterhead.phone}` : null,
      letterhead.fax ? `โทรสาร ${letterhead.fax}` : null,
      letterhead.taxId ? `เลขประจำตัวผู้เสียภาษี ${letterhead.taxId}` : null,
      letterhead.branch,
    ]
      .filter(Boolean)
      .join(' ');
    const headLines = [
      ...(letterhead.address
        ? writer.wrap(
            letterhead.address.replace(/\s*\n\s*/g, ' '),
            SIZE,
            RIGHT - textX - 110,
          )
        : []),
      contact,
    ]
      .filter(Boolean)
      .slice(0, 2);
    headLines.forEach((line, i) => left(line, textX, top - 22 - i * 11.5));
    rightAt('เลขที่เอกสาร', RIGHT, top - 14);
    rightAt(docNo, RIGHT, top - 33.5);

    // กรอบ + ชื่อเอกสาร + กล่องข้อมูล
    const boxTop = top - 42;
    centre('ใบเสนอราคา (Quotation)', LEFT, RIGHT, boxTop - 19, 12, true);
    const infoTop = boxTop - 28;
    hline(infoTop);
    drawInfo(partyRows, LEFT + PAD, leftValue, infoTop);
    drawInfo(sellerRows, MID + PAD, rightValue, infoTop);
    y = infoTop - infoHeight;
    vline(MID, infoTop, y);
    hline(y);
    frames.push({ page, top: boxTop, bottom: BOTTOM });
  };
  const frame = () => frames[frames.length - 1];

  // ── รายการ ───────────────────────────────────────────────────────────
  let columnsTop = 0;
  const closeColumns = (bottom: number) =>
    COL_LINES.forEach((x) => vline(x, columnsTop, bottom));
  const tableHead = () => {
    columnsTop = y;
    const at = y - 14;
    centre('Item', COLS.item, COLS.desc, at, SIZE, true);
    centre('Description', COLS.desc, COLS.qty, at, SIZE, true);
    centre('Qty', COLS.qty, COLS.unit, at, SIZE, true);
    centre('Unit', COLS.unit, COLS.price, at, SIZE, true);
    centre('Unit Price', COLS.price, COLS.discount, at, SIZE, true);
    centre('Discount', COLS.discount, COLS.amount, at, SIZE, true);
    centre(
      `Amount(${q.currency ?? 'THB'})`,
      COLS.amount,
      RIGHT,
      at,
      SIZE,
      true,
    );
    y -= 22;
    hline(y);
    y -= 3;
  };

  newPage();
  tableHead();
  for (const line of q.lines ?? []) {
    const lines = wrap(
      `${line.productCode ? `[${line.productCode}] ` : ''}${line.description}`,
      COLS.qty - COLS.desc - PAD * 2,
    );
    if (line.priceModel === 'monthly' && line.termMonths) {
      lines.push(`(ราคาต่อเดือน × ${line.termMonths} เดือน)`);
    } else if (line.priceModel === 'lump_sum') {
      lines.push('(ราคาเหมาทั้งงาน)');
    }
    let first = true;
    // บรรทัดยาวกว่าหน้าที่เหลือ → ตัวเลขอยู่กับบรรทัดแรก ที่เหลือไหลไปหน้าถัดไป
    while (lines.length) {
      if (y - ROW < BOTTOM + 2) {
        closeColumns(BOTTOM);
        newPage();
        tableHead();
      }
      const at = y - 10;
      if (first) {
        centre(String(line.lineNo), COLS.item, COLS.desc, at);
        centre(quantity(line.quantity), COLS.qty, COLS.unit, at);
        centre(line.unit ?? '', COLS.unit, COLS.price, at);
        rightAt(money(line.unitPrice), COLS.discount - PAD - 2, at);
        rightAt(money(lineDiscount(line)), COLS.amount - PAD - 2, at);
        rightAt(money(line.lineTotal), RIGHT - PAD - 2, at);
        first = false;
      }
      left(lines.shift() ?? '', COLS.desc + PAD, at);
      y -= ROW;
    }
  }

  // ── ยอดรวม + เงื่อนไข ────────────────────────────────────────────────
  const totals: [string, unknown][] = [
    ['Total', q.subtotal],
    ['Discount', q.discountTotal],
    ['Total Excluding Vat', q.netTotal],
    [`Vat ${quantity(q.vatPct)}%`, q.vatAmount],
    ['Total Price', q.grandTotal],
  ];
  const TOTAL_ROW = 20;
  const TERM_ROW = 19;
  const termWidth = RIGHT - LEFT - TERM_LABEL - PAD * 2;
  const validity = q.validUntil
    ? `${Math.max(
        0,
        Math.round(
          (new Date(q.validUntil).getTime() -
            new Date(q.createdAt ?? issued).getTime()) /
            86_400_000,
        ),
      )} days (until ${day(q.validUntil)})`
    : null;
  const terms = (
    [
      ['Validity of Offer', validity],
      ['Delivery Time', q.deliveryTime?.trim() || null],
      ['Warranty', q.warranty?.trim() || null],
      ['Term of Payment (Customer)', q.paymentTerms?.trim() || null],
    ] as [string, string | null][]
  )
    .filter((row): row is [string, string] => Boolean(row[1]))
    .map(([label, value]) => [label, wrap(value, termWidth)] as const);
  const monthly = Number(view.monthlyRecurring ?? 0) > 0;
  const summaryHeight =
    totals.length * TOTAL_ROW +
    (monthly ? TOTAL_ROW : 0) +
    terms.reduce(
      (sum, [, lines]) => sum + Math.max(TERM_ROW, lines.length * ROW + 6),
      0,
    );

  if (y - 6 - summaryHeight < BOTTOM) {
    // ไม่พอ → ตารางรายการยาวถึงขอบล่างตามต้นแบบ ยอดรวมขึ้นหน้าใหม่
    closeColumns(BOTTOM);
    newPage();
  } else {
    y -= 6;
    closeColumns(y);
    hline(y);
  }
  const totalsTop = y;
  for (const [label, value] of totals) {
    left(label, MID + PAD, y - 13);
    rightAt(money(value), RIGHT - PAD - 2, y - 13);
    y -= TOTAL_ROW;
    hline(y, MID);
  }
  if (monthly) {
    left('Monthly Recurring (included)', MID + PAD, y - 13);
    rightAt(money(view.monthlyRecurring), RIGHT - PAD - 2, y - 13);
    y -= TOTAL_ROW;
  }
  vline(MID, totalsTop, y);
  vline(COLS.amount, totalsTop, y);
  hline(y);

  const labelLine = LEFT + TERM_LABEL;
  for (const [label, lines] of terms) {
    const height = Math.max(TERM_ROW, lines.length * ROW + 6);
    left(label, LEFT + PAD, y - 13);
    lines.forEach((line, i) => left(line, labelLine + PAD, y - 13 - i * ROW));
    vline(labelLine, y, y - height);
    y -= height;
    hline(y);
  }

  // ── Remark ───────────────────────────────────────────────────────────
  const remark = [q.note?.trim(), letterhead.terms?.trim()]
    .filter(Boolean)
    .join('\n');
  if (remark) {
    const lines = wrap(remark, termWidth);
    let top = y;
    let labelled = false;
    while (lines.length) {
      if (y - ROW - 8 < BOTTOM) {
        if (top !== y) vline(labelLine, top, BOTTOM);
        newPage();
        top = y;
        labelled = false;
      }
      if (!labelled) {
        left('Remark', LEFT + PAD, y - 13);
        labelled = true;
      }
      left(lines.shift() ?? '', labelLine + PAD, y - 13);
      y -= ROW;
    }
    y -= 6;
    vline(labelLine, top, y);
  }
  frame().bottom = y;

  // ── ลงนาม ────────────────────────────────────────────────────────────
  const SIGN = 96;
  if (y - SIGN < BOTTOM) {
    newPage();
    frame().bottom = y;
  }
  const dots = '.'.repeat(58);
  const signBox = (x: number, title: string) => {
    centre(title, x, x + 180, y - 34);
    left(`Name${dots}`, x, y - 52);
    left(`( ${dots} )`, x, y - 68);
    left(
      'วันที่ / Date .............../....................../................',
      x,
      y - 84,
    );
  };
  signBox(LEFT + 50, 'For Accepted by Customer');
  signBox(MID + 40, letterhead.nameEn ?? letterhead.nameTh);

  // ── กรอบและท้ายกระดาษ — รู้จำนวนหน้าแล้ว ─────────────────────────────
  frames.forEach((entry, index) => {
    page = entry.page;
    page.drawRectangle({
      x: LEFT,
      y: entry.bottom,
      width: WIDTH,
      height: entry.top - entry.bottom,
      borderWidth: 0.9,
      borderColor: rgb(0, 0, 0),
    });
    hline(BOTTOM, LEFT, RIGHT, 0.9);
    writer.draw(page, `Print Date : ${stamp(printedAt)}`, LEFT, 20, 7);
    const label = `Page : ${index + 1} / ${frames.length}`;
    writer.draw(page, label, RIGHT - writer.width(label, 7), 20, 7);
  });

  return Buffer.from(await doc.save());
}
