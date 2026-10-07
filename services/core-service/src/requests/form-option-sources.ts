import { Injectable } from '@nestjs/common';
import { AppError } from '@request-management/share';

/** A master list a form field picks from via `"x-options-source": "<name>"` (e.g. `cost_centers`). */
export interface FormOptionSource {
  readonly name: string;
  /** What to call the list in the error a requester reads. */
  readonly label: string;
  /** The values that are not (or no longer) in the list for this company. */
  readonly unknownValues: (companyId: string, values: readonly string[]) => Promise<string[]>;
}

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const propertiesOf = (schema: unknown): JsonObject =>
  isObject(schema) && isObject(schema.properties) ? schema.properties : {};
const sourceOf = (property: unknown) =>
  isObject(property) && typeof property['x-options-source'] === 'string'
    ? property['x-options-source']
    : null;

/** Every answer given to a field (or table column) that picks from `source`. */
export function valuesFrom(schema: unknown, formData: unknown, source: string): string[] {
  const data = isObject(formData) ? formData : {};
  const values: unknown[] = [];
  for (const [key, property] of Object.entries(propertiesOf(schema))) {
    if (sourceOf(property) === source) values.push(data[key]);
    if (!isObject(property) || property.type !== 'array' || !Array.isArray(data[key])) continue;
    const columns = Object.entries(propertiesOf(property.items))
      .filter(([, cell]) => sourceOf(cell) === source)
      .map(([column]) => column);
    for (const row of data[key] as unknown[]) {
      if (isObject(row)) columns.forEach((column) => values.push(row[column]));
    }
  }
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v !== ''))];
}

/** Checks, at submit, that answers picked from a master list are still in it. */
@Injectable()
export class FormOptionSources {
  private readonly sources = new Map<string, FormOptionSource>();

  register(source: FormOptionSource): void {
    this.sources.set(source.name, source);
  }

  async assertValid(companyId: string, schema: unknown, formData: unknown): Promise<void> {
    for (const source of this.sources.values()) {
      const values = valuesFrom(schema, formData, source.name);
      if (!values.length) continue;
      const unknown = await source.unknownValues(companyId, values);
      if (!unknown.length) continue;
      throw new AppError(
        'VALIDATION_FAILED',
        `ไม่พบใน${source.label} หรือถูกปิดใช้งานแล้ว: ${unknown.join(', ')}`,
        unknown.map((value) => ({ field: source.name, reason: value })),
      );
    }
  }
}
