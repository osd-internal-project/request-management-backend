import { AppError, ErrorDetail } from '@request-management/share';

/** The slice of a `RequestType.formSchema` this checks. */
export interface FormSchema {
  required?: string[];
  properties?: Record<string, FormSchemaProperty>;
}

/**
 * One field of a form.
 *
 * `type: 'array'` is a table: `items` carries the columns as a schema of its
 * own and `maxItems` caps how many rows the person filling it in may add.
 * Plain JSON Schema vocabulary, like every other key here — the system's own
 * concerns are the ones spelled `x-`.
 */
export interface FormSchemaProperty {
  title?: string;
  type?: string;
  items?: FormSchema;
  maxItems?: number;
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
  /** The type's `refRequired`, and the reference the requester gave. */
  refRequired?: boolean;
  refId?: string | null;
}): void {
  const details: ErrorDetail[] = [
    ...missingFields(input.formSchema, input.formData),
    /*
      `อ้างอิงดีล` is not part of `formSchema` — it is a column on the request —
      so no schema rule reaches it and the check has to be here. It lived only
      in the submit screen until 1 ก.ย. 2569, which made it a rule anybody
      calling the API could skip (ROLE-01: the screen is convenience, never
      control).
    */
    ...(input.refRequired && isBlank(input.refId)
      ? [{ field: 'ref_id', reason: 'อ้างอิงดีล' }]
      : []),
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
  if (!parsed) return [];

  const missing = (parsed.required ?? [])
    .filter((field) => isBlank(formData[field]))
    .map((field) => ({
      field,
      // The label from the schema, so the message names what the user sees on
      // screen rather than the storage key.
      reason: parsed.properties?.[field]?.title ?? field,
    }));

  return [...missing, ...tableProblems(parsed, formData)];
}

/**
 * What is wrong inside the tables — row by row, column by column.
 *
 * Reported as `lines[2].qty` rather than as one failure on `lines`, for the
 * same reason `assertSubmittable` reports every field at once: a table can be
 * long, and "lines ไม่ครบ" leaves the person filling it in to hunt for the row.
 *
 * A table that is not required and was left empty is not a problem — the empty
 * case is already covered by `required` above.
 */
function tableProblems(
  parsed: FormSchema,
  formData: Record<string, unknown>,
): ErrorDetail[] {
  const details: ErrorDetail[] = [];

  for (const [name, property] of Object.entries(parsed.properties ?? {})) {
    const columns = tableOf(property);
    if (!columns) continue;

    const rows = rowsOf(formData[name]);
    if (!rows) continue;

    if (property.maxItems !== undefined && rows.length > property.maxItems) {
      details.push({
        field: name,
        reason: `เกิน ${property.maxItems} แถว`,
      });
    }

    rows.forEach((row, index) => {
      for (const column of columns.required ?? []) {
        if (!isBlank(row[column])) continue;

        details.push({
          field: `${name}[${index}].${column}`,
          reason: columns.properties?.[column]?.title ?? column,
        });
      }
    });
  }

  return details;
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

/** A table's column schema, or null when the field is not one. */
function tableOf(property: FormSchemaProperty | undefined): FormSchema | null {
  if (property?.type !== 'array') return null;

  return asSchema(property.items);
}

/** The rows a person filled in, or null when the value is not a table. */
function rowsOf(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;

  return value.filter(
    (row): row is Record<string, unknown> =>
      typeof row === 'object' && row !== null && !Array.isArray(row),
  );
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

  details.push(...unusableTables(parsed));

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

/**
 * What makes a table field unusable, checked when the admin saves it.
 *
 * Same principle as the rules above: only the things the code actually reads,
 * because those are the ones whose absence produces a type that looks saved
 * and then fails at submit — or worse, renders a table with no columns and no
 * explanation.
 *
 * **One level.** A table inside a table is refused: the submit screen draws a
 * grid of inputs and has nowhere to put a second grid inside a cell, and the
 * masking interceptor walks one level into rows for the same reason. Allowing
 * it in the schema while nothing downstream could handle it would be a type
 * that saves and then cannot be filled in.
 */
function unusableTables(parsed: FormSchema | null): ErrorDetail[] {
  const details: ErrorDetail[] = [];

  for (const [name, property] of Object.entries(parsed?.properties ?? {})) {
    if (property.type !== 'array') continue;

    const columns = tableOf(property);

    if (!columns?.properties || !Object.keys(columns.properties).length) {
      details.push({
        field: `form_schema.${name}.items`,
        reason: 'ตารางต้องมีอย่างน้อยหนึ่งคอลัมน์',
      });
      continue;
    }

    for (const column of columns.required ?? []) {
      if (columns.properties[column]) continue;

      details.push({
        field: `form_schema.${name}.items.required`,
        reason: `"${column}" ไม่มีอยู่ในคอลัมน์ของตาราง`,
      });
    }

    for (const [column, spec] of Object.entries(columns.properties)) {
      if (spec.type !== 'array') continue;

      details.push({
        field: `form_schema.${name}.items.${column}`,
        reason: 'ตารางซ้อนในตารางไม่รองรับ',
      });
    }

    if (
      property.maxItems !== undefined &&
      (!Number.isInteger(property.maxItems) || property.maxItems < 1)
    ) {
      details.push({
        field: `form_schema.${name}.maxItems`,
        reason: 'จำนวนแถวสูงสุดต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป',
      });
    }
  }

  return details;
}
