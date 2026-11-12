import { PrismaClient, Prisma } from '@prisma/client';
import {
  ALL_PERMISSIONS,
  permissionLevel,
  permissionModule,
  permissionType,
} from '../share/src/policy/permissions';

/** P5: role ระดับระบบตัวเดียว ถือ `system.*` ครบ. */
export const SYSTEM_ADMIN_ROLE_CODE = 'system_admin';

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * Create-only: an existing `system_admin` is left as admins shaped it.
 *
 * Writes the `system.*` catalog rows first — on a database migrated before
 * user-service has booted the new catalog, the role's permissions would
 * otherwise point at codes `permissions` does not hold yet.
 */
export async function ensureSystemAdminRole(client: Client): Promise<string> {
  const codes = ALL_PERMISSIONS.filter(
    (code) => permissionLevel(code) === 'SYSTEM',
  );
  await client.permission.createMany({
    data: codes.map((code) => ({
      code,
      module: permissionModule(code),
      type: permissionType(code),
    })),
    skipDuplicates: true,
  });

  const exists = await client.role.findFirst({
    where: { companyId: null, code: SYSTEM_ADMIN_ROLE_CODE },
    select: { id: true },
  });
  if (exists) return exists.id;

  const created = await client.role.create({
    data: {
      code: SYSTEM_ADMIN_ROLE_CODE,
      name: 'ผู้ดูแลระบบ (ทุกบริษัท)',
      description: 'จัดการผู้ใช้ บริษัท และ role ระดับระบบ',
      isSystem: true,
      level: 'SYSTEM',
      permissions: {
        create: codes.map((permissionCode) => ({ permissionCode })),
      },
    },
    select: { id: true },
  });
  return created.id;
}
