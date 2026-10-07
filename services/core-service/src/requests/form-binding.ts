/**
 * `x-bind` — which form field a module reads, by meaning rather than by key.
 * A field tagged `"x-bind": "disbursement.purpose"` keeps feeding the module after an admin renames it.
 * Table columns carry the full path: `"x-bind": "disbursement.lines.amount"`.
 */

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function propertiesOf(schema: unknown): JsonObject {
  return isObject(schema) && isObject(schema.properties) ? schema.properties : {};
}

function bindOf(property: unknown): string | null {
  return isObject(property) && typeof property['x-bind'] === 'string'
    ? property['x-bind']
    : null;
}

/** `target.field` → the key in this schema; table columns as `target.field.column`. */
export function boundKeys(schema: unknown, target: string): Map<string, string> {
  const prefix = `${target}.`;
  const keys = new Map<string, string>();
  for (const [key, property] of Object.entries(propertiesOf(schema))) {
    const bind = bindOf(property);
    if (bind?.startsWith(prefix)) keys.set(bind.slice(prefix.length), key);
    if (!isObject(property) || property.type !== 'array') continue;
    for (const [column, cell] of Object.entries(propertiesOf(property.items))) {
      const cellBind = bindOf(cell);
      if (cellBind?.startsWith(prefix)) keys.set(cellBind.slice(prefix.length), column);
    }
  }
  return keys;
}

/**
 * The module's view of `formData`: `{ field: value }`, a table as rows of `{ column: value }`.
 * A field with no tag is read from `fallback[field]` — forms written before `x-bind` existed.
 */
export function readBound(
  schema: unknown,
  formData: unknown,
  target: string,
  fallback: Readonly<Record<string, string>>,
): JsonObject {
  const keys = boundKeys(schema, target);
  const paths = [...new Set([...Object.keys(fallback), ...keys.keys()])];
  const keyOf = (path: string) => keys.get(path) ?? fallback[path];
  const data = isObject(formData) ? formData : {};

  const result: JsonObject = {};
  for (const path of paths.filter((p) => !p.includes('.'))) {
    const key = keyOf(path);
    if (!key) continue;
    const columns = paths
      .filter((p) => p.startsWith(`${path}.`))
      .map((p) => p.slice(path.length + 1));
    result[path] = columns.length
      ? rowsOf(data[key], columns, (column) => keyOf(`${path}.${column}`) ?? column)
      : data[key];
  }
  return result;
}

function rowsOf(
  value: unknown,
  columns: readonly string[],
  keyOf: (column: string) => string,
): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const cells = isObject(row) ? row : {};
    return Object.fromEntries(columns.map((column) => [column, cells[keyOf(column)]]));
  });
}

/** Required paths (`purpose`, `lines.amount`) that no field in the schema is tagged with. */
export function missingBindings(
  schema: unknown,
  target: string,
  required: readonly string[],
): string[] {
  const keys = boundKeys(schema, target);
  return required.filter((path) => !keys.has(path));
}
