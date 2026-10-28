import { writeFileSync, mkdirSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import {
  ACTING_PERMISSIONS_KEY,
  PERMISSIONS_KEY,
  SENSITIVE_RESOURCE_KEY,
} from '@request-management/share';
import { CoreServiceModule } from '../services/core-service/src/core-service.module';
import { UserServiceModule } from '../services/user-service/src/user-service.module';
import { ExternalServiceModule } from '../services/external-service/src/external-service.module';
import { enrichFromValidators, routesOf } from './openapi-validators';
import { writeWebhookDocument } from './openapi-webhooks';

/**
 * §14 — the OpenAPI document is **generated from the code**, never hand-written.
 *
 * A hand-maintained `api-spec.md` has nothing forcing it to match the routes
 * that actually exist; this reads the decorators the server itself runs on, so
 * a route that is renamed or deleted cannot stay in the spec by inertia.
 *
 * The app is created without listening: nothing binds a port, and no request
 * is ever served by this process.
 */
/**
 * Every `#/components/schemas/...` reachable from `node`, followed recursively.
 *
 * The partner document must carry the schemas its own paths use and nothing
 * else: `core-service.json` holds thirty, most belonging to the admin and
 * approval surfaces, and shipping those would hand an integrator the shape of
 * endpoints they cannot call and should not know about.
 */
function collectRefs(
  node: unknown,
  schemas: Record<string, unknown>,
  found: Set<string>,
): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, schemas, found);
    return;
  }
  if (node === null || typeof node !== 'object') return;

  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') {
      const name = value.replace('#/components/schemas/', '');
      // Guard against a cycle: a schema that refers back to itself, directly
      // or through a chain, would otherwise recurse until the stack gives out.
      if (schemas[name] && !found.has(name)) {
        found.add(name);
        collectRefs(schemas[name], schemas, found);
      }
      continue;
    }
    collectRefs(value, schemas, found);
  }
}

/**
 * What every partner document says, whatever module it describes.
 *
 * Kept in one place rather than repeated four times: these are properties of
 * the *service*, not of a module, and four copies would start disagreeing the
 * first time one was edited.
 */
const SHARED_RULES =
  '**ทุก route มีสองประตู** และ Swagger ของแต่ละ route บอกไว้ทั้งคู่: ' +
  'bearer ต้องถือสิทธิ์ `integration.*` ของ route นั้น (ประตูของเครื่อง) ' +
  'และคนที่ระบุใน header `X-Acting-User` ต้องถือสิทธิ์ของงานนั้นเอง ' +
  '(ประตูของคน) — ระบบทำงานในนามคนนั้น timeline จึงบันทึกชื่อคนจริง ' +
  'ไม่ใช่ชื่อบัญชีบริการ\n\n' +
  '**bearer รับได้สองแบบ**\n\n' +
  '1. access token ของ service account จาก Keycloak (client_credentials) ' +
  'อายุสั้น ต้องขอใหม่เมื่อหมดอายุ\n' +
  '2. **API key** ที่ขึ้นต้นด้วย `rfk_` — ไม่มีวันหมดอายุ ไม่ต้องต่ออายุ ' +
  'ระบบแลกเป็น token ให้เองตอนใช้ ออกด้วย `yarn apikey:issue` ' +
  'และเพิกถอนด้วย `yarn apikey:revoke` (มีผลทันที)\n\n' +
  'ทั้งสองแบบส่งเหมือนกัน: `Authorization: Bearer <ค่า>` ' +
  'และได้สิทธิ์ชุดเดียวกัน — key ตัดสินว่า *เข้าได้ไหม* token บอกว่า *ทำอะไรได้*';

interface ModuleDoc {
  readonly title: string;
  readonly summary: string;
  /** What is true of this module and no other — usually its robot-only routes. */
  readonly notes?: string;
  readonly tags: readonly { name: string; description: string }[];
}

/**
 * One entry per module external-service serves.
 *
 * The prose is per module on purpose. An integrator wiring up CRM should not
 * have to read the request flow's exceptions to find out that
 * `POST /crm/leads/intake` takes no `X-Acting-User`; that fact belongs in the CRM
 * document and nowhere else.
 */
const MODULE_DOCS: Readonly<Record<string, ModuleDoc>> = {
  disbursement: {
    title: 'Request Form — External API · Disbursement',
    summary:
      'การเบิก — หน้าทำงานเรื่องเงินของคำขอ FI05 (เงินทดรองจ่าย) และ FI06 (เงินสดย่อย): ตรวจ จ่าย เคลียร์ ปิด',
    notes:
      '**การขอเบิกคือคำขอ** — เปิดด้วย request API (`type_code` FI05/FI06) ใบเบิกถูกสร้างเอง' +
      'เมื่อคำขอถูกส่ง หาได้ที่ `disbursements/by-request/{requestNo}`\n\n' +
      '**คำขอคือ ticket** — อนุมัติหัวหน้า/ผู้บริหารอยู่บนคำขอ (approval API เดิม) ' +
      'action ที่นี่บันทึกเงินแล้วเลื่อนขั้นของคำขอให้ ผลการเลื่อนอยู่ใน `ticketMove`\n\n' +
      'ลำดับเงินทดรอง: `verify` → (ผู้บริหารอนุมัติบนคำขอ) → `pay` → `clearing` → `close` ' +
      '(คิดส่วนต่างคืน/เบิกเพิ่ม) — เงินสดย่อยปิดทันทีที่ `pay`; ไฟล์หลักฐานแนบได้จากหน้าจอเท่านั้น',
    tags: [
      {
        name: 'disbursement',
        description: 'ใบเบิก — ตรวจ จ่าย เคลียร์ ปิด',
      },
    ],
  },
  request: {
    title: 'Request Form — External API · Request',
    summary:
      'คำขอ (Platform Request) ตั้งแต่เปิดจนปิด สำหรับระบบภายนอก เช่น chatbot',
    notes:
      '**ลำดับการเรียกที่ใช้ได้จริง** — `request-types` หาประเภท · ' +
      '`request-types/{code}/form` เอาฟอร์มและผู้รับที่เลือกได้ · `users` แปลงชื่อคน ' +
      'เป็น uuid · `requests` เปิดคำขอ · จากนั้นทุกอย่างวิ่งผ่าน ' +
      '`requests/{ref}/actions` (ถามว่าทำอะไรได้) แล้ว ' +
      '`requests/{ref}/actions/{action}` (สั่งทำ)\n\n' +
      '**ห้ามจำว่าประเภทไหนมีฟิลด์อะไร** — ฟอร์ม เอกสารบังคับ เหตุผลตีกลับ SLA และ ' +
      'บันไดอนุมัติ เป็น configuration ที่แก้ได้จากหน้า admin โดยไม่ต้อง deploy ' +
      'ดึง `request-types/{code}/form` ใหม่ทุกครั้ง\n\n' +
      '**ห้ามเดา action** — enum ใน `{action}` คือรายการที่ระบบ*มี* ไม่ใช่ที่ทำได้ ' +
      '*ตอนนี้* คำตอบต่อใบต่อคนอยู่ที่ `requests/{ref}/actions` เท่านั้น\n\n' +
      '**สถานะหลังสร้างไม่แน่นอน** — ประเภทที่มีตารางอำนาจอนุมัติแบบก่อนทำงาน ' +
      '(`request:<CODE>:pre`) จะได้ `pending_approval` ประเภทที่ไม่มีจะได้ `submitted` ' +
      'อ่านจาก `status` ที่ตอบกลับมา อย่าสมมติ\n\n' +
      'ข้อยกเว้นหนึ่งเดียวที่ **ไม่มี** `X-Acting-User`: ' +
      '`POST /request/intake` — ระบบยื่นคำขอในนามตัวเอง `source: "system"` ' +
      'ไม่มีคนเป็นผู้ยื่น (REQ-10) ถ้าต้องการให้ timeline เป็นชื่อคน ใช้ ' +
      '`POST /request/requests` พร้อม `X-Acting-User` แทน',
    tags: [
      {
        name: 'request',
        description: 'คำขอ — เปิด, ติดตาม, ดำเนินการ, ปิด',
      },
    ],
  },
  crm: {
    title: 'Request Form — External API · CRM',
    summary:
      'ทะเบียนลูกค้า, Lead, โอกาสการขาย, ใบเสนอราคา, ใบสั่งขาย และหน้าตั้งค่า CRM',
    notes:
      'สาม route ที่ **ไม่มี** `X-Acting-User` เพราะไม่มีคนอยู่ปลายสาย: ' +
      '`POST /crm/leads/intake` (เว็บฟอร์มของลูกค้า — ใบที่เข้ามาไม่มีเจ้าของ ' +
      'รอพนักงานขายกดรับ) และ `GET|POST /crm/leads/{id}/facts|stage` ' +
      '(workflow engine อ่านและบันทึกขั้นที่ตัดสินใจแล้ว)\n\n' +
      'การมองเห็นแถวยังเดินผ่านตัวกรองเดิมทุกเส้นทาง และการอ่านข้ามบริษัทตอบ ' +
      '**404 ไม่ใช่ 403** (SCOPE-03) — เปิด CRM ออกมาทางนี้ไม่ได้ให้สิทธิ์ใหม่แก่ใคร',
    tags: [
      { name: 'crm', description: 'ทะเบียนลูกค้าและงานขาย' },
      { name: 'crm-intake', description: 'ช่องทางรับ Lead จากระบบภายนอก' },
      {
        name: 'crm-workflow',
        description: 'workflow engine อ่านและเลื่อนขั้น Lead',
      },
    ],
  },
  approval: {
    title: 'Request Form — External API · Approval',
    summary: 'เปิดเคสอนุมัติจากโมดูลอื่นที่ไม่มีคำขอในระบบรองรับ (APV-07)',
    notes:
      '**endpoint นี้ไม่มีคนทั้งเส้น** ผู้เรียกคือโมดูล ไม่ใช่คน จึงไม่ต้องส่ง ' +
      '`X-Acting-User` และส่งมาก็ไม่มีผล ชื่อที่บันทึกใน audit เป็นบัญชีบริการ ' +
      'ซึ่งถูกต้องแล้ว — การใส่ชื่อคนให้มันคือการบันทึกว่ามีคนทำสิ่งที่ไม่มีใครทำ',
    tags: [
      {
        name: 'approval',
        description: 'เปิดเคสอนุมัติจากโมดูลอื่น (APV-07)',
      },
    ],
  },
  flow: {
    title: 'Request Form — External API · Flow',
    summary:
      'ติดตามดีลหนึ่งใบทั้งสาย — ดีล → Pre-Sales → ใบเสนอราคา → ใบสั่งขาย → สัญญา → โครงการ',
    notes:
      '`stage` คือขั้นที่ไปถึง**ไกลที่สุด** อ่านจากสิ่งที่มีอยู่ ไม่ได้เก็บไว้ · ' +
      '`next_steps` บอก endpoint ที่ใช้เดินต่อ (เป็นคำแนะนำ — route ปลายทางยังตัดสินเอง)\n\n' +
      'แต่ละส่วนอ่านผ่าน service เดียวกับหน้าจอในนามคนใน `X-Acting-User` ' +
      'ส่วนที่คนนั้นไม่มีสิทธิ์เห็นตอบ `{ visible: false, reason }` แทนการล้มทั้งคำตอบ ' +
      'ดีลที่มองไม่เห็นตอบ 404',
    tags: [{ name: 'flow', description: 'ติดตามดีลทั้งสาย' }],
  },
  presales: {
    title: 'Request Form — External API · Pre-Sales',
    summary: 'Solution ของดีล — อ่านอย่างเดียว',
    notes:
      '**เริ่ม Pre-Sales ไม่ได้อยู่ที่นี่** — ยื่นคำขอประเภท `solutionRequestTypeCode` ' +
      'ของดีล (จาก `GET /crm/opportunities/{id}`) ผ่าน `POST /request/requests` ' +
      'พร้อม `ref_type=opportunity` และ `ref_id=<เลขดีล>` ' +
      'การออกแบบ Solution ทำบนหน้าจอของทีม Pre-Sales',
    tags: [{ name: 'presales', description: 'Solution ของ Pre-Sales' }],
  },
  legal: {
    title: 'Request Form — External API · Legal',
    summary: 'คลังสัญญา — อ่านอย่างเดียว',
    notes:
      '**ขอทำสัญญา** = ยื่นคำขอประเภท `contractRequestTypeCode` ของดีลผ่าน ' +
      '`POST /request/requests` พร้อม `ref_type=opportunity` · ' +
      'ร่าง ตรวจ อนุมัติ และลงนามทำบนหน้าจอฝ่ายกฎหมาย · ' +
      'ผู้ใช้ใน `X-Acting-User` ต้องถือ `legal.contract.read` และสัญญาลับพิเศษเห็นเฉพาะผู้มีสิทธิ์',
    tags: [{ name: 'legal', description: 'คลังสัญญา' }],
  },
  pm: {
    title: 'Request Form — External API · PM',
    summary: 'โครงการ — ค้น อ่าน และเปิดโครงการจากสัญญาที่ลงนามแล้ว',
    notes:
      'เปิดโครงการ: `GET /pm/projects/openable-contracts` → ' +
      '`GET /pm/projects/preview/{contractId}` (ดู `problems`) → `POST /pm/projects` ' +
      'ส่ง `Idempotency-Key` ทุกครั้ง · ต้องถือ `pm.project.manage`',
    tags: [{ name: 'pm', description: 'โครงการ' }],
  },
  delivery: {
    title: 'Request Form — External API · Delivery',
    summary: 'การส่งมอบของโครงการ — แผนส่งมอบ งวดวางบิล และการส่งต่อทีมบริการ',
    notes:
      'อ่านอย่างเดียว — ยืนยันติดตั้ง ใบรับรองการตรวจรับ และส่งวางบิลเข้า SAP ' +
      'ทำบนหน้าจอ เพราะลงนามเอกสารและสร้างรายการใน SAP',
    tags: [{ name: 'delivery', description: 'การส่งมอบและวางบิล' }],
  },
  support: {
    title: 'Request Form — External API · Support',
    summary:
      'งานบริการหลังการขาย — ทะเบียนอุปกรณ์ สิทธิ์บริการ และเปิดใบสั่งงานบริการ',
    notes:
      '`POST /support/work-orders` สร้างเคสตามประเภทที่ตั้งในหน้าตั้งค่า CRM แล้วยื่นทันที ' +
      '(นาฬิกา SLA เริ่ม) ติดตามต่อด้วย `GET /request/requests/{requestNo}` · ' +
      'ลูกค้าแจ้งเองใช้ช่องทาง `request/intake/*` หรือ Customer Portal ไม่ใช่ที่นี่',
    tags: [{ name: 'support', description: 'งานบริการหลังการขาย' }],
  },
  kb: {
    title: 'Request Form — External API · KBMS',
    summary:
      'คลังความรู้สำหรับช่องทาง AI ที่คุยกับลูกค้า (AI CARE, AI SMART) — ค้นบทความแล้วรายงานคำตอบและบทความที่อ้างอิง',
    notes:
      'หุ่นยนต์เท่านั้น (key ที่มี `integration.kb.read`) · ได้เฉพาะบทความที่เผยแพร่ให้ลูกค้า ' +
      '(ทุกราย หรือรายที่ระบุด้วย customer_code) ไม่มีบทความภายใน · ค้นทั้งคำและความหมาย (CD-267) · ทุกการค้นถูกบันทึก',
    tags: [{ name: 'kb', description: 'คลังความรู้สำหรับ AI (CD-265)' }],
  },
  care: {
    title: 'Request Form — External API · AI CARE',
    summary:
      'บทสนทนากับลูกค้าเดิมทุกช่องทาง (LINE, Facebook, Instagram, TikTok, อีเมล, เว็บแชต, D-Callcenter) สำหรับตัวเชื่อมช่องทางและ AI CARE',
    notes:
      'หุ่นยนต์เท่านั้น (key ที่มี `integration.service.care.manage`) บริษัทมาจาก key · ' +
      'ข้อความของผู้ส่งเดียวกันต่อบทสนทนาเดิม (เงียบ 24 ชม. เริ่มใหม่) · ' +
      'ข้อมูลลูกค้า อุปกรณ์ และสิทธิ์บริการส่งกลับเฉพาะผู้ส่งที่ยืนยันตัวตนแล้ว ' +
      '(ตัวตนจากช่องทางตรงผู้ติดต่อ หรือทีมบริการยืนยัน) · สิ่งที่ลูกค้าพิมพ์แจ้งเป็นแค่ "อ้างว่าเป็น"',
    tags: [{ name: 'care', description: 'AI CARE — บทสนทนา (CD-280)' }],
  },
  assistant: {
    title: 'Request Form — External API · Assistant',
    summary:
      'คำถามของผู้ช่วยส่วนตัว — ดีลใกล้ปิด/เงียบ งานรออนุมัติ โครงการมีปัญหา งานบริการค้าง บทความ และตัวเลขสรุป',
    notes:
      'อ่านอย่างเดียว · ทุกคำตอบเรียก service ตัวเดียวกับหน้าจอในนามของผู้ถาม ' +
      'จึงไม่เห็นเกินกว่าที่หน้าจอของคนนั้นแสดง · ใช้ผ่าน MCP เป็นหลัก (`assistant_*`)',
    tags: [{ name: 'assistant', description: 'ผู้ช่วยส่วนตัว (CD-276)' }],
  },
  smart: {
    title: 'Request Form — External API · AI SMART',
    summary: 'ส่งรายชื่อธุรกิจที่กวาดได้ (crawler/ผู้ให้บริการข้อมูล) เข้าคิวของ AI SMART',
    notes:
      'ไม่มี `X-Acting-User` — ระบบภายนอกส่งในนามตัวเอง (`integration.smart.prospect.create`) · ' +
      'ต้องมีแหล่งชนิด push ที่ตั้งไว้ในหน้า AI SMART ของบริษัทเดียวกับกุญแจ · ' +
      'ส่งซ้ำได้ รายการที่มีอยู่แล้วนับเป็นซ้ำ · ยังไม่เข้า CRM จนกว่าจะผ่านการคัดกรอง',
    tags: [{ name: 'smart', description: 'AI SMART — รับรายชื่อที่กวาดได้' }],
  },
  documents: {
    title: 'Request Form — External API · Documents',
    summary:
      'เอกสารบริษัทที่อัปโหลดในหน้าตั้งค่า — รายการ วันที่ออกเอกสาร และดาวน์โหลดไฟล์',
    notes:
      'หุ่นยนต์เท่านั้น (key ที่มี `integration.document.read`) บริษัทมาจาก key · ' +
      '`kind`: `dated` = มีวันที่ออกเอกสาร (`issue_date` เป็น YYYY-MM-DD เสมอ) · ' +
      '`general` = เอกสารทั่วไป (`issue_date` เป็น null) · ' +
      'ไฟล์ที่ `GET /documents/{id}/file` (ทุกครั้งบันทึก audit) · เอกสารที่เลิกใช้ตอบ 404',
    tags: [{ name: 'documents', description: 'เอกสารบริษัท' }],
  },
  mcp: {
    title: 'Request Form — External API · MCP',
    summary: 'ช่องทาง JSON-RPC สำหรับ tool-caller (LibreChat, MCP client)',
    notes:
      '**นี่ไม่ใช่ REST API และเอกสารนี้อธิบายมันได้แค่ครึ่งเดียว** — ' +
      'มี endpoint เดียว ชื่อ tool อยู่ใน `params.name` ของ body ไม่ใช่ใน path ' +
      'จึงไม่มี `/mcp/request-types` และไม่มี URL ต่อ tool\n\n' +
      'รายการ tool จริงอยู่ที่ `docs/openapi/external-tools.json` ' +
      'ซึ่ง `tools/list` อ่านจากไฟล์นั้นตรง ๆ ' +
      'วิธีเรียกและวิธีตั้งค่าใน LibreChat อยู่ใน `docs/EXTERNAL_API.md` §4.4\n\n' +
      'แยกไฟล์ออกมาเพราะเหตุนี้: ปล่อยให้ปนอยู่กับ path ที่ยิงแบบ REST ได้ ' +
      'ทำให้ integrator เข้าใจว่ายิงแบบเดียวกันได้',
    tags: [
      { name: 'mcp', description: 'JSON-RPC — ชื่อ tool อยู่ใน body' },
    ],
  },
};

/** Served by external-service but never handed to a partner. */
const NOT_A_PARTNER_MODULE = ['health'];

/**
 * The partner-facing documents: one file per module, cut from the
 * external-service document that was just built.
 *
 * Cut rather than generated from a module of its own, because a second
 * `SwaggerModule.createDocument` would describe a second application — one
 * assembled here, in this script, that no server runs. Filtering the real
 * document keeps §14's guarantee: what integrators receive is what
 * external-service actually serves.
 *
 * **One file per module rather than one combined file.** The combined
 * `external-api.json` was 70 paths and 221 KB, and somebody wiring up CRM had
 * to read past the request flow and the approval engine to find their own
 * endpoints. Grouping is by the path segment after the prefix, so a module
 * added later gets its own document without this function changing — it only
 * needs an entry in {@link MODULE_DOCS} for its prose.
 */
function writeExternalDocuments(document: OpenAPIObject, prefix: string): void {
  const byModule = new Map<string, Record<string, unknown>>();

  for (const [path, item] of Object.entries(document.paths)) {
    if (!path.startsWith(`/${prefix}/`)) continue;

    const module = path.slice(prefix.length + 2).split('/')[0];
    if (NOT_A_PARTNER_MODULE.includes(module)) continue;

    const paths = byModule.get(module) ?? {};
    paths[path] = item;
    byModule.set(module, paths);
  }

  const allSchemas = (document.components?.schemas ?? {}) as Record<
    string,
    unknown
  >;

  for (const [module, paths] of [...byModule].sort()) {
    const doc = MODULE_DOCS[module];

    /*
      A module with no prose still gets its document — blocking `yarn openapi`
      over a missing paragraph would stop every other module from being
      regenerated too. It says so loudly instead, because an integrator
      reading a document with no description is the real cost.
    */
    if (!doc) {
      console.warn(
        `⚠️  module '${module}' has no entry in MODULE_DOCS — ` +
          'its document will carry no description. Add one.',
      );
    }

    const used = new Set<string>();
    collectRefs(paths, allSchemas, used);

    const description = [
      doc?.summary,
      SHARED_RULES,
      doc?.notes,
    ]
      .filter(Boolean)
      .join('\n\n');

    const external = {
      ...document,
      info: {
        title: doc?.title ?? `Request Form — External API · ${module}`,
        description,
        version: document.info.version,
      },
      tags: doc?.tags ?? [],
      /*
        Where the document was true of when it was generated. Integrators import
        the file and press Try it: without this they are asked for a base URL
        they have no way to guess.

        **No path prefix here.** `setGlobalPrefix` already put `/${prefix}` into
        every key of `paths`, so a server URL carrying it too made Try it request
        `/api/v1/api/v1/request/...` and answer 404 — for everyone, on the very
        first thing an integrator does with the file. `EXTERNAL_API_PUBLIC_URL`
        must be prefix-free for the same reason: origin only, no trailing path.
      */
      servers: [
        {
          url: process.env.EXTERNAL_API_PUBLIC_URL ?? 'http://192.168.31.52:3503',
          description: 'เครื่องภายใน OSD',
        },
      ],
      paths,
      components: {
        ...document.components,
        schemas: Object.fromEntries(
          [...used].sort().map((name) => [name, allSchemas[name]]),
        ),
      },
    };

    const file = `docs/openapi/external-${module}.json`;
    writeFileSync(file, `${JSON.stringify(external, null, 2)}\n`);

    // `paths` is `Record<string, unknown>`, so the accumulator needs naming.
    const operations = Object.values(paths).reduce<number>(
      (total, item) => total + Object.keys(item as object).length,
      0,
    );
    console.log(
      `external-${module}: ${Object.keys(paths).length} paths · ` +
        `${operations} operations · ${used.size} schemas → ${file}`,
    );
  }

  writeEndpointIndex(byModule, prefix);
}

/** HTTP verbs as they appear as keys of an OpenAPI path item. */
const VERBS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/**
 * `docs/EXTERNAL_API_INDEX.md` — every external route on one page, with both
 * gates, for the integration guide to point at (6 Oct 2026).
 *
 * Generated here, never typed: `EXTERNAL_API.md` forbids a hand-kept copy of
 * the endpoint list because two lists stop agreeing the day one is edited.
 * This one is rewritten from the same document on every `yarn openapi`.
 */
function writeEndpointIndex(
  byModule: Map<string, Record<string, unknown>>,
  prefix: string,
): void {
  const cell = (value: unknown): string =>
    (Array.isArray(value) ? value.join(', ') : String(value ?? ''))
      .replace(/\|/g, '\\|')
      .replace(/\s+/g, ' ')
      .trim();
  const lines = [
    '# External API — ดัชนี endpoint ทั้งหมด',
    '',
    '> **ไฟล์นี้สร้างโดย `yarn openapi` — อย่าแก้มือ** แก้ที่ controller แล้วรันใหม่',
    '> ลำดับการเรียกตามสายงานอยู่ที่ [`EXTERNAL_API_GUIDE.md`](./EXTERNAL_API_GUIDE.md)',
    '',
    `ทุก path นำหน้าด้วย \`/${prefix}\` · **สิทธิ์กุญแจ** = ต้องอยู่ใน \`scopes\` ของ API key · ` +
      '**สิทธิ์คน** = คนใน `X-Acting-User` ต้องถือ (ว่าง = route ที่ไม่มีคน หรือ service ตรวจเอง)',
    '',
  ];

  for (const [module, paths] of [...byModule].sort()) {
    const doc = MODULE_DOCS[module];
    lines.push(`## ${module}${doc ? ` — ${doc.summary}` : ''}`, '');
    lines.push('| Method | Path | ทำอะไร | สิทธิ์กุญแจ | สิทธิ์คน |');
    lines.push('|---|---|---|---|---|');
    for (const [path, item] of Object.entries(paths)) {
      for (const verb of VERBS) {
        const operation = (item as Record<string, Record<string, unknown>>)[
          verb
        ];
        if (!operation) continue;
        lines.push(
          `| ${verb.toUpperCase()} | \`${path.slice(prefix.length + 1)}\` | ` +
            `${cell(operation.summary)} | ${cell(operation['x-permission'])} | ` +
            `${cell(operation['x-acting-permission'])} |`,
        );
      }
    }
    lines.push('');
  }

  writeFileSync('docs/EXTERNAL_API_INDEX.md', lines.join('\n'));
  console.log('external index → docs/EXTERNAL_API_INDEX.md');
}

async function generate(
  name: string,
  module: Parameters<typeof NestFactory.create>[0],
  prefix: string,
): Promise<void> {
  const app = await NestFactory.create(module, { logger: false });
  app.setGlobalPrefix(prefix);

  const config = new DocumentBuilder()
    .setTitle(`request-management ${name}`)
    .setVersion('1.0')
    .addBearerAuth()
    .addGlobalParameters({
      name: 'X-Company-Id',
      in: 'header',
      required: false,
      description: 'บริษัทที่คำขอนี้ทำงานอยู่ (§11.1) — ว่าง = บริษัทหลัก',
      schema: { type: 'string' },
    })
    .build();

  const document = SwaggerModule.createDocument(app, config);

  const stamped = stampRouteGates(document, routeGatesByRoute(app, prefix));
  const enriched = enrichFromValidators(app, document, prefix);

  mkdirSync('docs/openapi', { recursive: true });
  writeFileSync(
    `docs/openapi/${name}.json`,
    `${JSON.stringify(document, null, 2)}\n`,
  );

  const paths = Object.keys(document.paths).length;
  console.log(
    `${name}: ${paths} paths, ${stamped.declared} permission, ` +
      `${stamped.acting} acting-permission, ` +
      `${stamped.sensitive} sensitive-resource · ` +
      `${enriched.constraints} constraint · ${enriched.properties} property · ` +
      `${enriched.queryParams} query param · ${enriched.requiredFixed} required แก้ ` +
      `→ docs/openapi/${name}.json`,
  );

  if (name === 'external-service') writeExternalDocuments(document, prefix);

  await app.close();
}

/** สิ่งที่ decorator ประกาศไว้ต่อ route แต่ Swagger มองไม่เห็น. */
interface RouteGates {
  /**
   * `@Permissions` — สิทธิ์ที่ตัดสิน credential ที่ยิงเข้ามา บนพอร์ตภายนอกคือ
   * `scopes` ของกุญแจ (`integration.*`) บนพอร์ตของหน้าเว็บคือสิทธิ์ของคน.
   */
  declared?: string[];
  /** `@ActingPermissions` — สิทธิ์ของคนใน `X-Acting-User`. */
  acting?: string[];
  /** `@SensitiveResource` — ชุดกฎปกปิดที่ใช้กับคำตอบของ route นี้. */
  sensitive?: string;
}

/**
 * สิ่งที่ decorator ประกาศไว้ต่อ route คีย์ด้วย `METHOD /path` แบบ OpenAPI.
 *
 * ทั้งสองอย่างประกาศด้วย decorator ซึ่ง Swagger ไม่รู้จัก — ถ้าไม่ดึงออกมาไว้ในเอกสาร
 * ตัวสร้าง tool ของ MCP ก็ไม่มีทางรู้ว่า tool ไหนต้องตรวจสิทธิ์อะไรของคน และ tool ไหน
 * ต้องปกปิดฟิลด์ไหน — MCP จะเหลือประตูเดียวและไม่ปกปิดอะไรเลยตลอดไป
 *
 * `@SensitiveResource` สำคัญเป็นพิเศษกับ MCP เพราะฝั่ง REST มันถูกบังคับโดย
 * interceptor ที่อ่าน metadata จาก handler ที่ถูกเรียก — MCP เรียก service ตรง ๆ
 * interceptor จึงไม่ทำงาน และต้องมีค่านี้ติดมากับ tool ถึงจะปกปิดเองได้
 *
 * อ่านจาก metadata ที่เซิร์ฟเวอร์ใช้จริง ไม่ใช่ parse ข้อความในไฟล์ — route ที่ถูก
 * เปลี่ยนชื่อแล้วจะหลุดออกไปเอง ไม่ค้างอยู่เพราะไม่มีใครมาลบ
 */
function routeGatesByRoute(
  app: INestApplication,
  prefix: string,
): Map<string, RouteGates> {
  const found = new Map<string, RouteGates>();

  for (const { key, controller, handler } of routesOf(app, prefix)) {
    const read = <T>(metaKey: string): T | undefined =>
      (Reflect.getMetadata(metaKey, handler) as T | undefined) ??
      (Reflect.getMetadata(metaKey, controller) as T | undefined);

    const permissions = read<string[]>(ACTING_PERMISSIONS_KEY);
    const sensitive = read<string>(SENSITIVE_RESOURCE_KEY);
    const declared = read<string[]>(PERMISSIONS_KEY);

    if (!permissions?.length && !sensitive && !declared?.length) continue;

    /*
      สอง handler ที่ผูก METHOD+path เดียวกันคือ route ที่ทับกัน — Express จับตัวที่
      register ก่อน อีกตัวกลายเป็นโค้ดที่เรียกไม่ถึง และ OpenAPI เก็บได้ operation
      เดียวต่อ path จึงบรรยายตัวหนึ่งแต่ประทับสิทธิ์ของอีกตัว

      เคยเกิดจริงกับ `POST crm/leads` (intake vs sales create) และไม่มีอะไรส่งเสียง
      เลยจนกว่าจะมีคนยิงแล้วได้ error ที่อ่านไม่ออก — เตือนที่นี่เพราะที่นี่คือที่แรก
      ที่มองเห็นทั้งสองตัวพร้อมกัน
    */
    if (found.has(key)) {
      console.warn(
        `  ⚠ route ซ้ำ: ${key} — มีมากกว่าหนึ่ง handler ผูกอยู่ ` +
          'ตัวที่ register ทีหลังเรียกไม่ถึง',
      );
    }

    found.set(key, {
      ...(declared?.length ? { declared: [...declared] } : {}),
      ...(permissions?.length ? { acting: [...permissions] } : {}),
      ...(sensitive ? { sensitive } : {}),
    });
  }

  return found;
}

/**
 * ประทับสิทธิ์ของทั้งสองประตูและกฎปกปิดลงบน operation.
 *
 * คืนจำนวนที่ประทับแยกกัน เพราะ route ส่วนใหญ่มีอย่างแรกอย่างเดียว การรวมเป็นเลข
 * เดียวทำให้มองไม่ออกว่าการปกปิดหลุดไปทั้งชุดหรือเปล่า
 */
function stampRouteGates(
  document: OpenAPIObject,
  gates: Map<string, RouteGates>,
): { declared: number; acting: number; sensitive: number } {
  const stamped = { declared: 0, acting: 0, sensitive: 0 };

  for (const [path, item] of Object.entries(document.paths)) {
    for (const [verb, operation] of Object.entries(item)) {
      if (typeof operation !== 'object' || operation === null) continue;

      const gate = gates.get(`${verb.toUpperCase()} ${path}`);
      if (!gate) continue;

      if (gate.declared) {
        Object.assign(operation, { 'x-permission': gate.declared });
        stamped.declared += 1;
      }

      if (gate.acting) {
        Object.assign(operation, { 'x-acting-permission': gate.acting });
        stamped.acting += 1;
      }

      if (gate.sensitive) {
        Object.assign(operation, { 'x-sensitive-resource': gate.sensitive });
        stamped.sensitive += 1;
      }
    }
  }

  return stamped;
}

async function main(): Promise<void> {
  await generate('core-service', CoreServiceModule, 'api/v1');
  await generate('user-service', UserServiceModule, 'api/v1');
  await generate('external-service', ExternalServiceModule, 'api/v1');
  writeWebhookDocument('1.0');
}

main().catch((error) => {
  // เดิมเป็น `void main()` ซึ่งทำให้ unhandled rejection ออกมาเป็น exit 1 เปล่า ๆ
  // ไม่มีข้อความอะไรเลย — หาสาเหตุไม่ได้จนกว่าจะไปแก้ไฟล์นี้ก่อน
  console.error(error);
  process.exit(1);
});
