import { RolesService } from './roles.service';
import type { KeycloakRoleMapping } from '@prisma/client';

const OSD = 'company-osd';
const ACTOR = 'user-admin';

function mapping(over: Partial<KeycloakRoleMapping>): KeycloakRoleMapping {
  return {
    id: 'map-1',
    keycloakRole: 'team_lead',
    keycloakRoleId: null,
    roleId: 'role-team-lead',
    companyId: OSD,
    createdAt: new Date(),
    createdBy: null,
    ...over,
  };
}

/**
 * Only the collaborators this path touches. Every write is captured so a test
 * can assert what was *not* written as easily as what was.
 */
function serviceWith(mappings: KeycloakRoleMapping[]) {
  const mappingWrites: { where: unknown; data: Record<string, unknown> }[] = [];
  const roleWrites: { where: unknown; data: Record<string, unknown> }[] = [];
  const audits: Record<string, unknown>[] = [];

  const service = new RolesService(
    {
      update: jest.fn(
        (args: { where: unknown; data: Record<string, unknown> }) => {
          roleWrites.push(args);
          return Promise.resolve({});
        },
      ),
    } as never,
    {} as never,
    {} as never,
    {
      findForCompany: jest.fn(() => Promise.resolve(mappings)),
      update: jest.fn(
        (args: { where: unknown; data: Record<string, unknown> }) => {
          mappingWrites.push(args);
          return Promise.resolve({});
        },
      ),
    } as never,
    {
      record: jest.fn((entry: Record<string, unknown>) => {
        audits.push(entry);
        return Promise.resolve();
      }),
    } as never,
    {} as never,
  );

  return { service, mappingWrites, roleWrites, audits };
}

/**
 * ROLE-03, one way: the realm owns the names, this system owns the
 * permissions. Nothing in this path writes to Keycloak — `AGENTS.md` forbids
 * `admin.*` becoming a route to administering the realm.
 */
describe('a realm rename is followed, not guessed at', () => {
  it('links a legacy row to its realm role by name on the first run', async () => {
    const { service, mappingWrites } = serviceWith([
      mapping({ keycloakRoleId: null, keycloakRole: 'team_lead' }),
    ]);

    const report = await service.syncNamesFromKeycloak(
      OSD,
      [{ id: 'kc-1', name: 'team_lead' }],
      ACTOR,
    );

    expect(report.linked).toEqual(['team_lead']);
    expect(mappingWrites[0].data).toEqual({ keycloakRoleId: 'kc-1' });
    // Nothing was renamed — the name still agreed.
    expect(report.renamed).toEqual([]);
  });

  /**
   * The defect this whole change exists for: before it, the next token carried
   * `หัวหน้างาน`, no mapping matched, and every team lead lost the role.
   */
  it('rewrites the stored name when the realm role was renamed', async () => {
    const { service, mappingWrites, audits } = serviceWith([
      mapping({ keycloakRoleId: 'kc-1', keycloakRole: 'team_lead' }),
    ]);

    const report = await service.syncNamesFromKeycloak(
      OSD,
      [{ id: 'kc-1', name: 'lead' }],
      ACTOR,
    );

    expect(report.renamed).toEqual([{ from: 'team_lead', to: 'lead' }]);
    expect(mappingWrites[0].data).toEqual({ keycloakRole: 'lead' });
    // SUP-04: a change that arrived from another system still leaves a trail.
    expect(audits).toHaveLength(1);
    expect(audits[0].before).toEqual({ keycloakRole: 'team_lead' });
  });

  it('follows the realm description onto the display name', async () => {
    const { service, roleWrites } = serviceWith([
      mapping({ keycloakRoleId: 'kc-1', keycloakRole: 'team_lead' }),
    ]);

    await service.syncNamesFromKeycloak(
      OSD,
      [{ id: 'kc-1', name: 'lead', description: 'หัวหน้างาน' }],
      ACTOR,
    );

    expect(roleWrites[0].data).toEqual({ name: 'หัวหน้างาน' });
  });

  /**
   * `Role.code` is what `assertSeparationOfDuties`, the seed and the
   * `cfo`/`ceo` lookups key off. A realm administrator who could change it
   * would have a way around §5.4 from outside this system entirely.
   */
  it('never writes Role.code, whatever the realm says', async () => {
    const { service, roleWrites } = serviceWith([
      mapping({ keycloakRoleId: 'kc-1', keycloakRole: 'cfo' }),
    ]);

    await service.syncNamesFromKeycloak(
      OSD,
      [{ id: 'kc-1', name: 'finance_head', description: 'ฝ่ายการเงิน' }],
      ACTOR,
    );

    for (const write of roleWrites) {
      expect(Object.keys(write.data)).toEqual(['name']);
    }
  });

  it('leaves the display name alone when the realm carries no description', async () => {
    const { service, roleWrites } = serviceWith([
      mapping({ keycloakRoleId: 'kc-1', keycloakRole: 'team_lead' }),
    ]);

    await service.syncNamesFromKeycloak(
      OSD,
      [{ id: 'kc-1', name: 'lead' }],
      ACTOR,
    );

    expect(roleWrites).toHaveLength(0);
  });

  /**
   * A role absent from the realm list is reported and kept. Deleting on that
   * evidence would strip permissions from everyone the moment the realm was
   * half-configured or the admin API answered oddly — the failure this method
   * was written to prevent, arriving by a different door.
   */
  it('reports a vanished realm role without deleting the mapping', async () => {
    const { service, mappingWrites, audits } = serviceWith([
      mapping({ keycloakRoleId: 'kc-gone', keycloakRole: 'auditor' }),
    ]);

    const report = await service.syncNamesFromKeycloak(OSD, [], ACTOR);

    expect(report.missing).toEqual(['auditor']);
    expect(mappingWrites).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('reports a legacy row whose name matches nothing in the realm', async () => {
    const { service, mappingWrites } = serviceWith([
      mapping({ keycloakRoleId: null, keycloakRole: 'ghost' }),
    ]);

    const report = await service.syncNamesFromKeycloak(
      OSD,
      [{ id: 'kc-1', name: 'team_lead' }],
      ACTOR,
    );

    expect(report.missing).toEqual(['ghost']);
    expect(mappingWrites).toHaveLength(0);
  });

  it('writes nothing at all when everything already agrees', async () => {
    const { service, mappingWrites, roleWrites, audits } = serviceWith([
      mapping({ keycloakRoleId: 'kc-1', keycloakRole: 'team_lead' }),
    ]);

    const report = await service.syncNamesFromKeycloak(
      OSD,
      [{ id: 'kc-1', name: 'team_lead', description: 'หัวหน้าทีม' }],
      ACTOR,
    );

    expect([mappingWrites, roleWrites, audits].map((w) => w.length)).toEqual([
      0, 0, 0,
    ]);
    expect(report).toEqual({
      linked: [],
      renamed: [],
      missing: [],
      checked: 1,
    });
  });
});
