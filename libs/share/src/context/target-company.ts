import { AppError } from '../errors/app-error';
import type { Principal } from './principal';

/**
 * Resolves the company an **administration** endpoint acts on.
 *
 * The admin screens (A1 authority matrix, A2 request types, A3 org chart, SLA
 * configuration) let one administrator configure any company they belong to
 * without switching the whole session — §16 draws A1 with a tab per company.
 * So those endpoints accept a `company_id` alongside the `X-Company-Id`
 * header, which names the company the *working* screens are showing.
 *
 * That parameter must be checked. `CompanyGuard` validates the header and
 * nothing else, so a `company_id` taken at face value would let an
 * administrator of one company read and write the configuration of a company
 * they have no membership in — the company boundary is absolute (SCOPE-03,
 * D-11), and configuration is exactly what must not leak across it.
 *
 * Omitting it means "the company I am working in", which is what a screen with
 * no company picker wants.
 */
export function resolveTargetCompany(
  principal: Principal,
  requested: string | undefined,
): string {
  if (!requested) return principal.activeCompanyId;

  assertCompanyMember(principal, requested);

  return requested;
}

/**
 * The membership check on its own, for callers where an absent `company_id`
 * means something other than "my active company" — `createRole` treats it as
 * "a role shared by every company", which must keep meaning that.
 */
export function assertCompanyMember(
  principal: Principal,
  requested: string,
): void {
  /**
   * A service account has no membership to check — see `CompanyGuard` for why
   * membership is the wrong test for an integration. Its boundary is the
   * client grant, already enforced by `PolicyGuard`.
   */
  if (principal.isServiceAccount) return;

  const isMember = principal.companies.some(
    (company) => company.id === requested,
  );

  if (!isMember) {
    throw new AppError(
      'COMPANY_FORBIDDEN',
      'ไม่มีสิทธิ์เข้าถึงข้อมูลของบริษัทนี้',
      [{ field: 'company_id', reason: requested }],
    );
  }
}
