import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import type { RequestAttachment } from '@prisma/client';

@Injectable()
export class AttachmentRepository extends BaseRepository<
  PrismaService['requestAttachment']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.requestAttachment;
  }

  /**
   * One attachment, only if it belongs to the request named in the URL.
   *
   * Both ids are matched rather than trusting the attachment id alone: without
   * the pairing, knowing any attachment id would let a caller delete a file
   * from a request they can otherwise reach — the request-level ownership
   * check above would pass while operating on somebody else's row.
   */
  findOfRequest(
    requestId: string,
    attachmentId: string,
    option?: TxOption,
  ): Promise<RequestAttachment | null> {
    const client = option?.prisma ?? this.prisma;

    return client.requestAttachment.findFirst({
      where: { id: attachmentId, requestId, deletedAt: null },
    });
  }
}
