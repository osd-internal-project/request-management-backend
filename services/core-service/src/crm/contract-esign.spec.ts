import { Readable } from 'node:stream';
import type { Principal } from '@request-management/share';
import { ContractEsignService } from './contract-esign.service';

const legal = {
  userId: 'u-legal',
  activeCompanyId: 'osd',
  permissions: ['legal.contract.manage', 'esign.manage'],
} as unknown as Principal;

function harness(options: {
  requestId: string | null;
  approved?: number | null;
  draft?: boolean;
}) {
  const esign = { create: jest.fn(() => Promise.resolve({ id: 'env-1' })) };
  const service = new ContractEsignService(
    esign as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve({
          id: 'c-1',
          companyId: 'osd',
          contractNo: 'CTR-1',
          title: 'บริการ',
          value: 750_000,
          requestId: options.requestId,
        }),
      ),
    } as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve({
          id: 'doc-1',
          fileName: 'contract.pdf',
          mimeType: 'application/pdf',
          storageKey: 'k',
        }),
      ),
    } as never,
    { on: jest.fn() } as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
    {
      get: jest.fn(() => Promise.resolve(Readable.from([Buffer.from('%PDF')]))),
    } as never,
    {
      forRequest: jest.fn(() =>
        Promise.resolve({
          draft: options.draft === false ? null : { id: 'd-1' },
        }),
      ),
    } as never,
    {
      view: jest.fn(() =>
        Promise.resolve({ approvedVersionNo: options.approved ?? null }),
      ),
    } as never,
  );
  return { service, esign };
}

const dto = {
  document_id: 'doc-1',
  layout_id: 'l-1',
  signers: [{ field_key: 'f1', kind: 'internal' as const, user_id: 'u1' }],
};

describe('CD-160 sending a contract for signing', () => {
  it('a drafted contract waits for its approved draft', async () => {
    const pending = harness({ requestId: 'req-1', approved: null });
    await expect(pending.service.send('c-1', dto, legal)).rejects.toMatchObject(
      {
        code: 'CONFLICT',
      },
    );
    expect(pending.esign.create).not.toHaveBeenCalled();

    const approved = harness({ requestId: 'req-1', approved: 3 });
    await approved.service.send('c-1', dto, legal);
    // the contract value is what the signatories' limits are checked against
    expect(approved.esign.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 750_000, refType: 'contract' }),
      legal,
    );
  });

  it("a contract recorded without a draft is Legal's to send", async () => {
    const recorded = harness({ requestId: null });
    await recorded.service.send('c-1', dto, legal);
    expect(recorded.esign.create).toHaveBeenCalled();
    const noDraft = harness({ requestId: 'req-1', draft: false });
    await noDraft.service.send('c-1', dto, legal);
    expect(noDraft.esign.create).toHaveBeenCalled();
  });
});
