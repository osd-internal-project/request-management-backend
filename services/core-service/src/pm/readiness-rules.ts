/**
 * CD-225 ตรวจความพร้อมก่อนส่งมอบ — the rules, apart from the database: the
 * checks the system makes itself, a line's own problems, and when the
 * project is ready to ask for acceptance.
 */

export const READINESS_RESULTS = ['pass', 'fail'] as const;
export const MAX_READINESS_TEXT = 1000;
export const MAX_READINESS_ITEMS = 100;

export const DEFAULT_READINESS_CHECKLIST = [
  'หน้างานสะอาดเรียบร้อย',
  'ติดป้ายและฉลากอุปกรณ์ครบ',
  'อบรมผู้ใช้งานแล้ว',
  'สำรองค่าตั้งค่าระบบแล้ว',
];

export interface SystemCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string | null;
}

/** What the system checks itself — nobody ticks these. */
export function systemChecks(facts: {
  tests: { complete: boolean; total: number; passed: number };
  issuesOpen: number;
  /** CD-226 — the as-built: documents and settled deviations. */
  asBuilt: { complete: boolean; missing: number };
  /** CD-222 — UAT blockers not yet confirmed fixed by the customer. */
  uatBlocking: readonly string[];
  /** CD-215 — software projects only; null for the rest. */
  softwareDocs?: {
    complete: boolean;
    version: string | null;
    missing: number;
  } | null;
  /** CD-251 — the next phase's delivery documents; null with no trip yet. */
  deliveryDocs?: {
    complete: boolean;
    milestone: string;
    missing: readonly string[];
    /** CD-254 — its installation confirmed complete by the manager. */
    installed?: boolean;
  } | null;
}): SystemCheck[] {
  const softwareDocs = facts.softwareDocs;
  const deliveryDocs = facts.deliveryDocs;
  return [
    {
      key: 'tests',
      label: 'ทดสอบผ่านครบทุกข้อตามขอบเขตงาน',
      ok: facts.tests.complete,
      detail: facts.tests.complete
        ? null
        : facts.tests.total
          ? `ผ่าน ${facts.tests.passed}/${facts.tests.total}`
          : 'ยังไม่มีข้อทดสอบ',
    },
    {
      key: 'issues',
      label: 'ไม่มีปัญหาเปิดค้าง',
      ok: facts.issuesOpen === 0,
      detail: facts.issuesOpen ? `ค้าง ${facts.issuesOpen} ข้อ` : null,
    },
    {
      key: 'as_built',
      label: 'เอกสารสภาพจริง (As-built) ครบ',
      ok: facts.asBuilt.complete,
      detail: facts.asBuilt.complete
        ? null
        : `ค้าง ${facts.asBuilt.missing} รายการ`,
    },
    {
      key: 'uat',
      label: 'ประเด็น UAT ที่ปิดกั้นการใช้งานแก้และลูกค้ายืนยันครบ',
      ok: facts.uatBlocking.length === 0,
      detail: facts.uatBlocking.length ? facts.uatBlocking.join(', ') : null,
    },
    ...(softwareDocs
      ? [
          {
            key: 'software_docs',
            label: 'เอกสารซอฟต์แวร์ครบตามเวอร์ชันที่ส่งมอบ',
            ok: softwareDocs.complete,
            detail: softwareDocs.complete
              ? null
              : softwareDocs.version
                ? `เวอร์ชัน ${softwareDocs.version} ค้าง ${softwareDocs.missing} รายการ`
                : 'ยังไม่มีเวอร์ชันที่ส่งมอบ',
          },
        ]
      : []),
    ...(deliveryDocs
      ? [
          {
            key: 'delivery_docs',
            label: `เอกสารส่งมอบของเฟส "${deliveryDocs.milestone}" ครบ`,
            ok: deliveryDocs.complete,
            detail: deliveryDocs.complete
              ? null
              : `ขาด ${deliveryDocs.missing.join(', ')}`,
          },
          ...(deliveryDocs.installed === undefined
            ? []
            : [
                {
                  key: 'install_confirmed',
                  label: `ยืนยันงานติดตั้งของเฟส "${deliveryDocs.milestone}" เสร็จแล้ว`,
                  ok: deliveryDocs.installed,
                  detail: deliveryDocs.installed
                    ? null
                    : 'ผู้จัดการโครงการยังไม่ได้ยืนยัน',
                },
              ]),
        ]
      : []),
  ];
}

/** Template lines, blank and repeated ones dropped, in their order. */
export function fromChecklist(lines: readonly string[]): string[] {
  return [...new Set(lines.map((line) => line.trim()).filter(Boolean))];
}

/** A check's own problems, in Thai. */
export function checkProblems(input: {
  result: string;
  checkedOn: string | null;
  note: string;
  today: string;
}): string[] {
  const problems: string[] = [];
  if (!(READINESS_RESULTS as readonly string[]).includes(input.result)) {
    problems.push('ผลตรวจต้องเป็นผ่านหรือไม่ผ่าน');
  }
  if (!input.checkedOn) problems.push('ต้องระบุวันที่ตรวจ');
  if (input.checkedOn && input.checkedOn > input.today) {
    problems.push('วันที่ตรวจต้องไม่เกินวันนี้');
  }
  if (input.result === 'fail' && !input.note.trim()) {
    problems.push('ไม่ผ่าน: ต้องบอกว่าไม่พร้อมอย่างไร');
  }
  return problems;
}

export interface Readiness {
  /** Lines passed / all lines. */
  passed: number;
  total: number;
  failed: number;
  unchecked: number;
  /** Every line passed and every system check holds. */
  ready: boolean;
  /** What stands in the way, in Thai. */
  blockers: string[];
}

export function readiness(
  lines: readonly { text: string; result: string | null }[],
  checks: readonly SystemCheck[],
): Readiness {
  const passed = lines.filter((line) => line.result === 'pass').length;
  const failed = lines.filter((line) => line.result === 'fail').length;
  const unchecked = lines.length - passed - failed;
  const blockers = [
    ...checks
      .filter((check) => !check.ok)
      .map((check) =>
        check.detail ? `${check.label}: ${check.detail}` : check.label,
      ),
    ...lines
      .filter((line) => line.result !== 'pass')
      .map(
        (line) =>
          `${line.result === 'fail' ? 'ไม่ผ่าน' : 'ยังไม่ตรวจ'}: ${line.text}`,
      ),
  ];
  return {
    passed,
    total: lines.length,
    failed,
    unchecked,
    ready: blockers.length === 0,
    blockers,
  };
}
