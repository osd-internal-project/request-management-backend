import type { Readable } from 'node:stream';
import { StreamableFile } from '@nestjs/common';
import { inlineSafe } from './document-rules';

/** PDF and pictures open in the browser; everything else downloads. */
export function documentStream(file: {
  stream: Readable;
  fileName: string;
  mimeType: string;
}) {
  const name = encodeURIComponent(file.fileName);
  return new StreamableFile(file.stream, {
    type: file.mimeType,
    disposition: `${inlineSafe(file.mimeType) ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`,
  });
}
