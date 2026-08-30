/**
 * Reads the JSON that `scripts/extract-request-log.py` writes.
 *
 * The importers never open the `.xlsx`. Two reasons: this repo has no xlsx
 * library and adding one is a decision for a person to make, and the extracted
 * JSON is committed — so a git diff answers "did the source data change between
 * these two import runs", which a binary workbook cannot.
 *
 * See `docs/REQUEST_RAW_STRUCTURE.md` for what each sheet and column holds.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** One spreadsheet row. Keys are column letters, exactly as in Excel. */
export interface Row {
  /** The row number in the original sheet — import reports quote it. */
  readonly row: number;
  readonly cells: Record<string, string | number | boolean>;
  /** Columns that held a formula; the field dictionary marks these `(derived)`. */
  readonly formulas?: readonly string[];
  /** Columns whose value is an Excel date serial, resolved to `YYYY-MM-DD`. */
  readonly dates?: Record<string, string>;
}

export type Sheets = Record<string, Row[]>;

const EXTRACT_DIR = resolve(__dirname, '../../../source/extracted');

/**
 * Every sheet of one extracted workbook, keyed by sheet name.
 *
 * With no argument it picks the only workbook present, and refuses rather than
 * guessing when there is more than one — the source is meant to grow to twelve
 * departmental files, and silently importing whichever sorted first would be a
 * silent wrong answer.
 */
export function loadSheets(book?: string): Sheets {
  if (!existsSync(EXTRACT_DIR)) {
    throw new Error(
      `ไม่พบ ${EXTRACT_DIR}\n` +
        'รัน `python3 scripts/extract-request-log.py` ก่อน',
    );
  }

  const books = readdirSync(EXTRACT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  if (!books.length) {
    throw new Error(
      `ไม่มีข้อมูลใน ${EXTRACT_DIR} — รัน \`python3 scripts/extract-request-log.py\` ก่อน`,
    );
  }

  const chosen = book ?? (books.length === 1 ? books[0] : null);
  if (!chosen) {
    throw new Error(
      `มีหลายไฟล์ใน ${EXTRACT_DIR} (${books.join(', ')}) — ` +
        'ระบุชื่อไฟล์ที่ต้องการนำเข้าเป็นอาร์กิวเมนต์',
    );
  }

  const dir = join(EXTRACT_DIR, chosen);
  const sheets: Sheets = {};

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json') || file === '_index.json') continue;
    sheets[file.replace(/\.json$/, '')] = JSON.parse(
      readFileSync(join(dir, file), 'utf-8'),
    ) as Row[];
  }

  return sheets;
}

/** A cell as trimmed text; `''` when the cell is empty. */
export function text(row: Row, column: string): string {
  const value = row.cells[column];
  return value === undefined ? '' : String(value).trim();
}

/** A cell as a number; `null` when empty or not numeric. */
export function number(row: Row, column: string): number | null {
  const value = row.cells[column];
  if (value === undefined || value === '') return null;

  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** A cell as a date; `null` unless the extractor resolved it to a real date. */
export function date(row: Row, column: string): Date | null {
  const iso = row.dates?.[column];
  return iso ? new Date(`${iso}T00:00:00Z`) : null;
}

/**
 * The code half of a `รหัส · ชื่อ` dropdown value (validation rule ⑮).
 *
 * Returns the whole trimmed string when there is no separator, because two
 * cells in the source hold a plain name instead — the caller has to decide
 * what to do about that, and hiding it here would take the choice away.
 */
export function codePart(value: string): string {
  const [code] = value.split(' · ');
  return code.trim();
}
