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
  ],
  /**
   * AUTH-06: สิทธิ์ของบัญชีบริการ — ออกให้กุญแจ API ที่หน้าจอ API key ไม่ใช่
   * สิทธิ์ที่คนทำงานประจำวันควรถือ. หน้า Role ยังแสดงและติ๊กได้ (ทุกสิทธิ์ที่มี
   * ในระบบต้องมองเห็นจากที่เดียว) แต่ขึ้นเป็น `type: 'service'` เพื่อให้รู้ว่า
   * กำลังให้สิทธิ์ของเครื่องกับคน.
   */
  integration: [
    'integration.request.create',
    /**
     * CD-66: a customer channel (the public web form's server side, AI CARE,
     * the LINE connector) raising a request through a company's intake
     * channel, and reading its status by the private token. Deliberately not
     * `integration.request.create`: that scope also opens the routes that act
     * as any user through `X-Acting-User`, which a key sitting behind a public
     * form must never be able to do.
     */
    'integration.request.intake',
    'integration.approval.create',
    'integration.disbursement.read',
    'integration.disbursement.manage',
    /**
     * The workflow engine reading the facts its Decision nodes test
     * ("Workflow owns Process, Core owns Data", PO 10 ก.ย. 2569). Read-only and
     * separate from `crm.sales.read` so a human role can never pick it up.
     */
    'integration.crm.lead.read',
    /**
     * The workflow engine applying a stage it has already decided. Whether the
     * move is *allowed* is settled on `lwf-0001`; this permission only says
     * which caller may hand the answer back.
     */
    'integration.crm.lead.stage',
    /**
     * ระบบภายนอกยิง Lead เข้ามาเอง — เว็บฟอร์ม, LINE OA, งานอีเวนต์
     * (14 ก.ย. 2569). แยกจาก `crm.sales.manage` ด้วยเหตุผลเดียวกับสองตัวบน:
     * ผู้ถือคือบัญชีบริการที่ *เพิ่ม* ใบเข้ากองกลางได้อย่างเดียว อ่านทะเบียนที่
     * มีอยู่ไม่ได้ เลื่อนขั้นไม่ได้ แปลงไม่ได้ — ประตูเปิดกว้างเท่าที่การรับ
     * ข้อมูลเข้าต้องใช้ ไม่ใช่เท่าที่พนักงานขายหนึ่งคนทำได้.
     */
    'integration.crm.lead.create',
    /**
     * CRM ทั้งชุดที่เปิดให้ระบบภายนอกเรียกผ่าน external-service
     * (`api/v1/crm/*`). สี่ตัวนี้เป็น **ประตูของเครื่อง** อย่างเดียว — ตอบแค่ว่า
     * integration ตัวนี้ได้รับอนุญาตให้แตะ CRM ไหม ไม่ได้ตอบว่าใครทำอะไรได้.
     *
     * สิทธิ์ของคนที่ integration ทำแทนถูกตรวจแยกด้วย `@ActingPermissions`
     * ซึ่งประกาศ `crm.customer.*` / `crm.sales.*` ตัวเดิมที่ route ของหน้าเว็บ
     * ประกาศ — สองประตู คนละคำถาม ดู `ActingPolicyGuard`.
     *
     * แยก read กับ manage เพื่อให้กุญแจของ chatbot ที่ต้องอ่านอย่างเดียวออกได้
     * โดยไม่พ่วงสิทธิ์เขียน และแยก customer กับ sales ตามแนวเดียวกับ
     * `crm.customer.*` / `crm.sales.*` ที่มีอยู่แล้ว.
     */
    'integration.crm.customer.read',
    'integration.crm.customer.manage',
    'integration.crm.sales.read',
    'integration.crm.sales.manage',
    /**
     * หน้าตั้งค่า CRM (สถานะ Lead, กฎ KYC, มิติ segment, ค่าคอนฟิกบริษัท)
     * ที่เปิดให้ระบบภายนอกอ่าน/แก้ผ่าน `api/v1/crm/admin/*`.
     *
     * แยกจาก `admin.crm.manage` ไม่ใช่ใช้ตัวเดียวกัน เพราะสองคำถามต่างกัน:
     * ตัวนี้ตอบว่า integration ตัวไหนแตะหน้าตั้งค่าได้ ส่วน `admin.crm.manage`
     * ยังถูกตรวจกับ *คน* ใน `X-Acting-User` ต่อไปด้วย `@ActingPermissions`.
     * กุญแจที่ถือตัวนี้จึงยังทำอะไรไม่ได้ ถ้าคนที่มันทำแทนไม่ใช่ผู้ดูแล CRM.
     */
    'integration.crm.admin.manage',
    /**
     * สายงานหลังดีลที่เปิดให้ระบบภายนอกเรียก (6 ต.ค. 2569) — ติดตามดีลทั้งสาย
     * (`flow`), Solution ของ Pre-Sales, คลังสัญญา, โครงการ, การส่งมอบ และงาน
     * บริการ. เป็นประตูของเครื่องอย่างเดียวเหมือนชุด CRM: คนใน `X-Acting-User`
     * ยังถูกตรวจด้วยสิทธิ์ตัวเดิมของหน้าจอ (`presales.*`, `legal.*`, `pm.*`,
     * `service.*`) ที่ `@ActingPermissions`.
     *
     * อ่านแยกจากเขียน และเขียนเปิดเฉพาะจุดเริ่มของแต่ละช่วงที่ระบบอื่นมีเหตุ
     * ต้องสั่ง — เปิดโครงการจากสัญญาที่ลงนามแล้ว และเปิดใบสั่งงานบริการ.
     * การออกแบบ Solution ร่างสัญญา และวางแผนโครงการยังเป็นงานบนหน้าจอ.
     */
    'integration.flow.read',
    'integration.presales.read',
    'integration.legal.read',
    'integration.pm.read',
    'integration.pm.manage',
    'integration.delivery.read',
    'integration.support.read',
    'integration.support.manage',
    /**
     * CD-265 (CD-22 KBMS) — an AI channel that talks to customers (AI CARE,
     * AI SMART) reads published customer-facing articles and reports which
     * it answered with. Robot-only: no acting person, never internal articles.
     */
    'integration.kb.read',
    /**
     * CD-280 (CD-23 AI CARE) — a channel connector or AI CARE posts what a
     * customer wrote and what was answered, and reads the conversation with
     * the customer it is (assets and coverage only once the sender is
     * verified). Robot-only.
     */
    'integration.care.manage',
    /**
     * CD-276 (CD-24) — the personal assistant (LibreChat over MCP) asks the
     * questions people ask in a chat: deals closing or gone quiet, my
     * approvals, projects in trouble, open service jobs, articles, my figures.
     * Read-only; each route still asks the person for the screen's own
     * permission through `@ActingPermissions`.
     */
    'integration.assistant.read',
    /**
     * CD-289 — a licensed crawler or data vendor pushes what it found into
     * AI SMART's staging list (`smart/prospects/ingest`). Robot-only: there is
     * no acting person, and nothing reaches CRM until screening.
     */
    'integration.smart.ingest',
    /**
     * CD-292 — D-Callcenter reports how an AI call went (outcome, transcript,
     * recording) to `smart/calls/callback`. Robot-only, no acting person.
     */
    'integration.smart.callcenter',
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

export function permissionType(permission: Permission): PermissionType {
  return permissionModule(permission) === 'integration' ? 'service' : 'human';
}
