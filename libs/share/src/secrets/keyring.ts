/**
 * P8: the keys stored secrets are sealed with. New seals use `active`; any key
 * still listed opens what it sealed, so a key is retired only after
 * `yarn secrets:reseal` has moved every row off it.
 */
export interface SecretKeyring {
  readonly active: string;
  readonly keys: Readonly<Record<string, string>>;
  /** Opens values sealed before key ids existed (no `v2:` prefix). */
  readonly legacy?: string;
}

const DEV_SECRET = 'dev-project-config-secret';

/**
 * `CONFIG_SECRET_KEYS="k2:<secret>,k1:<secret>"` + `CONFIG_SECRET_ACTIVE=k2`.
 * With only `CONFIG_SECRET_KEY` set (every environment today) it becomes kid
 * `k1`, so nothing needs to change in an env file to deploy this.
 *
 * @throws in production when no key is configured — sealing with a
 *   development or empty key there would be silent and permanent.
 */
export function keyringFromEnv(env: NodeJS.ProcessEnv): SecretKeyring {
  const keys: Record<string, string> = {};
  for (const entry of (env.CONFIG_SECRET_KEYS ?? '').split(',')) {
    const at = entry.indexOf(':');
    if (at > 0 && entry.slice(at + 1)) {
      keys[entry.slice(0, at).trim()] = entry.slice(at + 1).trim();
    }
  }
  const legacy = env.CONFIG_SECRET_KEY || undefined;
  if (legacy && !Object.values(keys).includes(legacy)) keys.k1 ??= legacy;

  if (!Object.keys(keys).length) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'CONFIG_SECRET_KEY (or CONFIG_SECRET_KEYS) is not set — refusing to start in production',
      );
    }
    return { active: 'dev', keys: { dev: DEV_SECRET }, legacy: DEV_SECRET };
  }

  const active = env.CONFIG_SECRET_ACTIVE ?? Object.keys(keys)[0];
  if (!keys[active]) {
    throw new Error(
      `CONFIG_SECRET_ACTIVE=${active} is not in CONFIG_SECRET_KEYS`,
    );
  }
  return { active, keys, legacy };
}
