import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { RequestModule } from '../request/request.module';
import { PrincipalModule } from '@request-management/core-service';
import { McpActorService } from './mcp-actor';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { McpToolRegistry } from './mcp-tools';
import { McpChallengeMiddleware } from './mcp-challenge.middleware';
import { OAuthMetadataController } from './oauth-metadata.controller';

/**
 * MCP, as a module of its own.
 *
 * It owns no domain logic at all — `ExternalService` already shapes every
 * answer the ten tools give, and this module only translates JSON-RPC into
 * calls on it. Kept separate from `RequestModule` so the REST surface stays
 * exactly what it was: nothing here can change how `/external/*` behaves.
 */
@Module({
  imports: [RequestModule, PrincipalModule],
  controllers: [McpController, OAuthMetadataController],
  providers: [McpService, McpToolRegistry, McpActorService],
})
export class McpModule implements NestModule {
  /**
   * The `401` challenge, on the MCP route only — see the middleware for why it
   * is not global.
   *
   * `'mcp'`, without the prefix: middleware paths are resolved **inside** the
   * global prefix, so `'api/v1/mcp'` matches nothing and the challenge never
   * fires — which is how this was first written, and the header was silently
   * absent with the endpoint otherwise working.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(McpChallengeMiddleware).forRoutes('mcp');
  }
}
