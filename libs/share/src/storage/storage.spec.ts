import { AppError } from '../errors';
import { MemoryStorage } from './memory.storage';
import { MinioStorage } from './minio.storage';
import { createStorage } from './storage.module';

const MINIO = {
  endPoint: '127.0.0.1',
  port: 9000,
  useSSL: false,
  accessKey: 'key',
  secretKey: 'secret',
  bucket: 'bucket',
};

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('createStorage', () => {
  it('builds MinIO storage when every connection value is set', () => {
    expect(createStorage({ mode: 'minio', minio: MINIO })).toBeInstanceOf(MinioStorage);
  });

  it('refuses minio mode with missing values and names them', () => {
    expect(() =>
      createStorage({ mode: 'minio', minio: { ...MINIO, endPoint: '', bucket: '' } }),
    ).toThrow('endPoint, bucket');
  });

  it('refuses an unknown mode', () => {
    expect(() => createStorage({ mode: 's4', minio: MINIO })).toThrow('STORAGE_MODE=s4');
  });

  it('falls back to memory when no options are given', () => {
    expect(createStorage(undefined)).toBeInstanceOf(MemoryStorage);
  });
});

describe('MemoryStorage', () => {
  it('returns the bytes that were put', async () => {
    const storage = new MemoryStorage();
    await storage.put('a/b.txt', Buffer.from('สวัสดี'), { contentType: 'text/plain', size: 18 });

    expect((await readAll(await storage.get('a/b.txt'))).toString()).toBe('สวัสดี');
  });

  it('answers NOT_FOUND for a missing or removed key', async () => {
    const storage = new MemoryStorage();
    await storage.put('k', Buffer.from('x'), { contentType: 'text/plain', size: 1 });
    await storage.remove('k');

    await expect(storage.get('k')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(storage.get('k')).rejects.toBeInstanceOf(AppError);
  });
});
