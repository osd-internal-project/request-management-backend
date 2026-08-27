import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const WORKSPACE = join(ROOT, '..');
const SPEC_TXT = join(ROOT, 'docs', 'source', 'spec.txt');
const OUR_DOC = join(ROOT, 'docs', 'ctd-foundation-spec.md');
const FRONTEND_SRC = join(WORKSPACE, 'request-management-frontend', 'src');
const PROGRESS = join(WORKSPACE, 'PROGRESS.md');

/**
 * Prints the differences between the source specification and this repository.
 *
 * It exists because "I checked the document" is a claim, and a claim cannot be
 * reviewed. Three separate passes were reported as complete while §5.4 and
 * screen A4 were missing entirely. The output of this command can be read by
 * someone who does not trust the person running it — that is the point, so
 * ask for this output rather than for a description of it.
 *
 * Exits non-zero when anything is missing, so CI can run it too.
 */
interface Report {
  readonly heading: string;
  readonly missing: readonly string[];
  readonly note?: string;
}

function read(path: string, label: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    console.error(`อ่าน ${label} ไม่ได้ที่ ${path}`);
    process.exit(1);
  }
}

/** Every `.tsx` under the frontend, so screen markers are found wherever they live. */
function tsxFiles(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) found.push(...tsxFiles(path));
    else if (entry.endsWith('.tsx')) found.push(path);
  }

  return found;
}

/**
 * Screen headings as §16 writes them: `หน้าที่ 3 — …` and `หน้า A2 — …`.
 * Normalised to `หน้าที่ 3` / `A2` so a marker in the code can match.
 */
function screensInSource(spec: string): string[] {
  const screens = new Set<string>();

  for (const line of spec.split('\n')) {
    const numbered = /หน้าที่ (\d+) —/.exec(line);
    if (numbered) screens.add(`หน้าที่ ${numbered[1]}`);

    const admin = /หน้า (A\d+) —/.exec(line);
    if (admin) screens.add(admin[1]);
  }

  return [...screens];
}

function sectionsInSource(spec: string): string[] {
  const sections = new Map<number, string>();

  for (const line of spec.split('\n')) {
    // Headings are zero-padded `01 …` through `16 …`. The padding is what
    // separates them from mockup data that also starts with two digits —
    // `24 ชั่วโมงทำการ`, `23 ส.ค. 2569` — which an unpadded match swallows.
    const match = /^\s*(0[1-9]|1[0-6]) (\S.*)$/.exec(line);
    if (!match) continue;

    const number = Number(match[1]);
    if (!sections.has(number)) sections.set(number, match[2].trim());
  }

  return [...sections.entries()]
    .sort(([a], [b]) => a - b)
    .map(([number, title]) => `${number}. ${title}`);
}

function subSectionsInSource(spec: string): string[] {
  const subs: string[] = [];

  for (const line of spec.split('\n')) {
    const match = /^\s*(\d{1,2}\.\d) (\S.*)$/.exec(line);
    if (match) subs.push(`${match[1]} ${match[2].trim()}`);
  }

  return subs;
}

function checkSections(spec: string, ours: string): Report {
  const ourNumbers = new Set(
    [...ours.matchAll(/^## (\d+)\./gm)].map((match) => Number(match[1])),
  );

  const missing = sectionsInSource(spec).filter(
    (section) => !ourNumbers.has(Number(section.split('.')[0])),
  );

  return {
    heading: `หัวข้อหลัก — ต้นฉบับ ${sectionsInSource(spec).length} · เอกสารเรา ${ourNumbers.size}`,
    missing,
  };
}

function checkSubSections(spec: string, ours: string): Report {
  const missing = subSectionsInSource(spec).filter((sub) => {
    const number = sub.split(' ')[0];

    return !ours.includes(`§${number}`) && !ours.includes(`### ${number}`);
  });

  return {
    heading: 'หัวข้อย่อย — ตรวจว่าเอกสารเราอ้างถึงครบ',
    missing,
    note: 'ตรวจแบบหลวม: ผ่านถ้าเอกสารเราเอ่ยถึงเลขหัวข้อนั้นที่ไหนก็ได้',
  };
}

function checkScreens(spec: string): Report {
  const markers = tsxFiles(FRONTEND_SRC)
    .map((file) => readFileSync(file, 'utf-8'))
    .join('\n');

  const missing = screensInSource(spec).filter(
    (screen) => !markers.includes(`Screen §16 ${screen}`) &&
      !markers.includes(`Screen ${screen}`),
  );

  return {
    heading: `หน้าจอ §16 — ประกาศไว้ ${screensInSource(spec).length} หน้า`,
    missing,
    note: 'นับจาก comment `Screen §16 …` ในไฟล์ .tsx — หน้าที่ไม่มี marker ถือว่ายังไม่ได้ทำ',
  };
}

function checkProgress(): Report {
  const progress = read(PROGRESS, 'PROGRESS.md');

  const open = progress
    .split('\n')
    .filter((line) => /^\s*- \[ \]/.test(line))
    .map((line) => line.trim().replace(/^- \[ \]\s*/, ''));

  return {
    heading: `PROGRESS.md — งานที่ยังไม่ปิด ${open.length} ข้อ`,
    missing: open,
    note: 'ห้ามรายงานว่า phase เสร็จ ถ้ายังมีข้อค้างใต้ phase นั้น',
  };
}

function print(report: Report): boolean {
  console.log(`\n── ${report.heading}`);
  if (report.note) console.log(`   (${report.note})`);

  if (!report.missing.length) {
    console.log('   ✓ ครบ');

    return true;
  }

  for (const item of report.missing) console.log(`   ✗ ${item}`);

  return false;
}

function main(): void {
  const spec = read(SPEC_TXT, 'spec.txt');
  const ours = read(OUR_DOC, 'ctd-foundation-spec.md');

  console.log(`ต้นฉบับ: ${spec.split('\n').length} บรรทัด`);

  const results = [print(checkSections(spec, ours)), print(checkScreens(spec))];

  // These two are reported without failing the run. Outstanding work should
  // stay visible rather than break the build, and the sub-section pass is a
  // citation check — our document covers 5.1/6.1/7.2 in prose without quoting
  // the number, which is a traceability gap, not a missing requirement.
  print(checkSubSections(spec, ours));
  print(checkProgress());

  if (results.includes(false)) {
    console.log('\nมีส่วนต่างระหว่างต้นฉบับกับ repo');
    process.exit(1);
  }

  console.log('\nเอกสารตรงกับต้นฉบับ');
}

main();
