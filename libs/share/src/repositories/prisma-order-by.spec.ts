import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Prisma rejects an `orderBy` object with more than one key at runtime, yet its
 * types accept it and every unit test mocks Prisma — so only this catches it.
 * Several keys belong in an array: `orderBy: [{ a: 'asc' }, { b: 'asc' }]`.
 */
const ROOT = join(__dirname, '..', '..', '..', '..');
const SOURCE_DIRS = ['services', 'libs'];

/** Comments blanked, newlines kept so reported line numbers stay true. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
    .replace(/\/\/.*$/gm, '');
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;

    const path = join(dir, entry);

    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      found.push(path);
    }
  }

  return found;
}

/** The body between a `{` at `open` and its matching `}`. */
function braceBody(source: string, open: number): string {
  let depth = 0;

  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) {
      return source.slice(open + 1, i);
    }
  }

  return source.slice(open + 1);
}

/** Keys at the top level of an object literal body, nested objects ignored. */
function topLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let token = '';

  for (const char of body) {
    if ('{[('.includes(char)) depth++;
    else if ('}])'.includes(char)) depth--;

    if (depth === 0 && char === ':') keys.push(token.trim());
    token = depth === 0 && (char === ',' || char === ':') ? '' : token + char;
  }

  return keys;
}

function multiKeyOrderBys(): string[] {
  const offenders: string[] = [];

  for (const dir of SOURCE_DIRS) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      const source = withoutComments(readFileSync(file, 'utf8'));

      for (const match of source.matchAll(/orderBy:\s*\{/g)) {
        const open = match.index + match[0].length - 1;
        const keys = topLevelKeys(braceBody(source, open));

        if (keys.length > 1) {
          const line = source.slice(0, match.index).split('\n').length;
          offenders.push(
            `${relative(ROOT, file)}:${line} { ${keys.join(', ')} }`,
          );
        }
      }
    }
  }

  return offenders;
}

describe('Prisma orderBy shape', () => {
  it('never passes several keys in one orderBy object', () => {
    expect(multiKeyOrderBys()).toEqual([]);
  });

  it('reads keys at the top level only', () => {
    expect(topLevelKeys(" code: 'asc' ")).toEqual(['code']);
    expect(topLevelKeys(" active: 'asc', code: 'asc' ")).toEqual([
      'active',
      'code',
    ]);
    expect(topLevelKeys(" user: { name: 'asc', id: 'asc' } ")).toEqual([
      'user',
    ]);
  });
});
