import { FormSchema, FormSchemaProperty } from './submit-rules';

/**
 * A form field, as a caller with no form renderer needs it.
 *
 * The JSON Schema in `RequestType.formSchema` is the storage format and stays
 * the storage format — the web app renders straight from it. This is a second
 * *view* of the same thing, for callers that have to conduct a conversation
 * instead: a chatbot cannot ask "ความเร่งด่วน" and offer its three choices
 * without first knowing that `enum` means choices and `x-order` means order.
 *
 * Every client that parsed the schema itself wrote that translation, and each
 * one wrote it slightly differently. This is the translation, once.
 */
export interface FormField {
  /** The key to send back in `form_data`. Not the label. */
  readonly key: string;
  /** What to call it when speaking to a person. Falls back to the key. */
  readonly label: string;
  readonly type: FormFieldType;
  readonly required: boolean;
  /** Ask in this order. Fields without `x-order` sort last, then by key. */
  readonly order: number;
  /** Present only for `select` — every value the field accepts. */
  readonly options?: readonly FormFieldOption[];
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  /** Present only for `table` — the maximum number of rows. */
  readonly maxItems?: number;
  /** Present only for `table` — the columns, as fields in their own right. */
  readonly columns?: readonly FormField[];
  /** Present only for `boolean` — what to call each answer. */
  readonly trueLabel?: string;
  readonly falseLabel?: string;
  /**
   * SCOPE-04: masked for anyone without `request.sensitive.read`.
   *
   * Carried so a caller can warn before asking rather than after: a value
   * collected into a field the person cannot read back is a value they cannot
   * check.
   */
  readonly sensitive?: boolean;
}

export type FormFieldType =
  | 'text'
  | 'multiline'
  | 'number'
  | 'boolean'
  | 'select'
  | 'date'
  | 'datetime'
  | 'table';

export interface FormFieldOption {
  readonly value: string;
  /** The same as `value` today — schemas store bare enums, not labelled ones. */
  readonly label: string;
}

/** The `x-` keys are this system's own; everything else is plain JSON Schema. */
interface RichProperty extends FormSchemaProperty {
  enum?: unknown[];
  format?: string;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  'x-order'?: number;
  'x-multiline'?: boolean;
  'x-sensitive'?: boolean;
}

/**
 * Translate a stored schema into the fields to ask for.
 *
 * Returns `[]` for anything that is not a usable schema rather than throwing:
 * a type with a half-written form is an administrator's problem to fix on the
 * admin screen, and a caller asking what to fill in should be told "nothing
 * yet", not handed an error it cannot act on.
 */
export function toFormFields(schema: unknown): FormField[] {
  const parsed = asSchema(schema);
  if (!parsed) return [];

  const required = new Set(parsed.required ?? []);

  return Object.entries(parsed.properties ?? {})
    .map(([key, property]) =>
      toField(key, property as RichProperty, required.has(key)),
    )
    .sort(byOrderThenKey);
}

function toField(
  key: string,
  property: RichProperty,
  required: boolean,
): FormField {
  const type = typeOf(property);

  return {
    key,
    label: property.title?.trim() || key,
    type,
    required,
    /*
      `Number.MAX_SAFE_INTEGER` rather than 0, so a field with no `x-order`
      sorts *after* the ones that have it. Defaulting to 0 would put every
      unordered field first, which reads as a deliberate order and is not one.
    */
    order: property['x-order'] ?? Number.MAX_SAFE_INTEGER,
    ...(type === 'select'
      ? { options: (property.enum ?? []).map(toOption) }
      : {}),
    ...(property.maxLength !== undefined
      ? { maxLength: property.maxLength }
      : {}),
    ...(property.minimum !== undefined ? { minimum: property.minimum } : {}),
    ...(property.maximum !== undefined ? { maximum: property.maximum } : {}),
    ...(type === 'table'
      ? {
          ...(property.maxItems !== undefined
            ? { maxItems: property.maxItems }
            : {}),
          columns: toFormFields(property.items),
        }
      : {}),
    ...(type === 'boolean'
      ? {
          trueLabel: property['x-true-label']?.trim() || 'ใช่',
          falseLabel: property['x-false-label']?.trim() || 'ไม่ใช่',
        }
      : {}),
    ...(property['x-sensitive'] ? { sensitive: true } : {}),
  };
}

/**
 * Which kind of question this property is.
 *
 * `enum` wins over `type` on purpose: `{ type: 'string', enum: [...] }` is a
 * choice, and calling it text would send a caller off to ask an open question
 * whose answer the system then rejects.
 */
function typeOf(property: RichProperty): FormFieldType {
  if (Array.isArray(property.enum) && property.enum.length) return 'select';
  if (property.type === 'array' && property.items) return 'table';
  if (property.type === 'number' || property.type === 'integer')
    return 'number';
  if (property.type === 'boolean') return 'boolean';
  if (property.format === 'date') return 'date';
  if (property.format === 'date-time') return 'datetime';
  if (property['x-multiline']) return 'multiline';

  return 'text';
}

function toOption(value: unknown): FormFieldOption {
  const text = String(value);

  return { value: text, label: text };
}

function byOrderThenKey(left: FormField, right: FormField): number {
  return left.order - right.order || left.key.localeCompare(right.key);
}

function asSchema(value: unknown): FormSchema | null {
  if (typeof value !== 'object' || value === null) return null;

  const schema = value as FormSchema;

  return schema.properties && typeof schema.properties === 'object'
    ? schema
    : null;
}
