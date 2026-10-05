/**
 * CD-169 ผนึกเอกสาร / CD-170 ชุดหลักฐานการลงนาม — the signed PDF: each
 * signature drawn into its field, a signature page for `appendix` fields,
 * and evidence pages at the end. The caller hashes what this returns.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFFont, PDFPage, rgb } from 'pdf-lib';
import { BOX, placement, type LayoutField } from './esign-rules';

export interface SealSigner {
  fieldKey: string;
  name: string;
  label: string;
  kind: string;
  contact: string | null;
  signatureKind: string;
  signatureImage: { mime: string; bytes: Uint8Array } | null;
  signatureText: string | null;
  authMethod: string;
  signedAt: Date;
  viewedAt: Date | null;
  ip: string | null;
  userAgent: string | null;
}

export interface SealEvent {
  at: Date;
  type: string;
  who: string | null;
  ip: string | null;
}

export interface SealInput {
  original: Uint8Array;
  title: string;
  verifyCode: string;
  verifyUrl: string;
  originalHash: string;
  createdAt: Date;
  sentAt: Date | null;
  completedAt: Date;
  fields: LayoutField[];
  signers: SealSigner[];
  events: SealEvent[];
}

const EVENT_TH: Record<string, string> = {
  sent: 'ส่งคำขอลงนาม',
  notified: 'แจ้งเตือนในระบบ',
  opened: 'เปิดลิงก์',
  otp_sent: 'ส่งรหัสยืนยันตัวตน',
  otp_verified: 'ยืนยันตัวตนด้วยรหัส',
  otp_failed: 'กรอกรหัสผิด',
  viewed: 'เปิดอ่านเอกสาร',
  signed: 'ลงนาม',
  declined: 'ปฏิเสธการลงนาม',
  sealed: 'ผนึกเอกสาร',
  reminded: 'เตือนซ้ำ',
  expiry_warned: 'แจ้งผู้ส่งว่าใกล้หมดอายุ',
  extended: 'ขยายเวลา',
  link_reissued: 'ออกลิงก์ใหม่',
};

const AUTH_TH: Record<string, string> = {
  keycloak: 'ล็อกอินระบบกลางของบริษัท',
  otp_email: 'รหัสครั้งเดียวทางอีเมล',
  otp_sms: 'รหัสครั้งเดียวทาง SMS',
};

const SIGNATURE_TH: Record<string, string> = {
  draw: 'วาด',
  type: 'พิมพ์',
  upload: 'อัปโหลดภาพ',
};

export const thaiTime = (value: Date) =>
  value.toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

// Webpack turns `require.resolve` into a module id; the font files are read
// by path, so resolve with Node's own require (the bundle's
// `__non_webpack_require__`, plain `require` under ts-jest).
declare const __non_webpack_require__: NodeJS.Require | undefined;
const nodeRequire: NodeJS.Require =
  typeof __non_webpack_require__ === 'function'
    ? __non_webpack_require__
    : require;

function fontFile(name: string): Buffer {
  const root = dirname(nodeRequire.resolve('@fontsource/sarabun/package.json'));
  return readFileSync(join(root, 'files', name));
}

export interface Fonts {
  thai: PDFFont;
  latin: PDFFont;
  thaiBold: PDFFont;
  latinBold: PDFFont;
}

const THAI = /[฀-๿]+|[^฀-๿]+/g;

/** Thai and everything else come from two font files; draw run by run. */
export class Writer {
  constructor(private readonly fonts: Fonts) {}

  private runs(text: string, bold: boolean) {
    return (text.match(THAI) ?? ([] as string[])).map((run) => ({
      run,
      font: /[฀-๿]/.test(run)
        ? bold
          ? this.fonts.thaiBold
          : this.fonts.thai
        : bold
          ? this.fonts.latinBold
          : this.fonts.latin,
    }));
  }

  width(text: string, size: number, bold = false): number {
    return this.runs(text, bold).reduce(
      (sum, { run, font }) => sum + font.widthOfTextAtSize(run, size),
      0,
    );
  }

  draw(
    page: PDFPage,
    text: string,
    x: number,
    y: number,
    size: number,
    bold = false,
    grey = false,
  ): void {
    let at = x;
    for (const { run, font } of this.runs(text, bold)) {
      page.drawText(run, {
        x: at,
        y,
        size,
        font,
        color: grey ? rgb(0.35, 0.35, 0.35) : rgb(0, 0, 0),
      });
      at += font.widthOfTextAtSize(run, size);
    }
  }

  /** Split to lines no wider than `max`, breaking at spaces or characters. */
  wrap(text: string, size: number, max: number): string[] {
    const lines: string[] = [];
    let line = '';
    for (const char of Array.from(text)) {
      const next = line + char;
      if (this.width(next, size) > max && line) {
        const space = line.lastIndexOf(' ');
        if (space > 0 && char !== ' ') {
          lines.push(line.slice(0, space));
          line = line.slice(space + 1) + char;
        } else {
          lines.push(line);
          line = char === ' ' ? '' : char;
        }
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
    return lines;
  }
}

/** CD-252 — the Sarabun faces (Thai + Latin, regular + bold) for another PDF. */
export async function embedSarabun(doc: PDFDocument): Promise<Fonts> {
  doc.registerFontkit(fontkit);
  return {
    thai: await doc.embedFont(fontFile('sarabun-thai-400-normal.woff'), {
      subset: true,
    }),
    latin: await doc.embedFont(fontFile('sarabun-latin-400-normal.woff'), {
      subset: true,
    }),
    thaiBold: await doc.embedFont(fontFile('sarabun-thai-700-normal.woff'), {
      subset: true,
    }),
    latinBold: await doc.embedFont(fontFile('sarabun-latin-700-normal.woff'), {
      subset: true,
    }),
  };
}

export async function seal(input: SealInput): Promise<Uint8Array> {
  const doc = await PDFDocument.load(input.original);
  doc.registerFontkit(fontkit);
  const fonts: Fonts = {
    thai: await doc.embedFont(fontFile('sarabun-thai-400-normal.woff'), {
      subset: true,
    }),
    latin: await doc.embedFont(fontFile('sarabun-latin-400-normal.woff'), {
      subset: true,
    }),
    thaiBold: await doc.embedFont(fontFile('sarabun-thai-700-normal.woff'), {
      subset: true,
    }),
    latinBold: await doc.embedFont(fontFile('sarabun-latin-700-normal.woff'), {
      subset: true,
    }),
  };
  const writer = new Writer(fonts);
  const original = doc.getPages();
  const size = original[original.length - 1].getSize();
  const pageSize: [number, number] = [size.width, size.height];

  // --- the signatures, in their fields -----------------------------------------
  let appendix: PDFPage | null = null;
  let slot = 0;
  for (const field of input.fields) {
    const signer = input.signers.find((one) => one.fieldKey === field.key);
    if (!signer) continue;
    let page: PDFPage;
    let spot: { x: number; y: number };
    if (field.page === 'appendix') {
      if (!appendix) {
        appendix = doc.addPage(pageSize);
        writer.draw(
          appendix,
          'หน้าลงนาม',
          BOX.margin,
          size.height - 60,
          18,
          true,
        );
        writer
          .wrap(input.title, 12, size.width - BOX.margin * 2)
          .forEach((line, index) =>
            writer.draw(
              appendix!,
              line,
              BOX.margin,
              size.height - 84 - index * 16,
              12,
              false,
              true,
            ),
          );
      }
      page = appendix;
      spot = placement(field, original.length, size, slot++);
    } else {
      // which page first, then the spot on that page's own size
      const { pageIndex } = placement(field, original.length, size, 0);
      page = original[pageIndex];
      spot = placement(field, original.length, page.getSize(), 0);
    }
    await drawSignature(doc, page, writer, spot.x, spot.y, field, signer);
  }

  // --- the evidence ---------------------------------------------------------------
  evidence(doc, writer, pageSize, input);

  doc.setTitle(input.title);
  doc.setSubject(`ลงนามอิเล็กทรอนิกส์ · รหัสตรวจสอบ ${input.verifyCode}`);
  doc.setProducer('Connect the Dot — ระบบลงนามอิเล็กทรอนิกส์');
  doc.setModificationDate(input.completedAt);
  return doc.save();
}

async function drawSignature(
  doc: PDFDocument,
  page: PDFPage,
  writer: Writer,
  x: number,
  y: number,
  field: LayoutField,
  signer: SealSigner,
): Promise<void> {
  page.drawRectangle({
    x,
    y,
    width: BOX.width,
    height: BOX.height,
    borderColor: rgb(0.7, 0.7, 0.7),
    borderWidth: 0.6,
  });
  const inner = {
    x: x + 6,
    y: y + 24,
    width: BOX.width - 12,
    height: BOX.height - 30,
  };
  if (signer.signatureImage) {
    const image =
      signer.signatureImage.mime === 'image/png'
        ? await doc.embedPng(signer.signatureImage.bytes)
        : await doc.embedJpg(signer.signatureImage.bytes);
    // fill the box either way: a small upload grows, a large drawing shrinks
    const scale = Math.min(
      inner.width / image.width,
      inner.height / image.height,
    );
    const width = image.width * scale;
    const height = image.height * scale;
    page.drawImage(image, {
      x: inner.x + (inner.width - width) / 2,
      y: inner.y + (inner.height - height) / 2,
      width,
      height,
    });
  } else if (signer.signatureText) {
    const text = signer.signatureText;
    const fit = Math.min(
      20,
      (inner.width / Math.max(writer.width(text, 20, true), 1)) * 20,
    );
    writer.draw(
      page,
      text,
      inner.x + (inner.width - writer.width(text, fit, true)) / 2,
      inner.y + 12,
      fit,
      true,
    );
  }
  writer.draw(page, `${field.label}: ${signer.name}`, x + 6, y + 13, 7.5);
  writer.draw(
    page,
    `ลงนาม ${thaiTime(signer.signedAt)}`,
    x + 6,
    y + 4,
    6.5,
    false,
    true,
  );
}

function evidence(
  doc: PDFDocument,
  writer: Writer,
  pageSize: [number, number],
  input: SealInput,
): void {
  const [width, height] = pageSize;
  const left = 40;
  const max = width - 80;
  let page = doc.addPage(pageSize);
  let y = height - 50;
  const line = (text: string, size = 9, bold = false, grey = false) => {
    for (const piece of writer.wrap(text, size, max)) {
      if (y < 50) {
        page = doc.addPage(pageSize);
        y = height - 50;
      }
      writer.draw(page, piece, left, y, size, bold, grey);
      y -= size + 5;
    }
  };
  const gap = (points = 6) => {
    y -= points;
  };

  line('ชุดหลักฐานการลงนาม', 16, true);
  gap();
  line(`เอกสาร: ${input.title}`, 10);
  line(
    `รหัสตรวจสอบ: ${input.verifyCode} — ตรวจว่าไฟล์ที่ถืออยู่ตรงกับฉบับที่ลงนามได้ที่ ${input.verifyUrl}`,
    9,
  );
  line(
    `ค่าตรวจสอบ (SHA-256) ของเอกสารต้นฉบับก่อนลงนาม: ${input.originalHash}`,
    8,
    false,
    true,
  );
  line(
    `สร้าง ${thaiTime(input.createdAt)} · ส่งลงนาม ${input.sentAt ? thaiTime(input.sentAt) : '—'} · ลงนามครบ ${thaiTime(input.completedAt)}`,
    9,
  );
  gap(10);

  line('ผู้ลงนาม', 12, true);
  for (const signer of input.signers) {
    gap(4);
    const field = input.fields.find((one) => one.key === signer.fieldKey);
    line(
      `${field?.label ?? signer.fieldKey}: ${signer.name}${signer.kind === 'internal' ? ' (ภายใน)' : ' (ภายนอก)'}`,
      10,
      true,
    );
    if (signer.contact) line(`ติดต่อ: ${signer.contact}`, 9);
    line(
      `ยืนยันตัวตน: ${AUTH_TH[signer.authMethod] ?? signer.authMethod} · ลายมือชื่อแบบ${SIGNATURE_TH[signer.signatureKind] ?? signer.signatureKind}`,
      9,
    );
    line(
      `เปิดอ่านเอกสาร: ${signer.viewedAt ? thaiTime(signer.viewedAt) : '—'} · ลงนาม: ${thaiTime(signer.signedAt)}`,
      9,
    );
    line(`หมายเลขไอพี: ${signer.ip ?? '—'}`, 9);
    if (signer.userAgent) line(`อุปกรณ์: ${signer.userAgent}`, 8, false, true);
  }
  gap(10);

  line('ประวัติ', 12, true);
  for (const event of input.events) {
    line(
      `${thaiTime(event.at)} · ${EVENT_TH[event.type] ?? event.type}` +
        (event.who ? ` · ${event.who}` : '') +
        (event.ip ? ` · IP ${event.ip}` : ''),
      8.5,
    );
  }
  gap(10);
  line(
    'เอกสารนี้ผนึกหลังลงนามครบ — การแก้ไขใด ๆ หลังจากนี้จะทำให้ค่าตรวจสอบไม่ตรงกับที่ระบบบันทึกไว้',
    8,
    false,
    true,
  );
}
