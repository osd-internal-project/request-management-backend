import { applyDecorators, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import {
  ActingPolicyGuard,
  ServiceAccountOnly,
} from '@request-management/share';
import {
  ACTING_USER_HEADER_LABEL,
  ActingUserGuard,
  USER_TOKEN_HEADER_LABEL,
} from './acting-user.guard';

/** ผู้ใช้ที่ทำแทน — ส่ง header ตัวใดตัวหนึ่ง (`resolve-caller.ts`). เอกสารเท่านั้น. */
export const ApiActingHeaders = () =>
  applyDecorators(
    ApiHeader({
      name: USER_TOKEN_HEADER_LABEL,
      required: false,
      description:
        'Keycloak access token ของผู้ใช้ (ออกให้ client ที่ผูกกับระบบภายนอกนี้) — วิธีหลัก',
    }),
    ApiHeader({
      name: ACTING_USER_HEADER_LABEL,
      required: false,
      description:
        'อีเมลของผู้ใช้ — เฉพาะระบบภายนอกที่เปิดโหมดเดิมไว้ ส่งพร้อม X-User-Token ไม่ได้',
    }),
  );

/**
 * The class-level half of the two-gate model, for controllers whose every
 * route acts for a person (`X-User-Token`, or `X-Acting-User` where allowed).
 *
 * It is exactly what the generated CRM controllers spell out by hand: a
 * service-account credential, the acting-user swap, then the person's own
 * gate — in that order, because Nest runs route guards in the order written
 * (`acting-user.guard.ts` explains why the order is the design). Each route
 * still declares its own `@Permissions('integration.…')` and
 * `@ActingPermissions(…)`; this decorator never supplies either, so a route
 * that forgets one is refused rather than quietly opened.
 */
export const ActsForPerson = () =>
  applyDecorators(
    ApiBearerAuth(),
    ApiActingHeaders(),
    ServiceAccountOnly(),
    UseGuards(ActingUserGuard, ActingPolicyGuard),
  );
