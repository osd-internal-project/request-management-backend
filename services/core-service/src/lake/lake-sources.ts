/**
 * CD-90 — what flows into the Data Lake (the `raw` zone of the warehouse
 * database), and what never does.
 *
 * One entry per application table. Each extract takes the rows whose
 * watermark moved since the last run and appends them as a new version, so
 * the lake keeps the history of every row — the application keeps only its
 * current state.
 *
 * `exclude` (user decision 29 ก.ย. 2569): sensitive columns never leave the
 * application database — form contents (they carry margins, discounts and
 * personal data), cost and margin, tax ids, and personal contact details
 * (SCOPE-04 / PDPA). A table that is nothing but personal data
 * (`customer_contacts`) is not a source at all. When the central PDPA
 * system arrives, it decides what may be added back.
 */
export interface LakeSource {
  /** Table name in `raw` (and `latest`) in the lake. */
  readonly name: string;
  /** Module it belongs to, for the status screen and the docs. */
  readonly module: 'request' | 'crm' | 'sales' | 'reference';
  /** SQL `FROM` in the application database; the row alias is `t`. */
  readonly from: string;
  /** SQL expression giving the row's change time (`timestamp`, UTC). */
  readonly watermark: string;
  /** Columns of `t` dropped before the row leaves the application database. */
  readonly exclude: readonly string[];
}

const table = (name: string) => `"${name}" t`;

export const LAKE_SOURCES: readonly LakeSource[] = [
  // --- Platform Request ------------------------------------------------------
  {
    name: 'requests',
    module: 'request',
    from: table('requests'),
    watermark: 't."updatedAt"',
    exclude: ['formData', 'receiverFormData', 'stepFormData', 'typeSnapshot'],
  },
  {
    // Append-only: a row never changes after it is written.
    name: 'request_events',
    module: 'request',
    from: table('request_events'),
    watermark: 't."createdAt"',
    exclude: ['data'],
  },
  {
    name: 'request_types',
    module: 'request',
    from: table('request_types'),
    watermark: 't."updatedAt"',
    exclude: [],
  },
  {
    // No updatedAt: a case changes when it is decided.
    name: 'approval_cases',
    module: 'request',
    from: table('approval_cases'),
    watermark: 'GREATEST(t."createdAt", t."decidedAt")',
    exclude: ['payload'],
  },
  {
    name: 'approval_steps',
    module: 'request',
    from: table('approval_steps'),
    watermark: 'GREATEST(t."createdAt", t."decidedAt")',
    exclude: [],
  },
  {
    name: 'sla_clocks',
    module: 'request',
    from: table('sla_clocks'),
    watermark: 't."updatedAt"',
    exclude: [],
  },

  // --- CRM -------------------------------------------------------------------
  {
    name: 'customers',
    module: 'crm',
    from: table('customers'),
    watermark: 't."updatedAt"',
    exclude: ['taxId', 'dedupOverrideReason'],
  },
  {
    // The street lines identify a person's home for an individual customer.
    name: 'customer_locations',
    module: 'crm',
    from: table('customer_locations'),
    watermark: 't."updatedAt"',
    exclude: ['line1', 'line2'],
  },
  {
    name: 'customer_contracts',
    module: 'crm',
    from: table('customer_contracts'),
    watermark: 't."updatedAt"',
    exclude: ['note'],
  },
  {
    name: 'leads',
    module: 'crm',
    from: table('leads'),
    watermark: 't."updatedAt"',
    exclude: [
      'contactName',
      'contactPosition',
      'phone',
      'email',
      'taxId',
      'addressLine',
      'note',
    ],
  },
  {
    name: 'lead_activities',
    module: 'crm',
    from: table('lead_activities'),
    watermark: 't."updatedAt"',
    exclude: ['detail'],
  },

  // --- Sales -----------------------------------------------------------------
  {
    name: 'opportunities',
    module: 'sales',
    from: table('opportunities'),
    watermark: 't."updatedAt"',
    exclude: [
      'prospectTaxId',
      'prospectContactName',
      'prospectPhone',
      'prospectEmail',
    ],
  },
  {
    name: 'opportunity_activities',
    module: 'sales',
    from: table('opportunity_activities'),
    watermark: 't."updatedAt"',
    exclude: ['detail'],
  },
  {
    name: 'quotations',
    module: 'sales',
    from: table('quotations'),
    watermark: 't."updatedAt"',
    exclude: [
      'partyTaxId',
      'contactName',
      'costTotal',
      'marginAmount',
      'marginPct',
      'minMarginPct',
      'note',
      'responseNote',
    ],
  },
  {
    // Lines have no timestamp of their own: they move with their quotation.
    name: 'quotation_lines',
    module: 'sales',
    from: `"quotation_lines" t JOIN "quotations" q ON q.id = t."quotationId"`,
    watermark: 'q."updatedAt"',
    exclude: ['unitCost', 'lineCost'],
  },
  {
    name: 'sale_orders',
    module: 'sales',
    from: table('sale_orders'),
    watermark: 't."updatedAt"',
    exclude: ['note'],
  },
  {
    name: 'sale_order_lines',
    module: 'sales',
    from: `"sale_order_lines" t JOIN "sale_orders" s ON s.id = t."saleOrderId"`,
    watermark: 's."updatedAt"',
    exclude: [],
  },
  {
    name: 'sales_targets',
    module: 'sales',
    from: table('sales_targets'),
    watermark: 't."updatedAt"',
    exclude: [],
  },
  {
    name: 'campaigns',
    module: 'sales',
    from: table('campaigns'),
    watermark: 't."updatedAt"',
    exclude: ['note'],
  },
  {
    // The checklist answers are free text about the customer.
    name: 'sales_handovers',
    module: 'sales',
    from: table('sales_handovers'),
    watermark: 't."updatedAt"',
    exclude: ['items', 'note', 'history', 'returnReason'],
  },

  // --- reference data every other table points at ------------------------------
  {
    name: 'companies',
    module: 'reference',
    from: table('companies'),
    watermark: 't."updatedAt"',
    exclude: [],
  },
  {
    name: 'org_units',
    module: 'reference',
    from: table('org_units'),
    watermark: 't."updatedAt"',
    exclude: [],
  },
  {
    // Staff: the display name and position are what reports show; nothing
    // that reaches the person or their accounts.
    name: 'users',
    module: 'reference',
    from: table('users'),
    watermark: 't."updatedAt"',
    exclude: [
      'keycloakId',
      'email',
      'username',
      'firstName',
      'lastName',
      'phone',
      'extension',
      'employeeId',
      'keycloakRoles',
    ],
  },
  {
    // The SAP item catalog as last synced (CD-27).
    name: 'products',
    module: 'reference',
    from: table('products'),
    watermark: 't."updatedAt"',
    exclude: [],
  },
];

/** The SAP extract (daily): the customers' invoices, one version per day. */
export const SAP_INVOICES = 'sap_invoices';

/** Every table the lake holds, in the order the status screen lists them. */
export const LAKE_TABLES: readonly string[] = [
  ...LAKE_SOURCES.map((source) => source.name),
  SAP_INVOICES,
];

const IDENT = /^[a-z_][a-z0-9_]*$/;
const COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The definitions above are the only SQL that is not a literal in the
 * repository; checked once so a typo fails loudly at boot, not as data.
 */
export function assertSources(sources: readonly LakeSource[]): void {
  const seen = new Set<string>();
  for (const source of sources) {
    if (!IDENT.test(source.name)) {
      throw new Error(`lake source name "${source.name}" is not an identifier`);
    }
    if (seen.has(source.name)) {
      throw new Error(`lake source "${source.name}" is declared twice`);
    }
    seen.add(source.name);
    for (const column of source.exclude) {
      if (!COLUMN.test(column)) {
        throw new Error(
          `lake source "${source.name}" excludes "${column}", not a column name`,
        );
      }
    }
  }
}
