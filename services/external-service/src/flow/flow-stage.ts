/**
 * How far a deal has travelled, read off what exists — never stored.
 *
 * The order is the business flow the external guide walks: a deal, Pre-Sales
 * on it, a quotation, the sale order, the contract, the project. A later
 * artefact means the earlier steps are behind it even when one was skipped
 * (a small deal goes straight to a quotation without a Solution), so the
 * stage is the *furthest* one reached, not the last one touched.
 *
 * A section the person may not see counts as "nothing seen" rather than
 * failing the answer — the stage then reads as far as *they* can follow it,
 * which is the same thing their screens would show them.
 */
export const FLOW_STAGES = [
  'opportunity',
  'presales',
  'quotation',
  'sale_order',
  'contract',
  'project',
] as const;

export type FlowStage = (typeof FLOW_STAGES)[number] | 'lost';

export interface FlowFacts {
  readonly dealStage: string;
  readonly solutionRequests: number;
  readonly solutions: number;
  readonly quotations: number;
  readonly saleOrders: number;
  readonly contractRequests: number;
  readonly contracts: number;
  readonly projects: number;
}

export function currentStage(facts: FlowFacts): FlowStage {
  if (facts.projects > 0) return 'project';
  if (facts.contracts > 0 || facts.contractRequests > 0) return 'contract';
  if (facts.saleOrders > 0) return 'sale_order';
  // A lost deal with nothing past the quotation stopped there.
  if (facts.dealStage === 'lost') return 'lost';
  if (facts.quotations > 0) return 'quotation';
  if (facts.solutions > 0 || facts.solutionRequests > 0) return 'presales';
  return 'opportunity';
}

export interface NextStep {
  readonly action: string;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly note: string;
}

export interface NextStepContext {
  readonly opportunityId: string;
  readonly opportunityCode: string;
  readonly solutionTypeCode: string | null;
  readonly contractTypeCode: string | null;
}

/**
 * The calls that move the deal on from where it is — a hint for the
 * integrator, not a rule. Whether a call succeeds is still decided by the
 * route it names (a quotation must be accepted before a sale order opens, a
 * contract signed before a project does), and those answers carry the reason.
 */
export function nextSteps(
  stage: FlowStage,
  context: NextStepContext,
): NextStep[] {
  const dealRef = `ref_type=opportunity, ref_id=${context.opportunityCode}`;
  const raise = (typeCode: string, what: string): NextStep => ({
    action: what,
    method: 'POST',
    path: '/api/v1/request/requests',
    note: `type_code=${typeCode}, ${dealRef}`,
  });

  switch (stage) {
    case 'opportunity':
      return [
        ...(context.solutionTypeCode
          ? [raise(context.solutionTypeCode, 'ขอ Solution จาก Pre-Sales')]
          : []),
        {
          action: 'สร้างใบเสนอราคาบนดีล',
          method: 'POST',
          path: `/api/v1/crm/opportunities/${context.opportunityId}/quotations`,
          note: 'ดีลเล็กที่ไม่ต้องออกแบบ Solution',
        },
      ];
    case 'presales':
      return [
        {
          action: 'ติดตาม Solution ของดีล',
          method: 'GET',
          path: `/api/v1/presales/opportunities/${context.opportunityId}/solutions`,
          note: 'รอเวอร์ชันที่ approvalStatus=approved แล้วทีม Pricing สร้างใบเสนอราคา',
        },
      ];
    case 'quotation':
      return [
        {
          action: 'ยื่น / ส่ง / บันทึกลูกค้าตอบรับใบเสนอราคา',
          method: 'POST',
          path: '/api/v1/crm/quotations/{id}/submit|send|accept',
          note: 'ใบที่ accepted แล้วเปิดใบสั่งขายได้',
        },
        {
          action: 'เปิดใบสั่งขาย',
          method: 'POST',
          path: `/api/v1/crm/opportunities/${context.opportunityId}/sale-orders`,
          note: 'ลูกค้าในทะเบียนถูกสร้างที่จุดนี้ และดีลปิดชนะ',
        },
      ];
    case 'sale_order':
      return context.contractTypeCode
        ? [raise(context.contractTypeCode, 'ขอจัดทำสัญญาจากฝ่ายกฎหมาย')]
        : [];
    case 'contract':
      return [
        {
          action: 'ติดตามสัญญาของดีล',
          method: 'GET',
          path: `/api/v1/legal/contracts?opportunity_id=${context.opportunityId}`,
          note: 'มี signedOn แล้ว (ลงนามครบ) จึงเปิดโครงการได้',
        },
        {
          action: 'เปิดโครงการจากสัญญาที่ลงนามแล้ว',
          method: 'POST',
          path: '/api/v1/pm/projects',
          note: 'ตรวจก่อนด้วย GET /api/v1/pm/projects/preview/{contractId}',
        },
      ];
    case 'project':
      return [
        {
          action: 'ติดตามการส่งมอบและวางบิล',
          method: 'GET',
          path: '/api/v1/delivery/projects/{projectId}',
          note: 'และ /billing, /handovers',
        },
        {
          action: 'เปิดใบสั่งงานบริการหลังส่งมอบ',
          method: 'POST',
          path: '/api/v1/support/work-orders',
          note: 'อุปกรณ์ที่ตรวจรับแล้วอยู่ใน GET /api/v1/support/assets',
        },
      ];
    case 'lost':
      return [];
  }
}
