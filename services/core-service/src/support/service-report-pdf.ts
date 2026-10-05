import { PDFDocument, rgb, type PDFPage } from 'pdf-lib';
import { embedSarabun, Writer } from '../esign/esign-seal';
import type { SeverityFigures } from './service-report-rules';

/**
 * CD-247 — the service report as the customer receives it: the company's
 * letterhead, the cover and period, the levels met per severity, the jobs
 * that missed, the maintenance rounds, and the penalty confirmed (if any).
 */
export interface ServiceReportPdfInput {
  companyName: string;
  reportNo: string;
  customerName: string;
  coverTitle: string;
  contractNo: string | null;
  periodFrom: string;
  periodTo: string;
  coverage: string | null;
  figures: SeverityFigures[];
  missed: {
    requestNo: string | null;
    subject: string;
    severity: string | null;
    lateHours: number;
  }[];
  pm: { due: number; done: number; skipped: number; overdue: number };
  penaltyAmount: number | null;
  penaltyNote: string | null;
}

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 50;
const SEVERITY: Record<string, string> = {
  critical: 'วิกฤต',
  high: 'สูง',
  medium: 'กลาง',
  low: 'ต่ำ',
  all: 'รวม',
};
const COVERAGE: Record<string, string> = {
  H24X7: '24 ชม. ทุกวัน',
  H8X7: 'เวลาทำการ ทุกวัน',
  H8X5: 'เวลาทำการ จันทร์–ศุกร์',
};

export function thaiDay(day: string) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export async function serviceReportPdf(
  input: ServiceReportPdfInput,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`รายงานผลการให้บริการ ${input.reportNo}`);
  const writer = new Writer(await embedSarabun(doc));
  const maxWidth = A4.width - MARGIN * 2;
  let page: PDFPage = doc.addPage([A4.width, A4.height]);
  let y = A4.height - MARGIN;
  const newPage = () => {
    page = doc.addPage([A4.width, A4.height]);
    y = A4.height - MARGIN;
  };
  const ensure = (h: number) => {
    if (y < MARGIN + h) newPage();
  };
  const line = (text: string, size = 10.5, bold = false, indent = 0) => {
    for (const part of writer.wrap(text, size, maxWidth - indent)) {
      ensure(size);
      writer.draw(page, part, MARGIN + indent, y, size, bold);
      y -= size * 1.6;
    }
  };
  const rule = () => {
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: A4.width - MARGIN, y },
      thickness: 0.5,
      color: rgb(0.6, 0.6, 0.6),
    });
  };

  // header
  writer.draw(page, input.companyName, MARGIN, y, 13, true);
  const no = `เลขที่ ${input.reportNo}`;
  writer.draw(page, no, A4.width - MARGIN - writer.width(no, 10), y, 10);
  y -= 32;
  const title = 'รายงานผลการให้บริการ';
  writer.draw(
    page,
    title,
    (A4.width - writer.width(title, 17, true)) / 2,
    y,
    17,
    true,
  );
  y -= 14;
  rule();
  y -= 22;

  const facts: [string, string][] = [
    ['ลูกค้า', input.customerName],
    [
      'สัญญา/สิทธิ์บริการ',
      [input.contractNo, input.coverTitle].filter(Boolean).join(' · '),
    ],
    ['งวดรายงาน', `${thaiDay(input.periodFrom)} – ${thaiDay(input.periodTo)}`],
    [
      'ช่วงเวลาบริการ',
      input.coverage ? (COVERAGE[input.coverage] ?? input.coverage) : '—',
    ],
  ];
  for (const [label, value] of facts) {
    ensure(11);
    writer.draw(page, label, MARGIN, y, 10.5, true);
    writer.draw(page, value, MARGIN + 120, y, 10.5);
    y -= 17;
  }
  y -= 8;

  // figures
  line('ผลการให้บริการเทียบระดับที่ผูกพัน', 12, true);
  const cols = [MARGIN, MARGIN + 80, MARGIN + 140, MARGIN + 250, MARGIN + 360];
  const head = [
    'ความรุนแรง',
    'จำนวนงาน',
    'ตอบกลับทันกำหนด',
    'แก้ไขทันกำหนด',
    'ยังไม่ปิด',
  ];
  ensure(12);
  head.forEach((text, i) => writer.draw(page, text, cols[i], y, 9.5, true));
  y -= 15;
  const show = (met: number, missed: number, p: number | null) =>
    p === null ? '—' : `${p}% (${met}/${met + missed})`;
  for (const row of input.figures) {
    ensure(11);
    const cells = [
      SEVERITY[row.severity] ?? row.severity,
      String(row.jobs),
      show(row.responseMet, row.responseMissed, row.responsePct),
      show(row.resolutionMet, row.resolutionMissed, row.resolutionPct),
      String(row.open),
    ];
    cells.forEach((text, i) =>
      writer.draw(page, text, cols[i], y, 9.5, row.severity === 'all'),
    );
    y -= 15;
  }
  y -= 8;

  if (input.missed.length) {
    line('งานที่แก้ไขเกินกำหนด', 12, true);
    for (const job of input.missed) {
      line(
        `• ${job.requestNo ?? '—'} ${job.subject} (${SEVERITY[job.severity ?? ''] ?? job.severity ?? '—'}) — เกิน ${job.lateHours} ชม.`,
        10,
        false,
        10,
      );
    }
    y -= 6;
  }

  line('การบำรุงรักษาตามรอบ', 12, true);
  line(
    input.pm.due
      ? `ครบกำหนดในงวด ${input.pm.due} รอบ · ทำแล้ว ${input.pm.done} · ข้าม ${input.pm.skipped} · ค้าง ${input.pm.overdue}`
      : 'ไม่มีรอบบำรุงรักษาครบกำหนดในงวดนี้',
    10.5,
    false,
    10,
  );
  y -= 6;

  if (input.penaltyAmount !== null) {
    line('ค่าปรับตามสัญญา', 12, true);
    line(
      `${input.penaltyAmount.toLocaleString('th-TH', { minimumFractionDigits: 2 })} บาท`,
      10.5,
      false,
      10,
    );
    if (input.penaltyNote) line(input.penaltyNote, 10, false, 10);
  }
  return Buffer.from(await doc.save());
}
