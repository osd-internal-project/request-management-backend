import { AppError, ErrorDetail } from '@request-management/share';

/** The slice of a `RequestType.formSchema` this checks. */
export interface FormSchema {
  required?: string[];
  properties?: Record<string, { title?: string; type?: string }>;
}

/** One entry of `RequestType.requiredDocs`. */
export interface RequiredDoc {
  code: string;
  name: string;
}

/**
 * REQ-03 — what stops a submit, and says which field is missing.
 *
 * "ยื่นไม่ได้" on its own sends the user hunting; §16 หน้าที่ 3 shows the form
 * naming what is absent. So every failure carries the field and its human
 * label, and **all** problems are reported together — fixing one thing only to
 * be told about the next is the slowest possible way to fill in a form.
 */
export function assertSubmittable(input: {
  formSchema: unknown;
  requiredDocs: unknown;
  formData: Record<string, unknown>;
  attachmentCodes: readonly string[];
}): void {
  const details: ErrorDetail[] = [
    ...missingFields(input.formSchema, input.formData),
    ...missingDocs(input.requiredDocs, input.attachmentCodes),
  ];

  if (!details.length) return;

  const hasDoc = details.some((detail) => detail.field === 'attachments');

  throw new AppError(
    hasDoc ? 'REQ_DOC_MISSING' : 'REQ_FIELD_MISSING',
    hasDoc ? 'เอกสารบังคับยังไม่ครบ' : 'กรอกข้อมูลบังคับไม่ครบ',
    details,
  );
}

function missingFields(
  schema: unknown,
  formData: Record<string, unknown>,
): ErrorDetail[] {
  const parsed = asSchema(schema);
  if (!parsed?.required?.length) return [];

  return parsed.required
    .filter((field) => isBlank(formData[field]))
    .map((field) => ({
      field,
      // The label from the schema, so the message names what the user sees on
      // screen rather than the storage key.
      reason: parsed.properties?.[field]?.title ?? field,
    }));
}

function missingDocs(
  requiredDocs: unknown,
  attached: readonly string[],
): ErrorDetail[] {
  if (!Array.isArray(requiredDocs)) return [];

  const present = new Set(attached);

  return (requiredDocs as unknown[])
    .map(asDoc)
    .filter((doc): doc is RequiredDoc => doc !== null && !present.has(doc.code))
    .map((doc) => ({ field: 'attachments', reason: doc.name }));
}

/** Empty string and whitespace count as missing; `0` and `false` do not. */
function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function asSchema(value: unknown): FormSchema | null {
  if (typeof value !== 'object' || value === null) return null;

  const record = value as Record<string, unknown>;
  const required = Array.isArray(record.required)
    ? (record.required as unknown[]).filter(
        (item): item is string => typeof item === 'string',
      )
    : undefined;

  const properties =
    typeof record.properties === 'object' && record.properties !== null
      ? (record.properties as FormSchema['properties'])
      : undefined;

  return { required, properties };
}

function asDoc(value: unknown): RequiredDoc | null {
  if (typeof value !== 'object' || value === null) return null;

  const record = value as Record<string, unknown>;
  if (typeof record.code !== 'string') return null;

  // `name` is what the user is told is missing, so only a real string will do —
  // coercing whatever is there risks telling them to attach "[object Object]".
  return {
    code: record.code,
    name: typeof record.name === 'string' ? record.name : record.code,
  };
}

/**
 * REQ-04: the return reason must come from the type's own list.
 *
 * Accepting an arbitrary code would defeat the purpose — the list exists so
 * bounce causes can be counted, and a free-form code is a category of one.
 */
export function assertKnownReturnReason(
  returnReasonCodes: unknown,
  code: string,
): void {
  const known = Array.isArray(returnReasonCodes)
    ? (returnReasonCodes as unknown[])
        .map(asDoc)
        .filter((reason): reason is RequiredDoc => reason !== null)
        .map((reason) => reason.code)
    : [];

  if (known.includes(code)) return;

  throw new AppError('VALIDATION_FAILED', 'เหตุผลการตีกลับไม่ถูกต้อง', [
    { field: 'reason_code', reason: `ต้องเป็นหนึ่งใน: ${known.join(', ')}` },
  ]);
}
