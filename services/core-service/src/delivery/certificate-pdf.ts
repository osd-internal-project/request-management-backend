import { PDFDocument, rgb, type PDFPage } from 'pdf-lib';
import { BOX } from '../esign/esign-rules';
import { embedSarabun, Writer } from '../esign/esign-seal';

/**
 * CD-252 ใบรับรองการตรวจรับ — the company's certificate, drawn as a PDF: the
 * company, the certificate number, the project, contract and phase, what
 * the phase delivered, the result (accepted, or accepted with the open
 * points and the dates they are due), and room at the foot of the last page
 * for the signature boxes the e-sign layout places there (CD-14).
 */

export interface CertificateInput {
  companyName: string;
  certificateNo: string;
  projectNo: string;
  projectName: string;
  contractNo: string | null;
  customerName: string | null;
  phase: string;
  decidedOn: string;
  result: 'accepted' | 'conditional';
  note: string | null;
  deliverables: string[];
  openPoints: { text: string; dueOn: string }[];
}

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 56;
/** Kept free at the foot of the last page for the signature boxes. */
const SIGNATURE_ROOM = BOX.margin + BOX.height + 60;

export function thaiDate(day: string) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export async function certificatePdf(input: CertificateInput): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`ใบรับรองการตรวจรับ ${input.certificateNo}`);
  const writer = new Writer(await embedSarabun(doc));
  const maxWidth = A4.width - MARGIN * 2;
  let page: PDFPage = doc.addPage([A4.width, A4.height]);
  let y = A4.height - MARGIN;

  const newPage = () => {
    page = doc.addPage([A4.width, A4.height]);
    y = A4.height - MARGIN;
  };
  const line = (text: string, size = 11, bold = false, indent = 0) => {
    for (const part of writer.wrap(text, size, maxWidth - indent)) {
      if (y < MARGIN + size) newPage();
      writer.draw(page, part, MARGIN + indent, y, size, bold);
      y -= size * 1.6;
    }
  };
  const gap = (h = 8) => {
    y -= h;
  };

  // Header
  writer.draw(page, input.companyName, MARGIN, y, 13, true);
  const no = `เลขที่ ${input.certificateNo}`;
  writer.draw(page, no, A4.width - MARGIN - writer.width(no, 10), y, 10);
  y -= 34;
  const title = 'ใบรับรองการตรวจรับงาน';
  writer.draw(
    page,
    title,
    (A4.width - writer.width(title, 18, true)) / 2,
    y,
    18,
    true,
  );
  y -= 14;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: A4.width - MARGIN, y },
    thickness: 0.6,
    color: rgb(0.6, 0.6, 0.6),
  });
  y -= 24;

  // Facts
  const facts: [string, string][] = [
    ['โครงการ', `${input.projectNo} · ${input.projectName}`],
    ['สัญญา', input.contractNo ?? '—'],
    ['ลูกค้า', input.customerName ?? '—'],
    ['เฟสที่ตรวจรับ', input.phase],
    ['วันที่ตรวจรับ', thaiDate(input.decidedOn)],
    [
      'ผลการตรวจรับ',
      input.result === 'accepted' ? 'รับมอบ' : 'รับมอบโดยมีเงื่อนไข',
    ],
  ];
  for (const [label, value] of facts) {
    if (y < MARGIN + 11) newPage();
    writer.draw(page, label, MARGIN, y, 11, true);
    const lines = writer.wrap(value, 11, maxWidth - 120);
    for (const [i, part] of lines.entries()) {
      writer.draw(page, part, MARGIN + 120, y - i * 17, 11);
    }
    y -= Math.max(1, lines.length) * 17 + 2;
  }
  gap(10);

  line('รายการที่ส่งมอบในเฟสนี้', 12, true);
  if (input.deliverables.length) {
    for (const item of input.deliverables) line(`• ${item}`, 11, false, 12);
  } else {
    line('— ตามขอบเขตงานของเฟส —', 11, false, 12);
  }
  gap(10);

  if (input.result === 'conditional') {
    line('รายการค้างและกำหนดแก้ไข', 12, true);
    for (const point of input.openPoints) {
      line(`• ${point.text} — ภายใน ${thaiDate(point.dueOn)}`, 11, false, 12);
    }
    gap(10);
  }
  if (input.note?.trim()) {
    line('หมายเหตุ', 12, true);
    line(input.note.trim(), 11, false, 12);
    gap(10);
  }

  line(
    input.result === 'accepted'
      ? 'ผู้ลงนามด้านล่างยืนยันว่าได้ตรวจรับงานของเฟสข้างต้นครบถ้วนตามขอบเขตงานแล้ว'
      : 'ผู้ลงนามด้านล่างยืนยันการรับมอบงานของเฟสข้างต้น โดยบริษัทจะแก้ไขรายการค้างภายในกำหนดข้างต้น',
    11,
  );

  // The signature boxes go at the foot of the last page.
  if (y < SIGNATURE_ROOM + 20) newPage();
  return Buffer.from(await doc.save());
}
