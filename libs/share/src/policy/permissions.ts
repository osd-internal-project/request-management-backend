/**
 * The complete permission catalog, declared in code.
 *
 * §11.3 exposes this read-only at `GET /admin/permissions`: admins compose
 * roles out of these, but cannot invent new ones from the UI — a permission
 * only exists once an endpoint declares it with `@Permissions()`.
 *
 * Naming is `<module>.<action>`, with `.own` / `.any` suffixes where the same
 * action differs by whose record it touches.
 */
export const PERMISSIONS = {
  request: [
    'request.create',
    'request.read',
    /**
     * Every request in the active company, not just the ones the caller is
     * involved in or leads. What scope `company` used to grant, made an
     * ordinary permission when the scope levels were withdrawn (31 Aug 2026)
     * so that "sees everything" is visible in the role editor rather than
     * hidden in a separate rules table.
     */
    'request.read.all',
    'request.cancel.own',
    'request.cancel.any',
    'request.complete',
    'request.return',
    /** §7.1 amendment: park / resume work waiting on an external factor. */
    'request.hold',
    /** SCOPE-04: unmasks margin, discount, and other flagged fields. */
    'request.sensitive.read',
  ],
  approval: ['approval.decide', 'approval.delegate', 'approval.history.read'],
  crm: [
    'crm.customer.read',
    /**
     * Every customer in the active company, not just the caller's own book —
     * the same shape as `request.read.all`: "sees everything" is a permission
     * visible in the role editor, never a hidden scope rule.
     */
    'crm.customer.read.all',
    'crm.customer.manage',
    /** CM-08: unmasks เลขผู้เสียภาษี and other flagged customer fields. */
    'crm.customer.sensitive.read',
    /**
     * CM-03 (PO 8 ก.ย. 2569): confirming a create despite a similar-name
     * warning is its own permission, not part of `manage` — most people who
     * can register customers must not be able to wave the warning away.
     */
    'crm.customer.dedup.override',
    /**
     * C360-02 (PO 8 ก.ย. 2569): seeing ยอดค้างชำระ/AR from SAP is a separate
     * grant from reading the customer — configured per role on the Role
     * screen. Declared now so the catalog is complete before ชุดงาน D wires
     * the SAP read.
     */
    'crm.customer.financial.read',

    /** Lead + โอกาสการขาย (ดีล) — read within own/team scope. */
    'crm.sales.read',
    /** ทั้งบริษัท — หัวหน้าขาย/ผู้บริหาร. */
    'crm.sales.read.all',
    /** สร้าง/แก้/ปิดดีล และจัดการ Lead. */
    'crm.sales.manage',
    /**
     * CD-82: ตั้งเป้ายอดขายรายเดือนของพนักงาน/ทีม/ฝ่ายในบริษัท. ปรับเป้าของงวดที่
     * เริ่มแล้วต้องผ่านคำขออนุมัติ (ประเภทตั้งที่ ตั้งค่า CRM) — สิทธิ์นี้ยื่นได้
     * แต่ไม่ได้ข้ามการอนุมัติ.
     */
    'crm.target.manage',
    /** CD-71: สร้าง/แก้/ปิดแคมเปญการตลาด — ดูผลแคมเปญใช้ `crm.sales.read`. */
    'crm.campaign.manage',
    /**
     * CD-16 AI SMART — swept outside leads before they reach CRM: the sources
     * and their sweeps, and the raw list (CD-289). Apart from `crm.sales.*` so
     * a sales rep's screens never carry unscreened data.
     */
    'smart.prospect.read',
    'smart.prospect.manage',
    /**
     * CD-291 — call lists and what the AI says on them. Certifying the
     * company's calling policy is legal's (`legal.contract.manage`), not this.
     */
    'smart.call.manage',
    /**
     * CD-291 — the do-not-contact register (people who refused contact),
     * shared by AI SMART and AI CARE: add or lift an entry by hand. A refusal
     * on a call is recorded by the system without this.
     */
    'crm.contact.optout.manage',
  ],
  /**
   * CD-11 Pre-Sales. `presales.solution.read` sees every Solution in the
   * company; a salesperson sees their own deal's Solution through the deal
   * (`crm.sales.read`) without it. `presales.solution.manage` starts a
   * Solution from an accepted solution request, edits its drafts and locks
   * versions.
   */
  presales: ['presales.solution.read', 'presales.solution.manage'],
  report: [
    'report.request.read',
    /** CD-92: see the embedded Metabase dashboards (menu + signed URLs). */
    'report.dashboard.read',
  ],
  user: ['user.read'],
  notification: ['notification.read'],
  audit: ['audit.read'],
  /**
   * CD-13 Legal (CD-161 คลังสัญญา, user decision 29 ก.ย. 2569) — the contract
   * repository across the company: customers' contracts, NDAs, MSAs and
   * contracts with other counterparties. Confidential ones are seen by
   * `manage`, their owner/creator and their access list only.
   */
  legal: ['legal.contract.read', 'legal.contract.manage'],
  /**
   * CD-14 ระบบลงนามอิเล็กทรอนิกส์ — `esign.manage` sends documents for
   * signing, follows and cancels them, and keeps the signature layouts.
   * Signing itself needs no permission: an internal signer is the person the
   * envelope names (signed in); an external one holds the link and the code.
   */
  esign: ['esign.manage'],
  /**
   * การเบิก (docs/disbursement.md) — advances and petty cash. The requester
   * reads and clears their own without any of these; accounting verifies,
   * pays and closes; `fund.manage` keeps the petty-cash funds.
   */
  disbursement: [
    'disbursement.read.any',
    'disbursement.verify',
    'disbursement.pay',
    'disbursement.fund.manage',
  ],
  /**
   * CD-18 PM — `pm.project.read` sees every project of the company;
   * `pm.project.manage` opens projects from signed contracts and names their
   * manager and team. A project's manager and members see it without either.
   */
  pm: ['pm.project.read', 'pm.project.manage'],
  /**
   * CD-12 Pricing. `pricing.price.manage` keeps the standard price list
   * (CD-194); `pricing.price.read` sees it. A salesperson gets the price of a
   * product through the quotation form with `crm.sales.read` alone.
   * `pricing.price.override` (CD-204) quotes a product below the price the
   * system holds for the deal, with a reason; it goes to executive approval.
   */
  pricing: [
    'pricing.price.read',
    'pricing.price.manage',
    'pricing.price.override',
  ],
  /**
   * CD-207 (part of CD-17 HR). `hr.rate.read` sees people's cost per manday
   * and the labour amounts priced from it; without it a Solution's labour
   * shows mandays only. `hr.rate.manage` keeps the levels, work types and
   * rates — the one source every labour cost reads.
   */
  hr: [
    'hr.rate.read',
    'hr.rate.manage',
    /**
     * CD-229 — the employee register: HR's own facts about a person (level,
     * employment, skills). Identity stays with the user directory (LDAP).
     */
    'hr.employee.read',
    'hr.employee.manage',
  ],
  /**
   * CD-21 Service & Support. `service.asset.read` sees the installed base
   * (CD-236 — what each customer has, where, which serial and version);
   * `service.asset.manage` adds and corrects it, and imports the base that
   * predates the system.
   *
   * CD-280 (CD-23 AI CARE) — `service.care.manage` reads the conversations
   * AI CARE holds with customers on every channel and confirms who a sender
   * is (linking the channel identity to a customer contact).
   */
  service: [
    'service.asset.read',
    'service.asset.manage',
    'service.care.manage',
  ],
  /**
   * CD-20 Delivery — the delivery team's plans of what goes where and when
   * (CD-250). A project's manager and `pm.project.manage` change their own
   * project's plan too; its team reads it.
   */
  delivery: [
    'delivery.read',
    'delivery.manage',
    /**
     * CD-256 — every contract's installments billed and past due but not yet
     * paid (finance). Without it a salesperson sees only their own contracts'.
     */
    'delivery.receivable.read',
  ],
  /**
   * CD-22 KBMS (CD-259) — every member of staff reads published articles,
   * rates them and writes drafts; `kb.article.manage` (knowledge owners)
   * edits anyone's, publishes, archives and keeps the categories.
   */
  kb: ['kb.article.manage'],
  admin: [
    'admin.role.manage',
    'admin.org.manage',
    'admin.request-type.manage',
    'admin.approval-matrix.manage',
    'admin.sla.manage',
    /**
     * REQ-02: รูปแบบเลขรันของทุกชนิดเอกสาร — pattern, ความยาวลำดับ, รอบรีเซ็ต,
     * เลขเริ่มต้น. แยกจาก `admin.crm.manage` และ `admin.request-type.manage`
     * เพราะเลขรันเป็นของกลางข้ามโดเมน และคนที่แก้มันเปลี่ยนหน้าตาเอกสารที่ส่ง
     * ออกนอกองค์กรได้ทุกชนิดในคราวเดียว.
     */
    'admin.run-number.manage',
    /** CD-92: the "Metabase settings" menu item — a link into the BI admin UI. */
    'admin.bi.manage',
    /**
     * Read and write Keycloak users, realm roles, and groups. Deliberately
     * separate from `admin.role.manage`: this reaches outside our database
     * into the shared corporate realm.
     */
    'admin.identity.manage',
    /**
     * CM-02/03/07: CRM configuration — customer-code prefix, dedup threshold,
     * segment dimensions/values, external-code mappings. Configuration over
     * code, per D-09.
     */
    'admin.crm.manage',
    /**
     * CM-09 / CD-122 — รวมลูกค้าซ้ำ: re-points every document of one customer
     * to another. Admin only (AC), and apart from `admin.crm.manage` so the
     * role editor can hand out settings without handing out merges.
     */
    'admin.customer.merge',
    /**
     * ออกและเพิกถอน API key ของช่องทางภายนอก (14 ก.ย. 2569) และดูแลคิวส่ง
     * SAP — ดูงานที่ส่งไม่สำเร็จแล้วกดส่งใหม่ (24 ก.ย. 2569): ทั้งสองอย่างคือ
     * ขอบของระบบที่คุยกับระบบภายนอก ไม่ใช่การตั้งค่าธุรกิจของ CRM.
     *
     * แยกจาก `admin.identity.manage` เพราะคนละความเสี่ยง: อันนั้นแก้ผู้ใช้และ
     * role ใน realm ที่คนใช้งานอยู่ ส่วนอันนี้ **สร้างเครดentialใหม่** ที่เดินออก
     * นอกองค์กรไปอยู่บนเซิร์ฟเวอร์ของพาร์ตเนอร์. คนที่ดูแลผังองค์กรไม่จำเป็น
     * ต้องเป็นคนเดียวกับคนที่แจกกุญแจให้ระบบภายนอก และเมื่อแยกได้ก็ควรแยก.
     */
    'admin.integration.manage',
    /**
     * CD-54: ถ้อยคำการแจ้งเตือนต่อเหตุการณ์ของบริษัท — แก้ได้โดยไม่ต้องแก้
     * โปรแกรม. แยกจาก `admin.crm.manage` เพราะข้อความถึงผู้อนุมัติและผู้ยื่น
     * คำขอไม่ใช่การตั้งค่า CRM.
     */
    'admin.notification.manage',
    /** Cost Center master — the list forms pick from (`x-options-source: cost_centers`). */
    'admin.cost-center.manage',
    /**
     * CD-275 — the LLM Gateway: which model each AI task uses, token quotas,
     * model prices for the cost estimate, and the usage log. Apart from
     * `admin.integration.manage`: this spends money per call.
     */
    'admin.llm.manage',
    /**
     * CD-279 — reading the AI audit log (every MCP tool call and model call:
     * who asked what, which rows answered) and setting how long it is kept.
     * Apart from `admin.llm.manage` so reviewing is not the configurer's job.
     */
    'admin.ai.audit',
    /**
     * Which LibreChat host and widget the ผู้ช่วย AI panel loads. Apart from
     * `admin.llm.manage`: it points every user's browser at an outside host,
     * it does not spend per call.
     */
    'admin.chat-widget.manage',
    /**
     * Company documents (settings) — upload dated and general documents that
     * other systems download through `integration.document.read`.
     */
    'admin.document.manage',
  ],
  /**
   * AUTH-06: สิทธิ์ของบัญชีบริการ — ออกให้กุญแจ API ที่หน้าจอ API key ไม่ใช่
   * สิทธิ์ที่คนทำงานประจำวันควรถือ. หน้า Role ยังแสดงและติ๊กได้ (ทุกสิทธิ์ที่มี
   * ในระบบต้องมองเห็นจากที่เดียว) แต่ขึ้นเป็น `type: 'service'` เพื่อให้รู้ว่า
   * กำลังให้สิทธิ์ของเครื่องกับคน.
   */
  integration: [
    /*
      กฎ (22 ต.ค. 2569): scope ของ key = `integration.` + สิทธิ์ผู้ใช้ที่ route ใช้
      (`ExternalPermission` ด้านล่างคำนวณจากรายการนี้) — key กับคนตัดกันตรง ๆ
      และ use case เป็นแค่ชุดที่ติ๊กไว้ให้ ไม่ใช่สิทธิ์ใหม่.
      `crm-route-parity.spec.ts` ตรวจทุก route ของ external-service.
    */
    'integration.request.create',
    'integration.request.read',
    'integration.request.complete',
    'integration.request.hold',
    'integration.request.return',
    'integration.request.cancel.own',
    'integration.approval.decide',
    'integration.crm.customer.read',
    'integration.crm.customer.manage',
    'integration.crm.customer.financial.read',
    'integration.crm.sales.read',
    'integration.crm.sales.manage',
    'integration.crm.campaign.manage',
    'integration.crm.target.manage',
    'integration.admin.crm.manage',
    'integration.disbursement.pay',
    'integration.disbursement.verify',
    'integration.legal.contract.read',
    'integration.pm.project.read',
    'integration.pm.project.manage',
    'integration.presales.solution.read',
    'integration.delivery.read',
    'integration.service.asset.read',
    'integration.service.asset.manage',
    /**
     * CD-276 — ผู้ช่วยส่วนตัว (LibreChat ผ่าน MCP). route ที่ฝั่งคนแค่ต้อง login
     * (`notification.read`) ไม่มีสิทธิ์ของคนให้จับคู่ จึงใช้ชื่อ module นี้แทน.
     */
    'integration.assistant.read',
    /*
      ในนามบริษัท — ไม่มีคนปลายทาง จึงตั้งชื่อเป็น resource.action.
    */
    /**
     * CD-66: ช่องทางลูกค้า (เว็บฟอร์มสาธารณะ, AI CARE, LINE) เปิดคำขอผ่าน intake
     * ของบริษัท และอ่านสถานะด้วย token ส่วนตัว — ไปถึง route `X-Acting-User` ไม่ได้.
     */
    'integration.request.intake',
    'integration.approval.create',
    /**
     * workflow engine อ่านข้อเท็จจริงของ Lead ทุกใบในบริษัทของ key
     * (`readsAllLeads`) — รวม `GET crm/ai/leads/{id}` ที่ไม่มีข้อมูลติดต่อ.
     */
    'integration.crm.lead.read',
    /** workflow engine ส่งผลการเลื่อนขั้นที่ตัดสินแล้วกลับมา (`lwf-0001`). */
    'integration.crm.lead.stage',
    /** ระบบภายนอกยิง Lead เข้ากองกลาง — เพิ่มได้อย่างเดียว อ่าน/แปลงไม่ได้. */
    'integration.crm.lead.create',
    /** AI agent ในนามบริษัท: `update` = รายละเอียด + intake data, `convert` = เปิดดีล. */
    'integration.crm.lead.update',
    'integration.crm.lead.convert',
    /** อีเมล/โทรศัพท์ของ Lead — ข้อมูลส่วนบุคคล แยกจาก `lead.read` และไม่อยู่ใน webhook. */
    'integration.crm.lead.contact.read',
    /** OSD Workflow เขียน/อ่าน process log ทีละขั้น; ผู้ทำงานเป็นข้อมูล ไม่ได้ยืนยันตัว. */
    'integration.process.log',
    /** CD-265 — AI CARE / AI SMART อ่านบทความที่เผยแพร่ให้ลูกค้า. */
    'integration.kb.read',
    /** CD-280 — channel connector / AI CARE คุยกับลูกค้า (เดิม `integration.care.manage`). */
    'integration.service.care.manage',
    /** CD-289 — crawler / ผู้ขายข้อมูลส่ง prospect เข้า staging (เดิม `integration.smart.ingest`). */
    'integration.smart.prospect.create',
    /** CD-292 — D-Callcenter รายงานผลการโทร (เดิม `integration.smart.callcenter`). */
    'integration.smart.call.update',
    /** Vuvagent ปิดงานที่ส่งไป (`PATCH agent-records/:id`) — เฉพาะ record ของบริษัทใน key. */
    'integration.agent.record.update',
    /**
     * Company documents — list, read the issue date of, and download the
     * documents uploaded in settings. Robot-only: no acting person.
     */
    'integration.document.read',
  ],
} as const;

/**
 * The permissions an `OrgUnitScope` grant may carry, drawn from the catalog
 * above rather than invented (7 ก.ย. 2569).
 *
 * Replaces the single `canAct` boolean, which could only say "everything this
 * role may do" or "nothing". Every entry here has a real enforcement point on a
 * single row — a checkbox that decides nothing is worse than no checkbox:
 *
 *   - `request.complete` / `request.hold` — authority `carrier`, in
 *     `hasAuthority`: receive, assign, hold, resume, complete
 *   - `request.return` / `request.cancel.any` — the `*_or_lead` authorities,
 *     through `leads()`
 *   - `approval.decide` — an extra decider on a pending step, in
 *     `ApprovalsService.authorise`
 *
 * Deliberately absent: `admin.*` and `integration.*` (nothing to do with a
 * row), `request.create` and `request.read` (a grant already carries the read,
 * and creating is not done *to* an existing row), and
 * `request.sensitive.read` — masking happens on the response, where the
 * interceptor holds no row to test a grant against.
 *
 * A grant never *widens* what a role holds: every check is an intersection
 * with the caller's own permissions, which is what keeps
 * `assertSeparationOfDuties` meaningful. It never *narrows* either — being the
 * requester, receiver, assignee, a named candidate, a delegate or the head of
 * the group works exactly as it did before any of this existed.
 */
export const SCOPE_PERMISSIONS = [
  'request.complete',
  'request.hold',
  'request.return',
  'request.cancel.any',
  'approval.decide',
] as const satisfies readonly Permission[];

export type ScopePermission = (typeof SCOPE_PERMISSIONS)[number];

const SCOPE_PERMISSION_SET: ReadonlySet<string> = new Set(SCOPE_PERMISSIONS);

/** Whether a code came from outside and is one a grant may carry. */
export function isScopePermission(value: unknown): value is ScopePermission {
  return typeof value === 'string' && SCOPE_PERMISSION_SET.has(value);
}

export type PermissionModule = keyof typeof PERMISSIONS;

export type Permission = (typeof PERMISSIONS)[PermissionModule][number];

/** Flat list, in catalog order — what `GET /admin/permissions` returns. */
export const ALL_PERMISSIONS: readonly Permission[] =
  Object.values(PERMISSIONS).flat();

const PERMISSION_SET: ReadonlySet<string> = new Set(ALL_PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_SET.has(value);
}

/** The module a permission belongs to, for grouping in the admin UI. */
export function permissionModule(permission: Permission): PermissionModule {
  const found = (Object.keys(PERMISSIONS) as PermissionModule[]).find((key) =>
    (PERMISSIONS[key] as readonly string[]).includes(permission),
  );

  // Unreachable for a valid Permission; the type guard above is the gate.
  return found ?? 'request';
}

/**
 * ผู้ถือสิทธิ์: คนที่อยู่ใน role หรือบัญชีบริการที่ถือกุญแจ API.
 *
 * เก็บเป็นคอลัมน์ `type` ของตาราง `permissions` เพื่อให้หน้าจอจัดกลุ่มได้จากข้อมูล
 * ไม่ใช่จากรายการที่ frontend เขียนไว้เอง — รายการแบบนั้นคือเหตุที่กลุ่ม CRM
 * หายไปทั้งกลุ่มโดยไม่มีใครเห็น.
 */
export type PermissionType = 'human' | 'service';

/**
 * สิทธิ์ผู้ใช้ที่มีคู่ `integration.<สิทธิ์>` ใน catalog — ทำแทนผู้ใช้ผ่าน API ภายนอกได้.
 * คำนวณจาก catalog ไม่ได้เขียนแยก: เพิ่ม scope = route ใช้สิทธิ์นั้นได้ทันที.
 */
export type ExternalPermission = {
  [P in Permission]: `integration.${P}` extends Permission ? P : never;
}[Permission];

/** scope ของ key ที่ทำแทนผู้ใช้ได้ (`integration.<ExternalPermission>`) — ค่า runtime ของ type ข้างบน. */
export const ACTING_SCOPES: readonly Permission[] = ALL_PERMISSIONS.filter(
  (code) =>
    code.startsWith('integration.') &&
    isPermission(code.slice('integration.'.length)),
);

export function permissionType(permission: Permission): PermissionType {
  return permissionModule(permission) === 'integration' ? 'service' : 'human';
}
