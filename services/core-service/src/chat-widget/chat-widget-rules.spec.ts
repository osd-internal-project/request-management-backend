import {
  chooseDefault,
  widgetOrigin,
  type VisibleWidget,
} from './chat-widget-rules';

const widget = (
  id: string,
  extra: Partial<VisibleWidget> = {},
): VisibleWidget => ({
  id,
  isDefault: false,
  orgWide: true,
  groups: [],
  ...extra,
});

describe('chooseDefault', () => {
  const depthOf = new Map([
    ['team', 0],
    ['dept', 1],
  ]);

  it('takes the nearest group default over a parent group and the org', () => {
    const widgets = [
      widget('org', { isDefault: true }),
      widget('dept-chat', { groups: [{ orgUnitId: 'dept', isDefault: true }] }),
      widget('team-chat', { groups: [{ orgUnitId: 'team', isDefault: true }] }),
    ];
    expect(chooseDefault(widgets, depthOf)).toBe('team-chat');
  });

  it('falls back to the org default, then to the first widget', () => {
    expect(
      chooseDefault([widget('a'), widget('b', { isDefault: true })], depthOf),
    ).toBe('b');
    expect(chooseDefault([widget('a'), widget('b')], depthOf)).toBe('a');
    expect(chooseDefault([], depthOf)).toBeNull();
  });

  it('ignores a default from a group the user is not under', () => {
    const widgets = [
      widget('org', { isDefault: true }),
      widget('x', { groups: [{ orgUnitId: 'elsewhere', isDefault: true }] }),
    ];
    expect(chooseDefault(widgets, depthOf)).toBe('org');
  });
});

describe('widgetOrigin', () => {
  it('keeps the origin only and clears an empty value', () => {
    expect(widgetOrigin(' http://192.168.31.52/widget/v1.js ', 'http:')).toBe(
      'http://192.168.31.52',
    );
    expect(widgetOrigin('', 'https:')).toBeNull();
  });

  it('refuses a scheme that does not match the slot', () => {
    expect(() => widgetOrigin('http://x.test', 'https:')).toThrow();
  });
});
