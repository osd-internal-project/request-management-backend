import { softwareDocsStatus, targetRelease } from './software-docs-rules';

describe('CD-215 software document rules', () => {
  const v1 = { id: 'r1', version: '1.0.0' };
  const v2 = { id: 'r2', version: '1.1.0' };

  it('the documents describe what runs on production', () => {
    expect(
      targetRelease({ hasProduction: true, production: v1, latest: v2 }),
    ).toEqual({ ...v1, basis: 'production' });
    // nothing on production yet: not delivered, no target
    expect(
      targetRelease({ hasProduction: true, production: null, latest: v2 }),
    ).toBeNull();
    // no production environment kept here: the newest release
    expect(
      targetRelease({ hasProduction: false, production: null, latest: v2 }),
    ).toEqual({ ...v2, basis: 'latest' });
    expect(
      targetRelease({ hasProduction: false, production: null, latest: null }),
    ).toBeNull();
  });

  it('complete = every required title has a file for that version', () => {
    const target = { ...v2, basis: 'production' as const };
    const required = ['คู่มือผู้ใช้', 'เอกสาร API', ' ', 'คู่มือผู้ใช้'];
    expect(
      softwareDocsStatus({
        required,
        target,
        documents: [
          { title: 'คู่มือผู้ใช้', releaseId: 'r1' },
          { title: ' เอกสาร API ', releaseId: 'r2' },
        ],
      }),
    ).toEqual({ complete: false, target, missing: ['คู่มือผู้ใช้'] });
    expect(
      softwareDocsStatus({
        required,
        target,
        documents: [
          { title: 'คู่มือผู้ใช้', releaseId: 'r2' },
          { title: 'เอกสาร API', releaseId: 'r2' },
        ],
      }).complete,
    ).toBe(true);
    expect(
      softwareDocsStatus({ required, target: null, documents: [] }),
    ).toEqual({
      complete: false,
      target: null,
      missing: ['คู่มือผู้ใช้', 'เอกสาร API'],
    });
  });
});
