import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/**
 * H2.2 — notes people leave on a request.
 *
 * Its own repository rather than a reach through `RequestRepository`: a comment
 * is not a property of the request row, and the timeline reads it beside events
 * that come from a third table.
 *
 * **No update and no delete method.** The table is append-only by design (see
 * `RequestComment`), and the way to keep it that way is to give the service no
 * call that could break it.
 */
@Injectable()
export class RequestCommentRepository extends BaseRepository<
  PrismaService['requestComment']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.requestComment;
  }
}
