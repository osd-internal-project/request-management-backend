import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * CD-278 — the web page each answer came from.
 *
 * A chat answer the asker cannot check is a rumour. Every row an MCP tool
 * returns carries `link`, the screen that shows that record, so the
 * assistant can cite it and the person can open it. Paths mirror the web
 * app's `src/lib/routes.ts`; change one, change the other.
 */
export const PAGES = {
  request: (id: string) => `/pages/requests/${id}`,
  requests: '/pages/requests',
  newRequest: '/pages/requests/new',
  approvals: '/pages/approvals',
  customer: (id: string) => `/pages/customers/${id}`,
  customers: '/pages/customers',
  lead: (id: string) => `/pages/leads/${id}`,
  leads: '/pages/leads',
  opportunity: (id: string) => `/pages/opportunities/${id}`,
  opportunities: '/pages/opportunities',
  quotation: (id: string) => `/pages/quotations/${id}`,
  quotations: '/pages/quotations',
  crmDashboard: '/pages/crm',
  project: (id: string) => `/pages/projects/${id}`,
  portfolio: '/pages/projects/portfolio',
  workOrders: '/pages/service/work-orders',
  kbArticle: (id: string) => `/pages/kb/${id}`,
  kb: '/pages/kb',
} as const;

type RowKind = 'request' | 'customer' | 'lead' | 'opportunity' | 'quotation';

/** What a tool's answer links to: each record, and the page it was read from. */
interface ToolSource {
  /** Each row is one of these, linked by its `id` (or `request_id`). */
  readonly rows?: RowKind;
  /** The list or screen the whole answer stands for; null = no such page. */
  readonly source: string | null;
}

/**
 * Every catalogue tool, except `assistant_*` (which links its own rows — it
 * shapes them, and knows ids it does not return). `mcp-source-links.spec.ts`
 * fails for a tool that is in neither, so a new tool cannot answer unlinked.
 */
export const TOOL_SOURCES: Readonly<Record<string, ToolSource>> = {
  request_get_request_types: { source: PAGES.newRequest },
  request_get_request_types_code_form: { source: PAGES.newRequest },
  request_get_requests: { rows: 'request', source: PAGES.requests },
  request_get_requests_summary: { source: PAGES.requests },
  request_get_requests_ref: { rows: 'request', source: PAGES.requests },
  request_get_requests_ref_actions: { rows: 'request', source: PAGES.requests },
  request_get_requests_ref_tree: { rows: 'request', source: PAGES.requests },
  // A directory lookup for filling a form — there is no person page.
  request_get_users: { source: null },
  request_post_requests: { rows: 'request', source: PAGES.requests },
  request_post_requests_ref_actions_action: {
    rows: 'request',
    source: PAGES.requests,
  },

  crm_get_customers: { rows: 'customer', source: PAGES.customers },
  crm_get_customers_id: { rows: 'customer', source: PAGES.customers },
  crm_get_customers_id_summary: { source: PAGES.customers },
  crm_get_leads_statuses: { source: PAGES.leads },
  crm_get_leads: { rows: 'lead', source: PAGES.leads },
  crm_post_leads: { rows: 'lead', source: PAGES.leads },
  crm_get_leads_id: { rows: 'lead', source: PAGES.leads },
  crm_patch_leads_id_owner: { rows: 'lead', source: PAGES.leads },
  crm_patch_leads_id_status: { rows: 'lead', source: PAGES.leads },
  crm_post_leads_id_activities: { source: PAGES.leads },
  crm_post_leads_id_convert: {
    rows: 'opportunity',
    source: PAGES.opportunities,
  },
  crm_get_opportunities: { rows: 'opportunity', source: PAGES.opportunities },
  crm_post_opportunities: { rows: 'opportunity', source: PAGES.opportunities },
  crm_get_opportunities_id: {
    rows: 'opportunity',
    source: PAGES.opportunities,
  },
  crm_get_quotations: { rows: 'quotation', source: PAGES.quotations },
  crm_get_quotations_id: { rows: 'quotation', source: PAGES.quotations },
};

const ROW_PAGE: Readonly<Record<RowKind, (id: string) => string>> = {
  request: PAGES.request,
  customer: PAGES.customer,
  lead: PAGES.lead,
  opportunity: PAGES.opportunity,
  quotation: PAGES.quotation,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class SourceLinks {
  private readonly logger = new Logger(SourceLinks.name);
  private readonly base: string;

  constructor(config: ConfigService) {
    this.base = (config.get<string>('publicWebUrl') ?? '').replace(/\/+$/, '');
    if (!this.base) {
      this.logger.warn(
        'PUBLIC_WEB_URL ไม่ได้ตั้ง — ลิงก์ในคำตอบของผู้ช่วยจะเป็น path อย่างเดียว',
      );
    }
  }

  /** A page path as the person opens it. */
  url(path: string): string {
    return `${this.base}${path}`;
  }

  /**
   * `value` with `link` on each record row and `source_link` on the answer.
   *
   * Rows are found where the services put them: a §11.1 page (`data`),
   * a list (`items` or a bare array), or the record itself. A row whose id
   * cannot be read keeps no link rather than a wrong one.
   */
  attach(tool: string, value: unknown): unknown {
    const spec = TOOL_SOURCES[tool];
    if (!spec) return value;

    const link = (row: unknown): unknown => {
      if (!spec.rows || !isRecord(row)) return row;
      const id = row.id ?? row.request_id;
      return typeof id === 'string'
        ? { ...row, link: this.url(ROW_PAGE[spec.rows](id)) }
        : row;
    };

    if (Array.isArray(value)) return value.map(link);
    if (!isRecord(value)) return value;

    const source = spec.source ? { source_link: this.url(spec.source) } : {};
    if (Array.isArray(value.data)) {
      return { ...value, data: value.data.map(link), ...source };
    }
    if (Array.isArray(value.items)) {
      return { ...value, items: value.items.map(link), ...source };
    }
    return { ...(link(value) as Record<string, unknown>), ...source };
  }
}
