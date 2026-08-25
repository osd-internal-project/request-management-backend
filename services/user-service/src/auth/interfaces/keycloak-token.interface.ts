export interface KeycloakTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_expires_in: number;
  refresh_token: string;
  token_type: string;
  id_token?: string;
  'not-before-policy': number;
  session_state?: string;
  scope: string;
}

export interface KeycloakUserInfo {
  sub: string;
  email_verified: boolean;
  preferred_username: string;
  email?: string;
  given_name?: string;
  family_name?: string;
  name?: string;
  [key: string]: unknown;
}
