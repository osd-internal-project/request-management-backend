import { SensitiveFieldMasker } from './sensitive-field.masker';
import type { Principal } from '../context/principal';

/**
 * Rules as seeded, plus one an admin added for another type — the case a
 * fixed `request:DSC` could never honour.
 */
const RULES = [
  'request:DSC.est_margin_pct',
  'request:DSC.discount_pct',
  'request:PUR.budget',
];

function viewer(visible: string[] = []): Principal {
  return {
    userId: 'user-1',
    activeCompanyId: 'company-osd',
    sensitiveFieldsAll: RULES,
    sensitiveFieldsVisible: visible,
  } as unknown as Principal;
}

const dsc = {
  id: 'req-dsc',
  typeCode: 'DSC',
  formData: {
    customer_name: 'บริษัท ก',
    est_margin_pct: 12.5,
    discount_pct: 8,
  },
};
const pur = {
  id: 'req-pur',
  typeCode: 'PUR',
  formData: { item: 'server', budget: 90000, est_margin_pct: 99 },
};
const it1 = { id: 'req-it', typeCode: 'IT', formData: { device: 'notebook' } };

describe('CD-127 request:{typeCode} masks each row by its own type', () => {
  const masker = new SensitiveFieldMasker();

  it('a paginated list: every row gets its own type’s rules', () => {
    const page = masker.mask(
      'request:{typeCode}',
      { data: [dsc, pur, it1], meta: { total: 3 } },
      viewer(),
    ) as { data: { formData: Record<string, unknown> }[]; meta: unknown };

    expect(page.meta).toEqual({ total: 3 });
    expect(page.data[0].formData).toEqual({ customer_name: 'บริษัท ก' });
    // PUR's own rule applies; DSC's does not reach a PUR row
    expect(page.data[1].formData).toEqual({
      item: 'server',
      est_margin_pct: 99,
    });
    expect(page.data[2].formData).toEqual({ device: 'notebook' });
  });

  it('a single record (the detail route) uses its own type — not DSC for everyone', () => {
    const one = masker.mask('request:{typeCode}', pur, viewer()) as {
      formData: Record<string, unknown>;
    };

    expect(one.formData).not.toHaveProperty('budget');
  });

  it('the permitted viewer keeps the fields', () => {
    const one = masker.mask(
      'request:{typeCode}',
      dsc,
      viewer(['request:DSC.est_margin_pct', 'request:DSC.discount_pct']),
    ) as { formData: Record<string, unknown> };

    expect(one.formData).toEqual(dsc.formData);
  });

  it('reads snake_case rows too (the §11.1 contract spelling)', () => {
    const one = masker.mask(
      'request:{typeCode}',
      { type_code: 'DSC', form_data: { est_margin_pct: 3 } },
      viewer(),
    ) as { form_data: Record<string, unknown> };

    expect(one.form_data).toEqual({});
  });

  it('a row without a type fails closed: every rule under request: applies', () => {
    const one = masker.mask(
      'request:{typeCode}',
      { id: 'x', formData: { est_margin_pct: 5, budget: 1, note: 'ok' } },
      viewer(),
    ) as { formData: Record<string, unknown> };

    expect(one.formData).toEqual({ note: 'ok' });
  });

  it('records an unmasked read against the row’s resolved resource', async () => {
    const recorded: { resource: string; id: string }[] = [];
    const auditing = new SensitiveFieldMasker({
      recordSensitiveRead: (_actor, resource, id) => {
        recorded.push({ resource, id });
        return Promise.resolve();
      },
    });

    auditing.mask(
      'request:{typeCode}',
      { data: [dsc, it1] },
      viewer(['request:DSC.est_margin_pct', 'request:DSC.discount_pct']),
    );
    await Promise.resolve();

    expect(recorded).toEqual([{ resource: 'request:DSC', id: 'req-dsc' }]);
  });

  it('a fixed resource still behaves exactly as before', () => {
    const one = masker.mask('request:DSC', dsc, viewer()) as {
      formData: Record<string, unknown>;
    };

    expect(one.formData).toEqual({ customer_name: 'บริษัท ก' });
  });
});
