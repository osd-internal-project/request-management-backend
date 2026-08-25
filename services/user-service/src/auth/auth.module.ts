import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { PrincipalModule } from '../principal/principal.module';
import keycloakConfig from './keycloak.config';

@Module({
  imports: [
    ConfigModule.forFeature(keycloakConfig),
    HttpModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    PrincipalModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
