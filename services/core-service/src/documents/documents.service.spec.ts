import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { DocumentFilesService } from './document-files.service';
import { DocumentsService, type DocumentRow } from './documents.service';

const admin = {
  userId: 'u-admin',
  activeCompanyId: 'osd',
  permissions: ['admin.document.manage'],
} as unknown as Principal;

const row = (over: Partial<DocumentRow> = {}): DocumentRow => ({
  id: 'd-1',
  companyId: 'osd',
  kind: 'dated',
  title: 'หนังสือรับรองบริษัท',
  description: null,
  issueDate: new Date('2026-09-01T00:00:00.000Z'),
  fileName: 'cert.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1024,
  storageKey: 'company-documents/osd/d-1/k/cert.pdf',
  uploadedBy: 'u-admin',
  createdAt: new Date('2026-10-07T03:00:00.000Z'),
  updatedBy: null,
  updatedAt: new Date('2026-10-07T03:00:00.000Z'),
  archivedAt: null,
  archivedBy: null,
  ...over,
});

const pdf = {
  originalname: 'cert.pdf',
  mimetype: 'application/pdf',
  size: 1024,
  buffer: Buffer.from('%PDF'),
};

function harness(rows: DocumentRow[] = [row()]) {
  const documents = {
    findMany: jest.fn(() => Promise.resolve(rows)),
    count: jest.fn(() => Promise.resolve(rows.length)),
    findFirst: jest.fn(
      (args: { where: { id: string; companyId: string; archivedAt?: null } }) =>
        Promise.resolve(
          rows.find(
            (r) =>
              r.id === args.where.id &&
              r.companyId === args.where.companyId &&
              (args.where.archivedAt === undefined || r.archivedAt === null),
          ) ?? null,
        ),
    ),
  };
  const people = {
    findMany: jest.fn(() =>
      Promise.resolve([{ id: 'u-admin', displayName: 'แอดมิน' }]),
    ),
  };
  const tx = {
    companyDocument: {
      create: jest.fn((args: { data: Partial<DocumentRow> }) => {
        rows.push(row({ ...args.data }));
        return Promise.resolve({});
      }),
      update: jest.fn(() => Promise.resolve({})),
    },
  };
  const transactions = {
    execute: jest.fn((fn: (prisma: unknown) => unknown) => fn(tx)),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const storage = {
    put: jest.fn(() => Promise.resolve()),
    get: jest.fn(() => Promise.resolve('stream')),
    remove: jest.fn(() => Promise.resolve()),
  };
  const service = new DocumentsService(
    documents as never,
    people as never,
    transactions as never,
    audit as never,
  );
  const files = new DocumentFilesService(
    service,
    transactions as never,
    audit as never,
    storage as never,
  );
  return { service, files, documents, tx, audit, storage };
}

describe('company documents', () => {
  it('a dated upload without an issue date is refused before anything is stored', async () => {
    const { files, storage } = harness();
    await expect(
      files.upload(admin, { kind: 'dated', title: 'ใบอนุญาต' }, pdf),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('a dated upload stores the file, the issue date and an audit entry in one transaction', async () => {
    const { files, tx, audit, storage } = harness([]);
    const doc = await files.upload(
      admin,
      { kind: 'dated', title: ' ใบอนุญาต ', issue_date: '2026-10-01' },
      pdf,
    );
    expect(storage.put).toHaveBeenCalled();
    const data = (
      tx.companyDocument.create.mock.calls[0] as unknown as [
        { data: Partial<DocumentRow> },
      ]
    )[0].data;
    expect(data).toMatchObject({
      companyId: 'osd',
      kind: 'dated',
      title: 'ใบอนุญาต',
      uploadedBy: 'u-admin',
    });
    expect(data.issueDate?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'document.uploaded' }),
      { prisma: tx },
    );
    expect(doc.issue_date).toBe('2026-10-01');
  });

  it('a general upload carries no issue date', async () => {
    const { files, tx } = harness([]);
    const doc = await files.upload(
      admin,
      { kind: 'general', title: 'โบรชัวร์' },
      pdf,
    );
    expect(
      (
        tx.companyDocument.create.mock.calls[0] as unknown as [
          { data: Partial<DocumentRow> },
        ]
      )[0].data.issueDate,
    ).toBeNull();
    expect(doc.issue_date).toBeNull();
    await expect(
      files.upload(
        admin,
        { kind: 'general', title: 'โบรชัวร์', issue_date: '2026-10-01' },
        pdf,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('removes the stored file when the row cannot be written', async () => {
    const { files, tx, storage } = harness([]);
    tx.companyDocument.create.mockImplementationOnce(() =>
      Promise.reject(new Error('db down')),
    );
    await expect(
      files.upload(admin, { kind: 'general', title: 'x' }, pdf),
    ).rejects.toThrow('db down');
    expect(storage.remove).toHaveBeenCalled();
  });

  it('lists only the active company, newest issue date first, with the date as YYYY-MM-DD', async () => {
    const { service, documents } = harness();
    const page = await service.list('osd', {
      kind: 'dated',
      issued_from: '2026-01-01',
      page: 1,
      page_size: 20,
    });
    const args = (
      documents.findMany.mock.calls[0] as unknown as [
        { where: Record<string, unknown> },
      ]
    )[0];
    expect(args.where).toMatchObject({
      companyId: 'osd',
      archivedAt: null,
      kind: 'dated',
    });
    expect(page.data[0]).toMatchObject({
      issue_date: '2026-09-01',
      file_name: 'cert.pdf',
      uploaded_by: { id: 'u-admin', name: 'แอดมิน' },
    });
  });

  it("another company's document is 404 (SCOPE-03)", async () => {
    const { service, files } = harness([row({ companyId: 'lextech' })]);
    await expect(service.one('osd', 'd-1')).rejects.toBeInstanceOf(AppError);
    await expect(files.file(admin, 'd-1', 'external')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('an archived document is gone for the External API but still opens on the screen', async () => {
    const { files, audit } = harness([row({ archivedAt: new Date() })]);
    await expect(files.file(admin, 'd-1', 'external')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(files.file(admin, 'd-1', 'screen')).resolves.toMatchObject({
      fileName: 'cert.pdf',
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('an external download is audited', async () => {
    const { files, audit } = harness();
    const file = await files.file(admin, 'd-1', 'external');
    expect(file).toMatchObject({ mimeType: 'application/pdf' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'document.downloaded',
        resourceId: 'd-1',
      }),
    );
  });

  it('a general document cannot be given an issue date by editing', async () => {
    const { service } = harness([row({ kind: 'general', issueDate: null })]);
    await expect(
      service.update(admin, 'd-1', { issue_date: '2026-10-01' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('a dated document cannot have its issue date emptied', async () => {
    const { service } = harness();
    await expect(
      service.update(admin, 'd-1', { issue_date: '' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
