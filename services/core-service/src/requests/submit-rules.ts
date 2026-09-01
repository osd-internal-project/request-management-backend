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

/**
 * The receiver's form, checked the same way the requester's is at submit.
 *
 * Separate from `assertSubmittable` because it is a different moment and a
 * different form: no documents are involved, and a type with no second form
 * asks for nothing rather than passing an empty check.
 */
export function assertReceiverFormComplete(
  schema: unknown,
  formData: Record<string, unknown>,
): void {
  if (!schema) return;

  const details = missingFields(schema, formData);
  if (!details.length) return;

  throw new AppError('REQ_FIELD_MISSING', 'กรอกฟอร์มผู้รับคำขอไม่ครบ', details);
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

/**
 * REQ-03: an attached document must name a code the type actually asks for.
 *
 * Accepting anything looks harmless until it isn't: a caller that mistypes
 * `quotation` for `QUOTE_DRAFT` gets a stored row, believes the requirement is
 * met, and then hits "เอกสารบังคับยังไม่ครบ" at submit with nothing on screen
 * explaining why. Failing at the point of attachment names the mistake while
 * the user is still looking at it.
 *
 * An absent code is fine — that is an extra file, which REQ-03 allows.
 */
export function assertKnownDocCode(
  requiredDocs: unknown,
  code: string | undefined,
): void {
  if (code === undefined) return;

  const known = Array.isArray(requiredDocs)
    ? (requiredDocs as unknown[])
        .map(asDoc)
        .filter((doc): doc is RequiredDoc => doc !== null)
        .map((doc) => doc.code)
    : [];

  if (known.includes(code)) return;

  throw new AppError('VALIDATION_FAILED', 'รหัสเอกสารไม่ถูกต้อง', [
    {
      field: 'doc_code',
      reason: known.length
        ? `ต้องเป็นหนึ่งใน: ${known.join(', ')} หรือเว้นว่างสำหรับเอกสารเพิ่มเติม`
        : 'ประเภทคำขอนี้ไม่ได้กำหนดเอกสารบังคับ',
    },
  ]);
}

/**
 * REQ-01: a form schema an admin authored must be one this system can use.
 *
 * Not a JSON Schema validator — it checks the three things the code actually
 * reads, because those are the ones whose absence produces a type that looks
 * saved and then fails at submit:
 *
 * - `properties` must exist, or the form renders empty
 * - every name in `required` must be a real property, or `assertSubmittable`
 *   demands a field the screen never shows and the request can never be sent
 * - a required document code must be unique, or the same document is asked
 *   for twice and satisfied once
 */
export function assertUsableFormSchema(
  schema: unknown,
  requiredDocs?: readonly { code: string; name: string }[],
): void {
  const parsed = asSchema(schema);
  const details: ErrorDetail[] = [];

  if (!parsed?.properties || Object.keys(parsed.properties).length === 0) {
    details.push({
      field: 'form_schema.properties',
      reason: 'ต้องมีอย่างน้อยหนึ่งฟิลด์',
    });
  }

  for (const name of parsed?.required ?? []) {
    if (!parsed?.properties?.[name]) {
      details.push({
        field: 'form_schema.required',
        reason: `"${name}" ไม่มีอยู่ใน properties`,
      });
    }
  }

  const codes = (requiredDocs ?? []).map((doc) => doc.code);
  const duplicate = codes.find((code, i) => codes.indexOf(code) !== i);

  if (duplicate) {
    details.push({
      field: 'required_docs',
      reason: `รหัสเอกสารซ้ำ: ${duplicate}`,
    });
  }

  if (!details.length) return;

  throw new AppError('VALIDATION_FAILED', 'โครงสร้างฟอร์มไม่ถูกต้อง', details);
}
