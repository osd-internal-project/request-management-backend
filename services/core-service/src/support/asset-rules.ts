/**
 * CD-236 ทะเบียนอุปกรณ์ที่ติดตั้ง — the rules, apart from the database: what
 * a project leaves in the register at acceptance, what an asset entered by
 * hand needs, and how a search matches.
 */
import { readBoq } from '../presales/solution-rules';

export const ASSET_KINDS = ['equipment', 'software'] as const;
export const ASSET_STATUSES = ['active', 'replaced', 'removed'] as const;
export const MAX_ASSET_TEXT = 500;
export const MAX_IMPORT_ROWS = 500;

export interface AssetDraft {
  kind: 'equipment' | 'software';
  installationId: string | null;
  environmentId: string | null;
  productCode: string | null;
  name: string;
  model: string | null;
  serialNo: string | null;
  location: string | null;
  installedOn: string | null;
}

/**
 * What an accepted project leaves: every installed point (its BOQ line names
 * it) and every production environment of its software. Points not yet
 * installed wait for the next acceptance; what is already registered is
 * left alone.
 */
export function assetsFromProject(input: {
  projectName: string;
  baseline: unknown;
  points: readonly {
    id: string;
    seq: number;
    location: string;
    boqIndex: number | null;
    serialNo: string | null;
    installedOn: string | null;
  }[];
  environments: readonly { id: string; kind: string; name: string }[];
  registered: {
    installationIds: ReadonlySet<string>;
    environmentIds: ReadonlySet<string>;
  };
}): AssetDraft[] {
  const boq = readBoq((input.baseline as { boq?: unknown } | null)?.boq);
  const equipment = input.points
    .filter(
      (point) =>
        point.installedOn && !input.registered.installationIds.has(point.id),
    )
    .map((point) => {
      const line = point.boqIndex === null ? undefined : boq[point.boqIndex];
      return {
        kind: 'equipment' as const,
        installationId: point.id,
        environmentId: null,
        productCode: line?.productCode || null,
        name: line?.name || line?.productCode || `จุดติดตั้ง P-${point.seq}`,
        model: line?.model || null,
        serialNo: point.serialNo,
        location: point.location,
        installedOn: point.installedOn,
      };
    });
  const software = input.environments
    .filter(
      (env) =>
        env.kind === 'production' &&
        !input.registered.environmentIds.has(env.id),
    )
    .map((env) => ({
      kind: 'software' as const,
      installationId: null,
      environmentId: env.id,
      productCode: null,
      name: `${input.projectName} — ${env.name}`,
      model: null,
      serialNo: null,
      location: null,
      installedOn: null,
    }));
  return [...equipment, ...software];
}

/** An asset entered by hand (or a file row), its own problems in Thai. */
export function assetProblems(input: {
  kind: string;
  name: string;
  serialNo: string;
  installedOn: string;
  status?: string;
  today: string;
}): string[] {
  const problems: string[] = [];
  if (!(ASSET_KINDS as readonly string[]).includes(input.kind)) {
    problems.push('ชนิดต้องเป็นอุปกรณ์ (equipment) หรือซอฟต์แวร์ (software)');
  }
  if (!input.name.trim()) problems.push('ต้องระบุชื่ออุปกรณ์/ซอฟต์แวร์');
  if (input.name.length > MAX_ASSET_TEXT) problems.push('ชื่อยาวเกินไป');
  if (input.serialNo.length > 100)
    problems.push('หมายเลขเครื่องยาวเกิน 100 ตัวอักษร');
  if (input.installedOn) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.installedOn)) {
      problems.push('วันที่ติดตั้งต้องเป็น YYYY-MM-DD');
    } else if (input.installedOn > input.today) {
      problems.push('วันที่ติดตั้งต้องไม่เกินวันนี้');
    }
  }
  if (
    input.status !== undefined &&
    !(ASSET_STATUSES as readonly string[]).includes(input.status)
  ) {
    problems.push('สถานะไม่ถูกต้อง');
  }
  return problems;
}

/** A serial as compared: trimmed, case and inner spaces ignored. */
export function serialKey(serial: string | null | undefined): string | null {
  const key = (serial ?? '').replace(/\s+/g, '').toUpperCase();
  return key || null;
}
