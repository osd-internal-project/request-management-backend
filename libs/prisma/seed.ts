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
import {
  ALL_PERMISSIONS,
  Permission,
  permissionModule,
  permissionType,
} from '../share/src/policy/permissions';

const prisma = new PrismaClient();

/**
 * ทุกสิทธิ์อ่านของคนที่ `admin` ไม่ได้รับ แม้ชื่อจะลงท้าย `.read`.
 *
 * `request.sensitive.read` ถูก §5.4 ห้ามถือคู่กับ `admin.*` — ใส่เข้าไปจะโดน
 * `assertSeparationOfDuties` ตีกลับ 422 อีกสองตัวเป็นการถอดหน้ากากข้อมูล ซึ่ง
 * CM-08/C360-02 ออกแบบให้ตั้งรายบทบาท ไม่ใช่ของแถมของผู้ดูแลระบบ.
 */
const ADMIN_READ_EXCLUSIONS: readonly Permission[] = [
  'request.sensitive.read',
  'crm.customer.sensitive.read',
  'crm.customer.financial.read',
];

/**
 * สิทธิ์ของ `admin` — ทุกสิทธิ์ตั้งค่า บวกทุกสิทธิ์อ่านของคน.
 *
 * คำนวณจาก catalog แทนที่จะพิมพ์เป็นรายการ เพราะรายการเดิมตกหล่น
 * `admin.integration.manage` เงียบ ๆ ตั้งแต่ 14 ก.ย. 2569 และจะตกหล่นซ้ำทุกครั้งที่
 * เพิ่มหน้า admin ใหม่ — หน้าที่ผู้ดูแลระบบมองไม่เห็นคือหน้าที่ไม่มีใครดูแล.
 *
 * `permissionType` กัน `integration.*` ออก: นั่นคือสิทธิ์ของบัญชีบริการ (AUTH-06)
 * ไม่ใช่ของคน. `approval.decide` ไม่เข้าเงื่อนไขอยู่แล้วเพราะไม่ใช่สิทธิ์อ่าน ซึ่งตรงกับ
 * §5.2 ที่ว่าผู้ดูแลระบบตั้งค่าได้แต่อนุมัติแทนใครไม่ได้.
 */
function adminPermissions(): Permission[] {
  return ALL_PERMISSIONS.filter(
    (code) =>
      permissionType(code) === 'human' &&
      !ADMIN_READ_EXCLUSIONS.includes(code) &&
      (code.startsWith('admin.') ||
        code.endsWith('.read') ||
        code.endsWith('.read.all')),
  );
}

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
      'crm.target.manage',
      'crm.campaign.manage',
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
      'crm.target.manage',
      'crm.campaign.manage',
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
    // CD-161 — ฝ่ายกฎหมาย keeps the contract repository: records contracts
    // (customers' and anyone else's), attaches the signed files, and decides
    // which are confidential. Reads customers company-wide to attach one.
    code: 'legal',
    name: 'ฝ่ายกฎหมาย',
    description: 'ดูแลคลังสัญญา — บันทึกสัญญา แนบไฟล์ และกำหนดสัญญาลับพิเศษ',
    permissions: [
      'request.create',
      'request.read',
      'request.cancel.own',
      'request.return',
      'request.complete',
      'notification.read',
      'user.read',
      'crm.customer.read',
      'crm.customer.read.all',
      'legal.contract.read',
      'legal.contract.manage',
      // CD-14 — sends the approved contract for signing
      'esign.manage',
    ],
  },
  {
    // §5.2 is explicit that admins configure the system but hold no approval
    // authority — they cannot approve on anyone's behalf. §5.4 turns that into
    // an enforced guardrail: see `assertSeparationOfDuties`.
    code: 'admin',
    name: 'ผู้ดูแลระบบ',
    description: 'ทีมที่ดูแลการตั้งค่า — ไม่มีสิทธิ์อนุมัติแทนใคร',
    permissions: adminPermissions(),
  },
  {
    // CD-132 — the team that receives "ขอ Solution" requests and designs the
    // Solution. Holds the request receiver's actions plus Pre-Sales work.
    code: 'presales',
    name: 'ทีม Pre-Sales',
    description: 'รับโจทย์จากทีมขาย ออกแบบ Solution ขอบเขตงาน และ BOQ',
    permissions: [
      'request.create',
      'request.read',
      'request.cancel.own',
      'request.return',
      'request.complete',
      'notification.read',
      'user.read',
      'presales.solution.read',
      'presales.solution.manage',
    ],
  },
  {
    // CD-194 — the team that keeps reference prices and guards margin.
    code: 'pricing',
    name: 'ทีม Pricing',
    description: 'ดูแลราคามาตรฐาน ต้นทุน และ margin ก่อนออกใบเสนอราคา',
    permissions: [
      'request.create',
      'request.read',
      'notification.read',
      'user.read',
      'crm.sales.read',
      // CD-198 — Pricing prices every deal's quotation started from a Solution
      'crm.sales.read.all',
      'crm.sales.manage',
      'pricing.price.read',
      'pricing.price.manage',
    ],
  },
  {
    // CD-175 — ผู้จัดการโครงการ: opens a project from a signed contract,
    // with what was sold copied in, and runs it.
    code: 'pm',
    name: 'ผู้จัดการโครงการ',
    description: 'เปิดโครงการจากสัญญาที่ลงนามแล้ว กำหนดผู้จัดการและทีม',
    permissions: [
      'request.create',
      'request.read',
      'request.cancel.own',
      'request.return',
      'request.complete',
      'notification.read',
      'user.read',
      'pm.project.read',
      'pm.project.manage',
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
  const rows = ALL_PERMISSIONS.map((code) => ({
    code,
    module: permissionModule(code),
    // AUTH-06 — scope ของบัญชีบริการ ไม่ใช่สิทธิ์ที่คนถือทำงานประจำวัน
    type: permissionType(code),
  }));

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
    {
      code: 'OSD_DEMO',
      name: 'OSD (Demo)',
      docPrefix: 'OSDD',
      baseCurrency: 'THB',
    },
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
    {
      code: 'ROOT',
      name: 'บริษัท OSD (Demo)',
      kind: 'COMPANY' as const,
      parent: null,
    },
    {
      code: 'SALES',
      name: 'ฝ่ายขาย',
      kind: 'DEPARTMENT' as const,
      parent: 'ROOT',
    },
    {
      code: 'FIN',
      name: 'ฝ่ายการเงิน',
      kind: 'DEPARTMENT' as const,
      parent: 'ROOT',
    },
    {
      code: 'GETTER1',
      name: 'ทีมขาย Getter 1',
      kind: 'TEAM' as const,
      parent: 'SALES',
    },
    {
      code: 'KEEPER1',
      name: 'ทีมขาย Keeper 1',
      kind: 'TEAM' as const,
      parent: 'SALES',
    },
    {
      code: 'PRICING',
      name: 'ทีม Pricing',
      kind: 'TEAM' as const,
      parent: 'ROOT',
    },
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
  const rows: { ancestorId: string; descendantId: string; depth: number }[] =
    [];

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
    // CD-80: the cost the margin is computed from reveals it just as well.
    {
      resource: 'request:DSC',
      field: 'cost',
      visibleToPermission: 'request.sensitive.read',
    },
    // CD-201: the price approval carries the same figures.
    {
      resource: 'request:PRA',
      field: 'cost',
      visibleToPermission: 'request.sensitive.read',
    },
    {
      resource: 'request:PRA',
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
 * A two-level ladder for the demo discount type, approved **before** the work
 * (CD-80, user decision 28 ก.ย. 2569): the requester's own head (step 1) and
 * the head of the department above (step 2). Before the work, the ladder
 * climbs the requester's chart (`BEFORE_WORK`), so choosing a receiver no
 * longer changes who approves the discount.
 *
 * No ceilings: the amount tiers were withdrawn on 31 Aug 2026 (declared
 * amendment, §8 of `docs/ctd-foundation-spec.md`) and wait on CD-26.
 *
 * An environment seeded earlier has the after-work ladder `request:DSC`;
 * it is retired with a new version (never edited), or DSC would be approved
 * twice. Idempotent: a second run finds both done.
 */
async function seedApprovalMatrix(companyId: string) {
  const post = await prisma.approvalMatrix.findFirst({
    where: {
      companyId,
      subjectType: 'request:DSC',
      publishedAt: { not: null },
    },
    orderBy: { version: 'desc' },
  });
  if (post && !post.retired) {
    await prisma.approvalMatrix.create({
      data: {
        companyId,
        subjectType: 'request:DSC',
        currency: 'THB',
        version: post.version + 1,
        effectiveFrom: new Date(),
        publishedAt: new Date(),
        levels: [],
        tiers: [],
        retired: true,
        createdBy: 'seed',
      },
    });
    console.log('  approval matrix: after-work request:DSC retired (CD-80)');
  }

  const existing = await prisma.approvalMatrix.findFirst({
    where: { companyId, subjectType: 'request:DSC:pre' },
  });
  if (existing) {
    console.log('  approval matrix: request:DSC:pre already present');
    return;
  }

  await prisma.approvalMatrix.create({
    data: {
      companyId,
      subjectType: 'request:DSC:pre',
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

  console.log(
    '  approval matrix: request:DSC:pre v1 · หัวหน้าผู้ยื่น → หัวหน้าแผนก',
  );
}

/**
 * CD-79 — a starting list of standard trade terms for the demo company, only
 * when it has none (an admin's own list is never overwritten).
 */
async function seedTradeTerms(companyId: string) {
  const existing = await prisma.tradeTermStandard.count({
    where: { companyId },
  });
  if (existing) {
    console.log('  trade terms: already present, left alone');
    return;
  }
  const terms = [
    { code: 'PAYMENT', name: 'เครดิตการชำระเงิน', standardValue: '30 วัน' },
    { code: 'WARRANTY', name: 'การรับประกัน', standardValue: '1 ปี' },
    {
      code: 'PENALTY',
      name: 'ค่าปรับส่งมอบล่าช้า',
      standardValue: '0.1% ต่อวัน',
    },
    {
      code: 'DELIVERY',
      name: 'กำหนดส่งมอบ',
      standardValue: '30 วันหลังได้รับใบสั่งซื้อ',
    },
  ];
  await prisma.tradeTermStandard.createMany({
    data: terms.map((term, index) => ({
      ...term,
      companyId,
      sortOrder: index,
      updatedBy: 'seed',
    })),
  });
  console.log(`  trade terms: ${terms.length}`);
}

/**
 * CD-84 — a starting handover checklist for the demo company, only when it
 * has none (an admin's own list is never overwritten).
 */
async function seedHandoverItems(companyId: string) {
  const existing = await prisma.handoverChecklistItem.count({
    where: { companyId },
  });
  if (existing) {
    console.log('  handover checklist: already present, left alone');
    return;
  }
  const items = [
    {
      code: 'PRICE_MATCH',
      category: 'commercial' as const,
      label: 'ราคาและรายการในใบสั่งขายตรงกับใบเสนอราคาที่ลูกค้าตอบรับ',
      requiresDetail: false,
    },
    {
      code: 'PAYMENT_TERMS',
      category: 'commercial' as const,
      label: 'เงื่อนไขการชำระเงินและงวดเงิน',
      requiresDetail: true,
    },
    {
      code: 'SCOPE',
      category: 'requirement' as const,
      label: 'ขอบเขตงานและความต้องการของลูกค้า',
      requiresDetail: true,
    },
    {
      code: 'SITE_CONTACT',
      category: 'requirement' as const,
      label: 'ผู้ติดต่อหน้างานและสถานที่ส่งมอบ',
      requiresDetail: true,
    },
    {
      code: 'PROMISED_DATES',
      category: 'commitment' as const,
      label: 'กำหนดส่งมอบ/ติดตั้งที่แจ้งลูกค้าไว้',
      requiresDetail: true,
    },
    {
      code: 'EXTRAS',
      category: 'commitment' as const,
      label:
        'ของแถม ส่วนลด หรือสิ่งที่รับปากนอกใบเสนอราคา (ไม่มีให้ระบุว่า "ไม่มี")',
      requiresDetail: true,
    },
  ];
  await prisma.handoverChecklistItem.createMany({
    data: items.map((item, index) => ({
      ...item,
      companyId,
      sortOrder: index,
      updatedBy: 'seed',
    })),
  });
  console.log(`  handover checklist: ${items.length}`);
}

/**
 * CD-81 — points the demo company's contract card at `CTR`. Only when unset,
 * so an admin's own choice survives a re-seed.
 */
async function seedContractRequestType(companyId: string) {
  const config = await prisma.crmCompanyConfig.findUnique({
    where: { companyId },
    select: { contractRequestTypeCode: true },
  });
  if (!config) {
    await prisma.crmCompanyConfig.create({
      data: { companyId, contractRequestTypeCode: 'CTR', updatedBy: 'seed' },
    });
  } else if (!config.contractRequestTypeCode) {
    await prisma.crmCompanyConfig.update({
      where: { companyId },
      data: { contractRequestTypeCode: 'CTR', updatedBy: 'seed' },
    });
  }
  console.log('  contract request type: CTR');
}

/**
 * CD-130 — points the demo company's Solution card at `SOL`. Only when unset,
 * so an admin's own choice survives a re-seed.
 */
/**
 * CD-136 — labour cost per manday by role, until HR (CD-17) supplies real
 * rates. Placeholders an admin replaces in the CRM settings.
 */
const DEFAULT_LABOR_RATES = [
  { role: 'Engineer', rate: 4500 },
  { role: 'Senior Engineer', rate: 6000 },
  { role: 'Project Manager', rate: 7000 },
  { role: 'Technician', rate: 3000 },
];

async function seedSolutionRequestType(companyId: string) {
  const config = await prisma.crmCompanyConfig.findUnique({
    where: { companyId },
    select: {
      solutionRequestTypeCode: true,
      solutionApprovalTypeCode: true,
      demoRequestTypeCode: true,
      vendorQuoteTypeCode: true,
      presalesLaborRates: true,
    },
  });
  if (!config) {
    await prisma.crmCompanyConfig.create({
      data: {
        companyId,
        solutionRequestTypeCode: 'SOL',
        solutionApprovalTypeCode: 'SOLA',
        demoRequestTypeCode: 'DEMO',
        vendorQuoteTypeCode: 'VQ',
        presalesLaborRates: DEFAULT_LABOR_RATES,
        updatedBy: 'seed',
      },
    });
  } else {
    // Only what is still unset — a company's own choice is left alone.
    const data = {
      ...(config.solutionRequestTypeCode
        ? {}
        : { solutionRequestTypeCode: 'SOL' }),
      ...(config.solutionApprovalTypeCode
        ? {}
        : { solutionApprovalTypeCode: 'SOLA' }),
      ...(config.demoRequestTypeCode ? {} : { demoRequestTypeCode: 'DEMO' }),
      ...(config.vendorQuoteTypeCode ? {} : { vendorQuoteTypeCode: 'VQ' }),
      // CD-136 — a starting rate table only where none is set.
      ...(Array.isArray(config.presalesLaborRates) &&
      config.presalesLaborRates.length
        ? {}
        : { presalesLaborRates: DEFAULT_LABOR_RATES }),
    };
    if (Object.keys(data).length) {
      await prisma.crmCompanyConfig.update({
        where: { companyId },
        data: { ...data, updatedBy: 'seed' },
      });
    }
  }
  console.log('  solution request types: SOL, SOLA, DEMO, VQ');
}

/**
 * CD-143 — the `ขออนุมัติ Solution` ladder, after the work: the technical team
 * reviews the design, then the head of the reviewer's team and the director
 * above approve it (the ladder climbs the reviewer's chart). An admin moves it
 * to named groups on screen A1 when the real technical department exists.
 */
async function seedSolutionApprovalMatrix(companyId: string) {
  const existing = await prisma.approvalMatrix.findFirst({
    where: { companyId, subjectType: 'request:SOLA' },
  });
  if (existing) {
    console.log('  approval matrix: request:SOLA already present');
    return;
  }
  await prisma.approvalMatrix.create({
    data: {
      companyId,
      subjectType: 'request:SOLA',
      currency: 'THB',
      version: 1,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      publishedAt: new Date('2026-01-01T00:00:00Z'),
      levels: [
        { type: 'supervisor', up: 1 },
        { type: 'supervisor', up: 2 },
      ],
      // NOT NULL and read by nothing — see seedApprovalMatrix.
      tiers: [{ upto: null, chain: ['team_lead'] }],
      createdBy: 'seed',
    },
  });
  console.log(
    '  approval matrix: request:SOLA v1 · หัวหน้าผู้ตรวจ → ผู้อำนวยการถัดขึ้นไป',
  );
}

/**
 * CD-201 — the price approval ladder, before the work: the requester's head
 * always, the department head above 1,000,000 and the next level above
 * 5,000,000 (`net_total`, before VAT).
 *
 * CD-202 — and the executive level whenever a work type's margin is below its
 * minimum (`margin_below_minimum` = yes), due in one day. Seeded as the
 * third level up; the CFO/CEO group replaces it on the approval matrix
 * screen once it exists.
 *
 * **The amounts are placeholders** until Finance confirms the real limits
 * (CD-26). They are matrix data: an admin replaces them on the approval
 * matrix screen with a new version, no deploy.
 *
 * A ladder the seed published before CD-202 gets the executive level as a new
 * version (never edited); one an admin published is left to them.
 */
const PRICE_APPROVAL_EXECUTIVE_LEVEL = {
  type: 'supervisor',
  up: 3,
  condition: { field: 'margin_below_minimum', op: 'eq', value: 'yes' },
  slaHours: 24,
};

async function seedPriceApprovalMatrix(companyId: string) {
  const latest = await prisma.approvalMatrix.findFirst({
    where: { companyId, subjectType: 'request:PRA:pre' },
    orderBy: { version: 'desc' },
  });
  const levels = [
    { type: 'supervisor', up: 1 },
    {
      type: 'supervisor',
      up: 2,
      condition: { field: 'net_total', op: 'gt', value: 1000000 },
    },
    {
      type: 'supervisor',
      up: 3,
      condition: { field: 'net_total', op: 'gt', value: 5000000 },
    },
    PRICE_APPROVAL_EXECUTIVE_LEVEL,
  ];
  const hasExecutive = (value: unknown) =>
    Array.isArray(value) &&
    value.some(
      (level: { condition?: { field?: string } }) =>
        level?.condition?.field === 'margin_below_minimum',
    );

  if (latest && (hasExecutive(latest.levels) || latest.createdBy !== 'seed')) {
    console.log('  approval matrix: request:PRA:pre already present');
    return;
  }
  await prisma.approvalMatrix.create({
    data: {
      companyId,
      subjectType: 'request:PRA:pre',
      currency: 'THB',
      version: (latest?.version ?? 0) + 1,
      effectiveFrom: latest ? new Date() : new Date('2026-01-01T00:00:00Z'),
      publishedAt: latest ? new Date() : new Date('2026-01-01T00:00:00Z'),
      levels,
      // NOT NULL and read by nothing — see seedApprovalMatrix.
      tiers: [{ upto: null, chain: ['team_lead'] }],
      createdBy: 'seed',
    },
  });
  console.log(
    `  approval matrix: request:PRA:pre v${(latest?.version ?? 0) + 1} · หัวหน้า → >1ล้าน หัวหน้าแผนก → >5ล้าน ถัดขึ้นไป · margin ต่ำ → ผู้บริหาร (24 ชม.) (ตัวเลขชั่วคราว รอ CD-26)`,
  );
}

/**
 * CD-201 — quotations now ask PRA. A company still on DSC, the old default,
 * is moved; one that chose another type keeps it.
 */
async function seedPriceApprovalType(companyId: string) {
  const config = await prisma.crmCompanyConfig.findUnique({
    where: { companyId },
    select: { quotationApprovalTypeCode: true },
  });
  if (config?.quotationApprovalTypeCode === 'DSC') {
    await prisma.crmCompanyConfig.update({
      where: { companyId },
      data: { quotationApprovalTypeCode: 'PRA', updatedBy: 'seed' },
    });
  }
  console.log('  quotation approval type: PRA');
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
          'cost',
          'est_margin_pct',
          'reason',
        ],
        properties: {
          deal_value: {
            type: 'number',
            title: 'มูลค่าโอกาสการขาย (THB)',
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
          // CD-80 — what delivering the deal costs; the margin is computed
          // from it. Sensitive like the margin itself.
          cost: {
            type: 'number',
            title: 'ต้นทุน (THB)',
            minimum: 0,
            'x-sensitive': true,
            'x-order': 25,
          },
          // Sensitive (SCOPE-04) — the seeded request:DSC rules name this,
          // cost and discount_pct, so only request.sensitive.read sees them.
          // CD-80: computed by the system (screen live, server on save) —
          // never typed; see `computed-fields.ts`.
          est_margin_pct: {
            type: 'number',
            // Title as §16 prints it (spec:check reads it); the value is the
            // margin left after the discount, computed rather than estimated.
            title: 'margin โดยประมาณ (%)',
            'x-sensitive': true,
            'x-order': 30,
            'x-computed': {
              kind: 'margin_pct',
              value: 'deal_value',
              discount_pct: 'discount_pct',
              cost: 'cost',
            },
          },
          // §16 shows this filled from the opportunity and therefore unmarked. There
          // is no opportunity lookup yet (REQ-06), so it stays a required field the
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
      requiredDocs: [{ code: 'QUOTE_DRAFT', name: 'ใบเสนอราคาฉบับร่าง' }],
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
      // `amount_field` is inert since the amount tiers were withdrawn (31 Aug
      // 2026); kept so tiers can return once Finance confirms them (CD-26).
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
      /**
       * CD-61 — what the KYC reviewer records while closing the request. Read
       * by `KycCallbackService` when it completes: the risk (empty = the
       * system's suggestion), the earliest document expiry (it caps the
       * review date), the signatories, and — only when the customer matched
       * the prohibited list — why it is accepted anyway. The 360° KYC card
       * shows the live screening before the reviewer decides.
       */
      receiverFormSchema: {
        type: 'object',
        required: [],
        properties: {
          risk_level: {
            type: 'string',
            title: 'ระดับความเสี่ยง (เว้นว่าง = ใช้ที่ระบบแนะนำ)',
            enum: ['ต่ำ', 'กลาง', 'สูง'],
            'x-order': 10,
          },
          documents_expire_on: {
            type: 'string',
            format: 'date',
            title: 'เอกสารฉบับแรกที่หมดอายุ',
            'x-order': 20,
          },
          signatories: {
            type: 'string',
            title: 'ผู้มีอำนาจลงนาม (ชื่อ · ตำแหน่ง · เงื่อนไขการลงนาม)',
            maxLength: 2000,
            'x-multiline': true,
            'x-order': 30,
          },
          screening_clearance: {
            type: 'string',
            title: 'เหตุผลที่ยกเว้น (กรอกเฉพาะเมื่อชื่อตรงกับรายชื่อต้องห้าม)',
            maxLength: 2000,
            'x-multiline': true,
            'x-order': 40,
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
    // CD-62 — อนุมัติเปิดลูกค้าใหม่ ต่อประเภทลูกค้า (เอกสารบังคับต่างกัน). ยังไม่เปิดใช้
    // จนกว่าผู้ดูแลเลือกประเภทเหล่านี้ในหน้าตั้งค่า CRM; ลูกค้าใหม่ส่ง SAP ได้เมื่อคำขอ
    // ได้รับอนุมัติ (CustomerApprovalService).
    ...(
      [
        {
          code: 'NCA-CORP',
          name: 'อนุมัติเปิดลูกค้าใหม่ (นิติบุคคล)',
          docs: [
            {
              code: 'COMPANY_CERT',
              name: 'หนังสือรับรองบริษัท (ไม่เกิน 3 เดือน)',
            },
            { code: 'VAT20', name: 'ภ.พ.20' },
            { code: 'AUTH_ID', name: 'สำเนาบัตรประชาชนผู้มีอำนาจลงนาม' },
          ],
        },
        {
          code: 'NCA-IND',
          name: 'อนุมัติเปิดลูกค้าใหม่ (บุคคลธรรมดา)',
          docs: [
            { code: 'ID_CARD', name: 'สำเนาบัตรประชาชน' },
            { code: 'HOUSE_REG', name: 'สำเนาทะเบียนบ้าน' },
          ],
        },
        {
          code: 'NCA-GOV',
          name: 'อนุมัติเปิดลูกค้าใหม่ (หน่วยงานรัฐ)',
          docs: [
            {
              code: 'GOV_LETTER',
              name: 'หนังสือแจ้งจัดซื้อ/จัดจ้าง หรือหนังสือแต่งตั้ง',
            },
            {
              code: 'TAX_ID_DOC',
              name: 'เอกสารเลขประจำตัวผู้เสียภาษีของหน่วยงาน',
            },
          ],
        },
      ] as const
    ).map((nca) => ({
      code: nca.code,
      name: nca.name,
      receiverOrgUnitId: osdRoot?.id ?? null,
      formSchema: {
        type: 'object',
        required: ['customer_code', 'customer_name'],
        properties: {
          customer_code: { type: 'string', title: 'รหัสลูกค้า', 'x-order': 10 },
          customer_name: { type: 'string', title: 'ชื่อลูกค้า', 'x-order': 20 },
          customer_type: {
            type: 'string',
            title: 'ประเภทลูกค้า',
            'x-order': 30,
          },
          tax_id: {
            type: 'string',
            title: 'เลขประจำตัวผู้เสียภาษี',
            'x-order': 40,
          },
          credit_request: {
            type: 'string',
            title: 'วงเงิน/เครดิตที่ขอ (ถ้ามี)',
            maxLength: 500,
            'x-order': 50,
          },
          note: {
            type: 'string',
            title: 'หมายเหตุ',
            maxLength: 2000,
            'x-multiline': true,
            'x-order': 60,
          },
        },
      },
      requiredDocs: nca.docs.map((doc) => ({ ...doc })),
      returnReasonCodes: [
        { code: 'DOC_INCOMPLETE', name: 'เอกสารไม่ครบ' },
        { code: 'DOC_EXPIRED', name: 'เอกสารหมดอายุ' },
        { code: 'INFO_MISMATCH', name: 'ข้อมูลลูกค้าไม่ตรงเอกสาร' },
        { code: 'OTHER', name: 'อื่น ๆ' },
      ],
      approvalPolicy: {},
      slaHours: 24,
    })),
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
    {
      /**
       * CD-81 — ขอให้ฝ่ายกฎหมายจัดทำ/แก้สัญญา ยื่นจากหน้าดีล และติดตามสถานะ
       * ร่างจากหน้าดีลได้ (การ์ดสัญญา). Demo only: a real company points its
       * CRM setting `contractRequestTypeCode` at the type its Legal team
       * already receives. No ladder — Legal drafting is work, not a permission.
       */
      code: 'CTR',
      name: 'ขอจัดทำ/แก้ไขสัญญา',
      receiverOrgUnitId: null,
      formSchema: {
        type: 'object',
        required: ['contract_kind', 'counterparty', 'scope'],
        properties: {
          contract_kind: {
            type: 'string',
            title: 'ประเภทงานสัญญา',
            enum: ['ทำสัญญาใหม่', 'แก้ไขสัญญา', 'ต่ออายุสัญญา'],
            'x-order': 10,
          },
          counterparty: { type: 'string', title: 'คู่สัญญา', 'x-order': 20 },
          contract_value: {
            type: 'number',
            title: 'มูลค่าสัญญา (THB)',
            minimum: 0,
            'x-order': 30,
          },
          start_date: {
            type: 'string',
            format: 'date',
            title: 'วันเริ่มสัญญา',
            'x-order': 40,
          },
          end_date: {
            type: 'string',
            format: 'date',
            title: 'วันสิ้นสุดสัญญา',
            'x-order': 50,
          },
          scope: {
            type: 'string',
            title: 'ขอบเขตงานและสาระสำคัญ',
            maxLength: 4000,
            'x-multiline': true,
            'x-order': 60,
          },
          non_standard_terms: {
            type: 'string',
            title: 'เงื่อนไขที่ต่างจากสัญญามาตรฐาน',
            maxLength: 4000,
            'x-multiline': true,
            'x-order': 70,
          },
          // CD-133 — filled from the deal's approved Solution when raised
          // from the deal page; what the customer and third parties must
          // provide goes into the contract as its assumptions.
          dependencies: {
            type: 'string',
            title: 'สมมติฐานและสิ่งที่ต้องพึ่งพา (จาก Solution)',
            maxLength: 20000,
            'x-multiline': true,
            'x-order': 80,
          },
        },
      },
      requiredDocs: [],
      returnReasonCodes: [
        { code: 'INFO_INCOMPLETE', name: 'ข้อมูลไม่ครบ' },
        { code: 'TERMS_UNCLEAR', name: 'เงื่อนไขไม่ชัดเจน' },
        { code: 'OTHER', name: 'อื่น ๆ' },
      ],
      approvalPolicy: {},
      slaHours: 40,
    },
    {
      /**
       * CD-130 — ขอ Solution และประเมินต้นทุน (Sales → Pre-Sales · หัวหน้า Pre-Sales
       * · 2 วัน). Raised from the deal's Solution card, so it must name the deal.
       * Its required fields are handoff gate 2: the requirement checklist and the
       * customer's rough budget — missing any, it cannot be submitted.
       */
      code: 'SOL',
      name: 'ขอ Solution และประเมินต้นทุน',
      receiverOrgUnitId: osdRoot?.id ?? null,
      refRequired: true,
      formSchema: {
        type: 'object',
        required: [
          'requirement',
          'scope',
          'site',
          'timeline',
          'decision_maker',
          'budget_range',
        ],
        properties: {
          requirement: {
            type: 'string',
            title: 'ปัญหา / ความต้องการของลูกค้า',
            maxLength: 4000,
            'x-multiline': true,
            'x-order': 10,
          },
          scope: {
            type: 'string',
            title: 'ขอบเขตงานคร่าว ๆ (ระบบ จำนวน พื้นที่)',
            maxLength: 4000,
            'x-multiline': true,
            'x-order': 20,
          },
          site: {
            type: 'string',
            title: 'สถานที่ / ไซต์งาน',
            maxLength: 500,
            'x-order': 30,
          },
          timeline: {
            type: 'string',
            title: 'กำหนดเวลาที่ลูกค้าต้องการ',
            maxLength: 200,
            'x-order': 40,
          },
          decision_maker: {
            type: 'string',
            title: 'ผู้ตัดสินใจฝั่งลูกค้า (ชื่อ · ตำแหน่ง)',
            maxLength: 300,
            'x-order': 50,
          },
          budget_range: {
            type: 'string',
            title: 'กรอบงบประมาณคร่าวของลูกค้า',
            enum: [
              'ต่ำกว่า 500,000',
              '500,000 – 2 ล้าน',
              '2 – 10 ล้าน',
              'มากกว่า 10 ล้าน',
              'ลูกค้ายังไม่ระบุ แต่ยืนยันว่ามีงบ',
            ],
            'x-order': 60,
          },
          constraints: {
            type: 'string',
            title: 'ข้อจำกัด / ระบบเดิมที่ต้องเชื่อม (ถ้ามี)',
            maxLength: 2000,
            'x-multiline': true,
            'x-order': 70,
          },
          competitors: {
            type: 'string',
            title: 'คู่แข่งในดีลนี้ (ถ้ารู้)',
            maxLength: 500,
            'x-order': 80,
          },
          needs_demo: {
            type: 'boolean',
            title: 'ลูกค้าต้องการ Demo / POC',
            'x-order': 90,
          },
        },
      },
      requiredDocs: [],
      returnReasonCodes: [
        { code: 'REQUIREMENT_UNCLEAR', name: 'ความต้องการไม่ชัดเจน' },
        { code: 'BUDGET_UNKNOWN', name: 'ยังไม่รู้กรอบงบประมาณจริง' },
        { code: 'SCOPE_TOO_BROAD', name: 'ขอบเขตกว้างเกินกว่าจะออกแบบได้' },
        { code: 'CUSTOMER_INFO_NEEDED', name: 'ต้องขอข้อมูลเพิ่มจากลูกค้า' },
        { code: 'OTHER', name: 'อื่น ๆ' },
      ],
      approvalPolicy: {},
      // 2 days, as the scope's request-type table sets; coverage is 24×7.
      slaHours: 48,
    },
    {
      /**
       * CD-143 — ขออนุมัติ Solution (Pre-Sales → ฝ่ายเทคนิค · ผู้อำนวยการฝ่าย
       * เทคนิค · 2 วัน). Raised as a draft from a locked Solution version,
       * prefilled with what is being approved; the technical team reviews it
       * and the `request:SOLA` ladder approves it after the work.
       */
      code: 'SOLA',
      name: 'ขออนุมัติ Solution',
      receiverOrgUnitId: osdRoot?.id ?? null,
      refRequired: true,
      formSchema: {
        type: 'object',
        required: [
          'solution_title',
          'version_no',
          'summary',
          'in_scope',
          'deliverables',
        ],
        properties: {
          solution_title: {
            type: 'string',
            title: 'Solution',
            maxLength: 300,
            'x-order': 10,
          },
          version_no: {
            type: 'string',
            title: 'เวอร์ชันที่ขออนุมัติ',
            maxLength: 20,
            'x-order': 20,
          },
          summary: {
            type: 'string',
            title: 'สรุปทางออก',
            maxLength: 4000,
            'x-multiline': true,
            'x-order': 30,
          },
          in_scope: {
            type: 'string',
            title: 'งานในขอบเขต',
            maxLength: 20000,
            'x-multiline': true,
            'x-order': 40,
          },
          out_of_scope: {
            type: 'string',
            title: 'งานนอกขอบเขต',
            maxLength: 20000,
            'x-multiline': true,
            'x-order': 50,
          },
          deliverables: {
            type: 'string',
            title: 'รายการส่งมอบและเกณฑ์ตรวจรับ',
            maxLength: 20000,
            'x-multiline': true,
            'x-order': 60,
          },
          assumptions: {
            type: 'string',
            title: 'สมมติฐานการออกแบบ',
            maxLength: 20000,
            'x-multiline': true,
            'x-order': 70,
          },
          requirements: {
            type: 'string',
            title: 'ผลวิเคราะห์ความต้องการ',
            maxLength: 20000,
            'x-multiline': true,
            'x-order': 80,
          },
          // CD-135 — the BOQ this version fixes (handoff 3 → Pricing).
          boq: {
            type: 'string',
            title: 'BOQ / BOM',
            maxLength: 50000,
            'x-multiline': true,
            'x-order': 65,
          },
          // CD-138 — the TOR and how each clause is answered.
          tor: {
            type: 'string',
            title: 'TOR / RFP และการตอบข้อกำหนด',
            maxLength: 50000,
            'x-multiline': true,
            'x-order': 96,
          },
          // CD-139 — what the demos showed.
          demos: {
            type: 'string',
            title: 'Demo / POC และข้อค้นพบ',
            maxLength: 20000,
            'x-multiline': true,
            'x-order': 97,
          },
          // CD-141 — the risk register, highest score first.
          risks: {
            type: 'string',
            title: 'ความเสี่ยงทางเทคนิค',
            maxLength: 20000,
            'x-multiline': true,
            'x-order': 95,
          },
          // CD-140 — the technical Q&A with the customer.
          clarifications: {
            type: 'string',
            title: 'คำถาม-คำตอบทางเทคนิคกับลูกค้า',
            maxLength: 20000,
            'x-multiline': true,
            'x-order': 90,
          },
          // CD-133 — the overall verdict and its conditions.
          feasibility: {
            type: 'string',
            title: 'ผลประเมินความเป็นไปได้',
            maxLength: 4000,
            'x-multiline': true,
            'x-order': 25,
          },
        },
      },
      requiredDocs: [],
      returnReasonCodes: [
        { code: 'DESIGN_INCOMPLETE', name: 'การออกแบบยังไม่ครบ' },
        { code: 'SCOPE_UNCLEAR', name: 'ขอบเขตงานไม่ชัดเจน' },
        { code: 'NOT_FEASIBLE', name: 'ทำไม่ได้ทางเทคนิค' },
        { code: 'DOCS_MISSING', name: 'เอกสารประกอบไม่ครบ' },
        { code: 'OTHER', name: 'อื่น ๆ' },
      ],
      approvalPolicy: {},
      slaHours: 48,
    },
    {
      /**
       * CD-139 — ขอจัด Demo หรือ POC (Sales → Pre-Sales · Engineer · หัวหน้า
       * Pre-Sales · 3 วัน). Raised from the deal; the head of the receiving
       * Pre-Sales team accepting it is the approval (no matrix). Pre-Sales
       * then keeps the Demo/POC on the Solution, started from this form.
       */
      code: 'DEMO',
      name: 'ขอจัด Demo หรือ POC',
      receiverOrgUnitId: osdRoot?.id ?? null,
      refRequired: true,
      formSchema: {
        type: 'object',
        required: ['kind', 'objective', 'success_criteria'],
        properties: {
          kind: {
            type: 'string',
            title: 'ประเภท',
            enum: ['Demo', 'POC'],
            'x-order': 10,
          },
          objective: {
            type: 'string',
            title: 'วัตถุประสงค์ / สิ่งที่ลูกค้าอยากเห็น',
            maxLength: 4000,
            'x-multiline': true,
            'x-order': 20,
          },
          proposed_date: {
            type: 'string',
            format: 'date',
            title: 'วันที่ต้องการจัด',
            'x-order': 30,
          },
          site: {
            type: 'string',
            title: 'สถานที่ (ที่ลูกค้า / ออนไลน์ / Lab)',
            maxLength: 500,
            'x-order': 40,
          },
          success_criteria: {
            type: 'string',
            title: 'เกณฑ์ความสำเร็จ (ข้อละบรรทัด)',
            maxLength: 4000,
            'x-multiline': true,
            'x-order': 50,
          },
          attendees: {
            type: 'string',
            title: 'ผู้เข้าร่วมฝั่งลูกค้า',
            maxLength: 1000,
            'x-order': 60,
          },
        },
      },
      requiredDocs: [],
      returnReasonCodes: [
        { code: 'OBJECTIVE_UNCLEAR', name: 'วัตถุประสงค์ไม่ชัดเจน' },
        { code: 'NO_EQUIPMENT', name: 'ไม่มีอุปกรณ์/คนว่างในช่วงนั้น' },
        { code: 'NOT_READY', name: 'Solution ยังไม่พร้อมสาธิต' },
        { code: 'OTHER', name: 'อื่น ๆ' },
      ],
      approvalPolicy: {},
      // 3 days, as the scope's request-type table sets; coverage is 24×7.
      slaHours: 72,
    },
    {
      /**
       * CD-136 — ขอราคาจากคู่ค้า (Pre-Sales → จัดซื้อ · ผู้จัดการจัดซื้อ · 3 วัน).
       * Raised from the cost estimate for chosen BOQ lines; Purchasing answers
       * with the vendor's quote, which Pre-Sales records on the estimate.
       */
      code: 'VQ',
      name: 'ขอราคาจากคู่ค้า',
      receiverOrgUnitId: osdRoot?.id ?? null,
      refRequired: true,
      formSchema: {
        type: 'object',
        required: ['items'],
        properties: {
          solution_title: {
            type: 'string',
            title: 'Solution',
            maxLength: 300,
            'x-order': 10,
          },
          version_no: {
            type: 'string',
            title: 'เวอร์ชัน',
            maxLength: 20,
            'x-order': 20,
          },
          items: {
            type: 'string',
            title: 'รายการที่ขอราคา (จาก BOQ)',
            maxLength: 20000,
            'x-multiline': true,
            'x-order': 30,
          },
          needed_by: {
            type: 'string',
            format: 'date',
            title: 'ต้องการราคาภายใน',
            'x-order': 40,
          },
          preferred_vendors: {
            type: 'string',
            title: 'คู่ค้าที่แนะนำ (ถ้ามี)',
            maxLength: 1000,
            'x-order': 50,
          },
        },
      },
      receiverFormSchema: {
        type: 'object',
        required: ['vendor_name', 'quote_summary'],
        properties: {
          vendor_name: {
            type: 'string',
            title: 'คู่ค้า',
            maxLength: 300,
            'x-order': 10,
          },
          vendor_code: {
            type: 'string',
            title: 'รหัสผู้ขายใน SAP',
            maxLength: 60,
            'x-order': 20,
          },
          quote_summary: {
            type: 'string',
            title: 'ราคาที่ได้ (ต่อรายการ) และเงื่อนไข',
            maxLength: 20000,
            'x-multiline': true,
            'x-order': 30,
          },
          valid_until: {
            type: 'string',
            format: 'date',
            title: 'ราคาใช้ได้ถึง',
            'x-order': 40,
          },
        },
      },
      requiredDocs: [],
      returnReasonCodes: [
        { code: 'ITEMS_UNCLEAR', name: 'รายการไม่ชัดเจน' },
        { code: 'NO_VENDOR', name: 'ไม่มีคู่ค้าที่จำหน่าย' },
        { code: 'OTHER', name: 'อื่น ๆ' },
      ],
      approvalPolicy: {},
      slaHours: 72,
    },
    {
      /**
       * CD-201 — อนุมัติราคา: every quotation version, filed and submitted by
       * the system on "ยื่น" and bound to that version (`ref_id` = its id).
       * Approved before the work on the `request:PRA:pre` ladder, whose
       * levels route on `net_total`. Margin and cost are masked like DSC's.
       */
      code: 'PRA',
      name: 'อนุมัติราคา',
      receiverOrgUnitId: osdRoot?.id ?? null,
      refRequired: true,
      formSchema: {
        type: 'object',
        required: [
          'quotation_no',
          'version_no',
          'customer_name',
          'net_total',
          'reason',
        ],
        properties: {
          quotation_no: {
            type: 'string',
            title: 'เลขที่ใบเสนอราคา',
            maxLength: 40,
            'x-order': 10,
          },
          version_no: {
            type: 'number',
            title: 'เวอร์ชันที่ขออนุมัติ',
            minimum: 1,
            'x-order': 20,
          },
          customer_name: { type: 'string', title: 'ลูกค้า', 'x-order': 30 },
          net_total: {
            type: 'number',
            title: 'ยอดสุทธิก่อน VAT (THB)',
            minimum: 0,
            'x-order': 40,
          },
          deal_value: {
            type: 'number',
            title: 'มูลค่าก่อนส่วนลด (THB)',
            minimum: 0,
            'x-order': 50,
          },
          discount_pct: {
            type: 'number',
            title: '% ส่วนลด',
            minimum: 0,
            maximum: 100,
            'x-order': 60,
          },
          cost: {
            type: 'number',
            title: 'ต้นทุน (THB)',
            minimum: 0,
            'x-sensitive': true,
            'x-order': 70,
          },
          est_margin_pct: {
            type: 'number',
            title: 'margin (%)',
            'x-sensitive': true,
            'x-order': 80,
          },
          margin_below_minimum: {
            type: 'string',
            title: 'margin ต่ำกว่าเกณฑ์',
            enum: ['yes', 'no'],
            'x-order': 90,
          },
          reason: {
            type: 'string',
            title: 'รายละเอียด / เหตุผล',
            maxLength: 2000,
            'x-multiline': true,
            'x-order': 100,
          },
        },
      },
      requiredDocs: [],
      returnReasonCodes: [
        { code: 'PRICE_WRONG', name: 'ราคาไม่ถูกต้อง' },
        { code: 'MARGIN_TOO_LOW', name: 'margin ต่ำเกินไป' },
        { code: 'REASON_INSUFFICIENT', name: 'เหตุผลไม่เพียงพอ' },
        { code: 'OTHER', name: 'อื่น ๆ (ระบุ)' },
      ],
      approvalPolicy: {},
      slaHours: 24,
    },
  ];

  for (const type of types) {
    const saved = await prisma.requestType.upsert({
      where: { code: type.code },
      update: {
        name: type.name,
        receiverOrgUnitId: type.receiverOrgUnitId,
        formSchema: type.formSchema,
        // CD-61 — only a type that declares one; the others keep theirs.
        ...('receiverFormSchema' in type
          ? { receiverFormSchema: type.receiverFormSchema }
          : {}),
        requiredDocs: type.requiredDocs,
        // CD-130 — only a type that declares it; the others keep theirs.
        ...('refRequired' in type ? { refRequired: type.refRequired } : {}),
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
        ...('receiverFormSchema' in type
          ? { receiverFormSchema: type.receiverFormSchema }
          : {}),
        requiredDocs: type.requiredDocs,
        // CD-130 — only a type that declares it; the others keep theirs.
        ...('refRequired' in type ? { refRequired: type.refRequired } : {}),
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
        where: {
          dimensionId_code: { dimensionId: saved.id, code: value.code },
        },
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
    await prisma.opportunityLostReason.upsert({
      where: { companyId_code: { companyId, code: reason.code } },
      update: { name: reason.name, sortOrder: reason.sortOrder, active: true },
      create: { companyId, ...reason },
    });
  }
  console.log(`  opportunity lost reasons: ${lostReasons.length}`);
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
  await seedContractRequestType(demo.id);
  await seedSolutionRequestType(demo.id);
  await seedTradeTerms(demo.id);
  await seedHandoverItems(demo.id);
  await seedApprovalMatrix(demo.id);
  await seedSolutionApprovalMatrix(demo.id);
  await seedPriceApprovalMatrix(demo.id);
  await seedPriceApprovalType(demo.id);

  console.log('Done.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
