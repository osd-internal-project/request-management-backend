import { AppError } from '../errors';
import { assertSeparationOfDuties } from './separation-of-duties';

describe('§5.4 guardrail 1 — separation of duties', () => {
  it('allows a configuration role that only configures', () => {
    expect(() =>
      assertSeparationOfDuties([
        'admin.role.manage',
        'admin.org.manage',
        'audit.read',
        'request.read',
      ]),
    ).not.toThrow();
  });

  it('allows an approver that holds no admin permission', () => {
    expect(() =>
      assertSeparationOfDuties([
        'approval.decide',
        'request.sensitive.read',
        'request.return',
      ]),
    ).not.toThrow();
  });

  it('refuses admin authority combined with approval authority', () => {
    expect(() =>
      assertSeparationOfDuties(['admin.role.manage', 'approval.decide']),
    ).toThrow(AppError);
  });

  it('refuses admin authority combined with reading sensitive fields', () => {
    expect(() =>
      assertSeparationOfDuties(['admin.sla.manage', 'request.sensitive.read']),
    ).toThrow(AppError);
  });

  it('answers with 422 and names the offending permission', () => {
    try {
      assertSeparationOfDuties(['admin.role.manage', 'approval.decide']);
      fail('expected the guardrail to reject this combination');
    } catch (error) {
      const appError = error as AppError;

      expect(appError.code).toBe('UNPROCESSABLE');
      expect(appError.message).toContain('approval.decide');
      expect(appError.message).toContain('§5.4');
    }
  });

  it('triggers on any admin.* permission, not a hardcoded list', () => {
    // The catalog grows with each admin surface; the rule keys off the module
    // prefix so a newly declared `admin.something` is covered on the day it
    // is added, without editing this guardrail.
    expect(() =>
      assertSeparationOfDuties(['admin.bi.manage', 'approval.decide']),
    ).toThrow(AppError);
  });

  it('passes an empty set', () => {
    expect(() => assertSeparationOfDuties([])).not.toThrow();
  });
});
