import { backgroundTick } from './background-tick';

describe('backgroundTick', () => {
  it('a failing tick is logged, never an unhandled rejection that exits Node', async () => {
    const logger = { warn: jest.fn() };
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      backgroundTick(logger, 'SAP queue sweep', () =>
        Promise.reject(new Error("Can't reach database server")),
      )();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', unhandled);
    }

    expect(unhandled).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "SAP queue sweep failed, next round retries: Can't reach database server",
    );
  });

  it('a successful tick logs nothing', async () => {
    const logger = { warn: jest.fn() };
    const work = jest.fn(() => Promise.resolve());

    backgroundTick(logger, 'x', work)();
    await new Promise((resolve) => setImmediate(resolve));

    expect(work).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
