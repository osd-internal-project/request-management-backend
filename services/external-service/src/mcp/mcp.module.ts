import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import {
  AuditModule,
  SENSITIVE_READ_RECORDER,
  SensitiveFieldMasker,
} from '@request-management/share';
import { RequestModule } from '../request/request.module';
import {
  CrmModule as CoreCrmModule,
  PrincipalModule,
  SensitiveReadAuditRecorder,
} from '@request-management/core-service';
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
  imports: [RequestModule, PrincipalModule, CoreCrmModule, AuditModule],
  controllers: [McpController, OAuthMetadataController],
  providers: [
    McpService,
    McpToolRegistry,
    McpActorService,
    /*
      SCOPE-04/05 สำหรับประตูที่ไม่ใช่ HTTP.

      `SensitiveFieldInterceptor` ที่ลงทะเบียนไว้ที่ root ครอบ MCP ไม่ได้ — handler
      ที่ Nest เห็นคือ `McpController.handle` ซึ่งไม่มี `@SensitiveResource` และ
      คำตอบถูกห่อเป็น `content[].text` ไปแล้วตอนที่ interceptor ได้จับ
      `McpToolRegistry` จึงถือ masker ของตัวเอง และ recorder ตัวเดียวกับที่ root ใช้
      เพื่อให้ "ใครเห็นข้อมูลของใคร" ยังเป็นรอยเดียวไม่ว่าคำขอเข้ามาทางไหน
    */
    SensitiveFieldMasker,
    SensitiveReadAuditRecorder,
    {
      provide: SENSITIVE_READ_RECORDER,
      useExisting: SensitiveReadAuditRecorder,
    },
  ],
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
