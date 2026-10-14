import { AppError } from '@request-management/share';

/**
 * A widget URL as stored: its origin only, or null for "use the env". v1.js
 * builds its iframe and postMessage target from the script's origin, so a
 * path would be dropped anyway; the scheme must match the slot because an
 * https page cannot load an http script (mixed content).
 */
export function widgetOrigin(
  value: string | null | undefined,
  protocol: 'http:' | 'https:',
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AppError('VALIDATION_FAILED', `URL ไม่ถูกต้อง: ${trimmed}`);
  }
  if (url.protocol !== protocol) {
    throw new AppError(
      'VALIDATION_FAILED',
      `ช่องนี้ต้องขึ้นต้นด้วย ${protocol}// (ได้ ${url.protocol}//)`,
    );
  }
  return url.origin;
}

/** A visible widget with the group rows that made it visible to this user. */
export interface VisibleWidget {
  id: string;
  isDefault: boolean;
  orgWide: boolean;
  groups: { orgUnitId: string; isDefault: boolean }[];
}

/**
 * The widget the panel opens on: the default of the user's nearest group
 * (`depth` from `org_closure`, 0 = their own unit), else the org default,
 * else the first in order. Null only when nothing is visible.
 */
export function chooseDefault(
  widgets: readonly VisibleWidget[],
  depthOf: ReadonlyMap<string, number>,
): string | null {
  let nearest: { id: string; depth: number } | null = null;
  for (const widget of widgets) {
    for (const group of widget.groups) {
      const depth = depthOf.get(group.orgUnitId);
      if (!group.isDefault || depth === undefined) continue;
      if (!nearest || depth < nearest.depth) nearest = { id: widget.id, depth };
    }
  }
  if (nearest) return nearest.id;
  const orgDefault = widgets.find((w) => w.isDefault && w.orgWide);
  return orgDefault?.id ?? widgets[0]?.id ?? null;
}
