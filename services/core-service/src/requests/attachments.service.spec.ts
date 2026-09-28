import { AppError, MemoryStorage } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { AttachmentsService, safeFileName } from './attachments.service';

const actor = {
  userId: 'user-requester',
  activeCompanyId: 'company-osd',
  username: 'requester',
  // Only the fields these paths read.
} as unknown as Principal;

const FILE = {
  originalname: 'ใบเสนอราคา.pdf',
  mimetype: 'application/pdf',
  size: 5,
  buffer: Buffer.from('%PDF-'),
};

const REQUEST = {
  id: 'req-1',
  companyId: 'company-osd',
  requestType: { requiredDocs: [{ code: 'QUOTE', name: 'ใบเสนอราคา' }] },
};

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

function serviceWith(
  options: {
    createFails?: boolean;
    attachments?: Record<string, unknown>[];
  } = {},
) {
  const storage = new MemoryStorage();
  const create = jest.fn(({ data }: { data: Record<string, unknown> }) =>
    options.createFails
      ? Promise.reject(new Error('db down'))
      : Promise.resolve(data),
  );
  const record = jest.fn(() => Promise.resolve());

  const service = new AttachmentsService(
    {
      requireEditableOwn: jest.fn(() => Promise.resolve(REQUEST)),
      findOne: jest.fn(() =>
        Promise.resolve({ ...REQUEST, attachments: options.attachments ?? [] }),
      ),
    } as never,
    { create } as never,
    { record } as never,
    {
      execute: jest.fn((work: (prisma: unknown) => unknown) => work({})),
    } as never,
    storage,
  );

  return { service, storage, create, record };
}

describe('AttachmentsService.upload (REQ-03)', () => {
  it('stores the bytes, then records the row and the audit entry', async () => {
    const { service, storage, record } = serviceWith();

    const row = await service.upload('req-1', FILE, 'QUOTE', actor);

    expect(row).toMatchObject({
      requestId: 'req-1',
      docCode: 'QUOTE',
      fileName: 'ใบเสนอราคา.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 5,
    });
    expect(row.storageKey).toBe(`requests/req-1/${row.id}/ใบเสนอราคา.pdf`);
    expect(storage.has(row.storageKey)).toBe(true);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'request.attachment.added' }),
      expect.anything(),
    );
  });

  it('removes the stored object when the row cannot be written', async () => {
    const { service, storage } = serviceWith({ createFails: true });
    const put = jest.spyOn(storage, 'put');

    await expect(
      service.upload('req-1', FILE, undefined, actor),
    ).rejects.toThrow('db down');

    const [key] = put.mock.calls[0];
    expect(storage.has(key)).toBe(false);
  });

  it('refuses a doc code the type does not declare, before storing anything', async () => {
    const { service, storage } = serviceWith();
    const put = jest.spyOn(storage, 'put');

    await expect(
      service.upload('req-1', FILE, 'UNKNOWN', actor),
    ).rejects.toBeInstanceOf(AppError);
    expect(put).not.toHaveBeenCalled();
  });

  it('refuses a request with no file part', async () => {
    const { service } = serviceWith();

    await expect(
      service.upload('req-1', undefined, undefined, actor),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('AttachmentsService.download (REQ-03)', () => {
  it('streams the stored bytes', async () => {
    const { service, storage } = serviceWith({
      attachments: [
        {
          id: 'att-1',
          storageKey: 'requests/req-1/att-1/a.pdf',
          deletedAt: null,
        },
      ],
    });
    await storage.put('requests/req-1/att-1/a.pdf', Buffer.from('hello'), {
      contentType: 'application/pdf',
      size: 5,
    });

    const { stream } = await service.download('req-1', 'att-1', actor);

    expect(await readAll(stream)).toBe('hello');
  });

  it('answers ATTACHMENT_NO_FILE for a metadata-only row', async () => {
    const { service } = serviceWith({
      attachments: [
        { id: 'att-1', storageKey: 'pending://x', deletedAt: null },
      ],
    });

    await expect(
      service.download('req-1', 'att-1', actor),
    ).rejects.toMatchObject({
      code: 'ATTACHMENT_NO_FILE',
    });
  });

  it('answers NOT_FOUND for a withdrawn attachment', async () => {
    const { service } = serviceWith({
      attachments: [
        { id: 'att-1', storageKey: 'requests/k', deletedAt: new Date() },
      ],
    });

    await expect(
      service.download('req-1', 'att-1', actor),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('safeFileName', () => {
  it('keeps Thai, strips separators and control characters', () => {
    expect(safeFileName('../ก\u0000ข/ค.pdf')).toBe('.._กข_ค.pdf');
  });

  it('never returns an empty name', () => {
    expect(safeFileName('  ')).toBe('file');
  });
});
