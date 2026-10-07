import {
  fileProblems,
  inlineSafe,
  mayOpenVersion,
  nextVersionNo,
} from './brand-rules';

describe('CD-273 brand library rules', () => {
  it('versions count on from the highest', () => {
    expect(nextVersionNo([])).toBe(1);
    expect(nextVersionNo([1, 3, 2])).toBe(4);
  });

  it('takes brand files, refuses others and big ones', () => {
    expect(fileProblems({ mimetype: 'image/png', size: 10 })).toEqual([]);
    expect(
      fileProblems({
        mimetype:
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        size: 10,
      }),
    ).toEqual([]);
    expect(fileProblems({ mimetype: 'text/html', size: 10 })).toHaveLength(1);
    expect(
      fileProblems({ mimetype: 'image/png', size: 60 * 1024 * 1024 }),
    ).toHaveLength(1);
  });

  it('SVG downloads rather than opening in the browser', () => {
    expect(inlineSafe('image/png')).toBe(true);
    expect(inlineSafe('image/svg+xml')).toBe(false);
  });

  it('staff open the current version only; MACOM opens any', () => {
    expect(
      mayOpenVersion({
        versionId: 'v2',
        currentVersionId: 'v2',
        manager: false,
      }),
    ).toBe(true);
    expect(
      mayOpenVersion({
        versionId: 'v1',
        currentVersionId: 'v2',
        manager: false,
      }),
    ).toBe(false);
    expect(
      mayOpenVersion({
        versionId: 'v1',
        currentVersionId: 'v2',
        manager: true,
      }),
    ).toBe(true);
  });
});
