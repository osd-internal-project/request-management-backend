import { MockDCallcenterClient } from '../integrations/dcallcenter/mock-dcallcenter.client';
import { SmartDialerService } from './smart-dialer.service';

const target = (id: string, phone: string, attempts = 0) => ({
  id,
  prospectId: `p-${id}`,
  phone,
  attempts,
});

function harness(
  options: {
    callable?: ReturnType<typeof target>[];
    inFlight?: number;
    cap?: number;
    callcenter?: { mode: 'mock' | 'off'; placeCall: jest.Mock };
    llmMode?: string;
  } = {},
) {
  let seq = 0;
  const calls = {
    count: jest.fn(() => Promise.resolve(options.inFlight ?? 0)),
    create: jest.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: `call-${++seq}`,
        status: 'dialling',
        ...args.data,
      }),
    ),
    findFirst: jest.fn((args: { where: { externalCallId: string } }) =>
      Promise.resolve({
        id: 'call-1',
        companyId: 'osd',
        listId: 'l-1',
        targetId: 'a',
        prospectId: 'p-a',
        phone: '021111110',
        externalCallId: args.where.externalCallId,
        status: 'dialling',
        startedAt: new Date(),
      }),
    ),
    findMany: jest.fn(() => Promise.resolve([])),
    update: jest.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'call-1', listId: 'l-1', ...args.data }),
    ),
  };
  const lists = {
    findMany: jest.fn(() => Promise.resolve([{ id: 'l-1', companyId: 'osd' }])),
  };
  const targets = {
    update: jest.fn(() => Promise.resolve({})),
    findFirst: jest.fn(() => Promise.resolve({ attempts: 1 })),
  };
  const prospects = { update: jest.fn(() => Promise.resolve({})) };
  const callLists = {
    callable: jest.fn(() => Promise.resolve(options.callable ?? [])),
    dialPlan: jest.fn(() =>
      Promise.resolve({
        opening: 'AI โทรจาก OSD',
        script: 'แนะนำ',
        maxAttempts: 3,
      }),
    ),
    refuse: jest.fn(() => Promise.resolve({ blocked: true })),
  };
  const handoff = { afterInterest: jest.fn(() => Promise.resolve()) };
  const llm = {
    chat: jest.fn(() => Promise.resolve({ text: 'สนใจระบบกล้อง' })),
  };
  const service = new SmartDialerService(
    lists as never,
    targets as never,
    calls as never,
    prospects as never,
    callLists as never,
    handoff as never,
    llm as never,
    { execute: jest.fn((fn: (p: unknown) => unknown) => fn({})) } as never,
    {
      get: (key: string) =>
        key === 'smart.maxConcurrentCalls'
          ? (options.cap ?? 5)
          : key === 'llm.mode'
            ? (options.llmMode ?? 'mock')
            : 0,
    } as never,
    options.callcenter ?? new MockDCallcenterClient(),
  );
  return { service, calls, targets, prospects, callLists, llm, handoff };
}

const dataOf = (mock: jest.Mock, n: number) =>
  (mock.mock.calls[n] as unknown as [{ data: Record<string, unknown> }])[0]
    .data;

describe('CD-292 dialling through D-Callcenter', () => {
  it('dials only callable targets, within the company’s concurrent cap', async () => {
    const h = harness({
      callable: [
        target('a', '021111110'),
        target('b', '021111111'),
        target('c', '021111112'),
      ],
      inFlight: 3,
      cap: 5,
    });
    await expect(h.service.dialDue()).resolves.toEqual({ dialled: 2 });
    // the attempt counts when dialled
    expect(dataOf(h.targets.update, 0)).toMatchObject({ attempts: 1 });
  });

  it('nothing is dialled when the cap is already used', async () => {
    const h = harness({ callable: [target('a', '021111110')], inFlight: 5 });
    await expect(h.service.dialDue()).resolves.toEqual({ dialled: 0 });
    expect(h.callLists.callable).not.toHaveBeenCalled();
  });

  it('interest finishes the target and marks the prospect for its sales axis', async () => {
    const h = harness();
    await h.service.recordResult('osd', {
      callId: 'x',
      outcome: 'interested',
      transcript: 't',
    });
    expect(dataOf(h.calls.update, 0)).toMatchObject({
      status: 'completed',
      outcome: 'interested',
    });
    expect(dataOf(h.targets.update, 0)).toMatchObject({ status: 'done' });
    expect(dataOf(h.prospects.update, 0)).toHaveProperty('interestedAt');
    // CD-293 — and goes to its sales axis at once
    expect(h.handoff.afterInterest).toHaveBeenCalledWith('osd', 'p-a', 'l-1');
    // mock LLM mode — no summary call
    expect(h.llm.chat).not.toHaveBeenCalled();
  });

  it('a refusal blocks the number on every list through the register', async () => {
    const h = harness();
    await h.service.recordResult('osd', { callId: 'x', outcome: 'refused' });
    expect(dataOf(h.targets.update, 0)).toMatchObject({
      status: 'blocked',
      blockReason: 'do_not_contact',
    });
    expect(h.callLists.refuse).toHaveBeenCalledWith('osd', 'a', null);
  });

  it('no answer leaves the target to be tried again', async () => {
    const h = harness();
    await h.service.recordResult('osd', { callId: 'x', outcome: 'no_answer' });
    expect(dataOf(h.targets.update, 0)).toMatchObject({ status: 'pending' });
  });

  it('with a real gateway the model summarises; the outcome stays D-Callcenter’s', async () => {
    const h = harness({ llmMode: 'gateway' });
    await h.service.recordResult('osd', {
      callId: 'x',
      outcome: 'not_interested',
      transcript: 'ลูกค้า: ยังไม่สนใจ',
    });
    expect(h.llm.chat).toHaveBeenCalledWith(
      { companyId: 'osd', task: 'smart.call' },
      expect.any(Array),
      { maxTokens: 300 },
    );
    expect(dataOf(h.calls.update, 0)).toMatchObject({
      outcome: 'not_interested',
    });
  });

  it('a finished call is not recorded twice; an unknown outcome is refused', async () => {
    const h = harness();
    h.calls.findFirst.mockResolvedValueOnce({
      id: 'call-1',
      status: 'completed',
      outcome: 'interested',
    } as never);
    await h.service.recordResult('osd', { callId: 'x', outcome: 'interested' });
    expect(h.calls.update).not.toHaveBeenCalled();
    await expect(
      h.service.recordResult('osd', { callId: 'x', outcome: 'maybe' as never }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('a call centre that cannot dial fails the call, not the round', async () => {
    const h = harness({
      callable: [target('a', '021111110')],
      callcenter: {
        mode: 'off',
        placeCall: jest.fn(() => Promise.reject(new Error('down'))),
      },
    });
    await expect(h.service.dialDue()).resolves.toEqual({ dialled: 1 });
    expect(h.calls.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          error: 'down',
        }) as unknown,
      }),
    );
  });

  it('the mock answers the same way for the same number, so every path is walkable', async () => {
    const mock = new MockDCallcenterClient();
    const call = { ref: 'r', to: '021111110', opening: 'o', script: 's' };
    const first = await mock.placeCall(call);
    const again = await mock.placeCall(call);
    expect(first.result?.outcome).toBe(again.result?.outcome);
    expect(first.result?.transcript).toContain('[ข้อมูลจำลอง]');
  });
});
