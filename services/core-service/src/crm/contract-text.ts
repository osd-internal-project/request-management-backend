import type PdfParse from 'pdf-parse';

/**
 * The library entry, not the package index: `pdf-parse`'s index runs a
 * self-test that reads a sample file when it is the main module.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse/lib/pdf-parse.js') as typeof PdfParse;

/** Enough for any contract; a larger text is almost certainly not one. */
const MAX_TEXT = 1_000_000;
/** A malformed PDF must not hold an upload open. */
const TIMEOUT_MS = 20_000;

export type TextStatus = 'extracted' | 'empty' | 'failed' | 'not_pdf';

/**
 * CD-161 — the searchable text of an uploaded contract file. Only PDFs are
 * read; a PDF with no text layer (a scan) is `empty` — there is no OCR.
 * Whitespace is collapsed so a search matches across line breaks.
 */
export async function extractContractText(
  buffer: Buffer,
  mimeType: string,
): Promise<{ status: TextStatus; text: string | null }> {
  if (mimeType !== 'application/pdf') return { status: 'not_pdf', text: null };
  try {
    const parsed = await Promise.race([
      pdfParse(buffer),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS).unref(),
      ),
    ]);
    const text = normalizeText(parsed.text);
    return text
      ? { status: 'extracted', text: text.slice(0, MAX_TEXT) }
      : { status: 'empty', text: null };
  } catch {
    return { status: 'failed', text: null };
  }
}

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
