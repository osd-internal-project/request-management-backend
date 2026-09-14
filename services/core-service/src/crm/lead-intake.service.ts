import { Injectable } from '@nestjs/common';
import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import type { ApiKeyContext } from '../principal/api-key.service';
import { IntakeLeadDto, IntakeLeadResultDto } from './dto/lead-intake.dto';
import { LeadsService } from './leads.service';

/**
 * รับ Lead จากระบบภายนอก — เว็บฟอร์ม, LINE OA, งานอีเวนต์, ระบบพาร์ตเนอร์
 * (14 ก.ย. 2569).
 *
 * ไฟล์นี้บางโดยตั้งใจ. มันไม่ได้ "สร้าง Lead อีกทาง" — มันแปลงคำขอจากคนนอกให้
 * เป็นการเรียก `LeadsService.create` ครั้งเดียวกับที่หน้าจอเรียก แล้วย่อคำตอบให้
 * เหลือเท่าที่ผู้เรียกต้องใช้. ทุกอย่างที่เป็นกฎของ Lead — ขั้นตั้งต้นมาจากหน้า
 * ตั้งค่า, audit, การ start workflow `lwf-0001` — จึงเกิดที่เดียวและเหมือนกัน
 * ทั้งสองทางเข้า.
 *
 * เขียน insert เองที่นี่เมื่อไร คือวันที่ Lead จากเว็บไซต์ไม่มี workflow เดิน
 * แล้วไม่มีใครรู้จนกว่าจะมีคนถามว่าทำไมใบพวกนี้ไม่เคยขยับ.
 */
@Injectable()
export class LeadIntakeService {
  constructor(private readonly leads: LeadsService) {}

  async receive(
    dto: IntakeLeadDto,
    actor: Principal,
    key: ApiKeyContext | undefined,
  ): Promise<IntakeLeadResultDto> {
    const row = (await this.leads.create(
      { ...dto, source_code: sourceOf(dto, key) },
      actor,
      { unowned: true },
    )) as unknown as {
      id: string;
      name: string;
      status: string;
      sourceCode: string | null;
      ownerUserId: string | null;
      createdAt: Date;
    };

    return {
      id: row.id,
      name: row.name,
      status: row.status,
      source_code: row.sourceCode ?? '',
      owner_user_id: row.ownerUserId,
      created_at: row.createdAt.toISOString(),
    };
  }
}

/**
 * ช่องทางของใบนี้ — จากกุญแจก่อน จาก body เป็นทางสำรอง.
 *
 * ลำดับนี้กลับกันไม่ได้: กุญแจคือสิ่งที่ *เรา* ออกให้ช่องทางนั้น ส่วน body คือ
 * สิ่งที่ผู้เรียกพิมพ์มา. ถ้าปล่อยให้ body ชนะ key ของเว็บฟอร์มจะรายงานตัวเป็น
 * `line-oa` ได้ และตัวเลขที่การตลาดใช้ตัดสินใจก็ไม่เหลือความหมาย.
 *
 * ว่างทั้งสองทาง = ปฏิเสธ ไม่ใช่เติมคำว่า "unknown" ให้ — ใบที่ไม่รู้ต้นทางคือ
 * ใบที่วัดผลไม่ได้ และการซ่อนปัญหานี้ไว้ในข้อมูลแพงกว่า 422 หนึ่งครั้งตอนตั้งค่า.
 */
function sourceOf(dto: IntakeLeadDto, key: ApiKeyContext | undefined): string {
  const source = key?.sourceCode?.trim() || dto.source_code?.trim();

  if (!source) {
    throw new AppError(
      'VALIDATION_FAILED',
      'API key นี้ยังไม่ได้ผูกช่องทาง — ออก key ใหม่ด้วย --source หรือส่ง source_code มาใน body',
      [{ field: 'source_code', reason: 'required' }],
    );
  }

  return source;
}
