import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import {
  AppError,
  AuditWriter,
  auditActor,
  PERMISSIONS,
  Principal,
} from '@request-management/share';
import { ApiKeyRepository } from './api-key.repository';
import { API_KEY_PREFIX } from './api-key.service';
import {
  ApiKeyRowDto,
  IssueApiKeyDto,
  IssuedApiKeyDto,
} from './dto/api-key.dto';

/** How much of the key is stored in the clear, to name one without quoting it. */
const DISPLAY_LENGTH = 12;

/**
 * สิทธิ์ที่หน้าจอออกให้กุญแจได้ — `integration.*` เท่านั้น.
 *
 * อ่านจาก catalog ไม่ใช่พิมพ์รายการไว้เอง: สิทธิ์ integration ตัวถัดไปที่ใครเพิ่ม
 * จะโผล่บนหน้าจอเองโดยไม่มีใครต้องจำว่าต้องมาแก้ที่นี่ด้วย — และที่สำคัญกว่าคือ
 * ตัวที่ *ไม่ใช่* integration จะไม่มีทางโผล่ขึ้นมาเพราะเผลอ.
 */
const ISSUABLE_SCOPES: readonly string[] = PERMISSIONS.integration;

/**
 * ออกและเพิกถอน API key ของช่องทางภายนอก จากหน้าจอผู้ดูแล (14 ก.ย. 2569).
 *
 * **นี่คือการกลับคำตัดสินใจเดิม** ที่ `libs/prisma/api-key.ts` เขียนไว้ว่ากุญแจ
 * ควรออกจาก CLI เท่านั้น เพราะ "ออกไม่บ่อย และค่าเต็มต้องถึงมือคนเดียว — หน้าจอ
 * จะพามันผ่าน browser, proxy log และ screenshot". เหตุผลข้อแรกหมดอายุไปแล้ว:
 * พอเป็นหนึ่งกุญแจต่อหนึ่งช่องทาง การออกกุญแจก็กลายเป็นงานประจำของคนดูแล CRM
 * ไม่ใช่งานของคนที่ ssh เข้าเครื่องได้ — และ workflow ที่ต้องรอ dev มารันคำสั่ง
 * ให้ จบลงด้วยการใช้กุญแจใบเดิมซ้ำทุกช่องทาง ซึ่งแย่กว่าปัญหาที่กลัวตอนแรก.
 *
 * เหตุผลข้อที่สองไม่ได้หายไป จึงถูกกันไว้ตรงนี้แทน:
 *
 * - ค่าเต็มออกจาก `POST` **ครั้งเดียว** ไม่มี endpoint อ่านกลับ (เก็บแค่ sha256)
 * - ไม่เคยลง audit, ไม่เคยลง log — สิ่งที่บันทึกคือ prefix กับใครเป็นคนออก
 * - ผูกกับบริษัทที่ผู้ออกกำลังทำงานอยู่เสมอ ไม่ใช่ค่าที่ส่งมาใน body
 * - ติ๊กสิทธิ์ได้เฉพาะ `integration.*` — หน้าจอนี้ออกกุญแจของแอดมินไม่ได้
 */
@Injectable()
export class ApiKeyAdminService {
  constructor(
    private readonly keys: ApiKeyRepository,
    private readonly audit: AuditWriter,
  ) {}

  /** ตัวเลือกสิทธิ์ที่หน้าจอเอาไปวาด checkbox. */
  scopes() {
    return ISSUABLE_SCOPES.map((code) => ({ code }));
  }

  /**
   * กุญแจของบริษัทที่ผู้เรียกกำลังทำงานอยู่.
   *
   * กุญแจที่ไม่ผูกบริษัท (chatbot ซึ่งทำงานข้ามบริษัทด้วยใบเดียว) **ไม่ปรากฏ
   * ที่นี่** — มันไม่ใช่สมบัติของบริษัทไหน และหน้าจอของบริษัทหนึ่งไม่ควรเพิกถอน
   * กุญแจที่อีกบริษัทกำลังใช้อยู่ได้. ใบพวกนั้นยังดูแลจาก CLI เหมือนเดิม.
   */
  async list(actor: Principal): Promise<ApiKeyRowDto[]> {
    const rows = (await this.keys.findMany({
      where: { companyId: actor.activeCompanyId },
      orderBy: { createdAt: 'desc' },
    })) as ApiKeyRow[];

    return rows.map(toRow);
  }

  async issue(dto: IssueApiKeyDto, actor: Principal): Promise<IssuedApiKeyDto> {
    const scopes = [...new Set(dto.scopes)];
    const unknown = scopes.filter((scope) => !ISSUABLE_SCOPES.includes(scope));

    if (unknown.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        `ออกกุญแจด้วยสิทธิ์เหล่านี้จากหน้าจอไม่ได้: ${unknown.join(', ')}`,
        unknown.map((scope) => ({ field: 'scopes', reason: scope })),
      );
    }

    const key = API_KEY_PREFIX + randomBytes(32).toString('base64url');
    const prefix = key.slice(0, DISPLAY_LENGTH);
    const expiresAt = dto.expires_in_days
      ? new Date(Date.now() + dto.expires_in_days * 86_400_000)
      : null;

    const row = (await this.keys.create({
      data: {
        name: dto.name.trim(),
        prefix,
        keyHash: createHash('sha256').update(key).digest('hex'),
        companyId: actor.activeCompanyId,
        sourceCode: dto.source_code,
        scopes,
        expiresAt,
        createdBy: actor.userId,
      },
    })) as ApiKeyRow;

    /*
      บันทึกว่าใครออกกุญแจอะไรให้ช่องทางไหน — **ไม่เคยบันทึกตัวกุญแจ**. audit
      เป็น append-only และอ่านได้จากหน้าจอ audit; กุญแจที่หลุดลงไปในนั้นคือกุญแจ
      ที่เพิกถอนไม่ได้จริง เพราะสำเนายังอยู่ในบันทึกที่ลบไม่ได้ตลอดไป.
    */
    await this.audit.record({
      eventType: 'admin.api_key.issued',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'api_key',
      resourceId: row.id,
      after: {
        prefix,
        name: row.name,
        sourceCode: row.sourceCode,
        scopes,
        expiresAt: expiresAt?.toISOString() ?? null,
      },
    });

    return { ...toRow(row), key };
  }

  /**
   * เพิกถอน — มีผลกับคำขอถัดไปทันที (กุญแจถูกอ่านจากตารางนี้ก่อน cache 60 วินาที
   * ของ principal เสมอ) และย้อนกลับไม่ได้: ช่องทางนั้นต้องได้กุญแจใบใหม่.
   *
   * ไม่มีปุ่มลบ. แถวที่เพิกถอนแล้วยังอยู่เพราะคำถามที่จะถูกถามจริงคือ "กุญแจที่
   * เคยอยู่บนเว็บฟอร์มตัวเก่าถูกปิดไปเมื่อไหร่ ใครปิด" — ลบทิ้งแล้วไม่มีคำตอบ.
   */
  async revoke(id: string, actor: Principal): Promise<ApiKeyRowDto> {
    const found = (await this.keys.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    })) as ApiKeyRow | null;

    // SCOPE-03: กุญแจของบริษัทอื่น = ไม่มีอยู่จริงสำหรับผู้เรียกคนนี้
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบ API key ที่ระบุ');

    if (found.revokedAt) return toRow(found);

    const row = (await this.keys.update({
      where: { id },
      data: {
        active: false,
        revokedAt: new Date(),
        revokedBy: actor.userId,
      },
    })) as ApiKeyRow;

    await this.audit.record({
      eventType: 'admin.api_key.revoked',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'api_key',
      resourceId: id,
      before: { prefix: found.prefix, name: found.name, active: true },
      after: { prefix: found.prefix, name: found.name, active: false },
    });

    return toRow(row);
  }
}

interface ApiKeyRow {
  id: string;
  prefix: string;
  name: string;
  sourceCode: string | null;
  scopes: string[];
  active: boolean;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  createdBy: string;
}

/**
 * แถวจากฐานข้อมูล → สิ่งที่หน้าจอเห็น. `keyHash` ไม่ได้อยู่ใน type ที่แปลงออกมา
 * โดยตั้งใจ — การลืมเอาออกเป็นวิธีที่ hash หลุดออก API ได้ง่ายที่สุด.
 */
function toRow(row: ApiKeyRow): ApiKeyRowDto {
  return {
    id: row.id,
    prefix: row.prefix,
    name: row.name,
    source_code: row.sourceCode,
    scopes: row.scopes,
    status: statusOf(row),
    expires_at: row.expiresAt?.toISOString() ?? null,
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    created_by: row.createdBy,
  };
}

/**
 * สถานะที่คนอ่านเข้าใจ คำนวณจากแถว ไม่ใช่คอลัมน์เก็บไว้.
 *
 * เก็บไว้เป็นคอลัมน์เมื่อไร ก็ต้องมีอะไรสักอย่างคอยเดินอัปเดตตอนกุญแจหมดอายุ
 * และวันที่มันไม่เดิน หน้าจอจะบอกว่า active ทั้งที่ backend ปฏิเสธไปแล้ว.
 */
function statusOf(row: ApiKeyRow): 'active' | 'expired' | 'revoked' {
  if (row.revokedAt || !row.active) return 'revoked';
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return 'expired';

  return 'active';
}
