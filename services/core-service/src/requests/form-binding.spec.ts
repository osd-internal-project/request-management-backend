import { boundKeys, missingBindings, readBound } from './form-binding';
import { FormBindingRegistry } from './form-binding.registry';

/** FI05's form after an admin renamed `purpose` → `objective` and `expense_items` → `items`. */
const RENAMED = {
  type: 'object',
  properties: {
    objective: { type: 'string', 'x-bind': 'disbursement.purpose' },
    items: {
      type: 'array',
      'x-bind': 'disbursement.lines',
      items: {
        type: 'object',
        properties: {
          what: { type: 'string', 'x-bind': 'disbursement.lines.description' },
          baht: { type: 'number', 'x-bind': 'disbursement.lines.amount' },
        },
      },
    },
    unrelated: { type: 'string', 'x-bind': 'survey.subject' },
  },
};

const FALLBACK = {
  purpose: 'purpose',
  lines: 'expense_items',
  'lines.description': 'description',
  'lines.amount': 'amount',
};

describe('x-bind — reading a dynamic form by meaning', () => {
  it('maps tagged fields and table columns to the module paths', () => {
    expect(Object.fromEntries(boundKeys(RENAMED, 'disbursement'))).toEqual({
      purpose: 'objective',
      lines: 'items',
      'lines.description': 'what',
      'lines.amount': 'baht',
    });
  });

  it('keeps reading the right values after the admin renamed the fields', () => {
    const data = { objective: 'ออกบูธ', items: [{ what: 'ค่ารถ', baht: 600 }] };
    expect(readBound(RENAMED, data, 'disbursement', FALLBACK)).toEqual({
      purpose: 'ออกบูธ',
      lines: [{ description: 'ค่ารถ', amount: 600 }],
    });
  });

  it('falls back to the old fixed keys for a form written before x-bind', () => {
    const untagged = { type: 'object', properties: {} };
    const data = { purpose: 'ค่าที่พัก', expense_items: [{ description: 'โรงแรม', amount: 1200 }] };
    expect(readBound(untagged, data, 'disbursement', FALLBACK)).toEqual({
      purpose: 'ค่าที่พัก',
      lines: [{ description: 'โรงแรม', amount: 1200 }],
    });
  });

  it('reads a missing table as no rows, never as undefined', () => {
    expect(readBound(RENAMED, {}, 'disbursement', FALLBACK).lines).toEqual([]);
  });

  it('lists the required paths no field is tagged with', () => {
    expect(missingBindings(RENAMED, 'disbursement', ['purpose', 'clear_by', 'lines.amount'])).toEqual([
      'clear_by',
    ]);
  });
});

describe('FormBindingRegistry — refuses a form that drops a field a module needs', () => {
  const registry = new FormBindingRegistry();
  registry.register({
    target: 'disbursement',
    label: 'การเบิก',
    typeCodes: async () => ['FI05'],
    required: () => ['purpose', 'lines.amount'],
  });

  it('rejects FI05 when the amount column lost its tag', async () => {
    const broken = { type: 'object', properties: { objective: RENAMED.properties.objective } };
    await expect(registry.assertBound('FI05', broken)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('passes FI05 when every required path is tagged', async () => {
    await expect(registry.assertBound('FI05', RENAMED)).resolves.toBeUndefined();
  });

  it('never checks a type no module registered', async () => {
    await expect(registry.assertBound('PS01', { type: 'object', properties: {} })).resolves.toBeUndefined();
  });
});
