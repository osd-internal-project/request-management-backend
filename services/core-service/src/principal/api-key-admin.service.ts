import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import {
  AppError,
  AuditWriter,
  auditActor,
  ALL_PERMISSIONS,
  permissionType,
  Principal,
  PrismaTransactionService,
  TxOption,
} from '@request-management/share';
import { openSecret, sealSecret } from '../pm/config-rules';
import { ApiKeyRepository } from './api-key.repository';
import { IntegrationAdminService } from './integration-admin.service';
import { API_KEY_PREFIX } from './api-key.service';
import { API_EXAMPLES, type ApiExample } from './api-examples.generated';
import {
  ApiKeyRowDto,
  IssueApiKeyDto,
  IssuedApiKeyDto,
  UpdateApiKeyScopesDto,
} from './dto/api-key.dto';

/** How much of the key is stored in the clear, to name one without quoting it. */
const DISPLAY_LENGTH = 12;

/**
 * สิทธิ์ที่ออกให้กุญแจได้ — สิทธิ์ที่ catalog บอกว่าเป็นของบัญชีบริการ (AUTH-06).
 *
 * ถาม `permissionType` ไม่ใช่อ้างชื่อ module: ทั้งสองให้คำตอบเดียวกันวันนี้ แต่
 * "สิทธิ์ของเครื่อง" เป็นคำถามที่ catalog ตอบ ส่วน "อยู่ใน module integration" เป็น
 * รายละเอียดว่ามันถูกจัดเก็บไว้ที่ไหน ผูกกับอันหลังคือผูกกับสิ่งที่เปลี่ยนได้โดยไม่ตั้งใจ
 *
 * อ่านจาก catalog ไม่ใช่พิมพ์รายการไว้เอง: สิทธิ์ของเครื่องตัวถัดไปที่ใครเพิ่มจะโผล่
 * บนหน้าจอเองโดยไม่มีใครต้องจำว่าต้องมาแก้ที่นี่ด้วย — และที่สำคัญกว่าคือสิทธิ์ของคน
 * จะไม่มีทางโผล่ขึ้นมาเพราะเผลอ.
 */
const ISSUABLE_SCOPES: readonly string[] = ALL_PERMISSIONS.filter(
  (code) => permissionType(code) === 'service',
);

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
 * - หาด้วย sha256 เท่านั้น ค่าเต็มเก็บแบบเข้ารหัส (`keyEnc`) ให้ผู้ดูแลกดดูได้
 *   ทีละใบ ทุกครั้งที่ดูลง audit (26 ต.ค. 2569 — กลับจาก "แสดงครั้งเดียว")
 * - ไม่เคยลง audit, ไม่เคยลง log — สิ่งที่บันทึกคือ prefix กับใครเป็นคนออก
 * - ผูกกับบริษัทที่ผู้ออกกำลังทำงานอยู่เสมอ ไม่ใช่ค่าที่ส่งมาใน body
 * - ติ๊กสิทธิ์ได้เฉพาะ `integration.*` — หน้าจอนี้ออกกุญแจของแอดมินไม่ได้
 */
@Injectable()
export class ApiKeyAdminService {
  constructor(
    private readonly keys: ApiKeyRepository,
    private readonly audit: AuditWriter,
    private readonly integrations: IntegrationAdminService,
    private readonly config: ConfigService,
    private readonly transactions: PrismaTransactionService,
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

  /** Call examples this key may make: every scope a route demands is on the key. */
  async examples(id: string, actor: Principal): Promise<ApiExample[]> {
    const { scopes } = await this.owned(id, actor);
    return API_EXAMPLES.filter((example) =>
      example.scopes.every((scope) => scopes.includes(scope)),
    );
  }

  async issue(dto: IssueApiKeyDto, actor: Principal): Promise<IssuedApiKeyDto> {
    const scopes = assertIssuable(dto.scopes);
    const integrationId = dto.integration_id
      ? (await this.integrations.owned(dto.integration_id, actor)).id
      : await this.integrations.createForKey(dto.name.trim(), actor);

    const expiresAt = dto.expires_in_days
      ? new Date(Date.now() + dto.expires_in_days * 86_400_000)
      : null;

    const { key, row } = await this.mint(
      {
        name: dto.name.trim(),
        sourceCode: dto.source_code,
        scopes,
        expiresAt,
        integrationId,
      },
      actor,
    );
    const prefix = row.prefix;

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
        integrationId,
      },
    });

    return { ...toRow(row), key };
  }

  /**
   * ค่าเต็มของกุญแจ — ถอดจาก `keyEnc` ทุกครั้งที่ดูลง audit (ไม่มีตัวกุญแจในนั้น).
   * ใบที่ออกก่อนมี `keyEnc` ดูไม่ได้ ต้องออกใหม่.
   */
  async reveal(id: string, actor: Principal): Promise<{ key: string }> {
    const found = await this.owned(id, actor);
    const key = found.keyEnc ? openSecret(found.keyEnc, this.sealKey()) : null;
    if (!key) {
      throw new AppError(
        'UNPROCESSABLE',
        found.keyEnc
          ? 'ถอดรหัสกุญแจไม่ได้ — CONFIG_SECRET_KEY อาจถูกเปลี่ยน ให้กดออกใหม่'
          : 'กุญแจนี้ออกก่อนระบบเก็บแบบเข้ารหัส จึงดูย้อนหลังไม่ได้ — ให้กดออกใหม่',
      );
    }

    await this.audit.record({
      eventType: 'admin.api_key.revealed',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'api_key',
      resourceId: id,
      after: { prefix: found.prefix, name: found.name },
    });
    return { key };
  }

  /**
   * ออกใบใหม่แทนใบเดิม — ชื่อ ช่องทาง สิทธิ์ อายุ ระบบภายนอกเหมือนเดิม และเพิกถอน
   * ใบเดิมในรายการเดียวกัน: ใบเดิมใช้ไม่ได้ตั้งแต่คำขอถัดไป.
   */
  async rotate(id: string, actor: Principal): Promise<IssuedApiKeyDto> {
    const found = await this.owned(id, actor);
    if (statusOf(found) !== 'active') {
      throw new AppError(
        'UNPROCESSABLE',
        'ออกใหม่ได้เฉพาะกุญแจที่ยังใช้งานอยู่ — ใบนี้เพิกถอนหรือหมดอายุแล้ว ให้ออกใบใหม่แทน',
      );
    }

    const { key, row } = await this.transactions.execute(async (prisma) => {
      const minted = await this.mint(
        {
          name: found.name,
          sourceCode: found.sourceCode,
          scopes: found.scopes,
          expiresAt: found.expiresAt,
          integrationId: found.integrationId,
        },
        actor,
        { prisma },
      );
      await this.keys.update(
        {
          where: { id },
          data: {
            active: false,
            revokedAt: new Date(),
            revokedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'admin.api_key.rotated',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'api_key',
          resourceId: minted.row.id,
          before: { id, prefix: found.prefix, name: found.name },
          after: {
            id: minted.row.id,
            prefix: minted.row.prefix,
            name: found.name,
          },
        },
        { prisma },
      );
      return minted;
    });

    return { ...toRow(row), key };
  }

  /**
   * แก้สิทธิ์ของกุญแจที่ออกไปแล้ว — มีผลกับคำขอถัดไปทันที.
   *
   * ทันทีจริง ๆ เพราะกุญแจถูกอ่านจากตารางนี้ทุกคำขอ (`ApiKeyService.resolve`
   * เรียก `findByHash` ทุกครั้ง มีแต่ token ที่แลกมาเท่านั้นที่ถูก cache) — ไม่มี
   * ช่วงที่ช่องทางยังใช้สิทธิ์เก่าอยู่
   *
   * แทนที่ทั้งชุด ไม่ใช่เพิ่มเข้าไป: หน้าจอส่งสิ่งที่ติ๊กไว้มาทั้งหมด และ "เอาออก"
   * ต้องทำได้เท่า ๆ กับ "ใส่เข้า" ไม่งั้นกุญแจมีแต่จะกว้างขึ้นเรื่อย ๆ
   *
   * กุญแจที่เพิกถอนแล้วแก้ไม่ได้ — มันใช้ไม่ได้อยู่แล้ว การยอมให้แก้จะทำให้หน้าจอ
   * ดูเหมือนคืนชีพให้มันได้
   */
  async updateScopes(
    id: string,
    dto: UpdateApiKeyScopesDto,
    actor: Principal,
  ): Promise<ApiKeyRowDto> {
    const found = await this.owned(id, actor);

    if (found.revokedAt || !found.active) {
      throw new AppError(
        'UNPROCESSABLE',
        'กุญแจที่เพิกถอนแล้วแก้สิทธิ์ไม่ได้ — ออกใบใหม่แทน',
      );
    }

    const scopes = assertIssuable(dto.scopes);

    const row = (await this.keys.update({
      where: { id },
      data: { scopes },
    })) as ApiKeyRow;

    await this.audit.record({
      eventType: 'admin.api_key.scopes_changed',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'api_key',
      resourceId: id,
      before: { prefix: found.prefix, name: found.name, scopes: found.scopes },
      after: { prefix: found.prefix, name: found.name, scopes },
    });

    return toRow(row);
  }

  /**
   * เพิกถอน — มีผลกับคำขอถัดไปทันที (กุญแจถูกอ่านจากตารางนี้ก่อน cache 60 วินาที
   * ของ principal เสมอ) และย้อนกลับไม่ได้: ช่องทางนั้นต้องได้กุญแจใบใหม่.
   *
   * ไม่มีปุ่มลบ. แถวที่เพิกถอนแล้วยังอยู่เพราะคำถามที่จะถูกถามจริงคือ "กุญแจที่
   * เคยอยู่บนเว็บฟอร์มตัวเก่าถูกปิดไปเมื่อไหร่ ใครปิด" — ลบทิ้งแล้วไม่มีคำตอบ.
   */
  async revoke(id: string, actor: Principal): Promise<ApiKeyRowDto> {
    const found = await this.owned(id, actor);

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

  /** SCOPE-03: กุญแจของบริษัทอื่น = ไม่มีอยู่จริงสำหรับผู้เรียกคนนี้. */
  private async owned(id: string, actor: Principal): Promise<ApiKeyRow> {
    const found = (await this.keys.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    })) as ApiKeyRow | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบ API key ที่ระบุ');
    return found;
  }

  private async mint(
    data: Pick<
      ApiKeyRow,
      'name' | 'sourceCode' | 'scopes' | 'expiresAt' | 'integrationId'
    >,
    actor: Principal,
    option?: TxOption,
  ): Promise<{ key: string; row: ApiKeyRow }> {
    const key = API_KEY_PREFIX + randomBytes(32).toString('base64url');
    const row = (await this.keys.create(
      {
        data: {
          ...data,
          prefix: key.slice(0, DISPLAY_LENGTH),
          keyHash: createHash('sha256').update(key).digest('hex'),
          keyEnc: sealSecret(key, this.sealKey()),
          companyId: actor.activeCompanyId,
          createdBy: actor.userId,
        },
      },
      option,
    )) as ApiKeyRow;
    return { key, row };
  }

  private sealKey(): string {
    const secret = this.config.get<string>('projectConfig.secret');
    if (!secret) throw new Error('CONFIG_SECRET_KEY is not set');
    return secret;
  }
}

interface ApiKeyRow {
  id: string;
  prefix: string;
  name: string;
  sourceCode: string | null;
  integrationId: string | null;
  scopes: string[];
  keyEnc: string | null;
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
    integration_id: row.integrationId,
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
/**
 * ชุดสิทธิ์ที่ออกให้กุญแจได้ — dedupe แล้วตรวจว่าทุกตัวเป็นสิทธิ์ของบัญชีบริการ.
 *
 * ใช้ร่วมกันระหว่างการออกใบใหม่กับการแก้ใบเดิม เพราะสองทางนั้นต้องรับค่าชุดเดียวกัน
 * เสมอ — กฎที่หลวมกว่าอยู่ทางใดทางหนึ่งคือช่องที่คนจะเดินเข้า
 */
function assertIssuable(requested: readonly string[]): string[] {
  const scopes = [...new Set(requested)];
  const unknown = scopes.filter((scope) => !ISSUABLE_SCOPES.includes(scope));

  if (unknown.length) {
    throw new AppError(
      'VALIDATION_FAILED',
      `ออกกุญแจด้วยสิทธิ์เหล่านี้จากหน้าจอไม่ได้: ${unknown.join(', ')}`,
      unknown.map((scope) => ({ field: 'scopes', reason: scope })),
    );
  }

  return scopes;
}

function statusOf(row: ApiKeyRow): 'active' | 'expired' | 'revoked' {
  if (row.revokedAt || !row.active) return 'revoked';
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return 'expired';

  return 'active';
}
