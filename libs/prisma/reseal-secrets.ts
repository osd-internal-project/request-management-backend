/**
 * P8: move every sealed secret onto the active key.
 *
 *   set -a && . ./.env && set +a && yarn secrets:reseal          # count only
 *   set -a && . ./.env && set +a && yarn secrets:reseal --apply  # write
 *
 * Idempotent: a value already sealed under the active key is skipped, so a
 * second run reports 0. A value no key in the ring opens is reported and left
 * alone, never overwritten. Retire an old kid from CONFIG_SECRET_KEYS only
 * after a run that reports 0 to reseal and 0 unreadable.
 */
import { PrismaClient } from '@prisma/client';
import { keyringFromEnv } from '../share/src/secrets/keyring';
import {
  openSecret,
  sealSecret,
  sealedUnderActive,
} from '../../services/core-service/src/pm/config-rules';

/** Every column that holds a `sealSecret` value. */
const COLUMNS = [
  ['apiKey', 'keyEnc'],
  ['webhookSubscription', 'secretEnc'],
  ['workflowTrigger', 'channelKeyEnc'],
  ['outboundConnection', 'secretEnc'],
  ['mailSetting', 'clientSecretEnc'],
  ['softphoneExtension', 'passwordSealed'],
  ['projectConfigItem', 'secretSealed'],
  ['projectConfigHistory', 'oldSealed'],
  ['projectConfigHistory', 'newSealed'],
] as const;

type Row = { id: string } & Record<string, string | null>;
interface Table {
  findMany(args: object): Promise<Row[]>;
  update(args: object): Promise<unknown>;
}

async function main(): Promise<void> {
  if (!process.env.CONFIG_SECRET_KEY && !process.env.CONFIG_SECRET_KEYS) {
    throw new Error(
      'Set CONFIG_SECRET_KEY / CONFIG_SECRET_KEYS (load the service .env) — ' +
        'resealing with the development key would lock every secret away.',
    );
  }
  const ring = keyringFromEnv(process.env);
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();

  try {
    console.log(
      `active key: ${ring.active} · mode: ${apply ? 'APPLY' : 'dry-run'}`,
    );
    for (const [model, field] of COLUMNS) {
      // The delegates differ per model; each is read by id + one string column.
      const table = (prisma as unknown as Record<string, Table>)[model];
      const rows = await table.findMany({
        where: { [field]: { not: null } },
        select: { id: true, [field]: true },
      });
      let current = 0;
      let moved = 0;
      let unreadable = 0;
      for (const row of rows) {
        const sealed = row[field];
        if (!sealed) continue;
        if (sealedUnderActive(sealed, ring)) {
          current += 1;
          continue;
        }
        const plain = openSecret(sealed, ring);
        if (plain === null) {
          unreadable += 1;
          continue;
        }
        if (apply) {
          await table.update({
            where: { id: row.id },
            data: { [field]: sealSecret(plain, ring) },
          });
        }
        moved += 1;
      }
      console.log(
        `${model}.${field}: ${rows.length} rows · already ${current} · ${apply ? 'resealed' : 'to reseal'} ${moved} · unreadable ${unreadable}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
