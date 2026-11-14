import type { PrismaService } from '@request-management/share';
import type { User } from '@prisma/client';
import { UsersRepository, type KeycloakUserClaims } from './users.repository';

const claims: KeycloakUserClaims = {
  keycloakId: 'kc-1',
  username: 'taksapongk',
  email: 'taksapongk@osd.co.th',
  displayName: 'Taksapong Kasnopas',
};

// Only the methods upsertFromClaims calls are stubbed; Prisma itself is never reached.
function repositoryWith(existing: Partial<User> | null) {
  const repo = new UsersRepository({} as PrismaService);
  jest.spyOn(repo, 'findByKeycloakId').mockResolvedValue(existing as User | null);
  jest.spyOn(repo, 'findUnique').mockResolvedValue(null);
  const update = jest.spyOn(repo, 'update').mockResolvedValue({} as User);
  const create = jest.spyOn(repo, 'create').mockResolvedValue({} as User);
  return { repo, update, create };
}

describe('upsertFromClaims — ชื่อที่แสดง', () => {
  it('มีชื่อไทยจากทะเบียนพนักงานแล้ว login ไม่เขียนชื่ออังกฤษทับ', async () => {
    const { repo, update } = repositoryWith({ id: 'u1', displayName: 'นายทักษพงศ์ คัดโนภาส' });

    await repo.upsertFromClaims(claims);

    expect(update.mock.calls[0][0].data).toMatchObject({
      displayName: 'นายทักษพงศ์ คัดโนภาส',
      email: 'taksapongk@osd.co.th',
      keycloakId: 'kc-1',
    });
  });

  it('ชื่อเดิมเป็นอังกฤษ ยังตามชื่อใน Keycloak', async () => {
    const { repo, update } = repositoryWith({ id: 'u1', displayName: 'Old Name' });

    await repo.upsertFromClaims(claims);

    expect(update.mock.calls[0][0].data).toMatchObject({
      displayName: 'Taksapong Kasnopas',
    });
  });

  it('คนใหม่ใช้ชื่อจาก Keycloak', async () => {
    const { repo, create } = repositoryWith(null);

    await repo.upsertFromClaims(claims);

    expect(create.mock.calls[0][0].data).toMatchObject({
      displayName: 'Taksapong Kasnopas',
    });
  });
});

describe('upsertFromClaims — อีเมล', () => {
  it('token ไม่มี email ไม่ล้างอีเมลเดิม (X-Acting-User ยังหาคนนี้เจอ)', async () => {
    const { repo, update } = repositoryWith({
      id: 'u1',
      displayName: 'Old Name',
      email: 'taksapongk@osd.co.th',
    });

    await repo.upsertFromClaims({ ...claims, email: null });

    expect(update.mock.calls[0][0].data).toMatchObject({
      email: 'taksapongk@osd.co.th',
    });
  });
});

describe('upsertFromClaims — ผูก id ใหม่ (identity.relinked)', () => {
  it('จับด้วย username แล้วได้ sub ใหม่ → บอก id เดิมกลับไปให้ลง audit', async () => {
    const repo = new UsersRepository({} as PrismaService);
    jest.spyOn(repo, 'findByKeycloakId').mockResolvedValue(null);
    jest
      .spyOn(repo, 'findUnique')
      .mockResolvedValue({ id: 'u1', displayName: 'Old', keycloakId: 'kc-old' } as User);
    jest.spyOn(repo, 'update').mockResolvedValue({ id: 'u1' } as User);

    await expect(repo.upsertFromClaims(claims)).resolves.toMatchObject({
      relinkedFrom: 'kc-old',
    });
  });

  it('sub เดิม → ไม่ใช่การผูกใหม่', async () => {
    const { repo } = repositoryWith({ id: 'u1', displayName: 'Old', keycloakId: 'kc-1' });

    await expect(repo.upsertFromClaims(claims)).resolves.toMatchObject({
      relinkedFrom: null,
    });
  });
});
