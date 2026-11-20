import { Injectable } from '@nestjs/common';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface LineProfile {
  lineUserId: string;
  displayName: string;
  pictureUrl: string | null;
}

/** Thrown when LINE refuses or cannot be reached; the callback answers `LINE_ERROR`. */
export class LineLoginError extends Error {}

/**
 * LINE Login v2.1 — swaps the callback's code for an ID token and has LINE
 * verify it against the company's channel. The access token is never kept.
 */
@Injectable()
export class LineLoginClient {
  private fetcher: Fetch = (url, init) => fetch(url, init);

  /** Tests swap the network. */
  useFetch(fetcher: Fetch): void {
    this.fetcher = fetcher;
  }

  async profileFor(input: {
    code: string;
    redirectUri: string;
    channelId: string;
    channelSecret: string;
  }): Promise<LineProfile> {
    const token = await this.post<{ id_token?: string }>(
      'https://api.line.me/oauth2/v2.1/token',
      {
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: input.channelId,
        client_secret: input.channelSecret,
      },
    );
    if (!token.id_token) throw new LineLoginError('LINE returned no id_token');
    // verify checks the signature, expiry and that the token was issued to this channel
    const claims = await this.post<{
      sub?: string;
      name?: string;
      picture?: string;
    }>('https://api.line.me/oauth2/v2.1/verify', {
      id_token: token.id_token,
      client_id: input.channelId,
    });
    if (!claims.sub) throw new LineLoginError('LINE id_token has no sub');
    return {
      lineUserId: claims.sub,
      displayName: claims.name ?? '',
      pictureUrl: claims.picture ?? null,
    };
  }

  private async post<T>(url: string, form: Record<string, string>): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
      });
    } catch (failure) {
      throw new LineLoginError(
        `LINE unreachable: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
    }
    if (!response.ok) {
      throw new LineLoginError(
        `LINE ${new URL(url).pathname} answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
    }
    return (await response.json()) as T;
  }
}
