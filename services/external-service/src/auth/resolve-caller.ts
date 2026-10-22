import {
  AppError,
  COMPANY_HEADER,
  type Principal,
  type RequestWithPrincipal,
} from '@request-management/share';
import {
  getApiKey,
  type IntegrationPolicy,
  type RemotePrincipalService,
} from '@request-management/core-service';

/** อีเมลของผู้ใช้ที่ระบบภายนอกทำแทน — โหมดเดิม เปิดราย integration. */
export const ACTING_USER_HEADER = 'x-acting-user';
export const ACTING_USER_HEADER_LABEL = 'X-Acting-User';

/** Keycloak access token ของผู้ใช้เอง — ผู้ใช้ login กับระบบภายนอกแล้ว (22 ต.ค. 2569). */
export const USER_TOKEN_HEADER = 'x-user-token';
export const USER_TOKEN_HEADER_LABEL = 'X-User-Token';

/**
 * คนที่คำขอนี้ทำแทน — กฎเดียวของ Open API และ MCP.
 *
 * - token ของคนเอง (LibreChat) → คนนั้น; ห้ามแนบ header ระบุคนอื่น
 * - API key + `X-User-Token` → คนเจ้าของ token (สิทธิ์ = scope ของ key ∩ สิทธิ์ของคน)
 * - API key + `X-Acting-User` → คนตามอีเมล เฉพาะ integration ที่เปิดโหมดเดิมไว้
 *
 * @param caller principal ที่ guard ระดับ global resolve จาก bearer แล้ว
 */
export async function resolveCaller(
  request: RequestWithPrincipal,
  caller: Principal,
  principals: RemotePrincipalService,
): Promise<Principal> {
  const email = headerOf(request, ACTING_USER_HEADER);
  const userToken = headerOf(request, USER_TOKEN_HEADER);

  if (!caller.isServiceAccount) {
    // ระบบรู้อยู่แล้วว่าเป็นใคร — ยอมให้ header ระบุคนอื่นเท่ากับเปิดช่องสวมรอย
    if (email || userToken) {
      throw new AppError(
        'VALIDATION_FAILED',
        `ห้ามส่ง ${ACTING_USER_HEADER} หรือ ${USER_TOKEN_HEADER} เมื่อเข้าสู่ระบบด้วยบัญชีของตนเอง — ระบบทราบอยู่แล้วว่าเป็นใคร`,
        [
          {
            field: email ? ACTING_USER_HEADER : USER_TOKEN_HEADER,
            reason: 'not allowed for a user token',
          },
        ],
      );
    }
    return caller;
  }

  if (email && userToken) {
    throw new AppError(
      'VALIDATION_FAILED',
      `ส่ง ${USER_TOKEN_HEADER_LABEL} หรือ ${ACTING_USER_HEADER_LABEL} อย่างใดอย่างหนึ่ง`,
      [{ field: ACTING_USER_HEADER, reason: 'conflicts with x-user-token' }],
    );
  }

  const key = getApiKey(request);
  const policy = key?.integration;
  const company = headerOf(request, COMPANY_HEADER) || undefined;

  if (userToken) {
    return fromUserToken(
      userToken,
      policy,
      key?.companyId ?? null,
      company,
      principals,
    );
  }

  if (!email) {
    throw new AppError(
      'VALIDATION_FAILED',
      `ต้องระบุ ${USER_TOKEN_HEADER_LABEL} (token ของผู้ใช้) หรือ ${ACTING_USER_HEADER_LABEL} (อีเมล) ของผู้ใช้ที่ทำรายการ`,
      [{ field: USER_TOKEN_HEADER, reason: 'required' }],
    );
  }

  // integration ที่ไม่มี (key ก่อน 22 ต.ค. 2569) ทำได้ทุกแบบ เหมือนเดิม
  if (
    policy &&
    !(policy.allowActingUser && policy.modes.includes('delegated'))
  ) {
    throw new AppError(
      'FORBIDDEN',
      `ระบบภายนอกนี้ไม่ได้เปิดให้ระบุผู้ใช้ด้วย ${ACTING_USER_HEADER_LABEL} — ส่ง ${USER_TOKEN_HEADER_LABEL} แทน`,
      [
        {
          field: ACTING_USER_HEADER,
          reason: 'not allowed for this integration',
        },
      ],
    );
  }

  /*
    The caller's own bearer travels with the lookup: user-service decides
    whether this credential may ask the question at all, and it is the only
    service that verifies tokens (§03).
  */
  const actingUser = await principals.resolveActingUser(
    request.headers.authorization ?? '',
    email,
    company,
    key?.scopes ?? [],
  );
  return assertPlaced(actingUser, ACTING_USER_HEADER, email);
}

async function fromUserToken(
  token: string,
  policy: IntegrationPolicy | undefined,
  keyCompanyId: string | null,
  company: string | undefined,
  principals: RemotePrincipalService,
): Promise<Principal> {
  if (!policy?.modes.includes('delegated')) {
    throw new AppError(
      'FORBIDDEN',
      'ระบบภายนอกนี้ไม่ได้เปิดให้ทำรายการในนามผู้ใช้',
      [{ field: USER_TOKEN_HEADER, reason: 'delegated mode is off' }],
    );
  }

  // user-service verify ลายเซ็นและอายุ — token ปลอมหรือหมดอายุได้ 401 ตรงนี้
  const person = await principals.resolve(`Bearer ${token}`, company);

  // อ่าน azp หลัง verify แล้วเท่านั้น: token ที่ออกให้ client อื่น (เช่นเว็บของเราเอง) ใช้แทนไม่ได้
  const clientId = tokenClientId(token);
  if (
    person.isServiceAccount ||
    !clientId ||
    !policy.keycloakClientIds.includes(clientId)
  ) {
    throw new AppError(
      'FORBIDDEN',
      'token ของผู้ใช้ไม่ได้ออกให้ระบบภายนอกนี้',
      [{ field: USER_TOKEN_HEADER, reason: clientId ?? 'no azp' }],
    );
  }

  // pickActiveCompany ถอยไปบริษัทอื่นของคนเงียบ ๆ — key ที่ผูกบริษัทต้องได้คนในบริษัทนั้น (SCOPE-03)
  if (keyCompanyId && person.activeCompanyId !== keyCompanyId) {
    throw new AppError('NOT_FOUND', 'ไม่พบผู้ใช้ในบริษัทของ API key นี้');
  }

  return assertPlaced(person, USER_TOKEN_HEADER, person.email ?? person.userId);
}

function assertPlaced(
  person: Principal,
  field: string,
  who: string,
): Principal {
  if (person.pendingOrgAssignment) {
    throw new AppError(
      'FORBIDDEN',
      'ผู้ใช้รายนี้ยังไม่ถูกจัดสังกัดในผังองค์กร จึงยังทำรายการไม่ได้',
      [{ field, reason: who }],
    );
  }
  return person;
}

function headerOf(request: RequestWithPrincipal, name: string): string {
  const value = request.headers[name];
  return typeof value === 'string' ? value.trim() : '';
}

/** `azp` ของ JWT — อ่านเฉยๆ ไม่ verify; เรียกหลัง user-service verify token เดียวกันแล้ว. */
export function tokenClientId(token: string): string | null {
  const azp = jwtClaims(token).azp;
  return typeof azp === 'string' ? azp : null;
}

/** `aud` ของ JWT เป็น array เสมอ — อ่านเฉยๆ ไม่ verify เหมือน `tokenClientId`. */
export function tokenAudiences(token: string): string[] {
  const aud = jwtClaims(token).aud;
  if (typeof aud === 'string') return [aud];
  return Array.isArray(aud)
    ? aud.filter((value): value is string => typeof value === 'string')
    : [];
}

function jwtClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) return {};
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    );
    return typeof claims === 'object' && claims !== null
      ? (claims as Record<string, unknown>) // object ที่ parse จาก JSON มีแต่ key แบบ string
      : {};
  } catch {
    return {};
  }
}
