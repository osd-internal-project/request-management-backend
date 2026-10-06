import { Body, Controller, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CurrentPrincipal,
  Permissions,
  ServiceAccountOnly,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  KbAiAnswerDto,
  KbAiSearchDto,
  KbAiService,
} from '@request-management/core-service';

/**
 * CD-265 — the knowledge base for AI channels that talk to customers (AI
 * CARE, AI SMART), with a key holding `integration.kb.read`.
 *
 * Robot-only like `request/intake`: nobody of ours is at the other end, so
 * no `X-Acting-User` — and the search returns only published articles meant
 * for customers (every customer, or the one named by `customer_code`),
 * never internal ones. The company is the key's (or `X-Company-Id` for a
 * key bound to none).
 *
 * Search, answer from what came back, then report the answer and the
 * articles it cites (or that it could not answer): every search and answer
 * is kept so a knowledge owner can see what an answer was based on.
 */
@ApiTags('kb')
@ApiBearerAuth()
@Controller('kb/ai')
export class KbAiController {
  constructor(private readonly ai: KbAiService) {}

  @Post('search')
  @Permissions('integration.kb.read')
  @ServiceAccountOnly()
  @ApiOperation({
    summary: 'ค้นบทความที่เผยแพร่ให้ลูกค้าเพื่อใช้ตอบ (CD-265)',
    description:
      'ตอบ queryId + บทความ (Markdown, เวอร์ชัน) · ใส่ customer_code เพื่อรวมบทความเฉพาะลูกค้ารายนั้น · ทุกการค้นถูกบันทึก',
  })
  search(@Body() dto: KbAiSearchDto, @CurrentPrincipal() principal: Principal) {
    return this.ai.search(principal.activeCompanyId, {
      question: dto.question,
      channel: dto.channel,
      customerCode: dto.customer_code,
      conversationRef: dto.conversation_ref,
      limit: dto.limit,
    });
  }

  @Post('queries/:queryId/answer')
  @Permissions('integration.kb.read')
  @ServiceAccountOnly()
  @ApiOperation({
    summary: 'บันทึกคำตอบและบทความที่อ้างอิง หรือว่าตอบไม่ได้ (CD-265)',
    description:
      'อ้างอิงได้เฉพาะบทความที่การค้นนั้นส่งกลับไป · ตอบไม่ได้ = ช่องว่างความรู้ (CD-266) · บันทึกได้ครั้งเดียว',
  })
  answer(
    @Param('queryId') queryId: string,
    @Body() dto: KbAiAnswerDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.ai.answer(principal.activeCompanyId, queryId, {
      outcome: dto.outcome,
      answer: dto.answer,
      citedArticleIds: dto.cited_article_ids,
    });
  }
}
