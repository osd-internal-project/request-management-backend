import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const WORKSPACE = join(ROOT, '..');
const SPEC_TXT = join(ROOT, 'docs', 'source', 'spec.txt');
const OUR_DOC = join(ROOT, 'docs', 'ctd-foundation-spec.md');
const CHECKLIST = join(ROOT, 'docs', 'screen-checklist.json');
const SCHEMA = join(ROOT, 'libs', 'prisma', 'schema.prisma');
const SEED = join(ROOT, 'libs', 'prisma', 'seed.ts');
const CATALOG = join(ROOT, 'libs', 'share', 'src', 'errors', 'app-error.ts');
const SERVICES = join(ROOT, 'services');
const LIBS = join(ROOT, 'libs');
const FRONTEND_SRC = join(WORKSPACE, 'request-management-frontend', 'src');
const REPORT = join(ROOT, 'docs', 'spec-coverage.md');

/**
 * Reports where the source specification and this repository disagree.
 *
 * It exists because "I checked the document" is a claim, and a claim cannot be
 * reviewed. Three separate passes reported the document as covered while §5.4
 * and screen A4 were missing entirely; a fourth reported A1 and A2 complete
 * while both were half-built, because the only screen check was whether a
 * marker comment existed.
 *
 * So every check that was once done by hand lives here instead. Ask for this
 * output rather than for a description of it — a description is not evidence.
 *
 * Writes `docs/spec-coverage.md` as well, so the state is visible without
 * running anything. Exits non-zero on any gap.
 */
interface Report {
  readonly heading: string;
  readonly missing: readonly string[];
  readonly note?: string;
  /** Advisory reports print but do not fail the run. */
  readonly advisory?: boolean;
}

interface ScreenSpec {
  readonly title: string;
  readonly note?: string;
  readonly ui?: readonly string[];
  readonly seed?: readonly string[];
  readonly sample?: readonly string[];
}

function read(path: string, label: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    console.error(`อ่าน ${label} ไม่ได้ที่ ${path}`);
    process.exit(1);
  }
}

function filesUnder(dir: string, match: (name: string) => boolean): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') {
      continue;
    }

    const path = join(dir, entry);

    if (statSync(path).isDirectory()) found.push(...filesUnder(path, match));
    else if (match(entry)) found.push(path);
  }

  return found;
}

function concat(files: readonly string[]): string {
  return files.map((file) => readFileSync(file, 'utf-8')).join('\n');
}

/**
 * Source with comments removed.
 *
 * A screen check must look at what the page renders, not at what the code says
 * about itself. Comments quote the mockup constantly — `as §16 writes it:
 * \`100,001 – 1,000,000\`` — which made sample data look leaked and would let a
 * required phrase "pass" while appearing only in a JSDoc block.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// --- pass 1: top-level sections -------------------------------------------

function sectionsInSource(spec: string): string[] {
  const sections = new Map<number, string>();

  for (const line of spec.split('\n')) {
    // Headings are zero-padded `01` … `16`. The padding is what separates them
    // from mockup data that also starts with two digits — `24 ชั่วโมงทำการ`,
    // `23 ส.ค. 2569` — which an unpadded match swallows.
    const match = /^\s*(0[1-9]|1[0-6]) (\S.*)$/.exec(line);
    if (!match) continue;

    const number = Number(match[1]);
    if (!sections.has(number)) sections.set(number, match[2].trim());
  }

  return [...sections.entries()]
    .sort(([a], [b]) => a - b)
    .map(([number, title]) => `${number}. ${title}`);
}

function checkSections(spec: string, ours: string): Report {
  const ourNumbers = new Set(
    [...ours.matchAll(/^## (\d+)\./gm)].map((match) => Number(match[1])),
  );
  const sections = sectionsInSource(spec);

  return {
    heading: `หัวข้อหลัก — ต้นฉบับ ${sections.length} · เอกสารเรา ${ourNumbers.size}`,
    missing: sections.filter(
      (section) => !ourNumbers.has(Number(section.split('.')[0])),
    ),
  };
}

// --- pass 2 & 3: requirement codes ----------------------------------------

/** Codes sit on a line of their own in the extracted text. */
function requirementCodes(spec: string): string[] {
  const codes = new Set<string>();

  for (const line of spec.split('\n')) {
    const match = /^\s*((?:AUTH|ROLE|SCOPE|REQ|APV|SUP|NFR)-\d{2})\s*$/.exec(
      line,
    );
    if (match) codes.add(match[1]);
  }

  return [...codes].sort();
}

function checkRequirementsDocumented(spec: string, ours: string): Report {
  const codes = requirementCodes(spec);

  return {
    heading: `ข้อกำหนด ${codes.length} ข้อ — อยู่ในเอกสารเรา`,
    missing: codes.filter((code) => !ours.includes(code)),
  };
}

function checkRequirementsTested(spec: string): Report {
  const codes = requirementCodes(spec);
  const tests = concat([
    ...filesUnder(SERVICES, (name) => name.endsWith('.spec.ts')),
    ...filesUnder(LIBS, (name) => name.endsWith('.spec.ts')),
  ]);

  const untested = codes.filter((code) => !tests.includes(code));

  return {
    heading: `ข้อกำหนด ${codes.length} ข้อ — ผูกกับ test แล้ว ${codes.length - untested.length}`,
    missing: untested,
    note: '§14 — ทุกรหัสควรมี test ที่เอ่ยชื่อรหัสนั้น',
    // Advisory: naming a code in a test title is a documentation habit, and
    // failing the build on it today would block every unrelated change.
    advisory: true,
  };
}

// --- pass 4: §10 entities --------------------------------------------------

const SPEC_ENTITIES = `company user user_company org_unit org_closure role permission
role_permission user_role keycloak_role_mapping scope_rule sensitive_field_rule
request_type request request_attachment request_return_reason request_event
doc_number_config doc_number_counter approval_matrix approval_case approval_step
delegation sla_config sla_clock holiday_calendar notification
notification_delivery_log audit_log`
  .split(/\s+/)
  .filter(Boolean);

function checkEntities(): Report {
  const schema = read(SCHEMA, 'schema.prisma');
  const models = new Set(
    [...schema.matchAll(/^model\s+(\w+)/gm)].map(([, name]) =>
      name.replace(/(?<!^)(?=[A-Z])/g, '_').toLowerCase(),
    ),
  );

  return {
    heading: `§10 entity ${SPEC_ENTITIES.length} ตัว — schema มี ${models.size} model`,
    missing: SPEC_ENTITIES.filter((entity) => !models.has(entity)),
  };
}

// --- pass 5: §7.1 statuses -------------------------------------------------

const SPEC_STATUSES = [
  'draft',
  'submitted',
  'returned',
  'pending_approval',
  'approved',
  'rejected',
  'in_progress',
  'completed',
  'cancelled',
];

function checkStatuses(): Report {
  const schema = read(SCHEMA, 'schema.prisma');
  const block = /enum RequestStatus \{([\s\S]*?)\}/.exec(schema)?.[1] ?? '';

  return {
    heading: `§7.1 สถานะ ${SPEC_STATUSES.length} ตัว`,
    missing: SPEC_STATUSES.filter(
      (status) => !new RegExp(`\\b${status}\\b`).test(block),
    ),
  };
}

// --- pass 6: §11.9 error codes --------------------------------------------

function checkErrorCodes(spec: string): Report {
  const section = spec.slice(spec.indexOf('11.9'), spec.indexOf('\n 12 '));
  const declared = new Set(
    [...read(CATALOG, 'app-error.ts').matchAll(/^\s+([A-Z][A-Z_]{5,}):/gm)].map(
      ([, code]) => code,
    ),
  );

  const inSpec = [
    ...new Set([...section.matchAll(/\b([A-Z][A-Z_]{6,})\b/g)].map(([, c]) => c)),
  ].sort();

  return {
    heading: `§11.9 error code ${inSpec.length} ตัว`,
    missing: inSpec.filter((code) => !declared.has(code)),
  };
}

// --- pass 7: §11 endpoints -------------------------------------------------

function checkEndpoints(spec: string, ours: string): Report {
  const paths = [
    ...new Set(
      [...spec.matchAll(/(?:GET|POST|PATCH|PUT|DELETE) (\/[a-z0-9{}/_-]+)/g)].map(
        ([, path]) => path,
      ),
    ),
  ].sort();

  // Compared against our own §11 write-up rather than the controllers: the
  // controllers split paths across a `@Controller` prefix and a method
  // decorator, so the full path never appears as one string in the source.
  //
  // Compared verbatim, `{id}` included — our document writes them the same
  // way. Stripping the braces produced `/requests//submit`, which matched
  // nothing and reported 13 healthy endpoints as missing.
  return {
    heading: `§11 endpoint ${paths.length} เส้น — อยู่ในเอกสารเรา`,
    missing: paths.filter((path) => !ours.includes(path)),
  };
}

// --- pass 8: §16 screens ---------------------------------------------------

function checkScreens(): {
  readonly reports: readonly Report[];
  readonly rows: readonly string[];
} {
  const checklist = JSON.parse(read(CHECKLIST, 'screen-checklist.json')) as
    Record<string, ScreenSpec | unknown>;

  const ui = withoutComments(
    concat(
      filesUnder(
        FRONTEND_SRC,
        (name) => name.endsWith('.tsx') || name.endsWith('.ts'),
      ),
    ),
  );
  const seed = read(SEED, 'seed.ts');

  const reports: Report[] = [];
  const rows: string[] = [];

  for (const [key, value] of Object.entries(checklist)) {
    if (key.startsWith('$')) continue;

    const screen = value as ScreenSpec;
    const missing: string[] = [];

    for (const phrase of screen.ui ?? []) {
      if (!ui.includes(phrase)) missing.push(`ui: ${phrase}`);
    }

    for (const phrase of screen.seed ?? []) {
      if (!seed.includes(phrase)) missing.push(`seed: ${phrase}`);
    }

    // Sample data must be absent. A mockup name appearing in the source means
    // filler was copied in as if it were a feature.
    for (const phrase of screen.sample ?? []) {
      if (ui.includes(phrase)) missing.push(`sample leaked into code: ${phrase}`);
    }

    const total = (screen.ui?.length ?? 0) + (screen.seed?.length ?? 0);

    reports.push({
      heading: `${screen.title} — ${total - missing.length}/${total}`,
      missing,
      note: screen.note,
      advisory: Boolean(screen.note),
    });

    rows.push(
      `| ${screen.title} | ${total - missing.length}/${total} | ${
        missing.length ? missing.slice(0, 3).join(' · ') : '—'
      } |`,
    );
  }

  return { reports, rows };
}

// --- output ----------------------------------------------------------------

function print(report: Report): boolean {
  console.log(`\n── ${report.heading}`);
  if (report.note) console.log(`   (${report.note})`);

  if (!report.missing.length) {
    console.log('   ✓ ครบ');

    return true;
  }

  for (const item of report.missing) console.log(`   ✗ ${item}`);

  return Boolean(report.advisory);
}

function writeReport(reports: readonly Report[], screenRows: readonly string[]): void {
  const lines = [
    '# Specification coverage',
    '',
    '> **Generated by `yarn spec:check` — do not edit by hand.**',
    '> Editing this file would recreate the problem it exists to solve: a',
    '> document claiming coverage that nothing verifies. CI regenerates it and',
    '> fails if the result differs from what was committed.',
    '',
    '## Screens (§16)',
    '',
    '| Screen | Covered | Missing |',
    '|---|---|---|',
    ...screenRows,
    '',
    '## Everything else',
    '',
    '| Check | Result |',
    '|---|---|',
    ...reports.map(
      (report) =>
        `| ${report.heading} | ${
          report.missing.length ? `✗ ${report.missing.length}` : '✓'
        } |`,
    ),
    '',
  ];

  for (const report of reports) {
    if (!report.missing.length) continue;

    lines.push(`### ${report.heading}`, '');
    for (const item of report.missing) lines.push(`- ${item}`);
    lines.push('');
  }

  writeFileSync(REPORT, lines.join('\n'), 'utf-8');
}

/**
 * Every top-level path a service serves, from its own decorators.
 *
 * A controller's `@Controller('x')` prefix plus each method's route, reduced to
 * the first one or two segments — which is the granularity the frontend routes
 * on. `@Controller()` with no prefix means the route path stands alone.
 *
 * The route string is optional: `@Get()` on a prefixed controller serves the
 * prefix itself, and dropping those hid four whole prefixes from this list.
 */
function servicePaths(service: string): string[] {
  // `.controllers.ts` too: `crm/sales.controllers.ts` holds three of them, and
  // matching the singular alone dropped every route it declares.
  const files = filesUnder(
    join(SERVICES, service, 'src'),
    (name) =>
      (name.endsWith('.controller.ts') || name.endsWith('.controllers.ts')) &&
      !name.endsWith('.spec.ts'),
  );

  const paths = new Set<string>();

  for (const file of files) {
    const source = withoutComments(readFileSync(file, 'utf-8'));

    // Controllers appear in declaration order, and every route below one
    // belongs to it until the next `@Controller` — the same order the file
    // reads in.
    for (const block of source.split('@Controller(').slice(1)) {
      const prefix = /^'([^']*)'/.exec(block)?.[1] ?? '';

      for (const route of block.matchAll(
        /@(?:Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?/g,
      )) {
        const full = [prefix, route[1] ?? ''].filter(Boolean).join('/');
        const segments = full
          .split('/')
          .filter((part) => part && !part.startsWith(':'));
        if (!segments.length) continue;

        paths.add(
          '/' + (segments[0] === 'admin' ? segments.slice(0, 2) : [segments[0]]).join('/'),
        );
      }
    }
  }

  return [...paths].sort();
}

/**
 * The BFF sends a path to whichever service owns it, from a list held in the
 * frontend. Both directions are wrong in their own way, so both are checked.
 *
 * A path missing from the list is sent to user-service, which answers 404 — a
 * well-formed request to an endpoint that exists, just not there, which is the
 * hardest kind of 404 to read. `/admin/holiday-calendars` was missing for a
 * week for exactly that reason.
 *
 * A prefix left in the list after its routes moved is the same failure delayed:
 * it stops matching nothing and starts shadowing whatever is added under that
 * name next. `/external` and `/integrations` sat there after external-service
 * took the outward-facing API, and the one-way check could not see them.
 */
function checkServiceRouting(): Report {
  const table = read(
    join(FRONTEND_SRC, 'lib', 'backend.ts'),
    'frontend backend.ts',
  );
  const external = servicePaths('external-service');

  const core = routingGap(
    'core-service',
    'CORE_SERVICE_PREFIXES',
    table,
    external,
  );
  const runNumber = routingGap(
    'run-number-service',
    'RUN_NUMBER_SERVICE_PREFIXES',
    table,
    external,
  );

  return {
    heading: `เส้นทาง ${core.count + runNumber.count} กลุ่ม — frontend ส่งถูก service`,
    missing: [...core.missing, ...runNumber.missing],
    note: '*_SERVICE_PREFIXES ใน request-management-frontend/src/lib/backend.ts',
  };
}

/**
 * ส่วนต่างของ service หนึ่งตัวกับ prefix list ที่ frontend ถือไว้ ทั้งสองทาง.
 * `/health` และ `/internal` ไม่ผ่าน BFF จึงไม่นับ.
 */
function routingGap(
  service: string,
  constant: string,
  table: string,
  external: string[],
): { count: number; missing: string[] } {
  const declared = servicePaths(service).filter(
    (path) => path !== '/health' && !path.startsWith('/internal'),
  );

  const listed = [
    ...(new RegExp(`${constant} = \\[([^\\]]*)\\]`).exec(table)?.[1] ?? '').matchAll(
      /'([^']*)'|"([^"]*)"/g,
    ),
  ].map((match) => match[1] ?? match[2]);

  const unlisted = declared
    .filter((path) => !listed.some((prefix) => path.startsWith(prefix)))
    .map((path) => `${path} (${service}) → ถูกส่งไป user-service`);

  // external-service is named in the message rather than accepted, because a
  // prefix that moved there does not belong in this list either — outside
  // callers reach it directly, never through the BFF.
  const stale = listed
    .filter((prefix) => !declared.some((path) => path.startsWith(prefix)))
    .map((prefix) =>
      external.some((path) => path.startsWith(prefix))
        ? `${prefix} → ย้ายไป external-service แล้ว ลบออกจาก ${constant}`
        : `${prefix} → ไม่มี service ไหนเสิร์ฟแล้ว ลบออกจาก ${constant}`,
    );

  return { count: declared.length, missing: [...unlisted, ...stale] };
}

function main(): void {
  const spec = read(SPEC_TXT, 'spec.txt');
  const ours = read(OUR_DOC, 'ctd-foundation-spec.md');

  console.log(`ต้นฉบับ: ${spec.split('\n').length} บรรทัด`);

  const screens = checkScreens();

  const reports: Report[] = [
    checkSections(spec, ours),
    checkRequirementsDocumented(spec, ours),
    checkEntities(),
    checkStatuses(),
    checkErrorCodes(spec),
    checkEndpoints(spec, ours),
    checkServiceRouting(),
    ...screens.reports,
    checkRequirementsTested(spec),
  ];

  const passed = reports.map(print);

  writeReport(reports, screens.rows);
  console.log(`\nเขียน ${REPORT}`);

  if (passed.includes(false)) {
    console.log('\nมีส่วนต่างระหว่างต้นฉบับกับ repo');
    process.exit(1);
  }

  console.log('\nตรงกับต้นฉบับ');
}

main();
