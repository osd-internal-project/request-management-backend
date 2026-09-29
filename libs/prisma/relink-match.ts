/** Matches local users to accounts in a new realm — pure, so `kc:relink` can be tested without Keycloak. */

export interface LocalUser {
  readonly id: string;
  readonly username: string;
  readonly email: string | null;
  readonly keycloakId: string;
}

export interface RealmAccount {
  readonly id: string;
  readonly username: string;
  readonly email?: string;
}

export type Relink =
  | { readonly kind: 'unchanged'; readonly user: LocalUser }
  | {
      readonly kind: 'relink';
      readonly user: LocalUser;
      readonly by: 'username' | 'email';
      readonly keycloakId: string;
      readonly username: string;
    }
  | {
      readonly kind: 'conflict';
      readonly user: LocalUser;
      readonly reason: string;
    }
  | { readonly kind: 'missing'; readonly user: LocalUser };

/** Username first, then email; anything ambiguous is a conflict, never a guess. */
export function matchAccounts(
  users: readonly LocalUser[],
  accounts: readonly RealmAccount[],
): Relink[] {
  const byUsername = new Map(accounts.map((a) => [a.username, a]));
  const byEmail = new Map<string, RealmAccount>();
  for (const account of accounts)
    if (account.email) byEmail.set(account.email.toLowerCase(), account);

  const first = users.map((user) => proposeFor(user, byUsername, byEmail));
  return rejectDuplicates(first);
}

function proposeFor(
  user: LocalUser,
  byUsername: ReadonlyMap<string, RealmAccount>,
  byEmail: ReadonlyMap<string, RealmAccount>,
): Relink {
  const sameName = byUsername.get(user.username);
  const sameEmail = user.email
    ? byEmail.get(user.email.toLowerCase())
    : undefined;

  if (sameName && sameEmail && sameName.id !== sameEmail.id) {
    return {
      kind: 'conflict',
      user,
      reason: `username → ${sameName.username}, email → ${sameEmail.username}`,
    };
  }

  const account = sameName ?? sameEmail;
  if (!account) return { kind: 'missing', user };
  if (account.id === user.keycloakId && account.username === user.username)
    return { kind: 'unchanged', user };

  return {
    kind: 'relink',
    user,
    by: sameName ? 'username' : 'email',
    keycloakId: account.id,
    username: account.username,
  };
}

/** `keycloakId` and `username` are unique columns: two rows may not end on the same value. */
function rejectDuplicates(results: readonly Relink[]): Relink[] {
  const finalId = (r: Relink) =>
    r.kind === 'relink' ? r.keycloakId : r.user.keycloakId;
  const finalName = (r: Relink) =>
    r.kind === 'relink' ? r.username : r.user.username;
  const count = (values: string[]) => {
    const seen = new Map<string, number>();
    for (const v of values) seen.set(v, (seen.get(v) ?? 0) + 1);
    return seen;
  };
  const ids = count(results.map(finalId));
  const names = count(results.map(finalName));

  return results.map((r) => {
    if (r.kind !== 'relink') return r;
    if (ids.get(r.keycloakId)! > 1)
      return {
        kind: 'conflict',
        user: r.user,
        reason: `${r.username} would be linked to more than one local user`,
      };
    if (names.get(r.username)! > 1)
      return {
        kind: 'conflict',
        user: r.user,
        reason: `username ${r.username} is already taken by another local user`,
      };
    return r;
  });
}
