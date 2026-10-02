import {
  cleanSettings,
  designInForce,
  designSubmitProblems,
  openVersion,
  readSettings,
} from './design-rules';

describe('CD-211 design rules', () => {
  it('settings keep a key and a value; blank keys drop; a key twice is a problem', () => {
    expect(
      readSettings([{ key: ' IP กล้อง ', value: ' 10.0.0.1 ' }, { key: '' }]),
    ).toEqual([{ key: 'IP กล้อง', value: '10.0.0.1' }]);
    expect(
      cleanSettings([
        { key: 'VLAN', value: '20' },
        { key: 'VLAN', value: '30' },
      ]).problems,
    ).toEqual(['ค่าตั้งค่า "VLAN" ซ้ำ']);
  });

  it('a version sent for approval has a name, a drawing, and says how it differs', () => {
    expect(
      designSubmitProblems({
        title: 'แบบติดตั้งกล้อง',
        files: 1,
        differsFromSolution: false,
        differences: null,
      }),
    ).toEqual([]);
    expect(
      designSubmitProblems({
        title: ' ',
        files: 0,
        differsFromSolution: true,
        differences: '',
      }),
    ).toHaveLength(3);
  });

  it('the newest approved version is in force; one open version at a time', () => {
    const versions = [
      { versionNo: 1, status: 'superseded' },
      { versionNo: 2, status: 'approved' },
      { versionNo: 3, status: 'rejected' },
      { versionNo: 4, status: 'draft' },
    ];
    expect(designInForce(versions)?.versionNo).toBe(2);
    expect(openVersion(versions)?.versionNo).toBe(4);
    expect(designInForce([])).toBeNull();
  });
});
