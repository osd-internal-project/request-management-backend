import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/** Leg 2 of the PKCE flow — sent by the BFF, never by the browser. */
export class CallbackDto {
  @IsString()
  @IsNotEmpty()
  code: string;

  @IsString()
  @IsNotEmpty()
  codeVerifier: string;

  /** Must match the value the BFF stored before leg 1 (CSRF defence). */
  @IsOptional()
  @IsString()
  redirectUri?: string;
}
