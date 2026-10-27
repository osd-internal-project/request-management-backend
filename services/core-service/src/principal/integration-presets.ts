import type { Permission } from '@request-management/share';
import type { IntegrationMode } from './dto/integration.dto';

/** ชุด scope สำเร็จรูปต่อ use case — ติ๊กให้ตอนสร้าง ไม่ใช่สิทธิ์ใหม่ (22 ต.ค. 2569). */
export interface IntegrationPreset {
  readonly code: string;
  readonly name: string;
  readonly modes: readonly IntegrationMode[];
  readonly scopes: readonly Permission[];
}

export const INTEGRATION_PRESETS: readonly IntegrationPreset[] = [
  {
    code: 'lead-intake',
    name: 'เว็บฟอร์ม / ช่องทางรับ Lead',
    modes: ['app'],
    scopes: ['integration.crm.lead.create'],
  },
  {
    code: 'ai-lead-agent',
    name: 'AI ทำงาน Lead แทนบริษัท',
    modes: ['app'],
    scopes: [
      'integration.crm.lead.read',
      'integration.crm.lead.update',
      'integration.crm.lead.convert',
    ],
  },
  {
    code: 'ai-lead-finder',
    name: 'Vuvagent หา Lead (Find leads)',
    modes: ['app'],
    scopes: ['integration.crm.lead.create', 'integration.agent.record.update'],
  },
  {
    code: 'chatbot',
    name: 'Chatbot ทำงานแทนผู้ใช้',
    modes: ['delegated'],
    scopes: [
      'integration.request.create',
      'integration.request.read',
      'integration.approval.decide',
      'integration.crm.customer.read',
      'integration.crm.sales.read',
      'integration.assistant.read',
    ],
  },
  {
    code: 'workflow',
    name: 'OSD Workflow',
    modes: ['app'],
    scopes: [
      'integration.process.log',
      'integration.crm.lead.read',
      'integration.crm.lead.stage',
      'integration.request.intake',
      'integration.approval.create',
    ],
  },
  {
    code: 'customer-care',
    name: 'ช่องทางคุยกับลูกค้า (AI CARE)',
    modes: ['app'],
    scopes: ['integration.service.care.manage', 'integration.kb.read'],
  },
  {
    code: 'callcenter',
    name: 'D-Callcenter',
    modes: ['app'],
    scopes: ['integration.smart.call.update'],
  },
  {
    code: 'prospect-feed',
    name: 'ผู้ส่งรายชื่อเป้าหมาย (AI SMART)',
    modes: ['app'],
    scopes: ['integration.smart.prospect.create'],
  },
];
