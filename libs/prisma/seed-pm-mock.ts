/**
 * Mock data for the โครงการ (PM) menu — projects with their team, work plan,
 * milestones, budget, progress, risks, issues, a change request, costs,
 * config items, and HR bookings so ภาระงานทีม has something to show.
 *
 *   DATABASE_URL=postgresql://request_admin:osd%401234@localhost:5434/osd_request_form \
 *   PM_MOCK_ALLOW=1 yarn pm:mock [COMPANY_CODE]        # default OSD_DEMO
 *
 *   PM_MOCK_ALLOW=1 yarn pm:mock --clean               # remove the mock only
 *
 * Every row it writes has an id starting `mock-pm-`; each run removes those
 * first, so it is safe to re-run. Dates are relative to today, so the plan
 * always looks "in progress". Never run it against production.
 */
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const P = 'mock-pm-';

// --- dates -------------------------------------------------------------------

const TODAY = new Date(
  Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()),
);
const day = (offset: number) => new Date(TODAY.getTime() + offset * 86_400_000);
const at = (offset: number, hour = 10) =>
  new Date(day(offset).getTime() + hour * 3_600_000);

// --- people ------------------------------------------------------------------

const PEOPLE = [
  { key: 'pm1', username: 'mock.somchai', first: 'สมชาย', last: 'ใจดี', position: 'Project Manager', level: 'PROJECT-MANAGER' },
  { key: 'pm2', username: 'mock.suda', first: 'สุดา', last: 'วงศ์ทอง', position: 'Project Manager', level: 'PROJECT-MANAGER' },
  { key: 'se1', username: 'mock.anan', first: 'อนันต์', last: 'ศรีสุข', position: 'Senior Engineer', level: 'SENIOR-ENGINEER' },
  { key: 'en1', username: 'mock.preecha', first: 'ปรีชา', last: 'มั่นคง', position: 'Network Engineer', level: 'ENGINEER' },
  { key: 'en2', username: 'mock.kanya', first: 'กัญญา', last: 'แสงทอง', position: 'Software Developer', level: 'ENGINEER' },
  { key: 'tc1', username: 'mock.wirat', first: 'วิรัตน์', last: 'ทองดี', position: 'Technician', level: 'TECHNICIAN' },
  { key: 'tc2', username: 'mock.manop', first: 'มานพ', last: 'รักงาน', position: 'Technician', level: 'TECHNICIAN' },
] as const;
type PersonKey = (typeof PEOPLE)[number]['key'] | 'me';

// --- projects ----------------------------------------------------------------

interface TaskSpec {
  title: string;
  days: number;
  owner?: PersonKey;
  crew?: PersonKey[];
  /** fraction of leaf tasks done is driven by `progress`; override here */
  status?: 'open' | 'in_progress' | 'done' | 'cancelled';
  milestone?: number;
  devKind?: 'iteration' | 'item';
}
interface PhaseSpec {
  title: string;
  tasks: TaskSpec[];
}
interface ProjectSpec {
  no: number;
  name: string;
  customer: { nameTh: string; nameEn: string; type: 'corporate' | 'government'; taxId: string };
  manager: PersonKey;
  team: { who: PersonKey; role: string }[];
  status: 'active' | 'on_hold' | 'closed' | 'cancelled';
  startOffset: number;
  endOffset: number;
  value: number;
  /** % of leaf work done, in plan order */
  progress: number;
  /** extra points behind/ahead of plan reported by the manager */
  reportedPct: number;
  plannedPct: number;
  scope: string[];
  outOfScope: string[];
  deliverables: { title: string; description: string; criteria: string[] }[];
  phases: PhaseSpec[];
  milestones: { title: string; dueOffset: number; achieved?: boolean; criteria: string[]; pct: number; kind: string; penalty?: boolean }[];
  budget: { category: string; code: string; description: string; quantity: number; unit: string; unitCost: number }[];
  risks: { title: string; description: string; source: string; l: number; i: number; owner: PersonKey; response?: string; status?: string }[];
  issues: { title: string; description: string; severity: string; dueOffset: number; owner: PersonKey; days: number; cost: number; resolved?: string; kind?: string; cause?: string }[];
  change?: { title: string; reason: string; added: string; days: number; price: number; cost: { description: string; quantity: number; unit: string; unitCost: number }[]; status: string };
  costs: { category: string; description: string; amount: number; offset: number; vendor: string }[];
  configs: { system: string; key: string; value: string; note?: string }[];
  bookings: { who: PersonKey; from: number; to: number; hours: number; note: string }[];
}

const PROJECTS: ProjectSpec[] = [
  {
    no: 1,
    name: 'ระบบกล้องวงจรปิด อาคารสำนักงานใหญ่ ธนาคารสยามพัฒนา',
    customer: { nameTh: 'ธนาคารสยามพัฒนา จำกัด (มหาชน)', nameEn: 'Siam Pattana Bank PCL', type: 'corporate', taxId: '0107599000011' },
    manager: 'me',
    team: [
      { who: 'se1', role: 'วิศวกรออกแบบระบบ' },
      { who: 'en1', role: 'วิศวกรเครือข่าย' },
      { who: 'tc1', role: 'ช่างติดตั้ง' },
      { who: 'tc2', role: 'ช่างติดตั้ง' },
    ],
    status: 'active',
    startOffset: -45,
    endOffset: 75,
    value: 4_850_000,
    progress: 0.45,
    reportedPct: 42,
    plannedPct: 40,
    scope: [
      'ติดตั้งกล้อง IP 4MP จำนวน 120 ตัว ครอบคลุม 12 ชั้น และลานจอดรถ',
      'ติดตั้ง NVR พร้อมพื้นที่จัดเก็บ 90 วัน',
      'ห้องควบคุมพร้อมจอแสดงผล 6 จอ',
      'อบรมผู้ใช้งาน 2 รอบ',
    ],
    outOfScope: ['งานโยธาและเดินท่อร้อยสายภายนอกอาคาร', 'ไฟฟ้าสำรอง UPS ของอาคาร'],
    deliverables: [
      { title: 'แบบติดตั้ง (Shop drawing)', description: 'แบบตำแหน่งกล้องทุกชั้น', criteria: ['ลูกค้าลงนามอนุมัติแบบ'] },
      { title: 'ระบบกล้องพร้อมใช้งาน', description: 'กล้อง 120 ตัว ภาพชัดและบันทึกครบ', criteria: ['ทดสอบภาพครบทุกตัว', 'บันทึกย้อนหลังได้ 90 วัน'] },
      { title: 'คู่มือและการอบรม', description: 'คู่มือผู้ใช้และผู้ดูแล', criteria: ['อบรมครบ 2 รอบ'] },
    ],
    phases: [
      {
        title: 'สำรวจและออกแบบ',
        tasks: [
          { title: 'สำรวจหน้างาน 12 ชั้น', days: 5, owner: 'se1', crew: ['tc1'] },
          { title: 'จัดทำแบบติดตั้ง', days: 7, owner: 'se1' },
          { title: 'ลูกค้าอนุมัติแบบ', days: 0, owner: 'me', milestone: 1 },
        ],
      },
      {
        title: 'จัดหาอุปกรณ์',
        tasks: [
          { title: 'สั่งซื้อกล้องและ NVR', days: 3, owner: 'me' },
          { title: 'รับของและตรวจสภาพ', days: 10, owner: 'tc1' },
        ],
      },
      {
        title: 'ติดตั้ง',
        tasks: [
          { title: 'เดินสาย LAN ชั้น 1–6', days: 8, owner: 'tc1', crew: ['tc2'] },
          { title: 'เดินสาย LAN ชั้น 7–12 และลานจอด', days: 8, owner: 'tc2', crew: ['tc1'] },
          { title: 'ติดตั้งกล้องและตั้งค่า', days: 10, owner: 'en1', crew: ['tc1', 'tc2'] },
          { title: 'ติดตั้งห้องควบคุม', days: 4, owner: 'en1', milestone: 2 },
        ],
      },
      {
        title: 'ทดสอบและส่งมอบ',
        tasks: [
          { title: 'ทดสอบระบบ (SAT)', days: 5, owner: 'se1', crew: ['en1'] },
          { title: 'อบรมผู้ใช้งาน', days: 2, owner: 'se1' },
          { title: 'ตรวจรับงาน', days: 0, owner: 'me', milestone: 3 },
        ],
      },
    ],
    milestones: [
      { title: 'อนุมัติแบบติดตั้ง', dueOffset: -25, achieved: true, criteria: ['ลูกค้าลงนามแบบ'], pct: 0.3, kind: 'deposit' },
      { title: 'ติดตั้งครบทุกชั้น', dueOffset: 20, criteria: ['กล้องติดตั้งครบ 120 ตัว', 'ห้องควบคุมพร้อม'], pct: 0.5, kind: 'progress', penalty: true },
      { title: 'ตรวจรับงาน', dueOffset: 70, criteria: ['ผ่าน SAT', 'อบรมครบ'], pct: 0.2, kind: 'final', penalty: true },
    ],
    budget: [
      { category: 'material', code: 'CAM-IP-4MP', description: 'กล้อง IP 4MP', quantity: 120, unit: 'ตัว', unitCost: 14_500 },
      { category: 'material', code: 'NVR-64CH', description: 'NVR 64 ช่อง', quantity: 2, unit: 'เครื่อง', unitCost: 185_000 },
      { category: 'material', code: 'HDD-12TB', description: 'ฮาร์ดดิสก์ 12TB', quantity: 16, unit: 'ลูก', unitCost: 11_200 },
      { category: 'material', code: 'CBL-CAT6', description: 'สาย LAN CAT6', quantity: 30, unit: 'กล่อง', unitCost: 4_200 },
      { category: 'labor', code: 'ENG', description: 'วิศวกร', quantity: 45, unit: 'manday', unitCost: 6_000 },
      { category: 'labor', code: 'TECH', description: 'ช่างติดตั้ง', quantity: 80, unit: 'manday', unitCost: 2_800 },
    ],
    risks: [
      { title: 'อุปกรณ์ส่งล่าช้าจากผู้นำเข้า', description: 'ผู้นำเข้าแจ้ง lead time 6 สัปดาห์', source: 'technical', l: 3, i: 3, owner: 'me', response: 'สั่งของล่วงหน้าและมีผู้ขายสำรอง', status: 'mitigated' },
      { title: 'เข้าพื้นที่ได้เฉพาะนอกเวลาทำการ', description: 'ธนาคารอนุญาตเฉพาะหลัง 18:00 และวันหยุด', source: 'project', l: 4, i: 2, owner: 'tc1', response: 'จัดกะทำงานกลางคืน' },
    ],
    issues: [
      { title: 'ฝ้าชั้น 8 เปิดไม่ได้บางจุด', description: 'ต้องรอผู้รับเหมาอาคารเปิดฝ้า', severity: 'medium', dueOffset: 5, owner: 'tc2', days: 2, cost: 0 },
    ],
    costs: [
      { category: 'material', description: 'กล้อง IP 4MP งวดแรก 60 ตัว', amount: 870_000, offset: -20, vendor: 'บจก. วิชั่นเทค' },
      { category: 'material', description: 'สาย LAN CAT6 30 กล่อง', amount: 126_000, offset: -15, vendor: 'บจก. ลิงก์ซัพพลาย' },
    ],
    configs: [
      { system: 'NVR-01', key: 'ip_address', value: '10.20.1.11' },
      { system: 'NVR-01', key: 'retention_days', value: '90' },
      { system: 'NVR-02', key: 'ip_address', value: '10.20.1.12' },
      { system: 'Core Switch', key: 'vlan_cctv', value: '120', note: 'VLAN สำหรับกล้องทั้งหมด' },
    ],
    bookings: [
      { who: 'se1', from: -45, to: 75, hours: 4, note: 'ออกแบบ/ทดสอบ' },
      { who: 'en1', from: -5, to: 40, hours: 8, note: 'ติดตั้งและตั้งค่า' },
      { who: 'tc1', from: -10, to: 30, hours: 8, note: 'ติดตั้ง' },
      { who: 'tc2', from: -10, to: 30, hours: 6, note: 'ติดตั้ง' },
    ],
  },
  {
    no: 2,
    name: 'ปรับปรุงเครือข่าย Data Center โรงพยาบาลเมืองใหม่',
    customer: { nameTh: 'โรงพยาบาลเมืองใหม่', nameEn: 'Muang Mai Hospital', type: 'government', taxId: '0994000123456' },
    manager: 'pm1',
    team: [
      { who: 'me', role: 'ผู้ประสานงาน' },
      { who: 'se1', role: 'วิศวกรเครือข่ายอาวุโส' },
      { who: 'en1', role: 'วิศวกรเครือข่าย' },
      { who: 'tc2', role: 'ช่างติดตั้ง' },
    ],
    status: 'active',
    startOffset: -80,
    endOffset: 25,
    value: 12_400_000,
    progress: 0.4,
    reportedPct: 48,
    plannedPct: 72,
    scope: [
      'เปลี่ยน Core Switch 2 ชุด แบบ redundant',
      'ติดตั้ง Firewall รุ่นใหม่ HA',
      'ย้ายระบบ HIS โดยไม่หยุดบริการเกิน 2 ชั่วโมง',
    ],
    outOfScope: ['ซอฟต์แวร์ HIS', 'งานระบบไฟฟ้าห้อง Data Center'],
    deliverables: [
      { title: 'เครือข่าย Data Center ใหม่', description: 'Core/Firewall ทำงานแบบ HA', criteria: ['ทดสอบ failover ผ่าน'] },
      { title: 'เอกสาร As-built', description: 'แผนผังและค่าตั้งค่า', criteria: ['ส่งเอกสารครบ'] },
    ],
    phases: [
      {
        title: 'ออกแบบ',
        tasks: [
          { title: 'สำรวจเครือข่ายเดิม', days: 6, owner: 'se1' },
          { title: 'ออกแบบ Network ใหม่', days: 10, owner: 'se1', milestone: 1 },
        ],
      },
      {
        title: 'ติดตั้งและย้ายระบบ',
        tasks: [
          { title: 'ติดตั้ง Core Switch', days: 8, owner: 'en1', crew: ['tc2'] },
          { title: 'ติดตั้ง Firewall HA', days: 6, owner: 'en1' },
          { title: 'ย้ายระบบ HIS (cut-over)', days: 3, owner: 'se1', crew: ['en1', 'me'], milestone: 2 },
        ],
      },
      {
        title: 'ทดสอบและส่งมอบ',
        tasks: [
          { title: 'ทดสอบ failover', days: 4, owner: 'se1' },
          { title: 'จัดทำเอกสาร As-built', days: 5, owner: 'en1' },
          { title: 'ตรวจรับงาน', days: 0, owner: 'pm1', milestone: 3 },
        ],
      },
    ],
    milestones: [
      { title: 'อนุมัติแบบเครือข่าย', dueOffset: -50, achieved: true, criteria: ['คณะกรรมการรับรองแบบ'], pct: 0.2, kind: 'deposit' },
      { title: 'ย้ายระบบ HIS สำเร็จ', dueOffset: -10, criteria: ['HIS ใช้งานได้บนเครือข่ายใหม่', 'downtime ไม่เกิน 2 ชม.'], pct: 0.5, kind: 'progress', penalty: true },
      { title: 'ตรวจรับงาน', dueOffset: 25, criteria: ['คณะกรรมการตรวจรับลงนาม'], pct: 0.3, kind: 'final', penalty: true },
    ],
    budget: [
      { category: 'material', code: 'SW-CORE-48', description: 'Core Switch 48 port 25G', quantity: 2, unit: 'ชุด', unitCost: 1_850_000 },
      { category: 'material', code: 'FW-HA', description: 'Firewall HA pair', quantity: 1, unit: 'ชุด', unitCost: 3_200_000 },
      { category: 'material', code: 'SFP-25G', description: 'SFP 25G', quantity: 48, unit: 'ตัว', unitCost: 6_500 },
      { category: 'labor', code: 'ENG-SR', description: 'วิศวกรอาวุโส', quantity: 30, unit: 'manday', unitCost: 9_000 },
      { category: 'labor', code: 'ENG', description: 'วิศวกร', quantity: 40, unit: 'manday', unitCost: 6_000 },
    ],
    risks: [
      { title: 'Downtime ระบบ HIS เกินที่กำหนด', description: 'ระบบเดิมไม่มีเอกสาร อาจพบ dependency ที่ไม่รู้', source: 'technical', l: 4, i: 5, owner: 'se1', response: 'ทำ dry-run 2 รอบ และเตรียม rollback' },
      { title: 'ค่าปรับล่าช้าตามสัญญา', description: 'ค่าปรับ 0.1% ต่อวันของมูลค่างวด', source: 'legal', l: 3, i: 4, owner: 'pm1' },
      { title: 'Firmware ไม่รองรับ HIS เดิม', description: 'ต้องอัปเกรด HIS client', source: 'project', l: 3, i: 3, owner: 'en1', response: 'ประสานผู้พัฒนา HIS' },
    ],
    issues: [
      { title: 'Cut-over รอบแรกไม่ผ่าน', description: 'VLAN ของห้องแล็บไม่ถูกย้าย ทำให้ส่งผลแล็บไม่ได้', severity: 'high', dueOffset: -3, owner: 'se1', days: 7, cost: 45_000, kind: 'technical', cause: 'เอกสารเครือข่ายเดิมไม่ครบ' },
      { title: 'รอโรงพยาบาลกำหนดวัน cut-over ใหม่', description: 'ต้องผ่านคณะกรรมการ IT', severity: 'medium', dueOffset: 3, owner: 'pm1', days: 5, cost: 0 },
      { title: 'SFP ส่งผิดรุ่น 8 ตัว', description: 'ผู้ขายเปลี่ยนให้แล้ว', severity: 'low', dueOffset: -20, owner: 'en1', days: 2, cost: 0, resolved: 'ผู้ขายเปลี่ยนสินค้าให้ภายใน 3 วัน' },
    ],
    change: {
      title: 'เพิ่ม Access Switch ห้องแล็บ',
      reason: 'โรงพยาบาลขอแยกเครือข่ายห้องแล็บเพิ่ม',
      added: 'Access Switch 24 port 4 ชุด พร้อมติดตั้ง',
      days: 5,
      price: 420_000,
      cost: [
        { description: 'Access Switch 24 port', quantity: 4, unit: 'ชุด', unitCost: 68_000 },
        { description: 'ค่าแรงติดตั้ง', quantity: 6, unit: 'manday', unitCost: 6_000 },
      ],
      status: 'approved',
    },
    costs: [
      { category: 'material', description: 'Core Switch 2 ชุด', amount: 3_700_000, offset: -40, vendor: 'บจก. เน็ตเวิร์คโปร' },
      { category: 'material', description: 'Firewall HA pair', amount: 3_250_000, offset: -35, vendor: 'บจก. ซีเคียวร์เน็ต' },
      { category: 'other', description: 'ค่าเช่าอุปกรณ์สำรองระหว่าง cut-over', amount: 85_000, offset: -8, vendor: 'บจก. เรนท์ไอที' },
    ],
    configs: [
      { system: 'Core-SW-A', key: 'mgmt_ip', value: '172.16.0.1' },
      { system: 'Core-SW-B', key: 'mgmt_ip', value: '172.16.0.2' },
      { system: 'Firewall', key: 'ha_mode', value: 'active-passive' },
    ],
    bookings: [
      { who: 'se1', from: -30, to: 25, hours: 4, note: 'cut-over/ทดสอบ' },
      { who: 'en1', from: -20, to: 20, hours: 4, note: 'ติดตั้ง' },
      { who: 'tc2', from: -20, to: 5, hours: 2, note: 'ช่วยติดตั้ง' },
    ],
  },
  {
    no: 3,
    name: 'พัฒนาระบบเชื่อมต่อ SAP กับระบบคลังสินค้า บจก. ไทยโลจิสติกส์',
    customer: { nameTh: 'บริษัท ไทยโลจิสติกส์ จำกัด', nameEn: 'Thai Logistics Co., Ltd.', type: 'corporate', taxId: '0105560099887' },
    manager: 'pm2',
    team: [
      { who: 'en2', role: 'นักพัฒนา' },
      { who: 'se1', role: 'ที่ปรึกษาสถาปัตยกรรม' },
      { who: 'me', role: 'Business Analyst' },
    ],
    status: 'active',
    startOffset: -30,
    endOffset: 90,
    value: 2_350_000,
    progress: 0.3,
    reportedPct: 30,
    plannedPct: 28,
    scope: ['API ส่งใบสั่งขายจาก SAP ไป WMS', 'รับสถานะการจัดส่งกลับเข้า SAP', 'หน้าติดตามคิวและ error'],
    outOfScope: ['ปรับแต่ง SAP ฝั่งลูกค้า'],
    deliverables: [
      { title: 'Integration API', description: 'API 6 เส้นพร้อมเอกสาร', criteria: ['ผ่าน UAT'] },
      { title: 'หน้าติดตามคิว', description: 'Dashboard สถานะการส่ง', criteria: ['ผ่าน UAT'] },
    ],
    phases: [
      {
        title: 'Sprint 1 — ใบสั่งขาย',
        tasks: [
          { title: 'วิเคราะห์ mapping ฟิลด์ SAP ↔ WMS', days: 5, owner: 'me', devKind: 'item' },
          { title: 'API ส่งใบสั่งขาย', days: 8, owner: 'en2', devKind: 'item' },
          { title: 'Demo Sprint 1', days: 0, owner: 'pm2', milestone: 1 },
        ],
      },
      {
        title: 'Sprint 2 — สถานะจัดส่ง',
        tasks: [
          { title: 'Webhook รับสถานะจาก WMS', days: 8, owner: 'en2', devKind: 'item' },
          { title: 'อัปเดตสถานะกลับ SAP', days: 6, owner: 'en2', devKind: 'item' },
        ],
      },
      {
        title: 'Sprint 3 — หน้าติดตาม',
        tasks: [
          { title: 'หน้าติดตามคิวและ error', days: 10, owner: 'en2', devKind: 'item' },
          { title: 'UAT กับลูกค้า', days: 5, owner: 'me', crew: ['en2'] },
          { title: 'Go-live', days: 0, owner: 'pm2', milestone: 2 },
        ],
      },
    ],
    milestones: [
      { title: 'Demo Sprint 1', dueOffset: -5, achieved: true, criteria: ['ลูกค้ารับรองผล demo'], pct: 0.4, kind: 'progress' },
      { title: 'Go-live', dueOffset: 85, criteria: ['ผ่าน UAT', 'ใช้งานจริง 2 สัปดาห์ไม่มี critical'], pct: 0.6, kind: 'final' },
    ],
    budget: [
      { category: 'labor', code: 'DEV', description: 'นักพัฒนา', quantity: 120, unit: 'manday', unitCost: 7_000 },
      { category: 'labor', code: 'BA', description: 'Business Analyst', quantity: 30, unit: 'manday', unitCost: 6_500 },
      { category: 'other', code: 'CLOUD', description: 'ค่า Cloud ทดสอบ 4 เดือน', quantity: 4, unit: 'เดือน', unitCost: 12_000 },
    ],
    risks: [
      { title: 'SAP ของลูกค้าเปิด Service Layer ช้า', description: 'ทีม Basis ของลูกค้ามีคิวยาว', source: 'project', l: 3, i: 4, owner: 'pm2' },
    ],
    issues: [],
    costs: [{ category: 'other', description: 'ค่า Cloud เดือน ต.ค.', amount: 12_000, offset: -4, vendor: 'Cloud Provider' }],
    configs: [
      { system: 'Integration API', key: 'sap_base_url', value: 'https://sap-sl.thailogistics.local:50000/b1s/v1' },
      { system: 'Integration API', key: 'wms_webhook_path', value: '/hooks/wms/status' },
      { system: 'Integration API', key: 'retry_max', value: '5' },
    ],
    bookings: [
      { who: 'en2', from: -30, to: 90, hours: 8, note: 'พัฒนา' },
      { who: 'me', from: -30, to: 20, hours: 2, note: 'BA' },
    ],
  },
  {
    no: 4,
    name: 'ติดตั้ง Wi-Fi ทั่วทั้งวิทยาเขต มหาวิทยาลัยราชพฤกษ์',
    customer: { nameTh: 'มหาวิทยาลัยราชพฤกษ์', nameEn: 'Ratchaphruek University', type: 'government', taxId: '0994000654321' },
    manager: 'pm1',
    team: [
      { who: 'en1', role: 'วิศวกร Wireless' },
      { who: 'tc1', role: 'ช่างติดตั้ง' },
    ],
    status: 'on_hold',
    startOffset: -60,
    endOffset: 120,
    value: 6_900_000,
    progress: 0.2,
    reportedPct: 20,
    plannedPct: 35,
    scope: ['Access Point Wi-Fi 6 จำนวน 350 จุด', 'Wireless Controller', 'ระบบยืนยันตัวตนผ่าน LDAP'],
    outOfScope: ['ระบบสายใยแก้วระหว่างอาคาร'],
    deliverables: [{ title: 'Wi-Fi ครอบคลุม 18 อาคาร', description: 'สัญญาณ ≥ -67 dBm', criteria: ['ผ่าน site survey หลังติดตั้ง'] }],
    phases: [
      {
        title: 'สำรวจ',
        tasks: [
          { title: 'Site survey 18 อาคาร', days: 12, owner: 'en1', crew: ['tc1'] },
          { title: 'สรุปตำแหน่ง AP', days: 4, owner: 'en1', milestone: 1 },
        ],
      },
      {
        title: 'ติดตั้ง',
        tasks: [
          { title: 'ติดตั้ง AP อาคาร 1–9', days: 15, owner: 'tc1' },
          { title: 'ติดตั้ง AP อาคาร 10–18', days: 15, owner: 'tc1' },
          { title: 'ตั้งค่า Controller และ LDAP', days: 6, owner: 'en1', milestone: 2 },
        ],
      },
    ],
    milestones: [
      { title: 'สรุปตำแหน่ง AP', dueOffset: -30, achieved: true, criteria: ['มหาวิทยาลัยรับรอง'], pct: 0.3, kind: 'deposit' },
      { title: 'ติดตั้งและตรวจรับ', dueOffset: 120, criteria: ['ผ่าน site survey หลังติดตั้ง'], pct: 0.7, kind: 'final' },
    ],
    budget: [
      { category: 'material', code: 'AP-WIFI6', description: 'Access Point Wi-Fi 6', quantity: 350, unit: 'ตัว', unitCost: 12_800 },
      { category: 'material', code: 'WLC', description: 'Wireless Controller', quantity: 2, unit: 'เครื่อง', unitCost: 420_000 },
      { category: 'labor', code: 'TECH', description: 'ช่างติดตั้ง', quantity: 120, unit: 'manday', unitCost: 2_800 },
    ],
    risks: [
      { title: 'งบประมาณลูกค้าถูกชะลอ', description: 'มหาวิทยาลัยรออนุมัติงบกลางปี', source: 'project', l: 4, i: 4, owner: 'pm1' },
    ],
    issues: [
      { title: 'ลูกค้าขอพักโครงการ', description: 'รอผลอนุมัติงบประมาณ', severity: 'high', dueOffset: 30, owner: 'pm1', days: 30, cost: 0 },
    ],
    costs: [],
    configs: [],
    bookings: [],
  },
  {
    no: 5,
    name: 'ระบบ Access Control คลังสินค้า บจก. สยามฟู้ดส์',
    customer: { nameTh: 'บริษัท สยามฟู้ดส์ จำกัด', nameEn: 'Siam Foods Co., Ltd.', type: 'corporate', taxId: '0105555012345' },
    manager: 'me',
    team: [
      { who: 'en1', role: 'วิศวกร' },
      { who: 'tc2', role: 'ช่างติดตั้ง' },
    ],
    status: 'closed',
    startOffset: -150,
    endOffset: -20,
    value: 1_280_000,
    progress: 1,
    reportedPct: 100,
    plannedPct: 100,
    scope: ['เครื่องสแกนใบหน้า 24 จุด', 'ประตูไม้กั้น 4 ชุด', 'ซอฟต์แวร์บริหารสิทธิ์'],
    outOfScope: [],
    deliverables: [{ title: 'ระบบ Access Control', description: 'ใช้งานได้ทุกจุด', criteria: ['ตรวจรับครบ'] }],
    phases: [
      {
        title: 'ดำเนินงาน',
        tasks: [
          { title: 'ติดตั้งเครื่องสแกน', days: 10, owner: 'tc2' },
          { title: 'ติดตั้งไม้กั้น', days: 6, owner: 'tc2' },
          { title: 'ตั้งค่าซอฟต์แวร์', days: 5, owner: 'en1' },
          { title: 'ตรวจรับงาน', days: 0, owner: 'me', milestone: 1 },
        ],
      },
    ],
    milestones: [{ title: 'ตรวจรับงาน', dueOffset: -25, achieved: true, criteria: ['ลูกค้าลงนามตรวจรับ'], pct: 1, kind: 'final' }],
    budget: [
      { category: 'material', code: 'FACE-SCAN', description: 'เครื่องสแกนใบหน้า', quantity: 24, unit: 'เครื่อง', unitCost: 18_500 },
      { category: 'material', code: 'BARRIER', description: 'ไม้กั้น', quantity: 4, unit: 'ชุด', unitCost: 65_000 },
      { category: 'labor', code: 'TECH', description: 'ช่างติดตั้ง', quantity: 30, unit: 'manday', unitCost: 2_800 },
    ],
    risks: [{ title: 'ฝุ่นในคลังทำให้สแกนผิดพลาด', description: '', source: 'technical', l: 2, i: 2, owner: 'en1', response: 'ติดตั้งกล่องกันฝุ่น', status: 'closed' }],
    issues: [],
    costs: [{ category: 'material', description: 'เครื่องสแกนใบหน้า 24 เครื่อง', amount: 444_000, offset: -120, vendor: 'บจก. ไบโอเมตริกซ์' }],
    configs: [{ system: 'Access Server', key: 'ip_address', value: '192.168.50.10' }],
    bookings: [],
  },
  {
    no: 6,
    name: 'ระบบโทรศัพท์ IP-PBX 25 สาขา สหกรณ์ออมทรัพย์ครูไทย',
    customer: { nameTh: 'สหกรณ์ออมทรัพย์ครูไทย จำกัด', nameEn: 'Thai Teachers Savings Cooperative', type: 'corporate', taxId: '0993000111222' },
    manager: 'pm2',
    team: [
      { who: 'en1', role: 'วิศวกร VoIP' },
      { who: 'tc1', role: 'ช่างติดตั้ง' },
      { who: 'tc2', role: 'ช่างติดตั้ง' },
    ],
    status: 'active',
    startOffset: -5,
    endOffset: 110,
    value: 3_150_000,
    progress: 0.05,
    reportedPct: 5,
    plannedPct: 4,
    scope: ['IP-PBX ส่วนกลาง HA', 'โทรศัพท์ IP 400 เครื่อง 25 สาขา', 'SIP Trunk'],
    outOfScope: ['ค่าบริการ SIP Trunk รายเดือน'],
    deliverables: [{ title: 'ระบบโทรศัพท์ 25 สาขา', description: 'โทรภายในฟรี', criteria: ['ทดสอบโทรครบทุกสาขา'] }],
    phases: [
      {
        title: 'เตรียมงาน',
        tasks: [
          { title: 'Kick-off กับลูกค้า', days: 1, owner: 'pm2' },
          { title: 'สำรวจ 25 สาขา', days: 15, owner: 'en1', crew: ['tc1'] },
        ],
      },
      {
        title: 'ติดตั้ง',
        tasks: [
          { title: 'ติดตั้ง IP-PBX ส่วนกลาง', days: 5, owner: 'en1', milestone: 1 },
          { title: 'ติดตั้งโทรศัพท์สาขา 1–12', days: 20, owner: 'tc1' },
          { title: 'ติดตั้งโทรศัพท์สาขา 13–25', days: 20, owner: 'tc2' },
          { title: 'ทดสอบและตรวจรับ', days: 5, owner: 'en1', milestone: 2 },
        ],
      },
    ],
    milestones: [
      { title: 'IP-PBX ส่วนกลางพร้อม', dueOffset: 30, criteria: ['โทรผ่าน SIP Trunk ได้'], pct: 0.4, kind: 'progress' },
      { title: 'ตรวจรับงาน', dueOffset: 105, criteria: ['ทดสอบครบ 25 สาขา'], pct: 0.6, kind: 'final' },
    ],
    budget: [
      { category: 'material', code: 'PBX-HA', description: 'IP-PBX HA', quantity: 1, unit: 'ชุด', unitCost: 580_000 },
      { category: 'material', code: 'IP-PHONE', description: 'โทรศัพท์ IP', quantity: 400, unit: 'เครื่อง', unitCost: 3_200 },
      { category: 'labor', code: 'TECH', description: 'ช่างติดตั้ง', quantity: 90, unit: 'manday', unitCost: 2_800 },
    ],
    risks: [],
    issues: [],
    costs: [],
    configs: [],
    bookings: [
      { who: 'en1', from: 0, to: 60, hours: 4, note: 'สำรวจ/ติดตั้ง' },
      { who: 'tc1', from: 20, to: 70, hours: 8, note: 'ติดตั้งสาขา' },
      { who: 'tc2', from: 31, to: 80, hours: 8, note: 'ติดตั้งสาขา' },
    ],
  },
];

// --- helpers -----------------------------------------------------------------

const money = (n: number) => new Prisma.Decimal(n.toFixed(2));
const sumLines = (lines: { quantity: number; unitCost: number }[]) =>
  lines.reduce((s, l) => s + l.quantity * l.unitCost, 0);
const normalize = (s: string) =>
  s.replace(/บริษัท|จำกัด|\(มหาชน\)|บจก\.|/g, '').replace(/\s+/g, ' ').trim();

async function clean() {
  const like = { startsWith: P };
  const projectIds = (await prisma.project.findMany({ where: { id: like }, select: { id: true } })).map((p) => p.id);
  await prisma.hrBooking.deleteMany({ where: { id: like } });
  await prisma.projectConfigItem.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.projectCost.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.projectIntake.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.projectTaskLink.deleteMany({ where: { predecessorId: like } });
  // children before parents (parent is Restrict)
  await prisma.projectTask.deleteMany({ where: { id: like, parentId: { not: null } } });
  await prisma.projectTask.deleteMany({ where: { id: like } });
  await prisma.project.deleteMany({ where: { id: like } });
  await prisma.contractInstallment.deleteMany({ where: { id: like } });
  await prisma.customerContract.deleteMany({ where: { id: like } });
  await prisma.customer.deleteMany({ where: { id: like } });
  await prisma.hrEmployee.deleteMany({ where: { id: like } });
  await prisma.userCompany.deleteMany({ where: { id: like } });
  await prisma.user.deleteMany({ where: { id: like } });
}

async function main() {
  if (process.env.NODE_ENV === 'production' || process.env.PM_MOCK_ALLOW !== '1') {
    throw new Error('ตั้ง PM_MOCK_ALLOW=1 ก่อน (และห้ามรันบน production)');
  }
  const args = process.argv.slice(2);
  await clean();
  if (args.includes('--clean')) {
    console.log('ลบข้อมูล mock โครงการแล้ว');
    return;
  }

  const code = args.find((a) => !a.startsWith('--')) ?? 'OSD_DEMO';
  const company = await prisma.company.findFirst({ where: { code } });
  if (!company) throw new Error(`ไม่พบบริษัท ${code}`);
  const companyId = company.id;

  const meName = process.env.PM_MOCK_USER ?? 'uat.wichai';
  const me = await prisma.user.findFirst({ where: { username: meName } });
  if (!me) throw new Error(`ไม่พบผู้ใช้ ${meName} (ตั้ง PM_MOCK_USER)`);

  const levels = new Map(
    (await prisma.hrLevel.findMany({ select: { id: true, code: true } })).map((l) => [l.code, l.id]),
  );

  // people
  const uid = new Map<PersonKey, string>([['me', me.id]]);
  for (const person of PEOPLE) {
    const id = `${P}user-${person.key}`;
    uid.set(person.key, id);
    await prisma.user.create({
      data: {
        id,
        keycloakId: id,
        username: person.username,
        email: `${person.username}@example.test`,
        firstName: person.first,
        lastName: person.last,
        displayName: `${person.first} ${person.last}`,
        position: person.position,
        primaryCompanyId: companyId,
        lastCompanyId: companyId,
      },
    });
    await prisma.userCompany.create({
      data: { id: `${P}uc-${person.key}`, userId: id, companyId, isPrimary: true },
    });
  }
  const meEmployee = await prisma.hrEmployee.findUnique({
    where: { companyId_userId: { companyId, userId: me.id } },
  });
  const staff: { key: PersonKey; level?: string }[] = [
    ...PEOPLE.map((p) => ({ key: p.key as PersonKey, level: p.level })),
    ...(meEmployee ? [] : [{ key: 'me' as PersonKey, level: 'PROJECT-MANAGER' }]),
  ];
  for (const s of staff) {
    await prisma.hrEmployee.create({
      data: {
        id: `${P}emp-${s.key}`,
        companyId,
        userId: uid.get(s.key)!,
        levelId: s.level ? levels.get(s.level) ?? null : null,
      },
    });
  }
  const u = (k: PersonKey) => uid.get(k)!;
  const by = me.id;

  for (const spec of PROJECTS) {
    const n = String(spec.no).padStart(3, '0');
    const pid = `${P}prj-${n}`;
    const year = TODAY.getUTCFullYear() + 543;

    // customer + signed contract + installments
    const customerId = `${P}cus-${n}`;
    await prisma.customer.create({
      data: {
        id: customerId,
        customerCode: `CUS-MOCK-${n}`,
        companyId,
        type: spec.customer.type,
        nameTh: spec.customer.nameTh,
        nameEn: spec.customer.nameEn,
        normalizedName: normalize(spec.customer.nameTh),
        taxId: spec.customer.taxId,
        status: 'active',
        accountOwnerUserId: u(spec.manager),
        createdBy: by,
      },
    });
    const contractId = `${P}ctr-${n}`;
    const contractNo = `CTR-${year}-M${n}`;
    await prisma.customerContract.create({
      data: {
        id: contractId,
        companyId,
        customerId,
        contractNo,
        title: `สัญญา${spec.name}`,
        startOn: day(spec.startOffset),
        endOn: day(spec.endOffset + 365),
        value: money(spec.value),
        status: 'active',
        ownerUserId: u(spec.manager),
        signedOn: day(spec.startOffset - 7),
        signedVia: 'manual',
        signedRecordedBy: by,
        createdBy: by,
      },
    });
    const installments = spec.milestones.map((m, i) => ({
      id: `${P}ins-${n}-${i + 1}`,
      seq: i + 1,
      kind: m.kind,
      label: `งวดที่ ${i + 1} — ${m.title}`,
      amount: Math.round(spec.value * m.pct),
      dueOn: day(m.dueOffset + 15),
      milestone: m.title,
    }));
    for (const ins of installments) {
      await prisma.contractInstallment.create({
        data: { ...ins, companyId, contractId, amount: money(ins.amount) },
      });
    }

    const budgetTotal = sumLines(spec.budget);
    const baseline = {
      contract: {
        contractNo,
        title: `สัญญา${spec.name}`,
        party: spec.customer.nameTh,
        value: spec.value,
        currency: 'THB',
        startOn: day(spec.startOffset).toISOString().slice(0, 10),
        endOn: day(spec.endOffset + 365).toISOString().slice(0, 10),
        signedOn: day(spec.startOffset - 7).toISOString().slice(0, 10),
      },
      solution: { solutionId: null, title: spec.name, versionNo: 1 },
      scope: {
        inScope: spec.scope,
        outOfScope: spec.outOfScope,
        deliverables: spec.deliverables,
        assumptions: [],
      },
      boq: spec.budget
        .filter((l) => l.category === 'material')
        .map((l) => ({ productCode: l.code, name: l.description, quantity: l.quantity, unit: l.unit })),
      labor: spec.budget
        .filter((l) => l.category === 'labor')
        .map((l) => ({ role: l.description, mandays: l.quantity, rate: l.unitCost })),
      cost: null,
      installments: installments.map((i) => ({
        seq: i.seq,
        kind: i.kind,
        label: i.label,
        amount: i.amount,
        dueOn: i.dueOn.toISOString().slice(0, 10),
        dueNote: null,
        milestone: i.milestone,
      })),
      capturedAt: at(spec.startOffset).toISOString(),
    };

    await prisma.project.create({
      data: {
        id: pid,
        companyId,
        projectNo: `PRJ-MOCK-${n}`,
        name: spec.name,
        contractId,
        customerId,
        managerUserId: u(spec.manager),
        status: spec.status,
        startOn: day(spec.startOffset),
        endOn: day(spec.endOffset),
        contractValue: money(spec.value),
        baseline,
        openedAt: at(spec.startOffset - 3),
        openedBy: by,
        note: 'ข้อมูลตัวอย่าง (mock)',
        members: {
          create: spec.team
            .filter((m) => m.who !== spec.manager)
            .map((m) => ({ userId: u(m.who), role: m.role, addedBy: by })),
        },
      },
    });
    await prisma.projectIntake.create({
      data: {
        id: `${P}intake-${n}`,
        companyId,
        projectId: pid,
        status: 'accepted',
        acceptedBy: u(spec.manager),
        acceptedAt: at(spec.startOffset - 2),
        history: [{ action: 'accepted', at: at(spec.startOffset - 2).toISOString(), by: u(spec.manager), round: 0, lines: 0 }],
      },
    });

    // milestones
    const msIds: string[] = [];
    for (const [i, m] of spec.milestones.entries()) {
      const id = `${P}ms-${n}-${i + 1}`;
      msIds.push(id);
      const done = Boolean(m.achieved) || spec.status === 'closed';
      await prisma.projectMilestone.create({
        data: {
          id,
          companyId,
          projectId: pid,
          seq: i + 1,
          title: m.title,
          criteria: m.criteria.map((text) => ({
            text,
            met: done,
            metAt: done ? at(m.dueOffset - 1).toISOString() : null,
            metBy: done ? u(spec.manager) : null,
          })),
          dueOn: day(m.dueOffset),
          installmentId: installments[i].id,
          penaltyApplies: Boolean(m.penalty),
          status: done ? 'achieved' : 'planned',
          achievedOn: done ? day(m.dueOffset - 1) : null,
          achievedAt: done ? at(m.dueOffset - 1) : null,
          achievedBy: done ? u(spec.manager) : null,
          evidenceNote: done ? 'บันทึกการประชุม/ใบลงนามของลูกค้า' : null,
          createdBy: by,
        },
      });
    }

    // tasks: phase (summary) → leaf tasks, leaves chained finish-to-start
    const leaves = spec.phases.flatMap((p) => p.tasks);
    const doneCount = Math.round(leaves.length * spec.progress);
    let leafIndex = 0;
    let previousLeaf: string | null = null;
    for (const [pi, phase] of spec.phases.entries()) {
      const phaseId = `${P}task-${n}-${pi + 1}`;
      await prisma.projectTask.create({
        data: {
          id: phaseId,
          companyId,
          projectId: pid,
          seq: pi + 1,
          title: phase.title,
          ownerUserId: u(spec.manager),
          durationDays: 0,
          devKind: phase.tasks.some((t) => t.devKind) ? 'iteration' : null,
          createdBy: by,
        },
      });
      for (const [ti, task] of phase.tasks.entries()) {
        const id = `${P}task-${n}-${pi + 1}-${ti + 1}`;
        const status =
          task.status ??
          (leafIndex < doneCount ? 'done' : leafIndex === doneCount && spec.status !== 'closed' ? 'in_progress' : 'open');
        const started = status === 'done' || status === 'in_progress';
        await prisma.projectTask.create({
          data: {
            id,
            companyId,
            projectId: pid,
            parentId: phaseId,
            seq: ti + 1,
            title: task.title,
            ownerUserId: task.owner ? u(task.owner) : null,
            crewUserIds: (task.crew ?? []).map(u),
            durationDays: task.days,
            milestoneId: task.milestone ? msIds[task.milestone - 1] : null,
            devKind: task.devKind ?? null,
            status,
            startedAt: started ? at(spec.startOffset + leafIndex * 4) : null,
            doneAt: status === 'done' ? at(spec.startOffset + leafIndex * 4 + Math.max(task.days, 1)) : null,
            doneBy: status === 'done' && task.owner ? u(task.owner) : null,
            createdBy: by,
          },
        });
        if (previousLeaf) {
          await prisma.projectTaskLink.create({
            data: { predecessorId: previousLeaf, successorId: id, lagDays: 0 },
          });
        }
        previousLeaf = id;
        leafIndex++;
      }
    }

    // budget v1 (locked) + approved change → v2
    const lines = spec.budget.map((l) => ({ ...l, amount: l.quantity * l.unitCost }));
    let crBudgetId: string | null = null;
    const change = spec.change;
    await prisma.projectBudget.create({
      data: {
        id: `${P}bud-${n}-1`,
        companyId,
        projectId: pid,
        versionNo: 1,
        status: change?.status === 'approved' ? 'superseded' : 'locked',
        lines,
        total: money(budgetTotal),
        contractValue: money(spec.value),
        createdBy: u(spec.manager),
        lockedAt: at(spec.startOffset + 2),
        lockedBy: u(spec.manager),
      },
    });
    if (change) {
      const costLines = change.cost.map((c) => ({ category: 'material', code: '', ...c, amount: c.quantity * c.unitCost }));
      const costChange = sumLines(change.cost);
      if (change.status === 'approved') {
        crBudgetId = `${P}bud-${n}-2`;
        await prisma.projectBudget.create({
          data: {
            id: crBudgetId,
            companyId,
            projectId: pid,
            versionNo: 2,
            status: 'locked',
            lines: [...lines, ...costLines],
            total: money(budgetTotal + costChange),
            contractValue: money(spec.value + change.price),
            changeRequestId: `${P}cr-${n}-1`,
            createdBy: u(spec.manager),
            lockedAt: at(-12),
            lockedBy: u(spec.manager),
          },
        });
      }
      await prisma.projectChangeRequest.create({
        data: {
          id: `${P}cr-${n}-1`,
          companyId,
          projectId: pid,
          seq: 1,
          title: change.title,
          reason: change.reason,
          scopeAdded: change.added,
          scheduleDays: change.days,
          costLines,
          costChange: money(costChange),
          priceChange: money(change.price),
          status: change.status,
          submittedAt: at(-18),
          submittedBy: u(spec.manager),
          decidedAt: change.status === 'approved' ? at(-12) : null,
          budgetId: crBudgetId,
          createdBy: u(spec.manager),
        },
      });
    }

    // progress reports (a few, rising to the latest)
    const steps = spec.status === 'closed' ? [0.3, 0.7, 1] : [0.4, 0.75, 1];
    for (const [i, f] of steps.entries()) {
      const offset = Math.round(spec.startOffset + (Math.min(0, spec.endOffset) - spec.startOffset) * f) || -1;
      await prisma.projectProgressReport.create({
        data: {
          id: `${P}prog-${n}-${i + 1}`,
          companyId,
          projectId: pid,
          reportedPct: money(spec.reportedPct * f),
          computedPct: money(spec.progress * 100 * f),
          plannedPct: money(spec.plannedPct * f),
          reason: spec.reportedPct < spec.plannedPct - 5 && i === steps.length - 1 ? 'งานติดรอลูกค้าและปัญหาระหว่างติดตั้ง' : null,
          note: i === steps.length - 1 ? 'รายงานล่าสุด' : null,
          reportedAt: at(Math.min(offset, -1)),
          reportedBy: u(spec.manager),
        },
      });
    }

    // risks
    for (const [i, r] of spec.risks.entries()) {
      const id = `${P}risk-${n}-${i + 1}`;
      await prisma.projectRisk.create({
        data: {
          id,
          companyId,
          projectId: pid,
          seq: i + 1,
          source: r.source,
          sourceRef: r.source === 'project' ? null : `mock:${n}:${i + 1}`,
          title: r.title,
          description: r.description || null,
          likelihood: r.l,
          impact: r.i,
          ownerUserId: u(r.owner),
          response: r.response ?? null,
          status: r.status ?? 'open',
          lastReviewedAt: at(-10),
          nextReviewOn: day(4),
          createdBy: u(spec.manager),
          reviews: {
            create: [
              {
                id: `${P}rrev-${n}-${i + 1}`,
                note: 'ทบทวนในที่ประชุมโครงการประจำสัปดาห์',
                likelihood: r.l,
                impact: r.i,
                status: r.status ?? 'open',
                reviewedBy: u(spec.manager),
                reviewedAt: at(-10),
              },
            ],
          },
        },
      });
    }

    // issues
    for (const [i, issue] of spec.issues.entries()) {
      await prisma.projectIssue.create({
        data: {
          id: `${P}iss-${n}-${i + 1}`,
          companyId,
          projectId: pid,
          seq: i + 1,
          title: issue.title,
          description: issue.description,
          severity: issue.severity,
          scheduleImpactDays: issue.days,
          costImpact: money(issue.cost),
          ownerUserId: u(issue.owner),
          dueOn: day(issue.dueOffset),
          status: issue.resolved ? 'resolved' : 'open',
          resolution: issue.resolved ?? null,
          resolvedAt: issue.resolved ? at(issue.dueOffset) : null,
          resolvedBy: issue.resolved ? u(issue.owner) : null,
          kind: issue.kind ?? 'general',
          cause: issue.cause ?? null,
          createdBy: u(spec.manager),
          createdAt: at(issue.dueOffset - 10),
        },
      });
    }

    // actual costs
    for (const [i, c] of spec.costs.entries()) {
      await prisma.projectCost.create({
        data: {
          id: `${P}cost-${n}-${i + 1}`,
          companyId,
          projectId: pid,
          category: c.category,
          source: 'manual',
          docNo: `PO-M${n}-${i + 1}`,
          description: c.description,
          amount: money(c.amount),
          incurredOn: day(c.offset),
          vendorName: c.vendor,
          createdBy: u(spec.manager),
        },
      });
    }

    // config items
    for (const [i, c] of spec.configs.entries()) {
      await prisma.projectConfigItem.create({
        data: {
          id: `${P}cfg-${n}-${i + 1}`,
          companyId,
          projectId: pid,
          seq: i + 1,
          system: c.system,
          key: c.key,
          value: c.value,
          note: c.note ?? null,
          createdBy: u(spec.manager),
        },
      });
    }

    // HR bookings → ภาระงานทีม
    for (const [i, b] of spec.bookings.entries()) {
      await prisma.hrBooking.create({
        data: {
          id: `${P}book-${n}-${i + 1}`,
          companyId,
          userId: u(b.who),
          projectId: pid,
          startDate: day(b.from),
          endDate: day(b.to),
          hoursPerDay: new Prisma.Decimal(b.hours),
          note: b.note,
          createdBy: u(spec.manager),
        },
      });
    }
    console.log(`✓ PRJ-MOCK-${n} ${spec.name}`);
  }
  console.log(`\nสร้าง ${PROJECTS.length} โครงการ ในบริษัท ${company.code} — ผู้ใช้ ${meName} เป็นผู้จัดการ/สมาชิกบางโครงการ`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
