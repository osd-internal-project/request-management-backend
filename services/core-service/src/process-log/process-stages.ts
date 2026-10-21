/**
 * The seven stages of the End-to-End Business Process (OSD, 21 ต.ค. 2569) —
 * one workflow on OSD Workflow per stage, chained in this order.
 *
 * The workflow owns the steps inside a stage; this list only pins the stage
 * number to its code and team so a log row cannot claim "stage 3" under
 * stage 5's code.
 */
export const PROCESS_STAGES = [
  { no: 1, code: 'market_to_lead', team: 'T01', name: 'การตลาด & สร้างโอกาส' },
  {
    no: 2,
    code: 'solution_commercial',
    team: 'T02-03',
    name: 'วิเคราะห์โซลูชัน & เสนอราคา',
  },
  {
    no: 3,
    code: 'contract_order',
    team: 'T04-05',
    name: 'สัญญา & ออกคำสั่งขาย',
  },
  { no: 4, code: 'project_execution', team: 'T06-09', name: 'ดำเนินโครงการ' },
  {
    no: 5,
    code: 'billing_collection',
    team: 'T10',
    name: 'เรียกเก็บเงิน & รับชำระ',
  },
  {
    no: 6,
    code: 'expense_settlement',
    team: 'T11',
    name: 'ค่าใช้จ่าย & ปิดต้นทุน',
  },
  {
    no: 7,
    code: 'closure_growth',
    team: 'T12',
    name: 'ปิดโครงการ & ต่อยอด',
  },
] as const;

export const PROCESS_LOG_STATUSES = [
  'started',
  'completed',
  'approved',
  'rejected',
  'returned',
  'skipped',
  'failed',
  'info',
] as const;

export type ProcessLogStatus = (typeof PROCESS_LOG_STATUSES)[number];

export function stageOf(no: number) {
  return PROCESS_STAGES.find((stage) => stage.no === no);
}
