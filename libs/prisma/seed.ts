/**
 * Development / UAT seed.
 *
 * Creates the companies, the §5.2 seed roles with their permissions, a sample
 * org tree matching the mockups, and the default masking rules.
 * Idempotent — safe to re-run.
 *
 *   npm run prisma:seed
 *
 * **Everything this file seeds is invented** — the names in mockup §16, the
 * two pilot request types, the placeholder ceilings. It therefore all lands in
 * `OSD_DEMO`, not `OSD`. `OSD` is the real organisation and is populated from
 * the interim Excel request logs by `import-osd-catalog.ts`; mixing the two
 * would put fictional people in the company's own org chart.
 *
 * The approval-matrix ceilings are **placeholders**. Open question A (§15.2)
 * has finance confirming the real T1/T2 per company; nothing here should be
 * mistaken for a signed-off number.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Mirrors libs/share/src/policy/permissions.ts. */
const PERMISSIONS: Record<string, string[]> = {
  request: [
    'request.create',
    'request.read',
    'request.read.all',
    'request.cancel.own',
    'request.cancel.any',
    'request.complete',
    'request.return',
    'request.hold',
    'request.sensitive.read',
  ],
  approval: ['approval.decide', 'approval.delegate', 'approval.history.read'],
  crm: [
    'crm.customer.read',
    'crm.customer.read.all',
    'crm.customer.manage',
    'crm.customer.sensitive.read',
    'crm.customer.dedup.override',
    'crm.customer.financial.read',
    'crm.sales.read',
    'crm.sales.read.all',
    'crm.sales.manage',
  ],
  report: ['report.request.read', 'report.dashboard.read'],
  user: ['user.read'],
  notification: ['notification.read'],
  audit: ['audit.read'],
  admin: [
    'admin.role.manage',
    'admin.org.manage',
    'admin.request-type.manage',
    'admin.approval-matrix.manage',
    'admin.sla.manage',
    'admin.bi.manage',
    'admin.identity.manage',
    'admin.crm.manage',
  ],
  integration: ['integration.request.create', 'integration.approval.create'],
};

/**
 * §5.2 seed roles and what each can do.
 *
 * `visibilityLevel` is how far up the holder's **own** branch their view
 * starts — the nearest ancestor of that kind, then everything beneath it. It is
 * not the withdrawn own/team/department/company/all rank: it names a level of
 * the chart and resolves against whoever holds the role, so `DEPARTMENT` on two
 * people in two departments reaches two different sets of rows. Involvement and
 * the groups a person heads still work exactly as before — see
 * `access-rules.ts`, which unions all three.
 *
 * The seed tree is COMPANY → DEPARTMENT → TEAM, so those are the levels used
 * here. A role with no level behaves as it did before this column existed.
 */
const SEED_ROLES: {
  code: string;
  name: string;
  description: string;
  permissions: string[];
  visibilityLevel?: 'COMPANY' | 'DIVISION' | 'DEPARTMENT' | 'POSITION' | 'TEAM';
}[] = [
  {
    /*
      Everything in the Request menu, for everybody (2 ก.ย. 2569).

      Authority over a request follows the org chart and involvement, not the
      role: `assertMayAct` decides who may complete, assign, hold, resume or
      cancel, and `authorise()` decides who may approve by reading the step's
      `candidateUserIds`. Holding the permission is now the price of entry to
      the menu, not the right to act on somebody else's ticket.

      `user.read` is deliberately **not** here — the two reads the submit screen
      needs accept `request.create` instead (`@AnyPermission`), which keeps the
      admin Users screen on a permission an employee does not have.
    */
    code: 'employee',
    name: 'พนักงาน',
    description: 'บทบาทพื้นฐานที่ทุกผู้ใช้ได้อัตโนมัติ',
    permissions: [
      'request.create',
      'request.read',
      'request.cancel.own',
      'request.complete',
      'request.return',
      'request.hold',
      'approval.decide',
      'notification.read',
      // CM-01: ทะเบียนลูกค้าเปิดให้พนักงานสร้าง–แก้ตามสิทธิ์ — scope narrows
      // what they *see* (own book + own drafts), not whether the menu exists.
      'crm.customer.read',
      'crm.customer.manage',
      'crm.sales.read',
      'crm.sales.manage',
    ],
  },
  {
    code: 'team_lead',
    name: 'หัวหน้าทีม',
    description: 'ผู้บังคับบัญชาระดับต้น — อนุมัติชั้นแรกทุกใบ',
    permissions: [
      'request.create',
      'request.read',
      'request.cancel.own',
      'request.return',
      'approval.decide',
      'approval.delegate',
      'notification.read',
      'user.read',
      'crm.customer.read',
      'crm.customer.manage',
      'crm.sales.read',
      'crm.sales.manage',
    ],
    visibilityLevel: 'TEAM',
  },
  {
    code: 'department_manager',
    name: 'ผู้จัดการฝ่าย',
    description: 'ผู้บังคับบัญชาระดับฝ่าย',
    permissions: [
      'request.create',
      'request.read',
      'request.cancel.any',
      'request.return',
      'request.sensitive.read',
      'approval.decide',
      'approval.delegate',
      'approval.history.read',
      'report.request.read',
      'report.dashboard.read',
      'notification.read',
      'user.read',
      'crm.customer.read',
      'crm.customer.read.all',
      'crm.customer.manage',
      'crm.customer.sensitive.read',
      // CM-03 (PO 8 ก.ย. 2569): only a granted role may confirm past the
      // similar-name warning.
      'crm.customer.dedup.override',
      'crm.customer.financial.read',
      'crm.sales.read',
      'crm.sales.read.all',
      'crm.sales.manage',
    ],
    visibilityLevel: 'DEPARTMENT',
  },
  {
    code: 'executive',
    name: 'ผู้บริหาร',
    description: 'ผู้อำนวยการ / C-level',
    permissions: [
      'request.read',
      'request.sensitive.read',
      'approval.decide',
      'approval.delegate',
      'approval.history.read',
      'report.request.read',
      'report.dashboard.read',
      'notification.read',
      'user.read',
      'crm.customer.read',
      'crm.customer.read.all',
      'crm.customer.sensitive.read',
      'crm.customer.financial.read',
      'crm.sales.read',
      'crm.sales.read.all',
      'crm.sales.manage',
    ],
    visibilityLevel: 'COMPANY',
  },
  {
    // §8.1 names `cfo` and `ceo` as approval offices above T1 and T2, and
    // `roleHolders()` looks them up by exactly these codes. Without them the
    // executive fallback answers for both, so a three-tier ladder resolves to
    // the same person twice — which reads as an approved request that only one
    // person actually judged.
    code: 'cfo',
    name: 'ประธานเจ้าหน้าที่ฝ่ายการเงิน',
    description: 'ผู้อนุมัติชั้นที่ 2 — วงเงินเกินเพดานระดับ 1',
    permissions: [
      'request.read',
      'request.sensitive.read',
      'approval.decide',
      'approval.delegate',
      'approval.history.read',
      'report.request.read',
      'report.dashboard.read',
      'notification.read',
      'user.read',
    ],
    visibilityLevel: 'COMPANY',
  },
  {
    code: 'ceo',
    name: 'ประธานเจ้าหน้าที่บริหาร',
    description: 'ผู้อนุมัติชั้นที่ 3 — วงเงินเกินเพดานระดับ 2',
    permissions: [
      'request.read',
      'request.sensitive.read',
      'approval.decide',
      'approval.delegate',
      'approval.history.read',
      'report.request.read',
      'report.dashboard.read',
      'notification.read',
      'user.read',
    ],
    visibilityLevel: 'COMPANY',
  },
  {
    // §5.2's destination team — Pricing for a discount request. The only role
    // §5.4 grants `request.complete`: closing the work is the receiver's call,
    // not the approver's, so REQ-08 has no holder at all without this role.
    code: 'receiver',
    name: 'ทีมผู้รับคำขอ',
    description: 'ผู้ปฏิบัติงานของทีมปลายทาง เช่น ทีม Pricing ที่รับคำขอส่วนลด',
    permissions: [
      'request.create',
      'request.read',
      'request.cancel.own',
      'request.return',
      'request.complete',
      'request.sensitive.read',
      'report.request.read',
      'notification.read',
      'user.read',
    ],
  },
  {
    // §5.2 is explicit that admins configure the system but hold no approval
    // authority — they cannot approve on anyone's behalf. §5.4 turns that into
    // an enforced guardrail: see `assertSeparationOfDuties`.
    code: 'admin',
    name: 'ผู้ดูแลระบบ',
    description: 'ทีมที่ดูแลการตั้งค่า — ไม่มีสิทธิ์อนุมัติแทนใคร',
    permissions: [
      'admin.role.manage',
      'admin.org.manage',
      'admin.request-type.manage',
      'admin.approval-matrix.manage',
      'admin.sla.manage',
      'admin.bi.manage',
      'admin.identity.manage',
      'admin.crm.manage',
      'audit.read',
      'user.read',
      'notification.read',
      'request.read',
      'request.read.all',
      'crm.customer.read',
      'crm.customer.read.all',
    ],
  },
  {
    code: 'auditor',
    name: 'ผู้ตรวจสอบ',
    description: 'ตรวจสอบภายใน — อ่านอย่างเดียว ข้ามบริษัทได้',
    permissions: [
      'request.read',
      'request.read.all',
      'request.sensitive.read',
      'approval.history.read',
      'report.request.read',
      'report.dashboard.read',
      'audit.read',
      'user.read',
      'crm.customer.read',
      'crm.customer.read.all',
      'crm.customer.sensitive.read',
    ],
  },
];

async function seedPermissions() {
  const rows = Object.entries(PERMISSIONS).flatMap(([module, codes]) =>
    codes.map((code) => ({ code, module })),
  );

  await prisma.permission.createMany({ data: rows, skipDuplicates: true });
  console.log(`  permissions: ${rows.length}`);
}

/**
 * `OSD_DEMO` first: it is the one this file fills, and `demoCompany()` below
 * reads it by code rather than by position so the order here stays a detail.
 *
 * `OSD` is created empty. Its org tree, request types and people come from
 * `import-osd-catalog.ts`, which reads the departments' own request logs.
 */
async function seedCompanies() {
  const companies = [
    { code: 'OSD_DEMO', name: 'OSD (Demo)', docPrefix: 'OSDD', baseCurrency: 'THB' },
    { code: 'OSD', name: 'OSD', docPrefix: 'OSD', baseCurrency: 'THB' },
    // A separate business, not a division of OSD: its 26 people carry `L-*`
    // employee codes and its own department names. Created empty here for the
    // same reason `OSD` is — `import-osd-catalog.ts` fills it from the staff
    // register.
    { code: 'LEXTECH', name: 'LEXTECH', docPrefix: 'LEX', baseCurrency: 'THB' },
    { code: 'BCO', name: 'บริษัท B', docPrefix: 'BCO', baseCurrency: 'THB' },
  ];

  const saved = [];
  for (const company of companies) {
    saved.push(
      await prisma.company.upsert({
        where: { code: company.code },
        update: company,
        create: company,
      }),
    );
  }

  console.log(`  companies: ${saved.map((c) => c.code).join(', ')}`);
  return saved;
}

async function seedRoles(companyId: string) {
  for (const role of SEED_ROLES) {
    const saved = await prisma.role.upsert({
      where: { companyId_code: { companyId, code: role.code } },
      update: {
        name: role.name,
        description: role.description,
        isSystem: true,
        visibilityLevel: role.visibilityLevel ?? null,
      },
      create: {
        companyId,
        code: role.code,
        name: role.name,
        description: role.description,
        isSystem: true,
        visibilityLevel: role.visibilityLevel ?? null,
      },
    });

    await prisma.rolePermission.deleteMany({ where: { roleId: saved.id } });
    await prisma.rolePermission.createMany({
      data: role.permissions.map((permissionCode) => ({
        roleId: saved.id,
        permissionCode,
      })),
      skipDuplicates: true,
    });

    /*
      No `ScopeRule` rows are written any more.

      The own/team/department/company/all levels were withdrawn on 31 ส.ค. 2569
      — `access-rules.ts` decides row visibility now, from involvement and from
      the groups a person heads. The table, its repository and its admin
      endpoint are kept on purpose (the screen is hidden, not deleted), but
      seeding rows nothing reads made the old model look alive: `user: 'team'`
      sitting here is what made it look as though a plain employee could still
      read the directory, and that is why nobody noticed they had lost it until
      the receiver picker came back empty on 2 ก.ย. 2569.
    */
  }

  console.log(`  roles: ${SEED_ROLES.length}`);
}

/** The tree from mockup A3. */
async function seedOrgTree(companyId: string) {
  const units = [
    { code: 'ROOT', name: 'บริษัท OSD (Demo)', kind: 'COMPANY' as const, parent: null },
    { code: 'SALES', name: 'ฝ่ายขาย', kind: 'DEPARTMENT' as const, parent: 'ROOT' },
    { code: 'FIN', name: 'ฝ่ายการเงิน', kind: 'DEPARTMENT' as const, parent: 'ROOT' },
    { code: 'GETTER1', name: 'ทีมขาย Getter 1', kind: 'TEAM' as const, parent: 'SALES' },
    { code: 'KEEPER1', name: 'ทีมขาย Keeper 1', kind: 'TEAM' as const, parent: 'SALES' },
    { code: 'PRICING', name: 'ทีม Pricing', kind: 'TEAM' as const, parent: 'ROOT' },
  ];

  const byCode = new Map<string, string>();

  for (const unit of units) {
    const saved = await prisma.orgUnit.upsert({
      where: { companyId_code: { companyId, code: unit.code } },
      update: {
        name: unit.name,
        kind: unit.kind,
        parentId: unit.parent ? byCode.get(unit.parent) : null,
      },
      create: {
        companyId,
        code: unit.code,
        name: unit.name,
        kind: unit.kind,
        parentId: unit.parent ? byCode.get(unit.parent) : null,
      },
    });

    byCode.set(unit.code, saved.id);
  }

  // Rebuild the closure the same way OrgService does after an edit.
  const nodes = await prisma.orgUnit.findMany({
    where: { companyId },
    select: { id: true, parentId: true },
  });

  await prisma.orgClosure.deleteMany({ where: { ancestor: { companyId } } });

  const parentOf = new Map(nodes.map((n) => [n.id, n.parentId]));
  const rows: { ancestorId: string; descendantId: string; depth: number }[] = [];

  for (const node of nodes) {
    let depth = 0;
    let current: string | null = node.id;

    while (current) {
      rows.push({ ancestorId: current, descendantId: node.id, depth });
      current = parentOf.get(current) ?? null;
      depth += 1;
    }
  }

  await prisma.orgClosure.createMany({ data: rows });
  console.log(`  org units: ${units.length} (closure rows: ${rows.length})`);
}

async function seedSensitiveFields() {
  // §15.1 item 6: discount % and margin on a discount request, visible only to
  // the requester and the approval chain.
  const rules = [
    {
      resource: 'request:DSC',
      field: 'discount_pct',
      visibleToPermission: 'request.sensitive.read',
    },
    {
      resource: 'request:DSC',
      field: 'est_margin_pct',
      visibleToPermission: 'request.sensitive.read',
    },
    // CM-08: เลขผู้เสียภาษี is masked for callers without the CRM sensitive
    // read; the interceptor drops it from list and detail responses alike.
    {
      resource: 'customer',
      field: 'taxId',
      visibleToPermission: 'crm.customer.sensitive.read',
    },
  ];

  for (const rule of rules) {
    await prisma.sensitiveFieldRule.upsert({
      where: { resource_field: { resource: rule.resource, field: rule.field } },
      update: { visibleToPermission: rule.visibleToPermission },
      create: rule,
    });
  }

  console.log(`  sensitive field rules: ${rules.length}`);
}

/**
 * A two-level ladder for the demo discount type.
 *
 * No ceilings: the amount tiers were withdrawn on 31 Aug 2026 (declared
 * amendment, §8 of `docs/ctd-foundation-spec.md`). Step 1 is the head of the
 * group the requester sits in, step 2 the head of the department above — which
 * is what the demo chart is built to show.
 */
async function seedApprovalMatrix(companyId: string) {
  const existing = await prisma.approvalMatrix.findFirst({
    where: { companyId, subjectType: 'request:DSC' },
  });
  if (existing) {
    console.log('  approval matrix: already present, left alone');
    return;
  }

  await prisma.approvalMatrix.create({
    data: {
      companyId,
      subjectType: 'request:DSC',
      currency: 'THB',
      version: 1,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      // Published, or `findEffective` would never return it and no case could
      // ever be routed — a draft matrix is deliberately inert.
      publishedAt: new Date('2026-01-01T00:00:00Z'),
      levels: [
        { type: 'supervisor', up: 1 },
        { type: 'supervisor', up: 2 },
      ],
      // NOT NULL and read by nothing. Kept so the column has a well-formed
      // value; see the note on `ApprovalMatrix.tiers`.
      tiers: [{ upto: null, chain: ['team_lead'] }],
      createdBy: 'seed',
    },
  });

  console.log('  approval matrix: v1 · หัวหน้าหน่วยงาน → หัวหน้าแผนก');
}

/**
 * The two pilot request types (§1). Configuration, not code — REQ-01 requires
 * that the 3rd..30th type needs no migration and no deploy, so everything
 * about a type lives in these columns.
 *
 * ขอส่วนลด has an approval ladder and ส่งต่อโอกาสการขาย has none, so between
 * them they cover both shapes the engine has to handle: work that is checked
 * after it is finished, and work that is simply finished.
 */
async function seedRequestTypes(
  demoCompanyId: string,
  companies: { id: string; code: string }[],
) {
  const osdRoot = await prisma.orgUnit.findFirst({
    where: { companyId: demoCompanyId, code: 'PRICING' },
  });
  const sales = await prisma.orgUnit.findFirst({
    where: { companyId: demoCompanyId, code: 'SALES' },
  });

  const types = [
    {
      code: 'DSC',
      name: 'ขอส่วนลด',
      receiverOrgUnitId: osdRoot?.id ?? null,
      /**
       * Titles are the exact strings §16 หน้าที่ 3 shows — the screen renders
       * them verbatim, so a reworded title here silently reworders the screen.
       *
       * `x-order` is not decoration. `formSchema` is stored as `jsonb`, which
       * does **not** preserve key order: Postgres returns keys sorted by length
       * then bytes, so authoring order here reached the browser as
       * reason → deal_value → discount_pct → customer_name → est_margin_pct.
       * JSON Schema has no ordering of its own, so the order has to be a value.
       */
      formSchema: {
        type: 'object',
        required: [
          'customer_name',
          'deal_value',
          'discount_pct',
          'est_margin_pct',
          'reason',
        ],
        properties: {
          deal_value: {
            type: 'number',
            title: 'มูลค่าดีล (THB)',
            minimum: 0,
            'x-order': 10,
          },
          discount_pct: {
            type: 'number',
            title: '% ส่วนลดที่ขอ',
            minimum: 0,
            maximum: 100,
            'x-order': 20,
          },
          // Sensitive (SCOPE-04) — the seeded request:DSC rules name this and
          // discount_pct, so only request.sensitive.read sees the values.
          est_margin_pct: {
            type: 'number',
            title: 'margin โดยประมาณ (%)',
            'x-sensitive': true,
            'x-order': 30,
          },
          // §16 shows this filled from the deal and therefore unmarked. There
          // is no deal lookup yet (REQ-06), so it stays a required field the
          // requester types — an input that pretends to autofill and does not
          // is worse than an honest one.
          customer_name: { type: 'string', title: 'ลูกค้า', 'x-order': 40 },
          reason: {
            type: 'string',
            title: 'เหตุผลการขอส่วนลด',
            maxLength: 2000,
            'x-multiline': true,
            'x-order': 50,
          },
        },
      },
      requiredDocs: [
        { code: 'QUOTE_DRAFT', name: 'ใบเสนอราคาฉบับร่าง' },
      ],
      /*
        §16 A2 and หน้าที่ 5 both print this list; the screen offers exactly
        these and the server validates against them (REQ-04).

        `name`, like `requiredDocs` above and like `CodedLabelDto` — this list
        was seeded with `label` until 1 ก.ย. 2569, which made A2 unable to save
        either seeded type: the screen loaded entries with no `name`, sent them
        back untouched, and the DTO rejected them. One shape, everywhere.
      */
      returnReasonCodes: [
        { code: 'DOC_INCOMPLETE', name: 'เอกสารไม่ครบ' },
        { code: 'MARGIN_WRONG', name: 'ตัวเลข margin ไม่ถูกต้อง' },
        { code: 'REASON_INSUFFICIENT', name: 'เหตุผลไม่เพียงพอ' },
        { code: 'OTHER', name: 'อื่น ๆ (ระบุ)' },
      ],
      // The amount field is what APV-02 measures against the matrix ceilings.
      approvalPolicy: { mode: 'standard_chain', amount_field: 'deal_value' },
      slaHours: 24,
    },
    {
      /**
       * CM-04 (ชุดงาน B) — คำขอ KYC ลูกค้า. ยื่นได้เสมอจากหน้าลูกค้า
       * (KYC เป็นกระบวนการปกติ ไม่ block — PO 8 ก.ย. 2569); เมื่อคำขอนี้
       * complete, KycCallbackService ติด kycVerified ให้ลูกค้าที่อ้างใน ref.
       */
      code: 'KYC',
      name: 'KYC ลูกค้า',
      receiverOrgUnitId: osdRoot?.id ?? null,
      formSchema: {
        type: 'object',
        required: ['customer_code', 'customer_name'],
        properties: {
          customer_code: {
            type: 'string',
            title: 'รหัสลูกค้า',
            'x-order': 10,
          },
          customer_name: { type: 'string', title: 'ชื่อลูกค้า', 'x-order': 20 },
          note: {
            type: 'string',
            title: 'หมายเหตุ',
            maxLength: 2000,
            'x-multiline': true,
            'x-order': 30,
          },
        },
      },
      requiredDocs: [
        { code: 'COMPANY_CERT', name: 'หนังสือรับรองบริษัท' },
        { code: 'VAT20', name: 'ภ.พ.20 / เอกสารภาษี' },
        { code: 'AUTH_SIGNATORY', name: 'เอกสารผู้มีอำนาจลงนาม' },
      ],
      returnReasonCodes: [
        { code: 'DOC_INCOMPLETE', name: 'เอกสารไม่ครบ' },
        { code: 'DOC_EXPIRED', name: 'เอกสารหมดอายุ' },
        { code: 'OTHER', name: 'อื่น ๆ' },
      ],
      approvalPolicy: {},
      slaHours: 48,
    },
    {
      code: 'LEAD',
      name: 'ส่งต่อโอกาสการขาย',
      receiverOrgUnitId: sales?.id ?? null,
      formSchema: {
        type: 'object',
        required: ['customer_name', 'to_team', 'reason'],
        properties: {
          customer_name: { type: 'string', title: 'ลูกค้า', 'x-order': 10 },
          to_team: { type: 'string', title: 'ส่งต่อให้ทีม', 'x-order': 20 },
          contact: { type: 'string', title: 'ผู้ติดต่อ', 'x-order': 30 },
          reason: {
            type: 'string',
            title: 'เหตุผล',
            maxLength: 2000,
            'x-multiline': true,
            'x-order': 40,
          },
        },
      },
      requiredDocs: [],
      returnReasonCodes: [
        { code: 'INFO_INCOMPLETE', name: 'ข้อมูลไม่ครบ' },
        { code: 'WRONG_TEAM', name: 'ส่งผิดทีม' },
        { code: 'OTHER', name: 'อื่น ๆ' },
      ],
      // `approvalPolicy` is vestigial: the route lives on the matrix, and the
      // amount field it used to name was withdrawn with the ceilings.
      approvalPolicy: {},
      slaHours: 8,
    },
  ];

  for (const type of types) {
    const saved = await prisma.requestType.upsert({
      where: { code: type.code },
      update: {
        name: type.name,
        receiverOrgUnitId: type.receiverOrgUnitId,
        formSchema: type.formSchema,
        requiredDocs: type.requiredDocs,
        returnReasonCodes: type.returnReasonCodes,
        approvalPolicy: type.approvalPolicy,
        slaHours: type.slaHours,
        active: true,
        updatedBy: 'seed',
      },
      create: {
        code: type.code,
        name: type.name,
        receiverOrgUnitId: type.receiverOrgUnitId,
        formSchema: type.formSchema,
        requiredDocs: type.requiredDocs,
        returnReasonCodes: type.returnReasonCodes,
        approvalPolicy: type.approvalPolicy,
        slaHours: type.slaHours,
        active: true,
        createdBy: 'seed',
      },
    });

    // Available in every company that has no catalog of its own (D-11); a
    // company can deactivate its own. `OSD` and `LEXTECH` are excluded: their
    // real types come from the departments' request logs, and DSC/LEAD are
    // invented.
    for (const company of companies.filter(
      (entry) => entry.code !== 'OSD' && entry.code !== 'LEXTECH',
    )) {
      await prisma.requestTypeCompany.upsert({
        where: {
          requestTypeId_companyId: {
            requestTypeId: saved.id,
            companyId: company.id,
          },
        },
        update: {},
        create: { requestTypeId: saved.id, companyId: company.id },
      });
    }
  }

  console.log(`  request types: ${types.map((t) => t.code).join(', ')}`);
}

/**
 * CM-07 — the four starter dimensions the spec names. Values are
 * configuration an admin edits from the screen; `size` and `potential` get
 * conventional starters so UAT has something to assign.
 */
async function seedCrmDefaults(companyId: string) {
  const dimensions: {
    code: string;
    nameTh: string;
    sortOrder: number;
    values: { code: string; nameTh: string; sortOrder: number }[];
  }[] = [
    { code: 'type', nameTh: 'ประเภทลูกค้า', sortOrder: 1, values: [] },
    {
      code: 'size',
      nameTh: 'ขนาด',
      sortOrder: 2,
      values: [
        { code: 's', nameTh: 'เล็ก (S)', sortOrder: 1 },
        { code: 'm', nameTh: 'กลาง (M)', sortOrder: 2 },
        { code: 'l', nameTh: 'ใหญ่ (L)', sortOrder: 3 },
      ],
    },
    { code: 'industry', nameTh: 'อุตสาหกรรม', sortOrder: 3, values: [] },
    {
      code: 'potential',
      nameTh: 'ศักยภาพ',
      sortOrder: 4,
      values: [
        { code: 'a', nameTh: 'ศักยภาพสูง (A)', sortOrder: 1 },
        { code: 'b', nameTh: 'ศักยภาพปานกลาง (B)', sortOrder: 2 },
        { code: 'c', nameTh: 'ศักยภาพทั่วไป (C)', sortOrder: 3 },
      ],
    },
  ];

  for (const dim of dimensions) {
    const saved = await prisma.customerSegmentDimension.upsert({
      where: { companyId_code: { companyId, code: dim.code } },
      update: { nameTh: dim.nameTh, sortOrder: dim.sortOrder },
      create: {
        companyId,
        code: dim.code,
        nameTh: dim.nameTh,
        sortOrder: dim.sortOrder,
      },
    });

    for (const value of dim.values) {
      await prisma.customerSegmentValue.upsert({
        where: { dimensionId_code: { dimensionId: saved.id, code: value.code } },
        update: { nameTh: value.nameTh, sortOrder: value.sortOrder },
        create: { dimensionId: saved.id, ...value },
      });
    }
  }

  console.log(`  crm segment dimensions: ${dimensions.length}`);

  // เหตุผลปิดแพ้มาตรฐาน (spec: ปิดแพ้ต้องระบุเหตุผลจากรายการมาตรฐาน
  // เพื่อนำมาวิเคราะห์ได้) — ค่าตั้งต้น แก้/เพิ่มได้ภายหลัง.
  const lostReasons = [
    { code: 'price', name: 'ราคาสู้ไม่ได้', sortOrder: 1 },
    { code: 'competitor', name: 'แพ้คู่แข่ง', sortOrder: 2 },
    { code: 'no_budget', name: 'ลูกค้าไม่มีงบ/เลื่อนงบ', sortOrder: 3 },
    { code: 'no_decision', name: 'ลูกค้าไม่ตัดสินใจ/เงียบหาย', sortOrder: 4 },
    { code: 'requirement', name: 'ตอบโจทย์ความต้องการไม่ได้', sortOrder: 5 },
    { code: 'other', name: 'อื่น ๆ (ระบุ)', sortOrder: 9 },
  ];
  for (const reason of lostReasons) {
    await prisma.dealLostReason.upsert({
      where: { companyId_code: { companyId, code: reason.code } },
      update: { name: reason.name, sortOrder: reason.sortOrder, active: true },
      create: { companyId, ...reason },
    });
  }
  console.log(`  deal lost reasons: ${lostReasons.length}`);
}

async function main() {
  console.log('Seeding CTD foundation data…');

  await seedPermissions();
  const companies = await seedCompanies();

  // Read by code, never by position: this file seeds the *demo* company, and
  // a positional lookup silently seeds the wrong one the moment the list is
  // reordered — which is exactly what it did before `OSD_DEMO` existed.
  const demo = companies.find((company) => company.code === 'OSD_DEMO');
  if (!demo) throw new Error('OSD_DEMO is missing from seedCompanies().');

  // Roles are per company (ROLE-04) — a manager in one company is not a
  // manager in another. Seed the full set into every company so that
  // isolation is real rather than an artefact of only one company having
  // any roles at all.
  for (const company of companies) {
    await seedRoles(company.id);
    await seedCrmDefaults(company.id);
  }

  await seedOrgTree(demo.id);
  await seedSensitiveFields();
  await seedRequestTypes(demo.id, companies);
  await seedApprovalMatrix(demo.id);

  console.log('Done.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
