/**
 * CD-227 ส่งมอบงานเทคนิคให้ทีมบริการ — what the service team must receive
 * from the engineers before a handover (CD-255) can be sent, apart from the
 * database: the as-built (CD-226), the configuration (CD-217), each
 * integration's contact (CD-219) and the project team's cautions.
 */

export const MAX_CAUTIONS = 4000;

export interface TechPackageFacts {
  asBuilt: {
    complete: boolean;
    missingDocuments: readonly string[];
    openDeviations: readonly string[];
  };
  configItems: number;
  integrations: readonly {
    label: string;
    name: string;
    hasContact: boolean;
  }[];
  cautions: string | null;
}

/** Every gap, named, so the team closes them in one pass. Empty = complete. */
export function techPackageGaps(facts: TechPackageFacts): string[] {
  const gaps: string[] = [];
  for (const title of facts.asBuilt.missingDocuments) {
    gaps.push(`ยังไม่มีเอกสารสภาพจริง: ${title}`);
  }
  for (const deviation of facts.asBuilt.openDeviations) {
    gaps.push(`จุดที่ต่างจากที่ขายยังไม่ปิด: ${deviation}`);
  }
  if (!facts.configItems) gaps.push('ยังไม่ได้บันทึกค่าตั้งค่าระบบ');
  for (const integration of facts.integrations) {
    if (!integration.hasContact) {
      gaps.push(
        `จุดเชื่อมต่อ ${integration.label} ${integration.name} ยังไม่มีผู้ติดต่อฝั่งลูกค้า`,
      );
    }
  }
  if (!facts.cautions?.trim())
    gaps.push('ยังไม่ได้เขียนข้อควรระวังถึงทีมบริการ');
  return gaps;
}
