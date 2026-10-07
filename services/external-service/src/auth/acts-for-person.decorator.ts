import { applyDecorators, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import {
  ActingPolicyGuard,
  ServiceAccountOnly,
} from '@request-management/share';
import { ACTING_USER_HEADER_LABEL, ActingUserGuard } from './acting-user.guard';

/**
 * The class-level half of the two-gate model, for controllers whose every
 * route acts for the person in `X-Acting-User`.
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
    ApiHeader({
      name: ACTING_USER_HEADER_LABEL,
      required: true,
      description: 'อีเมลของผู้ใช้ที่ทำรายการ — ระบบจะทำงานในนามของคนนี้',
    }),
    ServiceAccountOnly(),
    UseGuards(ActingUserGuard, ActingPolicyGuard),
  );
