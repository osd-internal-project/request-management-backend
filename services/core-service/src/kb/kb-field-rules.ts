/**
 * CD-262 ความรู้จากงานบริการที่ปิดและปัญหาราก (part of CD-22 KBMS) — how a
 * closed job or a known error reads as an article, apart from the database.
 */

export interface JobFacts {
  requestNo: string | null;
  title: string;
  cause: string;
  resolution: string;
}

/** A draft from one or several closed jobs that share a fix. */
export function articleFromJobs(jobs: readonly JobFacts[]) {
  const refs = jobs.map((j) => j.requestNo).filter((n): n is string => !!n);
  const unique = (values: string[]) => [
    ...new Set(values.map((v) => v.trim()).filter(Boolean)),
  ];
  const symptoms = unique(jobs.map((j) => j.title));
  const causes = unique(jobs.map((j) => j.cause));
  const fixes = unique(jobs.map((j) => j.resolution));
  const body = [
    '## อาการ',
    ...symptoms.map((s) => `- ${s}`),
    '',
    '## สาเหตุ',
    ...causes.map((c) => `- ${c}`),
    '',
    '## วิธีแก้',
    ...(fixes.length === 1
      ? [fixes[0]]
      : fixes.map((f, i) => `${i + 1}. ${f}`)),
    '',
    refs.length ? `> ที่มา: ใบงานบริการ ${refs.join(', ')}` : '',
  ]
    .join('\n')
    .trim();
  return {
    title: symptoms[0] ?? 'วิธีแก้จากงานบริการ',
    body,
    sourceRef: refs.join(', ') || null,
  };
}

export const PROBLEM_KNOWN = ['known_error', 'resolved', 'closed'] as const;

const PROBLEM_STATUS: Record<string, string> = {
  known_error: 'ทราบสาเหตุแล้ว มีวิธีหลบเลี่ยง',
  resolved: 'แก้ถาวรแล้ว',
  closed: 'ปิดแล้ว',
};

export interface ProblemFacts {
  problemNo: string;
  title: string;
  status: string;
  rootCause: string | null;
  workaround: string | null;
  permanentFix: string | null;
}

/** Ready to become knowledge: known, with a workaround or a fix written. */
export function problemReady(p: ProblemFacts): boolean {
  return (
    (PROBLEM_KNOWN as readonly string[]).includes(p.status) &&
    !!(p.workaround?.trim() || p.permanentFix?.trim())
  );
}

/** The article a known error reads as. */
export function articleFromProblem(p: ProblemFacts) {
  const section = (heading: string, text: string | null) =>
    text?.trim() ? [`## ${heading}`, text.trim(), ''] : [];
  const body = [
    `> ปัญหาที่ทราบแล้ว ${p.problemNo} — ${PROBLEM_STATUS[p.status] ?? p.status}`,
    '',
    ...section('สาเหตุราก', p.rootCause),
    ...section('วิธีหลบเลี่ยง', p.workaround),
    ...section('การแก้ถาวร', p.permanentFix),
  ]
    .join('\n')
    .trim();
  return {
    title: `ปัญหาที่ทราบแล้ว: ${p.title}`,
    body,
    sourceRef: p.problemNo,
  };
}

/** Words of a job's subject worth searching on (Thai stays whole). */
export function subjectTerms(subject: string): string[] {
  return [
    ...new Set(
      subject
        .toLowerCase()
        .split(/[\s,./:;()[\]"'!?-]+/)
        .filter((w) => w.length >= 3),
    ),
  ].slice(0, 6);
}

// --- CD-263 บทเรียนปิดโครงการ ------------------------------------------------------

export interface LessonFacts {
  kind: string;
  text: string;
}

const LESSON_HEADINGS: [string, string][] = [
  ['went_well', 'สิ่งที่ทำได้ดี'],
  ['improve', 'สิ่งที่ควรปรับปรุง'],
  ['recommend', 'ข้อแนะนำสำหรับโครงการต่อไป'],
];

/** Lessons as Markdown sections, by kind, in the order the project wrote them. */
export function lessonSections(lessons: readonly LessonFacts[]): string {
  return LESSON_HEADINGS.flatMap(([kind, heading]) => {
    const rows = lessons.filter((l) => l.kind === kind && l.text.trim());
    return rows.length
      ? [`## ${heading}`, ...rows.map((l) => `- ${l.text.trim()}`), '']
      : [];
  })
    .join('\n')
    .trim();
}

/** One project's lessons as one draft. */
export function articleFromLessons(
  project: { projectNo: string; name: string },
  lessons: readonly LessonFacts[],
) {
  return {
    title: `บทเรียนจากโครงการ ${project.projectNo} · ${project.name}`,
    body: [
      `> บทเรียนปิดโครงการ ${project.projectNo} — ตัดชื่อลูกค้า ราคา และข้อมูลเฉพาะรายออกก่อนส่งตรวจ`,
      '',
      lessonSections(lessons),
    ].join('\n'),
    sourceRef: project.projectNo,
  };
}

/** Lessons written after the draft was made, added under their headings. */
export function appendLessons(
  body: string,
  lessons: readonly LessonFacts[],
): string {
  const extra = lessonSections(lessons);
  return extra ? `${body.trimEnd()}\n\n${extra}` : body;
}

// --- CD-264 คำถาม-คำตอบเทคนิค Pre-Sales ------------------------------------------

export interface QaFacts {
  question: string;
  answer: string;
}

/**
 * Answered questions as a Q&A article. Who answered and for which customer
 * are left out on purpose: the inbox keeps where it came from, the article
 * only the knowledge.
 */
export function articleFromQa(items: readonly QaFacts[]) {
  const rows = items.filter((q) => q.question.trim() && q.answer.trim());
  const body = [
    '> จากคำถาม-คำตอบเทคนิคของ Pre-Sales — ตัดชื่อลูกค้า สถานที่ และตัวเลขเฉพาะรายในคำตอบออกก่อนส่งตรวจ',
    '',
    ...(rows.length === 1
      ? [
          '## คำถาม',
          rows[0].question.trim(),
          '',
          '## คำตอบ',
          rows[0].answer.trim(),
        ]
      : rows.flatMap((q, i) => [
          `## ${i + 1}. ${q.question.trim()}`,
          q.answer.trim(),
          '',
        ])),
  ]
    .join('\n')
    .trim();
  return {
    title: rows[0]?.question.trim().slice(0, 200) ?? 'คำถาม-คำตอบเทคนิค',
    body,
  };
}

/** The first SAP item on a Solution's BOQ (equipment first). */
export function boqProductCode(boq: unknown): string | null {
  const lines = Array.isArray(boq)
    ? (boq as { kind?: string; productCode?: string }[])
    : [];
  const coded = lines.filter(
    (l) => typeof l.productCode === 'string' && l.productCode.trim(),
  );
  const first = coded.find((l) => l.kind === 'equipment') ?? coded[0];
  return first?.productCode?.trim() ?? null;
}
