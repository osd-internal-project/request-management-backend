import {
  matchAccounts,
  type LocalUser,
  type RealmAccount,
} from './relink-match';

const local = (over: Partial<LocalUser> & { username: string }): LocalUser => ({
  id: `db-${over.username}`,
  email: null,
  keycloakId: `old-${over.username}`,
  ...over,
});

describe('matchAccounts (kc:relink)', () => {
  it('relinks by username to the new subject id', () => {
    const [result] = matchAccounts(
      [local({ username: 'somchai.k' })],
      [{ id: 'new-1', username: 'somchai.k' }],
    );
    expect(result).toMatchObject({
      kind: 'relink',
      by: 'username',
      keycloakId: 'new-1',
      username: 'somchai.k',
    });
  });

  it('falls back to email and adopts the realm username', () => {
    const [result] = matchAccounts(
      [local({ username: 'charunans', email: 'C@osd.co.th' })],
      [{ id: 'new-2', username: 'yuki', email: 'c@osd.co.th' }],
    );
    expect(result).toMatchObject({
      kind: 'relink',
      by: 'email',
      keycloakId: 'new-2',
      username: 'yuki',
    });
  });

  it('leaves an already-linked row alone', () => {
    const [result] = matchAccounts(
      [local({ username: 'a', keycloakId: 'new-a' })],
      [{ id: 'new-a', username: 'a' }],
    );
    expect(result.kind).toBe('unchanged');
  });

  it('reports a row with no account as missing', () => {
    const [result] = matchAccounts([local({ username: 'gone' })], []);
    expect(result.kind).toBe('missing');
  });

  it('refuses when username and email point at different accounts', () => {
    const accounts: RealmAccount[] = [
      { id: 'n1', username: 'napatr' },
      { id: 'n2', username: 'napatr@osd.co.th', email: 'napatr@osd.co.th' },
    ];
    const [result] = matchAccounts(
      [local({ username: 'napatr', email: 'napatr@osd.co.th' })],
      accounts,
    );
    expect(result.kind).toBe('conflict');
  });

  it('refuses to link one account to two local users', () => {
    const results = matchAccounts(
      [
        local({ username: 'x', email: 'shared@osd.co.th' }),
        local({ username: 'y', email: 'shared@osd.co.th' }),
      ],
      [{ id: 'n', username: 'z', email: 'shared@osd.co.th' }],
    );
    expect(results.map((r) => r.kind)).toEqual(['conflict', 'conflict']);
  });

  it('refuses a rename onto a username another row already holds', () => {
    const results = matchAccounts(
      [
        local({ username: 'arunkamony', email: 'a@osd.co.th' }),
        local({ username: 'arunkamon' }),
      ],
      [{ id: 'n', username: 'arunkamon', email: 'a@osd.co.th' }],
    );
    expect(results[0].kind).toBe('conflict');
  });
});
