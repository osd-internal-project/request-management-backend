import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE_DIR = join(__dirname, '..', 'docs', 'source');
const SOURCE_HTML = join(
  SOURCE_DIR,
  'CTD Foundation Sprint_files',
  'saved_resource.html',
);
const OUTPUT = join(SOURCE_DIR, 'spec.txt');

/**
 * Turns the saved specification page into plain text that can be committed,
 * diffed, and grepped.
 *
 * `docs/source/CTD Foundation Sprint.html` is only the Claude artifact shell —
 * it contains no specification text at all, and every attempt to read it comes
 * back empty. The content lives in the `_files` companion directory that the
 * shell references. Extracting once into a committed `spec.txt` means nobody
 * has to rediscover that, and the source stops being re-parsed from scratch in
 * every session.
 */
function toPlainText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/td|\/th)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(Number(code)),
    )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function main(): void {
  let html: string;

  try {
    html = readFileSync(SOURCE_HTML, 'utf-8');
  } catch {
    console.error(
      `ไม่พบต้นฉบับที่ ${SOURCE_HTML}\n` +
        'บันทึกหน้าเอกสารทั้งชุด (HTML + โฟลเดอร์ _files) ลง docs/source/ ก่อน',
    );
    process.exit(1);
  }

  const text = toPlainText(html);
  const lines = text.split('\n').length;

  // A shell without its content yields a handful of lines; failing loudly here
  // is the whole point, because a silent near-empty spec.txt is what let an
  // earlier pass "scan the document" and find nothing wrong with it.
  if (lines < 500) {
    console.error(
      `ต้นฉบับแปลงได้เพียง ${lines} บรรทัด — น่าจะเป็นเปลือกที่ไม่มีเนื้อหา\n` +
        'ตรวจว่า docs/source/CTD Foundation Sprint_files/saved_resource.html คือไฟล์เนื้อหาจริง',
    );
    process.exit(1);
  }

  writeFileSync(OUTPUT, `${text}\n`, 'utf-8');
  console.log(`เขียน ${OUTPUT} · ${lines} บรรทัด`);
}

main();
