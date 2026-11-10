import { callSeconds, sipSettings } from './softphone-rules';

describe('sipSettings', () => {
  const valid = {
    extension: ' 1023 ',
    wss_url: 'wss://pbx.example.com:8089/ws',
    sip_server: '10.0.0.5',
  };

  it('trims and keeps a wss URL', () => {
    expect(sipSettings(valid)).toEqual({
      extension: '1023',
      wssUrl: 'wss://pbx.example.com:8089/ws',
      sipServer: '10.0.0.5',
    });
  });

  it('refuses ws:// — an https page cannot open it', () => {
    expect(() =>
      sipSettings({ ...valid, wss_url: 'ws://pbx.example.com/ws' }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('refuses an extension with spaces and a server with a path', () => {
    expect(() => sipSettings({ ...valid, extension: '10 23' })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
    expect(() => sipSettings({ ...valid, sip_server: '10.0.0.5/x' })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });
});

describe('callSeconds', () => {
  it('rounds to whole seconds', () => {
    expect(
      callSeconds(
        new Date('2026-11-10T03:00:00.000Z'),
        new Date('2026-11-10T03:04:12.400Z'),
      ),
    ).toBe(252);
  });

  it('refuses a hang-up before the answer', () => {
    expect(() =>
      callSeconds(
        new Date('2026-11-10T03:00:10Z'),
        new Date('2026-11-10T03:00:00Z'),
      ),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
});
