/**
 * Development / UAT seed.
 *
 * Creates the two companies, the §5.2 seed roles with their permissions, a
 * sample org tree matching the mockups, and the default scope and masking
 * rules. Idempotent — safe to re-run.
 *
 *   npm run prisma:seed
 *
 * The approval-matrix ceilings are **placeholders**. Open question A (§15.2)
 * has finance confirming the real T1/T2 per company; nothing here should be
 * mistaken for a signed-off number.
 */
import { PrismaClient, ScopeLevel } from '@prisma/client';

const prisma = new PrismaClient();

/** Mirrors libs/share/src/policy/permissions.ts. */
const PERMISSIONS: Record<string, string[]> = {
  request: [
    'request.create',
    'request.read',
    'request.cancel.own',
    'request.cancel.any',
    'request.complete',
    'request.return',
    'request.sensitive.read',
  ],
  approval: ['approval.decide', 'approval.delegate', 'approval.history.read'],
  report: ['report.request.read'],
  user: ['user.read'],
  notification: ['notification.read'],
  audit: ['audit.read'],
  admin: [
    'admin.role.manage',
    'admin.org.manage',
    'admin.request-type.manage',
    'admin.approval-matrix.manage',
    'admin.sla.manage',
    'admin.identity.manage',
  ],
  integration: ['integration.request.create', 'integration.approval.create'],
};

/** §5.2 seed roles: what each can do, and how far each can see. */
const SEED_ROLES: {
  code: string;
  name: string;
  description: string;
  permissions: string[];
  scopes: Record<string, ScopeLevel>;
}[] = [
  {
    code: 'employee',
    name: 'พนักงาน',
    description: 'บทบาทพื้นฐานที่ทุกผู้ใช้ได้อัตโนมัติ',
    permissions: [
      'request.create',
      'request.read',
      'request.cancel.own',
      'notification.read',
    ],
    scopes: { request: 'own', approval_case: 'own', user: 'team' },
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
    ],
    scopes: { request: 'team', approval_case: 'team', user: 'team' },
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
      'notification.read',
      'user.read',
    ],
    scopes: {
      request: 'department',
      approval_case: 'department',
      user: 'department',
    },
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
      'notification.read',
      'user.read',
    ],
    scopes: { request: 'company', approval_case: 'company', user: 'company' },
  },
  {
    // §5.2 is explicit that admins configure the system but hold no approval
    // authority — they cannot approve on anyone's behalf.
    code: 'admin',
    name: 'ผู้ดูแลระบบ',
    description: 'ทีมที่ดูแลการตั้งค่า — ไม่มีสิทธิ์อนุมัติแทนใคร',
    permissions: [
      'admin.role.manage',
      'admin.org.manage',
      'admin.request-type.manage',
      'admin.approval-matrix.manage',
      'admin.sla.manage',
      'admin.identity.manage',
      'audit.read',
      'user.read',
      'notification.read',
      'request.read',
    ],
    scopes: { request: 'company', approval_case: 'company', user: 'company' },
  },
  {
    code: 'auditor',
    name: 'ผู้ตรวจสอบ',
    description: 'ตรวจสอบภายใน — อ่านอย่างเดียว ข้ามบริษัทได้',
    permissions: [
      'request.read',
      'request.sensitive.read',
      'approval.history.read',
      'report.request.read',
      'audit.read',
      'user.read',
    ],
    scopes: { request: 'all', approval_case: 'all', user: 'all' },
  },
];

async function seedPermissions() {
  const rows = Object.entries(PERMISSIONS).flatMap(([module, codes]) =>
    codes.map((code) => ({ code, module })),
  );

  await prisma.permission.createMany({ data: rows, skipDuplicates: true });
  console.log(`  permissions: ${rows.length}`);
}

async function seedCompanies() {
  const companies = [
    { code: 'OSD', name: 'OSD', docPrefix: 'OSD', baseCurrency: 'THB' },
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
      update: { name: role.name, description: role.description, isSystem: true },
      create: {
        companyId,
        code: role.code,
        name: role.name,
        description: role.description,
        isSystem: true,
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

    for (const [resource, scope] of Object.entries(role.scopes)) {
      await prisma.scopeRule.upsert({
        where: { roleId_resource: { roleId: saved.id, resource } },
        update: { scope },
        create: { roleId: saved.id, resource, scope },
      });
    }
  }

  console.log(`  roles + scope rules: ${SEED_ROLES.length}`);
}

/** The tree from mockup A3. */
async function seedOrgTree(companyId: string) {
  const units = [
    { code: 'ROOT', name: 'บริษัท OSD', kind: 'COMPANY' as const, parent: null },
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

/** PLACEHOLDER ceilings — open question A. Do not enable in production. */
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
      tiers: [
        { upto: '100000.00', chain: ['team_lead'] },
        { upto: '1000000.00', chain: ['team_lead', 'cfo'] },
        { upto: null, chain: ['team_lead', 'cfo', 'ceo'] },
      ],
      createdBy: 'seed',
    },
  });

  console.log('  approval matrix: v1 with PLACEHOLDER ceilings (see §15.2 A)');
}

/**
 * The two pilot request types (§1). Configuration, not code — REQ-01 requires
 * that the 3rd..30th type needs no migration and no deploy, so everything
 * about a type lives in these columns.
 *
 * ขอส่วนลด carries an amount and exercises the full T1/T2 approval ladder;
 * ส่งต่อโอกาสการขาย has no monetary dimension, so `selectTier` returns the
 * lowest tier and it runs step 1 only. Between them they cover both shapes the
 * approval engine has to handle.
 */
async function seedRequestTypes(companies: { id: string; code: string }[]) {
  const osdRoot = await prisma.orgUnit.findFirst({
    where: { companyId: companies[0].id, code: 'PRICING' },
  });
  const sales = await prisma.orgUnit.findFirst({
    where: { companyId: companies[0].id, code: 'SALES' },
  });

  const types = [
    {
      code: 'DSC',
      name: 'ขอส่วนลด',
      receiverOrgUnitId: osdRoot?.id ?? null,
      formSchema: {
        type: 'object',
        required: ['customer_name', 'deal_value', 'discount_pct', 'reason'],
        properties: {
          customer_name: { type: 'string', title: 'ลูกค้า' },
          deal_value: { type: 'number', title: 'มูลค่าดีล (บาท)', minimum: 0 },
          discount_pct: {
            type: 'number',
            title: 'ส่วนลด (%)',
            minimum: 0,
            maximum: 100,
          },
          // Sensitive (SCOPE-04) — the seeded request:DSC rules name this and
          // discount_pct, so only request.sensitive.read sees the values.
          est_margin_pct: {
            type: 'number',
            title: 'มาร์จิ้นโดยประมาณ (%)',
            'x-sensitive': true,
          },
          reason: { type: 'string', title: 'เหตุผล', maxLength: 2000 },
        },
      },
      requiredDocs: [
        { code: 'QUOTE_DRAFT', name: 'ใบเสนอราคาฉบับร่าง' },
      ],
      returnReasonCodes: [
        { code: 'DOC_INCOMPLETE', label: 'เอกสารไม่ครบ' },
        { code: 'PRICE_UNCLEAR', label: 'ราคา/ส่วนลดไม่ชัดเจน' },
        { code: 'NEED_APPROVAL_ABOVE', label: 'ต้องขออนุมัติระดับสูงกว่า' },
        { code: 'OTHER', label: 'อื่น ๆ' },
      ],
      // The amount field is what APV-02 measures against the matrix ceilings.
      approvalPolicy: { mode: 'standard_chain', amount_field: 'deal_value' },
      slaHours: 24,
    },
    {
      code: 'LEAD',
      name: 'ส่งต่อโอกาสการขาย',
      receiverOrgUnitId: sales?.id ?? null,
      formSchema: {
        type: 'object',
        required: ['customer_name', 'to_team', 'reason'],
        properties: {
          customer_name: { type: 'string', title: 'ลูกค้า' },
          to_team: { type: 'string', title: 'ส่งต่อให้ทีม' },
          contact: { type: 'string', title: 'ผู้ติดต่อ' },
          reason: { type: 'string', title: 'เหตุผล', maxLength: 2000 },
        },
      },
      requiredDocs: [],
      returnReasonCodes: [
        { code: 'INFO_INCOMPLETE', label: 'ข้อมูลไม่ครบ' },
        { code: 'WRONG_TEAM', label: 'ส่งผิดทีม' },
        { code: 'OTHER', label: 'อื่น ๆ' },
      ],
      // No amount_field: selectTier takes the lowest tier, so step 1 only.
      approvalPolicy: { mode: 'standard_chain', amount_field: null },
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

    // Available in every company (D-11); a company can deactivate its own.
    for (const company of companies) {
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

async function main() {
  console.log('Seeding CTD foundation data…');

  await seedPermissions();
  const companies = await seedCompanies();
  const [osd] = companies;

  // Roles are per company (ROLE-04) — a manager in one company is not a
  // manager in another. Seed the full set into every company so that
  // isolation is real rather than an artefact of only one company having
  // any roles at all.
  for (const company of companies) {
    await seedRoles(company.id);
  }

  await seedOrgTree(osd.id);
  await seedSensitiveFields();
  await seedRequestTypes(companies);
  await seedApprovalMatrix(osd.id);

  console.log('Done.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
